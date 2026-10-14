import { createHash } from 'node:crypto';
import type { Express } from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { AdminAlert } from '../../src/modules/alerts';
import { Booking, BookingHistory, BookingService } from '../../src/modules/bookings';
import { Payment } from '../../src/modules/payments';
import { Payout, PayoutMethod, PayoutService } from '../../src/modules/payouts';
import { Refund } from '../../src/modules/refunds';
import { SettingsService } from '../../src/modules/settings';
import { WalletService, WalletTransaction } from '../../src/modules/wallets';
import { executeJob, syncSchedules, withJobLock, SCHEDULES } from '../../src/jobs';
import { enqueue, QUEUES } from '../../src/queues';
import type { MockPaymentProvider } from '../../src/providers/payment';
import { API, resetState, startApp, stopApp, type Session } from '../helpers/harness';
import {
  H,
  completeBooking,
  createPayment,
  freshProvider,
  payFully,
  setSetting,
  walletOf,
} from '../helpers/finance';
import { confirmedPastBooking, memoryQueue } from '../helpers/jobs';
import { at, baseWorld, bookIt, timeTravel, type BookArgs, type Nurse } from '../helpers/world';

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
  memoryQueue().jobs.length = 0;
  memoryQueue().schedulers.clear();
  memoryQueue().unavailable = false;
  mock = freshProvider();
  ({ serviceId, nurse, patient, D } = await baseWorld(app));
});
afterEach(() => jest.restoreAllMocks());

const MIN = 60_000;
const args = (s = '08:00', e = '12:00'): BookArgs => ({
  serviceId,
  nurseId: nurse.profileId,
  start: at(D, s),
  end: at(D, e),
});
const run = (name: string, data: Record<string, unknown> = {}, now?: Date) =>
  executeJob(name, data, { now });
const inHours = (h: number) => new Date(Date.now() + h * H);
const oid = (id: string) => new mongoose.Types.ObjectId(id);
const status = async (id: string) => (await Booking.findById(id))!.status;
const post = (s: Session, path: string, body: object = {}) =>
  request(app).post(`${API}${path}`).set(s.auth).send(body);

async function fingerprint() {
  const h = createHash('sha256');
  for (const c of ['wallets', 'walletTransactions', 'bookings', 'payments', 'refunds', 'payouts']) {
    h.update(
      c + JSON.stringify(await mongoose.connection.collection(c).find().sort({ _id: 1 }).toArray()),
    );
  }
  return h.digest('hex');
}

describe('executor: classification and payload hygiene', () => {
  it('rejects unknown jobs and invalid payloads permanently (never retried)', async () => {
    await expect(run('nope.nothing')).rejects.toMatchObject({ name: 'UnrecoverableError' });
    await expect(run('refund.attempt', { refundId: 'not-an-id' })).rejects.toMatchObject({
      name: 'UnrecoverableError',
    });
    await expect(
      run('refund.attempt', { refundId: '0'.repeat(24), extra: 'x' }),
    ).rejects.toMatchObject({ name: 'UnrecoverableError' });
  });

  it('turns 4xx domain errors into permanent failures but lets infrastructure errors retry', async () => {
    const { AppError } = await import('../../src/common/errors');
    jest
      .spyOn(BookingService, 'expireDue')
      .mockRejectedValueOnce(new AppError(409, 'X', 'conflict'));
    await expect(run('booking.expireDue')).rejects.toMatchObject({ name: 'UnrecoverableError' });
    jest.spyOn(BookingService, 'expireDue').mockRejectedValueOnce(new Error('connection reset'));
    await expect(run('booking.expireDue')).rejects.toThrow('connection reset');
  });
});

describe('booking expiration job', () => {
  it('expires a lapsed hold once; duplicate and concurrent jobs are safe', async () => {
    const { booking } = await bookIt(app, patient, args());
    const id = booking.body.data.id as string;
    await timeTravel(id, { holdExpiresAt: new Date(Date.now() - MIN) });
    const results = await Promise.all([1, 2, 3].map(() => run('booking.expireDue')));
    expect(results.reduce((n, r) => n + (r.expired as number), 0)).toBe(1);
    expect(await status(id)).toBe('EXPIRED');
    expect((await run('booking.expireDue')).expired).toBe(0);
    expect(await BookingHistory.countDocuments({ bookingId: id, newState: 'EXPIRED' })).toBe(1);
  });

  it('leaves live holds alone', async () => {
    const { booking } = await bookIt(app, patient, args());
    expect((await run('booking.expireDue')).expired).toBe(0);
    expect(await status(booking.body.data.id)).toBe('PAYMENT_PENDING');
  });
});

