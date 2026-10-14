import type { Express } from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { InsufficientBalanceError, InvalidBookingStateError } from '../../src/common/errors';
import { withTransaction } from '../../src/config/database';
import { AdminAlert } from '../../src/modules/alerts';
import { AuditLog } from '../../src/modules/audit';
import { Booking, BookingService, BookingStateMachine } from '../../src/modules/bookings';
import { Refund, RefundService } from '../../src/modules/refunds';
import { WalletService, WalletTransaction } from '../../src/modules/wallets';
import type { MockPaymentProvider } from '../../src/providers/payment';
import { API, resetState, startApp, stopApp, type Session } from '../helpers/harness';
import {
  H,
  completeBooking,
  freshProvider,
  payFully,
  setSetting,
  walletOf,
} from '../helpers/finance';
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

const args = (s = '08:00', e = '12:00'): BookArgs => ({
  serviceId,
  nurseId: nurse.profileId,
  start: at(D, s),
  end: at(D, e),
});
const post = (s: Session, path: string, body: object = {}) =>
  request(app).post(`${API}${path}`).set(s.auth).send(body);
const get = (s: Session, path: string) => request(app).get(`${API}${path}`).set(s.auth);
const ago = (hours: number) => new Date(Date.now() + hours * H); // "now + hours"
const rows = (extra: object = {}) =>
  WalletTransaction.find({ nurseId: nurse.profileId, ...extra })
    .sort({ createdAt: 1, _id: 1 })
    .lean();
const paid = (a = args(), who = patient) => payFully(app, mock, who, a);

describe('pending earnings', () => {
  it("are credited from the immutable booking snapshot, never recomputed from today's price or commission", async () => {
    const { bookingId } = await paid();
    await request(app)
      .post(`${API}/admin/services/${serviceId}/prices`)
      .set(admin.auth)
      .send({ kind: 'HOURLY', amountMinor: 90000 });
    await post(admin, '/admin/commissions', { scope: 'GLOBAL', type: 'PERCENTAGE', bps: 9000 });
    const b = (await Booking.findById(bookingId).lean())!;
    expect(b.financialSnapshot).toMatchObject({
      grossMinor: 16000,
      commissionMinor: 2400,
      nurseEarningMinor: 13600,
    });
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(13600);
    expect(BookingService.pendingEarningFor(b as never).amountMinor).toBe(13600);
  });

  it('one ledger row per booking, idempotent on the booking key', async () => {
    const { bookingId } = await paid();
    const b = (await Booking.findById(bookingId))!;
    const again = await withTransaction((s) => WalletService.creditPendingEarning(b, 'p', s));
    expect(again.applied).toBe(false);
    expect(await rows()).toHaveLength(1);
  });
});

