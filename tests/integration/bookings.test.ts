import type { Express } from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { resetRateLimiters } from '../../src/common/middleware/rateLimit';
import { InvalidBookingStateError } from '../../src/common/errors';
import { signQuoteToken } from '../../src/common/utils/jwt';
import {
  Booking,
  BookingHistory,
  BookingItem,
  BookingReservation,
  BookingService,
  BookingStateMachine,
} from '../../src/modules/bookings';
import { NurseProfile } from '../../src/modules/nurses';
import { User } from '../../src/modules/users';
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
  LOCATION,
  at,
  bookIt,
  bookReq,
  day,
  mkNurse,
  mkService,
  quoteReq,
  timeTravel,
  type BookArgs,
  type Nurse,
} from '../helpers/world';

let app: Express;
let admin: Session;
let patient: Session;
let patient2: Session;
let serviceId: string;
let nurse: Nurse;
let D: string;

beforeAll(async () => {
  app = await startApp();
});
afterAll(stopApp);
beforeEach(async () => {
  await resetState();
  admin = await createAdmin(app);
  serviceId = await mkService(app, admin);
  nurse = await mkNurse(app, admin, { serviceIds: [serviceId] });
  patient = await register(app, 'PATIENT');
  patient2 = await register(app, 'PATIENT');
  D = day(5);
});

const args = (s = '08:00', e = '12:00', over: Partial<BookArgs> = {}): BookArgs => ({
  serviceId,
  nurseId: nurse.profileId,
  start: at(D, s),
  end: at(D, e),
  ...over,
});
const get = (s: Session, path: string) => request(app).get(`${API}${path}`).set(s.auth);
const post = (s: Session, path: string, body: object = {}) =>
  request(app).post(`${API}${path}`).set(s.auth).send(body);
const put = (s: Session, path: string, body: object) =>
  request(app).put(`${API}${path}`).set(s.auth).send(body);

async function create(a = args(), who = patient) {
  const { booking } = await bookIt(app, who, a);
  expect(booking.status).toBe(201);
  return booking.body.data as { id: string; status: string };
}
const pay = (id: string) => BookingService.markPaid(id);
const statusOf = async (id: string) => (await Booking.findById(id))!.status;
const histories = async (id: string) =>
  (await BookingHistory.find({ bookingId: id }).sort({ createdAt: 1, _id: 1 }).lean()).map(
    (h) => h.newState,
  );

describe('creating a booking', () => {
  it('creates a PAYMENT_PENDING booking with server-side pricing, a hold, reservations, items and history', async () => {
    const before = Date.now();
    const b = await create();
    expect(b.status).toBe('PAYMENT_PENDING');
    const doc = (await Booking.findById(b.id).lean())!;

    // server priced: 4h x 4000 fils
    expect(doc.pricingSnapshot).toMatchObject({
      currency: 'AED',
      unit: 'HOURLY',
      baseMinor: 16000,
      grossMinor: 16000,
      discountMinor: 0,
      patientPayableMinor: 16000,
    });
    // financial snapshot (platform-funded discounts, commission 15%, nurse earnings from gross)
    expect(doc.financialSnapshot).toMatchObject({
      grossMinor: 16000,
      discountMinor: 0,
      patientPaidMinor: 16000,
      platformFundedDiscountMinor: 0,
      commissionBps: 1500,
      commissionMinor: 2400,
      nurseEarningMinor: 13600,
      paymentProcessingFeeMinor: 0,
      platformNetRevenueMinor: 2400,
    });
    expect(doc.commissionSnapshot).toMatchObject({
      type: 'PERCENTAGE',
      bps: 1500,
      platformMinor: 2400,
      nurseMinor: 13600,
    });
    expect(doc.refundPolicySnapshot!.tiers).toHaveLength(3);
    expect(doc.serviceSnapshot).toMatchObject({ billingUnit: 'HOURLY' });
    expect(doc.bookingNumber).toMatch(/^BK-\d{6}-[0-9A-F]{8}$/);

    // hold = platform setting (15 min default)
    const holdMs = doc.holdExpiresAt!.getTime() - before;
    expect(holdMs).toBeGreaterThan(14 * 60_000);
    expect(holdMs).toBeLessThan(16 * 60_000);

    expect(await BookingReservation.countDocuments({ bookingId: b.id, state: 'HELD' })).toBe(16);
    expect(await BookingItem.countDocuments({ bookingId: b.id })).toBe(1);
    expect(await histories(b.id)).toEqual(['PENDING', 'PAYMENT_PENDING']);
  });

  it('uses the configured hold duration from PlatformSettings', async () => {
    const r = await put(admin, '/admin/settings/booking.holdMinutes', { value: 5 });
    expect(r.status).toBe(200);
    const b = await create();
    const doc = (await Booking.findById(b.id).lean())!;
    expect(doc.holdExpiresAt!.getTime() - Date.now()).toBeLessThan(5 * 60_000 + 2000);
  });

  it('the patient response never contains commission or nurse earnings; admin sees everything', async () => {
    const b = await create();
    const mine = (await get(patient, `/bookings/${b.id}`)).body.data;
    expect(mine.pricing.patientPayableMinor).toBe(16000);
    expect(JSON.stringify(mine)).not.toMatch(/commission|nurseEarning|financial/i);
    const adm = (await get(admin, `/bookings/${b.id}`)).body.data;
    expect(adm.financial).toMatchObject({ commissionMinor: 2400, nurseEarningMinor: 13600 });
    expect(adm.commission).toMatchObject({ bps: 1500 });
  });

  it('rejects client-supplied prices/totals (strict body) and unknown fields', async () => {
    const q = await quoteReq(app, patient, args());
    const res = await request(app)
      .post(`${API}/bookings`)
      .set(patient.auth)
      .set('Idempotency-Key', 'test-key-00000001')
      .send({
        serviceId,
        nurseId: nurse.profileId,
        startDateTime: at(D, '08:00').toISOString(),
        endDateTime: at(D, '12:00').toISOString(),
        location: LOCATION,
        quoteToken: q.body.data.quoteToken,
        totalMinor: 1,
        patientPayableMinor: 1,
      });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe('VALIDATION_ERROR');
    expect(await Booking.countDocuments()).toBe(0);
  });
});

