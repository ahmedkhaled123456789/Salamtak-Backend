import { mulDivRound } from '../../common/utils/time';

export interface PolicyTier {
  minHoursBeforeStart: number;
  refundPercent: number;
  /** legacy policy field; the retained amount is now split by the booking's financial snapshot */
  nurseCompensationPercent?: number;
}

export interface CancellationOutcome {
  hoursBeforeStart: number;
  tierMinHours: number | null;
  /** true when an admin overrode the policy percentage */
  overridden: boolean;
  refundPercent: number;
  refundMinor: number;
  nurseCompensationMinor: number;
  platformKeptMinor: number;
}

/**
 * Splits what the patient paid when part of it is refunded:
 *   refund + nurseShare + platformShare == paid  (exactly, integer fils)
 * The retained amount R = paid - refund is NOT a refund. It is allocated with the booking's own
 * financial snapshot (never today's commission): the nurse receives the same fraction of R that the
 * snapshot grants her of the whole payment (nurseEarning / paid); the platform gets the remainder.
 *
 * The snapshot is authoritative. With a platform-funded discount nurseEarning (based on GROSS) can
 * exceed what the patient paid; the platform absorbs the difference, so platformShare may be
 * NEGATIVE. The nurse share is never reduced to make the arithmetic convenient, and the same value is
 * used for the cancellation outcome, the wallet reversal and reconciliation.
 */
export function allocateRetained(args: {
  paidMinor: number;
  refundMinor: number;
  nurseEarningMinor: number;
  /**
   * Only used when nothing was paid (fully discounted booking): the nurse then keeps the same
   * fraction of her gross-based earning that the policy does not refund (100% refund => nothing).
   */
  refundPercent?: number;
}): { nurseShareMinor: number; platformShareMinor: number; retainedMinor: number } {
  const retained = args.paidMinor - args.refundMinor;
  if (retained < 0) throw new Error('refund exceeds the amount paid');
  const nurse =
    args.paidMinor === 0
      ? mulDivRound(args.nurseEarningMinor, 100 - (args.refundPercent ?? 100), 100)
      : mulDivRound(args.nurseEarningMinor, retained, args.paidMinor);
  return { nurseShareMinor: nurse, platformShareMinor: retained - nurse, retainedMinor: retained };
}

/**
 * Pure refund calculation from the booking's SNAPSHOTTED policy (never the live setting).
 *  - tier = first tier (largest minHoursBeforeStart first) with hoursBeforeStart >= minHours
 *  - refund = percent of what the patient paid
 *  - the non-refunded remainder is allocated by `allocateRetained` (booking financial snapshot)
 */
export function computeCancellationOutcome(args: {
  tiers: PolicyTier[];
  startMs: number;
  nowMs: number;
  paidMinor: number;
  nurseEarningMinor: number;
  overridePercent?: number;
  fullRefundReason?: boolean;
}): CancellationOutcome {
  const hours = (args.startMs - args.nowMs) / 3_600_000;
  const sorted = [...args.tiers].sort((a, b) => b.minHoursBeforeStart - a.minHoursBeforeStart);
  const tier = sorted.find((t) => hours >= t.minHoursBeforeStart) ?? sorted[sorted.length - 1];

  let percent: number;
  if (args.fullRefundReason) percent = 100;
  else if (args.overridePercent !== undefined) percent = args.overridePercent;
  else percent = tier?.refundPercent ?? 0;
  if (!Number.isInteger(percent) || percent < 0 || percent > 100)
    throw new Error('invalid refund percent');

  const refundMinor = mulDivRound(args.paidMinor, percent, 100);
  const alloc = allocateRetained({
    paidMinor: args.paidMinor,
    refundMinor,
    nurseEarningMinor: args.nurseEarningMinor,
    refundPercent: percent,
  });
  return {
    hoursBeforeStart: Math.round(hours * 100) / 100,
    tierMinHours:
      args.overridePercent !== undefined || args.fullRefundReason
        ? null
        : (tier?.minHoursBeforeStart ?? null),
    overridden: args.overridePercent !== undefined,
    refundPercent: percent,
    refundMinor,
    nurseCompensationMinor: alloc.nurseShareMinor,
    platformKeptMinor: alloc.platformShareMinor,
  };
}
