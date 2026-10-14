import { randomBytes } from 'node:crypto';
import type { ClientSession, FilterQuery } from 'mongoose';
import { withTransaction } from '../../config/database';
import {
  AppError,
  BookingConflictError,
  ConflictError,
  InvalidBookingStateError,
  NotFoundError,
} from '../../common/errors';
import { toGeoPoint, type LatLng } from '../../common/types/geo';
import { verifyQuoteToken } from '../../common/utils/jwt';
import { withBestEffortLock } from '../../common/utils/redisLock';
import { AuditService, type AuditContext } from '../audit';
import { mulDivRound } from '../../common/utils/time';
import { NurseProfile } from '../nurses';
import { PricingService, type Quote } from '../pricing';
import { toPricingService } from '../services';
import { SettingsService } from '../settings';
import { User } from '../users';
import {
  Booking,
  BookingHistory,
  BookingItem,
  BookingReservation,
  type BookingDoc,
} from './booking.models';
import { BLOCKING_STATUSES, SYSTEM_ACTOR, type Actor, type BookingStatus } from './booking.states';
import { getBookingHooks, type CouponSnapshot } from './booking.hooks';
import { computeCancellationOutcome, type PolicyTier } from './booking.refund';
import { BookingStateMachine, type BookingRefund } from './booking.statemachine';
import { assertEligible } from './booking.validation';
import { ReservationService } from './reservation.service';

const MIN = 60_000;

export interface QuoteRequest {
  serviceId: string;
  nurseId: string;
  startDateTime: Date;
  endDateTime: Date;
  location?: LatLng;
  genderPreference?: 'MALE' | 'FEMALE' | 'OTHER';
  /** Optional coupon. The server computes the discount from the gross amount; the client never sends one. */
  couponCode?: string;
}

export interface CreateBookingRequest extends QuoteRequest {
  location: LatLng & { address: string; city?: string; country?: string };
  notes?: string;
  quoteToken: string;
}

const patientActor = (userId: string): Actor => ({ role: 'PATIENT', userId });
const PAID_CANCELLABLE: BookingStatus[] = ['NURSE_PENDING', 'NURSE_ACCEPTED', 'CONFIRMED'];
const policyOf = (b: BookingDoc): PolicyTier[] =>
  (b.refundPolicySnapshot?.tiers ?? []).map((t) => ({
    minHoursBeforeStart: t.minHoursBeforeStart as number,
    refundPercent: t.refundPercent as number,
    nurseCompensationPercent: t.nurseCompensationPercent as number,
  }));
const bookingNumber = () =>
  `BK-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${randomBytes(4).toString('hex').toUpperCase()}`;

const quoteMismatch = (why: string) =>
  new AppError(409, 'QUOTE_MISMATCH', `The quote no longer matches this request: ${why}`);