describe('booking validation', () => {
  const quote = (a: BookArgs, who = patient) => quoteReq(app, who, a);

  it('unknown service -> 404 SERVICE_NOT_FOUND', async () => {
    const r = await quote(
      args('08:00', '12:00', { serviceId: String(new mongoose.Types.ObjectId()) }),
    );
    expect(r.status).toBe(404);
    expect(r.body.errorCode).toBe('SERVICE_NOT_FOUND');
  });

  it('inactive service cannot be quoted or booked', async () => {
    const q = await quote(args());
    expect(
      (await request(app).patch(`${API}/admin/services/${serviceId}/deactivate`).set(admin.auth))
        .status,
    ).toBe(200);
    const r = await quote(args());
    expect(r.status).toBe(422);
    expect(r.body.errorCode).toBe('SERVICE_INACTIVE');
    const b = await bookReq(app, patient, args(), q.body.data.quoteToken);
    expect(b.status).toBe(422);
    expect(b.body.errorCode).toBe('SERVICE_INACTIVE');
    expect(await Booking.countDocuments()).toBe(0);
  });

  it('nurse that does not offer the service -> 422 SERVICE_NOT_OFFERED', async () => {
    const other = await mkService(app, admin);
    const r = await quote(args('08:00', '12:00', { serviceId: other }));
    expect(r.status).toBe(422);
    expect(r.body.errorCode).toBe('SERVICE_NOT_OFFERED');
    // a disabled offer behaves the same
    await put(nurse.session, '/nurses/me/services', { services: [] });
    expect((await quote(args())).body.errorCode).toBe('SERVICE_NOT_OFFERED');
  });

  it('unverified, rejected, inactive, suspended and blocked nurses are not bookable', async () => {
    const unverified = await mkNurse(app, admin, { serviceIds: [serviceId], verify: false });
    const r1 = await quote(args('08:00', '12:00', { nurseId: unverified.profileId }));
    expect(r1.status).toBe(422);
    expect(r1.body.errorCode).toBe('NURSE_NOT_BOOKABLE');

    // paused by the nurse
    await request(app)
      .patch(`${API}/nurses/me/status`)
      .set(nurse.session.auth)
      .send({ status: 'INACTIVE' });
    expect((await quote(args())).body.errorCode).toBe('NURSE_NOT_BOOKABLE');
    await request(app)
      .patch(`${API}/nurses/me/status`)
      .set(nurse.session.auth)
      .send({ status: 'ACTIVE' });
    expect((await quote(args())).status).toBe(200);

    // suspended by admin
    await request(app)
      .patch(`${API}/admin/nurses/${nurse.profileId}/suspend`)
      .set(admin.auth)
      .send({ reason: 'investigation' });
    expect((await quote(args())).body.errorCode).toBe('NURSE_NOT_BOOKABLE');
    await request(app)
      .patch(`${API}/admin/nurses/${nurse.profileId}/reactivate`)
      .set(admin.auth)
      .send({});

    // account blocked
    await request(app)
      .patch(`${API}/admin/users/${nurse.session.id}/block`)
      .set(admin.auth)
      .send({ blocked: true, reason: 'abuse report' });
    expect((await quote(args())).body.errorCode).toBe('NURSE_NOT_BOOKABLE');
  });

  it('unknown nurse -> 404', async () => {
    const r = await quote(
      args('08:00', '12:00', { nurseId: String(new mongoose.Types.ObjectId()) }),
    );
    expect(r.status).toBe(404);
    expect(r.body.errorCode).toBe('NURSE_NOT_FOUND');
  });

  it('outside the nurse working hours -> 409 NURSE_NOT_AVAILABLE with a reason', async () => {
    const day9to5 = await mkNurse(app, admin, {
      serviceIds: [serviceId],
      hours: ['09:00', '17:00'],
    });
    const r = await quote(args('18:00', '20:00', { nurseId: day9to5.profileId }));
    expect(r.status).toBe(409);
    expect(r.body.errorCode).toBe('NURSE_NOT_AVAILABLE');
    expect(r.body.details[0].message).toBe('OUTSIDE_WORKING_HOURS');
    expect((await quote(args('09:00', '11:00', { nurseId: day9to5.profileId }))).status).toBe(200);
    expect((await quote(args('16:00', '18:00', { nurseId: day9to5.profileId }))).status).toBe(409); // straddles closing
  });

  it('a nurse with no availability rules is never available', async () => {
    const none = await mkNurse(app, admin, { serviceIds: [serviceId], hours: null });
    expect((await quote(args('08:00', '12:00', { nurseId: none.profileId }))).body.errorCode).toBe(
      'NURSE_NOT_AVAILABLE',
    );
  });

  it('invalid durations and times', async () => {
    const short = await quote(args('08:00', '08:30'));
    expect(short.status).toBe(422);
    expect(short.body.errorCode).toBe('INVALID_DURATION');
    const long = await quote({
      ...args(),
      end: new Date(at(D, '08:00').getTime() + 25 * 3_600_000),
    });
    expect(long.body.errorCode).toBe('INVALID_DURATION'); // service max is 24h
    const reversed = await quote(args('12:00', '08:00'));
    expect(reversed.body.errorCode).toBe('INVALID_BOOKING_TIME');
    const unaligned = await quote({
      ...args(),
      start: new Date(at(D, '08:00').getTime() + 7 * 60_000),
    });
    expect(unaligned.body.errorCode).toBe('INVALID_BOOKING_TIME');
    const past = await quote({
      ...args(),
      start: new Date(Date.now() - 3_600_000),
      end: new Date(Date.now() + 3_600_000),
    });
    expect(past.body.errorCode).toBe('INVALID_BOOKING_TIME');
    const tooSoon = await quote({
      ...args(),
      start: new Date(Math.ceil((Date.now() + 10 * 60_000) / 900_000) * 900_000),
      end: new Date(Math.ceil((Date.now() + 10 * 60_000) / 900_000) * 900_000 + 7_200_000),
    });
    expect(tooSoon.body.errorCode).toBe('INVALID_BOOKING_TIME'); // min lead 60 min
    const tooFar = await quote({
      ...args(),
      start: at(day(200), '08:00'),
      end: at(day(200), '12:00'),
    });
    expect(tooFar.body.errorCode).toBe('INVALID_BOOKING_TIME');
  });

  it('outside the nurse service radius -> 422 OUT_OF_SERVICE_AREA', async () => {
    const far = await request(app)
      .post(`${API}/bookings/quote`)
      .set(patient.auth)
      .send({
        serviceId,
        nurseId: nurse.profileId,
        startDateTime: at(D, '08:00').toISOString(),
        endDateTime: at(D, '12:00').toISOString(),
        location: { latitude: 24.4539, longitude: 54.3773 },
      }); // Abu Dhabi ~130km
    expect(far.status).toBe(422);
    expect(far.body.errorCode).toBe('OUT_OF_SERVICE_AREA');
  });

  it('gender preference must match', async () => {
    const r = await request(app)
      .post(`${API}/bookings/quote`)
      .set(patient.auth)
      .send({
        serviceId,
        nurseId: nurse.profileId,
        startDateTime: at(D, '08:00').toISOString(),
        endDateTime: at(D, '12:00').toISOString(),
        genderPreference: 'MALE',
      });
    expect(r.body.errorCode).toBe('GENDER_PREFERENCE_MISMATCH');
  });

  it('a nurse cannot create bookings or quotes (403)', async () => {
    expect((await post(nurse.session, '/bookings/quote', {})).status).toBe(403);
    expect((await post(nurse.session, '/bookings', {})).status).toBe(403);
    expect((await request(app).post(`${API}/bookings/quote`).send({})).status).toBe(401);
  });
});

