import type { ClientSession } from 'mongoose';
import { withTransaction } from '../../config/database';
import { AppError, ConflictError, NotFoundError } from '../../common/errors';
import { AlertService } from '../alerts';
import { AuditService, type AuditContext } from '../audit';
import { Booking } from '../bookings';
import { notifyNurse } from '../notifications';
import { NurseProfile } from '../nurses';
import { SettingsService } from '../settings';
import { User } from '../users';
import { Review, type ReviewDoc, type ReviewStatus } from './review.models';

const counts = (s: string) => s === 'ACTIVE';

/** Atomic, never-negative aggregate update on the nurse profile (one pipeline update). */
async function applyRating(
  nurseId: string,
  sumDelta: number,
  countDelta: number,
  session: ClientSession,
): Promise<void> {
  if (sumDelta === 0 && countDelta === 0) return;
  await NurseProfile.collection.updateOne(
    { _id: new NurseProfile.base.Types.ObjectId(nurseId) },
    [
      {
        $set: {
          ratingSum: { $max: [0, { $add: ['$ratingSum', sumDelta] }] },
          totalReviews: { $max: [0, { $add: ['$totalReviews', countDelta] }] },
        },
      },
      {
        $set: {
          averageRating: {
            $cond: [
              { $gt: ['$totalReviews', 0] },
              { $round: [{ $divide: ['$ratingSum', '$totalReviews'] }, 2] },
              0,
            ],
          },
        },
      },
    ],
    { session },
  );
}

export const toPublicReviewDTO = (r: ReviewDoc, reviewerFirstName: string | undefined) => ({
  id: String(r._id),
  rating: r.rating,
  comment: r.comment ?? null,
  reviewer: reviewerFirstName ?? 'Patient',
  createdAt: r.createdAt,
});

export const toOwnReviewDTO = (r: ReviewDoc) => ({
  id: String(r._id),
  bookingId: String(r.bookingId),
  nurseId: String(r.nurseId),
  rating: r.rating,
  comment: r.comment ?? null,
  status: r.status,
  createdAt: r.createdAt,
});

export const toAdminReviewDTO = (r: ReviewDoc) => ({
  ...toOwnReviewDTO(r),
  patientId: String(r.patientId),
  moderationReason: r.moderationReason ?? null,
  moderatedBy: r.moderatedBy ? String(r.moderatedBy) : null,
  moderatedAt: r.moderatedAt ?? null,
});

