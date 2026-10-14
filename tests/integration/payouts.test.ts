import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { AdminAlert } from '../../src/modules/alerts';
import { AuditLog } from '../../src/modules/audit';
import { ReconciliationService } from '../../src/modules/finance';
import { Payout, PayoutMethod, PayoutService } from '../../src/modules/payouts';
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
import { at, baseWorld, mkNurse, type Nurse } from '../helpers/world';

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

const later = (seconds: number) => new Date(Date.now() + seconds * 1000);
const post = (s: Session, path: string, body: object = {}) =>
  request(app).post(`${API}${path}`).set(s.auth).send(body);
const get = (s: Session, path: string) => request(app).get(`${API}${path}`).set(s.auth);
const put = (s: Session, path: string, body: object) =>
  request(app).put(`${API}${path}`).set(s.auth).send(body);
const payoutReq = (s: Session, body: object, key: string | null = randomUUID()) => {
  const r = request(app).post(`${API}/payouts`).set(s.auth);
  return (key ? r.set('Idempotency-Key', key) : r).send(body);
};
const setMethod = (n: Nurse = nurse) =>
  put(n.session, '/nurses/me/payout-method', {
    providerRef: 'mock_acct_123456',
    last4: '4242',
    bankName: 'Emirates NBD',
  });

/** Real money path: payment -> completion -> release, so the balance is genuine ledger-backed earnings. */
async function earnAvailable(a = { s: '08:00', e: '12:00' }) {
  const r = await payFully(app, mock, patient, {
    serviceId,
    nurseId: nurse.profileId,
    start: at(D, a.s),
    end: at(D, a.e),
  });
  await completeBooking(r.bookingId, nurse, app);
  await WalletService.releaseDue(later(49 * 3600));
  return r;
}

describe('payout method (provider token only)', () => {
  it('stores the provider token and non-sensitive metadata; raw bank details are refused', async () => {
    expect((await get(nurse.session, '/nurses/me/payout-method')).body.data).toBeNull();
    for (const iban of ['AE070331234567890123456', 'GB29NWBK60161331926819']) {
      const r = await put(nurse.session, '/nurses/me/payout-method', { providerRef: iban });
      expect([r.status, r.body.errorCode]).toEqual([400, 'RAW_BANK_DETAILS_NOT_ALLOWED']);
    }
    expect(
      (
        await put(nurse.session, '/nurses/me/payout-method', {
          providerRef: 'x',
          accountNumber: '123',
        })
      ).status,
    ).toBe(400);
    const ok = await setMethod();
    expect(ok.body.data).toMatchObject({
      provider: 'mock',
      providerRef: 'mock_acct_123456',
      last4: '4242',
    });
    expect(await PayoutMethod.countDocuments()).toBe(1);
    expect(JSON.stringify(await PayoutMethod.find().lean())).not.toMatch(/iban|accountNumber/i);
    expect(
      (await put(patient, '/nurses/me/payout-method', { providerRef: 'mock_acct_123456' })).status,
    ).toBe(403);
  });
});

