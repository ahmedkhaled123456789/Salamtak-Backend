import type { Express } from 'express';
import request from 'supertest';
import { AdminAlert } from '../../src/modules/alerts';
import { Booking, BookingHistory, BookingService } from '../../src/modules/bookings';
import { Payment } from '../../src/modules/payments';
import { Refund, RefundService, backoffSeconds, sanitizeError } from '../../src/modules/refunds';
import { WalletService, WalletTransaction } from '../../src/modules/wallets';
import type { MockPaymentProvider } from '../../src/providers/payment';
import { withTransaction } from '../../src/config/database';
import { API, resetState, startApp, stopApp, type Session } from '../helpers/harness';
import {
  H,
  completeBooking,
  deliver,
  freshProvider,
  payFully,
  setSetting,
  walletOf,
} from '../helpers/finance';
import { at, baseWorld, timeTravel, type BookArgs, type Nurse } from '../helpers/world';

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
});
afterEach(() => jest.restoreAllMocks());

const args = (s = '08:00', e = '12:00'): BookArgs => ({
  serviceId,
  nurseId: nurse.profileId,
  start: at(D, s),
  end: at(D, e),
});
const post = (s: Session, path: string, body: object = {}) =>
  request(app).post(`${API}${path}`).set(s.auth).send(body);
const get = (s: Session, path: string) => request(app).get(`${API}${path}`).set(s.auth);
const later = (seconds: number) => new Date(Date.now() + seconds * 1000);
const statusOf = async (id: string) => (await Booking.findById(id))!.status;
const states = async (id: string) =>
  (await BookingHistory.find({ bookingId: id }).sort({ createdAt: 1, _id: 1 }).lean()).map(
    (h) => h.newState,
  );
const refundOf = async (bookingId: string) => (await Refund.findOne({ bookingId }))!;

async function paidBooking(hoursBeforeStart?: number, a = args()) {
  const r = await payFully(app, mock, patient, a);
  if (hoursBeforeStart !== undefined) {
    const start = Date.now() + hoursBeforeStart * H;
    await timeTravel(r.bookingId, {
      startDateTime: new Date(start),
      endDateTime: new Date(start + 4 * H),
    });
  }
  return r;
}
async function rejected() {
  const r = await paidBooking(100);
  await post(nurse.session, `/bookings/${r.bookingId}/reject`);
  return r;
}

