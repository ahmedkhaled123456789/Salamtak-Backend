import { mulDivRound } from '../../src/common/utils/time';
import { allocateRetained } from '../../src/modules/bookings/booking.refund';

/** Reference implementation: exact half-up rounding of a*b/c with BigInt. */
const ref = (a: number, b: number, c: number): bigint => {
  const A = BigInt(a);
  const B = BigInt(b);
  const C = BigInt(c);
  return (2n * A * B + C) / (2n * C);
};

// small deterministic PRNG so failures are reproducible
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('mulDivRound (exact BigInt arithmetic)', () => {
  it('rounds half up and keeps the documented examples', () => {
    expect(mulDivRound(4000, 90, 60)).toBe(6000);
    expect(mulDivRound(1, 1, 2)).toBe(1);
    expect(mulDivRound(10, 1, 3)).toBe(3);
    expect(mulDivRound(5, 1, 3)).toBe(2);
    expect(mulDivRound(0, 5, 7)).toBe(0);
  });

  it('is exact where double arithmetic loses precision (products above 2^53)', () => {
    const a = 9_007_199_254_740_991; // MAX_SAFE_INTEGER
    expect(mulDivRound(a, 1, 1)).toBe(a);
    expect(mulDivRound(a, 3, 3)).toBe(a);
    expect(mulDivRound(a, 9_999, 10_000)).toBe(Number(ref(a, 9_999, 10_000)));
    expect(mulDivRound(123_456_789_012, 8_500, 10_000)).toBe(
      Number(ref(123_456_789_012, 8_500, 10_000)),
    );
  });

  it('matches the BigInt reference for 50,000 random operands, including 10M+ AED amounts', () => {
    const r = rng(42);
    for (let i = 0; i < 50_000; i++) {
      const digits = 1 + Math.floor(r() * 13);
      const a = Math.floor(r() * 10 ** digits);
      const b = Math.floor(r() * 20_000);
      const c = 1 + Math.floor(r() * 20_000);
      expect(mulDivRound(a, b, c)).toBe(Number(ref(a, b, c)));
    }
  });

  it('rejects non-integers, negatives, unsafe integers, division by zero and unsafe results', () => {
    expect(() => mulDivRound(1.5, 1, 1)).toThrow(RangeError);
    expect(() => mulDivRound(-1, 1, 1)).toThrow(RangeError);
    expect(() => mulDivRound(1, 1, 0)).toThrow(RangeError);
    expect(() => mulDivRound(Number.NaN, 1, 1)).toThrow(RangeError);
    expect(() => mulDivRound(Number.MAX_SAFE_INTEGER + 2, 1, 1)).toThrow(RangeError);
    expect(() => mulDivRound(Number.MAX_SAFE_INTEGER, 2, 1)).toThrow(RangeError);
  });
});

describe('allocateRetained invariants (property tests)', () => {
  it('nurse + platform always equals the retained amount; nurse share never exceeds the earning', () => {
    const r = rng(7);
    for (let i = 0; i < 20_000; i++) {
      const paid = 1 + Math.floor(r() * 5_000_000);
      const refund = Math.floor(r() * (paid + 1));
      const gross = paid + Math.floor(r() * paid * 0.5); // discount => gross >= paid
      const earning = Math.floor(gross * (0.5 + r() * 0.5));
      const a = allocateRetained({
        paidMinor: paid,
        refundMinor: refund,
        nurseEarningMinor: earning,
      });
      expect(a.nurseShareMinor + a.platformShareMinor).toBe(paid - refund);
      expect(a.nurseShareMinor).toBeGreaterThanOrEqual(0);
      expect(a.nurseShareMinor).toBeLessThanOrEqual(earning);
    }
  });

  it('boundaries: nothing retained, everything retained, zero paid', () => {
    expect(
      allocateRetained({ paidMinor: 1000, refundMinor: 1000, nurseEarningMinor: 850 }),
    ).toMatchObject({ nurseShareMinor: 0, platformShareMinor: 0 });
    expect(
      allocateRetained({ paidMinor: 1000, refundMinor: 0, nurseEarningMinor: 850 }),
    ).toMatchObject({ nurseShareMinor: 850, platformShareMinor: 150 });
    expect(allocateRetained({ paidMinor: 0, refundMinor: 0, nurseEarningMinor: 0 })).toMatchObject({
      nurseShareMinor: 0,
      platformShareMinor: 0,
    });
  });

  it('platform-funded discount: gross 1000, discount 200, paid 800, nurse 850 -> platform absorbs the difference', () => {
    const none = allocateRetained({ paidMinor: 800, refundMinor: 0, nurseEarningMinor: 850 });
    expect(none).toMatchObject({ nurseShareMinor: 850, platformShareMinor: -50 });
    const half = allocateRetained({ paidMinor: 800, refundMinor: 400, nurseEarningMinor: 850 });
    expect(half).toMatchObject({ nurseShareMinor: 425, platformShareMinor: -25 });
    const all = allocateRetained({ paidMinor: 800, refundMinor: 800, nurseEarningMinor: 850 });
    expect(all).toMatchObject({ nurseShareMinor: 0, platformShareMinor: 0 });
  });
});
