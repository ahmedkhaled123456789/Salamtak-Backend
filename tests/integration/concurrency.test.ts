import { resetRateLimiters } from '../../src/common/middleware/rateLimit';
import type { Express } from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { withTransaction } from '../../src/config/database';
import { getRedis } from '../../src/config/redis';
import { BookingConflictError } from '../../src/common/errors';
import {
  BLOCKING_STATUSES,
  Booking,
  BookingHistory,
  BookingReservation,
  BookingService,
  ReservationService,
  slotStarts,
} from '../../src/modules/bookings';
import {
  API,
  createAdmin,
  register,
  resetState,
  startApp,
  stopApp,
  type Session,
} from '../helpers/harness';
import {
  at,
  bookReq,
  day,
  mkNurse,
  mkService,
  quoteReq,
  type BookArgs,
  type Nurse,
} from '../helpers/world';

let app: Express;
let admin: Session;
let serviceId: string;
let nurse: Nurse;
let D: string; // a test date

beforeAll(async () => {
  app = await startApp();
});
afterAll(stopApp);

beforeEach(async () => {
  await resetState();
  admin = await createAdmin(app);
  serviceId = await mkService(app, admin);
  nurse = await mkNurse(app, admin, { serviceIds: [serviceId] });
  D = day(5);
});
afterEach(() => jest.restoreAllMocks());

const slots = (start: Date, end: Date) => (end.getTime() - start.getTime()) / (15 * 60_000);

async function patients(count: number): Promise<Session[]> {
  resetRateLimiters(); // registration is rate limited per IP
  return Promise.all(Array.from({ length: count }, () => register(app, 'PATIENT')));
}

/** All quotes first (sequential outcome irrelevant), then ALL booking POSTs fired at the same instant. */
async function raceBook(who: { patient: Session; args: BookArgs }[]) {
  const quotes = await Promise.all(who.map((w) => quoteReq(app, w.patient, w.args)));
  quotes.forEach((q) => expect(q.status).toBe(200));
  return Promise.all(
    who.map((w, i) => bookReq(app, w.patient, w.args, quotes[i]!.body.data.quoteToken)),
  );
}

const args = (n: Nurse, s: string, e: string, d = D): BookArgs => ({
  serviceId,
  nurseId: n.profileId,
  start: at(d, s),
  end: at(d, e),
});

/** Database-level consistency: no overlapping live bookings, reservations == slots of live bookings, no orphans. */
async function assertConsistent(nurseId: string) {
  const live = await Booking.find({ nurseId, status: { $in: BLOCKING_STATUSES } }).lean();
  const sorted = [...live].sort((a, b) => a.startDateTime.getTime() - b.startDateTime.getTime());
  for (let i = 1; i < sorted.length; i++) {
    expect(sorted[i]!.startDateTime.getTime()).toBeGreaterThanOrEqual(
      sorted[i - 1]!.endDateTime.getTime(),
    );
  }
  const expected = new Set<string>();
  for (const b of live) {
    for (const s of slotStarts(b.startDateTime.getTime(), b.endDateTime.getTime(), b.slotMinutes))
      expected.add(`${b._id}:${s.getTime()}`);
  }
  const actual = (await BookingReservation.find({ nurseId }).lean()).map(
    (r) => `${r.bookingId}:${r.slotStart.getTime()}`,
  );
  expect(new Set(actual).size).toBe(actual.length); // no duplicate slot
  expect(new Set(actual)).toEqual(expected); // exactly the live bookings' slots, no orphans
}

describe('schema-level guarantees', () => {
  it('reservations are unique per nurse+SLOT, never per nurse+day', async () => {
    const idx = await mongoose.connection.collection('bookingReservations').indexes();
    expect(idx).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: { nurseId: 1, slotStart: 1 }, unique: true }),
      ]),
    );
    expect(idx.some((i) => 'day' in i.key)).toBe(false);
  });
});