describe('no-show job (existing Phase 2.1 rule: DISPUTED, no settlement)', () => {
  it('flags an eligible booking DISPUTED without any financial effect, exactly once under concurrency', async () => {
    const r = await confirmedPastBooking(app, mock, patient, nurse, args(), 45);
    const before = await walletOf(nurse);
    const results = await Promise.all([1, 2, 3].map(() => run('booking.flagNoShows')));
    expect(results.reduce((n, x) => n + (x.flagged as number), 0)).toBe(1);
    expect(await status(r.bookingId)).toBe('DISPUTED');
    const after = await walletOf(nurse);
    expect(after.pendingBalanceMinor).toBe(before.pendingBalanceMinor);
    expect(after.availableBalanceMinor).toBe(before.availableBalanceMinor);
    expect(await Refund.countDocuments()).toBe(0);
    expect((await Booking.findById(r.bookingId))!.earningReleasedAt).toBeUndefined();
    expect(
      await BookingHistory.countDocuments({ bookingId: r.bookingId, newState: 'DISPUTED' }),
    ).toBe(1);
    expect((await run('booking.flagNoShows')).flagged).toBe(0); // duplicate job
  });

  it('does not flag before the grace period has passed', async () => {
    const r = await confirmedPastBooking(app, mock, patient, nurse, args(), 10);
    expect((await run('booking.flagNoShows')).flagged).toBe(0);
    expect(await status(r.bookingId)).toBe('CONFIRMED');
  });
});

describe('wallet release job (keeps the Phase 3 release-race fix)', () => {
  async function completed() {
    const r = await payFully(app, mock, patient, args());
    await completeBooking(r.bookingId, nurse, app);
    return r.bookingId;
  }

  it('releases eligible earnings once, even with duplicate and concurrent jobs', async () => {
    const id = await completed();
    const rs = await Promise.all([1, 2, 3].map(() => run('wallet.releaseDue', {}, inHours(49))));
    expect(rs.reduce((n, x) => n + (x.released as number), 0)).toBe(1);
    expect(await walletOf(nurse)).toMatchObject({
      availableBalanceMinor: 13600,
      pendingBalanceMinor: 0,
    });
    expect(await WalletTransaction.countDocuments({ referenceId: id, type: 'RELEASE' })).toBe(2);
    expect((await run('wallet.releaseDue', {}, inHours(49))).released).toBe(0);
  });

  it('does not release before the configured delay', async () => {
    await completed();
    expect((await run('wallet.releaseDue', {}, inHours(1))).released).toBe(0);
    await setSetting('wallet.releaseDelayHours', 1);
    expect((await run('wallet.releaseDue', {}, inHours(2))).released).toBe(1);
  });

  it.each(['DISPUTED', 'REFUND_PENDING', 'FAILED'])(
    'never releases a booking that is %s',
    async (st) => {
      const id = await completed();
      await Booking.collection.updateOne({ _id: oid(id) }, { $set: { status: st } });
      const res = await run('wallet.releaseDue', {}, inHours(49));
      expect(res.released).toBe(0);
      expect((await walletOf(nurse)).availableBalanceMinor).toBe(0);
      expect(await WalletTransaction.countDocuments({ type: 'RELEASE' })).toBe(0);
    },
  );
});

