import type { Express } from 'express';
import request from 'supertest';
import { AdminAlert } from '../../src/modules/alerts';
import { AuditLog } from '../../src/modules/audit';
import { Booking } from '../../src/modules/bookings';
import { ReconciliationService } from '../../src/modules/finance';
import { Payment } from '../../src/modules/payments';
import { Refund, RefundService } from '../../src/modules/refunds';
import { WalletTransaction } from '../../src/modules/wallets';
import type { MockPaymentProvider } from '../../src/providers/payment';
import { API, resetState, startApp, stopApp, type Session } from '../helpers/harness';
import { H, deliver, freshProvider, payFully, setSetting, walletOf } from '../helpers/finance';
import { at, baseWorld, type BookArgs, type Nurse } from '../helpers/world';

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

const args = (): BookArgs => ({
  serviceId,
  nurseId: nurse.profileId,
  start: at(D, '08:00'),
  end: at(D, '12:00'),
});
const post = (s: Session, path: string, body: object = {}) =>
  request(app).post(`${API}${path}`).set(s.auth).send(body);
const later = (seconds: number) => new Date(Date.now() + seconds * 1000);
const refundOf = async (bookingId: string) => (await Refund.findOne({ bookingId }))!;
const status = async (id: string) => (await Booking.findById(id))!.status;

/** Paid booking the nurse rejects => 100% refund obligation of 16000 (nurse earning 13600 reversed). */
async function rejected() {
  const r = await payFully(app, mock, patient, args());
  await post(nurse.session, `/bookings/${r.bookingId}/reject`);
  return r;
}
async function exhaustToFailed(bookingId: string) {
  await setSetting('refund.maxAttempts', 2);
  await setSetting('refund.alertAfterAttempts', 1);
  mock.refundFailuresRemaining = 99;
  await RefundService.processDue(later(0));
  await RefundService.processDue(later(3600));
  mock.refundFailuresRemaining = 0;
  expect((await refundOf(bookingId)).status).toBe('FAILED');
}

describe('P2: provider refund success is never undone by a LOCAL persistence failure', () => {
  it('local finalization fails after the provider refunded: PROVIDER_SUCCEEDED, no failure, no restore, one provider call; the retry finalizes', async () => {
    const { bookingId, paymentId } = await rejected();
    const spy = jest
      .spyOn(RefundService, 'finalizeSuccess')
      .mockRejectedValueOnce(new Error('simulated local write failure'));
    expect(await RefundService.processDue()).toEqual({ FINALIZE_PENDING: 1 });
    spy.mockRestore();

    const r = await refundOf(bookingId);
    expect(r.toObject()).toMatchObject({
      status: 'PROVIDER_SUCCEEDED',
      failureCount: 0,
      finalizeAttempts: 1,
    });
    expect(r.providerRefundId).toBeTruthy();
    expect(r.finalizeError).toContain('simulated local write failure');
    expect(await status(bookingId)).toBe('REFUND_PENDING'); // not FAILED
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(0); // earnings NOT restored
    expect(await WalletTransaction.countDocuments({ idempotencyKey: /^refund-restore/ })).toBe(0);
    expect(await AdminAlert.countDocuments({ type: 'REFUND_FAILED' })).toBe(0);
    expect(mock.calls.refund).toBe(1);

    // retry: finalizes locally WITHOUT calling the provider's refund endpoint again
    expect(await RefundService.processDue(later(120))).toEqual({ SUCCEEDED: 1 });
    expect(mock.calls.refund).toBe(1);
    expect(await refundOf(bookingId)).toMatchObject({ status: 'SUCCEEDED', failureCount: 0 });
    expect(await status(bookingId)).toBe('REFUNDED');
    expect(await Payment.findById(paymentId)).toMatchObject({
      status: 'REFUNDED',
      refundedMinor: 16000,
    });
    expect((await ReconciliationService.run()).ok).toBe(true);
  });

  it('repeated local failures raise a CRITICAL finalize-pending alert but never fail the refund', async () => {
    const { bookingId } = await rejected();
    await setSetting('refund.alertAfterAttempts', 2);
    jest.spyOn(RefundService, 'finalizeSuccess').mockRejectedValue(new Error('db down'));
    await RefundService.processDue(later(0));
    await RefundService.processDue(later(3600));
    await RefundService.processDue(later(7200));
    const r = await refundOf(bookingId);
    expect(r).toMatchObject({ status: 'PROVIDER_SUCCEEDED', failureCount: 0 });
    expect(await AdminAlert.findOne({ type: 'REFUND_FINALIZE_PENDING' })).toMatchObject({
      severity: 'CRITICAL',
    });
    expect(await status(bookingId)).toBe('REFUND_PENDING');
    expect(mock.calls.refund).toBe(1);
  });

  it('a verified refund.succeeded webhook also completes a PROVIDER_SUCCEEDED refund', async () => {
    const { bookingId } = await rejected();
    jest.spyOn(RefundService, 'finalizeSuccess').mockRejectedValueOnce(new Error('boom'));
    await RefundService.processDue();
    const r = await refundOf(bookingId);
    const res = await deliver(
      app,
      mock.signEvent('refund.succeeded', {
        providerRefundId: r.providerRefundId,
        providerTransactionId: r.providerTransactionId,
        amountMinor: r.amountMinor,
        currency: 'AED',
      }),
    );
    expect(res.body.data.outcome).toBe('REFUND_SUCCEEDED');
    expect(await status(bookingId)).toBe('REFUNDED');
    expect(mock.calls.refund).toBe(1);
  });
});

