import type { ClientSession, FilterQuery } from 'mongoose';
import { Types } from 'mongoose';
import { withTransaction } from '../../config/database';
import { AppError, ConflictError, NotFoundError } from '../../common/errors';
import { mulDivRound } from '../../common/utils/time';
import { AuditService, type AuditContext } from '../audit';
import type { BookingDoc, CouponSnapshot, DiscountEvaluation } from '../bookings';
import {
  Coupon,
  CouponRedemption,
  CouponUserUsage,
  type CouponDoc,
  type CouponType,
} from './coupon.models';

const fail = (code: string, msg: string) => new AppError(422, code, msg);
export const normalizeCode = (c: string) => c.trim().toUpperCase();

/**
 * Pure, integer-only discount. PERCENTAGE uses basis points with half-up rounding; the result is
 * capped by maxDiscount and by the gross itself (a coupon can never create a negative price).
 */
export function computeDiscount(
  c: {
    type: CouponType;
    valueMinor?: number | null;
    valueBps?: number | null;
    maxDiscountMinor?: number | null;
  },
  grossMinor: number,
): number {
  if (!Number.isSafeInteger(grossMinor) || grossMinor < 0)
    throw new AppError(500, 'INVALID_MONEY', 'gross must be a non-negative integer');
  let d =
    c.type === 'FIXED' ? (c.valueMinor ?? 0) : mulDivRound(grossMinor, c.valueBps ?? 0, 10_000);
  if (c.maxDiscountMinor != null) d = Math.min(d, c.maxDiscountMinor);
  return Math.min(d, grossMinor);
}

export interface CouponInput {
  code: string;
  description?: string;
  type: CouponType;
  valueMinor?: number;
  valueBps?: number;
  maxDiscountMinor?: number;
  minBookingAmountMinor?: number;
  usageLimit?: number;
  perUserLimit?: number;
  startAt: Date;
  endAt: Date;
  applicableServiceIds?: string[];
  applicableNurseIds?: string[];
}

function assertTerms(
  i: Pick<CouponInput, 'type' | 'valueMinor' | 'valueBps' | 'startAt' | 'endAt'>,
) {
  if (i.type === 'FIXED' && (!i.valueMinor || i.valueBps != null))
    throw new AppError(400, 'INVALID_COUPON', 'A FIXED coupon needs valueMinor (and no valueBps)');
  if (i.type === 'PERCENTAGE' && (!i.valueBps || i.valueMinor != null))
    throw new AppError(
      400,
      'INVALID_COUPON',
      'A PERCENTAGE coupon needs valueBps (and no valueMinor)',
    );
  if (i.endAt <= i.startAt)
    throw new AppError(400, 'INVALID_COUPON', 'endAt must be after startAt');
}