export const BookingService = {
  // ---------------------------------------------------------------- quote
  async quote(patientId: string, req: QuoteRequest): Promise<Quote> {
    const now = new Date();
    const settings = await SettingsService.getAll();
    const startMs = req.startDateTime.getTime();
    const endMs = req.endDateTime.getTime();
    const el = await assertEligible({
      serviceId: req.serviceId,
      nurseId: req.nurseId,
      window: { startMs, endMs },
      location: req.location,
      genderPreference: req.genderPreference,
      settings,
      now,
      checkReservations: true,
    });
    const args = {
      service: toPricingService(el.service),
      nurseId: req.nurseId,
      offer: el.offer,
      patientId,
      startMs,
      endMs,
      now,
    };
    const { quote } = await this.quoteWithCoupon(patientId, req, args);
    return quote;
  },

  /**
   * Prices without a coupon to learn the GROSS amount, lets the coupon module compute the discount
   * from that gross (platform funded), then prices again with the discount. Returns the coupon
   * snapshot that must be stored on the booking.
   */
  async quoteWithCoupon(
    patientId: string,
    req: { couponCode?: string; serviceId: string; nurseId: string },
    args: Parameters<typeof PricingService.quote>[0],
  ): Promise<{ quote: Quote; snapshot?: CouponSnapshot }> {
    const plain = await PricingService.quote(args);
    if (!req.couponCode) return { quote: plain };
    const hook = getBookingHooks().discount;
    if (!hook) throw new AppError(422, 'COUPONS_UNAVAILABLE', 'Coupons are not available');
    const ev = await hook.evaluate({
      code: req.couponCode,
      patientId,
      serviceId: req.serviceId,
      nurseId: req.nurseId,
      grossMinor: plain.pricing.grossMinor,
      now: args.now ?? new Date(),
    });
    const quote = await PricingService.quote({
      ...args,
      coupon: {
        code: ev.snapshot.code,
        discountMinor: ev.discountMinor,
        fingerprint: `${ev.snapshot.couponId}:${ev.snapshot.couponVersion}:${ev.discountMinor}`,
      },
    });
    return { quote, snapshot: { ...ev.snapshot, discountMinor: quote.pricing.discountMinor } };
  },

  // ---------------------------------------------------------------- create
  /**
   * Defense in depth against double booking (MongoDB is authoritative):
   *  1. Redis lock per nurse (best-effort; skipped silently if Redis is unavailable)
   *  2. MongoDB transaction
   *  3. per-nurse write guard: `$inc bookingSeq` on the nurse document serialises concurrent
   *     booking transactions for the same nurse (the loser gets a WriteConflict and retries)
   *  4. overlap query against live bookings
   *  5. slot reservations: unique {nurseId, slotStart} makes overlapping ranges impossible even if
   *     every other layer were bypassed
   */
  async create(
    patientId: string,
    req: CreateBookingRequest,
    opts: { inTxn?: (session: ClientSession, booking: BookingDoc) => Promise<void> } = {},
  ): Promise<BookingDoc> {
    const now = new Date();
    const settings = await SettingsService.getAll();
    const startMs = req.startDateTime.getTime();
    const endMs = req.endDateTime.getTime();

    // quote binding
    const q = verifyQuoteToken(req.quoteToken);
    if (q.pid !== patientId) throw quoteMismatch('issued to a different patient');
    if (q.svc !== req.serviceId || q.nrs !== req.nurseId)
      throw quoteMismatch('service or nurse differs');
    if (q.st !== startMs || q.en !== endMs) throw quoteMismatch('time range differs');

    const el = await assertEligible({
      serviceId: req.serviceId,
      nurseId: req.nurseId,
      window: { startMs, endMs },
      location: req.location,
      genderPreference: req.genderPreference,
      settings,
      now,
    });

    // The coupon must be the one the quote was priced with (a code cannot be added or swapped later).
    const wantedCode = req.couponCode?.trim().toUpperCase();
    if ((q.cpn ?? undefined) !== wantedCode) throw quoteMismatch('coupon differs');

    // The server prices again. The client's number is only ever compared, never used.
    const { quote: fresh, snapshot: couponSnapshot } = await this.quoteWithCoupon(patientId, req, {
      service: toPricingService(el.service),
      nurseId: req.nurseId,
      offer: el.offer,
      patientId,
      startMs,
      endMs,
      now,
    });
    if (fresh.pricingVersion !== q.ver || fresh.pricing.patientPayableMinor !== q.tot) {
      throw quoteMismatch('prices changed since the quote was issued');
    }

    const [patient, nurseUser] = await Promise.all([
      User.findById(patientId).select('firstName lastName'),
      User.findById(el.nurse.userId).select('firstName lastName'),
    ]);
    if (!patient || !nurseUser) throw new NotFoundError('User not found', 'USER_NOT_FOUND');

    const holdExpiresAt = new Date(now.getTime() + settings['booking.holdMinutes'] * MIN);
    const number = bookingNumber();
    const pricing = fresh.pricing;
    const zeroPayable = pricing.patientPayableMinor === 0;
    // wallet must exist before the money transaction (zero-payment credits the nurse in it)
    if (zeroPayable) await getBookingHooks().zeroPayment?.prepare({ nurseId: req.nurseId });

    return withBestEffortLock(`lock:nurse:${req.nurseId}`, () =>
      withTransaction(async (session) => {
        // (3) per-nurse serialization guard; also re-checks the nurse is still bookable
        const nurse = await NurseProfile.findOneAndUpdate(
          { _id: req.nurseId, isBookable: true },
          { $inc: { bookingSeq: 1 } },
          { new: true, session },
        );
        if (!nurse)
          throw new AppError(
            422,
            'NURSE_NOT_BOOKABLE',
            'This nurse cannot currently receive bookings',
          );

        // lapsed-but-unswept holds must not block a legitimate booking
        await BookingService.expireLapsedForNurse(req.nurseId, now, session);

        // (4) overlap query
        const clash = await Booking.exists({
          nurseId: req.nurseId,
          status: { $in: BLOCKING_STATUSES },
          startDateTime: { $lt: req.endDateTime },
          endDateTime: { $gt: req.startDateTime },
        }).session(session);
        if (clash) throw new BookingConflictError();

        const [booking] = await Booking.create(
          [
            {
              bookingNumber: number,
              patientId,
              nurseId: req.nurseId,
              nurseUserId: nurse.userId,
              serviceId: req.serviceId,
              serviceSnapshot: {
                name: el.service.name,
                slug: el.service.slug,
                category: el.service.category,
                billingUnit: el.service.billingUnit,
              },
              nurseSnapshot: {
                displayName: `${nurseUser.firstName} ${nurseUser.lastName.charAt(0)}.`,
              },
              patientSnapshot: {
                displayName: `${patient.firstName} ${patient.lastName.charAt(0)}.`,
              },
              startDateTime: req.startDateTime,
              endDateTime: req.endDateTime,
              durationMinutes: pricing.durationMinutes,
              slotMinutes: settings['booking.slotMinutes'],
              location: {
                point: toGeoPoint(req.location),
                address: req.location.address,
                city: req.location.city,
                country: req.location.country,
              },
              notes: req.notes,
              genderPreference: req.genderPreference,
              pricingSnapshot: {
                currency: pricing.currency,
                unit: pricing.unit,
                rateMinor: pricing.lines[0]!.unitAmountMinor,
                rateSource: fresh.rateSource,
                lines: pricing.lines,
                baseMinor: pricing.baseMinor,
                surchargeMinor: pricing.surchargeMinor,
                feesMinor: pricing.feesMinor,
                grossMinor: pricing.grossMinor,
                discountMinor: pricing.discountMinor,
                patientPayableMinor: pricing.patientPayableMinor,
                pricingVersion: fresh.pricingVersion,
                priceRuleIds: fresh.priceRuleIds,
                quotedAt: now,
              },
              financialSnapshot: pricing.financial,
              ...(couponSnapshot && { couponSnapshot }),
              commissionSnapshot: {
                type: fresh.commission.type,
                bps: pricing.financial.commissionBps,
                fixedMinor: fresh.commission.fixedMinor,
                platformMinor: pricing.financial.commissionMinor,
                nurseMinor: pricing.financial.nurseEarningMinor,
              },
              refundPolicySnapshot: { tiers: settings['refund.policy'] },
              status: 'PENDING',
            },
          ],
          { session },
        );
        const id = String(booking!._id);

        await BookingHistory.create(
          [
            {
              bookingId: id,
              previousState: null,
              newState: 'PENDING',
              actorId: patientId,
              actorRole: 'PATIENT',
              reason: 'Booking requested',
              metadata: { quoteVersion: fresh.pricingVersion },
            },
          ],
          { session },
        );
        await BookingItem.create(
          pricing.lines.map((l) => ({
            bookingId: id,
            kind:
              l.code === 'BASE'
                ? 'BASE'
                : l.code === 'FEE'
                  ? 'FEE'
                  : l.code === 'DISCOUNT'
                    ? 'DISCOUNT'
                    : 'SURCHARGE',
            code: l.code,
            label: l.label,
            quantity: l.quantity,
            unitAmountMinor: l.unitAmountMinor,
            amountMinor: l.amountMinor,
          })),
          { session, ordered: true },
        );

        // coupon: consume one use atomically (global + per-user limits) in THIS transaction
        if (couponSnapshot)
          await getBookingHooks().discount!.redeem(
            { snapshot: couponSnapshot, patientId, bookingId: id, now },
            session,
          );

        // (5) reserve the exact time range; unique index is the final arbiter
        await ReservationService.reserve(
          {
            nurseId: req.nurseId,
            bookingId: id,
            startMs,
            endMs,
            slotMinutes: settings['booking.slotMinutes'],
            holdExpiresAt,
          },
          session,
        );

        const created = await BookingStateMachine.transition(
          id,
          'PAYMENT_PENDING',
          patientActor(patientId),
          { session, now, reason: 'Awaiting payment', patch: { holdExpiresAt } },
        );
        // Fully discounted: no provider payment exists. The explicit server-side zero-payment
        // flow records an internal PAID payment and credits the nurse (gross based) atomically.
        let result = created;
        if (zeroPayable) {
          const settle = getBookingHooks().zeroPayment;
          if (!settle)
            throw new AppError(500, 'ZERO_PAYMENT_UNAVAILABLE', 'Zero-payment is not available');
          await settle.settle(created, session);
          result = (await Booking.findById(id).session(session)) as BookingDoc;
        }
        // e.g. complete the idempotency record in the SAME transaction as the booking
        await opts.inTxn?.(session, result);
        return result;
      }),
    );
  },

  // ---------------------------------------------------------------- reads
  async getForViewer(id: string, viewer: { userId: string; role: string }): Promise<BookingDoc> {
    const b = await Booking.findById(id);
    const allowed =
      b &&
      (viewer.role === 'ADMIN' ||
        (viewer.role === 'PATIENT' && String(b.patientId) === viewer.userId) ||
        (viewer.role === 'NURSE' && String(b.nurseUserId) === viewer.userId && !!b.paidAt));
    // 404 (not 403) so booking ids of other users are not discoverable
    if (!b || !allowed) throw new NotFoundError('Booking not found', 'BOOKING_NOT_FOUND');
    return b;
  },

  async list(
    viewer: { userId: string; role: string },
    q: {
      page: number;
      limit: number;
      status?: BookingStatus;
      from?: Date;
      to?: Date;
      patientId?: string;
      nurseId?: string;
    },
  ) {
    const filter: FilterQuery<unknown> = {};
    if (viewer.role === 'PATIENT') filter.patientId = viewer.userId;
    else if (viewer.role === 'NURSE') {
      filter.nurseUserId = viewer.userId;
      filter.paidAt = { $exists: true }; // nurses never see unpaid holds
    } else {
      if (q.patientId) filter.patientId = q.patientId;
      if (q.nurseId) filter.nurseId = q.nurseId;
    }
    if (q.status) filter.status = q.status;
    if (q.from || q.to)
      filter.startDateTime = { ...(q.from && { $gte: q.from }), ...(q.to && { $lte: q.to }) };
    const [items, total] = await Promise.all([
      Booking.find(filter)
        .sort({ startDateTime: -1 })
        .skip((q.page - 1) * q.limit)
        .limit(q.limit),
      Booking.countDocuments(filter),
    ]);
    return {
      items,
      meta: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) },
    };
  },

  async history(id: string, viewer: { userId: string; role: string }) {
    await this.getForViewer(id, viewer);
    return BookingHistory.find({ bookingId: id }).sort({ createdAt: 1 }).lean();
  },

  // ---------------------------------------------------------------- patient actions
  /**
   * Patient cancellation.
   *  - unpaid (PENDING / PAYMENT_PENDING): cancelled, slot released, nothing to refund
   *  - paid and not started (NURSE_PENDING / NURSE_ACCEPTED / CONFIRMED): CANCELLED, then
   *    REFUND_PENDING with the amount taken from the booking's SNAPSHOTTED refund policy
   *    (0% => stays CANCELLED with refund.status NONE). The provider refund is Phase 3.
   * Anything else (in progress, completed, already cancelled/refunded, ...) is refused.
   */
  async cancelByPatient(id: string, patientId: string, reason?: string): Promise<BookingDoc> {
    const now = new Date();
    return withTransaction(async (session) => {
      const b = await Booking.findOne({ _id: id, patientId }).session(session);
      if (!b) throw new NotFoundError('Booking not found', 'BOOKING_NOT_FOUND');
      const actor = patientActor(patientId);
      if (b.status === 'PAYMENT_PENDING' || b.status === 'PENDING') {
        return BookingStateMachine.transition(id, 'CANCELLED', actor, {
          session,
          now,
          reason: reason ?? 'Cancelled by patient',
          patch: { cancelledAt: now, cancelledBy: 'PATIENT', holdExpiresAt: null },
        });
      }
      if (!PAID_CANCELLABLE.includes(b.status as BookingStatus)) {
        throw new ConflictError(
          `A booking in status ${b.status} cannot be cancelled`,
          'CANCELLATION_NOT_ALLOWED',
        );
      }
      return this.cancelPaid(b, actor, { reason: reason ?? 'Cancelled by patient' }, session, now);
    });
  },

  /** Shared by patient and admin cancellation of a PAID booking. Runs in the caller's transaction. */
  async cancelPaid(
    b: BookingDoc,
    actor: Actor,
    opts: { reason: string; overridePercent?: number },
    session: ClientSession,
    now: Date,
  ): Promise<BookingDoc> {
    const id = String(b._id);
    const by = actor.role === 'ADMIN' ? 'ADMIN' : 'PATIENT';
    const outcome = computeCancellationOutcome({
      tiers: policyOf(b),
      startMs: b.startDateTime.getTime(),
      nowMs: now.getTime(),
      paidMinor: b.pricingSnapshot!.patientPayableMinor,
      nurseEarningMinor: b.financialSnapshot!.nurseEarningMinor,
      overridePercent: opts.overridePercent,
    });
    const reasonCode = by === 'ADMIN' ? 'ADMIN_CANCELLATION' : 'PATIENT_CANCELLATION';
    const cancelled = await BookingStateMachine.transition(id, 'CANCELLED', actor, {
      session,
      now,
      reason: opts.reason,
      metadata: { refundPercent: outcome.refundPercent, refundMinor: outcome.refundMinor },
      patch: {
        cancelledAt: now,
        cancelledBy: by,
        holdExpiresAt: null,
        nurseResponseDeadline: null,
        cancellationOutcome: { cancelledBy: by, ...outcome },
        ...(outcome.refundMinor === 0 && {
          refund: {
            status: 'NONE',
            reason: reasonCode,
            percent: 0,
            amountMinor: 0,
            requestedAt: now,
          },
        }),
      },
    });
    const zeroPaid = b.pricingSnapshot!.patientPayableMinor === 0;
    if (outcome.refundMinor === 0 && !(zeroPaid && outcome.refundPercent > 0)) return cancelled;
    return this.toRefundPending(id, session, now, {
      reason: reasonCode,
      percent: outcome.refundPercent,
      amountMinor: outcome.refundMinor,
      why: 'Refund due per cancellation policy',
    });
  },

  /** Records the refund obligation and moves to REFUND_PENDING (business state only; no provider call). */
  async toRefundPending(
    id: string,
    session: ClientSession,
    now: Date,
    a: {
      reason: BookingRefund['reason'];
      percent: number;
      amountMinor: number;
      why?: string;
      actor?: Actor;
    },
  ): Promise<BookingDoc> {
    const out = await BookingStateMachine.transition(
      id,
      'REFUND_PENDING',
      a.actor ?? SYSTEM_ACTOR,
      {
        session,
        now,
        reason: a.why,
        patch: {
          refund: {
            status: 'PENDING',
            reason: a.reason,
            percent: a.percent,
            amountMinor: a.amountMinor,
            requestedAt: now,
          },
        },
      },
    );
    // Finance hook: refund obligation + nurse-earnings reversal, in this same transaction.
    await getBookingHooks().onRefundPending?.(out, session);
    // Nothing was paid, so there is no provider refund to wait for: the (ledger-only) refund is complete.
    if (out.pricingSnapshot!.patientPayableMinor === 0)
      return (await this.completeRefund(id, { session, now, providerRefundId: 'ZERO_PAYMENT' }))
        .booking;
    return out;
  },

  /** Admin (privileged) cancellation of an unstarted booking; optional refund % override; audit-logged. */
  async adminCancel(
    id: string,
    ctx: AuditContext,
    input: { reason: string; refundPercent?: number },
  ): Promise<BookingDoc> {
    const now = new Date();
    const actor: Actor = { role: 'ADMIN', userId: ctx.actorId };
    return withTransaction(async (session) => {
      const b = await Booking.findById(id).session(session);
      if (!b) throw new NotFoundError('Booking not found', 'BOOKING_NOT_FOUND');
      let out: BookingDoc;
      if (b.status === 'PAYMENT_PENDING' || b.status === 'PENDING') {
        out = await BookingStateMachine.transition(id, 'CANCELLED', actor, {
          session,
          now,
          reason: input.reason,
          patch: { cancelledAt: now, cancelledBy: 'ADMIN', holdExpiresAt: null },
        });
      } else if (PAID_CANCELLABLE.includes(b.status as BookingStatus)) {
        out = await this.cancelPaid(
          b,
          actor,
          { reason: input.reason, overridePercent: input.refundPercent },
          session,
          now,
        );
      } else {
        throw new ConflictError(
          `A booking in status ${b.status} cannot be cancelled`,
          'CANCELLATION_NOT_ALLOWED',
        );
      }
      await AuditService.record(
        ctx,
        {
          action: 'booking.cancelled_by_admin',
          entity: 'Booking',
          entityId: id,
          oldData: { status: b.status },
          newData: {
            status: out.status,
            reason: input.reason,
            refundPercentOverride: input.refundPercent ?? null,
            refund: out.refund ?? null,
          },
        },
        session,
      );
      return out;
    });
  },

  /** Admin decision for a DISPUTED booking (e.g. a no-show): refund (1-100%) or complete without refund. */
  async adminResolve(
    id: string,
    ctx: AuditContext,
    input: { resolution: 'REFUND' | 'COMPLETE'; refundPercent?: number; reason: string },
  ): Promise<BookingDoc> {
    const now = new Date();
    const actor: Actor = { role: 'ADMIN', userId: ctx.actorId };
    return withTransaction(async (session) => {
      const b = await Booking.findById(id).session(session);
      if (!b) throw new NotFoundError('Booking not found', 'BOOKING_NOT_FOUND');
      if (b.status !== 'DISPUTED')
        throw new InvalidBookingStateError(
          `Booking is ${b.status}; only DISPUTED bookings can be resolved`,
        );
      let out: BookingDoc;
      if (input.resolution === 'REFUND') {
        const percent = input.refundPercent ?? 100;
        if (!Number.isInteger(percent) || percent < 1 || percent > 100)
          throw new AppError(
            400,
            'INVALID_REFUND_PERCENT',
            'refundPercent must be an integer 1-100',
          );
        out = await this.toRefundPending(id, session, now, {
          reason: 'ADMIN_RESOLUTION',
          percent,
          amountMinor: mulDivRound(b.pricingSnapshot!.patientPayableMinor, percent, 100),
          why: input.reason,
          actor,
        });
      } else {
        out = await BookingStateMachine.transition(id, 'COMPLETED', actor, {
          session,
          now,
          reason: input.reason,
          patch: { completedAt: now },
        });
      }
      await AuditService.record(
        ctx,
        {
          action: 'booking.dispute_resolved',
          entity: 'Booking',
          entityId: id,
          oldData: { status: b.status },
          newData: {
            status: out.status,
            resolution: input.resolution,
            reason: input.reason,
            refund: out.refund ?? null,
          },
        },
        session,
      );
      return out;
    });
  },

  // ---------------------------------------------------------------- nurse actions
  async ownedByNurse(id: string, nurseUserId: string, session: ClientSession): Promise<BookingDoc> {
    const b = await Booking.findOne({ _id: id, nurseUserId, paidAt: { $exists: true } }).session(
      session,
    );
    if (!b) throw new NotFoundError('Booking not found', 'BOOKING_NOT_FOUND');
    return b;
  },

  /** NURSE_PENDING -> NURSE_ACCEPTED -> CONFIRMED in one transaction (two history rows). */
  async accept(id: string, nurseUserId: string): Promise<BookingDoc> {
    const actor: Actor = { role: 'NURSE', userId: nurseUserId };
    const now = new Date();
    const res = await withTransaction(async (session) => {
      const b = await this.ownedByNurse(id, nurseUserId, session);
      if (
        b.status === 'NURSE_PENDING' &&
        b.nurseResponseDeadline &&
        b.nurseResponseDeadline <= now
      ) {
        return { expired: true as const };
      }
      await BookingStateMachine.transition(id, 'NURSE_ACCEPTED', actor, {
        session,
        now,
        reason: 'Accepted by nurse',
      });
      const confirmed = await BookingStateMachine.transition(id, 'CONFIRMED', actor, {
        session,
        now,
        reason: 'Confirmed',
        patch: { confirmedAt: now, nurseResponseDeadline: null },
      });
      return { expired: false as const, booking: confirmed };
    });
    if (res.expired) {
      await this.expireDue(now);
      throw new AppError(
        409,
        'BOOKING_EXPIRED',
        'The response window for this booking has expired',
      );
    }
    return res.booking;
  },

  /** NURSE_PENDING -> NURSE_REJECTED -> REFUND_PENDING (100% refund), atomically. */
  async reject(id: string, nurseUserId: string, reason?: string): Promise<BookingDoc> {
    const now = new Date();
    return withTransaction(async (session) => {
      const b = await this.ownedByNurse(id, nurseUserId, session);
      await BookingStateMachine.transition(
        id,
        'NURSE_REJECTED',
        { role: 'NURSE', userId: nurseUserId },
        {
          session,
          now,
          reason: reason ?? 'Rejected by nurse',
          patch: { nurseResponseDeadline: null },
        },
      );
      return this.toRefundPending(id, session, now, {
        reason: 'NURSE_REJECTED',
        percent: 100,
        amountMinor: b.pricingSnapshot!.patientPayableMinor,
        why: 'Full refund: nurse rejected the booking',
      });
    });
  },

  /** CONFIRMED -> CARE_STARTED, and on to CARE_IN_PROGRESS once the scheduled start has passed. */
  async start(id: string, nurseUserId: string): Promise<BookingDoc> {
    const actor: Actor = { role: 'NURSE', userId: nurseUserId };
    const now = new Date();
    return withTransaction(async (session) => {
      const b = await this.ownedByNurse(id, nurseUserId, session);
      let out = await BookingStateMachine.transition(id, 'CARE_STARTED', actor, {
        session,
        now,
        reason: 'Care started',
        patch: { startedAt: now },
      });
      if (now >= b.startDateTime) {
        out = await BookingStateMachine.transition(id, 'CARE_IN_PROGRESS', actor, { session, now });
      }
      return out;
    });
  },

  async complete(id: string, nurseUserId: string): Promise<BookingDoc> {
    const actor: Actor = { role: 'NURSE', userId: nurseUserId };
    const now = new Date();
    return withTransaction(async (session) => {
      const b = await this.ownedByNurse(id, nurseUserId, session);
      if (b.status === 'CARE_STARTED' && now >= b.startDateTime) {
        await BookingStateMachine.transition(id, 'CARE_IN_PROGRESS', actor, { session, now });
      }
      return BookingStateMachine.transition(id, 'COMPLETED', actor, {
        session,
        now,
        reason: 'Care completed',
        patch: { completedAt: now },
      });
    });
  },

  // ---------------------------------------------------------------- system: payment hook (Phase 3 calls this)
  /**
   * Used by the verified payment webhook, inside ITS transaction. Decides, without throwing and
   * without side effects outside the session, whether this payment can settle the booking:
   *  - PAID:        PAYMENT_PENDING -> PAID -> NURSE_PENDING happened now (via markPaid)
   *  - REPLAY:      the same payment was already applied (duplicate delivery): nothing changed
   *  - NOT_PAYABLE: the booking expired / was cancelled / was paid by a different payment /
   *                 its hold lapsed. It is NEVER revived; the caller must refund the payment.
   */
  async confirmPayment(
    id: string,
    opts: { paymentId: string; session: ClientSession; now?: Date; paymentTime?: Date },
  ): Promise<
    | { result: 'PAID' | 'REPLAY'; booking: BookingDoc }
    | { result: 'NOT_PAYABLE'; booking: BookingDoc | null; status: string }
  > {
    const now = opts.now ?? new Date();
    const b = await Booking.findById(id).session(opts.session);
    if (!b) return { result: 'NOT_PAYABLE', booking: null, status: 'MISSING' };
    if (b.paidAt && b.paymentId && String(b.paymentId) === opts.paymentId) {
      return { result: 'REPLAY', booking: b };
    }
    // The hold is judged at the time the customer PAID (verified provider time when available), but a
    // booking that is no longer PAYMENT_PENDING (expired/cancelled: slot released) or whose start has
    // already passed can never be fulfilled and is never revived.
    const paidAtTime = opts.paymentTime ?? now;
    if (
      b.status !== 'PAYMENT_PENDING' ||
      !b.holdExpiresAt ||
      b.holdExpiresAt <= paidAtTime ||
      b.startDateTime <= now
    ) {
      return { result: 'NOT_PAYABLE', booking: b, status: b.status };
    }
    const paid = await this.markPaid(id, {
      paymentId: opts.paymentId,
      session: opts.session,
      now,
      paymentTime: opts.paymentTime,
    });
    if (!paid) return { result: 'NOT_PAYABLE', booking: b, status: 'HOLD_LAPSED' };
    return { result: 'PAID', booking: paid };
  },

  /**
   * PAYMENT_PENDING -> PAID -> NURSE_PENDING. Phase 3's verified payment webhook calls this
   * inside its own transaction; Phase 2 exposes it for tests only (no HTTP route).
   * An expired hold can never be paid: it is expired instead and the caller gets 409.
   */
  async markPaid(
    id: string,
    opts: { paymentId?: string; session?: ClientSession; now?: Date; paymentTime?: Date } = {},
  ): Promise<BookingDoc> {
    const now = opts.now ?? new Date();
    const settings = await SettingsService.getAll();
    const run = async (session: ClientSession) => {
      const b = await Booking.findById(id).session(session);
      if (!b) throw new NotFoundError('Booking not found', 'BOOKING_NOT_FOUND');
      // Replay of the SAME payment confirmation is a no-op (webhook retries); anything else is refused.
      if (
        opts.paymentId &&
        b.paidAt &&
        b.paymentId &&
        String(b.paymentId) === opts.paymentId &&
        b.status !== 'PAYMENT_PENDING'
      ) {
        return b;
      }
      if (b.status !== 'PAYMENT_PENDING')
        throw new InvalidBookingStateError(`Booking is ${b.status}; it cannot be paid`);
      if (!b.holdExpiresAt || b.holdExpiresAt <= (opts.paymentTime ?? now)) return null;
      await BookingStateMachine.transition(id, 'PAID', SYSTEM_ACTOR, {
        session,
        now,
        paymentTime: opts.paymentTime,
        reason: 'Payment verified',
        patch: { paidAt: now, paymentId: opts.paymentId, holdExpiresAt: null },
      });
      return BookingStateMachine.transition(id, 'NURSE_PENDING', SYSTEM_ACTOR, {
        session,
        now,
        patch: {
          // never later than the scheduled start
          nurseResponseDeadline: new Date(
            Math.min(
              now.getTime() + settings['booking.nurseResponseMinutes'] * MIN,
              b.startDateTime.getTime(),
            ),
          ),
        },
      });
    };
    const out = opts.session ? await run(opts.session) : await withTransaction(run);
    if (!out) {
      // Inside a caller-owned transaction (payment webhook) we must not throw or open other
      // transactions: report "not payable" via null; confirmPayment() turns it into a result.
      if (opts.session) return null as unknown as BookingDoc;
      await this.expireDue(now);
      throw new AppError(409, 'BOOKING_EXPIRED', 'The payment hold for this booking has expired');
    }
    return out;
  },

  // ---------------------------------------------------------------- expiration / lifecycle sweeps
  /** Expire this nurse's lapsed holds / unanswered requests so they stop blocking. Same transaction. */
  async expireLapsedForNurse(nurseId: string, now: Date, session: ClientSession): Promise<number> {
    const lapsed = await Booking.find({
      nurseId,
      $or: [
        { status: 'PAYMENT_PENDING', holdExpiresAt: { $lte: now } },
        { status: 'NURSE_PENDING', nurseResponseDeadline: { $lte: now } },
      ],
    })
      .select('_id')
      .session(session);
    for (const b of lapsed) await this.expireOne(String(b._id), session, now);
    return lapsed.length;
  },

  /**
   * Idempotent sweep: PAYMENT_PENDING past holdExpiresAt and NURSE_PENDING past
   * nurseResponseDeadline become EXPIRED and release their reservations. Safe to run concurrently
   * and repeatedly (BullMQ will schedule this in Phase 4).
   */
  async expireDue(now = new Date(), limit = 200): Promise<{ expired: number }> {
    const due = await Booking.find({
      $or: [
        { status: 'PAYMENT_PENDING', holdExpiresAt: { $lte: now } },
        { status: 'NURSE_PENDING', nurseResponseDeadline: { $lte: now } },
      ],
    })
      .select('_id status')
      .limit(limit)
      .lean();
    let expired = 0;
    for (const b of due) {
      try {
        await withTransaction((session) => this.expireOne(String(b._id), session, now));
        expired += 1;
      } catch (err) {
        if (!(err instanceof InvalidBookingStateError)) throw err; // changed concurrently: already handled
      }
    }
    return { expired };
  },

  /**
   * Auto-complete bookings `endDateTime + grace` after they ended. Only CARE_STARTED /
   * CARE_IN_PROGRESS bookings qualify; cancelled, refunded, disputed, completed, etc. are never touched.
   */
  async autoCompleteDue(now = new Date(), limit = 200): Promise<{ completed: number }> {
    const settings = await SettingsService.getAll();
    const cutoff = new Date(now.getTime() - settings['booking.autoCompleteGraceMinutes'] * MIN);
    const due = await Booking.find({
      status: { $in: ['CARE_STARTED', 'CARE_IN_PROGRESS'] },
      endDateTime: { $lte: cutoff },
    })
      .select('_id')
      .limit(limit)
      .lean();
    let completed = 0;
    for (const b of due) {
      try {
        await withTransaction(async (session) => {
          const cur = await Booking.findById(b._id).session(session);
          if (cur?.status === 'CARE_STARTED') {
            await BookingStateMachine.transition(String(b._id), 'CARE_IN_PROGRESS', SYSTEM_ACTOR, {
              session,
              now,
            });
          }
          await BookingStateMachine.transition(String(b._id), 'COMPLETED', SYSTEM_ACTOR, {
            session,
            now,
            autoComplete: true,
            reason: 'Auto-completed after grace period',
            patch: { completedAt: now },
          });
        });
        completed += 1;
      } catch (err) {
        if (!(err instanceof InvalidBookingStateError)) throw err;
      }
    }
    return { completed };
  },

  /**
   * EXPIRED transition for a lapsed hold (unpaid: nothing to refund) or an unanswered paid request
   * (-> REFUND_PENDING with a 100% refund, same transaction). Guarded by status, so replays are no-ops
   * (callers catch InvalidBookingStateError).
   */
  async expireOne(id: string, session: ClientSession, now: Date): Promise<BookingDoc> {
    const before = await Booking.findById(id).session(session);
    if (!before) throw new NotFoundError('Booking not found', 'BOOKING_NOT_FOUND');
    const paid = !!before.paidAt;
    const expired = await BookingStateMachine.transition(id, 'EXPIRED', SYSTEM_ACTOR, {
      session,
      now,
      reason: paid ? 'Nurse did not respond in time' : 'Payment hold expired',
      patch: { holdExpiresAt: null, nurseResponseDeadline: null },
    });
    if (!paid) return expired;
    return this.toRefundPending(id, session, now, {
      reason: 'NURSE_TIMEOUT',
      percent: 100,
      amountMinor: before.pricingSnapshot!.patientPayableMinor,
      why: 'Full refund: nurse did not respond',
    });
  },

  /**
   * Phase 3 hook: the provider refund succeeded. REFUND_PENDING -> REFUNDED exactly once;
   * a replay returns the booking unchanged (`changed:false`), so duplicate callbacks cannot refund twice.
   */
  async completeRefund(
    id: string,
    opts: { providerRefundId?: string; now?: Date; session?: ClientSession } = {},
  ): Promise<{ booking: BookingDoc; changed: boolean }> {
    const now = opts.now ?? new Date();
    const run = async (session: ClientSession) => {
      const b = await Booking.findById(id).session(session);
      if (!b) throw new NotFoundError('Booking not found', 'BOOKING_NOT_FOUND');
      if (b.status === 'REFUNDED') return { booking: b, changed: false };
      const refund = (b.refund as unknown as { toObject(): BookingRefund } | undefined)?.toObject();
      const booking = await BookingStateMachine.transition(id, 'REFUNDED', SYSTEM_ACTOR, {
        session,
        now,
        reason: 'Refund completed',
        patch: {
          refund: {
            ...(refund as BookingRefund),
            status: 'COMPLETED',
            completedAt: now,
            providerRefundId: opts.providerRefundId,
          },
        },
      });
      return { booking, changed: true };
    };
    return opts.session ? run(opts.session) : withTransaction(run);
  },

  /**
   * Safety net: paid bookings that ended in NURSE_REJECTED / EXPIRED / CANCELLED (refund due)
   * but have no refund obligation recorded are moved to REFUND_PENDING. Idempotent.
   */
  async reconcileRefundRequests(now = new Date(), limit = 200): Promise<{ requested: number }> {
    const rows = await Booking.find({
      status: { $in: ['NURSE_REJECTED', 'EXPIRED', 'CANCELLED'] },
      paidAt: { $exists: true },
      refund: { $exists: false },
    })
      .limit(limit)
      .lean();
    let requested = 0;
    for (const r of rows) {
      const paid = r.pricingSnapshot!.patientPayableMinor;
      let reason: BookingRefund['reason'];
      let percent = 100;
      let amountMinor = paid;
      if (r.status === 'NURSE_REJECTED') reason = 'NURSE_REJECTED';
      else if (r.status === 'EXPIRED') reason = 'NURSE_TIMEOUT';
      else {
        const o = r.cancellationOutcome;
        if (!o || o.refundMinor === 0) continue;
        reason = o.cancelledBy === 'ADMIN' ? 'ADMIN_CANCELLATION' : 'PATIENT_CANCELLATION';
        percent = o.refundPercent;
        amountMinor = o.refundMinor;
      }
      try {
        await withTransaction((session) =>
          this.toRefundPending(String(r._id), session, now, {
            reason,
            percent,
            amountMinor,
            why: 'Refund reconciliation',
          }),
        );
        requested += 1;
      } catch (err) {
        if (!(err instanceof InvalidBookingStateError)) throw err;
      }
    }
    return { requested };
  },

  /**
   * No-show detection. A CONFIRMED booking whose whole window passed (+ grace) without a
   * care-start event goes to DISPUTED for admin review. NOTHING is refunded, completed or paid out
   * automatically: settlement waits for an admin decision (adminResolve). Idempotent.
   */
  async flagNoShows(now = new Date(), limit = 200): Promise<{ flagged: number }> {
    const settings = await SettingsService.getAll();
    const cutoff = new Date(now.getTime() - settings['booking.noShowGraceMinutes'] * MIN);
    const due = await Booking.find({ status: 'CONFIRMED', endDateTime: { $lte: cutoff } })
      .select('_id')
      .limit(limit)
      .lean();
    let flagged = 0;
    for (const b of due) {
      try {
        await BookingStateMachine.transitionAtomic(String(b._id), 'DISPUTED', SYSTEM_ACTOR, {
          now,
          reason: 'NO_SHOW_SUSPECTED: care was never started; awaiting admin review',
          metadata: { source: 'no-show-detector' },
        });
        flagged += 1;
      } catch (err) {
        if (!(err instanceof InvalidBookingStateError)) throw err;
      }
    }
    return { flagged };
  },

  /**
   * Phase 3 contract: the amount credited to the nurse's PENDING wallet balance when payment is
   * confirmed. ALWAYS read from the booking's immutable financial snapshot, never recomputed from
   * current prices. The wallet mutation + ledger row must share the payment-confirmation transaction.
   */
  pendingEarningFor(b: Pick<BookingDoc, '_id' | 'nurseId' | 'financialSnapshot'>) {
    return {
      bookingId: String(b._id),
      nurseId: String(b.nurseId),
      currency: 'AED' as const,
      amountMinor: b.financialSnapshot!.nurseEarningMinor,
      idempotencyKey: `wallet:pending-earning:${String(b._id)}`,
    };
  },

  /** Deletes reservations whose booking no longer blocks time (crash/partial-failure safety net). */
  async cleanupOrphanReservations(): Promise<{ removed: number }> {
    const orphans = await BookingReservation.aggregate<{ _id: unknown }>([
      { $group: { _id: '$bookingId' } },
      { $lookup: { from: 'bookings', localField: '_id', foreignField: '_id', as: 'b' } },
      { $match: { $or: [{ b: { $size: 0 } }, { 'b.status': { $nin: BLOCKING_STATUSES } }] } },
    ]);
    if (!orphans.length) return { removed: 0 };
    const res = await BookingReservation.deleteMany({
      bookingId: { $in: orphans.map((o) => o._id) },
    });
    return { removed: res.deletedCount ?? 0 };
  },
};
