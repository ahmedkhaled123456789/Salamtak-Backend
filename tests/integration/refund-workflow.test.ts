import type { Express } from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { InvalidBookingStateError } from '../../src/common/errors';
import { AuditLog } from '../../src/modules/audit';
import {
  Booking,
  BookingHistory,
  BookingReservation,
  BookingService,
} from '../../src/modules/bookings';
import { API, resetState, startApp, stopApp, type Session } from '../helpers/harness';
import { at, baseWorld, bookIt, timeTravel, type BookArgs, type Nurse } from '../helpers/world';

let app: Express;
let admin: Session;
let serviceId: string;
let nurse: Nurse;
let patient: Session;
let patient2: Session;
let D: string;

beforeAll(async () => {
  app = await startApp();
});
afterAll(stopApp);
beforeEach(async () => {
  await resetState();
  ({ admin, serviceId, nurse, patient, patient2, D } = await baseWorld(app));
});

const H = 3_600_000;
const args = (s = '08:00', e = '12:00'): BookArgs => ({
  serviceId,
  nurseId: nurse.profileId,
  start: at(D, s),
  end: at(D, e),
});
const post = (s: Session, path: string, body: object = {}) =>
  request(app).post(`${API}${path}`).set(s.auth).send(body);
const get = (s: Session, path: string) => request(app).get(`${API}${path}`).set(s.auth);
const put = (s: Session, path: string, body: object) =>
  request(app).put(`${API}${path}`).set(s.auth).send(body);
const statusOf = async (id: string) => (await Booking.findById(id))!.status;
const states = async (id: string) =>
  (await BookingHistory.find({ bookingId: id }).sort({ createdAt: 1, _id: 1 }).lean()).map(
    (h) => h.newState,
  );

async function paidBooking(hoursBeforeStart?: number, who = patient, a = args()) {
  const { booking } = await bookIt(app, who, a);
  expect(booking.status).toBe(201);
  const id = booking.body.data.id as string;
  await BookingService.markPaid(id);
  if (hoursBeforeStart !== undefined) {
    const start = Date.now() + hoursBeforeStart * H;
    await timeTravel(id, { startDateTime: new Date(start), endDateTime: new Date(start + 4 * H) });
  }
  return id;
}