describe('refund jobs', () => {
  async function rejected() {
    const r = await payFully(app, mock, patient, args());
    await post(nurse.session, `/bookings/${r.bookingId}/reject`);
    return r;
  }

  it('the sweep enqueues one deterministic job per due refund; repeated sweeps do not duplicate it', async () => {
    const r = await rejected();
    const refund = (await Refund.findOne({ bookingId: r.bookingId }))!;
    const first = await run('refund.sweep');
    expect(first).toMatchObject({ due: 1, enqueued: 1 });
    const again = await run('refund.sweep');
    expect(again).toMatchObject({ due: 1, enqueued: 0 });
    const jobs = memoryQueue().jobs.filter((j) => j.queue === QUEUES.refund);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      name: 'refund.attempt',
      data: { refundId: String(refund._id) },
      jobId: `refund-${String(refund._id)}-${refund.nextRetryAt!.getTime()}`,
    });
    expect(Object.keys(jobs[0]!.data)).toEqual(['refundId']); // ids only, no payment/patient data
  });

  it('processes the refund through the domain service; duplicate and concurrent jobs call the provider once', async () => {
    const r = await rejected();
    const refund = (await Refund.findOne({ bookingId: r.bookingId }))!;
    const outs = await Promise.all(
      [1, 2, 3].map(() => run('refund.attempt', { refundId: String(refund._id) })),
    );
    expect(outs.filter((o) => o.outcome === 'SUCCEEDED')).toHaveLength(1);
    expect(mock.calls.refund).toBe(1);
    expect(await status(r.bookingId)).toBe('REFUNDED');
    expect((await run('refund.attempt', { refundId: String(refund._id) })).outcome).toBe('SKIPPED');
    expect(mock.calls.refund).toBe(1);
    expect(await Payment.findById(r.paymentId)).toMatchObject({
      refundedMinor: 16000,
      status: 'REFUNDED',
    });
  });

  it('a retryable provider failure is rescheduled by the service (not by the queue) and succeeds later', async () => {
    const r = await rejected();
    const refund = (await Refund.findOne({ bookingId: r.bookingId }))!;
    mock.refundFailuresRemaining = 1;
    expect((await run('refund.attempt', { refundId: String(refund._id) })).outcome).toBe('RETRY');
    expect((await run('refund.attempt', { refundId: String(refund._id) })).outcome).toBe('SKIPPED'); // not due yet
    const later = new Date(Date.now() + 120_000);
    expect((await run('refund.attempt', { refundId: String(refund._id) }, later)).outcome).toBe(
      'SUCCEEDED',
    );
    expect(mock.calls.refund).toBe(2);
  });

  it('a local failure after provider success is finalized later WITHOUT a second provider refund', async () => {
    const r = await rejected();
    const refund = (await Refund.findOne({ bookingId: r.bookingId }))!;
    const { RefundService } = await import('../../src/modules/refunds');
    jest.spyOn(RefundService, 'finalizeSuccess').mockRejectedValueOnce(new Error('db blip'));
    expect((await run('refund.attempt', { refundId: String(refund._id) })).outcome).toBe(
      'FINALIZE_PENDING',
    );
    jest.restoreAllMocks();
    const later = new Date(Date.now() + 120_000);
    expect((await run('refund.attempt', { refundId: String(refund._id) }, later)).outcome).toBe(
      'SUCCEEDED',
    );
    expect(mock.calls.refund).toBe(1);
  });

  it('an asynchronous refund is polled by later jobs, never re-issued, and alerts when stuck', async () => {
    const r = await rejected();
    const refund = (await Refund.findOne({ bookingId: r.bookingId }))!;
    mock.refundMode = 'ASYNC';
    await setSetting('refund.statusPollSeconds', 60);
    await setSetting('refund.maxProcessingMinutes', 10);
    expect((await run('refund.attempt', { refundId: String(refund._id) })).outcome).toBe(
      'PENDING_PROVIDER',
    );
    const t = (m: number) => new Date(Date.now() + m * MIN);
    await run('refund.attempt', { refundId: String(refund._id) }, t(5));
    await run('refund.attempt', { refundId: String(refund._id) }, t(30));
    expect(mock.calls.refund).toBe(1);
    expect(
      await AdminAlert.countDocuments({ type: 'REFUND_STUCK_PROCESSING', severity: 'CRITICAL' }),
    ).toBe(1);
    expect(await status(r.bookingId)).toBe('REFUND_PENDING');
  });
});