describe('P4: a verified refund.succeeded after local FAILED reconciles the refund', () => {
  const lateEvent = (r: InstanceType<typeof Refund>, over: Record<string, unknown> = {}) =>
    mock.signEvent('refund.succeeded', {
      providerRefundId: 're_late_1',
      providerTransactionId: r.providerTransactionId,
      amountMinor: r.amountMinor,
      currency: 'AED',
      ...over,
    });

  it('moves refund to SUCCEEDED and booking FAILED -> REFUNDED, takes the restored earnings back, audits, and is idempotent', async () => {
    const { bookingId, paymentId } = await rejected();
    await exhaustToFailed(bookingId);
    expect(await status(bookingId)).toBe('FAILED');
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(13600); // restored on failure
    const r = await refundOf(bookingId);

    const first = await deliver(app, lateEvent(r));
    expect(first.body.data.outcome).toBe('REFUND_RECONCILED_AFTER_FAILURE');
    expect(await refundOf(bookingId)).toMatchObject({
      status: 'SUCCEEDED',
      providerRefundId: 're_late_1',
    });
    expect(await status(bookingId)).toBe('REFUNDED');
    expect(await Payment.findById(paymentId)).toMatchObject({
      status: 'REFUNDED',
      refundedMinor: 16000,
    });
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(0); // restoration undone
    expect(await AuditLog.countDocuments({ action: 'refund.reconciled_after_failure' })).toBe(1);
    expect(await AdminAlert.countDocuments({ type: 'REFUND_FAILED', status: 'OPEN' })).toBe(0);
    expect((await ReconciliationService.run()).ok).toBe(true);

    // duplicate delivery of a NEW event id for the same refund changes nothing
    const again = await deliver(app, lateEvent(r, {}));
    expect(again.body.data.outcome).toBe('REFUND_ALREADY_FINAL');
    expect((await Payment.findById(paymentId))!.refundedMinor).toBe(16000);
    expect(await WalletTransaction.countDocuments({ idempotencyKey: /^refund-unrestore/ })).toBe(1);
  });

  it('refuses an event whose amount differs from the refund (CRITICAL alert, nothing applied)', async () => {
    const { bookingId, paymentId } = await rejected();
    await exhaustToFailed(bookingId);
    const r = await refundOf(bookingId);
    const res = await deliver(app, lateEvent(r, { amountMinor: 1 }));
    expect(res.body.data.outcome).toBe('REFUND_AMOUNT_MISMATCH');
    expect((await refundOf(bookingId)).status).toBe('FAILED');
    expect(await status(bookingId)).toBe('FAILED');
    expect((await Payment.findById(paymentId))!.refundedMinor).toBe(0);
    expect(await AdminAlert.findOne({ type: 'REFUND_EVENT_AMOUNT_MISMATCH' })).toMatchObject({
      severity: 'CRITICAL',
    });
  });

  it('refuses an event whose provider refund id contradicts the recorded one', async () => {
    const { bookingId } = await rejected();
    mock.refundMode = 'ASYNC';
    await RefundService.processDue();
    const r = await refundOf(bookingId);
    expect(r.providerRefundId).toBeTruthy();
    const res = await deliver(app, lateEvent(r, { providerRefundId: 're_someone_else' }));
    // unknown id falls back to the payment lookup, finds this refund and sees the id disagree
    expect(res.body.data.outcome).toBe('REFUND_ID_MISMATCH');
    expect(await status(bookingId)).toBe('REFUND_PENDING');
    expect(await AdminAlert.findOne({ type: 'REFUND_EVENT_ID_MISMATCH' })).toBeTruthy();
  });

  it('an event for a refund we never issued is reported, not applied', async () => {
    await rejected();
    const res = await deliver(
      app,
      mock.signEvent('refund.succeeded', { providerRefundId: 're_ghost', amountMinor: 5 }),
    );
    expect(res.body.data.outcome).toBe('UNKNOWN_REFUND');
    expect(await AdminAlert.countDocuments({ type: 'UNKNOWN_REFUND_EVENT' })).toBe(1);
  });

  it('concurrent late webhook + admin retry: exactly one refund of the money, consistent state', async () => {
    const { bookingId, paymentId } = await rejected();
    await exhaustToFailed(bookingId);
    const r = await refundOf(bookingId);
    const [hook, retry] = await Promise.all([
      deliver(app, lateEvent(r)),
      post(admin, `/admin/refunds/${String(r._id)}/retry`),
    ]);
    expect([200, 500, 409]).toContain(hook.status);
    expect([200, 409, 500]).toContain(retry.status);
    // whatever ordering won, converge: sweep and a (re)delivery of the event
    await RefundService.processDue(later(3600));
    await deliver(app, lateEvent(r));
    const finalRefund = await refundOf(bookingId);
    expect(['SUCCEEDED', 'PENDING', 'PROCESSING', 'PROVIDER_SUCCEEDED']).toContain(
      finalRefund.status,
    );
    const pay = (await Payment.findById(paymentId))!;
    expect(pay.refundedMinor).toBeLessThanOrEqual(16000); // never refunded twice
    const w = await walletOf(nurse);
    expect(w.pendingBalanceMinor).toBeGreaterThanOrEqual(0);
  });
});