export const ReviewService = {
  /**
   * Only the booking's patient, only for a COMPLETED booking (not cancelled, refunded, rejected,
   * expired or disputed), once. The review row and the nurse aggregate change in ONE transaction;
   * the unique index on bookingId makes a concurrent duplicate fail and roll back entirely.
   */
  async create(
    patientId: string,
    bookingId: string,
    input: { rating: number; comment?: string },
  ): Promise<ReviewDoc> {
    const settings = await SettingsService.getAll();
    try {
      return await withTransaction(async (session) => {
        const b = await Booking.findOne({ _id: bookingId, patientId }).session(session);
        if (!b) throw new NotFoundError('Booking not found', 'BOOKING_NOT_FOUND');
        if (b.status !== 'COMPLETED')
          throw new AppError(
            422,
            'REVIEW_NOT_ELIGIBLE',
            'Only a completed booking can be reviewed',
          );
        const windowMs = settings['reviews.requireCompletedBookingWithinDays'] * 86_400_000;
        if (b.completedAt && Date.now() - b.completedAt.getTime() > windowMs)
          throw new AppError(
            422,
            'REVIEW_WINDOW_CLOSED',
            'The review period for this booking has ended',
          );
        const [review] = await Review.create(
          [
            {
              bookingId,
              patientId,
              nurseId: b.nurseId,
              rating: input.rating,
              comment: input.comment,
              status: 'ACTIVE',
            },
          ],
          { session },
        );
        await applyRating(String(b.nurseId), input.rating, 1, session);
        await notifyNurse(
          String(b.nurseId),
          {
            type: 'NEW_REVIEW',
            title: 'New review',
            body: `You received a ${input.rating}-star review.`,
            data: { reviewId: String(review!._id), rating: input.rating },
            referenceKey: String(review!._id),
            channels: ['PUSH'],
          },
          session,
        );
        return review!;
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000)
        throw new ConflictError('This booking has already been reviewed', 'REVIEW_ALREADY_EXISTS');
      throw err;
    }
  },

  async listForNurse(nurseId: string, q: { page: number; limit: number }) {
    const filter = { nurseId, status: 'ACTIVE' as const };
    const [items, total] = await Promise.all([
      Review.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((q.page - 1) * q.limit)
        .limit(q.limit),
      Review.countDocuments(filter),
    ]);
    const users = await User.find({ _id: { $in: items.map((i) => i.patientId) } })
      .select('firstName')
      .lean();
    const names = new Map(users.map((u) => [String(u._id), u.firstName]));
    return { items: items.map((r) => toPublicReviewDTO(r, names.get(String(r.patientId)))), total };
  },

  async listMine(patientId: string, q: { page: number; limit: number }) {
    const filter = { patientId };
    const [items, total] = await Promise.all([
      Review.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((q.page - 1) * q.limit)
        .limit(q.limit),
      Review.countDocuments(filter),
    ]);
    return { items, total };
  },

  async listAdmin(q: { page: number; limit: number; status?: ReviewStatus; nurseId?: string }) {
    const filter = {
      ...(q.status && { status: q.status }),
      ...(q.nurseId && { nurseId: q.nurseId }),
    };
    const [items, total] = await Promise.all([
      Review.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((q.page - 1) * q.limit)
        .limit(q.limit),
      Review.countDocuments(filter),
    ]);
    return { items, total };
  },

  async getAdmin(id: string): Promise<ReviewDoc> {
    const r = await Review.findById(id);
    if (!r) throw new NotFoundError('Review not found', 'REVIEW_NOT_FOUND');
    return r;
  },

  /**
   * HIDE / FLAG remove the review from the public view and from the nurse aggregate; RESTORE puts it
   * back. Bookings, payments and the review row itself are never deleted. Idempotent (asking for the
   * state it already has changes nothing); the status change and the aggregate delta are one transaction.
   */
  async moderate(
    id: string,
    action: 'HIDE' | 'RESTORE' | 'FLAG',
    reason: string | undefined,
    ctx: AuditContext,
  ): Promise<{ review: ReviewDoc; changed: boolean }> {
    const target: ReviewStatus =
      action === 'HIDE' ? 'HIDDEN' : action === 'FLAG' ? 'FLAGGED' : 'ACTIVE';
    return withTransaction(async (session) => {
      const r = await Review.findById(id).session(session);
      if (!r) throw new NotFoundError('Review not found', 'REVIEW_NOT_FOUND');
      if (r.status === target) return { review: r, changed: false };
      const updated = await Review.findOneAndUpdate(
        { _id: id, status: r.status },
        {
          $set: {
            status: target,
            moderatedBy: ctx.actorId,
            moderatedAt: new Date(),
            ...(reason && { moderationReason: reason }),
          },
        },
        { new: true, session },
      );
      if (!updated)
        throw new ConflictError('Review changed concurrently; retry', 'REVIEW_CONFLICT');
      const sign = (counts(target) ? 1 : 0) - (counts(r.status) ? 1 : 0);
      await applyRating(String(r.nurseId), sign * r.rating, sign, session);
      await AuditService.record(
        ctx,
        {
          action: `review.${action.toLowerCase()}`,
          entity: 'Review',
          entityId: id,
          oldData: { status: r.status },
          newData: { status: target, reason: reason ?? null, nurseId: String(r.nurseId) },
        },
        session,
      );
      return { review: updated, changed: true };
    });
  },

  /**
   * Recomputes every nurse aggregate from the reviews (the source of truth). Repairs drift in the
   * denormalised cache and raises one warning per drifted nurse. Idempotent; never touches reviews.
   */
  async reconcileAggregates(nurseId?: string): Promise<{ checked: number; repaired: number }> {
    const rows = await Review.aggregate<{ _id: unknown; sum: number; n: number }>([
      {
        $match: {
          status: 'ACTIVE',
          ...(nurseId && { nurseId: new NurseProfile.base.Types.ObjectId(nurseId) }),
        },
      },
      { $group: { _id: '$nurseId', sum: { $sum: '$rating' }, n: { $sum: 1 } } },
    ]);
    const truth = new Map(rows.map((r) => [String(r._id), r]));
    const profiles = await NurseProfile.find(
      nurseId
        ? { _id: nurseId }
        : { $or: [{ totalReviews: { $gt: 0 } }, { _id: { $in: [...truth.keys()] } }] },
    )
      .select('_id ratingSum totalReviews averageRating')
      .lean();
    let repaired = 0;
    for (const p of profiles) {
      const t = truth.get(String(p._id)) ?? { sum: 0, n: 0 };
      const avg = t.n > 0 ? Math.round((t.sum / t.n) * 100) / 100 : 0;
      if (p.ratingSum === t.sum && p.totalReviews === t.n && p.averageRating === avg) continue;
      await NurseProfile.collection.updateOne(
        { _id: p._id },
        { $set: { ratingSum: t.sum, totalReviews: t.n, averageRating: avg } },
      );
      repaired += 1;
      await AlertService.raise({
        key: `review-aggregate-drift:${String(p._id)}`,
        type: 'REVIEW_AGGREGATE_DRIFT',
        severity: 'WARNING',
        entity: 'NurseProfile',
        entityId: String(p._id),
        message: 'A nurse rating aggregate did not match the reviews and was recomputed',
        data: {
          expected: { sum: t.sum, count: t.n },
          found: { sum: p.ratingSum, count: p.totalReviews },
        },
        reopen: true,
      });
    }
    return { checked: profiles.length, repaired };
  },
};