export const toCouponDTO = (c: CouponDoc) => ({
  id: String(c._id),
  code: c.code,
  description: c.description ?? null,
  type: c.type,
  valueMinor: c.valueMinor ?? null,
  valueBps: c.valueBps ?? null,
  maxDiscountMinor: c.maxDiscountMinor ?? null,
  minBookingAmountMinor: c.minBookingAmountMinor ?? 0,
  usageLimit: c.usageLimit ?? null,
  perUserLimit: c.perUserLimit ?? null,
  startAt: c.startAt,
  endAt: c.endAt,
  active: c.active,
  applicableServiceIds: c.applicableServiceIds.map(String),
  applicableNurseIds: c.applicableNurseIds.map(String),
  usedCount: c.usedCount,
  version: c.version,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

export const CouponService = {
  // ------------------------------------------------------------------ patient side
  /** Read-only validation + server-side discount. Never trusts a client number. */
  async evaluate(a: {
    code: string;
    patientId: string;
    serviceId: string;
    nurseId: string;
    grossMinor: number;
    now: Date;
  }): Promise<DiscountEvaluation> {
    const c = await Coupon.findOne({ code: normalizeCode(a.code) });
    if (!c) throw fail('COUPON_NOT_FOUND', 'This coupon code is not valid');
    if (!c.active) throw fail('COUPON_INACTIVE', 'This coupon is not active');
    if (a.now < c.startAt) throw fail('COUPON_NOT_STARTED', 'This coupon is not valid yet');
    if (a.now >= c.endAt) throw fail('COUPON_EXPIRED', 'This coupon has expired');
    if (a.grossMinor < (c.minBookingAmountMinor ?? 0))
      throw fail(
        'COUPON_MIN_AMOUNT',
        `A minimum booking amount of ${c.minBookingAmountMinor} fils applies`,
      );
    if (
      c.applicableServiceIds.length &&
      !c.applicableServiceIds.some((s) => String(s) === a.serviceId)
    )
      throw fail('COUPON_SERVICE_NOT_ELIGIBLE', 'This coupon does not apply to this service');
    if (c.applicableNurseIds.length && !c.applicableNurseIds.some((n) => String(n) === a.nurseId))
      throw fail('COUPON_NURSE_NOT_ELIGIBLE', 'This coupon does not apply to this nurse');
    if (c.usageLimit != null && c.usedCount >= c.usageLimit)
      throw fail('COUPON_USAGE_LIMIT', 'This coupon has been fully used');
    if (c.perUserLimit != null) {
      const u = await CouponUserUsage.findOne({ couponId: c._id, userId: a.patientId }).lean();
      if ((u?.used ?? 0) >= c.perUserLimit)
        throw fail(
          'COUPON_USER_LIMIT',
          'You have already used this coupon the maximum number of times',
        );
    }
    const discountMinor = computeDiscount(c, a.grossMinor);
    return {
      discountMinor,
      snapshot: {
        couponId: String(c._id),
        code: c.code,
        type: c.type,
        ...(c.valueMinor != null && { valueMinor: c.valueMinor }),
        ...(c.valueBps != null && { valueBps: c.valueBps }),
        ...(c.maxDiscountMinor != null && { maxDiscountMinor: c.maxDiscountMinor }),
        minBookingAmountMinor: c.minBookingAmountMinor ?? 0,
        discountMinor,
        couponVersion: c.version,
      },
    };
  },

  /**
   * Consumes one use INSIDE the booking transaction with conditional MongoDB updates (no Redis):
   *  1. coupon.usedCount += 1 only while still active, inside its validity window and below usageLimit
   *  2. couponUserUsage.used += 1 only while below perUserLimit (a unique {coupon,user} row)
   *  3. the redemption row (unique per booking)
   * Concurrent redemptions conflict on these documents; the loser re-reads and is refused. Any
   * failure aborts the whole booking transaction, so a use is never consumed without its booking.
   */
  async redeem(
    a: { snapshot: CouponSnapshot; patientId: string; bookingId: string; now: Date },
    session: ClientSession,
  ): Promise<void> {
    const id = new Types.ObjectId(a.snapshot.couponId);
    const c = await Coupon.findOneAndUpdate(
      {
        _id: id,
        active: true,
        startAt: { $lte: a.now },
        endAt: { $gt: a.now },
        $expr: {
          $or: [
            { $eq: [{ $ifNull: ['$usageLimit', null] }, null] },
            { $lt: ['$usedCount', '$usageLimit'] },
          ],
        },
      },
      { $inc: { usedCount: 1 } },
      { new: true, session },
    );
    if (!c) {
      const cur = await Coupon.findById(id).session(session);
      if (cur?.usageLimit != null && cur.usedCount >= cur.usageLimit)
        throw fail('COUPON_USAGE_LIMIT', 'This coupon has been fully used');
      throw fail('COUPON_INACTIVE', 'This coupon is no longer valid');
    }
    if (c.perUserLimit != null) {
      try {
        await CouponUserUsage.updateOne(
          { couponId: id, userId: a.patientId, used: { $lt: c.perUserLimit } },
          { $inc: { used: 1 } },
          { upsert: true, session },
        );
      } catch (err) {
        // the row exists and is already at the limit => the upsert tried to insert a duplicate
        if ((err as { code?: number }).code === 11000)
          throw fail(
            'COUPON_USER_LIMIT',
            'You have already used this coupon the maximum number of times',
          );
        throw err;
      }
    }
    await CouponRedemption.create(
      [
        {
          couponId: id,
          userId: a.patientId,
          bookingId: a.bookingId,
          code: a.snapshot.code,
          discountMinor: a.snapshot.discountMinor,
        },
      ],
      { session },
    );
  },

  /**
   * An UNPAID booking that expired or was cancelled gives its use back (otherwise abandoned
   * checkouts would burn limited coupons). Idempotent: only an APPLIED redemption can be released.
   * Paid bookings keep their use (a refund is a separate, audited financial flow).
   */
  async releaseForBooking(b: BookingDoc, reason: string, session: ClientSession): Promise<boolean> {
    if (!b.couponSnapshot || b.paidAt) return false;
    const red = await CouponRedemption.findOneAndUpdate(
      { bookingId: b._id, status: 'APPLIED' },
      { $set: { status: 'RELEASED', releasedAt: new Date(), releaseReason: reason } },
      { session },
    );
    if (!red) return false;
    await Coupon.updateOne(
      { _id: red.couponId, usedCount: { $gt: 0 } },
      { $inc: { usedCount: -1 } },
      { session },
    );
    await CouponUserUsage.updateOne(
      { couponId: red.couponId, userId: red.userId, used: { $gt: 0 } },
      { $inc: { used: -1 } },
      { session },
    );
    return true;
  },

  // ------------------------------------------------------------------ admin
  async create(input: CouponInput, ctx: AuditContext): Promise<CouponDoc> {
    assertTerms(input);
    try {
      return await withTransaction(async (session) => {
        const [c] = await Coupon.create(
          [
            {
              ...input,
              code: normalizeCode(input.code),
              applicableServiceIds: input.applicableServiceIds ?? [],
              applicableNurseIds: input.applicableNurseIds ?? [],
              createdBy: ctx.actorId,
              updatedBy: ctx.actorId,
            },
          ],
          { session },
        );
        await AuditService.record(
          ctx,
          {
            action: 'coupon.created',
            entity: 'Coupon',
            entityId: String(c!._id),
            newData: {
              code: c!.code,
              type: c!.type,
              valueMinor: c!.valueMinor,
              valueBps: c!.valueBps,
            },
          },
          session,
        );
        return c!;
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000)
        throw new ConflictError('A coupon with this code already exists', 'COUPON_CODE_EXISTS');
      throw err;
    }
  },

  /** Changes the terms for FUTURE bookings only (version bump); existing booking snapshots are unaffected. */
  async update(id: string, patch: Partial<Omit<CouponInput, 'code'>>, ctx: AuditContext) {
    return withTransaction(async (session) => {
      const before = await Coupon.findById(id).session(session);
      if (!before) throw new NotFoundError('Coupon not found', 'COUPON_NOT_FOUND');
      const merged = {
        type: patch.type ?? before.type,
        valueMinor: patch.type
          ? patch.valueMinor
          : (patch.valueMinor ?? before.valueMinor ?? undefined),
        valueBps: patch.type ? patch.valueBps : (patch.valueBps ?? before.valueBps ?? undefined),
        startAt: patch.startAt ?? before.startAt,
        endAt: patch.endAt ?? before.endAt,
      };
      assertTerms(merged);
      const set: Record<string, unknown> = { ...patch, updatedBy: ctx.actorId };
      const unset: Record<string, 1> = {};
      if (patch.type === 'FIXED') unset.valueBps = 1;
      if (patch.type === 'PERCENTAGE') unset.valueMinor = 1;
      const after = await Coupon.findByIdAndUpdate(
        id,
        { $set: set, ...(Object.keys(unset).length && { $unset: unset }), $inc: { version: 1 } },
        { new: true, session, runValidators: true },
      );
      await AuditService.record(
        ctx,
        {
          action: 'coupon.updated',
          entity: 'Coupon',
          entityId: id,
          oldData: {
            version: before.version,
            type: before.type,
            valueMinor: before.valueMinor,
            valueBps: before.valueBps,
          },
          newData: { version: after!.version, changed: Object.keys(patch) },
        },
        session,
      );
      return after!;
    });
  },

  async setActive(id: string, active: boolean, ctx: AuditContext) {
    return withTransaction(async (session) => {
      const c = await Coupon.findById(id).session(session);
      if (!c) throw new NotFoundError('Coupon not found', 'COUPON_NOT_FOUND');
      if (c.active === active) return { coupon: c, changed: false };
      const after = await Coupon.findOneAndUpdate(
        { _id: id, active: c.active },
        { $set: { active, updatedBy: ctx.actorId }, $inc: { version: 1 } },
        { new: true, session },
      );
      if (!after) throw new ConflictError('Coupon changed concurrently; retry', 'COUPON_CONFLICT');
      await AuditService.record(
        ctx,
        {
          action: active ? 'coupon.activated' : 'coupon.deactivated',
          entity: 'Coupon',
          entityId: id,
          oldData: { active: c.active },
          newData: { active },
        },
        session,
      );
      return { coupon: after, changed: true };
    });
  },

  async list(q: { page: number; limit: number; active?: boolean }) {
    const filter: FilterQuery<unknown> = q.active === undefined ? {} : { active: q.active };
    const [items, total] = await Promise.all([
      Coupon.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((q.page - 1) * q.limit)
        .limit(q.limit),
      Coupon.countDocuments(filter),
    ]);
    return { items, total };
  },

  async inspect(id: string) {
    const c = await Coupon.findById(id);
    if (!c) throw new NotFoundError('Coupon not found', 'COUPON_NOT_FOUND');
    const [applied, released, discount] = await Promise.all([
      CouponRedemption.countDocuments({ couponId: id, status: 'APPLIED' }),
      CouponRedemption.countDocuments({ couponId: id, status: 'RELEASED' }),
      CouponRedemption.aggregate<{ total: number }>([
        { $match: { couponId: new Types.ObjectId(id), status: 'APPLIED' } },
        { $group: { _id: null, total: { $sum: '$discountMinor' } } },
      ]),
    ]);
    return {
      coupon: c,
      usage: { applied, released, totalDiscountMinor: discount[0]?.total ?? 0 },
    };
  },
};
