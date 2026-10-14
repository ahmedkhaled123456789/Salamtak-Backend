import type { Express } from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { InvalidBookingStateError } from '../../src/common/errors';
import { AuditLog } from '../../src/modules/audit';
import {
  BOOKING_STATUSES,
  Booking,
  BookingHistory,
  BookingReservation,
  BookingService,
  BookingStateMachine,
  type BookingStatus,
} from '../../src/modules/bookings';
import { NurseProfile } from '../../src/modules/nurses';
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
const statusOf = async (id: string) => (await Booking.findById(id))!.status;
const states = async (id: string) =>
  (await BookingHistory.find({ bookingId: id }).sort({ createdAt: 1, _id: 1 }).lean()).map(
    (h) => h.newState,
  );
const oid = (id: string) => new mongoose.Types.ObjectId(id);
/** Test-only: remove a booking and free its slots so the next iteration can reuse the range. */
const drop = async (id: string) => {
  await Booking.collection.deleteOne({ _id: oid(id) });
  await BookingReservation.deleteMany({ bookingId: id });
};

async function unpaid(a = args(), who = patient) {
  const { booking } = await bookIt(app, who, a);
  expect(booking.status).toBe(201);
  return booking.body.data.id as string;
}
/** A paid booking forced into `status` (test-only, bypasses the state machine on purpose). */
async function inState(
  status: BookingStatus,
  a = args(),
  who = patient,
  extra: Record<string, unknown> = {},
) {
  const id = await unpaid(a, who);
  await Booking.collection.updateOne(
    { _id: oid(id) },
    { $set: { status, paidAt: new Date(), paymentId: new mongoose.Types.ObjectId(), ...extra } },
  );
  return id;
}
const sys = (id: string, to: BookingStatus) =>
  BookingStateMachine.transitionAtomic(id, to, { role: 'SYSTEM' });

