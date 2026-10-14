import {
  checkRange,
  effectiveWindows,
  type AvailabilityRule,
} from '../../src/modules/availability';
import {
  isoWeekday,
  localDate,
  mulDivRound,
  parseHHmm,
  splitByLocalDay,
} from '../../src/common/utils/time';

const TZ = 'Asia/Dubai';
// 2026-12-01 is a Tuesday (ISO 2)
const ms = (iso: string) => Date.parse(iso);

const weekly = (dayOfWeek: number, from: string, to: string): AvailabilityRule => ({
  kind: 'WEEKLY',
  dayOfWeek,
  startMinute: parseHHmm(from),
  endMinute: parseHHmm(to),
});

describe('timezone helpers (Asia/Dubai, UTC+4, stored as UTC)', () => {
  it('converts UTC instants to the Dubai calendar day and weekday', () => {
    // 2026-12-01T21:00Z is already 01:00 on Dec 2 in Dubai
    expect(localDate(ms('2026-12-01T21:00:00Z'), TZ)).toBe('2026-12-02');
    expect(localDate(ms('2026-12-01T19:59:00Z'), TZ)).toBe('2026-12-01');
    expect(isoWeekday('2026-12-01', TZ)).toBe(2);
    expect(isoWeekday('2026-12-06', TZ)).toBe(7);
  });

  it('splits a range at LOCAL midnight, not UTC midnight', () => {
    // 22:00 Dec 1 -> 02:00 Dec 2 local == 18:00Z..22:00Z
    const segs = splitByLocalDay(ms('2026-12-01T18:00:00Z'), ms('2026-12-01T22:00:00Z'), TZ);
    expect(segs.map((s) => [s.date, s.startMin, s.endMin])).toEqual([
      ['2026-12-01', 22 * 60, 24 * 60],
      ['2026-12-02', 0, 2 * 60],
    ]);
  });

  it('parses 24:00 and rejects invalid times', () => {
    expect(parseHHmm('24:00')).toBe(1440);
    expect(() => parseHHmm('25:00')).toThrow();
    expect(() => parseHHmm('8:00')).toThrow();
  });

  it('mulDivRound rounds half up in integers', () => {
    expect(mulDivRound(4000, 90, 60)).toBe(6000);
    expect(mulDivRound(1, 1, 2)).toBe(1);
    expect(mulDivRound(10, 1, 3)).toBe(3);
    expect(mulDivRound(5, 1, 3)).toBe(2);
  });
});

describe('weekly availability', () => {
  const rules = [weekly(2, '08:00', '18:00')]; // Tuesdays only

  it('accepts a range fully inside working hours (local time)', () => {
    // 08:00-12:00 Dubai == 04:00Z-08:00Z
    expect(checkRange(rules, ms('2026-12-01T04:00:00Z'), ms('2026-12-01T08:00:00Z'), TZ)).toEqual({
      ok: true,
    });
  });

  it('rejects before opening, after closing and straddling the boundary', () => {
    // 07:00 local start
    expect(
      checkRange(rules, ms('2026-12-01T03:00:00Z'), ms('2026-12-01T05:00:00Z'), TZ),
    ).toMatchObject({
      ok: false,
      reason: 'OUTSIDE_WORKING_HOURS',
    });
    // 17:00-19:00 local
    expect(
      checkRange(rules, ms('2026-12-01T13:00:00Z'), ms('2026-12-01T15:00:00Z'), TZ),
    ).toMatchObject({
      ok: false,
    });
    // exactly to 18:00 is fine (end is exclusive)
    expect(checkRange(rules, ms('2026-12-01T10:00:00Z'), ms('2026-12-01T14:00:00Z'), TZ)).toEqual({
      ok: true,
    });
  });

  it('rejects days without a weekly rule', () => {
    expect(
      checkRange(rules, ms('2026-12-02T04:00:00Z'), ms('2026-12-02T08:00:00Z'), TZ),
    ).toMatchObject({
      ok: false,
      reason: 'OUTSIDE_WORKING_HOURS',
    });
  });

  it('merges adjacent windows (morning + afternoon shifts)', () => {
    const r = [weekly(2, '08:00', '12:00'), weekly(2, '12:00', '18:00')];
    expect(checkRange(r, ms('2026-12-01T06:00:00Z'), ms('2026-12-01T12:00:00Z'), TZ)).toEqual({
      ok: true,
    });
  });

  it('does not allow crossing a gap between windows', () => {
    const r = [weekly(2, '08:00', '12:00'), weekly(2, '14:00', '18:00')];
    expect(checkRange(r, ms('2026-12-01T06:00:00Z'), ms('2026-12-01T12:00:00Z'), TZ).ok).toBe(
      false,
    );
    expect(checkRange(r, ms('2026-12-01T10:00:00Z'), ms('2026-12-01T14:00:00Z'), TZ).ok).toBe(true);
  });

  it('multi-day ranges need every local day covered', () => {
    const all = [1, 2, 3, 4, 5, 6, 7].map((d) => weekly(d, '00:00', '24:00'));
    expect(checkRange(all, ms('2026-12-01T00:00:00Z'), ms('2026-12-04T00:00:00Z'), TZ).ok).toBe(
      true,
    );
    const noWed = all.filter((r) => r.dayOfWeek !== 3);
    expect(
      checkRange(noWed, ms('2026-12-01T00:00:00Z'), ms('2026-12-04T00:00:00Z'), TZ),
    ).toMatchObject({
      ok: false,
      date: '2026-12-02',
    });
  });
});

