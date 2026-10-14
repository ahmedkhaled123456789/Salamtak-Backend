import mongoose, { type ClientSession } from 'mongoose';
import { InsufficientBalanceError } from '../../common/errors';
import { withTransaction } from '../../config/database';
import { AlertService } from '../alerts';
import { Booking, allocateRetained, type BookingDoc } from '../bookings';
import { isReleasable } from './wallet.release';
import { notifyNurse } from '../notifications';
import { SettingsService } from '../settings';
import {
  Wallet,
  WalletTransaction,
  type LedgerType,
  type WalletDoc,
  type WalletTransactionDoc,
} from './wallet.models';

const HOUR = 3_600_000;

export interface LedgerEntryInput {
  nurseId: string;
  type: LedgerType;
  bucket: 'PENDING' | 'AVAILABLE' | 'NONE';
  /** Signed change of the bucket (integer fils). */
  amountMinor: number;
  earnedDelta?: number;
  withdrawnDelta?: number;
  referenceType: 'BOOKING' | 'PAYMENT' | 'REFUND' | 'PAYOUT' | 'MANUAL';
  referenceId: string;
  /** Globally unique. A repeat is a no-op, so retries/duplicate webhooks can never double-apply. */
  idempotencyKey: string;
  note?: string;
  createdBy?: string;
}

const field = (b: 'PENDING' | 'AVAILABLE') =>
  b === 'PENDING' ? 'pendingBalanceMinor' : 'availableBalanceMinor';

