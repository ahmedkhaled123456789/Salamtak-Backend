import { createHash } from 'node:crypto';
import type { Express } from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { Booking } from '../../src/modules/bookings';
import { ReconciliationService } from '../../src/modules/finance';
import { Payment } from '../../src/modules/payments';
import { Payout, PayoutService } from '../../src/modules/payouts';
import { Refund, RefundService } from '../../src/modules/refunds';
import { Wallet, WalletService, WalletTransaction } from '../../src/modules/wallets';
import type { MockPaymentProvider } from '../../src/providers/payment';
import { AuditLog } from '../../src/modules/audit';
import { API, resetState, startApp, stopApp, type Session } from '../helpers/harness';
import {
  H,
  completeBooking,
  createPayment,
  freshProvider,
  payFully,
  succeed,
} from '../helpers/finance';
import { at, baseWorld, bookIt, timeTravel, type Nurse } from '../helpers/world';

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

const later = (seconds: number) => new Date(Date.now() + seconds * 1000);
const post = (s: Session, path: string, body: object = {}) =>
  request(app).post(`${API}${path}`).set(s.auth).send(body);
const oid = (id: unknown) => new mongoose.Types.ObjectId(String(id));
const pay = (s: string, e: string) =>
  payFully(app, mock, patient, {
    serviceId,
    nurseId: nurse.profileId,
    start: at(D, s),
    end: at(D, e),
  });
const failing = async () =>
  (await ReconciliationService.run()).checks.filter((c) => !c.ok).map((c) => c.name);

/** A realistic mixed history: completed+released+paid out, 50%-cancelled+refunded, rejected+refunded, still pending. */
async function busyHistory() {
  const done = await pay('06:00', '10:00');
  await completeBooking(done.bookingId, nurse, app);
  await WalletService.releaseDue(later(49 * 3600));
  await WalletService.ensure(nurse.profileId);
  const { PayoutMethod } = await import('../../src/modules/payouts');
  await PayoutMethod.create({
    nurseId: nurse.profileId,
    provider: 'mock',
    providerRef: 'mock_acct_123456',
  });
  await PayoutService.request(nurse.profileId, 5000, 'recon-payout-1');
  await PayoutService.processDue();

  const cancelled = await pay('11:00', '15:00');
  const start = Date.now() + 30 * H;
  await timeTravel(cancelled.bookingId, {
    startDateTime: new Date(start),
    endDateTime: new Date(start + 4 * H),
  });
  await post(patient, `/bookings/${cancelled.bookingId}/cancel`);

  const rejected = await pay('16:00', '18:00');
  await post(nurse.session, `/bookings/${rejected.bookingId}/reject`);
  await RefundService.processDue();

  const live = await pay('19:00', '21:00');
  return { done, cancelled, rejected, live };
}

async function fingerprint() {
  const cols = [
    'wallets',
    'walletTransactions',
    'bookings',
    'payments',
    'refunds',
    'payouts',
    'adminAlerts',
    'auditLogs',
  ];
  const h = createHash('sha256');
  for (const c of cols) {
    const docs = await mongoose.connection.collection(c).find().sort({ _id: 1 }).toArray();
    h.update(c + JSON.stringify(docs));
  }
  return h.digest('hex');
}