describe('quotes', () => {
  it('returns an itemised integer quote with expiry and a pricing reference; reserves nothing', async () => {
    const q = await quoteReq(app, patient, args());
    expect(q.status).toBe(200);
    expect(q.body.data).toMatchObject({
      currency: 'AED',
      unit: 'HOURLY',
      durationMinutes: 240,
      rateMinor: 4000,
      rateSource: 'SERVICE',
      baseMinor: 16000,
      surchargeMinor: 0,
      feesMinor: 0,
      discountMinor: 0,
      grossMinor: 16000,
      patientPayableMinor: 16000,
    });
    expect(q.body.data.pricingVersion).toMatch(/^[0-9a-f]{16}$/);
    expect(q.body.data.quoteToken.split('.')).toHaveLength(3);
    const ttl = new Date(q.body.data.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(9 * 60_000);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000 + 1000);
    expect(JSON.stringify(q.body)).not.toMatch(/commission|nurseEarning/i);
    expect(await BookingReservation.countDocuments()).toBe(0);
    expect(await Booking.countDocuments()).toBe(0);
  });

  it('uses the nurse-specific rate override when configured', async () => {
    await put(nurse.session, '/nurses/me/services', {
      services: [{ serviceId, hourlyRateMinor: 6000 }],
    });
    const q = await quoteReq(app, patient, args());
    expect(q.body.data).toMatchObject({
      rateSource: 'NURSE_OVERRIDE',
      rateMinor: 6000,
      patientPayableMinor: 24000,
    });
  });

  it('a quote token cannot be used for another time range, nurse, or patient', async () => {
    const q = await quoteReq(app, patient, args());
    const token = q.body.data.quoteToken;
    const diffTime = await bookReq(app, patient, args('09:00', '13:00'), token);
    expect(diffTime.status).toBe(409);
    expect(diffTime.body.errorCode).toBe('QUOTE_MISMATCH');
    const otherPatient = await bookReq(app, patient2, args(), token);
    expect(otherPatient.body.errorCode).toBe('QUOTE_MISMATCH');
    const nurse2 = await mkNurse(app, admin, { serviceIds: [serviceId] });
    const otherNurse = await bookReq(
      app,
      patient,
      args('08:00', '12:00', { nurseId: nurse2.profileId }),
      token,
    );
    expect(otherNurse.body.errorCode).toBe('QUOTE_MISMATCH');
    expect(await Booking.countDocuments()).toBe(0);
  });

  it('an expired quote is rejected with QUOTE_EXPIRED', async () => {
    const q = await quoteReq(app, patient, args());
    const live = JSON.parse(
      Buffer.from(q.body.data.quoteToken.split('.')[1], 'base64url').toString(),
    );
    const expired = signQuoteToken(
      {
        pid: live.pid,
        svc: live.svc,
        nrs: live.nrs,
        st: live.st,
        en: live.en,
        tot: live.tot,
        ver: live.ver,
      },
      -30,
    );
    const r = await bookReq(app, patient, args(), expired);
    expect(r.status).toBe(422);
    expect(r.body.errorCode).toBe('QUOTE_EXPIRED');
  });

  it('garbage or access-token-as-quote is rejected with INVALID_QUOTE', async () => {
    expect((await bookReq(app, patient, args(), 'x'.repeat(40))).body.errorCode).toBe(
      'INVALID_QUOTE',
    );
    expect((await bookReq(app, patient, args(), patient.accessToken)).body.errorCode).toBe(
      'INVALID_QUOTE',
    );
  });

  it('a price change after the quote invalidates it (QUOTE_MISMATCH) and the booking is not created', async () => {
    const q = await quoteReq(app, patient, args());
    const pub = await request(app)
      .post(`${API}/admin/services/${serviceId}/prices`)
      .set(admin.auth)
      .send({ kind: 'HOURLY', amountMinor: 5000 });
    expect(pub.status).toBe(201);
    const r = await bookReq(app, patient, args(), q.body.data.quoteToken);
    expect(r.status).toBe(409);
    expect(r.body.errorCode).toBe('QUOTE_MISMATCH');
    // a fresh quote reflects the new rate
    const q2 = await quoteReq(app, patient, args());
    expect(q2.body.data.patientPayableMinor).toBe(20000);
    expect((await bookReq(app, patient, args(), q2.body.data.quoteToken)).status).toBe(201);
  });

  it('existing bookings keep their snapshot when prices change later', async () => {
    const b = await create();
    await request(app)
      .post(`${API}/admin/services/${serviceId}/prices`)
      .set(admin.auth)
      .send({ kind: 'HOURLY', amountMinor: 9000 });
    await request(app)
      .patch(`${API}/admin/services/${serviceId}`)
      .set(admin.auth)
      .send({ name: 'Renamed Service' });
    const doc = (await Booking.findById(b.id).lean())!;
    expect(doc.pricingSnapshot.patientPayableMinor).toBe(16000);
    expect(doc.serviceSnapshot!.name).not.toBe('Renamed Service');
    expect((await get(patient, `/bookings/${b.id}`)).body.data.service.name).toBe(
      doc.serviceSnapshot!.name,
    );
  });
});

