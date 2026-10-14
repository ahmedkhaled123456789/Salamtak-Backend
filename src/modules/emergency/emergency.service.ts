import { createHash } from 'node:crypto';
import { withTransaction } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError, ConflictError, NotFoundError } from '../../common/errors';
import { toGeoPoint, fromGeoPoint, type LatLng } from '../../common/types/geo';
import { AuditService, type AuditContext } from '../audit';
import { BookingService } from '../bookings';
import { IdempotencyService } from '../idempotency';
import { NotificationService } from '../notifications';
import { NurseSearchService } from '../nurse-search';
import { NurseProfile } from '../nurses';
import { Service } from '../services';
import { SettingsService } from '../settings';
import { User } from '../users';
import {
  ACTIVE_EMERGENCY,
  EmergencyOffer,
  EmergencyRequest,
  type EmergencyOfferDoc,
  type EmergencyRequestDoc,
} from './emergency.models';

const MIN = 60_000;
/** Bookings live on the reservation grid: round the start UP to the next slot boundary. */
const alignUp = (ms: number, stepMs: number) => Math.ceil(ms / stepMs) * stepMs;

export interface CreateEmergencyInput {
  serviceId: string;
  location: LatLng & { address: string; city?: string };
  durationMinutes: number;
  genderPreference?: 'MALE' | 'FEMALE' | 'OTHER';
  notes?: string;
}

/** Patient/admin view. Contact details of the patient never go to nurses; exact address only via the booking. */
export const toRequestDTO = (r: EmergencyRequestDoc, admin = false) => ({
  id: String(r._id),
  status: r.status,
  statusReason: r.statusReason ?? null,
  serviceId: String(r.serviceId),
  requestedStart: r.requestedStart,
  durationMinutes: r.durationMinutes,
  genderPreference: r.genderPreference ?? null,
  expiresAt: r.expiresAt,
  offersMade: r.offersMade,
  bookingId: r.bookingId ? String(r.bookingId) : null,
  createdAt: r.createdAt,
  ...(admin && {
    patientId: String(r.patientId),
    acceptedNurseId: r.acceptedNurseId ? String(r.acceptedNurseId) : null,
    location: {
      ...fromGeoPoint(r.location.point),
      address: r.location.address,
      city: r.location.city ?? null,
    },
    notes: r.notes ?? null,
  }),
});

export const toNurseOfferDTO = (
  o: EmergencyOfferDoc,
  r: EmergencyRequestDoc,
  serviceName: string,
) => ({
  offerId: String(o._id),
  requestId: String(r._id),
  service: serviceName,
  city: r.location.city ?? null, // deliberately coarse: no address, no patient identity before acceptance
  requestedStart: r.requestedStart,
  durationMinutes: r.durationMinutes,
  expiresAt: o.expiresAt,
});

async function notify(
  recipientId: string,
  type: string,
  title: string,
  body: string,
  referenceKey: string,
  data: Record<string, string>,
  session?: Parameters<typeof NotificationService.notify>[1],
) {
  await NotificationService.notify(
    { recipientId, type, title, body, data, referenceKey, channels: ['EMAIL', 'PUSH'] },
    session,
  );
}

