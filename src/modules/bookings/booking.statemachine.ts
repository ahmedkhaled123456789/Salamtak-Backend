import type { ClientSession } from 'mongoose';
import { InvalidBookingStateError, NotFoundError } from '../../common/errors';
import { withTransaction } from '../../config/database';
import { NurseService } from '../nurses';
import { SettingsService } from '../settings';
import { Booking, BookingHistory, type BookingDoc } from './booking.models';
import { RELEASING_STATUSES, TRANSITIONS, type Actor, type BookingStatus } from './booking.states';
import type { CancellationOutcome } from './booking.refund';
import { getBookingHooks } from './booking.hooks';
import { ReservationService } from './reservation.service';

const MIN = 60_000;

/** Whitelisted mutable lifecycle fields a transition may set alongside the status. */
export interface TransitionPatch {
  holdExpiresAt?: Date | null;
  nurseResponseDeadline?: Date | null;
  paymentId?: string;
  paidAt?: Date;
  confirmedAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  cancelledAt?: Date;
  cancelledBy?: string;
  statusReason?: string;
  refund?: BookingRefund;
  cancellationOutcome?: CancellationOutcome & { cancelledBy: 'PATIENT' | 'ADMIN' };
}

export interface BookingRefund {
  status: 'NONE' | 'PENDING' | 'COMPLETED' | 'FAILED';
  reason:
    | 'PATIENT_CANCELLATION'
    | 'NURSE_REJECTED'
    | 'NURSE_TIMEOUT'
    | 'ADMIN_CANCELLATION'
    | 'ADMIN_RESOLUTION';
  percent: number;
  amountMinor: number;
  requestedAt: Date;
  completedAt?: Date;
  providerRefundId?: string;
}

export interface TransitionOptions {
  session: ClientSession;
  reason?: string;
  metadata?: Record<string, unknown>;
  patch?: TransitionPatch;
  now?: Date;
  /** Marks a SYSTEM auto-completion (enables the end+grace time guard). */
  autoComplete?: boolean;
  /** PAYMENT_PENDING -> PAID only: the (verified) time the customer paid; the hold is judged at this time. */
  paymentTime?: Date;
}

interface GuardCtx {
  now: Date;
  paymentTime?: Date;
  actor: Actor;
  startEarlyMinutes: number;
  autoCompleteGraceMinutes: number;
  autoComplete: boolean;
}

function fail(from: BookingStatus, to: BookingStatus, why: string): never {
  throw new InvalidBookingStateError(`Cannot move booking from ${from} to ${to}: ${why}`);
}

/** Business guards on specific edges, evaluated inside the transition transaction. */
function guard(b: BookingDoc, to: BookingStatus, g: GuardCtx): void {
  const from = b.status as BookingStatus;
  if (from === 'PAYMENT_PENDING' && to === 'PAID') {
    if (!b.holdExpiresAt || b.holdExpiresAt <= (g.paymentTime ?? g.now))
      fail(from, to, 'the payment hold has expired');
  }
  if (to === 'REFUND_PENDING' && !b.paidAt) {
    fail(from, to, 'no payment was captured, nothing to refund');
  }
  if (
    to === 'REFUNDED' &&
    !(b.refund?.status === 'PENDING' || (from === 'FAILED' && b.refund?.status === 'FAILED'))
  ) {
    fail(from, to, 'there is no pending refund to complete');
  }
  if (from === 'CONFIRMED' && to === 'CARE_STARTED') {
    const earliest = b.startDateTime.getTime() - g.startEarlyMinutes * MIN;
    if (g.now.getTime() < earliest) fail(from, to, 'it is too early to start this booking');
    if (g.now >= b.endDateTime) fail(from, to, 'the booking window has already ended');
  }
  if (from === 'CARE_STARTED' && to === 'CARE_IN_PROGRESS' && g.now < b.startDateTime) {
    fail(from, to, 'the scheduled start time has not been reached');
  }
  if (from === 'CARE_IN_PROGRESS' && to === 'COMPLETED') {
    if (g.now < b.startDateTime) fail(from, to, 'care has not started yet');
    if (g.actor.role === 'SYSTEM') {
      const due = b.endDateTime.getTime() + g.autoCompleteGraceMinutes * MIN;
      if (!g.autoComplete || g.now.getTime() < due) fail(from, to, 'auto-completion is not due');
    }
  }
  if (from === 'NURSE_PENDING' && to === 'NURSE_ACCEPTED') {
    if (b.nurseResponseDeadline && b.nurseResponseDeadline <= g.now)
      fail(from, to, 'the nurse response window has expired');
  }
}