describe('date overrides and blocked periods', () => {
  const base = [weekly(2, '08:00', '18:00')];

  it('DATE override can make a day unavailable', () => {
    const r: AvailabilityRule[] = [
      ...base,
      { kind: 'DATE', date: '2026-12-01', isAvailable: false },
    ];
    expect(checkRange(r, ms('2026-12-01T04:00:00Z'), ms('2026-12-01T08:00:00Z'), TZ)).toMatchObject(
      {
        ok: false,
        reason: 'DAY_UNAVAILABLE',
      },
    );
  });

  it('DATE override REPLACES weekly hours (modified hours)', () => {
    const r: AvailabilityRule[] = [
      ...base,
      { kind: 'DATE', date: '2026-12-01', isAvailable: true, startMinute: 600, endMinute: 840 },
    ];
    // 10:00-14:00 local only
    expect(checkRange(r, ms('2026-12-01T06:00:00Z'), ms('2026-12-01T10:00:00Z'), TZ).ok).toBe(true);
    // 08:00-10:00 would be fine weekly but not with the override
    expect(checkRange(r, ms('2026-12-01T04:00:00Z'), ms('2026-12-01T06:00:00Z'), TZ).ok).toBe(
      false,
    );
  });

  it('DATE override can OPEN a day that has no weekly rule', () => {
    const r: AvailabilityRule[] = [
      { kind: 'DATE', date: '2026-12-02', isAvailable: true, startMinute: 480, endMinute: 720 },
    ];
    expect(checkRange(r, ms('2026-12-02T04:00:00Z'), ms('2026-12-02T08:00:00Z'), TZ).ok).toBe(true);
  });

  it('BLOCKED (vacation/holiday) ranges win over everything, inclusive of both ends', () => {
    const r: AvailabilityRule[] = [
      ...base,
      { kind: 'DATE', date: '2026-12-01', isAvailable: true, startMinute: 0, endMinute: 1440 },
      { kind: 'BLOCKED', dateFrom: '2026-12-01', dateTo: '2026-12-03' },
    ];
    expect(effectiveWindows(r, '2026-12-01', TZ).failure).toBe('BLOCKED');
    expect(effectiveWindows(r, '2026-12-03', TZ).failure).toBe('BLOCKED');
    expect(effectiveWindows(r, '2026-12-04', TZ).failure).toBeUndefined();
    expect(checkRange(r, ms('2026-12-01T04:00:00Z'), ms('2026-12-01T08:00:00Z'), TZ)).toMatchObject(
      {
        ok: false,
        reason: 'BLOCKED',
      },
    );
  });

  it('a blocked day in the middle of a multi-day range rejects the whole range', () => {
    const all = [1, 2, 3, 4, 5, 6, 7].map((d) => weekly(d, '00:00', '24:00'));
    const r: AvailabilityRule[] = [
      ...all,
      { kind: 'BLOCKED', dateFrom: '2026-12-02', dateTo: '2026-12-02' },
    ];
    expect(checkRange(r, ms('2026-12-01T00:00:00Z'), ms('2026-12-04T00:00:00Z'), TZ).ok).toBe(
      false,
    );
  });
});