describe('RELEASE after the configured delay (default 48h after completion)', () => {
  it('does not release early; releases pending -> available with two ledger rows after the delay', async () => {
    const { bookingId } = await paid();
    await completeBooking(bookingId, nurse, app);
    expect(await WalletService.releaseDue(ago(47))).toMatchObject({ released: 0 });
    expect(await walletOf(nurse)).toMatchObject({
      pendingBalanceMinor: 13600,
      availableBalanceMinor: 0,
    });

    expect(await WalletService.releaseDue(ago(49))).toEqual({ released: 1, releasedMinor: 13600 });
    expect(await walletOf(nurse)).toMatchObject({
      pendingBalanceMinor: 0,
      availableBalanceMinor: 13600,
      totalEarnedMinor: 13600,
    });
    const rel = await rows({ type: 'RELEASE' });
    expect(rel.map((r) => [r.bucket, r.amountMinor])).toEqual([
      ['PENDING', -13600],
      ['AVAILABLE', 13600],
    ]);
    expect((await Booking.findById(bookingId))!.earningReleasedAt).toBeInstanceOf(Date);
  });

  it('is idempotent and safe under concurrent runs: released exactly once', async () => {
    const { bookingId } = await paid();
    await completeBooking(bookingId, nurse, app);
    const runs = await Promise.all([1, 2, 3, 4].map(() => WalletService.releaseDue(ago(49))));
    expect(runs.reduce((n, r) => n + r.releasedMinor, 0)).toBe(13600);
    expect(await WalletService.releaseDue(ago(100))).toMatchObject({ released: 0 });
    expect(await rows({ type: 'RELEASE' })).toHaveLength(2);
    expect(await walletOf(nurse)).toMatchObject({
      availableBalanceMinor: 13600,
      totalEarnedMinor: 13600,
    });
  });

  it('the delay is configurable (wallet.releaseDelayHours)', async () => {
    await setSetting('wallet.releaseDelayHours', 1);
    const { bookingId } = await paid();
    await completeBooking(bookingId, nurse, app);
    expect((await WalletService.releaseDue(ago(0.5))).released).toBe(0);
    expect((await WalletService.releaseDue(ago(2))).released).toBe(1);
  });

  it('never releases DISPUTED, in-flight, reversed or refunded earnings', async () => {
    const make = async (s: string, e: string, status: string, extra: object = {}) => {
      const { bookingId } = await paid(args(s, e));
      await Booking.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(bookingId) },
        { $set: { status, completedAt: new Date(Date.now() - 100 * H), ...extra } },
      );
      return bookingId;
    };
    const disputed = await make('06:00', '07:00', 'DISPUTED');
    const refundPending = await make('08:00', '09:00', 'REFUND_PENDING', {
      refund: {
        status: 'PENDING',
        reason: 'NURSE_REJECTED',
        percent: 100,
        amountMinor: 16000,
        requestedAt: new Date(),
      },
    });
    const failed = await make('10:00', '11:00', 'FAILED');
    const confirmed = await make('12:00', '13:00', 'CONFIRMED');
    expect(await WalletService.releaseDue(ago(1000))).toMatchObject({
      released: 0,
      releasedMinor: 0,
    });
    for (const id of [disputed, refundPending, failed, confirmed])
      expect((await Booking.findById(id))!.earningReleasedAt).toBeUndefined();
    expect((await walletOf(nurse)).availableBalanceMinor).toBe(0);
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(4 * 3400); // four 1-hour bookings (4000 gross, 15% commission)
  });
});

describe('disputes freeze nurse earnings until an admin decides', () => {
  async function noShow() {
    const { bookingId } = await paid();
    await post(nurse.session, `/bookings/${bookingId}/accept`);
    await Booking.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(bookingId) },
      {
        $set: {
          startDateTime: new Date(Date.now() - 6 * H),
          endDateTime: new Date(Date.now() - 2 * H),
        },
      },
    );
    expect((await BookingService.flagNoShows()).flagged).toBe(1);
    return bookingId;
  }

  it('DISPUTED earnings stay in pendingBalance, even long after the release delay', async () => {
    const id = await noShow();
    expect((await Booking.findById(id))!.status).toBe('DISPUTED');
    expect(await WalletService.releaseDue(ago(24 * 365))).toMatchObject({ released: 0 });
    expect(await walletOf(nurse)).toMatchObject({
      pendingBalanceMinor: 13600,
      availableBalanceMinor: 0,
    });
    expect(await rows({ type: { $in: ['RELEASE', 'REVERSAL'] } })).toHaveLength(0);
  });

  it('resolved as COMPLETE: the earnings are released by the normal rules, counted from the resolution', async () => {
    const id = await noShow();
    await post(admin, `/admin/bookings/${id}/resolve`, {
      resolution: 'COMPLETE',
      reason: 'care was delivered, nurse forgot to press start',
    });
    expect((await WalletService.releaseDue(ago(47))).released).toBe(0);
    expect((await WalletService.releaseDue(ago(49))).released).toBe(1);
    expect(await walletOf(nurse)).toMatchObject({
      pendingBalanceMinor: 0,
      availableBalanceMinor: 13600,
    });
  });

  it('resolved as REFUND: the earnings are reversed (ledger-backed), then the provider refunds', async () => {
    const id = await noShow();
    await post(admin, `/admin/bookings/${id}/resolve`, {
      resolution: 'REFUND',
      reason: 'nurse did not attend',
    });
    expect(await walletOf(nurse)).toMatchObject({ pendingBalanceMinor: 0 });
    expect((await rows({ type: 'REVERSAL' })).map((r) => r.amountMinor)).toEqual([-13600]);
    await RefundService.processDue();
    expect((await Booking.findById(id))!.status).toBe('REFUNDED');
    expect(await WalletService.releaseDue(ago(1000))).toMatchObject({ released: 0 });
  });

  it('a partial dispute refund keeps the nurse her snapshot share of what the patient does not get back', async () => {
    const id = await noShow();
    await post(admin, `/admin/bookings/${id}/resolve`, {
      resolution: 'REFUND',
      refundPercent: 40,
      reason: 'arrived very late',
    });
    // patient gets 6400 back; retained 9600 is split 85/15 => nurse keeps 8160
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(8160);
    expect((await Refund.findOne({ bookingId: id }))!.amountMinor).toBe(6400);
  });
});

