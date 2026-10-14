export const BOOKING_STATUSES = [
  'PENDING',
  'PAYMENT_PENDING',
  'PAID',
  'NURSE_PENDING',
  'NURSE_ACCEPTED',
  'NURSE_REJECTED',
  'CONFIRMED',
  'CARE_STARTED',
  'CARE_IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'EXPIRED',
  'REFUND_PENDING',
  'REFUNDED',
  'DISPUTED',
  'FAILED',
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** States in which the nurse's time range is held (reservations exist). */
export const BLOCKING_STATUSES: readonly BookingStatus[] = [
  'PENDING',
  'PAYMENT_PENDING',
  'PAID',
  'NURSE_PENDING',
  'NURSE_ACCEPTED',
  'CONFIRMED',
  'CARE_STARTED',
  'CARE_IN_PROGRESS',
  'DISPUTED',
];

/** Entering one of these states frees the reservation slots (in the same transaction). */
export const RELEASING_STATUSES: readonly BookingStatus[] = [
  'NURSE_REJECTED',
  'CANCELLED',
  'EXPIRED',
  'FAILED',
  'COMPLETED',
  'REFUND_PENDING',
  'REFUNDED',
];

export type ActorRole = 'PATIENT' | 'NURSE' | 'ADMIN' | 'SYSTEM';
export interface Actor {
  role: ActorRole;
  userId?: string;
}
export const SYSTEM_ACTOR: Actor = { role: 'SYSTEM' };

export interface TransitionRule {
  to: BookingStatus;
  actors: readonly ActorRole[];
}

const P: ActorRole = 'PATIENT';
const N: ActorRole = 'NURSE';
const A: ActorRole = 'ADMIN';
const S: ActorRole = 'SYSTEM';

/**
 * The complete, declarative transition table. Anything not listed is an invalid transition.
 * Guards (time windows, ownership of money, ...) live in BookingStateMachine.
 */
export const TRANSITIONS: Record<BookingStatus, readonly TransitionRule[]> = {
  PENDING: [
    { to: 'PAYMENT_PENDING', actors: [S, P] },
    { to: 'CANCELLED', actors: [S, P, A] },
    { to: 'FAILED', actors: [S] },
  ],
  PAYMENT_PENDING: [
    { to: 'PAID', actors: [S] },
    { to: 'EXPIRED', actors: [S] },
    { to: 'CANCELLED', actors: [S, P, A] },
    { to: 'FAILED', actors: [S] },
  ],
  PAID: [
    { to: 'NURSE_PENDING', actors: [S] },
    { to: 'REFUND_PENDING', actors: [S, A] },
  ],
  NURSE_PENDING: [
    { to: 'NURSE_ACCEPTED', actors: [N] },
    { to: 'NURSE_REJECTED', actors: [N, A] },
    { to: 'EXPIRED', actors: [S] },
    { to: 'CANCELLED', actors: [P, A, S] },
  ],
  NURSE_ACCEPTED: [
    { to: 'CONFIRMED', actors: [S, N] },
    { to: 'CANCELLED', actors: [P, A, S] }, // nurses cannot cancel a patient's booking
  ],
  NURSE_REJECTED: [{ to: 'REFUND_PENDING', actors: [S] }],
  CONFIRMED: [
    { to: 'CARE_STARTED', actors: [N, A] },
    { to: 'CANCELLED', actors: [P, A, S] },
    { to: 'DISPUTED', actors: [S, A] }, // no-show: needs operational review, no automatic settlement
  ],
  CARE_STARTED: [
    { to: 'CARE_IN_PROGRESS', actors: [S, N] },
    { to: 'DISPUTED', actors: [P, A] },
  ],
  CARE_IN_PROGRESS: [
    { to: 'COMPLETED', actors: [N, S, A] },
    { to: 'DISPUTED', actors: [P, A] },
  ],
  COMPLETED: [{ to: 'DISPUTED', actors: [P, A] }],
  CANCELLED: [{ to: 'REFUND_PENDING', actors: [S, A] }],
  EXPIRED: [{ to: 'REFUND_PENDING', actors: [S] }],
  DISPUTED: [
    { to: 'REFUND_PENDING', actors: [S, A] },
    { to: 'COMPLETED', actors: [A] },
  ],
  REFUND_PENDING: [
    { to: 'REFUNDED', actors: [S] },
    { to: 'FAILED', actors: [S] },
  ],
  REFUNDED: [],
  // A refund that exhausted its automatic retries can be re-opened by an admin only.
  // Re-opened by an admin, or reconciled by a later verified provider success (never by a client).
  FAILED: [
    { to: 'REFUND_PENDING', actors: [A] },
    { to: 'REFUNDED', actors: [S] },
  ],
};

export const isTerminal = (s: BookingStatus): boolean => TRANSITIONS[s].length === 0;