describe('overlapping requests for the SAME nurse', () => {
  it('10 simultaneous identical-range requests: exactly one 201, nine clean 409 BOOKING_CONFLICT', async () => {
    const ps = await patients(10);
    const res = await raceBook(
      ps.map((patient) => ({ patient, args: args(nurse, '08:00', '12:00') })),
    );

    const ok = res.filter((r) => r.status === 201);
    const conflicts = res.filter((r) => r.status === 409);
    expect(ok).toHaveLength(1);
    expect(conflicts).toHaveLength(9);
    for (const c of conflicts)
      expect(c.body).toMatchObject({ success: false, errorCode: 'BOOKING_CONFLICT' });
    expect(res.filter((r) => ![201, 409].includes(r.status))).toEqual([]); // no 500s

    // exactly one booking row, one set of reservations, one history trail
    expect(await Booking.countDocuments()).toBe(1);
    expect(await BookingReservation.countDocuments()).toBe(slots(at(D, '08:00'), at(D, '12:00')));
    expect(await BookingHistory.countDocuments({ bookingId: ok[0]!.body.data.id })).toBe(2); // PENDING, PAYMENT_PENDING
    expect(await BookingHistory.countDocuments()).toBe(2);
    await assertConsistent(nurse.profileId);
  });

  it('partially overlapping ranges (08-12 vs 11-15) conflict: one wins', async () => {
    const [a, b] = await patients(2);
    const res = await raceBook([
      { patient: a!, args: args(nurse, '08:00', '12:00') },
      { patient: b!, args: args(nurse, '11:00', '15:00') },
    ]);
    expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(res.find((r) => r.status === 409)!.body.errorCode).toBe('BOOKING_CONFLICT');
    await assertConsistent(nurse.profileId);
  });

  it('a single 15-minute overlap is enough to conflict', async () => {
    const [a, b] = await patients(2);
    const res = await raceBook([
      { patient: a!, args: args(nurse, '08:00', '10:00') },
      { patient: b!, args: args(nurse, '09:45', '11:00') },
    ]);
    expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it('sequential conflict is also a clean 409 (second request after the first committed)', async () => {
    const [a, b] = await patients(2);
    const q1 = await quoteReq(app, a!, args(nurse, '08:00', '12:00'));
    const q2 = await quoteReq(app, b!, args(nurse, '09:00', '11:00'));
    expect(
      (await bookReq(app, a!, args(nurse, '08:00', '12:00'), q1.body.data.quoteToken)).status,
    ).toBe(201);
    const second = await bookReq(app, b!, args(nurse, '09:00', '11:00'), q2.body.data.quoteToken);
    expect(second.status).toBe(409);
    expect(second.body.errorCode).toBe('BOOKING_CONFLICT');
    expect(await Booking.countDocuments()).toBe(1);
  });

  it('a quote for an already-taken range is refused up front with NURSE_NOT_AVAILABLE', async () => {
    const [a, b] = await patients(2);
    const q1 = await quoteReq(app, a!, args(nurse, '08:00', '12:00'));
    await bookReq(app, a!, args(nurse, '08:00', '12:00'), q1.body.data.quoteToken);
    const q2 = await quoteReq(app, b!, args(nurse, '10:00', '13:00'));
    expect(q2.status).toBe(409);
    expect(q2.body.errorCode).toBe('NURSE_NOT_AVAILABLE');
  });
});

describe('non-overlapping requests', () => {
  it('same nurse, same day, 08-12 and 14-18 simultaneously: BOTH succeed', async () => {
    const [a, b] = await patients(2);
    const res = await raceBook([
      { patient: a!, args: args(nurse, '08:00', '12:00') },
      { patient: b!, args: args(nurse, '14:00', '18:00') },
    ]);
    expect(res.map((r) => r.status)).toEqual([201, 201]);
    expect(await Booking.countDocuments()).toBe(2);
    expect(await BookingReservation.countDocuments()).toBe(32);
    await assertConsistent(nurse.profileId);
  });

  it('back-to-back (08-12 and 12-16) simultaneously: both succeed', async () => {
    const [a, b] = await patients(2);
    const res = await raceBook([
      { patient: a!, args: args(nurse, '08:00', '12:00') },
      { patient: b!, args: args(nurse, '12:00', '16:00') },
    ]);
    expect(res.map((r) => r.status)).toEqual([201, 201]);
    await assertConsistent(nurse.profileId);
  });

  it('three disjoint ranges on the same day all succeed concurrently', async () => {
    const ps = await patients(3);
    const res = await raceBook([
      { patient: ps[0]!, args: args(nurse, '06:00', '08:00') },
      { patient: ps[1]!, args: args(nurse, '09:00', '11:00') },
      { patient: ps[2]!, args: args(nurse, '13:00', '15:00') },
    ]);
    expect(res.map((r) => r.status)).toEqual([201, 201, 201]);
    await assertConsistent(nurse.profileId);
  });

  it('DIFFERENT nurses with the same overlapping range: both succeed', async () => {
    const nurse2 = await mkNurse(app, admin, { serviceIds: [serviceId] });
    const [a, b] = await patients(2);
    const res = await raceBook([
      { patient: a!, args: args(nurse, '08:00', '12:00') },
      { patient: b!, args: args(nurse2, '08:00', '12:00') },
    ]);
    expect(res.map((r) => r.status)).toEqual([201, 201]);
    await assertConsistent(nurse.profileId);
    await assertConsistent(nurse2.profileId);
  });

  it('the same patient can hold two non-overlapping bookings with the same nurse', async () => {
    const [a] = await patients(1);
    const res = await raceBook([
      { patient: a!, args: args(nurse, '08:00', '10:00') },
      { patient: a!, args: args(nurse, '14:00', '16:00') },
    ]);
    expect(res.map((r) => r.status)).toEqual([201, 201]);
  });
});

describe('mixed storms: the outcome must always equal SOME serial order', () => {
  it('overlapping chains (08-12, 11-15, 14-18, 08-12) x 5 rounds never double-book', async () => {
    for (let round = 0; round < 5; round++) {
      await BookingReservation.deleteMany({});
      await Booking.collection.deleteMany({});
      const d = day(10 + round);
      const ps = await patients(8);
      const plan: [string, string][] = [
        ['08:00', '12:00'],
        ['11:00', '15:00'],
        ['14:00', '18:00'],
        ['08:00', '12:00'],
        ['11:00', '15:00'],
        ['14:00', '18:00'],
        ['10:00', '11:00'],
        ['16:00', '17:00'],
      ];
      const res = await raceBook(
        ps.map((patient, i) => ({ patient, args: args(nurse, plan[i]![0], plan[i]![1], d) })),
      );
      expect(res.every((r) => r.status === 201 || r.status === 409)).toBe(true);
      expect(
        res.filter((r) => r.status === 409).every((r) => r.body.errorCode === 'BOOKING_CONFLICT'),
      ).toBe(true);
      expect(res.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
      await assertConsistent(nurse.profileId);
    }
  });
});

describe('Redis is NOT required for correctness', () => {
  it('Redis down (commands reject): still exactly one winner', async () => {
    const ps = await patients(8);
    const redis = getRedis();
    jest.spyOn(redis, 'set').mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:6379'));
    jest.spyOn(redis, 'eval').mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:6379'));
    const res = await raceBook(
      ps.map((patient) => ({ patient, args: args(nurse, '08:00', '12:00') })),
    );
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      res.filter((r) => r.status === 409).every((r) => r.body.errorCode === 'BOOKING_CONFLICT'),
    ).toBe(true);
    expect(res.filter((r) => r.status >= 500)).toEqual([]);
    await assertConsistent(nurse.profileId);
  });

  it('Redis hangs (never answers): requests still complete and stay correct', async () => {
    const ps = await patients(4); // register first: it also uses Redis (OTP)
    const redis = getRedis();
    jest.spyOn(redis, 'set').mockImplementation((() => new Promise(() => undefined)) as never);
    const res = await raceBook(
      ps.map((patient) => ({ patient, args: args(nurse, '08:00', '12:00') })),
    );
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409)).toHaveLength(3);
    await assertConsistent(nurse.profileId);
  });

  it('Redis lock permanently held by someone else: proceeds after a short wait, still correct', async () => {
    jest.spyOn(getRedis(), 'set').mockResolvedValue(null as never);
    const [a, b] = await patients(2);
    const res = await raceBook([
      { patient: a!, args: args(nurse, '08:00', '12:00') },
      { patient: b!, args: args(nurse, '14:00', '18:00') },
    ]);
    expect(res.map((r) => r.status)).toEqual([201, 201]);
    await assertConsistent(nurse.profileId);
  });

  it('Redis down + non-overlapping bookings: both succeed', async () => {
    jest.spyOn(getRedis(), 'set').mockRejectedValue(new Error('down'));
    const [a, b] = await patients(2);
    const res = await raceBook([
      { patient: a!, args: args(nurse, '08:00', '12:00') },
      { patient: b!, args: args(nurse, '14:00', '18:00') },
    ]);
    expect(res.map((r) => r.status)).toEqual([201, 201]);
  });
});

