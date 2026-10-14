import {
  BLOCKING_STATUSES,
  BOOKING_STATUSES,
  BookingStateMachine,
  RELEASING_STATUSES,
  TRANSITIONS,
  slotStarts,
  type ActorRole,
  type BookingStatus,
} from '../../src/modules/bookings';

const ACTORS: ActorRole[] = ['PATIENT', 'NURSE', 'ADMIN', 'SYSTEM'];
const can = (from: BookingStatus, to: BookingStatus, role: ActorRole) =>
  BookingStateMachine.canTransition(from, to, { role });

describe('booking state table', () => {
  it('defines all 16 approved states', () => {
    expect([...BOOKING_STATUSES].sort()).toEqual(
      [
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
      ].sort(),
    );
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...BOOKING_STATUSES].sort());
  });

  it('allows the approved happy path, step by step, for the right actor', () => {
    const path: [BookingStatus, BookingStatus, ActorRole][] = [
      ['PENDING', 'PAYMENT_PENDING', 'SYSTEM'],
      ['PAYMENT_PENDING', 'PAID', 'SYSTEM'],
      ['PAID', 'NURSE_PENDING', 'SYSTEM'],
      ['NURSE_PENDING', 'NURSE_ACCEPTED', 'NURSE'],
      ['NURSE_ACCEPTED', 'CONFIRMED', 'SYSTEM'],
      ['CONFIRMED', 'CARE_STARTED', 'NURSE'],
      ['CARE_STARTED', 'CARE_IN_PROGRESS', 'NURSE'],
      ['CARE_IN_PROGRESS', 'COMPLETED', 'NURSE'],
    ];
    for (const [from, to, role] of path) expect(can(from, to, role)).toBe(true);
  });

  it('allows the rejection and timeout branches', () => {
    expect(can('NURSE_PENDING', 'NURSE_REJECTED', 'NURSE')).toBe(true);
    expect(can('NURSE_REJECTED', 'REFUND_PENDING', 'SYSTEM')).toBe(true);
    expect(can('REFUND_PENDING', 'REFUNDED', 'SYSTEM')).toBe(true);
    expect(can('NURSE_PENDING', 'EXPIRED', 'SYSTEM')).toBe(true);
    expect(can('EXPIRED', 'REFUND_PENDING', 'SYSTEM')).toBe(true);
    expect(can('PAYMENT_PENDING', 'EXPIRED', 'SYSTEM')).toBe(true);
  });

  it('exhaustively rejects every (from,to) pair that is not in the table, for every actor', () => {
    let checked = 0;
    for (const from of BOOKING_STATUSES) {
      for (const to of BOOKING_STATUSES) {
        const listed = TRANSITIONS[from].find((t) => t.to === to);
        for (const role of ACTORS) {
          const expected = !!listed && listed.actors.includes(role);
          expect(can(from, to, role)).toBe(expected);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(16 * 16 * 4);
  });

  it('important invalid transitions are rejected', () => {
    expect(can('PENDING', 'CONFIRMED', 'SYSTEM')).toBe(false);
    expect(can('PAYMENT_PENDING', 'NURSE_ACCEPTED', 'NURSE')).toBe(false);
    expect(can('PAID', 'CONFIRMED', 'SYSTEM')).toBe(false); // must go through NURSE_PENDING + accept
    expect(can('NURSE_PENDING', 'CONFIRMED', 'NURSE')).toBe(false);
    expect(can('CONFIRMED', 'COMPLETED', 'NURSE')).toBe(false); // must start first
    expect(can('CARE_STARTED', 'COMPLETED', 'NURSE')).toBe(false); // via CARE_IN_PROGRESS
    expect(can('COMPLETED', 'CANCELLED', 'ADMIN')).toBe(false);
    expect(can('EXPIRED', 'PAID', 'SYSTEM')).toBe(false); // expired holds can never be paid
    expect(can('CANCELLED', 'CONFIRMED', 'ADMIN')).toBe(false);
    expect(can('REFUNDED', 'PAID', 'SYSTEM')).toBe(false);
  });

  it('actor restrictions: only the system marks payment; only nurses accept/start; patients cannot confirm', () => {
    expect(can('PAYMENT_PENDING', 'PAID', 'PATIENT')).toBe(false);
    expect(can('PAYMENT_PENDING', 'PAID', 'NURSE')).toBe(false);
    expect(can('PAYMENT_PENDING', 'PAID', 'ADMIN')).toBe(false);
    expect(can('NURSE_PENDING', 'NURSE_ACCEPTED', 'PATIENT')).toBe(false);
    expect(can('CONFIRMED', 'CARE_STARTED', 'PATIENT')).toBe(false);
    expect(can('NURSE_PENDING', 'NURSE_ACCEPTED', 'SYSTEM')).toBe(false);
  });

  it('REFUNDED is terminal; FAILED can only be re-opened by an admin', () => {
    expect(TRANSITIONS.REFUNDED).toEqual([]);
    // re-opened by an admin, or reconciled to REFUNDED by a verified late provider success (SYSTEM)
    expect(TRANSITIONS.FAILED).toEqual([
      { to: 'REFUND_PENDING', actors: ['ADMIN'] },
      { to: 'REFUNDED', actors: ['SYSTEM'] },
    ]);
  });

  it('time is blocked while a booking is live and released when it ends', () => {
    for (const s of [
      'PAYMENT_PENDING',
      'PAID',
      'NURSE_PENDING',
      'CONFIRMED',
      'CARE_IN_PROGRESS',
    ] as const) {
      expect(BLOCKING_STATUSES).toContain(s);
    }
    for (const s of [
      'NURSE_REJECTED',
      'CANCELLED',
      'EXPIRED',
      'FAILED',
      'COMPLETED',
      'REFUNDED',
    ] as const) {
      expect(RELEASING_STATUSES).toContain(s);
      expect(BLOCKING_STATUSES).not.toContain(s);
    }
    // nothing is both blocking and releasing
    expect(BLOCKING_STATUSES.filter((s) => RELEASING_STATUSES.includes(s))).toEqual([]);
  });
});

describe('reservation slots (time-range protection)', () => {
  const ms = (iso: string) => Date.parse(iso);
  const set = (a: string, b: string) =>
    new Set(slotStarts(ms(a), ms(b), 15).map((d) => d.getTime()));
  const shares = (x: Set<number>, y: Set<number>) => [...x].some((v) => y.has(v));

  it('08:00-12:00 produces 16 quarter-hour slots', () => {
    expect(slotStarts(ms('2026-12-01T04:00:00Z'), ms('2026-12-01T08:00:00Z'), 15)).toHaveLength(16);
  });

  it('same-day non-overlapping bookings share no slot (both allowed)', () => {
    expect(
      shares(
        set('2026-12-01T04:00:00Z', '2026-12-01T08:00:00Z'),
        set('2026-12-01T10:00:00Z', '2026-12-01T14:00:00Z'),
      ),
    ).toBe(false);
  });

  it('back-to-back bookings (12:00 end / 12:00 start) share no slot', () => {
    expect(
      shares(
        set('2026-12-01T04:00:00Z', '2026-12-01T08:00:00Z'),
        set('2026-12-01T08:00:00Z', '2026-12-01T12:00:00Z'),
      ),
    ).toBe(false);
  });

  it('overlapping ranges share at least one slot (08-12 vs 11-15, and a 15 minute overlap)', () => {
    expect(
      shares(
        set('2026-12-01T04:00:00Z', '2026-12-01T08:00:00Z'),
        set('2026-12-01T07:00:00Z', '2026-12-01T11:00:00Z'),
      ),
    ).toBe(true);
    expect(
      shares(
        set('2026-12-01T04:00:00Z', '2026-12-01T08:00:00Z'),
        set('2026-12-01T07:45:00Z', '2026-12-01T09:00:00Z'),
      ),
    ).toBe(true);
  });

  it('rejects unaligned or empty ranges', () => {
    expect(() => slotStarts(ms('2026-12-01T04:05:00Z'), ms('2026-12-01T08:00:00Z'), 15)).toThrow();
    expect(() => slotStarts(ms('2026-12-01T04:00:00Z'), ms('2026-12-01T04:00:00Z'), 15)).toThrow();
  });
});