describe('immutability and status protection', () => {
  it('snapshots and time fields cannot be modified through the model', async () => {
    const b = await create();
    await expect(
      Booking.updateOne({ _id: b.id }, { $set: { 'pricingSnapshot.grossMinor': 1 } }),
    ).rejects.toThrow(/immutable/);
    await expect(
      Booking.updateOne({ _id: b.id }, { $set: { financialSnapshot: {} } }),
    ).rejects.toThrow(/immutable/);
    await expect(
      Booking.updateOne({ _id: b.id }, { $set: { startDateTime: new Date() } }),
    ).rejects.toThrow(/immutable/);
    await expect(
      Booking.updateOne({ _id: b.id }, { $set: { nurseId: new mongoose.Types.ObjectId() } }),
    ).rejects.toThrow(/immutable/);
  });

  it('status cannot be changed outside the BookingStateMachine', async () => {
    const b = await create();
    await expect(
      Booking.updateOne({ _id: b.id }, { $set: { status: 'CONFIRMED' } }),
    ).rejects.toThrow(/BookingStateMachine/);
    await expect(Booking.findOneAndUpdate({ _id: b.id }, { status: 'PAID' })).rejects.toThrow(
      /BookingStateMachine/,
    );
    await expect(Booking.updateMany({}, { $set: { status: 'PAID' } })).rejects.toThrow();
    expect(await statusOf(b.id)).toBe('PAYMENT_PENDING');
  });

  it('bookings are never deleted; history and items are append-only', async () => {
    const b = await create();
    await expect(Booking.deleteOne({ _id: b.id })).rejects.toThrow(/never deleted/);
    await expect(
      BookingHistory.updateOne({ bookingId: b.id }, { reason: 'edited' }),
    ).rejects.toThrow(/append-only/);
    await expect(BookingHistory.deleteMany({ bookingId: b.id })).rejects.toThrow(/append-only/);
    await expect(BookingItem.updateOne({ bookingId: b.id }, { label: 'x' })).rejects.toThrow(
      /immutable/,
    );
  });
});

