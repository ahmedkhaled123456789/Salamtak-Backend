import type { Express } from 'express';
import { DateTime } from 'luxon';
import request from 'supertest';
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
  bookIt,
  day,
  mkNurse,
  mkService,
  nextWeekday,
  quoteReq,
  type Nurse,
} from '../helpers/world';

let app: Express;
let admin: Session;
let patient: Session;
let serviceId: string;
let nurse: Nurse;

beforeAll(async () => {
  app = await startApp();
});
afterAll(stopApp);
beforeEach(async () => {
  await resetState();
  admin = await createAdmin(app);
  patient = await register(app, 'PATIENT');
  serviceId = await mkService(app, admin);
  nurse = await mkNurse(app, admin, { serviceIds: [serviceId], hours: null });
});

const rules = (s: Session = nurse.session) =>
  request(app).get(`${API}/nurses/me/availability`).set(s.auth);
const add = (body: object, s: Session = nurse.session) =>
  request(app).post(`${API}/nurses/me/availability`).set(s.auth).send(body);
const plus = (d: string, n: number) => DateTime.fromISO(d).plus({ days: n }).toFormat('yyyy-LL-dd');
const quote = (d: string, from: string, to: string) =>
  quoteReq(app, patient, {
    serviceId,
    nurseId: nurse.profileId,
    start: at(d, from),
    end: at(d, to),
  });

describe('availability rules API', () => {
  it('creates, lists, updates and deletes weekly rules (times shown in HH:mm)', async () => {
    const created = await add({
      kind: 'WEEKLY',
      dayOfWeek: 1,
      startTime: '08:00',
      endTime: '18:00',
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      kind: 'WEEKLY',
      dayOfWeek: 1,
      startTime: '08:00',
      endTime: '18:00',
    });
    const id = created.body.data.id;
    expect((await rules()).body.data.items).toHaveLength(1);

    const upd = await request(app)
      .patch(`${API}/nurses/me/availability/${id}`)
      .set(nurse.session.auth)
      .send({ endTime: '20:00' });
    expect(upd.body.data).toMatchObject({ startTime: '08:00', endTime: '20:00' });
    expect(
      (await request(app).delete(`${API}/nurses/me/availability/${id}`).set(nurse.session.auth))
        .status,
    ).toBe(200);
    expect((await rules()).body.data.items).toHaveLength(0);
    expect(
      (await request(app).delete(`${API}/nurses/me/availability/${id}`).set(nurse.session.auth))
        .status,
    ).toBe(404);
  });

  it('validates input: order, format, kinds, dates, unknown fields', async () => {
    expect(
      (await add({ kind: 'WEEKLY', dayOfWeek: 1, startTime: '18:00', endTime: '08:00' })).status,
    ).toBe(400);
    expect(
      (await add({ kind: 'WEEKLY', dayOfWeek: 8, startTime: '08:00', endTime: '18:00' })).status,
    ).toBe(400);
    expect(
      (await add({ kind: 'WEEKLY', dayOfWeek: 1, startTime: '8am', endTime: '18:00' })).status,
    ).toBe(400);
    expect((await add({ kind: 'DATE', date: '2026-12-01', isAvailable: true })).status).toBe(400); // window required
    expect(
      (
        await add({
          kind: 'DATE',
          date: '2026-12-01',
          isAvailable: false,
          startTime: '08:00',
          endTime: '10:00',
        })
      ).status,
    ).toBe(400);
    expect(
      (await add({ kind: 'DATE', date: '2026-02-30', isAvailable: false })).body.errorCode,
    ).toBe('INVALID_DATE');
    expect(
      (
        await add({
          kind: 'BLOCKED',
          type: 'VACATION',
          dateFrom: '2026-12-10',
          dateTo: '2026-12-01',
        })
      ).status,
    ).toBe(400);
    expect((await add({ kind: 'NOPE' })).status).toBe(400);
    expect(
      (
        await add({
          kind: 'WEEKLY',
          dayOfWeek: 1,
          startTime: '08:00',
          endTime: '18:00',
          nurseId: 'x',
        })
      ).status,
    ).toBe(400);
  });

  it('rejects overlapping weekly windows and conflicting same-date rules; allows adjacent windows', async () => {
    await add({ kind: 'WEEKLY', dayOfWeek: 2, startTime: '08:00', endTime: '12:00' });
    expect(
      (await add({ kind: 'WEEKLY', dayOfWeek: 2, startTime: '11:00', endTime: '15:00' })).body
        .errorCode,
    ).toBe('AVAILABILITY_OVERLAP');
    expect(
      (await add({ kind: 'WEEKLY', dayOfWeek: 2, startTime: '12:00', endTime: '15:00' })).status,
    ).toBe(201);
    await add({
      kind: 'DATE',
      date: '2026-12-01',
      isAvailable: true,
      startTime: '10:00',
      endTime: '12:00',
    });
    expect(
      (await add({ kind: 'DATE', date: '2026-12-01', isAvailable: false })).body.errorCode,
    ).toBe('AVAILABILITY_OVERLAP');
  });

  it('a nurse can only touch their own rules; patients cannot use the endpoints', async () => {
    const other = await mkNurse(app, admin, { serviceIds: [serviceId], hours: null });
    const mine = await add({ kind: 'WEEKLY', dayOfWeek: 1, startTime: '08:00', endTime: '18:00' });
    const id = mine.body.data.id;
    expect(
      (
        await request(app)
          .patch(`${API}/nurses/me/availability/${id}`)
          .set(other.session.auth)
          .send({ endTime: '09:00' })
      ).status,
    ).toBe(404);
    expect(
      (await request(app).delete(`${API}/nurses/me/availability/${id}`).set(other.session.auth))
        .status,
    ).toBe(404);
    expect((await rules(other.session)).body.data.items).toHaveLength(0);
    expect((await rules(patient)).status).toBe(403);
    expect(
      (await add({ kind: 'WEEKLY', dayOfWeek: 1, startTime: '08:00', endTime: '18:00' }, patient))
        .status,
    ).toBe(403);
  });

  it('PATCH only accepts fields that apply to the rule kind', async () => {
    const r = await add({
      kind: 'BLOCKED',
      type: 'VACATION',
      dateFrom: '2026-12-10',
      dateTo: '2026-12-20',
    });
    const bad = await request(app)
      .patch(`${API}/nurses/me/availability/${r.body.data.id}`)
      .set(nurse.session.auth)
      .send({ dayOfWeek: 3 });
    expect(bad.body.errorCode).toBe('FIELD_NOT_APPLICABLE');
  });
});