describe('refund tiers end to end (cancellation snapshot -> provider -> REFUNDED)', () => {
  it('100%: obligation created with the cancellation; the provider is called by the sweep; booking, payment and refund end REFUNDED/SUCCEEDED', async () => {
    const { bookingId, paymentId } = await paidBooking(100);
    const c = await post(patient, `/bookings/${bookingId}/cancel`);
    expect(c.body.data.status).toBe('REFUND_PENDING');
    const pending = await refundOf(bookingId);
    expect(pending).toMatchObject({
      status: 'PENDING',
      amountMinor: 16000,
      percent: 100,
      type: 'FULL',
      reason: 'PATIENT_CANCELLATION',
      attempts: 0,
    });
    expect(mock.calls.refund).toBe(0); // nothing is sent inside the cancellation request

    expect(await RefundService.processDue()).toEqual({ SUCCEEDED: 1 });
    expect(await statusOf(bookingId)).toBe('REFUNDED');
    expect(await states(bookingId)).toEqual([
      'PENDING',
      'PAYMENT_PENDING',
      'PAID',
      'NURSE_PENDING',
      'CANCELLED',
      'REFUND_PENDING',
      'REFUNDED',
    ]);
    expect(await Payment.findById(paymentId)).toMatchObject({
      status: 'REFUNDED',
      refundedMinor: 16000,
    });
    const done = await refundOf(bookingId);
    expect(done).toMatchObject({ status: 'SUCCEEDED', attempts: 1 });
    expect(done.providerRefundId).toMatch(/^mock_re_/);
    expect((await Booking.findById(bookingId))!.refund).toMatchObject({
      status: 'COMPLETED',
      providerRefundId: done.providerRefundId,
    });
    expect(mock.calls.refund).toBe(1);
  });

  it('50%: the patient gets 8000 back; the retained 8000 is split by the booking snapshot (85/15); payment is PARTIALLY_REFUNDED', async () => {
    const { bookingId, paymentId } = await paidBooking(30);
    await post(patient, `/bookings/${bookingId}/cancel`);
    const r = await refundOf(bookingId);
    expect(r).toMatchObject({ amountMinor: 8000, percent: 50, type: 'PARTIAL' });
    await RefundService.processDue();
    expect(await Payment.findById(paymentId)).toMatchObject({
      status: 'PARTIALLY_REFUNDED',
      refundedMinor: 8000,
    });
    expect(await statusOf(bookingId)).toBe('REFUNDED');
    const b = (await Booking.findById(bookingId).lean())!;
    expect(b.cancellationOutcome).toMatchObject({
      refundMinor: 8000,
      nurseCompensationMinor: 6800,
      platformKeptMinor: 1200,
    });
    // patientRefund + nurseShare + platformShare == patientPaid
    const o = b.cancellationOutcome!;
    expect(o.refundMinor + o.nurseCompensationMinor + o.platformKeptMinor).toBe(
      b.pricingSnapshot.patientPayableMinor,
    );
    // the nurse keeps exactly her share in pending, and it becomes releasable 48h after the refund completed
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(6800);
    expect((await WalletService.releaseDue(later(47 * 3600))).released).toBe(0);
    expect((await WalletService.releaseDue(later(49 * 3600))).released).toBe(1);
    expect(await walletOf(nurse)).toMatchObject({
      pendingBalanceMinor: 0,
      availableBalanceMinor: 6800,
      totalEarnedMinor: 6800,
    });
  });

  it('0%: no refund record, no provider call, booking stays CANCELLED, the nurse keeps and later receives her earning', async () => {
    const { bookingId, paymentId } = await paidBooking(10);
    const c = await post(patient, `/bookings/${bookingId}/cancel`);
    expect(c.body.data.status).toBe('CANCELLED');
    expect(await Refund.countDocuments({ bookingId })).toBe(0);
    expect(await RefundService.processDue()).toEqual({});
    expect(mock.calls.refund).toBe(0);
    expect(await Payment.findById(paymentId)).toMatchObject({ status: 'PAID', refundedMinor: 0 });
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(13600);
    expect(await WalletTransaction.countDocuments({ type: 'REVERSAL' })).toBe(0);
    expect((await WalletService.releaseDue(later(49 * 3600))).releasedMinor).toBe(13600);
    expect((await walletOf(nurse)).availableBalanceMinor).toBe(13600);
  });

  it('admin override percent drives the refund and the allocation', async () => {
    const { bookingId } = await paidBooking(100);
    await post(admin, `/admin/bookings/${bookingId}/cancel`, {
      reason: 'ops decision',
      refundPercent: 25,
    });
    expect(await refundOf(bookingId)).toMatchObject({
      amountMinor: 4000,
      percent: 25,
      reason: 'ADMIN_CANCELLATION',
    });
    // retained 12000 -> nurse 10200; pending = 13600 - reversed(3400)
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(10200);
  });

  it('nurse rejection and nurse timeout both refund 100% through the provider', async () => {
    const a = await rejected();
    const b = await paidBooking(100, args('14:00', '18:00'));
    expect((await BookingService.expireDue(later(3 * 3600))).expired).toBe(1);
    expect(await RefundService.processDue()).toEqual({ SUCCEEDED: 2 });
    for (const id of [a.bookingId, b.bookingId]) {
      expect(await statusOf(id)).toBe('REFUNDED');
      expect(await refundOf(id)).toMatchObject({
        amountMinor: 16000,
        percent: 100,
        status: 'SUCCEEDED',
      });
    }
    expect((await refundOf(a.bookingId)).reason).toBe('NURSE_REJECTED');
    expect((await refundOf(b.bookingId)).reason).toBe('NURSE_TIMEOUT');
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(0);
  });
});