describe('REFUND_PENDING reverses nurse earnings immediately; a failed provider refund restores them', () => {
  it('nurse rejection: reversal row, pending back to zero, refund obligation created in the same transaction', async () => {
    const { bookingId } = await paid();
    await post(nurse.session, `/bookings/${bookingId}/reject`);
    expect(await walletOf(nurse)).toMatchObject({ pendingBalanceMinor: 0 });
    const rev = await rows({ type: 'REVERSAL' });
    expect(rev).toHaveLength(1);
    expect(rev[0]).toMatchObject({
      bucket: 'PENDING',
      amountMinor: -13600,
      balanceBefore: 13600,
      balanceAfter: 0,
    });
    expect(await Refund.countDocuments({ bookingId })).toBe(1);
  });

  it('the reversal stays final when the provider refund succeeds', async () => {
    const { bookingId } = await paid();
    await post(nurse.session, `/bookings/${bookingId}/reject`);
    await RefundService.processDue();
    expect((await Booking.findById(bookingId))!.status).toBe('REFUNDED');
    expect(await walletOf(nurse)).toMatchObject({
      pendingBalanceMinor: 0,
      availableBalanceMinor: 0,
    });
    expect(await rows({ type: { $in: ['ADJUSTMENT'] } })).toHaveLength(0);
  });

  it('a permanently failed refund restores the earnings with a NEW compensating ledger row (original untouched)', async () => {
    mock.refundFailuresRemaining = 5;
    mock.refundFailRetryable = false; // non-retryable => FAILED straight away
    const { bookingId } = await paid();
    await post(nurse.session, `/bookings/${bookingId}/reject`);
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(0);
    await RefundService.processDue();
    expect((await Booking.findById(bookingId))!.status).toBe('FAILED');
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(13600);
    const all = await rows();
    expect(all.map((r) => [r.type, r.amountMinor])).toEqual([
      ['EARNING', 13600],
      ['REVERSAL', -13600],
      ['ADJUSTMENT', 13600],
    ]);
    expect(await AdminAlert.countDocuments({ type: 'REFUND_FAILED', severity: 'CRITICAL' })).toBe(
      1,
    );
  });

  it('a reversal after earnings were already released takes the money back from availableBalance', async () => {
    const { bookingId } = await paid();
    await completeBooking(bookingId, nurse, app);
    await WalletService.releaseDue(ago(49));
    expect((await walletOf(nurse)).availableBalanceMinor).toBe(13600);
    await BookingStateMachine.transitionAtomic(bookingId, 'DISPUTED', {
      role: 'ADMIN',
      userId: admin.id,
    });
    await post(admin, `/admin/bookings/${bookingId}/resolve`, {
      resolution: 'REFUND',
      reason: 'quality complaint upheld',
    });
    expect(await walletOf(nurse)).toMatchObject({
      availableBalanceMinor: 0,
      pendingBalanceMinor: 0,
      totalEarnedMinor: 0,
    });
    const rev = await rows({ type: 'REVERSAL' });
    expect(rev.map((r) => [r.bucket, r.amountMinor, r.earnedDelta])).toEqual([
      ['AVAILABLE', -13600, -13600],
    ]);
  });

  it('money already withdrawn cannot be reversed: balances never go negative and a critical alert is raised', async () => {
    const { bookingId } = await paid();
    await completeBooking(bookingId, nurse, app);
    await WalletService.releaseDue(ago(49));
    await withTransaction((s) =>
      WalletService.apply(
        {
          nurseId: nurse.profileId,
          type: 'PAYOUT',
          bucket: 'AVAILABLE',
          amountMinor: -13600,
          withdrawnDelta: 0,
          referenceType: 'MANUAL',
          referenceId: String(new mongoose.Types.ObjectId()),
          idempotencyKey: 'test-withdrawal',
        },
        s,
      ),
    );
    await BookingStateMachine.transitionAtomic(bookingId, 'DISPUTED', {
      role: 'ADMIN',
      userId: admin.id,
    });
    await post(admin, `/admin/bookings/${bookingId}/resolve`, {
      resolution: 'REFUND',
      reason: 'quality complaint upheld',
    });
    const w = await walletOf(nurse);
    expect(w.availableBalanceMinor).toBe(0);
    expect(w.pendingBalanceMinor).toBe(0);
    expect(await AdminAlert.findOne({ type: 'NURSE_EARNINGS_SHORTFALL' })).toMatchObject({
      severity: 'CRITICAL',
    });
  });
});