describe('reconciliation of a healthy system', () => {
  it('every check passes after a busy mixed history, and the totals match the snapshots', async () => {
    await busyHistory();
    const rep = await ReconciliationService.run();
    expect(rep.checks.filter((c) => !c.ok)).toEqual([]);
    expect(rep.ok).toBe(true);
    expect(rep.checks.map((c) => c.name)).toEqual([
      'wallet balances equal the ledger',
      'ledger rows are consistent',
      'pending earnings equal eligible bookings',
      'payments reconcile with bookings',
      'refunds reconcile with payments',
      'every pending booking refund has an obligation',
      'commission and allocations reconcile with snapshots',
      'payouts reconcile with the ledger',
      'earnings are credited exactly once per paid booking',
      'ledger chain is continuous',
      'no orphan ledger rows or duplicate financial references',
      'payout amounts match their ledger rows',
      'refund amounts match obligations and snapshots',
    ]);
    // 4 paid bookings; (4h:16000)+(4h:16000)+(2h:8000)+(2h:8000) gross
    expect(rep.totals).toMatchObject({
      bookingsPaid: 4,
      grossMinor: 48000,
      commissionMinor: 7200,
      nurseEarningMinor: 40800,
      paidOutMinor: 5000,
    });
    expect(rep.totals.refundedMinor).toBe(8000 + 8000); // 50% of 16000 + 100% of 8000
    // every check actually examined data (nothing is REFUND_PENDING at the end, so that one may be empty)
    for (const c of rep.checks.filter((c) => !c.name.includes('pending booking refund')))
      expect(c.checked).toBeGreaterThan(0);
  });

  it('wallet fields equal the ledger-derived values exactly', async () => {
    await busyHistory();
    const w = (await Wallet.findOne({ nurseId: nurse.profileId }).lean())!;
    const rows = await WalletTransaction.find({ nurseId: nurse.profileId }).lean();
    const sum = (b: string) =>
      rows.filter((r) => r.bucket === b).reduce((n, r) => n + r.amountMinor, 0);
    expect(w.pendingBalanceMinor).toBe(sum('PENDING'));
    expect(w.availableBalanceMinor).toBe(sum('AVAILABLE'));
    expect(w.totalEarnedMinor).toBe(rows.reduce((n, r) => n + r.earnedDelta, 0));
    expect(w.totalWithdrawnMinor).toBe(rows.reduce((n, r) => n + r.withdrawnDelta, 0));
    expect(w.totalWithdrawnMinor).toBe(5000);
  });

  it('is READ-ONLY: running it never changes any financial data', async () => {
    await busyHistory();
    const before = await fingerprint();
    await ReconciliationService.run();
    const res = await request(app).get(`${API}/admin/reconciliation`).set(admin.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(true);
    expect(await fingerprint()).toBe(before);
  });
});

describe('reconciliation detects drift (and does not repair it)', () => {
  beforeEach(async () => {
    await busyHistory();
    expect(await failing()).toEqual([]);
  });

  it('wallet balance edited outside the ledger', async () => {
    await Wallet.collection.updateOne(
      { nurseId: oid(nurse.profileId) },
      { $inc: { availableBalanceMinor: 1 } },
    );
    expect(await failing()).toContain('wallet balances equal the ledger');
    const rep = await ReconciliationService.run();
    expect(rep.checks[0]!.problems[0]).toMatch(/available: balance \d+ != ledger \d+/);
    expect(
      (await Wallet.findOne({ nurseId: nurse.profileId }))!.availableBalanceMinor,
    ).toBeGreaterThan(0); // not "fixed"
  });

  it('negative wallet balance', async () => {
    await Wallet.collection.updateOne(
      { nurseId: oid(nurse.profileId) },
      { $set: { totalWithdrawnMinor: -1 } },
    );
    expect(await failing()).toContain('wallet balances equal the ledger');
  });

  it('ledger row whose balances do not add up', async () => {
    await WalletTransaction.collection.updateOne(
      { type: 'EARNING' },
      { $set: { balanceAfter: 1 } },
    );
    expect(await failing()).toContain('ledger rows are consistent');
  });

  it('a ledger row removed (money without a trail)', async () => {
    await WalletTransaction.collection.deleteOne({ type: 'RELEASE', bucket: 'AVAILABLE' });
    const f = await failing();
    expect(f).toContain('wallet balances equal the ledger');
  });

  it('pending earnings that do not match the booking state', async () => {
    const b = await Booking.findOne({ status: 'NURSE_PENDING' });
    await Booking.collection.updateOne({ _id: b!._id }, { $set: { status: 'EXPIRED' } }); // fully reversed state, yet still holds pending
    expect(await failing()).toContain('pending earnings equal eligible bookings');
  });

  it('a payment amount that differs from the booking / refund totals that differ from the payment', async () => {
    const p = await Payment.findOne({ status: 'PAID' });
    const original = p!.amountMinor;
    await Payment.collection.updateOne({ _id: p!._id }, { $set: { amountMinor: 1 } });
    expect(await failing()).toContain('payments reconcile with bookings');
    await Payment.collection.updateOne({ _id: p!._id }, { $set: { amountMinor: original } });
    const refunded = await Payment.findOne({ status: { $in: ['REFUNDED', 'PARTIALLY_REFUNDED'] } });
    await Payment.collection.updateOne({ _id: refunded!._id }, { $inc: { refundedMinor: 100 } });
    expect(await failing()).toContain('refunds reconcile with payments');
  });

  it('a paid booking whose payment is missing', async () => {
    const p = await Payment.findOne({ status: 'PAID' });
    await Payment.collection.deleteOne({ _id: p!._id });
    expect(await failing()).toContain('payments reconcile with bookings');
  });

  it('a REFUND_PENDING booking with no refund record', async () => {
    const r = await Booking.findOne({ status: 'REFUND_PENDING' });
    if (!r) {
      // make one: reject the live booking without processing the refund
      const live = await Booking.findOne({ status: 'NURSE_PENDING' });
      await post(nurse.session, `/bookings/${live!._id}/reject`);
    }
    const pending = (await Booking.findOne({ status: 'REFUND_PENDING' }))!;
    await Refund.collection.deleteMany({ bookingId: pending._id });
    expect(await failing()).toContain('every pending booking refund has an obligation');
  });

  it('commission / snapshot arithmetic that does not add up', async () => {
    const b = await Booking.findOne({ status: 'NURSE_PENDING' });
    await Booking.collection.updateOne(
      { _id: b!._id },
      { $set: { 'financialSnapshot.commissionMinor': 5 } },
    );
    const f = await failing();
    expect(f).toContain('commission and allocations reconcile with snapshots');
  });

  it('allocation that does not equal what the patient paid', async () => {
    const c = await Booking.findOne({ cancellationOutcome: { $exists: true } });
    await Booking.collection.updateOne(
      { _id: c!._id },
      { $inc: { 'cancellationOutcome.platformKeptMinor': 7 } },
    );
    expect(await failing()).toContain('commission and allocations reconcile with snapshots');
  });

  it('a payout without its ledger rows, or a paid payout that was not settled', async () => {
    const p = await Payout.findOne({ status: 'PAID' });
    await WalletTransaction.collection.deleteOne({
      idempotencyKey: `payout:${String(p!._id)}:settled`,
    });
    expect(await failing()).toContain('payouts reconcile with the ledger');
  });
});

describe('explicit repair', () => {
  it('only creates missing refund obligations (idempotent, audited); reconciliation alone never repairs', async () => {
    const r = await pay('08:00', '12:00');
    await post(nurse.session, `/bookings/${r.bookingId}/reject`);
    await Refund.collection.deleteMany({ bookingId: oid(r.bookingId) });
    expect(await failing()).toContain('every pending booking refund has an obligation');
    expect(await Refund.countDocuments()).toBe(0); // reconciliation did not repair

    const fixed = await post(admin, '/admin/reconciliation/repair/refund-obligations');
    expect(fixed.body.data.repaired).toBe(1);
    expect(await Refund.countDocuments({ bookingId: r.bookingId })).toBe(1);
    expect(
      (await post(admin, '/admin/reconciliation/repair/refund-obligations')).body.data.repaired,
    ).toBe(0);
    expect(await failing()).toEqual([]);
    expect(
      await AuditLog.countDocuments({ action: 'reconciliation.refund_obligation_repaired' }),
    ).toBe(1);
  });

  it('admin only', async () => {
    for (const who of [patient, nurse.session]) {
      expect((await request(app).get(`${API}/admin/reconciliation`).set(who.auth)).status).toBe(
        403,
      );
      expect((await post(who, '/admin/reconciliation/repair/refund-obligations')).status).toBe(403);
    }
    expect((await request(app).get(`${API}/admin/reconciliation`)).status).toBe(401);
  });
});

describe('P3/E: earnings, ledger chain, orphans, duplicates and amounts', () => {
  const EARN = 'earnings are credited exactly once per paid booking';
  const CHAIN = 'ledger chain is continuous';
  const ORPHAN = 'no orphan ledger rows or duplicate financial references';
  const PAYOUT_AMT = 'payout amounts match their ledger rows';
  const REFUND_AMT = 'refund amounts match obligations and snapshots';

  it('a paid booking whose EARNING credit is missing is detected', async () => {
    const r = await pay('08:00', '12:00');
    expect(await failing()).toEqual([]);
    await WalletTransaction.collection.deleteOne({
      referenceId: oid(r.bookingId),
      type: 'EARNING',
    });
    expect(await failing()).toContain(EARN);
  });

  it('a duplicated EARNING credit is detected (earnings check, duplicate reference, ledger chain)', async () => {
    const r = await pay('08:00', '12:00');
    const row = (await WalletTransaction.collection.findOne({
      referenceId: oid(r.bookingId),
      type: 'EARNING',
    }))!;
    const { _id, ...copy } = row;
    void _id;
    await WalletTransaction.collection.insertOne({
      ...copy,
      idempotencyKey: `${String(row.idempotencyKey)}:dup`,
      seq: (row.seq as number) + 1,
    });
    const bad = await failing();
    expect(bad).toEqual(expect.arrayContaining([EARN, ORPHAN]));
  });

  it('an EARNING credit with the wrong amount is detected', async () => {
    const r = await pay('08:00', '12:00');
    await WalletTransaction.collection.updateOne(
      { referenceId: oid(r.bookingId), type: 'EARNING' },
      { $set: { amountMinor: 1 } },
    );
    expect(await failing()).toContain(EARN);
  });

  it('a zero-earning booking legitimately has no EARNING row and is not flagged', async () => {
    const { booking } = await bookIt(app, patient, {
      serviceId,
      nurseId: nurse.profileId,
      start: at(D, '08:00'),
      end: at(D, '12:00'),
    });
    await Booking.collection.updateOne(
      { _id: oid(booking.body.data.id) },
      {
        $set: {
          'financialSnapshot.nurseEarningMinor': 0,
          'financialSnapshot.commissionMinor': 16000,
          'commissionSnapshot.nurseMinor': 0,
          'commissionSnapshot.platformMinor': 16000,
        },
      },
    );
    const pay1 = await createPayment(app, patient, booking.body.data.id);
    await succeed(app, mock, pay1.body.data.id);
    expect(await WalletTransaction.countDocuments({ type: 'EARNING' })).toBe(0);
    expect(await failing()).toEqual([]);
  });

  it('a gap or reordering in the per-wallet ledger sequence breaks the chain check', async () => {
    await pay('08:00', '12:00');
    await pay('13:00', '16:00');
    await WalletTransaction.collection.updateOne({ seq: 2 }, { $set: { seq: 5 } });
    expect(await failing()).toContain(CHAIN);
  });

  it('a broken balance chain between consecutive rows is detected', async () => {
    await pay('08:00', '12:00');
    await pay('13:00', '16:00');
    await WalletTransaction.collection.updateOne(
      { seq: 2 },
      { $set: { balanceBefore: 1, balanceAfter: 1 + 10000 } },
    );
    expect(await failing()).toContain(CHAIN);
  });

  it('orphan ledger rows (no booking / no payout / no wallet) are detected', async () => {
    const r = await pay('08:00', '12:00');
    await Booking.collection.deleteOne({ _id: oid(r.bookingId) });
    expect(await failing()).toContain(ORPHAN);
  });

  it('a payout whose ledger rows carry a different amount is detected', async () => {
    await pay('08:00', '12:00');
    const { PayoutMethod } = await import('../../src/modules/payouts');
    const b = (await Booking.findOne().lean())!;
    await completeBooking(String(b._id), nurse, app);
    await WalletService.releaseDue(later(49 * 3600));
    await PayoutMethod.create({
      nurseId: nurse.profileId,
      provider: 'mock',
      providerRef: 'mock_acct_123456',
    });
    await PayoutService.request(nurse.profileId, 6000, 'recon-amt-1');
    expect(await failing()).toEqual([]);
    await WalletTransaction.collection.updateOne({ type: 'PAYOUT' }, { $set: { amountMinor: -1 } });
    expect(await failing()).toContain(PAYOUT_AMT);
  });

  it('a refund whose amount differs from the booking obligation or snapshot is detected', async () => {
    const r = await pay('08:00', '12:00');
    await post(nurse.session, `/bookings/${r.bookingId}/reject`);
    await Refund.collection.updateOne(
      { bookingId: oid(r.bookingId) },
      { $set: { amountMinor: 15999 } },
    );
    expect(await failing()).toContain(REFUND_AMT);
  });

  it('a refund whose provider already refunded but is not finalized is flagged', async () => {
    const r = await pay('08:00', '12:00');
    await post(nurse.session, `/bookings/${r.bookingId}/reject`);
    await Refund.collection.updateOne(
      { bookingId: oid(r.bookingId) },
      { $set: { status: 'PROVIDER_SUCCEEDED' } },
    );
    expect(await failing()).toContain(REFUND_AMT);
  });

  it('stays read-only with the new checks', async () => {
    await busyHistory();
    const before = await fingerprint();
    await ReconciliationService.run();
    expect(await fingerprint()).toBe(before);
  });
});