export const BookingStateMachine = {
  /** Pure lookup: may `actor` move `from` -> `to`? */
  canTransition(from: BookingStatus, to: BookingStatus, actor: Actor): boolean {
    return TRANSITIONS[from].some((t) => t.to === to && t.actors.includes(actor.role));
  },

  /**
   * THE only code path that writes `booking.status` (the Booking model rejects any other write).
   * Runs inside the caller's transaction: optimistic status+version filter, history row,
   * reservation side effects. Throws InvalidBookingStateError for illegal transitions.
   */
  async transition(
    bookingId: string,
    to: BookingStatus,
    actor: Actor,
    opts: TransitionOptions,
  ): Promise<BookingDoc> {
    const { session } = opts;
    const now = opts.now ?? new Date();
    const current = await Booking.findById(bookingId).session(session);
    if (!current) throw new NotFoundError('Booking not found', 'BOOKING_NOT_FOUND');
    const from = current.status as BookingStatus;

    const rule = TRANSITIONS[from].find((t) => t.to === to);
    if (!rule) fail(from, to, 'transition is not allowed');
    if (!rule.actors.includes(actor.role)) {
      fail(from, to, `${actor.role} is not permitted to perform this transition`);
    }
    const settings = await SettingsService.getAll();
    guard(current, to, {
      now,
      paymentTime: opts.paymentTime,
      actor,
      startEarlyMinutes: settings['booking.startEarlyMinutes'],
      autoCompleteGraceMinutes: settings['booking.autoCompleteGraceMinutes'],
      autoComplete: !!opts.autoComplete,
    });

    const $set: Record<string, unknown> = { status: to, statusUpdatedAt: now };
    const $unset: Record<string, 1> = {};
    for (const [k, v] of Object.entries(opts.patch ?? {})) {
      if (v === null) $unset[k] = 1;
      else if (v !== undefined) $set[k] = v;
    }
    if (opts.reason && !('statusReason' in $set)) $set.statusReason = opts.reason;

    const updated = (await Booking.findOneAndUpdate(
      { _id: bookingId, status: from, version: current.version },
      { $set, $inc: { version: 1 }, ...(Object.keys($unset).length ? { $unset } : {}) },
      { new: true, session, transitionAuthorized: true } as never,
    )) as unknown as BookingDoc | null;
    if (!updated) fail(from, to, 'the booking was modified concurrently');

    await BookingHistory.create(
      [
        {
          bookingId,
          previousState: from,
          newState: to,
          actorId: actor.userId,
          actorRole: actor.role,
          reason: opts.reason,
          metadata: opts.metadata,
        },
      ],
      { session },
    );

    // ---- side effects, same transaction ----
    if (RELEASING_STATUSES.includes(to)) await ReservationService.release(bookingId, session);
    if (to === 'PAID') await ReservationService.confirm(bookingId, session);
    if (to === 'COMPLETED') await NurseService.incrementCompleted(String(updated.nurseId), session);
    await getBookingHooks().onTransition?.(updated, { from, to }, session);

    return updated;
  },

  /** Convenience: run a single transition in its own transaction. */
  transitionAtomic(
    bookingId: string,
    to: BookingStatus,
    actor: Actor,
    opts: Omit<TransitionOptions, 'session'> = {},
  ): Promise<BookingDoc> {
    return withTransaction((session) =>
      this.transition(bookingId, to, actor, { ...opts, session }),
    );
  },
};
