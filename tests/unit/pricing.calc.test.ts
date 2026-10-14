import { calculatePrice, type CalcInput } from '../../src/modules/pricing';

const TZ = 'Asia/Dubai';
const ms = (iso: string) => Date.parse(iso);

// Tue 2026-12-01 08:00-12:00 Dubai
const TUE_08 = ms('2026-12-01T04:00:00Z');
const HOUR = 3_600_000;

const base = (o: Partial<CalcInput> = {}): CalcInput => ({
  unit: 'HOURLY',
  rateMinor: 4000,
  weekendBps: 0,
  holidayBps: 0,
  fees: [],
  weekendDays: [6, 7],
  holidayDates: new Set(),
  startMs: TUE_08,
  endMs: TUE_08 + 4 * HOUR,
  tz: TZ,
  commissionBps: 1500,
  ...o,
});

describe('hourly pricing', () => {
  it('4h x 40.00 AED = 160.00 AED, in integer fils', () => {
    const r = calculatePrice(base());
    expect(r.baseMinor).toBe(16000);
    expect(r.grossMinor).toBe(16000);
    expect(r.patientPayableMinor).toBe(16000);
    expect(r.durationMinutes).toBe(240);
    expect(r.lines).toEqual([
      expect.objectContaining({
        code: 'BASE',
        quantity: 240,
        unitAmountMinor: 4000,
        amountMinor: 16000,
      }),
    ]);
  });

  it('prorates partial hours per minute and rounds half-up to whole fils', () => {
    expect(calculatePrice(base({ endMs: TUE_08 + 90 * 60_000 })).baseMinor).toBe(6000);
    // 45 min at 3333 fils/h = 2499.75 -> 2500
    const r = calculatePrice(base({ rateMinor: 3333, endMs: TUE_08 + 45 * 60_000 }));
    expect(r.baseMinor).toBe(2500);
    expect(Number.isInteger(r.baseMinor)).toBe(true);
  });

  it('only ever returns safe integers', () => {
    for (const rate of [1, 3333, 4999, 12345]) {
      for (const minutes of [15, 45, 75, 100 * 15]) {
        const r = calculatePrice(base({ rateMinor: rate, endMs: TUE_08 + minutes * 60_000 }));
        for (const v of [
          r.baseMinor,
          r.grossMinor,
          r.patientPayableMinor,
          r.financial.commissionMinor,
        ]) {
          expect(Number.isSafeInteger(v)).toBe(true);
        }
      }
    }
  });

  it('rejects non-integer or negative rates', () => {
    expect(() => calculatePrice(base({ rateMinor: 40.5 }))).toThrow();
    expect(() => calculatePrice(base({ rateMinor: -1 }))).toThrow();
  });
});

describe('daily pricing', () => {
  it('250 AED/day x 3 days = 750 AED = 75000 fils', () => {
    const r = calculatePrice(base({ unit: 'DAILY', rateMinor: 25000, endMs: TUE_08 + 72 * HOUR }));
    expect(r.baseMinor).toBe(75000);
    expect(r.lines[0]).toMatchObject({ quantity: 3, unitAmountMinor: 25000, amountMinor: 75000 });
  });

  it('every started 24h block is billed as a day', () => {
    expect(
      calculatePrice(base({ unit: 'DAILY', rateMinor: 25000, endMs: TUE_08 + 25 * HOUR }))
        .baseMinor,
    ).toBe(50000);
    expect(
      calculatePrice(base({ unit: 'DAILY', rateMinor: 25000, endMs: TUE_08 + 4 * HOUR })).baseMinor,
    ).toBe(25000);
  });
});

describe('surcharges and fees', () => {
  it('applies the weekend surcharge only to weekend hours (split at local midnight)', () => {
    // Fri 2026-12-04 22:00 -> Sat 02:00 Dubai: 2h Friday + 2h Saturday (weekend = Sat/Sun)
    const start = ms('2026-12-04T18:00:00Z');
    const r = calculatePrice(base({ weekendBps: 2000, startMs: start, endMs: start + 4 * HOUR }));
    expect(r.baseMinor).toBe(16000);
    expect(r.surchargeMinor).toBe(1600); // 20% of 2h*4000
    expect(r.lines.find((l) => l.code === 'WEEKEND_SURCHARGE')?.amountMinor).toBe(1600);
    expect(r.grossMinor).toBe(17600);
  });

  it('holiday surcharge wins over weekend (no stacking)', () => {
    const r = calculatePrice(
      base({
        weekendBps: 2000,
        holidayBps: 5000,
        holidayDates: new Set(['2026-12-05']), // a Saturday
        startMs: ms('2026-12-05T04:00:00Z'),
        endMs: ms('2026-12-05T08:00:00Z'),
      }),
    );
    expect(r.surchargeMinor).toBe(8000); // 50% of 16000
    expect(r.lines.some((l) => l.code === 'WEEKEND_SURCHARGE')).toBe(false);
  });

  it('adds fixed fees as lines', () => {
    const r = calculatePrice(
      base({ fees: [{ code: 'TRAVEL', label: 'Travel', amountMinor: 1500 }] }),
    );
    expect(r.feesMinor).toBe(1500);
    expect(r.grossMinor).toBe(17500);
    expect(r.lines.at(-1)).toMatchObject({ code: 'FEE', amountMinor: 1500 });
  });
});

describe('commission and platform-funded discounts (financial snapshot)', () => {
  it('1500 AED at 15% => platform 225 AED, nurse 1275 AED', () => {
    const r = calculatePrice(base({ unit: 'DAILY', rateMinor: 150000, endMs: TUE_08 + 24 * HOUR }));
    expect(r.financial).toMatchObject({
      grossMinor: 150000,
      commissionMinor: 22500,
      nurseEarningMinor: 127500,
    });
  });

  it('commission + nurse earning always equal gross exactly (no lost fils)', () => {
    for (const bps of [0, 1, 999, 1500, 3333, 10000]) {
      for (const rate of [1, 7, 3333, 12345]) {
        const r = calculatePrice(
          base({ rateMinor: rate, commissionBps: bps, endMs: TUE_08 + 75 * 60_000 }),
        );
        expect(r.financial.commissionMinor + r.financial.nurseEarningMinor).toBe(r.grossMinor);
      }
    }
  });

  it('coupon discount reduces what the patient pays, NOT nurse earnings (platform absorbs it)', () => {
    // 1000 AED gross, 200 AED discount => patient pays 800; nurse still earns on 1000
    const r = calculatePrice(
      base({ unit: 'DAILY', rateMinor: 100000, endMs: TUE_08 + 24 * HOUR, discountMinor: 20000 }),
    );
    expect(r.grossMinor).toBe(100000);
    expect(r.discountMinor).toBe(20000);
    expect(r.patientPayableMinor).toBe(80000);
    expect(r.financial).toMatchObject({
      patientPaidMinor: 80000,
      platformFundedDiscountMinor: 20000,
      commissionMinor: 15000,
      nurseEarningMinor: 85000,
      paymentProcessingFeeMinor: 0,
      platformNetRevenueMinor: 15000 - 20000, // commission minus the discount the platform funds
    });
  });
});