describe('patient cancels a PAID booking: refund per the snapshotted policy', () => {
  it('48h+ before start -> 100% refund: CANCELLED -> REFUND_PENDING', async () => {
    const id = await paidBooking(100);
    const r = await post(patient, `/bookings/${id}/cancel`, { reason: 'plans changed' });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('REFUND_PENDING');
    expect(r.body.data.refund).toMatchObject({
      status: 'PENDING',
      reason: 'PATIENT_CANCELLATION',
      percent: 100,
      amountMinor: 16000,
    });
    expect(r.body.data.cancellationOutcome).toMatchObject({
      cancelledBy: 'PATIENT',
      refundPercent: 100,
      refundMinor: 16000,
    });
    expect(await states(id)).toEqual([
      'PENDING',
      'PAYMENT_PENDING',
      'PAID',
      'NURSE_PENDING',
      'CANCELLED',
      'REFUND_PENDING',
    ]);
    expect(await BookingReservation.countDocuments({ bookingId: id })).toBe(0);
  });

  it('works from every paid, unstarted state (NURSE_PENDING, CONFIRMED)', async () => {
    const pending = await paidBooking(100);
    expect((await post(patient, `/bookings/${pending}/cancel`)).body.data.status).toBe(
      'REFUND_PENDING',
    );
    const confirmed = await paidBooking(100, patient, args('14:00', '18:00'));
    await post(nurse.session, `/bookings/${confirmed}/accept`);
    expect(await statusOf(confirmed)).toBe('CONFIRMED');
    const r = await post(patient, `/bookings/${confirmed}/cancel`);
    expect(r.body.data.status).toBe('REFUND_PENDING');
    expect(r.body.data.refund.amountMinor).toBe(16000);
  });

  it('24-48h -> 50% refund; the nurse compensation and platform share are recorded and reconcile', async () => {
    const id = await paidBooking(30);
    const r = await post(patient, `/bookings/${id}/cancel`);
    expect(r.body.data.status).toBe('REFUND_PENDING');
    expect(r.body.data.refund).toMatchObject({ percent: 50, amountMinor: 8000 });
    const doc = (await Booking.findById(id).lean())!;
    expect(doc.cancellationOutcome).toMatchObject({
      refundPercent: 50,
      refundMinor: 8000,
      nurseCompensationMinor: 6800,
      platformKeptMinor: 1200,
      tierMinHours: 24,
    });
    const o = doc.cancellationOutcome!;
    expect(o.refundMinor + o.nurseCompensationMinor + o.platformKeptMinor).toBe(
      doc.pricingSnapshot.patientPayableMinor,
    );
  });

  it('under 24h -> 0% refund: stays CANCELLED, no refund pending, nurse keeps the earnings', async () => {
    const id = await paidBooking(10);
    const r = await post(patient, `/bookings/${id}/cancel`);
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('CANCELLED');
    expect(r.body.data.refund).toMatchObject({ status: 'NONE', amountMinor: 0, percent: 0 });
    const doc = (await Booking.findById(id).lean())!;
    expect(doc.cancellationOutcome).toMatchObject({
      refundMinor: 0,
      nurseCompensationMinor: 13600,
      platformKeptMinor: 2400,
    });
    expect(await states(id)).not.toContain('REFUND_PENDING');
    expect(await BookingReservation.countDocuments({ bookingId: id })).toBe(0);
    // the financial outcome is clearly visible to the nurse too
    const nurseView = (await get(nurse.session, `/bookings/${id}`)).body.data;
    expect(nurseView.cancellation).toEqual({ nurseCompensationMinor: 13600 });
  });

  it('uses the policy SNAPSHOTTED on the booking, not the current setting', async () => {
    const id = await paidBooking(100); // snapshot: default tiers
    const strict = [{ minHoursBeforeStart: 0, refundPercent: 0, nurseCompensationPercent: 100 }];
    expect((await put(admin, '/admin/settings/refund.policy', { value: strict })).status).toBe(200);
    const r = await post(patient, `/bookings/${id}/cancel`);
    expect(r.body.data.refund).toMatchObject({ percent: 100, amountMinor: 16000 }); // old policy still applies

    // a booking created AFTER the change snapshots the new policy
    const id2 = await paidBooking(undefined, patient2, args('14:00', '18:00'));
    const doc = (await Booking.findById(id2).lean())!;
    expect(doc.refundPolicySnapshot!.tiers).toHaveLength(1);
    const r2 = await post(patient2, `/bookings/${id2}/cancel`);
    expect(r2.body.data.status).toBe('CANCELLED'); // 0% under the new snapshot
  });

  it('is rejected for bookings that are underway, finished, or already cancelled/refunded', async () => {
    const started = await paidBooking();
    await Booking.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(started) },
      { $set: { status: 'CARE_IN_PROGRESS' } },
    );
    const done = await paidBooking(undefined, patient, args('14:00', '16:00'));
    await Booking.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(done) },
      { $set: { status: 'COMPLETED' } },
    );
    for (const id of [started, done]) {
      const r = await post(patient, `/bookings/${id}/cancel`);
      expect(r.status).toBe(409);
      expect(r.body.errorCode).toBe('CANCELLATION_NOT_ALLOWED');
    }
    const c = await paidBooking(undefined, patient, args('17:00', '19:00'));
    await post(patient, `/bookings/${c}/cancel`);
    expect((await post(patient, `/bookings/${c}/cancel`)).status).toBe(409); // already cancelled (REFUND_PENDING)
    await BookingService.completeRefund(c);
    const again = await post(patient, `/bookings/${c}/cancel`);
    expect(again.status).toBe(409); // already refunded
    expect(await statusOf(c)).toBe('REFUNDED');
  });

  it('two simultaneous cancellations: exactly one succeeds and only one refund obligation exists', async () => {
    const id = await paidBooking(100);
    const res = await Promise.all([
      post(patient, `/bookings/${id}/cancel`),
      post(patient, `/bookings/${id}/cancel`),
    ]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await states(id)).filter((s) => s === 'CANCELLED')).toHaveLength(1);
    expect((await states(id)).filter((s) => s === 'REFUND_PENDING')).toHaveLength(1);
  });

  it('is limited to the booking owner: other patients, nurses and anonymous callers cannot cancel', async () => {
    const id = await paidBooking(100);
    expect((await post(patient2, `/bookings/${id}/cancel`)).status).toBe(404);
    expect((await post(nurse.session, `/bookings/${id}/cancel`)).status).toBe(403);
    expect((await request(app).post(`${API}/bookings/${id}/cancel`).send({})).status).toBe(401);
    expect(await statusOf(id)).toBe('NURSE_PENDING');
  });

  it('unpaid cancellation keeps working: no refund fields', async () => {
    const { booking } = await bookIt(app, patient, args());
    const r = await post(patient, `/bookings/${booking.body.data.id}/cancel`);
    expect(r.body.data.status).toBe('CANCELLED');
    expect(r.body.data.refund).toBeNull();
  });
});