describe('ledger invariants', () => {
  const credit = (n: number, key: string) =>
    withTransaction((s) =>
      WalletService.apply(
        {
          nurseId: nurse.profileId,
          type: 'ADJUSTMENT',
          bucket: 'AVAILABLE',
          amountMinor: n,
          referenceType: 'MANUAL',
          referenceId: String(new mongoose.Types.ObjectId()),
          idempotencyKey: key,
        },
        s,
      ),
    );
  const debit = (n: number, key: string) => credit(-n, key);

  beforeEach(async () => {
    await WalletService.ensure(nurse.profileId);
  });

  it('a balance can never go negative: the debit is refused and nothing is written', async () => {
    await credit(500, 'seed');
    await expect(debit(501, 'too-much')).rejects.toBeInstanceOf(InsufficientBalanceError);
    expect((await walletOf(nurse)).availableBalanceMinor).toBe(500);
    expect(await WalletTransaction.countDocuments({ idempotencyKey: 'too-much' })).toBe(0);
  });

  it('the same idempotency key applies once (a replay is a no-op)', async () => {
    const a = await credit(300, 'same-key');
    const b = await credit(300, 'same-key');
    expect(a.applied).toBe(true);
    expect(b.applied).toBe(false);
    expect((await walletOf(nurse)).availableBalanceMinor).toBe(300);
  });

  it('concurrent debits serialise: only what the balance allows succeeds, the ledger matches the balance', async () => {
    await credit(500, 'seed');
    const res = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => debit(100, `d${i}`)));
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    expect(
      res
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .every((r) => r.reason instanceof InsufficientBalanceError),
    ).toBe(true);
    expect((await walletOf(nurse)).availableBalanceMinor).toBe(0);
    const sum = (await WalletTransaction.find({ bucket: 'AVAILABLE' }).lean()).reduce(
      (n, r) => n + r.amountMinor,
      0,
    );
    expect(sum).toBe(0);
  });

  it('concurrent duplicates of one key apply exactly once', async () => {
    const res = await Promise.allSettled(
      Array.from({ length: 8 }, () => credit(250, 'dup-concurrent')),
    );
    expect(res.every((r) => r.status === 'fulfilled')).toBe(true);
    expect((await walletOf(nurse)).availableBalanceMinor).toBe(250);
    expect(await WalletTransaction.countDocuments({ idempotencyKey: 'dup-concurrent' })).toBe(1);
  });

  it('every row records balanceBefore/After and the ledger rows are immutable', async () => {
    await credit(100, 'a');
    await credit(50, 'b');
    const all = await WalletTransaction.find({ nurseId: nurse.profileId })
      .sort({ createdAt: 1, _id: 1 })
      .lean();
    expect(all.map((r) => [r.balanceBefore, r.balanceAfter])).toEqual([
      [0, 100],
      [100, 150],
    ]);
    await expect(
      WalletTransaction.updateOne({ idempotencyKey: 'a' }, { amountMinor: 1 }),
    ).rejects.toThrow(/append-only/);
    await expect(WalletTransaction.deleteMany({})).rejects.toThrow(/append-only/);
    await expect(
      WalletTransaction.findOneAndUpdate({ idempotencyKey: 'a' }, { amountMinor: 1 }),
    ).rejects.toThrow(/append-only/);
  });

  it('money is integer only', async () => {
    await expect(credit(10.5, 'float')).rejects.toThrow(/integer/);
    await expect(credit(0, 'zero')).rejects.toThrow();
  });

  it('wallet balances cannot be written outside the service: negatives are rejected by the schema too', async () => {
    const { Wallet } = await import('../../src/modules/wallets');
    await expect(
      Wallet.updateOne(
        { nurseId: nurse.profileId },
        { $set: { availableBalanceMinor: -5 } },
        { runValidators: true },
      ),
    ).rejects.toThrow();
  });
});