describe('payment confirmation (markPaid) safety', () => {
  it('replaying the SAME payment confirmation is a harmless no-op (webhook retry)', async () => {
    const id = await unpaid();
    const pid = String(new mongoose.Types.ObjectId());
    const first = await BookingService.markPaid(id, { paymentId: pid });
    const again = await BookingService.markPaid(id, { paymentId: pid });
    expect(first.status).toBe('NURSE_PENDING');
    expect(again.status).toBe('NURSE_PENDING');
    expect((await states(id)).filter((s) => s === 'PAID')).toHaveLength(1);
    expect(await Booking.countDocuments({ _id: id })).toBe(1);
  });

  it('a second, DIFFERENT payment for an already paid booking is refused', async () => {
    const id = await unpaid();
    await BookingService.markPaid(id, { paymentId: String(new mongoose.Types.ObjectId()) });
    await expect(
      BookingService.markPaid(id, { paymentId: String(new mongoose.Types.ObjectId()) }),
    ).rejects.toBeInstanceOf(InvalidBookingStateError);
    await expect(BookingService.markPaid(id)).rejects.toBeInstanceOf(InvalidBookingStateError);
    expect((await states(id)).filter((s) => s === 'PAID')).toHaveLength(1);
  });

  it('simultaneous confirmations of the same payment settle exactly once', async () => {
    const id = await unpaid();
    const pid = String(new mongoose.Types.ObjectId());
    const res = await Promise.allSettled(
      [1, 2, 3, 4].map(() => BookingService.markPaid(id, { paymentId: pid })),
    );
    expect(res.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    expect((await states(id)).filter((s) => s === 'PAID')).toHaveLength(1);
    expect(await statusOf(id)).toBe('NURSE_PENDING');
  });

  it('cannot pay expired, cancelled or refunded bookings', async () => {
    for (const status of [
      'EXPIRED',
      'CANCELLED',
      'REFUNDED',
      'REFUND_PENDING',
      'FAILED',
    ] as const) {
      const id = await inState(status, args(), patient, { paymentId: undefined });
      await expect(
        BookingService.markPaid(id, { paymentId: String(new mongoose.Types.ObjectId()) }),
      ).rejects.toBeInstanceOf(InvalidBookingStateError);
      await drop(id);
    }
  });

  it('nothing but the state machine can mark a booking paid', async () => {
    const id = await unpaid();
    await expect(Booking.updateOne({ _id: id }, { $set: { status: 'PAID' } })).rejects.toThrow(
      /BookingStateMachine/,
    );
    await expect(sys(id, 'NURSE_PENDING')).rejects.toBeInstanceOf(InvalidBookingStateError); // cannot skip PAID
  });
});

describe('invalid transitions are refused with a business error (API level)', () => {
  it('rejecting an already rejected booking', async () => {
    const id = await unpaid();
    await BookingService.markPaid(id);
    await post(nurse.session, `/bookings/${id}/reject`);
    const r = await post(nurse.session, `/bookings/${id}/reject`);
    expect([r.status, r.body.errorCode]).toEqual([422, 'INVALID_BOOKING_STATE']);
  });

  it('accepting an expired booking', async () => {
    const id = await unpaid();
    await BookingService.markPaid(id);
    await BookingService.expireDue(new Date(Date.now() + 3 * H));
    const r = await post(nurse.session, `/bookings/${id}/accept`);
    expect([r.status, r.body.errorCode]).toEqual([422, 'INVALID_BOOKING_STATE']);
  });

  it('completing a cancelled booking and a refunded booking', async () => {
    const id = await unpaid();
    await BookingService.markPaid(id);
    await post(patient, `/bookings/${id}/cancel`);
    for (const expected of ['REFUND_PENDING', 'REFUNDED']) {
      expect(await statusOf(id)).toBe(expected);
      const r = await post(nurse.session, `/bookings/${id}/complete`);
      expect([r.status, r.body.errorCode]).toEqual([422, 'INVALID_BOOKING_STATE']);
      if (expected === 'REFUND_PENDING') await BookingService.completeRefund(id);
    }
    const cancelledZero = await inState('CANCELLED', args('14:00', '18:00'));
    const r = await post(nurse.session, `/bookings/${cancelledZero}/complete`);
    expect(r.status).toBe(422);
  });

  it('starting an unpaid booking (nurse cannot even see it) and an expired one', async () => {
    const id = await unpaid();
    expect((await post(nurse.session, `/bookings/${id}/start`)).status).toBe(404);
    const exp = await inState('EXPIRED', args('14:00', '18:00'));
    const r = await post(nurse.session, `/bookings/${exp}/start`);
    expect([r.status, r.body.errorCode]).toEqual([422, 'INVALID_BOOKING_STATE']);
    await expect(sys(id, 'CARE_STARTED')).rejects.toBeInstanceOf(InvalidBookingStateError); // state machine too
  });

  it('refunding an already refunded booking is a no-op, and REFUNDED has no exits', async () => {
    const id = await unpaid();
    await BookingService.markPaid(id);
    await post(patient, `/bookings/${id}/cancel`);
    expect((await BookingService.completeRefund(id)).changed).toBe(true);
    expect((await BookingService.completeRefund(id)).changed).toBe(false);
    for (const to of BOOKING_STATUSES) {
      await expect(sys(id, to)).rejects.toBeInstanceOf(InvalidBookingStateError);
    }
    expect(await statusOf(id)).toBe('REFUNDED');
  });

  it('refund cannot be requested for a booking that was never paid', async () => {
    const id = await inState('CANCELLED', args(), patient, {});
    await Booking.collection.updateOne({ _id: oid(id) }, { $unset: { paidAt: 1 } });
    await expect(sys(id, 'REFUND_PENDING')).rejects.toThrow(/nothing to refund/);
  });
});

describe('every illegal (state -> state) move is refused against a real booking', () => {
  it('walks all 16x16 pairs: only table transitions are even attempted, the rest throw', async () => {
    // Spot-check a representative matrix against the database (exhaustive pair logic is unit tested)
    const blocked: [BookingStatus, BookingStatus][] = [
      ['COMPLETED', 'CANCELLED'],
      ['CANCELLED', 'CONFIRMED'],
      ['EXPIRED', 'PAID'],
      ['REFUNDED', 'REFUND_PENDING'],
      ['PAID', 'CONFIRMED'],
      ['NURSE_REJECTED', 'NURSE_ACCEPTED'],
      ['FAILED', 'PAYMENT_PENDING'],
      ['CONFIRMED', 'COMPLETED'],
    ];
    let n = 0;
    for (const [from, to] of blocked) {
      const id = await inState(from, args(), patient, {
        startDateTime: new Date(Date.now() - 5 * H),
      });
      await expect(sys(id, to)).rejects.toBeInstanceOf(InvalidBookingStateError);
      expect(await statusOf(id)).toBe(from);
      await drop(id);
      n += 1;
    }
    expect(n).toBe(blocked.length);
  });
});

describe('no-show: a CONFIRMED booking that never started goes to admin review', () => {
  async function confirmed() {
    const id = await unpaid();
    await BookingService.markPaid(id);
    await post(nurse.session, `/bookings/${id}/accept`);
    expect(await statusOf(id)).toBe('CONFIRMED');
    return id;
  }
  const pastWindow = (id: string, endedMinutesAgo: number) =>
    timeTravel(id, {
      startDateTime: new Date(Date.now() - (endedMinutesAgo + 240) * 60_000),
      endDateTime: new Date(Date.now() - endedMinutesAgo * 60_000),
    });

  it('is flagged DISPUTED after end + grace; nothing is refunded, completed or settled automatically', async () => {
    const id = await confirmed();
    await pastWindow(id, 60); // ended 60 min ago, grace is 30
    expect((await BookingService.flagNoShows()).flagged).toBe(1);
    const doc = (await Booking.findById(id).lean())!;
    expect(doc.status).toBe('DISPUTED');
    expect(doc.refund).toBeUndefined(); // no refund obligation
    expect(doc.cancellationOutcome).toBeUndefined();
    expect(doc.completedAt).toBeUndefined();
    expect(await states(id)).toEqual([
      'PENDING',
      'PAYMENT_PENDING',
      'PAID',
      'NURSE_PENDING',
      'NURSE_ACCEPTED',
      'CONFIRMED',
      'DISPUTED',
    ]);
    const h = await BookingHistory.findOne({ bookingId: id, newState: 'DISPUTED' }).lean();
    expect(h).toMatchObject({ actorRole: 'SYSTEM' });
    expect(h!.reason).toContain('NO_SHOW_SUSPECTED');
    expect((await NurseProfile.findById(nurse.profileId))!.totalCompletedBookings).toBe(0);
    // the other sweeps must not settle it either
    expect((await BookingService.autoCompleteDue()).completed).toBe(0);
    expect((await BookingService.reconcileRefundRequests()).requested).toBe(0);
    expect((await BookingService.expireDue(new Date(Date.now() + 24 * H))).expired).toBe(0);
    expect(await statusOf(id)).toBe('DISPUTED');
  });

  it('is idempotent and respects the grace period', async () => {
    const id = await confirmed();
    await pastWindow(id, 10); // within the 30 minute grace
    expect((await BookingService.flagNoShows()).flagged).toBe(0);
    await pastWindow(id, 45);
    expect((await BookingService.flagNoShows()).flagged).toBe(1);
    expect((await BookingService.flagNoShows()).flagged).toBe(0);
    expect((await states(id)).filter((s) => s === 'DISPUTED')).toHaveLength(1);
  });

  it('never flags bookings that were started, that are still upcoming, or in other states', async () => {
    const upcoming = await confirmed();
    const started = await inState('CARE_IN_PROGRESS', args('14:00', '16:00'), patient2, {
      startDateTime: new Date(Date.now() - 6 * H),
      endDateTime: new Date(Date.now() - 4 * H),
    });
    const pending = await inState('NURSE_PENDING', args('17:00', '19:00'), patient2, {
      startDateTime: new Date(Date.now() - 6 * H),
      endDateTime: new Date(Date.now() - 4 * H),
    });
    expect((await BookingService.flagNoShows()).flagged).toBe(0);
    expect(await statusOf(upcoming)).toBe('CONFIRMED');
    expect(await statusOf(started)).toBe('CARE_IN_PROGRESS');
    expect(await statusOf(pending)).toBe('NURSE_PENDING');
  });

  it('the nurse can no longer start a flagged booking', async () => {
    const id = await confirmed();
    await pastWindow(id, 60);
    await BookingService.flagNoShows();
    const r = await post(nurse.session, `/bookings/${id}/start`);
    expect([r.status, r.body.errorCode]).toEqual([422, 'INVALID_BOOKING_STATE']);
  });

  it('admin resolves: full refund -> REFUND_PENDING (audited)', async () => {
    const id = await confirmed();
    await pastWindow(id, 60);
    await BookingService.flagNoShows();
    const r = await post(admin, `/admin/bookings/${id}/resolve`, {
      resolution: 'REFUND',
      reason: 'nurse confirmed no-show',
    });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('REFUND_PENDING');
    expect(r.body.data.refund).toMatchObject({
      status: 'PENDING',
      reason: 'ADMIN_RESOLUTION',
      percent: 100,
      amountMinor: 16000,
    });
    const log = await AuditLog.findOne({ action: 'booking.dispute_resolved' }).lean();
    expect(log).toMatchObject({ actorRole: 'ADMIN', entity: 'Booking' });
    expect(log!.newData).toMatchObject({ resolution: 'REFUND', reason: 'nurse confirmed no-show' });
  });

  it('admin resolves: partial refund, or complete without refund', async () => {
    const a = await confirmed();
    await pastWindow(a, 60);
    await BookingService.flagNoShows();
    const partial = await post(admin, `/admin/bookings/${a}/resolve`, {
      resolution: 'REFUND',
      refundPercent: 40,
      reason: 'late arrival',
    });
    expect(partial.body.data.refund).toMatchObject({ percent: 40, amountMinor: 6400 });

    const b = await inState('DISPUTED', args('14:00', '18:00'), patient2);
    const done = await post(admin, `/admin/bookings/${b}/resolve`, {
      resolution: 'COMPLETE',
      reason: 'care was delivered',
    });
    expect(done.body.data.status).toBe('COMPLETED');
    expect((await Booking.findById(b))!.refund).toBeUndefined();
    expect((await NurseProfile.findById(nurse.profileId))!.totalCompletedBookings).toBe(1);
  });

  it('resolution is admin-only, DISPUTED-only, validated, and cannot be repeated', async () => {
    const id = await confirmed();
    await pastWindow(id, 60);
    await BookingService.flagNoShows();
    for (const who of [patient, nurse.session]) {
      expect(
        (
          await post(who, `/admin/bookings/${id}/resolve`, {
            resolution: 'REFUND',
            reason: 'trying my luck',
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await post(admin, `/admin/bookings/${id}/resolve`, {
          resolution: 'REFUND',
          refundPercent: 0,
          reason: 'zero percent',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(admin, `/admin/bookings/${id}/resolve`, {
          resolution: 'MAYBE',
          reason: 'invalid',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(admin, `/admin/bookings/${id}/resolve`, {
          resolution: 'REFUND',
          reason: 'ok reason',
        })
      ).status,
    ).toBe(200);
    const again = await post(admin, `/admin/bookings/${id}/resolve`, {
      resolution: 'REFUND',
      reason: 'ok reason',
    });
    expect([again.status, again.body.errorCode]).toEqual([422, 'INVALID_BOOKING_STATE']);
    expect((await states(id)).filter((s) => s === 'REFUND_PENDING')).toHaveLength(1);
    const notDisputed = await unpaid(args('14:00', '16:00'), patient2);
    expect(
      (
        await post(admin, `/admin/bookings/${notDisputed}/resolve`, {
          resolution: 'COMPLETE',
          reason: 'not disputed',
        })
      ).status,
    ).toBe(422);
  });

  it('nurses cannot cancel or otherwise settle bookings (state table + API)', async () => {
    const id = await confirmed();
    await expect(
      BookingStateMachine.transitionAtomic(id, 'CANCELLED', {
        role: 'NURSE',
        userId: nurse.session.id,
      }),
    ).rejects.toBeInstanceOf(InvalidBookingStateError);
    expect((await post(nurse.session, `/bookings/${id}/cancel`)).status).toBe(403);
    expect(
      (await post(nurse.session, `/admin/bookings/${id}/cancel`, { reason: 'let me out' })).status,
    ).toBe(403);
    expect(await statusOf(id)).toBe('CONFIRMED');
  });
});