describe('state machine against the database', () => {
  it('illegal transitions return InvalidBookingStateError and change nothing', async () => {
    const b = await create();
    for (const to of [
      'CONFIRMED',
      'COMPLETED',
      'CARE_STARTED',
      'NURSE_ACCEPTED',
      'REFUNDED',
    ] as const) {
      await expect(
        BookingStateMachine.transitionAtomic(b.id, to, { role: 'SYSTEM' }),
      ).rejects.toBeInstanceOf(InvalidBookingStateError);
    }
    expect(await statusOf(b.id)).toBe('PAYMENT_PENDING');
    expect(await histories(b.id)).toEqual(['PENDING', 'PAYMENT_PENDING']);
  });

  it('wrong actors are refused (patient cannot mark paid; nurse cannot cancel)', async () => {
    const b = await create();
    await expect(
      BookingStateMachine.transitionAtomic(b.id, 'PAID', { role: 'PATIENT', userId: patient.id }),
    ).rejects.toThrow(/not permitted/);
    await expect(
      BookingStateMachine.transitionAtomic(b.id, 'CANCELLED', {
        role: 'NURSE',
        userId: nurse.session.id,
      }),
    ).rejects.toThrow(/not permitted/);
  });

  it('the full happy path through the API with a history entry for every transition', async () => {
    const b = await create();
    await pay(b.id);
    expect(await statusOf(b.id)).toBe('NURSE_PENDING');
    expect(await BookingReservation.countDocuments({ bookingId: b.id, state: 'CONFIRMED' })).toBe(
      16,
    );
    expect(
      await BookingReservation.countDocuments({ bookingId: b.id, expiresAt: { $exists: true } }),
    ).toBe(0);

    const acc = await post(nurse.session, `/bookings/${b.id}/accept`);
    expect(acc.status).toBe(200);
    expect(acc.body.data.status).toBe('CONFIRMED');

    // too early to start (booking is days away)
    const early = await post(nurse.session, `/bookings/${b.id}/start`);
    expect(early.status).toBe(422);
    expect(early.body.errorCode).toBe('INVALID_BOOKING_STATE');

    // move the clock: the booking is now "starting"
    const now = Date.now();
    await timeTravel(b.id, {
      startDateTime: new Date(now - 10 * 60_000),
      endDateTime: new Date(now + 3 * 3_600_000),
    });
    const start = await post(nurse.session, `/bookings/${b.id}/start`);
    expect(start.status).toBe(200);
    expect(start.body.data.status).toBe('CARE_IN_PROGRESS');

    const done = await post(nurse.session, `/bookings/${b.id}/complete`);
    expect(done.status).toBe(200);
    expect(done.body.data.status).toBe('COMPLETED');

    expect(await histories(b.id)).toEqual([
      'PENDING',
      'PAYMENT_PENDING',
      'PAID',
      'NURSE_PENDING',
      'NURSE_ACCEPTED',
      'CONFIRMED',
      'CARE_STARTED',
      'CARE_IN_PROGRESS',
      'COMPLETED',
    ]);
    expect(await BookingReservation.countDocuments({ bookingId: b.id })).toBe(0); // released on completion
    expect((await NurseProfile.findById(nurse.profileId))!.totalCompletedBookings).toBe(1);

    const hist = await get(patient, `/bookings/${b.id}/history`);
    expect(hist.body.data.items.map((h: { newState: string }) => h.newState)).toContain(
      'COMPLETED',
    );
    expect(hist.body.data.items[0]).toMatchObject({
      previousState: null,
      newState: 'PENDING',
      actorRole: 'PATIENT',
    });
  });

  it('invalid transitions through the API are clean business errors (422 INVALID_BOOKING_STATE)', async () => {
    const b = await create();
    await pay(b.id);
    await post(nurse.session, `/bookings/${b.id}/accept`);
    const complete = await post(nurse.session, `/bookings/${b.id}/complete`); // CONFIRMED -> COMPLETED is illegal
    expect(complete.status).toBe(422);
    expect(complete.body).toMatchObject({ success: false, errorCode: 'INVALID_BOOKING_STATE' });
    const acceptAgain = await post(nurse.session, `/bookings/${b.id}/accept`);
    expect(acceptAgain.status).toBe(422);
    const rejectLate = await post(nurse.session, `/bookings/${b.id}/reject`);
    expect(rejectLate.status).toBe(422);
  });

  it('nurse rejection releases the time range so it can be booked again', async () => {
    const b = await create();
    await pay(b.id);
    const rej = await post(nurse.session, `/bookings/${b.id}/reject`, { reason: 'not available' });
    expect(rej.body.data.status).toBe('REFUND_PENDING'); // paid + rejected => 100% refund pending
    expect(await BookingReservation.countDocuments({ bookingId: b.id })).toBe(0);
    expect(await histories(b.id)).toEqual([
      'PENDING',
      'PAYMENT_PENDING',
      'PAID',
      'NURSE_PENDING',
      'NURSE_REJECTED',
      'REFUND_PENDING',
    ]);
    const again = await bookIt(app, patient2, args());
    expect(again.booking.status).toBe(201);
  });

  it('two simultaneous accepts: exactly one succeeds', async () => {
    const b = await create();
    await pay(b.id);
    const res = await Promise.all([
      post(nurse.session, `/bookings/${b.id}/accept`),
      post(nurse.session, `/bookings/${b.id}/accept`),
    ]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 422]);
    expect(await histories(b.id)).toEqual([
      'PENDING',
      'PAYMENT_PENDING',
      'PAID',
      'NURSE_PENDING',
      'NURSE_ACCEPTED',
      'CONFIRMED',
    ]);
  });
});

