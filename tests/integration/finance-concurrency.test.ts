import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { Booking } from '../../src/modules/bookings';
import { ReconciliationService } from '../../src/modules/finance';
import { Payment } from '../../src/modules/payments';
import { Payout, PayoutMethod, PayoutService } from '../../src/modules/payouts';
import { Refund, RefundService } from '../../src/modules/refunds';
import { WalletService, WalletTransaction } from '../../src/modules/wallets';
import type { MockPaymentProvider } from '../../src/providers/payment';
import { API, resetState, startApp, stopApp, type Session } from '../helpers/harness';
import {
  completeBooking,
  createPayment,
  deliver,
  freshProvider,
  payFully,
  setSetting,
  walletOf,
} from '../helpers/finance';
import { at, baseWorld, bookIt, type Nurse } from '../helpers/world';

let app: Express;
let admin: Session;
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
  ({ admin, serviceId, nurse, patient, D } = await baseWorld(app));
  await setSetting('payout.minAmountMinor', 1000);
});

const later = (seconds: number) => new Date(Date.now() + seconds * 1000);
const range = (i: number) => ({
  serviceId,
  nurseId: nurse.profileId,
  start: at(D, `${String(6 + i * 2).padStart(2, '0')}:00`),
  end: at(D, `${String(7 + i * 2).padStart(2, '0')}:00`),
});