export const WalletService = {
  /**
   * Creates the wallet if it does not exist. Call OUTSIDE (before) the money transaction: creating
   * documents by upsert inside concurrent transactions can abort them on a duplicate key.
   */
  async ensure(nurseId: string): Promise<WalletDoc> {
    for (let i = 0; i < 3; i++) {
      const w = await Wallet.findOne({ nurseId });
      if (w) return w;
      try {
        return await Wallet.create({ nurseId });
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) throw err;
      }
    }
    return (await Wallet.findOne({ nurseId })) as WalletDoc;
  },

  /**
   * THE ONLY function that changes a wallet balance. Within the caller's transaction it
   *  1. returns early if the idempotency key was already applied,
   *  2. conditionally $inc's the balance (a debit can never take a bucket below zero),
   *  3. inserts the immutable ledger row with balanceBefore/After.
   * Concurrent operations on one wallet serialise on the wallet document (write conflict + retry).
   */
  async apply(
    e: LedgerEntryInput,
    session: ClientSession,
  ): Promise<{ applied: boolean; tx: WalletTransactionDoc }> {
    const existing = await WalletTransaction.findOne({ idempotencyKey: e.idempotencyKey }).session(
      session,
    );
    if (existing) return { applied: false, tx: existing };

    if (!Number.isSafeInteger(e.amountMinor)) throw new Error('ledger amount must be an integer');
    if (e.bucket === 'NONE' ? e.amountMinor !== 0 : e.amountMinor === 0)
      throw new Error('ledger amount must be non-zero for a balance bucket and zero for NONE');
    const earned = e.earnedDelta ?? 0;
    const withdrawn = e.withdrawnDelta ?? 0;

    const wallet = await Wallet.findOne({ nurseId: e.nurseId }).session(session);
    if (!wallet)
      throw new Error('wallet missing: call WalletService.ensure() before the transaction');

    const filter: Record<string, unknown> = { _id: wallet._id };
    const inc: Record<string, number> = { version: 1 };
    if (e.bucket !== 'NONE') {
      const f = field(e.bucket);
      inc[f] = e.amountMinor;
      if (e.amountMinor < 0) filter[f] = { $gte: -e.amountMinor };
    }
    if (earned) {
      inc.totalEarnedMinor = earned;
      if (earned < 0) filter.totalEarnedMinor = { $gte: -earned };
    }
    if (withdrawn) {
      inc.totalWithdrawnMinor = withdrawn;
      if (withdrawn < 0) filter.totalWithdrawnMinor = { $gte: -withdrawn };
    }
    const before = await Wallet.findOneAndUpdate(
      filter,
      { $inc: inc },
      {
        returnDocument: 'before',
        session,
      },
    );
    if (!before) throw new InsufficientBalanceError();

    const balanceBefore = e.bucket === 'NONE' ? 0 : (before[field(e.bucket)] as number);
    const [tx] = await WalletTransaction.create(
      [
        {
          walletId: wallet._id,
          nurseId: e.nurseId,
          type: e.type,
          bucket: e.bucket,
          amountMinor: e.amountMinor,
          balanceBefore,
          balanceAfter: balanceBefore + e.amountMinor,
          earnedDelta: earned,
          withdrawnDelta: withdrawn,
          referenceType: e.referenceType,
          referenceId: e.referenceId,
          idempotencyKey: e.idempotencyKey,
          seq: (before.version as number) + 1,
          note: e.note,
          createdBy: e.createdBy,
        },
      ],
      { session },
    );
    return { applied: true, tx: tx! };
  },

  /** What the ledger currently holds for one booking, per bucket (derived from rows, not balances). */
  async bookingNet(
    bookingId: string,
    session?: ClientSession,
  ): Promise<{ pending: number; available: number }> {
    const rows = await WalletTransaction.aggregate<{ _id: string; sum: number }>([
      { $match: { referenceType: 'BOOKING', referenceId: new mongoose.Types.ObjectId(bookingId) } },
      { $group: { _id: '$bucket', sum: { $sum: '$amountMinor' } } },
    ]).session(session ?? null);
    const get = (b: string) => rows.find((r) => r._id === b)?.sum ?? 0;
    return { pending: get('PENDING'), available: get('AVAILABLE') };
  },

  /** Payment confirmed: credit the booking's SNAPSHOTTED nurse earning to pendingBalance. */
  async creditPendingEarning(b: BookingDoc, paymentId: string, session: ClientSession) {
    const amount = b.financialSnapshot!.nurseEarningMinor;
    if (amount <= 0) return { applied: false };
    return this.apply(
      {
        nurseId: String(b.nurseId),
        type: 'EARNING',
        bucket: 'PENDING',
        amountMinor: amount,
        referenceType: 'BOOKING',
        referenceId: String(b._id),
        idempotencyKey: `wallet:pending-earning:${String(b._id)}`,
        note: `payment ${paymentId}`,
      },
      session,
    );
  },

  /**
   * A refund obligation exists: take back the nurse earnings the refund removes, immediately.
   * The nurse keeps her snapshot-based share of whatever the patient does NOT get back
   * (allocateRetained). Reverses from pending first, then from already released funds; anything the
   * nurse has meanwhile withdrawn cannot be reversed and raises an alert (never a negative balance).
   */
  async reverseForRefund(
    b: BookingDoc,
    refundMinor: number,
    generation: number,
    session: ClientSession,
  ): Promise<{ reversedMinor: number; shortfallMinor: number }> {
    const earning = b.financialSnapshot!.nurseEarningMinor;
    const { nurseShareMinor } = allocateRetained({
      paidMinor: b.pricingSnapshot!.patientPayableMinor,
      refundMinor,
      nurseEarningMinor: earning,
      refundPercent: b.refund?.percent ?? undefined,
    });
    const net = await this.bookingNet(String(b._id), session);
    const held = net.pending + net.available;
    if (held <= 0) return { reversedMinor: 0, shortfallMinor: 0 }; // nothing was ever credited
    const target = Math.min(earning - nurseShareMinor, held);
    if (target <= 0) return { reversedMinor: 0, shortfallMinor: 0 };

    const wallet = await Wallet.findOne({ nurseId: b.nurseId }).session(session);
    const fromPending = Math.min(net.pending, target);
    const fromAvailable = Math.min(
      net.available,
      target - fromPending,
      wallet?.availableBalanceMinor ?? 0,
    );
    const id = String(b._id);
    const base = {
      nurseId: String(b.nurseId),
      type: 'REVERSAL' as const,
      referenceType: 'BOOKING' as const,
      referenceId: id,
    };
    if (fromPending > 0)
      await this.apply(
        {
          ...base,
          bucket: 'PENDING',
          amountMinor: -fromPending,
          idempotencyKey: `reversal:${id}:g${generation}:pending`,
          note: 'refund: pending earnings reversed',
        },
        session,
      );
    if (fromAvailable > 0)
      await this.apply(
        {
          ...base,
          bucket: 'AVAILABLE',
          amountMinor: -fromAvailable,
          earnedDelta: -fromAvailable,
          idempotencyKey: `reversal:${id}:g${generation}:available`,
          note: 'refund: released earnings reversed',
        },
        session,
      );
    const shortfall = target - fromPending - fromAvailable;
    if (shortfall > 0) {
      await AlertService.raise(
        {
          key: `earnings-shortfall:${id}:g${generation}`,
          type: 'NURSE_EARNINGS_SHORTFALL',
          severity: 'CRITICAL',
          entity: 'Booking',
          entityId: id,
          message: `Could not reverse ${shortfall} fils of nurse earnings (already withdrawn)`,
          data: { shortfallMinor: shortfall },
        },
        session,
      );
    }
    return { reversedMinor: fromPending + fromAvailable, shortfallMinor: shortfall };
  },

  /**
   * The provider refund permanently failed: put the reversed earnings back with new, compensating
   * ledger rows (the original reversal rows are never edited or deleted).
   */
  async restoreAfterRefundFailure(
    b: BookingDoc,
    refundId: string,
    generation: number,
    session: ClientSession,
  ): Promise<{ restoredMinor: number }> {
    const id = String(b._id);
    const rows = await WalletTransaction.find({
      referenceType: 'BOOKING',
      referenceId: id,
      idempotencyKey: { $regex: `^reversal:${id}:g${generation}:` },
    }).session(session);
    let restored = 0;
    for (const bucket of ['PENDING', 'AVAILABLE'] as const) {
      const amount = -rows
        .filter((r) => r.bucket === bucket)
        .reduce((n, r) => n + r.amountMinor, 0);
      if (amount <= 0) continue;
      restored += amount;
      await this.apply(
        {
          nurseId: String(b.nurseId),
          type: 'ADJUSTMENT',
          bucket,
          amountMinor: amount,
          earnedDelta: bucket === 'AVAILABLE' ? amount : 0,
          referenceType: 'BOOKING',
          referenceId: id,
          idempotencyKey: `refund-restore:${refundId}:${bucket.toLowerCase()}`,
          note: 'refund failed at the provider: earnings restored',
        },
        session,
      );
    }
    return { restoredMinor: restored };
  },

  /**
   * A refund that was FAILED (earnings restored by compensating rows) turned out to have succeeded at
   * the provider: take the restored amounts back out, again with new ledger rows (nothing is edited).
   * Bounded by the live balances; anything already withdrawn raises a shortfall alert.
   */
  async undoRestoreAfterRefundSuccess(
    b: BookingDoc,
    refundId: string,
    session: ClientSession,
  ): Promise<{ undoneMinor: number; shortfallMinor: number }> {
    const id = String(b._id);
    const rows = await WalletTransaction.find({
      referenceType: 'BOOKING',
      referenceId: id,
      idempotencyKey: { $regex: `^refund-restore:${refundId}:` },
    }).session(session);
    const wallet = await Wallet.findOne({ nurseId: b.nurseId }).session(session);
    let undone = 0;
    let shortfall = 0;
    for (const bucket of ['PENDING', 'AVAILABLE'] as const) {
      const restored = rows
        .filter((r) => r.bucket === bucket)
        .reduce((n, r) => n + r.amountMinor, 0);
      if (restored <= 0) continue;
      const live =
        bucket === 'PENDING'
          ? (wallet?.pendingBalanceMinor ?? 0)
          : (wallet?.availableBalanceMinor ?? 0);
      const take = Math.min(restored, live);
      shortfall += restored - take;
      if (take <= 0) continue;
      undone += take;
      await this.apply(
        {
          nurseId: String(b.nurseId),
          type: 'REVERSAL',
          bucket,
          amountMinor: -take,
          earnedDelta: bucket === 'AVAILABLE' ? -take : 0,
          referenceType: 'BOOKING',
          referenceId: id,
          idempotencyKey: `refund-unrestore:${refundId}:${bucket.toLowerCase()}`,
          note: 'refund confirmed by the provider after being marked failed: restored earnings reversed again',
        },
        session,
      );
    }
    if (shortfall > 0)
      await AlertService.raise(
        {
          key: `earnings-shortfall:${id}:unrestore:${refundId}`,
          type: 'NURSE_EARNINGS_SHORTFALL',
          severity: 'CRITICAL',
          entity: 'Booking',
          entityId: id,
          message: `Could not take back ${shortfall} fils restored to the nurse (already moved/withdrawn)`,
          data: { shortfallMinor: shortfall },
        },
        session,
      );
    return { undoneMinor: undone, shortfallMinor: shortfall };
  },

  /** RELEASE one booking's pending earnings to available. Idempotent; never touches DISPUTED/FAILED. */
  async releaseBooking(
    bookingId: string,
    now: Date,
    session: ClientSession,
  ): Promise<{ releasedMinor: number; blocked?: boolean }> {
    // Eligibility is decided HERE, from the booking as it is now, inside the money transaction.
    // The candidate query in releaseDue is only a hint: a dispute/refund may have landed since.
    const b = await Booking.findById(bookingId).session(session);
    if (!b || b.earningReleasedAt) return { releasedMinor: 0 };
    const settings = await SettingsService.getAll();
    const cutoff = new Date(now.getTime() - settings['wallet.releaseDelayHours'] * HOUR);
    if (!isReleasable(b, cutoff)) return { releasedMinor: 0, blocked: true };
    const net = await this.bookingNet(bookingId, session);
    if (net.pending > 0) {
      await this.apply(
        {
          nurseId: String(b.nurseId),
          type: 'RELEASE',
          bucket: 'PENDING',
          amountMinor: -net.pending,
          referenceType: 'BOOKING',
          referenceId: bookingId,
          idempotencyKey: `release:${bookingId}:pending`,
        },
        session,
      );
      await this.apply(
        {
          nurseId: String(b.nurseId),
          type: 'RELEASE',
          bucket: 'AVAILABLE',
          amountMinor: net.pending,
          earnedDelta: net.pending,
          referenceType: 'BOOKING',
          referenceId: bookingId,
          idempotencyKey: `release:${bookingId}:available`,
        },
        session,
      );
    }
    await Booking.updateOne({ _id: bookingId }, { $set: { earningReleasedAt: now } }, { session });
    if (net.pending > 0)
      await notifyNurse(
        String(b.nurseId),
        {
          type: 'EARNINGS_RELEASED',
          title: 'Earnings released',
          body: `AED ${(net.pending / 100).toFixed(2)} for booking ${b.bookingNumber} is now available.`,
          data: { bookingId, amountMinor: net.pending },
          referenceKey: bookingId,
          channels: ['PUSH'],
        },
        session,
      );
    return { releasedMinor: Math.max(net.pending, 0) };
  },

  /**
   * Releases earnings that passed the configured delay (wallet.releaseDelayHours, default 48h):
   *  - COMPLETED bookings, counted from completion;
   *  - CANCELLED / REFUNDED bookings, only the share the nurse legitimately keeps (what is left in
   *    pending after the reversal), counted from the cancellation / refund completion.
   * DISPUTED, FAILED, REFUND_PENDING and every other state are frozen: never released.
   */
  async releaseDue(
    now = new Date(),
    limit = 200,
  ): Promise<{ released: number; releasedMinor: number }> {
    const settings = await SettingsService.getAll();
    const cutoff = new Date(now.getTime() - settings['wallet.releaseDelayHours'] * HOUR);
    const rows = await Booking.find({
      earningReleasedAt: { $exists: false },
      paidAt: { $exists: true },
      $or: [
        { status: 'COMPLETED', completedAt: { $lte: cutoff } },
        { status: { $in: ['CANCELLED', 'REFUNDED'] } },
      ],
    })
      .select('_id status completedAt cancelledAt refund')
      .limit(limit)
      .lean();
    let released = 0;
    let releasedMinor = 0;
    for (const r of rows) {
      if (r.status !== 'COMPLETED') {
        const ref = r.refund?.completedAt ?? r.cancelledAt;
        if (!ref || ref > cutoff) continue;
      }
      const res = await withTransaction((session) =>
        this.releaseBooking(String(r._id), now, session),
      );
      if (res.releasedMinor > 0) {
        released += 1;
        releasedMinor += res.releasedMinor;
      }
    }
    return { released, releasedMinor };
  },

  /** Admin adjustment (positive or negative) with a mandatory reason. Idempotent per key. */
  async adjust(a: {
    nurseId: string;
    bucket: 'PENDING' | 'AVAILABLE';
    amountMinor: number;
    reason: string;
    key: string;
    adminId?: string;
  }): Promise<{ applied: boolean; tx: WalletTransactionDoc }> {
    await this.ensure(a.nurseId);
    return withTransaction((session) =>
      this.apply(
        {
          nurseId: a.nurseId,
          type: 'ADJUSTMENT',
          bucket: a.bucket,
          amountMinor: a.amountMinor,
          referenceType: 'MANUAL',
          referenceId: String(new mongoose.Types.ObjectId()),
          idempotencyKey: `adjustment:${a.nurseId}:${a.key}`,
          note: a.reason,
          createdBy: a.adminId,
        },
        session,
      ),
    );
  },

  getByNurse: (nurseId: string) => Wallet.findOne({ nurseId }),
};