describe('admin privileged cancellation', () => {
  it('can cancel with a refund-percent override; audit-logged with actor, reason and outcome', async () => {
    const id = await paidBooking(100);
    const r = await post(admin, `/admin/bookings/${id}/cancel`, {
      reason: 'nurse emergency',
      refundPercent: 75,
    });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('REFUND_PENDING');
    expect(r.body.data.refund).toMatchObject({
      reason: 'ADMIN_CANCELLATION',
      percent: 75,
      amountMinor: 12000,
    });
    const log = await AuditLog.findOne({ action: 'booking.cancelled_by_admin' }).lean();
    expect(log).toMatchObject({ actorRole: 'ADMIN', entity: 'Booking' });
    expect(String(log!.actorId)).toBe(admin.id);
    expect(log!.newData).toMatchObject({
      status: 'REFUND_PENDING',
      reason: 'nurse emergency',
      refundPercentOverride: 75,
    });
    const hist = await BookingHistory.findOne({ bookingId: id, newState: 'CANCELLED' }).lean();
    expect(hist).toMatchObject({ actorRole: 'ADMIN', reason: 'nurse emergency' });
  });

  it('without an override the booking policy tier applies', async () => {
    const id = await paidBooking(30);
    const r = await post(admin, `/admin/bookings/${id}/cancel`, { reason: 'ops decision' });
    expect(r.body.data.refund).toMatchObject({ percent: 50 });
  });

  it('can cancel unpaid holds, but not started/finished bookings', async () => {
    const { booking } = await bookIt(app, patient, args());
    expect(
      (await post(admin, `/admin/bookings/${booking.body.data.id}/cancel`, { reason: 'duplicate' }))
        .body.data.status,
    ).toBe('CANCELLED');
    const id = await paidBooking(undefined, patient, args('14:00', '18:00'));
    await Booking.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set: { status: 'CARE_IN_PROGRESS' } },
    );
    expect(
      (await post(admin, `/admin/bookings/${id}/cancel`, { reason: 'too late now' })).status,
    ).toBe(409);
  });

  it('requires a reason, a valid percent and the admin role', async () => {
    const id = await paidBooking(100);
    expect((await post(admin, `/admin/bookings/${id}/cancel`, {})).status).toBe(400);
    expect(
      (
        await post(admin, `/admin/bookings/${id}/cancel`, {
          reason: 'valid reason',
          refundPercent: 150,
        })
      ).status,
    ).toBe(400);
    for (const who of [patient, nurse.session]) {
      expect(
        (await post(who, `/admin/bookings/${id}/cancel`, { reason: 'valid reason' })).status,
      ).toBe(403);
    }
    expect(await statusOf(id)).toBe('NURSE_PENDING');
    expect(await AuditLog.countDocuments({ action: 'booking.cancelled_by_admin' })).toBe(0);
  });
});