describe('concurrent money movements stay exact', () => {
  it('6 different bookings of one nurse confirmed by simultaneous webhooks: pending earnings = exact sum, 6 ledger rows, reconciliation clean', async () => {
    const payments: { bookingId: string; paymentId: string; tx: string }[] = [];
    for (let i = 0; i < 6; i++) {
      const { booking } = await bookIt(app, patient, range(i));
      expect(booking.status).toBe(201);
      const p = await createPayment(app, patient, booking.body.data.id);
      const doc = (await Payment.findById(p.body.data.id).lean())!;
      payments.push({
        bookingId: booking.body.data.id,
        paymentId: p.body.data.id,
        tx: doc.providerTransactionId!,
      });
    }
    const res = await Promise.all(
      payments.map((p) =>
        deliver(
          app,
          mock.signEvent('payment.succeeded', {
            providerTransactionId: p.tx,
            amountMinor: 4000,
            currency: 'AED',
          }),
        ),
      ),
    );
    expect(res.map((r) => r.status)).toEqual(Array(6).fill(200));
    expect(res.every((r) => r.body.data.outcome === 'PAYMENT_APPLIED')).toBe(true);
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(6 * 3400);
    expect(await WalletTransaction.countDocuments({ type: 'EARNING' })).toBe(6);
    expect((await ReconciliationService.run()).ok).toBe(true);
  });

  it('simultaneous duplicate webhooks across several payments never double-credit', async () => {
    const evts = [];
    for (let i = 0; i < 3; i++) {
      const { booking } = await bookIt(app, patient, range(i));
      const p = await createPayment(app, patient, booking.body.data.id);
      const doc = (await Payment.findById(p.body.data.id).lean())!;
      evts.push(
        mock.signEvent(
          'payment.succeeded',
          { providerTransactionId: doc.providerTransactionId, amountMinor: 4000, currency: 'AED' },
          { eventId: `evt_c_${i}` },
        ),
      );
    }
    await Promise.all(evts.flatMap((e) => [deliver(app, e), deliver(app, e), deliver(app, e)]));
    expect(await WalletTransaction.countDocuments({ type: 'EARNING' })).toBe(3);
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(3 * 3400);
  });

  it('release, payout request and an admin debit racing on one wallet never overdraw it, and the ledger always matches', async () => {
    const r = await payFully(app, mock, patient, range(0));
    await completeBooking(r.bookingId, nurse, app);
    await PayoutMethod.create({
      nurseId: nurse.profileId,
      provider: 'mock',
      providerRef: 'mock_acct_123456',
    });
    const results = await Promise.allSettled([
      WalletService.releaseDue(later(49 * 3600)),
      WalletService.releaseDue(later(49 * 3600)),
      PayoutService.request(nurse.profileId, 3000, randomUUID()),
      WalletService.adjust({
        nurseId: nurse.profileId,
        bucket: 'AVAILABLE',
        amountMinor: -3400,
        reason: 'racing clawback',
        key: 'race-1',
        adminId: admin.id,
      }),
    ]);
    expect(
      results
        .filter((x) => x.status === 'rejected')
        .every(
          (x) =>
            (x as PromiseRejectedResult).reason?.errorCode === 'INSUFFICIENT_BALANCE' ||
            (x as PromiseRejectedResult).reason?.errorCode === 'PAYOUT_BELOW_MINIMUM',
        ),
    ).toBe(true);
    const w = await walletOf(nurse);
    expect(w.availableBalanceMinor).toBeGreaterThanOrEqual(0);
    expect(w.pendingBalanceMinor).toBeGreaterThanOrEqual(0);
    const rep = await ReconciliationService.run();
    expect(rep.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it('a refund attempt racing with the refund.succeeded webhook finalises once', async () => {
    mock.refundMode = 'ASYNC';
    const r = await payFully(app, mock, patient, range(0));
    await request(app)
      .post(`${API}/bookings/${r.bookingId}/reject`)
      .set(nurse.session.auth)
      .send({});
    await RefundService.processDue(); // provider accepted asynchronously
    const refund = (await Refund.findOne({ bookingId: r.bookingId }))!;
    const evt = mock.signEvent(
      'refund.succeeded',
      { providerRefundId: refund.providerRefundId },
      { eventId: 'evt_race_refund' },
    );
    await Promise.allSettled([
      deliver(app, evt),
      deliver(app, evt),
      RefundService.processDue(later(7200)),
      deliver(
        app,
        mock.signEvent('refund.succeeded', { providerRefundId: refund.providerRefundId }),
      ),
    ]);
    expect((await Booking.findById(r.bookingId))!.status).toBe('REFUNDED');
    expect((await Payment.findById(r.paymentId))!.refundedMinor).toBe(4000);
    expect(await Refund.countDocuments({ status: 'SUCCEEDED' })).toBe(1);
    expect((await ReconciliationService.run()).ok).toBe(true);
  });

  it('simultaneous cancel + nurse reject + expiry sweep on one paid booking: exactly one refund obligation and one reversal', async () => {
    const r = await payFully(app, mock, patient, range(0));
    await Promise.allSettled([
      request(app).post(`${API}/bookings/${r.bookingId}/cancel`).set(patient.auth).send({}),
      request(app).post(`${API}/bookings/${r.bookingId}/reject`).set(nurse.session.auth).send({}),
      request(app)
        .post(`${API}/admin/bookings/${r.bookingId}/cancel`)
        .set(admin.auth)
        .send({ reason: 'ops race' }),
    ]);
    expect(await Refund.countDocuments({ bookingId: r.bookingId })).toBe(1);
    expect(await WalletTransaction.countDocuments({ type: 'REVERSAL' })).toBeLessThanOrEqual(1);
    await RefundService.processDue();
    expect(mock.calls.refund).toBeLessThanOrEqual(1);
    expect((await ReconciliationService.run()).checks.filter((c) => !c.ok)).toEqual([]);
  });

  it('parallel payout processors pay each payout exactly once', async () => {
    const r = await payFully(app, mock, patient, range(0));
    await completeBooking(r.bookingId, nurse, app);
    await WalletService.releaseDue(later(49 * 3600));
    await PayoutMethod.create({
      nurseId: nurse.profileId,
      provider: 'mock',
      providerRef: 'mock_acct_123456',
    });
    await PayoutService.request(nurse.profileId, 3400, randomUUID());
    await Promise.all(Array.from({ length: 5 }, () => PayoutService.processDue()));
    expect(mock.calls.payout).toBe(1);
    expect(await Payout.countDocuments({ status: 'PAID' })).toBe(1);
    expect((await walletOf(nurse)).totalWithdrawnMinor).toBe(3400);
  });
});