describe('requesting a payout (only from availableBalance)', () => {
  it('needs a payout method, an Idempotency-Key and a sane amount', async () => {
    await earnAvailable();
    const noMethod = await payoutReq(nurse.session, { amountMinor: 10000 });
    expect([noMethod.status, noMethod.body.errorCode]).toEqual([422, 'PAYOUT_METHOD_REQUIRED']);
    await setMethod();
    expect((await payoutReq(nurse.session, { amountMinor: 10000 }, null)).status).toBe(400);
    const low = await payoutReq(nurse.session, { amountMinor: 1000 });
    expect([low.status, low.body.errorCode]).toEqual([422, 'PAYOUT_BELOW_MINIMUM']);
    expect((await payoutReq(nurse.session, { amountMinor: 100.5 })).status).toBe(400);
    expect((await payoutReq(nurse.session, { amountMinor: 10000, status: 'PAID' })).status).toBe(
      400,
    );
    expect(await Payout.countDocuments()).toBe(0);
    expect((await walletOf(nurse)).availableBalanceMinor).toBe(13600);
  });

  it('debits the wallet and creates a PENDING payout in one transaction (ledger row PAYOUT)', async () => {
    await earnAvailable();
    await setMethod();
    const r = await payoutReq(nurse.session, { amountMinor: 10000 });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      amountMinor: 10000,
      status: 'PENDING',
      currency: 'AED',
      provider: 'mock',
    });
    expect(await walletOf(nurse)).toMatchObject({
      availableBalanceMinor: 3600,
      totalWithdrawnMinor: 0,
    });
    const row = await WalletTransaction.findOne({ type: 'PAYOUT' }).lean();
    expect(row).toMatchObject({
      bucket: 'AVAILABLE',
      amountMinor: -10000,
      balanceBefore: 13600,
      balanceAfter: 3600,
      referenceType: 'PAYOUT',
    });
    expect(mock.calls.payout).toBe(0);
  });

  it('omitting the amount withdraws the whole available balance', async () => {
    await earnAvailable();
    await setMethod();
    const r = await payoutReq(nurse.session, {});
    expect(r.body.data.amountMinor).toBe(13600);
    expect((await walletOf(nurse)).availableBalanceMinor).toBe(0);
  });

  it('insufficient balance is refused; pending (unreleased) earnings cannot be paid out', async () => {
    await payFully(app, mock, patient, {
      serviceId,
      nurseId: nurse.profileId,
      start: at(D, '08:00'),
      end: at(D, '12:00'),
    });
    await setMethod();
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(13600);
    const r = await payoutReq(nurse.session, { amountMinor: 13600 });
    expect([r.status, r.body.errorCode]).toEqual([422, 'INSUFFICIENT_BALANCE']);
    await earnAvailableOther();
    const tooMuch = await payoutReq(nurse.session, { amountMinor: 20000 });
    expect(tooMuch.body.errorCode).toBe('INSUFFICIENT_BALANCE');
    expect(await Payout.countDocuments()).toBe(0);
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(13600);
  });
  async function earnAvailableOther() {
    await earnAvailable({ s: '14:00', e: '18:00' });
  }

  it('is idempotent: the same key returns the original payout, a different payload is rejected, one debit only', async () => {
    await earnAvailable();
    await setMethod();
    const key = randomUUID();
    const a = await payoutReq(nurse.session, { amountMinor: 6000 }, key);
    const b = await payoutReq(nurse.session, { amountMinor: 6000 }, key);
    const c = await payoutReq(nurse.session, { amountMinor: 7000 }, key);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body.data.id).toBe(a.body.data.id);
    expect([c.status, c.body.errorCode]).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);
    expect(await Payout.countDocuments()).toBe(1);
    expect(await WalletTransaction.countDocuments({ type: 'PAYOUT' })).toBe(1);
    expect((await walletOf(nurse)).availableBalanceMinor).toBe(7600);
  });

  it('simultaneous requests: one open payout per nurse, the balance is debited once', async () => {
    await earnAvailable();
    await setMethod();
    const res = await Promise.all(
      Array.from({ length: 6 }, () => payoutReq(nurse.session, { amountMinor: 5000 })),
    );
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      res.filter((r) => r.status === 409).every((r) => r.body.errorCode === 'PAYOUT_ALREADY_OPEN'),
    ).toBe(true);
    expect(res.filter((r) => r.status >= 500)).toEqual([]);
    expect(await Payout.countDocuments()).toBe(1);
    expect((await walletOf(nurse)).availableBalanceMinor).toBe(8600);
    expect(await WalletTransaction.countDocuments({ type: 'PAYOUT' })).toBe(1);
  });

  it('simultaneous duplicate of the SAME key creates one payout', async () => {
    await earnAvailable();
    await setMethod();
    const key = randomUUID();
    const res = await Promise.all(
      Array.from({ length: 5 }, () => payoutReq(nurse.session, { amountMinor: 5000 }, key)),
    );
    expect(res.every((r) => r.status === 201)).toBe(true);
    expect(new Set(res.map((r) => r.body.data.id)).size).toBe(1);
    expect(await Payout.countDocuments()).toBe(1);
  });

  it('only nurses can request; patients and anonymous callers cannot', async () => {
    expect((await payoutReq(patient, { amountMinor: 5000 })).status).toBe(403);
    expect((await request(app).post(`${API}/payouts`).send({})).status).toBe(401);
  });
});