describe('payout jobs', () => {
  async function pendingPayout() {
    const r = await payFully(app, mock, patient, args());
    await completeBooking(r.bookingId, nurse, app);
    await WalletService.releaseDue(inHours(49));
    await PayoutMethod.create({
      nurseId: nurse.profileId,
      provider: 'mock',
      providerRef: 'mock_acct_123456',
    });
    return PayoutService.request(nurse.profileId, 10_000, 'job-payout-1');
  }

  it('sweep enqueues a deterministic job; concurrent processing pays the provider once and settles once', async () => {
    const p = await pendingPayout();
    expect(await run('payout.sweep')).toMatchObject({ due: 1, enqueued: 1 });
    expect(await run('payout.sweep')).toMatchObject({ due: 1, enqueued: 0 });
    const outs = await Promise.all(
      [1, 2, 3].map(() => run('payout.process', { payoutId: String(p._id) })),
    );
    expect(outs.filter((o) => o.outcome === 'PAID')).toHaveLength(1);
    expect(mock.calls.payout).toBe(1);
    expect(await WalletTransaction.countDocuments({ type: 'PAYOUT_SETTLED' })).toBe(1);
    expect((await walletOf(nurse)).totalWithdrawnMinor).toBe(10_000);
  });

  it('retryable failure, then exhausted retries return the funds exactly once', async () => {
    const p = await pendingPayout();
    await setSetting('payout.maxAttempts', 2);
    mock.payoutFailuresRemaining = 5;
    expect((await run('payout.process', { payoutId: String(p._id) })).outcome).toBe('RETRY');
    const later = new Date(Date.now() + 3_600_000);
    expect((await run('payout.process', { payoutId: String(p._id) }, later)).outcome).toBe(
      'FAILED',
    );
    expect((await run('payout.process', { payoutId: String(p._id) }, later)).outcome).toBe(
      'SKIPPED',
    );
    expect(await WalletTransaction.countDocuments({ type: 'PAYOUT_REVERSAL' })).toBe(1);
    expect((await Payout.findById(p._id))!.status).toBe('FAILED');
    expect(await AdminAlert.countDocuments({ type: 'PAYOUT_FAILED' })).toBe(1);
  });

  it('provider paid + local failure is settled later without paying again', async () => {
    const p = await pendingPayout();
    jest.spyOn(PayoutService, 'finalizePaid').mockRejectedValueOnce(new Error('db blip'));
    expect((await run('payout.process', { payoutId: String(p._id) })).outcome).toBe(
      'FINALIZE_PENDING',
    );
    jest.restoreAllMocks();
    const later = new Date(Date.now() + 3_600_000);
    expect((await run('payout.process', { payoutId: String(p._id) }, later)).outcome).toBe('PAID');
    expect(mock.calls.payout).toBe(1);
    expect(await WalletTransaction.countDocuments({ type: 'PAYOUT_REVERSAL' })).toBe(0);
  });
});

describe('payment polling job (provider lookup is the authority; never "believes" a payment)', () => {
  async function openPayment(ageMinutes = 20) {
    const { booking } = await bookIt(app, patient, args());
    const bookingId = booking.body.data.id as string;
    const pay = await createPayment(app, patient, bookingId);
    const payment = (await Payment.findById(pay.body.data.id))!;
    await Payment.collection.updateOne(
      { _id: payment._id },
      { $set: { createdAt: new Date(Date.now() - ageMinutes * MIN) } },
    );
    return { bookingId, payment };
  }

  it('leaves a payment alone while the provider says it is not paid', async () => {
    const { payment } = await openPayment();
    const res = await run('payment.pollProcessing');
    expect(res).toMatchObject({ checked: 1, applied: 0, unchanged: 1 });
    expect((await Payment.findById(payment._id))!.status).toBe('PENDING');
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(0);
  });

  it('ignores payments younger than the polling age', async () => {
    await openPayment(1);
    expect(await run('payment.pollProcessing')).toMatchObject({ checked: 0 });
  });

  it('applies a provider-confirmed payment through the normal pipeline, exactly once under concurrency', async () => {
    const { bookingId, payment } = await openPayment();
    mock.markPaid(payment.providerTransactionId!);
    const rs = await Promise.all([1, 2, 3].map(() => run('payment.pollProcessing')));
    expect(rs.reduce((n, r) => n + (r.applied as number), 0)).toBe(1);
    expect(await status(bookingId)).toBe('NURSE_PENDING');
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(13600);
    expect(await WalletTransaction.countDocuments({ type: 'EARNING' })).toBe(1);
    expect((await run('payment.pollProcessing')).checked).toBe(0); // already PAID
  });

  it('records a provider-reported failure', async () => {
    const { payment } = await openPayment();
    jest
      .spyOn(mock, 'verifyPayment')
      .mockResolvedValue({ status: 'FAILED', amountMinor: 16000, currency: 'AED' });
    await run('payment.pollProcessing');
    expect((await Payment.findById(payment._id))!.status).toBe('FAILED');
  });

  it('an unrecognised provider status changes nothing and raises a warning', async () => {
    const { payment } = await openPayment();
    jest
      .spyOn(mock, 'verifyPayment')
      .mockResolvedValue({ status: 'WEIRD' as never, amountMinor: 16000, currency: 'AED' });
    expect(await run('payment.pollProcessing')).toMatchObject({ invalid: 1, applied: 0 });
    expect((await Payment.findById(payment._id))!.status).toBe('PENDING');
    expect(await AdminAlert.countDocuments({ type: 'PAYMENT_POLL_INVALID_STATUS' })).toBe(1);
  });

  it('a payment confirmed after the hold expired follows the late-payment rule: refunded, never revived, no earnings', async () => {
    const { bookingId, payment } = await openPayment();
    await timeTravel(bookingId, { holdExpiresAt: new Date(Date.now() - 5 * MIN) });
    await BookingService.expireDue(new Date());
    expect(await status(bookingId)).toBe('EXPIRED');
    mock.markPaid(payment.providerTransactionId!);
    await run('payment.pollProcessing');
    expect(await status(bookingId)).toBe('EXPIRED');
    expect(await WalletTransaction.countDocuments({ type: 'EARNING' })).toBe(0);
    expect(await Refund.findOne({ paymentId: payment._id })).toMatchObject({
      amountMinor: 16000,
      reason: 'BOOKING_EXPIRED_BEFORE_PAYMENT_CONFIRMATION',
    });
  });

  it('a payment unresolved for a long time raises one stale-payment warning', async () => {
    await openPayment(500);
    await run('payment.pollProcessing');
    await run('payment.pollProcessing');
    const alerts = await AdminAlert.find({ type: 'PAYMENT_STALE' }).lean();
    expect(alerts).toHaveLength(1);
  });
});