describe('the unique slot index alone is sufficient (other layers bypassed)', () => {
  it('concurrent raw reservations of overlapping ranges: exactly one transaction commits', async () => {
    const start = at(D, '08:00').getTime();
    const tryReserve = (offsetSlots: number) =>
      withTransaction((session) =>
        ReservationService.reserve(
          {
            nurseId: nurse.profileId,
            bookingId: String(new mongoose.Types.ObjectId()),
            startMs: start + offsetSlots * 15 * 60_000,
            endMs: start + offsetSlots * 15 * 60_000 + 8 * 15 * 60_000, // 2 hours
            slotMinutes: 15,
            holdExpiresAt: new Date(Date.now() + 60_000),
          },
          session,
        ),
      );
    // offsets 0..4 all overlap each other (2h windows starting within 1h)
    const results = await Promise.allSettled([0, 1, 2, 3, 4, 0].map(tryReserve));
    const winners = results.filter((r) => r.status === 'fulfilled');
    const losers = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(5);
    for (const l of losers) expect(l.reason).toBeInstanceOf(BookingConflictError);
    expect(await BookingReservation.countDocuments({ nurseId: nurse.profileId })).toBe(8);
  });

  it('a failed (conflicting) reservation leaves nothing behind: the transaction rolls back', async () => {
    const start = at(D, '08:00').getTime();
    const mk = (s: number, n: number) => ({
      nurseId: nurse.profileId,
      bookingId: String(new mongoose.Types.ObjectId()),
      startMs: start + s * 15 * 60_000,
      endMs: start + (s + n) * 15 * 60_000,
      slotMinutes: 15,
      holdExpiresAt: new Date(Date.now() + 60_000),
    });
    await withTransaction((session) => ReservationService.reserve(mk(8, 4), session)); // 10:00-11:00
    await expect(
      withTransaction((session) => ReservationService.reserve(mk(0, 12), session)), // 08:00-11:00 overlaps the tail
    ).rejects.toBeInstanceOf(BookingConflictError);
    // the first 8 slots of the rejected range must NOT have been persisted
    expect(await BookingReservation.countDocuments({ nurseId: nurse.profileId })).toBe(4);
  });
});