export const EmergencyService = {
  // ------------------------------------------------------------------ patient
  /**
   * Creates the request (idempotent per Idempotency-Key; at most ONE live request per patient).
   * The start time respects the booking minimum lead: emergency bookings obey every booking rule.
   */
  async create(patientId: string, input: CreateEmergencyInput, key: string) {
    const settings = await SettingsService.getAll();
    const svc = await Service.findById(input.serviceId).lean();
    if (!svc || !svc.isActive)
      throw new AppError(422, 'SERVICE_INACTIVE', 'This service is not available');
    const now = new Date();
    const step = settings['booking.slotMinutes'] * MIN;
    if ((input.durationMinutes * MIN) % step !== 0)
      throw new AppError(
        400,
        'INVALID_DURATION',
        `Duration must be a multiple of ${settings['booking.slotMinutes']} minutes`,
      );
    const start = new Date(
      alignUp(
        now.getTime() +
          (settings['booking.minLeadMinutes'] + settings['emergency.startBufferMinutes']) * MIN,
        step,
      ),
    );
    try {
      return await withTransaction(async (session) => {
        const [r] = await EmergencyRequest.create(
          [
            {
              patientId,
              serviceId: input.serviceId,
              location: {
                point: toGeoPoint(input.location),
                address: input.location.address,
                city: input.location.city,
              },
              requestedStart: start,
              durationMinutes: input.durationMinutes,
              genderPreference: input.genderPreference,
              notes: input.notes,
              expiresAt: new Date(now.getTime() + settings['emergency.requestTtlMinutes'] * MIN),
              idempotencyKey: key,
              status: 'PENDING',
            },
          ],
          { session },
        );
        return r!;
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        const same = await EmergencyRequest.findOne({ patientId, idempotencyKey: key });
        if (same) return same; // retry of the same request
        throw new ConflictError(
          'You already have an active emergency request',
          'EMERGENCY_ALREADY_ACTIVE',
        );
      }
      throw err;
    }
  },

  async getForPatient(patientId: string, id: string) {
    const r = await EmergencyRequest.findOne({ _id: id, patientId });
    if (!r) throw new NotFoundError('Emergency request not found', 'EMERGENCY_NOT_FOUND');
    return r;
  },

  listForPatient: (patientId: string, limit = 20) =>
    EmergencyRequest.find({ patientId }).sort({ createdAt: -1 }).limit(limit),

  async cancel(patientId: string | undefined, id: string, reason: string, ctx?: AuditContext) {
    return withTransaction(async (session) => {
      const r = await EmergencyRequest.findOne({
        _id: id,
        ...(patientId && { patientId }),
      }).session(session);
      if (!r) throw new NotFoundError('Emergency request not found', 'EMERGENCY_NOT_FOUND');
      if (r.status === 'CANCELLED') return { request: r, changed: false };
      if (r.status === 'ACCEPTED' && r.bookingId)
        throw new ConflictError(
          'A booking was already created; cancel the booking instead',
          'EMERGENCY_HAS_BOOKING',
        );
      const updated = await EmergencyRequest.findOneAndUpdate(
        {
          _id: id,
          status: { $in: ['PENDING', 'MATCHING', 'NURSE_OFFERED', 'ACCEPTED'] },
          bookingId: { $exists: false },
        },
        { $set: { status: 'CANCELLED', statusReason: reason }, $unset: { currentOfferId: 1 } },
        { new: true, session },
      );
      if (!updated)
        throw new ConflictError(
          `Request is ${r.status} and cannot be cancelled`,
          'EMERGENCY_STATE',
        );
      await EmergencyOffer.updateMany(
        { requestId: id, status: 'OFFERED' },
        { $set: { status: 'CANCELLED', respondedAt: new Date() } },
        { session },
      );
      if (ctx)
        await AuditService.record(
          ctx,
          {
            action: 'emergency.cancelled_by_admin',
            entity: 'EmergencyRequest',
            entityId: id,
            oldData: { status: r.status },
            newData: { status: 'CANCELLED', reason },
          },
          session,
        );
      return { request: updated, changed: true };
    });
  },

  // ------------------------------------------------------------------ matching
  /**
   * Offers the request to the best remaining candidate, one nurse at a time. Candidates come from the
   * existing nurse search / MatchingService (verified + ACTIVE only, availability and reservations
   * respected). Idempotent and safe to run concurrently: the request moves PENDING/MATCHING ->
   * NURSE_OFFERED with a conditional update, and a unique partial index allows ONE live offer.
   */
  async matchNext(
    requestId: string,
    now = new Date(),
  ): Promise<'OFFERED' | 'NO_CANDIDATE' | 'SKIPPED'> {
    const settings = await SettingsService.getAll();
    const r = await EmergencyRequest.findOne({
      _id: requestId,
      status: { $in: ['PENDING', 'MATCHING'] },
      currentOfferId: { $exists: false },
    });
    if (!r || r.expiresAt <= now) return 'SKIPPED';
    if (r.offersMade >= settings['emergency.maxOffers']) {
      await this.fail(requestId, 'NO_NURSE_AVAILABLE');
      return 'NO_CANDIDATE';
    }

    const end = new Date(r.requestedStart.getTime() + r.durationMinutes * MIN);
    const tried = new Set(
      (await EmergencyOffer.find({ requestId, round: r.round }).select('nurseId').lean()).map((o) =>
        String(o.nurseId),
      ),
    );
    const found = await NurseSearchService.search({
      serviceId: String(r.serviceId),
      gender: r.genderPreference ?? undefined,
      startDateTime: r.requestedStart,
      endDateTime: end,
      location: fromGeoPoint(r.location.point) ?? undefined,
      maxDistanceKm: settings['emergency.maxDistanceKm'],
      withinNurseRadius: true,
      sort: 'relevance',
      page: 1,
      limit: 25,
    }).catch((err: unknown) => {
      logger.warn({ requestId, err: (err as Error).message }, 'Emergency candidate search failed');
      return null;
    });
    if (!found) return 'SKIPPED'; // transient: the next sweep retries
    const candidate = found.items.find((n) => !tried.has(n.id));
    if (!candidate) {
      await this.fail(requestId, 'NO_NURSE_AVAILABLE');
      return 'NO_CANDIDATE';
    }
    const nurse = await NurseProfile.findOne({ _id: candidate.id, isBookable: true })
      .select('userId')
      .lean();
    if (!nurse) return 'SKIPPED';

    try {
      return await withTransaction(async (session) => {
        const claimed = await EmergencyRequest.findOneAndUpdate(
          {
            _id: requestId,
            status: { $in: ['PENDING', 'MATCHING'] },
            currentOfferId: { $exists: false },
          },
          { $set: { status: 'NURSE_OFFERED' }, $inc: { offersMade: 1 } },
          { new: true, session },
        );
        if (!claimed) return 'SKIPPED' as const;
        const [offer] = await EmergencyOffer.create(
          [
            {
              requestId,
              round: r.round,
              nurseId: candidate.id,
              nurseUserId: nurse.userId,
              score: candidate.matchScore ?? undefined,
              expiresAt: new Date(now.getTime() + settings['emergency.offerTtlSeconds'] * 1000),
            },
          ],
          { session },
        );
        await EmergencyRequest.updateOne(
          { _id: requestId },
          { $set: { currentOfferId: offer!._id } },
          { session },
        );
        await notify(
          String(nurse.userId),
          'EMERGENCY_OFFER',
          'Emergency request nearby',
          'An urgent request is waiting for your response.',
          String(offer!._id),
          { offerId: String(offer!._id) },
          session,
        );
        return 'OFFERED' as const;
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return 'SKIPPED'; // lost the race to another worker
      throw err;
    }
  },

  async fail(requestId: string, reason: string) {
    await withTransaction(async (session) => {
      const r = await EmergencyRequest.findOneAndUpdate(
        { _id: requestId, status: { $in: ['PENDING', 'MATCHING', 'NURSE_OFFERED'] } },
        { $set: { status: 'FAILED', statusReason: reason }, $unset: { currentOfferId: 1 } },
        { new: true, session },
      );
      if (!r) return;
      await EmergencyOffer.updateMany(
        { requestId, status: 'OFFERED' },
        { $set: { status: 'CANCELLED', respondedAt: new Date() } },
        { session },
      );
      await notify(
        String(r.patientId),
        'EMERGENCY_NO_NURSE',
        'No nurse available',
        'We could not find an available nurse for your urgent request. Please try a regular booking.',
        `${requestId}:FAILED`,
        { requestId },
        session,
      );
    });
  },

  // ------------------------------------------------------------------ nurse
  async listOffers(nurseUserId: string, now = new Date()) {
    const offers = await EmergencyOffer.find({
      nurseUserId,
      status: 'OFFERED',
      expiresAt: { $gt: now },
    }).sort({
      createdAt: -1,
    });
    const reqs = await EmergencyRequest.find({ _id: { $in: offers.map((o) => o.requestId) } });
    const services = await Service.find({ _id: { $in: reqs.map((r) => r.serviceId) } })
      .select('name')
      .lean();
    const names = new Map(services.map((s) => [String(s._id), s.name]));
    return offers.flatMap((o) => {
      const r = reqs.find((x) => String(x._id) === String(o.requestId));
      return r ? [toNurseOfferDTO(o, r, names.get(String(r.serviceId)) ?? 'Service')] : [];
    });
  },

  /** Single acceptance: conditional offer + request updates in one transaction; then the normal booking flow. */
  async respond(nurseUserId: string, offerId: string, accept: boolean, now = new Date()) {
    const out = await withTransaction(async (session) => {
      const offer = await EmergencyOffer.findOne({ _id: offerId, nurseUserId }).session(session);
      if (!offer) throw new NotFoundError('Offer not found', 'OFFER_NOT_FOUND');
      if (offer.status !== 'OFFERED') {
        if (accept && offer.status === 'ACCEPTED') return { offer, replay: true as const };
        throw new ConflictError(`Offer is ${offer.status}`, 'OFFER_NOT_AVAILABLE');
      }
      if (offer.expiresAt <= now) throw new ConflictError('The offer has expired', 'OFFER_EXPIRED');
      const upd = await EmergencyOffer.findOneAndUpdate(
        { _id: offerId, status: 'OFFERED', expiresAt: { $gt: now } },
        { $set: { status: accept ? 'ACCEPTED' : 'DECLINED', respondedAt: now } },
        { new: true, session },
      );
      if (!upd) throw new ConflictError('The offer is no longer available', 'OFFER_NOT_AVAILABLE');
      const r = await EmergencyRequest.findOneAndUpdate(
        { _id: offer.requestId, status: 'NURSE_OFFERED', currentOfferId: offer._id },
        accept
          ? {
              $set: { status: 'ACCEPTED', acceptedNurseId: offer.nurseId, acceptedAt: now },
              $unset: { currentOfferId: 1 },
            }
          : { $set: { status: 'MATCHING' }, $unset: { currentOfferId: 1 } },
        { new: true, session },
      );
      if (!r) throw new ConflictError('The request is no longer open', 'OFFER_NOT_AVAILABLE');
      return { offer: upd, request: r, replay: false as const };
    });
    if (accept && !out.replay && 'request' in out)
      await this.finalizeBooking(String(out.request._id)).catch(() => undefined);
    return out.offer;
  },

  /**
   * ACCEPTED -> booking through the ordinary quote + create flow (payment still required, nurse
   * eligibility and slot concurrency enforced there). Idempotent per request, so a crash or a retry
   * can never create two bookings. If the nurse can no longer be booked, the request goes back to matching.
   */
  async finalizeBooking(requestId: string, now = new Date()) {
    const r = await EmergencyRequest.findOne({
      _id: requestId,
      status: 'ACCEPTED',
      bookingId: { $exists: false },
    });
    if (!r || !r.acceptedNurseId) return null;
    const settings = await SettingsService.getAll();
    const step = settings['booking.slotMinutes'] * MIN;
    const minStart = new Date(
      alignUp(now.getTime() + (settings['booking.minLeadMinutes'] + 1) * MIN, step),
    );
    const start = r.requestedStart < minStart ? minStart : r.requestedStart;
    const end = new Date(start.getTime() + r.durationMinutes * MIN);
    const patientId = String(r.patientId);
    const point = fromGeoPoint(r.location.point)!;
    try {
      const res = await IdempotencyService.execute<{ id: string }>(
        {
          scope: 'emergency.booking',
          userId: patientId,
          key: `emergency-${requestId}`,
          requestHash: createHash('sha256').update(requestId).digest('hex'),
        },
        async (ctx) => {
          const base = {
            serviceId: String(r.serviceId),
            nurseId: String(r.acceptedNurseId),
            startDateTime: start,
            endDateTime: end,
            location: point,
            genderPreference: r.genderPreference ?? undefined,
          };
          const q = await BookingService.quote(patientId, base);
          const booking = await BookingService.create(
            patientId,
            {
              ...base,
              location: {
                ...point,
                address: r.location.address,
                city: r.location.city ?? undefined,
              },
              quoteToken: q.quoteToken,
            },
            {
              inTxn: (session, b) =>
                ctx.complete(session, { status: 201, body: { id: String(b._id) } }),
            },
          );
          return { status: 201, body: { id: String(booking._id) } };
        },
      );
      await EmergencyRequest.updateOne(
        { _id: requestId, bookingId: { $exists: false } },
        { $set: { bookingId: res.body.id, requestedStart: start } },
      );
      await notify(
        patientId,
        'EMERGENCY_NURSE_FOUND',
        'A nurse accepted your urgent request',
        'Complete the payment to confirm your booking.',
        requestId,
        { requestId, bookingId: res.body.id },
      );
      return res.body.id;
    } catch (err) {
      const permanent = err instanceof AppError && err.statusCode < 500;
      const attempts = r.finalizeAttempts + 1;
      await EmergencyRequest.updateOne(
        { _id: requestId },
        { $set: { finalizeAttempts: attempts } },
      );
      if (permanent || attempts >= 5) await this.revertToMatching(requestId, now);
      return null;
    }
  },

  /** The accepted nurse could not be booked (taken, unbookable ...): offer to the next candidate. */
  async revertToMatching(requestId: string, now = new Date()) {
    await withTransaction(async (session) => {
      const r = await EmergencyRequest.findOneAndUpdate(
        { _id: requestId, status: 'ACCEPTED', bookingId: { $exists: false } },
        {
          $set: { status: 'MATCHING', finalizeAttempts: 0 },
          $unset: { acceptedNurseId: 1, acceptedAt: 1, currentOfferId: 1 },
        },
        { new: true, session },
      );
      if (!r) return;
      await EmergencyOffer.updateMany(
        { requestId, status: 'ACCEPTED' },
        { $set: { status: 'FAILED', respondedAt: now } },
        { session },
      );
    });
  },

  // ------------------------------------------------------------------ scheduled
  /** One pass: expire offers and requests, offer to the next nurse, finish accepted requests. Idempotent. */
  async sweep(now = new Date()) {
    const out = { offersExpired: 0, requestsExpired: 0, offered: 0, noCandidate: 0, finalized: 0 };
    const lapsed = await EmergencyOffer.find({ status: 'OFFERED', expiresAt: { $lte: now } })
      .select('_id requestId')
      .lean();
    for (const o of lapsed) {
      const done = await withTransaction(async (session) => {
        const u = await EmergencyOffer.findOneAndUpdate(
          { _id: o._id, status: 'OFFERED', expiresAt: { $lte: now } },
          { $set: { status: 'EXPIRED', respondedAt: now } },
          { session },
        );
        if (!u) return false;
        await EmergencyRequest.updateOne(
          { _id: o.requestId, status: 'NURSE_OFFERED', currentOfferId: o._id },
          { $set: { status: 'MATCHING' }, $unset: { currentOfferId: 1 } },
          { session },
        );
        return true;
      });
      if (done) out.offersExpired += 1;
    }

    const stale = await EmergencyRequest.find({
      status: { $in: ['PENDING', 'MATCHING', 'NURSE_OFFERED'] },
      expiresAt: { $lte: now },
    })
      .select('_id patientId')
      .limit(100)
      .lean();
    for (const s of stale) {
      const ok = await withTransaction(async (session) => {
        const r = await EmergencyRequest.findOneAndUpdate(
          {
            _id: s._id,
            status: { $in: ['PENDING', 'MATCHING', 'NURSE_OFFERED'] },
            expiresAt: { $lte: now },
          },
          {
            $set: { status: 'EXPIRED', statusReason: 'REQUEST_TIMED_OUT' },
            $unset: { currentOfferId: 1 },
          },
          { new: true, session },
        );
        if (!r) return false;
        await EmergencyOffer.updateMany(
          { requestId: s._id, status: 'OFFERED' },
          { $set: { status: 'CANCELLED', respondedAt: now } },
          { session },
        );
        await notify(
          String(r.patientId),
          'EMERGENCY_NO_NURSE',
          'No nurse available',
          'We could not find an available nurse in time. Please try a regular booking.',
          `${String(s._id)}:EXPIRED`,
          { requestId: String(s._id) },
          session,
        );
        return true;
      });
      if (ok) out.requestsExpired += 1;
    }

    const waiting = await EmergencyRequest.find({
      status: { $in: ['PENDING', 'MATCHING'] },
      currentOfferId: { $exists: false },
      expiresAt: { $gt: now },
    })
      .sort({ createdAt: 1 })
      .limit(25)
      .select('_id')
      .lean();
    for (const w of waiting) {
      const r = await this.matchNext(String(w._id), now);
      if (r === 'OFFERED') out.offered += 1;
      if (r === 'NO_CANDIDATE') out.noCandidate += 1;
    }

    const accepted = await EmergencyRequest.find({
      status: 'ACCEPTED',
      bookingId: { $exists: false },
    })
      .limit(25)
      .select('_id')
      .lean();
    for (const a of accepted)
      if (await this.finalizeBooking(String(a._id), now)) out.finalized += 1;
    return out;
  },

  // ------------------------------------------------------------------ admin
  async listAdmin(q: { page: number; limit: number; status?: string; patientId?: string }) {
    const filter = {
      ...(q.status && { status: q.status }),
      ...(q.patientId && { patientId: q.patientId }),
    };
    const [items, total] = await Promise.all([
      EmergencyRequest.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((q.page - 1) * q.limit)
        .limit(q.limit),
      EmergencyRequest.countDocuments(filter),
    ]);
    return { items, total };
  },

  async inspect(id: string) {
    const r = await EmergencyRequest.findById(id);
    if (!r) throw new NotFoundError('Emergency request not found', 'EMERGENCY_NOT_FOUND');
    const offers = await EmergencyOffer.find({ requestId: id }).sort({ createdAt: 1 });
    const patient = await User.findById(r.patientId).select('firstName lastName').lean();
    return {
      request: r,
      offers,
      patientName: patient ? `${patient.firstName} ${patient.lastName.charAt(0)}.` : null,
    };
  },

  /** Admin intervention: put a FAILED / EXPIRED request back into matching with a fresh deadline. */
  async reopen(id: string, ctx: AuditContext) {
    const settings = await SettingsService.getAll();
    return withTransaction(async (session) => {
      const before = await EmergencyRequest.findById(id).session(session);
      if (!before) throw new NotFoundError('Emergency request not found', 'EMERGENCY_NOT_FOUND');
      if (ACTIVE_EMERGENCY.includes(before.status)) return { request: before, changed: false };
      if (!['FAILED', 'EXPIRED'].includes(before.status))
        throw new ConflictError(`A ${before.status} request cannot be reopened`, 'EMERGENCY_STATE');
      const r = await EmergencyRequest.findOneAndUpdate(
        { _id: id, status: before.status },
        {
          $set: {
            status: 'PENDING',
            offersMade: 0,
            expiresAt: new Date(Date.now() + settings['emergency.requestTtlMinutes'] * MIN),
          },
          $unset: { statusReason: 1, currentOfferId: 1 },
          $inc: { round: 1 },
        },
        { new: true, session },
      );
      if (!r) throw new ConflictError('Request changed concurrently', 'EMERGENCY_CONFLICT');
      await AuditService.record(
        ctx,
        {
          action: 'emergency.reopened_by_admin',
          entity: 'EmergencyRequest',
          entityId: id,
          oldData: { status: before.status },
          newData: { status: 'PENDING' },
        },
        session,
      );
      return { request: r, changed: true };
    });
  },
};