describe('cancellation (before payment only in Phase 2)', () => {
  it('patient cancels an unpaid booking: slot released, history written', async () => {
    const b = await create();
    const r = await post(patient, `/bookings/${b.id}/cancel`, { reason: 'changed my mind' });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('CANCELLED');
    expect(await BookingReservation.countDocuments({ bookingId: b.id })).toBe(0);
    expect(await histories(b.id)).toEqual(['PENDING', 'PAYMENT_PENDING', 'CANCELLED']);
    expect((await post(patient, `/bookings/${b.id}/cancel`)).status).toBe(409); // already cancelled
    expect((await bookIt(app, patient2, args())).booking.status).toBe(201);
  });

  it('paid bookings are cancelled through the refund workflow (see refund-workflow tests)', async () => {
    const b = await create();
    await pay(b.id);
    const r = await post(patient, `/bookings/${b.id}/cancel`);
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('REFUND_PENDING'); // booking is days away => 100% tier
    expect(r.body.data.refund).toMatchObject({
      status: 'PENDING',
      percent: 100,
      amountMinor: 16000,
    });
  });
});

describe('hold expiration', () => {
  it('expireDue expires lapsed holds, frees slots, is idempotent, and blocks later payment', async () => {
    const b = await create();
    const fresh = await BookingService.expireDue(new Date());
    expect(fresh.expired).toBe(0); // not due yet
    const later = new Date(Date.now() + 16 * 60_000);
    expect((await BookingService.expireDue(later)).expired).toBe(1);
    expect((await BookingService.expireDue(later)).expired).toBe(0); // idempotent
    expect(await statusOf(b.id)).toBe('EXPIRED');
    expect(await BookingReservation.countDocuments({ bookingId: b.id })).toBe(0);
    expect(await histories(b.id)).toEqual(['PENDING', 'PAYMENT_PENDING', 'EXPIRED']);
    await expect(pay(b.id)).rejects.toBeInstanceOf(InvalidBookingStateError); // an expired booking can never be paid
    expect(await statusOf(b.id)).toBe('EXPIRED');
  });

  it('paying a lapsed (but not yet swept) hold is refused with 409 BOOKING_EXPIRED and expires it', async () => {
    const b = await create();
    await timeTravel(b.id, { holdExpiresAt: new Date(Date.now() - 1000) });
    await expect(pay(b.id)).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'BOOKING_EXPIRED',
    });
    expect(await statusOf(b.id)).toBe('EXPIRED');
    expect(await BookingReservation.countDocuments({ bookingId: b.id })).toBe(0);
  });

  it('a nurse who never responds: NURSE_PENDING expires and the nurse cannot accept late', async () => {
    const b = await create();
    await pay(b.id);
    await timeTravel(b.id, { nurseResponseDeadline: new Date(Date.now() - 1000) });
    const r = await post(nurse.session, `/bookings/${b.id}/accept`);
    expect(r.status).toBe(409);
    expect(r.body.errorCode).toBe('BOOKING_EXPIRED');
    expect(await statusOf(b.id)).toBe('REFUND_PENDING'); // EXPIRED -> REFUND_PENDING (100%)
    expect(await BookingReservation.countDocuments({ bookingId: b.id })).toBe(0);
  });

  it('expireDue also handles NURSE_PENDING timeouts', async () => {
    const b = await create();
    await pay(b.id);
    const far = new Date(Date.now() + 3 * 3_600_000);
    expect((await BookingService.expireDue(far)).expired).toBe(1);
    expect(await histories(b.id)).toEqual([
      'PENDING',
      'PAYMENT_PENDING',
      'PAID',
      'NURSE_PENDING',
      'EXPIRED',
      'REFUND_PENDING',
    ]);
  });
});