describe('scheduled reconciliation (read-only, alert-only)', () => {
  it('a healthy system passes and creates no drift alert', async () => {
    await payFully(app, mock, patient, args());
    expect(await run('reconciliation.run')).toMatchObject({ ok: true, failing: [] });
    expect(await AdminAlert.countDocuments({ type: 'RECONCILIATION_DRIFT' })).toBe(0);
  });

  it('drift becomes ONE critical alert (deduplicated), never a silent repair, and resolves when fixed', async () => {
    const r = await payFully(app, mock, patient, args());
    const earning = (await WalletTransaction.collection.findOne({
      referenceId: oid(r.bookingId),
      type: 'EARNING',
    }))!;
    await WalletTransaction.collection.deleteOne({ _id: earning._id });
    const before = await fingerprint();
    const first = await run('reconciliation.run');
    await run('reconciliation.run');
    expect(first.ok).toBe(false);
    expect(await fingerprint()).toBe(before); // no financial mutation
    const alert = await AdminAlert.find({
      key: 'reconciliation-drift:earnings-are-credited-exactly-once-per-paid-booking',
    }).lean();
    expect(alert).toHaveLength(1);
    expect(alert[0]).toMatchObject({
      severity: 'CRITICAL',
      status: 'OPEN',
      type: 'RECONCILIATION_DRIFT',
    });
    // restore the row => the check passes again and the alert resolves automatically
    await WalletTransaction.collection.insertOne(earning);
    await run('reconciliation.run');
    const resolved = await AdminAlert.findOne({
      key: 'reconciliation-drift:earnings-are-credited-exactly-once-per-paid-booking',
    });
    expect(resolved!.status).toBe('RESOLVED');
    // recurrence re-opens it
    await WalletTransaction.collection.deleteOne({ _id: earning._id });
    await run('reconciliation.run');
    expect(
      (await AdminAlert.findOne({
        key: 'reconciliation-drift:earnings-are-credited-exactly-once-per-paid-booking',
      }))!.status,
    ).toBe('OPEN');
  });

  it('overlapping runs are skipped while another run holds the lease', async () => {
    await payFully(app, mock, patient, args());
    const held = await withJobLock('reconciliation', 60_000, async () => run('reconciliation.run'));
    expect(held.acquired && held.value).toEqual({ skipped: 'ALREADY_RUNNING' });
    expect(await run('reconciliation.run')).toMatchObject({ ok: true }); // lease released afterwards
  });
});

describe('queue health alerts', () => {
  it('raises backlog / stuck / no-worker alerts with thresholds from settings and clears them', async () => {
    await setSetting('queue.backlogAlertThreshold', 2);
    await setSetting('queue.oldestWaitingAlertSeconds', 1);
    for (let i = 0; i < 4; i++)
      await enqueue(
        QUEUES.refund,
        'refund.attempt',
        { refundId: '0'.repeat(24) },
        { jobId: `j${i}` },
      );
    memoryQueue().jobs.forEach((j) => (j.addedAt -= 10_000));
    await run('alerts.queueHealth');
    const types = (await AdminAlert.find({ status: 'OPEN' }).lean()).map((a) => a.type).sort();
    expect(types).toEqual(['QUEUE_BACKLOG', 'QUEUE_NO_WORKERS', 'QUEUE_STUCK']);
    await run('alerts.queueHealth');
    expect(await AdminAlert.countDocuments({ type: 'QUEUE_BACKLOG' })).toBe(1); // not spammed
    memoryQueue().drain();
    await run('alerts.queueHealth');
    expect(
      await AdminAlert.countDocuments({
        status: 'OPEN',
        type: { $in: ['QUEUE_BACKLOG', 'QUEUE_STUCK', 'QUEUE_NO_WORKERS'] },
      }),
    ).toBe(0);
  });
});