describe('availability is enforced on quotes/bookings (platform timezone Asia/Dubai)', () => {
  it('weekly hours: 08:00-18:00 local on Tuesdays only', async () => {
    await add({ kind: 'WEEKLY', dayOfWeek: 2, startTime: '08:00', endTime: '18:00' });
    const tue = nextWeekday(2);
    const wed = nextWeekday(3);
    expect((await quote(tue, '08:00', '12:00')).status).toBe(200);
    expect((await quote(tue, '14:00', '18:00')).status).toBe(200); // ends exactly at closing
    expect((await quote(tue, '07:00', '09:00')).body.errorCode).toBe('NURSE_NOT_AVAILABLE'); // starts before opening
    expect((await quote(tue, '17:00', '19:00')).body.errorCode).toBe('NURSE_NOT_AVAILABLE'); // runs past closing
    expect((await quote(wed, '08:00', '12:00')).body.errorCode).toBe('NURSE_NOT_AVAILABLE'); // no rule for Wednesday
  });

  it('timezone: the same UTC instants are judged in Dubai local time, not UTC', async () => {
    await add({ kind: 'WEEKLY', dayOfWeek: 2, startTime: '08:00', endTime: '18:00' });
    const tue = nextWeekday(2);
    // 08:00 Dubai == 04:00Z, so 04:00Z-08:00Z is inside; 02:00Z (06:00 Dubai) is outside.
    const inside = await quoteReq(app, patient, {
      serviceId,
      nurseId: nurse.profileId,
      start: new Date(`${tue}T04:00:00Z`),
      end: new Date(`${tue}T08:00:00Z`),
    });
    expect(inside.status).toBe(200);
    const outside = await quoteReq(app, patient, {
      serviceId,
      nurseId: nurse.profileId,
      start: new Date(`${tue}T02:00:00Z`),
      end: new Date(`${tue}T05:00:00Z`),
    });
    expect(outside.body.errorCode).toBe('NURSE_NOT_AVAILABLE');
    // 15:00Z == 19:00 Dubai (after closing) even though 15:00 "looks" like office hours in UTC
    const late = await quoteReq(app, patient, {
      serviceId,
      nurseId: nurse.profileId,
      start: new Date(`${tue}T15:00:00Z`),
      end: new Date(`${tue}T17:00:00Z`),
    });
    expect(late.body.errorCode).toBe('NURSE_NOT_AVAILABLE');
  });

  it('specific-date override: unavailable day, and modified hours', async () => {
    await add({ kind: 'WEEKLY', dayOfWeek: 2, startTime: '08:00', endTime: '18:00' });
    const tue = nextWeekday(2);
    const nextTue = nextWeekday(2, 10);
    await add({ kind: 'DATE', date: tue, isAvailable: false });
    expect((await quote(tue, '09:00', '12:00')).body.errorCode).toBe('NURSE_NOT_AVAILABLE');
    expect((await quote(nextTue, '09:00', '12:00')).status).toBe(200); // other Tuesdays unaffected

    await add({
      kind: 'DATE',
      date: nextTue,
      isAvailable: true,
      startTime: '13:00',
      endTime: '17:00',
    });
    expect((await quote(nextTue, '09:00', '12:00')).body.errorCode).toBe('NURSE_NOT_AVAILABLE'); // replaced hours
    expect((await quote(nextTue, '13:00', '16:00')).status).toBe(200);
  });

  it('a DATE override can open a day with no weekly rule (extra shift)', async () => {
    const wed = nextWeekday(3);
    expect((await quote(wed, '09:00', '12:00')).status).toBe(409);
    await add({ kind: 'DATE', date: wed, isAvailable: true, startTime: '09:00', endTime: '13:00' });
    expect((await quote(wed, '09:00', '12:00')).status).toBe(200);
  });

  it('blocked dates: vacation, blocked period and holiday override even a DATE opening', async () => {
    await add({ kind: 'WEEKLY', dayOfWeek: 2, startTime: '08:00', endTime: '18:00' });
    const tue = nextWeekday(2);
    await add({ kind: 'DATE', date: tue, isAvailable: true, startTime: '08:00', endTime: '18:00' });
    await add({ kind: 'BLOCKED', type: 'HOLIDAY', dateFrom: tue, dateTo: tue, reason: 'Eid' });
    const r = await quote(tue, '09:00', '12:00');
    expect(r.status).toBe(409);
    expect(r.body.details[0].message).toBe('BLOCKED');
    // range is inclusive on both ends and unrelated dates stay open
    const next = nextWeekday(2, 10);
    await add({ kind: 'BLOCKED', type: 'VACATION', dateFrom: day(1), dateTo: next });
    expect((await quote(next, '09:00', '12:00')).status).toBe(409);
    expect((await quote(nextWeekday(2, 24), '09:00', '12:00')).status).toBe(200);
  });

  it('multi-day (daily) requests need every day covered', async () => {
    const dailyService = await mkService(app, admin, { billingUnit: 'DAILY' });
    await request(app)
      .put(`${API}/nurses/me/services`)
      .set(nurse.session.auth)
      .send({ services: [{ serviceId: dailyService }] });
    for (let d = 1; d <= 7; d++)
      await add({ kind: 'WEEKLY', dayOfWeek: d, startTime: '00:00', endTime: '24:00' });
    const start = at(nextWeekday(2), '08:00');
    const end = new Date(start.getTime() + 72 * 3_600_000);
    const args = { serviceId: dailyService, nurseId: nurse.profileId, start, end };
    expect((await quoteReq(app, patient, args)).status).toBe(200);
    await add({
      kind: 'BLOCKED',
      type: 'BLOCKED',
      dateFrom: plus(nextWeekday(2), 1),
      dateTo: plus(nextWeekday(2), 1),
    });
    expect((await quoteReq(app, patient, args)).body.errorCode).toBe('NURSE_NOT_AVAILABLE');
  });

  it('availability changes do not silently cancel existing bookings', async () => {
    for (let d = 1; d <= 7; d++)
      await add({ kind: 'WEEKLY', dayOfWeek: d, startTime: '00:00', endTime: '24:00' });
    const tue = nextWeekday(2);
    const b = await bookIt(app, patient, {
      serviceId,
      nurseId: nurse.profileId,
      start: at(tue, '09:00'),
      end: at(tue, '12:00'),
    });
    expect(b.booking.status).toBe(201);
    await add({ kind: 'BLOCKED', type: 'VACATION', dateFrom: tue, dateTo: tue });
    const still = await request(app)
      .get(`${API}/bookings/${b.booking.body.data.id}`)
      .set(patient.auth);
    expect(still.body.data.status).toBe('PAYMENT_PENDING');
  });
});