describe('expired holds do not block later bookings', () => {
  it('a lapsed unpaid hold is expired on demand and its slots are re-bookable', async () => {
    const [a, b] = await patients(2);
    const first = await raceBook([{ patient: a!, args: args(nurse, '08:00', '12:00') }]);
    expect(first[0]!.status).toBe(201);
    const firstId = first[0]!.body.data.id as string;
    // simulate time passing: hold lapsed, sweeper has NOT run yet
    await Booking.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(firstId) },
      { $set: { holdExpiresAt: new Date(Date.now() - 1000) } },
    );
    await BookingReservation.updateMany(
      { bookingId: firstId },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );

    const second = await raceBook([{ patient: b!, args: args(nurse, '09:00', '11:00') }]);
    expect(second[0]!.status).toBe(201);
    expect((await Booking.findById(firstId))!.status).toBe('EXPIRED');
    await assertConsistent(nurse.profileId);
  });

  it('cleanupOrphanReservations removes reservations of non-blocking bookings (crash safety net)', async () => {
    const [a] = await patients(1);
    const r = await raceBook([{ patient: a!, args: args(nurse, '08:00', '10:00') }]);
    const id = r[0]!.body.data.id as string;
    // simulate a crash that cancelled the booking but left slots behind
    await Booking.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set: { status: 'CANCELLED' } },
    );
    expect(await BookingReservation.countDocuments()).toBeGreaterThan(0);
    const { removed } = await BookingService.cleanupOrphanReservations();
    expect(removed).toBe(8);
    expect(await BookingReservation.countDocuments()).toBe(0);
    expect((await BookingService.cleanupOrphanReservations()).removed).toBe(0); // idempotent
  });
});

describe('API still shows the world is sane after the storm', () => {
  it('the winner is retrievable and the losers do not exist anywhere', async () => {
    const ps = await patients(5);
    const res = await raceBook(
      ps.map((patient) => ({ patient, args: args(nurse, '08:00', '12:00') })),
    );
    const winnerIdx = res.findIndex((r) => r.status === 201);
    const get = await request(app)
      .get(`${API}/bookings/${res[winnerIdx]!.body.data.id}`)
      .set(ps[winnerIdx]!.auth);
    expect(get.status).toBe(200);
    for (let i = 0; i < ps.length; i++) {
      if (i === winnerIdx) continue;
      const list = await request(app).get(`${API}/bookings`).set(ps[i]!.auth);
      expect(list.body.data.items).toHaveLength(0);
    }
  });
});