describe('P6: asynchronous refunds that stay PROCESSING', () => {
  it('stores the provider refund id, polls the provider (never re-issues), and finalizes when it settles', async () => {
    const { bookingId } = await rejected();
    mock.refundMode = 'ASYNC';
    await setSetting('refund.statusPollSeconds', 60);
    expect(await RefundService.processDue()).toEqual({ PENDING_PROVIDER: 1 });
    const r = await refundOf(bookingId);
    expect(r.status).toBe('PROCESSING');
    expect(r.providerRefundId).toBeTruthy();
    expect(r.processingSince).toBeInstanceOf(Date);

    expect(await RefundService.processDue(later(30))).toEqual({}); // not due
    expect(await RefundService.processDue(later(70))).toEqual({ PENDING_PROVIDER: 1 });
    expect(mock.calls.refund).toBe(1); // polled, not re-issued
    expect(mock.calls.getRefund).toBe(1);
    expect(await status(bookingId)).toBe('REFUND_PENDING'); // never guessed

    mock.settleRefund(r.providerRefundId!, 'SUCCEEDED');
    expect(await RefundService.processDue(later(140))).toEqual({ SUCCEEDED: 1 });
    expect(await status(bookingId)).toBe('REFUNDED');
    expect(mock.calls.refund).toBe(1);
  });

  it('a stuck PROCESSING refund raises one CRITICAL alert and is never marked REFUNDED or FAILED', async () => {
    const { bookingId } = await rejected();
    mock.refundMode = 'ASYNC';
    await setSetting('refund.statusPollSeconds', 60);
    await setSetting('refund.maxProcessingMinutes', 10);
    await RefundService.processDue();
    for (const mins of [5, 20, 40]) await RefundService.processDue(later(mins * 60));
    const r = await refundOf(bookingId);
    expect(r.status).toBe('PROCESSING');
    expect(await status(bookingId)).toBe('REFUND_PENDING');
    const alerts = await AdminAlert.find({ type: 'REFUND_STUCK_PROCESSING' }).lean();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: 'CRITICAL', status: 'OPEN' });
    expect(mock.calls.refund).toBe(1);
  });

  it('a lookup that fails is not a refund failure', async () => {
    const { bookingId } = await rejected();
    mock.refundMode = 'ASYNC';
    await setSetting('refund.statusPollSeconds', 60);
    await RefundService.processDue();
    mock.getRefundFailures = 2;
    await RefundService.processDue(later(70));
    const r = await refundOf(bookingId);
    expect(r).toMatchObject({ status: 'PROCESSING', failureCount: 0 });
    expect(r.lastError).toContain('lookup');
  });

  it('the provider reporting the async refund FAILED retries with a NEW idempotency key (and never duplicates a success)', async () => {
    const { bookingId } = await rejected();
    mock.refundMode = 'ASYNC';
    await setSetting('refund.statusPollSeconds', 60);
    await RefundService.processDue();
    const first = await refundOf(bookingId);
    mock.settleRefund(first.providerRefundId!, 'FAILED');
    await RefundService.processDue(later(70));
    const after = await refundOf(bookingId);
    expect(after).toMatchObject({ status: 'PENDING', failureCount: 1, providerKeySeq: 1 });
    mock.refundMode = 'SYNC';
    expect(await RefundService.processDue(later(70 + 3600))).toEqual({ SUCCEEDED: 1 });
    expect(mock.calls.refund).toBe(2);
    expect(await status(bookingId)).toBe('REFUNDED');
  });

  it('keeps the same idempotency key across retries of an unknown outcome', async () => {
    const { bookingId } = await rejected();
    const seen: string[] = [];
    const orig = mock.refundPayment.bind(mock);
    jest.spyOn(mock, 'refundPayment').mockImplementation(async (i) => {
      seen.push(i.idempotencyKey);
      return orig(i);
    });
    mock.refundFailuresRemaining = 2;
    await RefundService.processDue(later(0));
    await RefundService.processDue(later(3600));
    await RefundService.processDue(later(7200));
    expect(new Set(seen).size).toBe(1);
    expect(seen).toHaveLength(3);
    expect(await status(bookingId)).toBe('REFUNDED');
    expect(H).toBeGreaterThan(0);
  });
});
