import {
  allocateRetained,
  computeCancellationOutcome,
  type PolicyTier,
} from '../../src/modules/bookings/booking.refund';

const POLICY: PolicyTier[] = [
  { minHoursBeforeStart: 48, refundPercent: 100, nurseCompensationPercent: 0 },
  { minHoursBeforeStart: 24, refundPercent: 50, nurseCompensationPercent: 50 },
  { minHoursBeforeStart: 0, refundPercent: 0, nurseCompensationPercent: 100 },
];
const H = 3_600_000;
const NOW = Date.parse('2026-12-01T00:00:00Z');
const calc = (
  hoursBefore: number,
  paid = 16000,
  extra: Partial<Parameters<typeof computeCancellationOutcome>[0]> = {},
) =>
  computeCancellationOutcome({
    tiers: POLICY,
    startMs: NOW + hoursBefore * H,
    nowMs: NOW,
    paidMinor: paid,
    nurseEarningMinor: Math.floor(paid * 0.85), // 15% commission snapshot
    ...extra,
  });

describe('cancellation outcome from the snapshotted policy', () => {
  it('48h+ before start: 100% refund, nothing kept', () => {
    expect(calc(100)).toMatchObject({
      refundPercent: 100,
      refundMinor: 16000,
      nurseCompensationMinor: 0,
      platformKeptMinor: 0,
      tierMinHours: 48,
    });
  });

  it('24-48h: 50% refund; the retained half is split by the booking snapshot (85/15)', () => {
    expect(calc(30)).toMatchObject({
      refundPercent: 50,
      refundMinor: 8000,
      nurseCompensationMinor: 6800, // 85% of the retained 8000 (booking snapshot)
      platformKeptMinor: 1200,
      tierMinHours: 24,
    });
  });

  it('under 24h: 0% refund, the full payment is allocated nurse/platform as if completed', () => {
    expect(calc(10)).toMatchObject({
      refundPercent: 0,
      refundMinor: 0,
      nurseCompensationMinor: 13600, // the normal 85/15 split of what was paid
      platformKeptMinor: 2400,
      tierMinHours: 0,
    });
  });

  it('tier boundaries are inclusive of the lower bound', () => {
    expect(calc(48).refundPercent).toBe(100);
    expect(calc(47.99).refundPercent).toBe(50);
    expect(calc(24).refundPercent).toBe(50);
    expect(calc(23.99).refundPercent).toBe(0);
    expect(calc(0).refundPercent).toBe(0);
  });

  it('after the start time the last tier applies', () => {
    expect(calc(-5).refundPercent).toBe(0);
  });

  it('refund + nurse + platform always equals what was paid (no lost or invented fils)', () => {
    for (const paid of [1, 3, 99, 16001, 123457]) {
      for (const h of [100, 30, 10]) {
        const o = calc(h, paid);
        expect(o.refundMinor + o.nurseCompensationMinor + o.platformKeptMinor).toBe(paid);
        expect(Number.isSafeInteger(o.refundMinor)).toBe(true);
      }
    }
  });

  it('tier order in the stored policy does not matter', () => {
    const shuffled = [POLICY[2]!, POLICY[0]!, POLICY[1]!];
    expect(
      computeCancellationOutcome({
        tiers: shuffled,
        startMs: NOW + 30 * H,
        nowMs: NOW,
        paidMinor: 1000,
        nurseEarningMinor: 850,
      }).refundPercent,
    ).toBe(50);
  });

  it('is driven by the tiers given, not by any live setting (custom policy)', () => {
    const custom: PolicyTier[] = [
      { minHoursBeforeStart: 0, refundPercent: 10, nurseCompensationPercent: 0 },
    ];
    expect(
      computeCancellationOutcome({
        tiers: custom,
        startMs: NOW + 500 * H,
        nowMs: NOW,
        paidMinor: 1000,
        nurseEarningMinor: 850,
      }).refundMinor,
    ).toBe(100);
  });

  it('admin override replaces the percentage; the retained part is still split by the snapshot', () => {
    expect(calc(10, 16000, { overridePercent: 25 })).toMatchObject({
      overridden: true,
      refundPercent: 25,
      refundMinor: 4000,
      nurseCompensationMinor: 10200, // 85% of the retained 12000
      platformKeptMinor: 1800,
      tierMinHours: null,
    });
  });

  it('nurse-caused refunds are always 100%', () => {
    expect(calc(1, 16000, { fullRefundReason: true })).toMatchObject({
      refundPercent: 100,
      refundMinor: 16000,
    });
  });

  it('rejects invalid override percentages', () => {
    expect(() => calc(10, 1000, { overridePercent: 101 })).toThrow();
    expect(() => calc(10, 1000, { overridePercent: -1 })).toThrow();
    expect(() => calc(10, 1000, { overridePercent: 12.5 })).toThrow();
  });
});

describe('allocateRetained (financial snapshot split)', () => {
  it('patientRefund + nurseShare + platformShare == patientPaid, exactly, for many amounts', () => {
    for (const paid of [1, 7, 999, 100000, 123457]) {
      for (const pct of [0, 1, 33, 50, 99, 100]) {
        const refund = Math.floor((paid * pct) / 100);
        const a = allocateRetained({
          paidMinor: paid,
          refundMinor: refund,
          nurseEarningMinor: Math.floor(paid * 0.85),
        });
        expect(refund + a.nurseShareMinor + a.platformShareMinor).toBe(paid);
        expect(a.nurseShareMinor).toBeGreaterThanOrEqual(0);
        expect(a.platformShareMinor).toBeGreaterThanOrEqual(0);
      }
    }
  });
  it('the example: AED 1000 paid, AED 500 refunded -> the other AED 500 is allocated 85/15, not refunded', () => {
    expect(
      allocateRetained({ paidMinor: 100000, refundMinor: 50000, nurseEarningMinor: 85000 }),
    ).toEqual({
      retainedMinor: 50000,
      nurseShareMinor: 42500,
      platformShareMinor: 7500,
    });
  });
  it('uses the booking snapshot, so a different current commission is irrelevant', () => {
    // snapshot says the nurse earns 70% of this booking (30% commission at the time)
    expect(
      allocateRetained({ paidMinor: 10000, refundMinor: 0, nurseEarningMinor: 7000 })
        .nurseShareMinor,
    ).toBe(7000);
  });
  it('with a platform-funded discount the nurse keeps the snapshot earning and the platform absorbs the difference', () => {
    // paid 800 but nurse earning is 850 (platform absorbs a 200 discount): platform share is negative
    expect(allocateRetained({ paidMinor: 800, refundMinor: 0, nurseEarningMinor: 850 })).toEqual({
      retainedMinor: 800,
      nurseShareMinor: 850,
      platformShareMinor: -50,
    });
  });
  it('rejects a refund larger than the payment', () => {
    expect(() =>
      allocateRetained({ paidMinor: 100, refundMinor: 101, nurseEarningMinor: 85 }),
    ).toThrow();
  });
});