describe('provider failure: retryable, never REFUNDED, obligation preserved', () => {
  it('a failed attempt keeps the booking REFUND_PENDING and the refund retryable with the error recorded', async () => {
    const { bookingId, paymentId } = await rejected();
    mock.refundFailuresRemaining = 1;
    expect(await RefundService.processDue()).toEqual({ RETRY: 1 });
    const r = await refundOf(bookingId);
    expect(r).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      failureCount: 1,
      amountMinor: 16000,
      reason: 'NURSE_REJECTED',
    });
    expect(r.lastError).toContain('mock provider refund failure');
    expect(r.lastErrorAt).toBeInstanceOf(Date);
    expect(r.nextRetryAt!.getTime()).toBeGreaterThan(Date.now() + 50_000);
    expect(await statusOf(bookingId)).toBe('REFUND_PENDING'); // the customer has NOT been refunded
    expect(await Payment.findById(paymentId)).toMatchObject({ status: 'PAID', refundedMinor: 0 });
    expect((await Booking.findById(bookingId))!.refund).toMatchObject({ status: 'PENDING' });
  });

  it('is not retried before nextRetryAt; the retry then succeeds with the original amount/reason and 2 attempts', async () => {
    const { bookingId, paymentId } = await rejected();
    mock.refundFailuresRemaining = 1;
    await RefundService.processDue();
    expect(await RefundService.processDue()).toEqual({}); // not due yet
    expect(await RefundService.processDue(later(61))).toEqual({ SUCCEEDED: 1 });
    expect(await refundOf(bookingId)).toMatchObject({
      status: 'SUCCEEDED',
      attempts: 2,
      failureCount: 1,
      amountMinor: 16000,
      reason: 'NURSE_REJECTED',
    });
    expect(await statusOf(bookingId)).toBe('REFUNDED');
    expect(await Payment.findById(paymentId)).toMatchObject({
      status: 'REFUNDED',
      refundedMinor: 16000,
    });
    expect(await WalletTransaction.find({ type: 'REVERSAL' }).lean()).toHaveLength(1); // reversal untouched by retries
  });

  it('retries back off exponentially (60s, 120s, 240s ...) capped', async () => {
    const { bookingId } = await rejected();
    mock.refundFailuresRemaining = 3;
    const gaps: number[] = [];
    let now = new Date();
    for (let i = 0; i < 3; i++) {
      await RefundService.processDue(now);
      const r = await refundOf(bookingId);
      gaps.push(Math.round((r.nextRetryAt!.getTime() - now.getTime()) / 1000));
      now = new Date(r.nextRetryAt!.getTime() + 1000);
    }
    expect(gaps).toEqual([60, 120, 240]);
    expect([1, 2, 3, 10, 20].map((n) => backoffSeconds(n, 60))).toEqual([
      60, 120, 240, 21600, 21600,
    ]);
  });

  it('raises an admin alert after repeated failures, and goes FAILED (earnings restored) when retries are exhausted', async () => {
    await setSetting('refund.maxAttempts', 4);
    await setSetting('refund.alertAfterAttempts', 2);
    const { bookingId } = await rejected();
    mock.refundFailuresRemaining = 99;
    let now = new Date();
    for (let i = 0; i < 4; i++) {
      await RefundService.processDue(now);
      const r = await refundOf(bookingId);
      if (r.nextRetryAt) now = new Date(r.nextRetryAt.getTime() + 1000);
      if (i === 1)
        expect(
          await AdminAlert.countDocuments({ type: 'REFUND_RETRYING', severity: 'WARNING' }),
        ).toBe(1);
    }
    const r = await refundOf(bookingId);
    expect(r).toMatchObject({
      status: 'FAILED',
      failureCount: 4,
      attempts: 4,
      amountMinor: 16000,
      reason: 'NURSE_REJECTED',
    });
    expect(await statusOf(bookingId)).toBe('FAILED');
    expect((await Booking.findById(bookingId))!.refund).toMatchObject({ status: 'FAILED' });
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(13600); // reversed earnings restored
    expect(await AdminAlert.findOne({ type: 'REFUND_FAILED' })).toMatchObject({
      severity: 'CRITICAL',
      status: 'OPEN',
    });
    expect(await RefundService.processDue(later(10 * 24 * 3600))).toEqual({}); // FAILED is not retried automatically
  });

  it('a non-retryable provider error fails immediately (no pointless retries)', async () => {
    mock.refundFailuresRemaining = 1;
    mock.refundFailRetryable = false;
    const { bookingId } = await rejected();
    expect(await RefundService.processDue()).toEqual({ FAILED: 1 });
    expect(await refundOf(bookingId)).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(await statusOf(bookingId)).toBe('FAILED');
  });

  it('a provider reply of FAILED is never treated as a refund', async () => {
    const { bookingId } = await rejected();
    jest
      .spyOn(mock, 'refundPayment')
      .mockResolvedValueOnce({ providerRefundId: 're_x', status: 'FAILED', raw: {} });
    expect(await RefundService.processDue()).toEqual({ RETRY: 1 });
    expect(await statusOf(bookingId)).toBe('REFUND_PENDING');
  });

  it('admin sees booking, payment, amount, provider, provider refund id, attempts, last error, next retry, created/updated', async () => {
    const { bookingId, paymentId } = await rejected();
    mock.refundFailuresRemaining = 1;
    await RefundService.processDue();
    const res = await get(admin, `/admin/refunds?bookingId=${bookingId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items[0]).toMatchObject({
      bookingId,
      paymentId,
      amountMinor: 16000,
      currency: 'AED',
      provider: 'mock',
      status: 'PENDING',
      attempts: 1,
      failureCount: 1,
      reason: 'NURSE_REJECTED',
      providerRefundId: null,
    });
    const item = res.body.data.items[0];
    expect(item.lastError).toContain('mock provider refund failure');
    for (const k of ['nextRetryAt', 'lastAttemptAt', 'createdAt', 'updatedAt'])
      expect(item[k]).toBeTruthy();
    expect((await get(patient, '/admin/refunds')).status).toBe(403);
    expect((await get(nurse.session, '/admin/refunds')).status).toBe(403);
    expect((await get(admin, '/admin/refunds?status=SUCCEEDED')).body.data.meta.total).toBe(0);
  });

  it('admin can re-open a FAILED refund: obligation PENDING again, booking REFUND_PENDING, earnings reversed again, then it succeeds', async () => {
    mock.refundFailuresRemaining = 1;
    mock.refundFailRetryable = false;
    const { bookingId } = await rejected();
    await RefundService.processDue();
    const failed = await refundOf(bookingId);
    expect(failed.status).toBe('FAILED');
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(13600);

    expect((await post(patient, `/admin/refunds/${failed._id}/retry`)).status).toBe(403);
    const r = await post(admin, `/admin/refunds/${failed._id}/retry`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'PENDING' });
    expect(await statusOf(bookingId)).toBe('REFUND_PENDING');
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(0);
    expect((await post(admin, `/admin/refunds/${failed._id}/retry`)).status).toBe(409); // no longer FAILED

    expect(await RefundService.processDue()).toEqual({ SUCCEEDED: 1 });
    expect(await statusOf(bookingId)).toBe('REFUNDED');
    expect(await Refund.countDocuments({ bookingId })).toBe(1); // same obligation, never a second refund
  });
});

describe('duplicate refunds are impossible', () => {
  it('concurrent attempts: one provider call, one SUCCEEDED, the others skip', async () => {
    const { bookingId } = await rejected();
    const r = await refundOf(bookingId);
    const out = await Promise.all([1, 2, 3, 4].map(() => RefundService.attempt(String(r._id))));
    expect(out.filter((o) => o.outcome === 'SUCCEEDED')).toHaveLength(1);
    expect(out.filter((o) => o.outcome === 'SKIPPED')).toHaveLength(3);
    expect(mock.calls.refund).toBe(1);
    expect(await Refund.countDocuments({ status: 'SUCCEEDED' })).toBe(1);
  });

  it('concurrent sweeps: provider refunds once', async () => {
    await rejected();
    await Promise.all([
      RefundService.processDue(),
      RefundService.processDue(),
      RefundService.processDue(),
    ]);
    expect(mock.calls.refund).toBe(1);
  });

  it('a second refund for the same payment cannot exist (unique active refund per payment)', async () => {
    const { bookingId, paymentId } = await rejected();
    const r = await refundOf(bookingId);
    await expect(
      Refund.create({
        paymentId,
        patientId: r.patientId,
        provider: 'mock',
        providerTransactionId: r.providerTransactionId,
        amountMinor: 100,
        percent: 1,
        type: 'PARTIAL',
        reason: 'ADMIN_RESOLUTION',
        idempotencyKey: 'other-key',
      }),
    ).rejects.toThrow(/E11000/);
    const again = await withTransaction((s) =>
      RefundService.createObligation(
        { bookingId, paymentId, amountMinor: 16000, reason: 'NURSE_REJECTED' },
        s,
      ),
    );
    expect(again.created).toBe(false);
    expect(String(again.refund._id)).toBe(String(r._id));
  });

  it("a crashed worker's stale claim is retried and the provider (idempotent) does not refund twice", async () => {
    const { bookingId } = await rejected();
    const r = await refundOf(bookingId);
    // simulate: provider processed the refund, then the worker died before recording it
    await mock.refundPayment({
      providerTransactionId: r.providerTransactionId,
      amountMinor: r.amountMinor,
      currency: 'AED',
      idempotencyKey: `refund-${String(r._id)}`,
      reason: 'x',
    });
    await Refund.updateOne(
      { _id: r._id },
      { $set: { status: 'PROCESSING', nextRetryAt: new Date(Date.now() - 1000) } },
    );
    expect(await RefundService.processDue()).toEqual({ SUCCEEDED: 1 });
    expect(mock.calls.refund).toBe(1);
    expect(await statusOf(bookingId)).toBe('REFUNDED');
  });

  it('completing the booking refund twice is a no-op (Phase 2.1 hook)', async () => {
    const { bookingId } = await rejected();
    await RefundService.processDue();
    expect((await BookingService.completeRefund(bookingId)).changed).toBe(false);
    expect((await states(bookingId)).filter((s) => s === 'REFUNDED')).toHaveLength(1);
  });
});

describe('asynchronous provider refunds (webhook completes them)', () => {
  it('provider PENDING: refund stays PROCESSING, booking REFUND_PENDING; the signed refund.succeeded webhook finalises exactly once', async () => {
    mock.refundMode = 'ASYNC';
    const { bookingId, paymentId } = await rejected();
    expect(await RefundService.processDue()).toEqual({ PENDING_PROVIDER: 1 });
    const r = await refundOf(bookingId);
    expect(r.status).toBe('PROCESSING');
    expect(r.providerRefundId).toMatch(/^mock_re_/);
    expect(await statusOf(bookingId)).toBe('REFUND_PENDING');

    const evt = mock.signEvent(
      'refund.succeeded',
      { providerRefundId: r.providerRefundId },
      { eventId: 'evt_refund_ok' },
    );
    expect((await deliver(app, evt)).body.data.outcome).toBe('REFUND_SUCCEEDED');
    expect(await statusOf(bookingId)).toBe('REFUNDED');
    expect(await Payment.findById(paymentId)).toMatchObject({
      status: 'REFUNDED',
      refundedMinor: 16000,
    });
    // duplicate + a differently-numbered duplicate: nothing changes
    expect((await deliver(app, evt)).body.data.status).toBe('DUPLICATE');
    const again = await deliver(
      app,
      mock.signEvent('refund.succeeded', { providerRefundId: r.providerRefundId }),
    );
    expect(again.body.data.outcome).toBe('REFUND_ALREADY_FINAL');
    expect((await states(bookingId)).filter((s) => s === 'REFUNDED')).toHaveLength(1);
    expect((await Payment.findById(paymentId))!.refundedMinor).toBe(16000);
  });

  it('a refund.failed webhook is recorded as a failure and the obligation stays retryable', async () => {
    mock.refundMode = 'ASYNC';
    const { bookingId } = await rejected();
    await RefundService.processDue();
    const r = await refundOf(bookingId);
    const out = await deliver(
      app,
      mock.signEvent('refund.failed', {
        providerRefundId: r.providerRefundId,
        failureReason: 'insufficient_funds',
      }),
    );
    expect(out.body.data.outcome).toBe('REFUND_FAILURE_RECORDED');
    expect(await refundOf(bookingId)).toMatchObject({ status: 'PENDING', failureCount: 1 });
    expect(await statusOf(bookingId)).toBe('REFUND_PENDING');
  });
});

describe('secrets and card data are never persisted', () => {
  it('provider errors are sanitised before they are stored', () => {
    const s = sanitizeError(
      'failed with sk_live_ABCDEF123456 for card 4242424242424242 using Bearer abc.def.ghi',
    );
    expect(s).not.toMatch(/sk_live|4242|abc\.def/);
    expect(s).toContain('[redacted]');
  });

  it('stored refund/payment documents contain no client secret, keys or card numbers', async () => {
    mock.refundFailuresRemaining = 1;
    await rejected();
    await RefundService.processDue();
    const dump = JSON.stringify([
      await Refund.find().lean(),
      await Payment.find().lean(),
      await WalletTransaction.find().lean(),
    ]);
    expect(dump).not.toMatch(/_secret_|sk_|whsec|cardNumber|cvv/i);
  });
});

describe('reconciling a completed booking lifecycle', () => {
  it('pay -> complete -> release keeps ledger, wallet and snapshots consistent', async () => {
    const { bookingId } = await paidBooking();
    await completeBooking(bookingId, nurse, app);
    await WalletService.releaseDue(later(49 * 3600));
    const { ReconciliationService } = await import('../../src/modules/finance');
    const rep = await ReconciliationService.run();
    expect(rep.checks.filter((c) => !c.ok)).toEqual([]);
    expect(rep.ok).toBe(true);
    expect(rep.totals).toMatchObject({
      bookingsPaid: 1,
      grossMinor: 16000,
      commissionMinor: 2400,
      nurseEarningMinor: 13600,
    });
  });
});
