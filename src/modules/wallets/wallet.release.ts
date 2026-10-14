import type { BookingDoc } from '../bookings';

/**
 * Pure release-eligibility rule, evaluated against the CURRENT booking inside the release
 * transaction. Earnings are releasable only when:
 *  - the booking was paid and has not been released yet, and
 *  - it is COMPLETED and the release delay has elapsed since completion, or
 *  - it is CANCELLED (0% refund, nothing pending) / REFUNDED (partial refund finished) and the delay
 *    has elapsed since the cancellation / refund completion (only the nurse's retained share is left).
 * Everything else is FROZEN: DISPUTED, REFUND_PENDING, FAILED, EXPIRED, NURSE_REJECTED, live states.
 */
export function isReleasable(
  b: Pick<
    BookingDoc,
    'status' | 'paidAt' | 'earningReleasedAt' | 'completedAt' | 'cancelledAt' | 'refund'
  >,
  cutoff: Date,
): boolean {
  if (!b.paidAt || b.earningReleasedAt) return false;
  if (b.status === 'COMPLETED') return !!b.completedAt && b.completedAt <= cutoff;
  if (b.status === 'CANCELLED' || b.status === 'REFUNDED') {
    if (b.refund && b.refund.status !== 'NONE' && b.refund.status !== 'COMPLETED') return false;
    const ref = b.refund?.completedAt ?? b.cancelledAt;
    return !!ref && ref <= cutoff;
  }
  return false;
}