describe('nurse rejection of a paid booking', () => {
  it('NURSE_REJECTED -> REFUND_PENDING with a 100% refund', async () => {
    const id = await paidBooking(10); // even when close to the start: nurse-caused => 100%
    const r = await post(nurse.session, `/bookings/${id}/reject`, { reason: 'ill' });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('REFUND_PENDING');
    const doc = (await Booking.findById(id).lean())!;
    expect(doc.refund).toMatchObject({
      status: 'PENDING',
      reason: 'NURSE_REJECTED',
      percent: 100,
      amountMinor: 16000,
    });
    expect(await states(id)).toEqual([
      'PENDING',
      'PAYMENT_PENDING',
      'PAID',
      'NURSE_PENDING',
      'NURSE_REJECTED',
      'REFUND_PENDING',
    ]);
    expect(await BookingReservation.countDocuments({ bookingId: id })).toBe(0);
  });

  it('duplicate rejection is refused and creates no second refund obligation', async () => {
    const id = await paidBooking(100);
    expect((await post(nurse.session, `/bookings/${id}/reject`)).status).toBe(200);
    const again = await post(nurse.session, `/bookings/${id}/reject`);
    expect(again.status).toBe(422);
    expect(again.body.errorCode).toBe('INVALID_BOOKING_STATE');
    expect((await states(id)).filter((s) => s === 'REFUND_PENDING')).toHaveLength(1);
  });

  it('simultaneous duplicate rejections: exactly one wins', async () => {
    const id = await paidBooking(100);
    const res = await Promise.all([
      post(nurse.session, `/bookings/${id}/reject`),
      post(nurse.session, `/bookings/${id}/reject`),
    ]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 422]);
    expect((await states(id)).filter((s) => s === 'NURSE_REJECTED')).toHaveLength(1);
  });

  it('an unpaid hold cannot be rejected (the nurse cannot even see it)', async () => {
    const { booking } = await bookIt(app, patient, args());
    expect((await post(nurse.session, `/bookings/${booking.body.data.id}/reject`)).status).toBe(
      404,
    );
  });
});

describe('nurse response timeout on a paid booking', () => {
  it('EXPIRED -> REFUND_PENDING with a 100% refund', async () => {
    const id = await paidBooking(100);
    const out = await BookingService.expireDue(new Date(Date.now() + 3 * H));
    expect(out.expired).toBe(1);
    const doc = (await Booking.findById(id).lean())!;
    expect(doc.status).toBe('REFUND_PENDING');
    expect(doc.refund).toMatchObject({
      status: 'PENDING',
      reason: 'NURSE_TIMEOUT',
      percent: 100,
      amountMinor: 16000,
    });
    expect(await states(id)).toEqual([
      'PENDING',
      'PAYMENT_PENDING',
      'PAID',
      'NURSE_PENDING',
      'EXPIRED',
      'REFUND_PENDING',
    ]);
  });

  it('duplicate / concurrent timeout processing creates exactly one refund obligation', async () => {
    const id = await paidBooking(100);
    const later = new Date(Date.now() + 3 * H);
    const results = await Promise.all([
      BookingService.expireDue(later),
      BookingService.expireDue(later),
      BookingService.expireDue(later),
    ]);
    expect(results.reduce((n, r) => n + r.expired, 0)).toBe(1);
    expect((await BookingService.expireDue(later)).expired).toBe(0);
    expect((await states(id)).filter((s) => s === 'EXPIRED')).toHaveLength(1);
    expect((await states(id)).filter((s) => s === 'REFUND_PENDING')).toHaveLength(1);
  });

  it('an UNPAID hold that lapses simply expires: nothing to refund', async () => {
    const { booking } = await bookIt(app, patient, args());
    await BookingService.expireDue(new Date(Date.now() + 20 * 60_000));
    const doc = (await Booking.findById(booking.body.data.id).lean())!;
    expect(doc.status).toBe('EXPIRED');
    expect(doc.refund).toBeUndefined();
  });

  it('the nurse response deadline is never later than the scheduled start', async () => {
    const { booking } = await bookIt(app, patient, args());
    const id = booking.body.data.id as string;
    const soon = new Date(Date.now() + 30 * 60_000);
    await timeTravel(id, { startDateTime: soon, endDateTime: new Date(soon.getTime() + 2 * H) });
    await BookingService.markPaid(id);
    const doc = (await Booking.findById(id).lean())!;
    expect(doc.nurseResponseDeadline!.getTime()).toBe(soon.getTime());
  });
});