describe('auto-completion', () => {
  const setup = async (status: string, endAgoMinutes: number) => {
    const b = await create();
    const now = Date.now();
    await Booking.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(b.id) },
      {
        $set: {
          status,
          startDateTime: new Date(now - (endAgoMinutes + 120) * 60_000),
          endDateTime: new Date(now - endAgoMinutes * 60_000),
          paidAt: new Date(),
        },
      },
    );
    await BookingReservation.deleteMany({ bookingId: b.id }); // free the slots so the next setup() can reuse the range
    return b.id;
  };

  it('completes CARE_IN_PROGRESS / CARE_STARTED bookings after end + grace, idempotently', async () => {
    const a = await setup('CARE_IN_PROGRESS', 180);
    const c = await setup('CARE_STARTED', 180);
    const res = await BookingService.autoCompleteDue();
    expect(res.completed).toBe(2);
    expect(await statusOf(a)).toBe('COMPLETED');
    expect(await statusOf(c)).toBe('COMPLETED');
    expect((await BookingService.autoCompleteDue()).completed).toBe(0);
    expect((await NurseProfile.findById(nurse.profileId))!.totalCompletedBookings).toBe(2);
  });

  it('does not complete inside the grace period', async () => {
    const a = await setup('CARE_IN_PROGRESS', 30); // grace is 120 min
    expect((await BookingService.autoCompleteDue()).completed).toBe(0);
    expect(await statusOf(a)).toBe('CARE_IN_PROGRESS');
  });

  it('never touches cancelled, refunded, disputed, completed, expired or merely confirmed bookings', async () => {
    const ids: Record<string, string> = {};
    for (const s of [
      'CANCELLED',
      'REFUNDED',
      'REFUND_PENDING',
      'DISPUTED',
      'COMPLETED',
      'EXPIRED',
      'CONFIRMED',
      'FAILED',
    ]) {
      ids[s] = await setup(s, 600);
    }
    const res = await BookingService.autoCompleteDue();
    expect(res.completed).toBe(0);
    for (const [s, id] of Object.entries(ids)) expect(await statusOf(id)).toBe(s);
  });
});