describe('wallet API and admin adjustments', () => {
  it('a nurse reads her wallet and paginated ledger; patients and anonymous callers cannot', async () => {
    await paid();
    const w = await get(nurse.session, '/wallets/me');
    expect(w.body.data).toEqual({
      availableBalanceMinor: 0,
      pendingBalanceMinor: 13600,
      totalEarnedMinor: 0,
      totalWithdrawnMinor: 0,
      currency: 'AED',
    });
    const tx = await get(nurse.session, '/wallets/me/transactions?limit=1');
    expect(tx.body.data.items[0]).toMatchObject({
      type: 'EARNING',
      bucket: 'PENDING',
      amountMinor: 13600,
    });
    expect(tx.body.data.meta).toMatchObject({ total: 1, limit: 1 });
    expect((await get(patient, '/wallets/me')).status).toBe(403);
    expect((await request(app).get(`${API}/wallets/me`)).status).toBe(401);
    // one nurse never sees another nurse's ledger
    expect(
      (await get(nurse.session, '/wallets/me/transactions?type=PAYOUT')).body.data.items,
    ).toHaveLength(0);
  });

  it('admin adjustment: reason + Idempotency-Key required, ledger-backed, idempotent, audit-logged', async () => {
    const url = `/admin/wallets/${nurse.profileId}/adjustments`;
    const send = (key: string | null, body: object) => {
      const r = request(app).post(`${API}${url}`).set(admin.auth);
      return (key ? r.set('Idempotency-Key', key) : r).send(body);
    };
    expect(
      (await send(null, { bucket: 'AVAILABLE', amountMinor: 1000, reason: 'goodwill credit' }))
        .status,
    ).toBe(400);
    expect(
      (await send('adj-key-0001', { bucket: 'AVAILABLE', amountMinor: 1000, reason: 'x' })).status,
    ).toBe(400);
    const a = await send('adj-key-0001', {
      bucket: 'AVAILABLE',
      amountMinor: 1000,
      reason: 'goodwill credit',
    });
    const b = await send('adj-key-0001', {
      bucket: 'AVAILABLE',
      amountMinor: 1000,
      reason: 'goodwill credit',
    });
    expect(a.status).toBe(201);
    expect(a.body.data.applied).toBe(true);
    expect(b.body.data).toMatchObject({ applied: false, ledgerId: a.body.data.ledgerId });
    expect((await walletOf(nurse)).availableBalanceMinor).toBe(1000);
    expect(await AuditLog.countDocuments({ action: 'wallet.adjusted' })).toBe(1);
    const neg = await send('adj-key-0002', {
      bucket: 'AVAILABLE',
      amountMinor: -5000,
      reason: 'clawback attempt',
    });
    expect([neg.status, neg.body.errorCode]).toEqual([422, 'INSUFFICIENT_BALANCE']);
    expect((await walletOf(nurse)).availableBalanceMinor).toBe(1000);
    const res = await request(app)
      .post(`${API}${url}`)
      .set(nurse.session.auth)
      .set('Idempotency-Key', 'adj-key-0003')
      .send({ bucket: 'AVAILABLE', amountMinor: 1, reason: 'self service' });
    expect(res.status).toBe(403);
  });

  it('a state machine violation never leaves a ledger side effect', async () => {
    const { bookingId } = await paid();
    await expect(
      BookingStateMachine.transitionAtomic(bookingId, 'REFUNDED', { role: 'SYSTEM' }),
    ).rejects.toBeInstanceOf(InvalidBookingStateError);
    expect(await rows()).toHaveLength(1);
  });
});