describe('public availability view', () => {
  it('shows working windows per local date plus busy periods; 31-day limit', async () => {
    for (let d = 1; d <= 7; d++)
      await add({ kind: 'WEEKLY', dayOfWeek: d, startTime: '08:00', endTime: '18:00' });
    const tue = nextWeekday(2);
    await add({ kind: 'BLOCKED', type: 'VACATION', dateFrom: plus(tue, 1), dateTo: plus(tue, 1) });
    const booked = await bookIt(app, patient, {
      serviceId,
      nurseId: nurse.profileId,
      start: at(tue, '09:00'),
      end: at(tue, '11:00'),
    });
    expect(booked.booking.status).toBe(201);

    const res = await request(app)
      .get(`${API}/nurses/${nurse.profileId}/availability?from=${tue}&to=${plus(tue, 1)}`)
      .set(patient.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.timezone).toBe('Asia/Dubai');
    expect(res.body.data.days[0]).toMatchObject({
      date: tue,
      available: true,
      windows: [{ start: '08:00', end: '18:00' }],
    });
    const blocked = res.body.data.days.find((x: { date: string }) => x.date === plus(tue, 1));
    expect(blocked).toMatchObject({ available: false, blocked: 'BLOCKED' });
    expect(res.body.data.busy).toHaveLength(1);
    expect(new Date(res.body.data.busy[0].start).toISOString()).toBe(
      at(tue, '09:00').toISOString(),
    );
    expect(JSON.stringify(res.body)).not.toMatch(/patient|bookingId/i);

    const tooLong = await request(app)
      .get(`${API}/nurses/${nurse.profileId}/availability?from=${tue}&to=${day(60)}`)
      .set(patient.auth);
    expect(tooLong.status).toBe(400);
  });
});
