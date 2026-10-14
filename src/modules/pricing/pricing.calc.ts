import { AppError } from '../../common/errors';
import { isoWeekday, localDate, mulDivRound, splitByLocalDay } from '../../common/utils/time';

/**
 * Pure, integer-only price calculation. No I/O, no floating point: every amount is a safe integer
 * in minor units (fils) and percentages are basis points. Rounding is half-up per line.
 */

export type BillingUnit = 'HOURLY' | 'DAILY';

export interface PriceLine {
  code: 'BASE' | 'WEEKEND_SURCHARGE' | 'HOLIDAY_SURCHARGE' | 'FEE' | 'DISCOUNT';
  label: string;
  /** minutes for HOURLY base, days for DAILY base, 1 for the rest */
  quantity: number;
  unitAmountMinor: number;
  amountMinor: number;
}

export interface CalcInput {
  unit: BillingUnit;
  /** per hour or per day, in fils */
  rateMinor: number;
  weekendBps: number;
  holidayBps: number;
  fees: { code: string; label: string; amountMinor: number }[];
  weekendDays: number[];
  holidayDates: ReadonlySet<string>;
  startMs: number;
  endMs: number;
  tz: string;
  commissionBps: number;
  /** When set the commission is this fixed amount (capped at gross) instead of a percentage. */
  commissionFixedMinor?: number;
  discountMinor?: number;
}

export interface CalcResult {
  currency: 'AED';
  unit: BillingUnit;
  durationMinutes: number;
  lines: PriceLine[];
  baseMinor: number;
  surchargeMinor: number;
  feesMinor: number;
  grossMinor: number;
  discountMinor: number;
  patientPayableMinor: number;
  financial: {
    grossMinor: number;
    discountMinor: number;
    patientPaidMinor: number; // what the patient owes (paid in Phase 3)
    platformFundedDiscountMinor: number;
    commissionBps: number;
    commissionMinor: number;
    nurseEarningMinor: number;
    paymentProcessingFeeMinor: number;
    platformNetRevenueMinor: number;
  };
}

const MIN = 60_000;
const DAY_MIN = 1440;

export function assertMoney(v: number, what: string): void {
  if (!Number.isSafeInteger(v) || v < 0) {
    throw new AppError(500, 'INVALID_MONEY', `${what} must be a non-negative integer`);
  }
}

export function calculatePrice(i: CalcInput): CalcResult {
  assertMoney(i.rateMinor, 'rate');
  const durationMinutes = Math.round((i.endMs - i.startMs) / MIN);

  const dayKind = (date: string): 'HOLIDAY' | 'WEEKEND' | null =>
    i.holidayDates.has(date)
      ? 'HOLIDAY'
      : i.weekendDays.includes(isoWeekday(date, i.tz))
        ? 'WEEKEND'
        : null;

  let baseMinor = 0;
  let baseQty = 0;
  let weekendMinor = 0;
  let holidayMinor = 0;

  if (i.unit === 'HOURLY') {
    for (const seg of splitByLocalDay(i.startMs, i.endMs, i.tz)) {
      const minutes = seg.endMin - seg.startMin;
      const segBase = mulDivRound(i.rateMinor, minutes, 60);
      baseMinor += segBase;
      baseQty += minutes;
      const kind = dayKind(seg.date);
      if (kind === 'HOLIDAY') holidayMinor += mulDivRound(segBase, i.holidayBps, 10_000);
      else if (kind === 'WEEKEND') weekendMinor += mulDivRound(segBase, i.weekendBps, 10_000);
    }
  } else {
    // DAILY: every started 24h block is one billable day; its first instant decides the day type.
    const days = Math.max(1, Math.ceil(durationMinutes / DAY_MIN));
    for (let k = 0; k < days; k++) {
      baseMinor += i.rateMinor;
      baseQty += 1;
      const kind = dayKind(localDate(i.startMs + k * DAY_MIN * MIN, i.tz));
      if (kind === 'HOLIDAY') holidayMinor += mulDivRound(i.rateMinor, i.holidayBps, 10_000);
      else if (kind === 'WEEKEND') weekendMinor += mulDivRound(i.rateMinor, i.weekendBps, 10_000);
    }
  }

  const lines: PriceLine[] = [
    {
      code: 'BASE',
      label: i.unit === 'HOURLY' ? 'Care (hourly rate)' : 'Care (daily rate)',
      quantity: baseQty,
      unitAmountMinor: i.rateMinor,
      amountMinor: baseMinor,
    },
  ];
  if (weekendMinor > 0)
    lines.push({
      code: 'WEEKEND_SURCHARGE',
      label: 'Weekend surcharge',
      quantity: 1,
      unitAmountMinor: weekendMinor,
      amountMinor: weekendMinor,
    });
  if (holidayMinor > 0)
    lines.push({
      code: 'HOLIDAY_SURCHARGE',
      label: 'Public holiday surcharge',
      quantity: 1,
      unitAmountMinor: holidayMinor,
      amountMinor: holidayMinor,
    });
  let feesMinor = 0;
  for (const f of i.fees) {
    assertMoney(f.amountMinor, `fee ${f.code}`);
    feesMinor += f.amountMinor;
    lines.push({
      code: 'FEE',
      label: f.label,
      quantity: 1,
      unitAmountMinor: f.amountMinor,
      amountMinor: f.amountMinor,
    });
  }

  const surchargeMinor = weekendMinor + holidayMinor;
  const grossMinor = baseMinor + surchargeMinor + feesMinor;
  const discountMinor = Math.min(i.discountMinor ?? 0, grossMinor);
  if (discountMinor > 0)
    lines.push({
      code: 'DISCOUNT',
      label: 'Discount',
      quantity: 1,
      unitAmountMinor: discountMinor,
      amountMinor: discountMinor,
    });
  const patientPayableMinor = grossMinor - discountMinor;

  // Commission/earnings come from GROSS (platform absorbs discounts). commission + nurse == gross exactly.
  const commissionMinor =
    i.commissionFixedMinor !== undefined
      ? Math.min(i.commissionFixedMinor, grossMinor)
      : mulDivRound(grossMinor, i.commissionBps, 10_000);
  const nurseEarningMinor = grossMinor - commissionMinor;
  const processingFee = 0; // Phase 3
  for (const [k, v] of Object.entries({
    grossMinor,
    patientPayableMinor,
    commissionMinor,
    nurseEarningMinor,
  })) {
    assertMoney(v, k);
  }

  return {
    currency: 'AED',
    unit: i.unit,
    durationMinutes,
    lines,
    baseMinor,
    surchargeMinor,
    feesMinor,
    grossMinor,
    discountMinor,
    patientPayableMinor,
    financial: {
      grossMinor,
      discountMinor,
      patientPaidMinor: patientPayableMinor,
      platformFundedDiscountMinor: discountMinor,
      commissionBps: i.commissionFixedMinor !== undefined ? 0 : i.commissionBps,
      commissionMinor,
      nurseEarningMinor,
      paymentProcessingFeeMinor: processingFee,
      platformNetRevenueMinor: commissionMinor - discountMinor - processingFee,
    },
  };
}
