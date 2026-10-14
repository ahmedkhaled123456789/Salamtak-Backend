import type { Express } from 'express';
import mongoose from 'mongoose';
import { withTransaction } from '../../src/config/database';
import { Booking, BookingStateMachine } from '../../src/modules/bookings';
import { WalletService, WalletTransaction } from '../../src/modules/wallets';
import type { MockPaymentProvider } from '../../src/providers/payment';
import { resetState, startApp, stopApp, type Session } from '../helpers/harness';
import { completeBooking, freshProvider, payFully, walletOf } from '../helpers/finance';
import { at, baseWorld, type BookArgs, type Nurse } from '../helpers/world';

let app: Express;
let serviceId: string;
let nurse: Nurse;
let patient: Session;
let D: string;
let mock: MockPaymentProvider;

beforeAll(async () => {
  app = await startApp();
});
afterAll(stopApp);
beforeEach(async () => {
  await resetState();
  mock = freshProvider();
  ({ serviceId, nurse, patient, D } = await baseWorld(app));
});

const args = (): BookArgs => ({
  serviceId,
  nurseId: nurse.profileId,
  start: at(D, '08:00'),
  end: at(D, '12:00'),
});
const later = (hours: number) => new Date(Date.now() + hours * 3_600_000);
const oid = (id: string) => new mongoose.Types.ObjectId(id);
/** Test-only: native write bypasses the state machine to simulate "state changed after the select". */
const forceStatus = (id: string, status: string, extra: object = {}) =>
  Booking.collection.updateOne({ _id: oid(id) }, { $set: { status, ...extra } });
const releaseRows = (id: string) =>
  WalletTransaction.countDocuments({ referenceId: id, type: 'RELEASE' });

async function completed() {
  const r = await payFully(app, mock, patient, args());
  await completeBooking(r.bookingId, nurse, app);
  return r.bookingId;
}

describe('release re-checks eligibility INSIDE the release transaction (P1)', () => {
  it('a normal completed booking is released exactly once after the delay', async () => {
    const id = await completed();
    expect(await WalletService.releaseDue(later(49))).toMatchObject({ released: 1 });
    expect(await walletOf(nurse)).toMatchObject({
      pendingBalanceMinor: 0,
      availableBalanceMinor: 13600,
    });
    // idempotent: a second sweep and a direct call change nothing
    expect(await WalletService.releaseDue(later(49))).toMatchObject({ released: 0 });
    expect(
      await withTransaction((s) => WalletService.releaseBooking(id, later(49), s)),
    ).toMatchObject({ releasedMinor: 0 });
    expect(await releaseRows(id)).toBe(2);
  });

  it.each(['DISPUTED', 'REFUND_PENDING', 'FAILED', 'EXPIRED', 'NURSE_REJECTED', 'CONFIRMED'])(
    'a booking that became %s after it was selected is never released',
    async (status) => {
      const id = await completed();
      // the candidate query would have selected it as COMPLETED; the state changes before the release runs
      await forceStatus(id, status);
      const res = await withTransaction((s) => WalletService.releaseBooking(id, later(49), s));
      expect(res).toEqual({ releasedMinor: 0, blocked: true });
      expect(await walletOf(nurse)).toMatchObject({
        pendingBalanceMinor: 13600,
        availableBalanceMinor: 0,
      });
      expect(await releaseRows(id)).toBe(0);
      expect((await Booking.findById(id))!.earningReleasedAt).toBeUndefined();
    },
  );

  it('does not release before the delay even when called directly', async () => {
    const id = await completed();
    const res = await withTransaction((s) => WalletService.releaseBooking(id, later(1), s));
    expect(res.blocked).toBe(true);
    expect(await releaseRows(id)).toBe(0);
  });

  it('a stale candidate list cannot release a booking that was disputed in between (releaseDue)', async () => {
    const id = await completed();
    const original = WalletService.releaseBooking.bind(WalletService);
    const spy = jest
      .spyOn(WalletService, 'releaseBooking')
      .mockImplementationOnce(async (bid, now, session) => {
        // the dispute lands AFTER the candidate select but BEFORE the release transaction reads the booking
        await forceStatus(bid, 'DISPUTED');
        return original(bid, now, session);
      });
    const res = await WalletService.releaseDue(later(49));
    spy.mockRestore();
    expect(res.released).toBe(0);
    expect(await releaseRows(id)).toBe(0);
    expect((await walletOf(nurse)).availableBalanceMinor).toBe(0);
  });

  it('concurrent release and dispute never produce a half-released or double-released booking', async () => {
    for (let i = 0; i < 4; i++) {
      await resetState();
      mock = freshProvider();
      ({ serviceId, nurse, patient, D } = await baseWorld(app));
      const r = await payFully(app, mock, patient, args());
      await completeBooking(r.bookingId, nurse, app, 100);
      const id = r.bookingId;
      const dispute = withTransaction((session) =>
        BookingStateMachine.transition(
          id,
          'DISPUTED',
          { role: 'ADMIN', userId: String(new mongoose.Types.ObjectId()) },
          { session, reason: 'race' },
        ),
      ).catch((e: Error) => e);
      const release = WalletService.releaseDue(later(0));
      await Promise.all([dispute, release]);
      const b = (await Booking.findById(id))!;
      const rows = await releaseRows(id);
      expect(rows).toBe(b.earningReleasedAt ? 2 : 0); // all-or-nothing, never duplicated
      const w = await walletOf(nurse);
      expect(w.pendingBalanceMinor + w.availableBalanceMinor).toBe(13600);
      expect(w.availableBalanceMinor).toBe(b.earningReleasedAt ? 13600 : 0);
      if (!b.earningReleasedAt) expect(['DISPUTED', 'COMPLETED']).toContain(b.status);
    }
  });
});
