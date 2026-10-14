import type { ClientSession } from 'mongoose';
import type { BookingDoc } from './booking.models';

/** What a coupon snapshot stored on the booking looks like (immutable afterwards). */
export interface CouponSnapshot {
  couponId: string;
  code: string;
  type: 'FIXED' | 'PERCENTAGE';
  valueMinor?: number;
  valueBps?: number;
  maxDiscountMinor?: number;
  minBookingAmountMinor: number;
  /** server-calculated discount applied to the gross amount */
  discountMinor: number;
  /** coupon version at the time, so the exact terms can be reconstructed */
  couponVersion: number;
}

export interface DiscountEvaluation {
  discountMinor: number;
  snapshot: CouponSnapshot;
}

/**
 * Seams through which other modules plug into bookings WITHOUT the bookings module importing them
 * (no dependency cycles). Hooks run inside the booking's MongoDB transaction where noted.
 */
export interface BookingFinancialHooks {
  /** Called right after a booking enters REFUND_PENDING (refund details are on `booking.refund`). */
  onRefundPending?(booking: BookingDoc, session: ClientSession): Promise<void>;
  /**
   * Called after EVERY booking transition (same MongoDB transaction). Listeners are registered by
   * name through `registerTransitionListener`, so registration is idempotent and independent.
   */
  onTransition?(
    booking: BookingDoc,
    change: { from: string; to: string },
    session: ClientSession,
  ): Promise<void>;
  /** Coupons: the server calculates the discount from the GROSS amount; the client never sends one. */
  discount?: {
    evaluate(a: {
      code: string;
      patientId: string;
      serviceId: string;
      nurseId: string;
      grossMinor: number;
      now: Date;
    }): Promise<DiscountEvaluation>;
    /** Atomically consumes one use (global + per-user limits) inside the booking transaction. */
    redeem(
      a: { snapshot: CouponSnapshot; patientId: string; bookingId: string; now: Date },
      session: ClientSession,
    ): Promise<void>;
  };
  /** Explicit zero-payment path for fully discounted bookings (no provider payment is created). */
  zeroPayment?: {
    prepare(booking: { nurseId: string }): Promise<void>;
    settle(booking: BookingDoc, session: ClientSession): Promise<void>;
  };
}

type TransitionListener = NonNullable<BookingFinancialHooks['onTransition']>;
const listeners = new Map<string, TransitionListener>();

let hooks: BookingFinancialHooks = {
  onTransition: async (booking, change, session) => {
    for (const fn of listeners.values()) await fn(booking, change, session);
  },
};

/** Hooks are merged, so independent modules can each register their own. */
export const registerBookingHooks = (h: Omit<BookingFinancialHooks, 'onTransition'>): void => {
  hooks = { ...hooks, ...h };
};
/** Named, idempotent: registering the same name again replaces the previous listener. */
export const registerTransitionListener = (name: string, fn: TransitionListener): void => {
  listeners.set(name, fn);
};
export const getBookingHooks = (): BookingFinancialHooks => hooks;