describe('REFUND_PENDING -> REFUNDED (completion hook for Phase 3) is exactly-once', () => {
  it('completes once; replays are no-ops', async () => {
    const id = await paidBooking(100);
    await post(patient, `/bookings/${id}/cancel`);
    const first = await BookingService.completeRefund(id, { providerRefundId: 're_test_1' });
    expect(first.changed).toBe(true);
    expect(first.booking.status).toBe('REFUNDED');
    const second = await BookingService.completeRefund(id, { providerRefundId: 're_test_1' });
    expect(second.changed).toBe(false);
    const doc = (await Booking.findById(id).lean())!;
    expect(doc.refund).toMatchObject({
      status: 'COMPLETED',
      providerRefundId: 're_test_1',
      amountMinor: 16000,
    });
    expect((await states(id)).filter((s) => s === 'REFUNDED')).toHaveLength(1);
  });

  it('concurrent completion callbacks refund once', async () => {
    const id = await paidBooking(100);
    await post(patient, `/bookings/${id}/cancel`);
    const res = await Promise.all([
      BookingService.completeRefund(id),
      BookingService.completeRefund(id),
      BookingService.completeRefund(id),
    ]);
    expect(res.filter((r) => r.changed)).toHaveLength(1);
    expect((await states(id)).filter((s) => s === 'REFUNDED')).toHaveLength(1);
  });

  it('refuses to refund a booking with no refund pending', async () => {
    const id = await paidBooking(100);
    await expect(BookingService.completeRefund(id)).rejects.toBeInstanceOf(
      InvalidBookingStateError,
    ); // NURSE_PENDING
    const zero = await paidBooking(10, patient, args('14:00', '18:00'));
    await post(patient, `/bookings/${zero}/cancel`); // 0% => CANCELLED, refund NONE
    await expect(BookingService.completeRefund(zero)).rejects.toBeInstanceOf(
      InvalidBookingStateError,
    );
    expect(await statusOf(zero)).toBe('CANCELLED');
  });

  it('reconcileRefundRequests repairs paid terminal bookings that lack a refund obligation (idempotent)', async () => {
    const rejected = await paidBooking(100);
    const expired = await paidBooking(100, patient, args('14:00', '18:00'));
    for (const [id, status] of [
      [rejected, 'NURSE_REJECTED'],
      [expired, 'EXPIRED'],
    ] as const) {
      await Booking.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(id) },
        { $set: { status } },
      );
    }
    expect((await BookingService.reconcileRefundRequests()).requested).toBe(2);
    expect((await BookingService.reconcileRefundRequests()).requested).toBe(0);
    expect((await Booking.findById(rejected))!.refund).toMatchObject({
      reason: 'NURSE_REJECTED',
      percent: 100,
    });
    expect((await Booking.findById(expired))!.refund).toMatchObject({
      reason: 'NURSE_TIMEOUT',
      percent: 100,
    });
  });
});

describe('nurse earnings contract for Phase 3 (wallet pending balance)', () => {
  it('pendingEarningFor reads the immutable snapshot, never current prices or commission', async () => {
    const id = await paidBooking(100);
    await request(app)
      .post(`${API}/admin/services/${serviceId}/prices`)
      .set(admin.auth)
      .send({ kind: 'HOURLY', amountMinor: 99000 });
    await put(admin, '/admin/settings/commission.defaultBps', { value: 5000 });
    const b = (await Booking.findById(id))!;
    expect(BookingService.pendingEarningFor(b)).toEqual({
      bookingId: id,
      nurseId: nurse.profileId,
      currency: 'AED',
      amountMinor: 13600, // 16000 gross - 15% commission, frozen at booking time
      idempotencyKey: `wallet:pending-earning:${id}`,
    });
  });
});
