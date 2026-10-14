import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { AdminAlert } from '../../src/modules/alerts';
import { ReconciliationService } from '../../src/modules/finance';
import { Payout, PayoutService } from '../../src/modules/payouts';
import { WalletService, WalletTransaction } from '../../src/modules/wallets';
import type { MockPaymentProvider } from '../../src/providers/payment';
import { API, resetState, startApp, stopApp, type Session } from '../helpers/harness';
import {
  completeBooking,
  deliver,
  freshProvider,
  payFully,
  setSetting,
  walletOf,
} from '../helpers/finance';
import { at, baseWorld, type Nurse } from '../helpers/world';

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
afterEach(() => jest.restoreAllMocks());

const later = (seconds: number) => new Date(Date.now() + seconds * 1000);

async function requestedPayout(amountMinor = 10_000) {
  const r = await payFully(app, mock, patient, {
    serviceId,
    nurseId: nurse.profileId,
    start: at(D, '08:00'),
    end: at(D, '12:00'),
  });
  await completeBooking(r.bookingId, nurse, app);
  await WalletService.releaseDue(later(49 * 3600));
  await request(app)
    .put(`${API}/nurses/me/payout-method`)
    .set(nurse.session.auth)
    .send({ providerRef: 'mock_acct_123456', last4: '4242', bankName: 'Emirates NBD' });
  const res = await request(app)
    .post(`${API}/payouts`)
    .set(nurse.session.auth)
    .set('Idempotency-Key', randomUUID())
    .send({ amountMinor });
  expect(res.status).toBe(201);
  return (await Payout.findById(res.body.data.id))!;
}
const reload = async (id: unknown) => (await Payout.findById(id))!;

describe('D: payout provider success vs LOCAL persistence failure', () => {
  it('a local failure after the provider paid keeps the funds debited, does not count as a failure, and the retry settles without paying twice', async () => {
    const p = await requestedPayout();
    jest
      .spyOn(PayoutService, 'finalizePaid')
      .mockRejectedValueOnce(new Error('local write failed'));
    expect(await PayoutService.processDue()).toEqual({ FINALIZE_PENDING: 1 });
    jest.restoreAllMocks();

    const mid = await reload(p._id);
    expect(mid.toObject()).toMatchObject({
      status: 'PROVIDER_PAID',
      failureCount: 0,
      finalizeAttempts: 1,
    });
    expect(mid.providerPayoutId).toBeTruthy();
    expect(await WalletTransaction.countDocuments({ type: 'PAYOUT_REVERSAL' })).toBe(0);
    expect((await walletOf(nurse)).availableBalanceMinor).toBe(3600); // still debited
    expect(await AdminAlert.countDocuments({ type: 'PAYOUT_FAILED' })).toBe(0);
    expect(mock.calls.payout).toBe(1);

    expect(await PayoutService.processDue(later(3600))).toEqual({ PAID: 1 });
    expect(mock.calls.payout).toBe(1); // never paid twice
    expect(await reload(p._id)).toMatchObject({ status: 'PAID' });
    expect(await walletOf(nurse)).toMatchObject({
      availableBalanceMinor: 3600,
      totalWithdrawnMinor: 10_000,
    });
    expect(await WalletTransaction.countDocuments({ type: 'PAYOUT_SETTLED' })).toBe(1);
    expect((await ReconciliationService.run()).ok).toBe(true);
  });

  it('a PROVIDER_PAID payout blocks a second open payout for the same nurse', async () => {
    const p = await requestedPayout(5000);
    jest.spyOn(PayoutService, 'finalizePaid').mockRejectedValue(new Error('down'));
    await PayoutService.processDue();
    const second = await request(app)
      .post(`${API}/payouts`)
      .set(nurse.session.auth)
      .set('Idempotency-Key', randomUUID())
      .send({ amountMinor: 5000 });
    expect([second.status, second.body.errorCode]).toEqual([409, 'PAYOUT_ALREADY_OPEN']);
    expect((await reload(p._id)).status).toBe('PROVIDER_PAID');
  });

  it('repeated local failures raise a CRITICAL alert, never a payout failure', async () => {
    const p = await requestedPayout();
    jest.spyOn(PayoutService, 'finalizePaid').mockRejectedValue(new Error('down'));
    for (const s of [0, 3600, 7200, 10_800]) await PayoutService.processDue(later(s));
    expect(await AdminAlert.findOne({ type: 'PAYOUT_FINALIZE_PENDING' })).toMatchObject({
      severity: 'CRITICAL',
    });
    expect((await reload(p._id)).status).toBe('PROVIDER_PAID');
    expect(await WalletTransaction.countDocuments({ type: 'PAYOUT_REVERSAL' })).toBe(0);
  });

  it('an asynchronous payout is polled with getPayout (never re-issued) and settles when the provider says PAID', async () => {
    const p = await requestedPayout();
    mock.payoutMode = 'ASYNC';
    expect(await PayoutService.processDue()).toEqual({ PENDING_PROVIDER: 1 });
    const mid = await reload(p._id);
    expect(mid.providerPayoutId).toBeTruthy();
    expect(mid.status).toBe('PROCESSING');
    mock.settlePayout(mid.providerPayoutId!, 'PAID');
    expect(await PayoutService.processDue(later(24 * 3600))).toEqual({ PAID: 1 });
    expect(mock.calls.payout).toBe(1);
    expect((await reload(p._id)).status).toBe('PAID');
  });

  it('a stuck asynchronous payout raises one CRITICAL alert and is never guessed final', async () => {
    const p = await requestedPayout();
    mock.payoutMode = 'ASYNC';
    await setSetting('refund.maxProcessingMinutes', 10);
    await setSetting('refund.statusPollSeconds', 60);
    await PayoutService.processDue();
    for (const m of [5, 30, 60]) await PayoutService.processDue(later(m * 60));
    expect(await AdminAlert.countDocuments({ type: 'PAYOUT_STUCK_PROCESSING' })).toBe(1);
    expect((await reload(p._id)).status).toBe('PROCESSING');
    expect(await WalletTransaction.countDocuments({ type: 'PAYOUT_REVERSAL' })).toBe(0);
  });

  it('a provider-reported async FAILURE returns the funds once and bumps the idempotency generation', async () => {
    const p = await requestedPayout();
    mock.payoutMode = 'ASYNC';
    await setSetting('payout.maxAttempts', 1);
    await PayoutService.processDue();
    const mid = await reload(p._id);
    mock.settlePayout(mid.providerPayoutId!, 'FAILED');
    await PayoutService.processDue(later(24 * 3600));
    await PayoutService.processDue(later(48 * 3600));
    expect((await reload(p._id)).status).toBe('FAILED');
    expect(await WalletTransaction.countDocuments({ type: 'PAYOUT_REVERSAL' })).toBe(1);
    expect((await walletOf(nurse)).availableBalanceMinor).toBe(13_600);
    expect((await ReconciliationService.run()).ok).toBe(true);
  });
});