describe('payout lifecycle PENDING -> PROCESSING -> PAID', () => {
  async function requested(amount = 10000) {
    await earnAvailable();
    await setMethod();
    const r = await payoutReq(nurse.session, { amountMinor: amount });
    return r.body.data.id as string;
  }

  it('the sweep pays it through the provider; withdrawal is settled in the ledger', async () => {
    const id = await requested();
    expect(await PayoutService.processDue()).toEqual({ PAID: 1 });
    const p = (await Payout.findById(id).lean())!;
    expect(p).toMatchObject({ status: 'PAID', attempts: 1 });
    expect(p.providerPayoutId).toMatch(/^mock_po_/);
    expect(p.paidAt).toBeInstanceOf(Date);
    expect(await walletOf(nurse)).toMatchObject({
      availableBalanceMinor: 3600,
      totalWithdrawnMinor: 10000,
      totalEarnedMinor: 13600,
    });
    expect(await WalletTransaction.findOne({ type: 'PAYOUT_SETTLED' })).toMatchObject({
      bucket: 'NONE',
      amountMinor: 0,
      withdrawnDelta: 10000,
    });
    expect(mock.calls.payout).toBe(1);
    const mine = await get(nurse.session, '/payouts');
    expect(mine.body.data.items[0]).toMatchObject({ id, status: 'PAID' });
  });

  it('concurrent processing calls the provider once and settles once', async () => {
    await requested();
    await Promise.all([
      PayoutService.processDue(),
      PayoutService.processDue(),
      PayoutService.processDue(),
    ]);
    expect(mock.calls.payout).toBe(1);
    expect(await WalletTransaction.countDocuments({ type: 'PAYOUT_SETTLED' })).toBe(1);
    expect((await walletOf(nurse)).totalWithdrawnMinor).toBe(10000);
  });

  it('a retryable provider failure keeps the payout pending, funds stay debited, then it is retried with backoff and paid', async () => {
    const id = await requested();
    mock.payoutFailuresRemaining = 1;
    expect(await PayoutService.processDue()).toEqual({ RETRY: 1 });
    const p = (await Payout.findById(id).lean())!;
    expect(p).toMatchObject({ status: 'PENDING', attempts: 1, failureCount: 1 });
    expect(p.lastError).toContain('mock provider payout failure');
    expect(p.nextRetryAt!.getTime()).toBeGreaterThan(Date.now() + 50_000);
    expect((await walletOf(nurse)).availableBalanceMinor).toBe(3600);
    expect(await PayoutService.processDue()).toEqual({}); // not yet
    expect(await PayoutService.processDue(later(61))).toEqual({ PAID: 1 });
    expect(await Payout.findById(id)).toMatchObject({ status: 'PAID', attempts: 2 });
    expect((await walletOf(nurse)).totalWithdrawnMinor).toBe(10000);
  });

  it('exhausted retries: FAILED, funds returned by a compensating ledger row, critical alert, nurse can request again', async () => {
    await setSetting('payout.maxAttempts', 2);
    const id = await requested();
    mock.payoutFailuresRemaining = 99;
    await PayoutService.processDue();
    await PayoutService.processDue(later(3600));
    const p = (await Payout.findById(id).lean())!;
    expect(p.status).toBe('FAILED');
    expect(await walletOf(nurse)).toMatchObject({
      availableBalanceMinor: 13600,
      totalWithdrawnMinor: 0,
    });
    expect(
      (await WalletTransaction.find({ referenceType: 'PAYOUT' }).sort({ createdAt: 1 }).lean()).map(
        (r) => [r.type, r.amountMinor],
      ),
    ).toEqual([
      ['PAYOUT', -10000],
      ['PAYOUT_REVERSAL', 10000],
    ]);
    expect(await AdminAlert.findOne({ type: 'PAYOUT_FAILED' })).toMatchObject({
      severity: 'CRITICAL',
    });
    expect((await payoutReq(nurse.session, { amountMinor: 5000 })).status).toBe(201);
  });

  it('a non-retryable error fails the payout immediately and returns the funds', async () => {
    const id = await requested();
    mock.payoutFailuresRemaining = 1;
    mock.payoutFailRetryable = false;
    expect(await PayoutService.processDue()).toEqual({ FAILED: 1 });
    expect((await Payout.findById(id))!.status).toBe('FAILED');
    expect((await walletOf(nurse)).availableBalanceMinor).toBe(13600);
  });

  it('asynchronous provider: PROCESSING until the signed payout.paid webhook; replays are harmless', async () => {
    mock.payoutMode = 'ASYNC';
    const id = await requested();
    expect(await PayoutService.processDue()).toEqual({ PENDING_PROVIDER: 1 });
    const p = (await Payout.findById(id).lean())!;
    expect(p.status).toBe('PROCESSING');
    const evt = mock.signEvent(
      'payout.paid',
      { providerPayoutId: p.providerPayoutId },
      { eventId: 'evt_po_1' },
    );
    expect((await deliver(app, evt)).body.data.outcome).toBe('PAYOUT_PAID');
    expect((await deliver(app, evt)).body.data.status).toBe('DUPLICATE');
    expect(
      (await deliver(app, mock.signEvent('payout.paid', { providerPayoutId: p.providerPayoutId })))
        .body.data.outcome,
    ).toBe('PAYOUT_ALREADY_FINAL');
    expect((await Payout.findById(id))!.status).toBe('PAID');
    expect((await walletOf(nurse)).totalWithdrawnMinor).toBe(10000);
    expect(await WalletTransaction.countDocuments({ type: 'PAYOUT_SETTLED' })).toBe(1);
  });

  it('cancel: only unprocessed payouts, funds return once; other nurses cannot cancel yours', async () => {
    const id = await requested();
    const other = await mkNurse(app, admin, { serviceIds: [serviceId] });
    expect((await post(other.session, `/payouts/${id}/cancel`)).status).toBe(404);
    expect((await post(patient, `/payouts/${id}/cancel`)).status).toBe(403);
    const c = await post(nurse.session, `/payouts/${id}/cancel`);
    expect(c.body.data.status).toBe('CANCELLED');
    expect((await walletOf(nurse)).availableBalanceMinor).toBe(13600);
    expect((await post(nurse.session, `/payouts/${id}/cancel`)).status).toBe(409);
    expect((await walletOf(nurse)).availableBalanceMinor).toBe(13600);

    const id2 = (await payoutReq(nurse.session, { amountMinor: 5000 })).body.data.id;
    await PayoutService.processDue();
    expect((await post(nurse.session, `/payouts/${id2}/cancel`)).status).toBe(409); // already paid
  });

  it('admin lists payouts and can cancel an unprocessed one (audited)', async () => {
    const id = await requested();
    const list = await get(admin, '/admin/payouts?status=PENDING');
    expect(list.body.data.items[0]).toMatchObject({
      id,
      status: 'PENDING',
      provider: 'mock',
      attempts: 0,
    });
    expect((await get(patient, '/admin/payouts')).status).toBe(403);
    expect((await post(admin, `/admin/payouts/${id}/cancel`)).body.data.status).toBe('CANCELLED');
    expect(await AuditLog.countDocuments({ action: 'payout.cancelled_by_admin' })).toBe(1);
  });

  it('wallet, payouts and ledger reconcile after a mix of paid, failed and cancelled payouts', async () => {
    await earnAvailable();
    await setMethod();
    await payoutReq(nurse.session, { amountMinor: 5000 });
    await PayoutService.processDue();
    const b = (await payoutReq(nurse.session, { amountMinor: 5000 })).body.data.id;
    await post(nurse.session, `/payouts/${b}/cancel`);
    mock.payoutFailuresRemaining = 99;
    mock.payoutFailRetryable = false;
    await payoutReq(nurse.session, { amountMinor: 5000 });
    await PayoutService.processDue();
    const rep = await ReconciliationService.run();
    expect(rep.checks.filter((c) => !c.ok)).toEqual([]);
    expect(rep.totals.paidOutMinor).toBe(5000);
    expect(await walletOf(nurse)).toMatchObject({
      availableBalanceMinor: 8600,
      totalWithdrawnMinor: 5000,
    });
  });
});