describe('authorization and visibility', () => {
  it('requires authentication', async () => {
    expect((await request(app).get(`${API}/bookings`)).status).toBe(401);
    expect(
      (await request(app).post(`${API}/bookings/${new mongoose.Types.ObjectId()}/cancel`)).status,
    ).toBe(401);
  });

  it("another patient cannot read, cancel or see someone else's booking (404, not 403)", async () => {
    const b = await create();
    expect((await get(patient2, `/bookings/${b.id}`)).status).toBe(404);
    expect((await get(patient2, `/bookings/${b.id}/history`)).status).toBe(404);
    expect((await post(patient2, `/bookings/${b.id}/cancel`)).status).toBe(404);
    expect((await get(patient2, '/bookings')).body.data.items).toHaveLength(0);
    expect((await get(patient, '/bookings')).body.data.items).toHaveLength(1);
  });

  it('patients cannot perform nurse actions; nurses cannot cancel as patients', async () => {
    const b = await create();
    await pay(b.id);
    for (const action of ['accept', 'reject', 'start', 'complete']) {
      expect((await post(patient, `/bookings/${b.id}/${action}`)).status).toBe(403);
    }
    expect((await post(nurse.session, `/bookings/${b.id}/cancel`)).status).toBe(403);
  });

  it('a nurse sees only PAID requests assigned to them, never unpaid holds, never other nurses', async () => {
    const b = await create();
    expect((await get(nurse.session, `/bookings/${b.id}`)).status).toBe(404); // unpaid hold is invisible
    expect((await get(nurse.session, '/bookings')).body.data.items).toHaveLength(0);
    await pay(b.id);
    expect((await get(nurse.session, `/bookings/${b.id}`)).status).toBe(200);
    expect((await get(nurse.session, '/bookings')).body.data.items).toHaveLength(1);

    const other = await mkNurse(app, admin, { serviceIds: [serviceId] });
    expect((await get(other.session, `/bookings/${b.id}`)).status).toBe(404);
    expect((await post(other.session, `/bookings/${b.id}/accept`)).status).toBe(404);
    expect((await post(other.session, `/bookings/${b.id}/reject`)).status).toBe(404);
    expect(await statusOf(b.id)).toBe('NURSE_PENDING');
  });

  it('nurse view: own earnings only, exact address hidden until accepted', async () => {
    const b = await create();
    await pay(b.id);
    const before = (await get(nurse.session, `/bookings/${b.id}`)).body.data;
    expect(before.earnings).toEqual({ currency: 'AED', nurseEarningMinor: 13600 });
    expect(before.location.address).toBeNull();
    expect(before.location.latitude).toBeNull();
    expect(before.location.city).toBe('Dubai');
    expect(before.patient.displayName).toMatch(/^Test P\.$/);
    expect(JSON.stringify(before)).not.toMatch(/pricing|commission|patientPayable/i);
    await post(nurse.session, `/bookings/${b.id}/accept`);
    const after = (await get(nurse.session, `/bookings/${b.id}`)).body.data;
    expect(after.location.address).toBe(LOCATION.address);
  });

  it('admin can list and filter all bookings; others cannot', async () => {
    await create();
    await create(args('14:00', '16:00'), patient2);
    const all = await get(admin, '/admin/bookings');
    expect(all.body.data.meta).toMatchObject({ total: 2, page: 1 });
    expect((await get(admin, '/admin/bookings?status=PAID')).body.data.meta.total).toBe(0);
    expect((await get(admin, `/admin/bookings?patientId=${patient.id}`)).body.data.meta.total).toBe(
      1,
    );
    expect((await get(patient, '/admin/bookings')).status).toBe(403);
    expect((await get(nurse.session, '/admin/bookings')).status).toBe(403);
  });

  it('listing supports pagination, status and date filters', async () => {
    for (let i = 0; i < 3; i++)
      await create(args(`${8 + i * 3}:00`.padStart(5, '0'), `${10 + i * 3}:00`.padStart(5, '0')));
    const p1 = await get(patient, '/bookings?page=1&limit=2');
    expect(p1.body.data.items).toHaveLength(2);
    expect(p1.body.data.meta).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
    expect((await get(patient, '/bookings?status=CANCELLED')).body.data.meta.total).toBe(0);
    expect(
      (
        await get(
          patient,
          `/bookings?from=${at(D, '00:00').toISOString()}&to=${at(D, '09:00').toISOString()}`,
        )
      ).body.data.meta.total,
    ).toBe(1);
    expect((await get(patient, '/bookings?limit=500')).status).toBe(400);
  });

  it('an unrelated nurse user cannot be coerced via nurseUserId in input (strict schema)', async () => {
    const q = await quoteReq(app, patient, args());
    const r = await request(app)
      .post(`${API}/bookings`)
      .set(patient.auth)
      .set('Idempotency-Key', 'test-key-00000001')
      .send({
        serviceId,
        nurseId: nurse.profileId,
        startDateTime: at(D, '08:00').toISOString(),
        endDateTime: at(D, '12:00').toISOString(),
        location: LOCATION,
        quoteToken: q.body.data.quoteToken,
        patientId: patient2.id,
      });
    expect(r.status).toBe(400);
  });
});

describe('misc', () => {
  it('a blocked patient cannot book', async () => {
    await User.updateOne({ _id: patient.id }, { isActive: false });
    resetRateLimiters();
    expect((await quoteReq(app, patient, args())).status).toBe(403);
  });
});