describe('D: duplicate and contradictory payout events', () => {
  const event = (
    p: { providerPayoutId?: string | null },
    type: 'payout.paid' | 'payout.failed',
    eventId?: string,
    extra = {},
  ) => mock.signEvent(type, { providerPayoutId: p.providerPayoutId, ...extra }, { eventId });

  it('duplicate payout.paid events (same or different event id) settle exactly once', async () => {
    const p = await requestedPayout();
    mock.payoutMode = 'ASYNC';
    await PayoutService.processDue();
    const mid = await reload(p._id);
    const a = await deliver(app, event(mid, 'payout.paid', 'evt_p1'));
    const b = await deliver(app, event(mid, 'payout.paid', 'evt_p1'));
    const c = await deliver(app, event(mid, 'payout.paid', 'evt_p2'));
    expect(a.body.data.outcome).toBe('PAYOUT_PAID');
    expect(b.body.data.status).toBe('DUPLICATE');
    expect(c.body.data.outcome).toBe('PAYOUT_ALREADY_FINAL');
    expect(await WalletTransaction.countDocuments({ type: 'PAYOUT_SETTLED' })).toBe(1);
    expect((await walletOf(nurse)).totalWithdrawnMinor).toBe(10_000);
  });

  it('payout.failed after the payout was PAID never returns the funds; a CRITICAL alert asks for manual review', async () => {
    const p = await requestedPayout();
    await PayoutService.processDue(); // SYNC provider: PAID
    const paid = await reload(p._id);
    expect(paid.status).toBe('PAID');
    const res = await deliver(app, event(paid, 'payout.failed', 'evt_late_fail'));
    expect(res.body.data.outcome).toBe('PAYOUT_ALREADY_FINAL');
    expect(await WalletTransaction.countDocuments({ type: 'PAYOUT_REVERSAL' })).toBe(0);
    expect(await AdminAlert.findOne({ type: 'PAYOUT_EVENT_CONTRADICTION' })).toMatchObject({
      severity: 'CRITICAL',
    });
    expect((await reload(p._id)).status).toBe('PAID');
  });

  it('an event whose amount disagrees with the payout is not applied', async () => {
    const p = await requestedPayout();
    mock.payoutMode = 'ASYNC';
    await PayoutService.processDue();
    const mid = await reload(p._id);
    const res = await deliver(app, event(mid, 'payout.paid', 'evt_amt', { amountMinor: 1 }));
    expect(res.body.data.outcome).toBe('PAYOUT_AMOUNT_MISMATCH');
    expect((await reload(p._id)).status).toBe('PROCESSING');
    expect(await AdminAlert.findOne({ type: 'PAYOUT_EVENT_AMOUNT_MISMATCH' })).toBeTruthy();
  });

  it('an event for an unknown payout is reported, not applied', async () => {
    await requestedPayout();
    const res = await deliver(app, event({ providerPayoutId: 'po_ghost' }, 'payout.paid', 'evt_g'));
    expect(res.body.data.outcome).toBe('UNKNOWN_PAYOUT');
    expect(await AdminAlert.countDocuments({ type: 'UNKNOWN_PAYOUT_EVENT' })).toBe(1);
  });
});