describe('scheduler', () => {
  it('registers every recurring job from platform settings, idempotently', async () => {
    const s = await syncSchedules(memoryQueue());
    expect(s.upserted).toHaveLength(SCHEDULES.length);
    const sched = memoryQueue().schedulers;
    expect(sched.size).toBe(SCHEDULES.length);
    expect(sched.get('booking-jobs:booking.expireDue')!.everyMs).toBe(60_000);
    expect(sched.get('reconciliation-jobs:reconciliation.run')!.everyMs).toBe(15 * 60_000);
    await syncSchedules(memoryQueue());
    expect(sched.size).toBe(SCHEDULES.length);
    await setSetting('jobs.bookingExpireSeconds', 30);
    await syncSchedules(memoryQueue());
    expect(sched.get('booking-jobs:booking.expireDue')!.everyMs).toBe(30_000);
  });

  it('removes all schedules when the scheduler is disabled', async () => {
    await syncSchedules(memoryQueue());
    await SettingsService.set('jobs.schedulerEnabled', false);
    const s = await syncSchedules(memoryQueue());
    expect(s.enabled).toBe(false);
    expect(memoryQueue().schedulers.size).toBe(0);
  });
});

describe('Redis / queue unavailable never changes financial correctness', () => {
  it('enqueue is best-effort and never throws', async () => {
    memoryQueue().unavailable = true;
    await expect(
      enqueue(QUEUES.refund, 'refund.attempt', { refundId: '0'.repeat(24) }),
    ).resolves.toBe(false);
  });

  it('payment, cancellation and refund still complete correctly while the queue backend is down', async () => {
    memoryQueue().unavailable = true;
    const r = await payFully(app, mock, patient, args());
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(13600);
    await post(nurse.session, `/bookings/${r.bookingId}/reject`);
    // sweeps can run directly against MongoDB (no queue needed)
    const { RefundService } = await import('../../src/modules/refunds');
    await RefundService.processDue();
    expect(await status(r.bookingId)).toBe('REFUNDED');
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });
});

describe('GET /admin/queues (operational visibility, RBAC)', () => {
  it('shows counts, schedules and workers to admins and finance approvers only; never payloads', async () => {
    const { createAdmin } = await import('../helpers/harness');
    const admin = await createAdmin(app);
    const approver = await createAdmin(app, 'FINANCE_APPROVER');
    await syncSchedules(memoryQueue());
    await enqueue(QUEUES.refund, 'refund.attempt', { refundId: '0'.repeat(24) }, { jobId: 'x' });
    await memoryQueue().heartbeat({
      id: 'w1',
      startedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      queues: ['refund-jobs'],
      pid: 1,
    });
    for (const who of [admin, approver]) {
      const res = await request(app).get(`${API}/admin/queues`).set(who.auth);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ available: true, backend: 'memory' });
      expect(res.body.data.queues).toHaveLength(9);
      expect(
        res.body.data.queues.find((q: { queue: string }) => q.queue === 'refund-jobs').waiting,
      ).toBe(1);
      expect(res.body.data.schedulers.length).toBe(SCHEDULES.length);
      expect(res.body.data.workers[0]).toMatchObject({ id: 'w1', alive: true });
      expect(JSON.stringify(res.body)).not.toContain('0'.repeat(24)); // no job payloads
    }
    for (const who of [patient, nurse.session])
      expect((await request(app).get(`${API}/admin/queues`).set(who.auth)).status).toBe(403);
    expect((await request(app).get(`${API}/admin/queues`)).status).toBe(401);
  });

  it('degrades to available:false (HTTP 200) when the queue backend is unreachable', async () => {
    const { createAdmin } = await import('../helpers/harness');
    const admin = await createAdmin(app);
    memoryQueue().unavailable = true;
    const res = await request(app).get(`${API}/admin/queues`).set(admin.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ available: false, queues: [] });
  });
});
