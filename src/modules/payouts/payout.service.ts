import type { ClientSession } from 'mongoose';
import {
  AppError,
  ConflictError,
  InsufficientBalanceError,
  NotFoundError,
} from '../../common/errors';
import { withTransaction } from '../../config/database';
import {
  getPayoutProvider,
  ProviderError,
  type PaymentProvider,
  type PayoutProvider,
  type PayoutResult,
  type ProviderEvent,
} from '../../providers/payment';
import { AlertService } from '../alerts';
import { notifyNurse } from '../notifications';
import { SettingsService } from '../settings';
import { WalletService } from '../wallets';
import { Payout, PayoutMethod, type PayoutDoc } from './payout.models';

const LEASE_MS = 5 * 60_000;
const MAX_BACKOFF_SECONDS = 6 * 3600;
const backoff = (failures: number, base: number) =>
  Math.min(base * 2 ** Math.max(0, failures - 1), MAX_BACKOFF_SECONDS);
const payoutKey = (p: Pick<PayoutDoc, '_id' | 'providerKeySeq'>) =>
  p.providerKeySeq ? `payout-${String(p._id)}-${p.providerKeySeq}` : `payout-${String(p._id)}`;
const clean = (m: string) =>
  m
    .replace(/\b(sk|rk|pk|whsec)_[A-Za-z0-9_]+/g, '[redacted]')
    .replace(/\b\d{12,19}\b/g, '[redacted]')
    .slice(0, 300);

export const PayoutService = {
  /**
   * Payout request: debits availableBalance (ledger row PAYOUT, conditional so the balance can never
   * go negative) and creates the PENDING payout, atomically. Only AVAILABLE funds are ever payable.
   * Idempotent per (nurse, key); at most one open payout per nurse (unique partial index).
   */
  async request(
    nurseId: string,
    amountMinor: number | undefined,
    key: string,
    opts: { inTxn?: (session: ClientSession, payout: PayoutDoc) => Promise<void> } = {},
  ): Promise<PayoutDoc> {
    const settings = await SettingsService.getAll();
    const method = await PayoutMethod.findOne({ nurseId });
    if (!method)
      throw new AppError(
        422,
        'PAYOUT_METHOD_REQUIRED',
        'Add a payout method before requesting a payout',
      );
    const wallet = await WalletService.ensure(nurseId);
    const idemKey = `payout-request:${nurseId}:${key}`;
    try {
      return await withTransaction(async (session) => {
        const dup = await Payout.findOne({ idempotencyKey: idemKey }).session(session);
        if (dup) return dup;
        const w = await WalletService.getByNurse(nurseId).session(session);
        const amount = amountMinor ?? w!.availableBalanceMinor;
        if (amount < settings['payout.minAmountMinor'])
          throw new AppError(
            422,
            'PAYOUT_BELOW_MINIMUM',
            `The minimum payout is ${settings['payout.minAmountMinor']} fils`,
          );
        if (amount > w!.availableBalanceMinor) {
          throw new InsufficientBalanceError('Requested amount exceeds your available balance');
        }
        const [payout] = await Payout.create(
          [
            {
              nurseId,
              walletId: wallet._id,
              amountMinor: amount,
              status: 'PENDING',
              provider: method.provider,
              providerRef: method.providerRef,
              idempotencyKey: idemKey,
              nextRetryAt: new Date(),
            },
          ],
          { session },
        );
        await WalletService.apply(
          {
            nurseId,
            type: 'PAYOUT',
            bucket: 'AVAILABLE',
            amountMinor: -amount,
            referenceType: 'PAYOUT',
            referenceId: String(payout!._id),
            idempotencyKey: `payout:${String(payout!._id)}:request`,
          },
          session,
        );
        await notifyNurse(
          nurseId,
          {
            type: 'PAYOUT_SUBMITTED',
            title: 'Payout submitted',
            body: `Your payout of AED ${(amount / 100).toFixed(2)} was submitted.`,
            data: { payoutId: String(payout!._id), amountMinor: amount },
            referenceKey: String(payout!._id),
            channels: ['PUSH'],
          },
          session,
        );
        await opts.inTxn?.(session, payout!);
        return payout!;
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000)
        throw new ConflictError('You already have a payout in progress', 'PAYOUT_ALREADY_OPEN');
      throw err;
    }
  },

  async process(
    payoutId: string,
    now = new Date(),
  ): Promise<{
    outcome: 'PAID' | 'PENDING_PROVIDER' | 'FINALIZE_PENDING' | 'RETRY' | 'FAILED' | 'SKIPPED';
  }> {
    // Provider already paid: only local settlement is left. Never call the provider again.
    const fin = await Payout.findOneAndUpdate(
      { _id: payoutId, status: 'PROVIDER_PAID', nextRetryAt: { $lte: now } },
      { $set: { lastAttemptAt: now, nextRetryAt: new Date(now.getTime() + LEASE_MS) } },
      { new: true },
    );
    if (fin) return { outcome: await this.finalizeLocally(fin, now) };
    const payout = await Payout.findOneAndUpdate(
      { _id: payoutId, status: { $in: ['PENDING', 'PROCESSING'] }, nextRetryAt: { $lte: now } },
      {
        $set: {
          status: 'PROCESSING',
          lastAttemptAt: now,
          nextRetryAt: new Date(now.getTime() + LEASE_MS),
        },
        $inc: { attempts: 1 },
      },
      { new: true },
    );
    if (!payout) return { outcome: 'SKIPPED' };
    const provider = getPayoutProvider() as Partial<PaymentProvider> & PayoutProvider;
    let res: PayoutResult;
    try {
      if (payout.providerPayoutId && provider.getPayout) {
        // accepted asynchronously earlier: ask, never pay again
        res = await provider.getPayout(payout.providerPayoutId);
      } else {
        res = await provider.createPayout({
          providerRef: payout.providerRef,
          amountMinor: payout.amountMinor,
          currency: payout.currency,
          idempotencyKey: payoutKey(payout),
          reference: `PO-${String(payout._id)}`,
        });
      }
    } catch (err) {
      return { outcome: await this.recordFailure(String(payout._id), err, now) };
    }
    // From here the provider has answered: local problems must never be treated as provider failures.
    if (res.status === 'PAID') {
      try {
        await Payout.updateOne(
          { _id: payout._id, status: { $in: ['PENDING', 'PROCESSING'] } },
          {
            $set: {
              status: 'PROVIDER_PAID',
              providerPayoutId: res.providerPayoutId,
              providerPaidAt: now,
              nextRetryAt: now,
            },
          },
        );
      } catch {
        return { outcome: 'PENDING_PROVIDER' }; // lease expires; same idempotency key returns the same payout
      }
      const fresh = (await Payout.findById(payout._id)) ?? payout;
      return { outcome: await this.finalizeLocally(fresh, now) };
    }
    if (res.status === 'PENDING') {
      const settings = await SettingsService.getAll();
      await Payout.updateOne(
        { _id: payout._id, status: 'PROCESSING' },
        {
          $set: {
            providerPayoutId: res.providerPayoutId,
            nextRetryAt: new Date(now.getTime() + settings['refund.statusPollSeconds'] * 1000),
            ...(payout.processingSince ? {} : { processingSince: now }),
          },
        },
      );
      if (
        payout.processingSince &&
        now.getTime() - payout.processingSince.getTime() >
          settings['refund.maxProcessingMinutes'] * 60_000
      )
        await AlertService.raise({
          key: `payout-stuck:${String(payout._id)}`,
          type: 'PAYOUT_STUCK_PROCESSING',
          severity: 'CRITICAL',
          entity: 'Payout',
          entityId: String(payout._id),
          message: 'A payout accepted by the provider is still unconfirmed after the maximum time',
          data: { providerPayoutId: res.providerPayoutId, amountMinor: payout.amountMinor },
        });
      return { outcome: 'PENDING_PROVIDER' };
    }
    return {
      outcome: await this.recordFailure(
        String(payout._id),
        new ProviderError('provider reported payout failure', true),
        now,
        undefined,
        { definitive: true },
      ),
    };
  },

  /** Local settlement after the provider paid. Failures are retried; they never return funds. */
  async finalizeLocally(payout: PayoutDoc, now: Date): Promise<'PAID' | 'FINALIZE_PENDING'> {
    const id = String(payout._id);
    try {
      await withTransaction((s) => this.finalizePaid(id, payout.providerPayoutId ?? 'unknown', s));
      return 'PAID';
    } catch (err) {
      const n = (payout.finalizeAttempts ?? 0) + 1;
      const message = clean((err as Error).message);
      await Payout.updateOne(
        { _id: id, status: 'PROVIDER_PAID' },
        {
          $set: {
            finalizeError: message,
            nextRetryAt: new Date(now.getTime() + Math.min(30 * 2 ** (n - 1), 3600) * 1000),
          },
          $inc: { finalizeAttempts: 1 },
        },
      ).catch(() => undefined);
      if (n >= 3)
        await AlertService.raise({
          key: `payout-finalize-pending:${id}`,
          type: 'PAYOUT_FINALIZE_PENDING',
          severity: 'CRITICAL',
          entity: 'Payout',
          entityId: id,
          message: 'The provider paid the nurse but local settlement keeps failing',
          data: { finalizeAttempts: n, lastError: message },
        }).catch(() => undefined);
      return 'FINALIZE_PENDING';
    }
  },

  async finalizePaid(
    payoutId: string,
    providerPayoutId: string,
    session: ClientSession,
  ): Promise<{ changed: boolean }> {
    const p = await Payout.findOneAndUpdate(
      { _id: payoutId, status: { $in: ['PENDING', 'PROCESSING', 'PROVIDER_PAID'] } },
      {
        $set: { status: 'PAID', paidAt: new Date(), providerPayoutId },
        $unset: { lastError: 1, finalizeError: 1, processingSince: 1 },
      },
      { new: true, session },
    );
    if (!p) return { changed: false };
    await notifyNurse(
      String(p.nurseId),
      {
        type: 'PAYOUT_COMPLETED',
        title: 'Payout completed',
        body: `Your payout of AED ${(p.amountMinor / 100).toFixed(2)} was paid.`,
        data: { payoutId, amountMinor: p.amountMinor },
        referenceKey: payoutId,
        channels: ['EMAIL', 'PUSH'],
      },
      session,
    );
    await WalletService.apply(
      {
        nurseId: String(p.nurseId),
        type: 'PAYOUT_SETTLED',
        bucket: 'NONE',
        amountMinor: 0,
        withdrawnDelta: p.amountMinor,
        referenceType: 'PAYOUT',
        referenceId: payoutId,
        idempotencyKey: `payout:${payoutId}:settled`,
      },
      session,
    );
    return { changed: true };
  },

  async recordFailure(
    payoutId: string,
    err: unknown,
    now: Date,
    session?: ClientSession,
    opts: { definitive?: boolean } = {},
  ): Promise<'RETRY' | 'FAILED'> {
    const settings = await SettingsService.getAll();
    const p = await Payout.findById(payoutId).session(session ?? null);
    if (
      !p ||
      p.status === 'PAID' ||
      p.status === 'PROVIDER_PAID' ||
      p.status === 'FAILED' ||
      p.status === 'CANCELLED'
    )
      return 'FAILED';
    const failures = p.failureCount + 1;
    const message = clean(err instanceof Error ? err.message : String(err));
    const retryable = !(err instanceof ProviderError) || err.retryable;
    if (!retryable || failures >= settings['payout.maxAttempts']) {
      await this.failPermanently(payoutId, message, failures, session);
      return 'FAILED';
    }
    await Payout.updateOne(
      { _id: payoutId },
      {
        $set: {
          status: 'PENDING',
          failureCount: failures,
          lastError: message,
          nextRetryAt: new Date(
            now.getTime() + backoff(failures, settings['payout.retryBaseSeconds']) * 1000,
          ),
        },
        ...(opts.definitive
          ? { $inc: { providerKeySeq: 1 }, $unset: { providerPayoutId: 1, processingSince: 1 } }
          : {}),
      },
      { session },
    );
    return 'RETRY';
  },

  /** FAILED: the debited funds go back to availableBalance through a compensating ledger row. */
  async failPermanently(
    payoutId: string,
    message: string,
    failures: number,
    session?: ClientSession,
  ): Promise<void> {
    const run = async (s: ClientSession) => {
      const p = await Payout.findOneAndUpdate(
        { _id: payoutId, status: { $in: ['PENDING', 'PROCESSING'] } },
        {
          $set: {
            status: 'FAILED',
            failedAt: new Date(),
            failureCount: failures,
            lastError: message,
          },
        },
        { new: true, session: s },
      );
      if (!p) return;
      await this.returnFunds(p, s);
      await notifyNurse(
        String(p.nurseId),
        {
          type: 'PAYOUT_FAILED',
          title: 'Payout failed',
          body: `Your payout of AED ${(p.amountMinor / 100).toFixed(2)} failed and the funds were returned to your wallet.`,
          data: { payoutId, amountMinor: p.amountMinor },
          referenceKey: payoutId,
          channels: ['EMAIL', 'PUSH'],
        },
        s,
      );
      await AlertService.raise(
        {
          key: `payout-failed:${payoutId}`,
          type: 'PAYOUT_FAILED',
          severity: 'CRITICAL',
          entity: 'Payout',
          entityId: payoutId,
          message: 'Payout failed at the provider; funds returned to the nurse wallet',
          data: { failures, lastError: message },
        },
        s,
      );
    };
    if (session) await run(session);
    else await withTransaction(run);
  },

  async returnFunds(p: PayoutDoc, session: ClientSession): Promise<void> {
    await WalletService.apply(
      {
        nurseId: String(p.nurseId),
        type: 'PAYOUT_REVERSAL',
        bucket: 'AVAILABLE',
        amountMinor: p.amountMinor,
        referenceType: 'PAYOUT',
        referenceId: String(p._id),
        idempotencyKey: `payout:${String(p._id)}:reversal`,
      },
      session,
    );
  },

  /** Cancel an unprocessed payout (nurse or admin). Funds return to availableBalance. */
  async cancel(payoutId: string, nurseId?: string): Promise<PayoutDoc> {
    return withTransaction(async (session) => {
      const p = await Payout.findOneAndUpdate(
        { _id: payoutId, ...(nurseId && { nurseId }), status: 'PENDING', attempts: 0 },
        { $set: { status: 'CANCELLED', cancelledAt: new Date() } },
        { new: true, session },
      );
      if (!p) {
        const exists = await Payout.exists({ _id: payoutId, ...(nurseId && { nurseId }) }).session(
          session,
        );
        if (!exists) throw new NotFoundError('Payout not found', 'PAYOUT_NOT_FOUND');
        throw new ConflictError(
          'Only an unprocessed payout can be cancelled',
          'PAYOUT_NOT_CANCELLABLE',
        );
      }
      await this.returnFunds(p, session);
      return p;
    });
  },

  async onProviderEvent(e: ProviderEvent, session: ClientSession): Promise<string> {
    const p = await Payout.findOne({ providerPayoutId: e.providerPayoutId }).session(session);
    if (!p) {
      await AlertService.raise(
        {
          key: `unknown-payout-event:${e.eventId}`,
          type: 'UNKNOWN_PAYOUT_EVENT',
          severity: 'WARNING',
          entity: 'PaymentWebhook',
          message: 'A signed payout event does not match any payout we issued',
          data: {
            eventId: e.eventId,
            eventType: e.type,
            providerPayoutId: e.providerPayoutId ?? null,
          },
        },
        session,
      );
      return 'UNKNOWN_PAYOUT';
    }
    if (e.amountMinor !== undefined && e.amountMinor !== p.amountMinor) {
      await AlertService.raise(
        {
          key: `payout-event-amount:${e.eventId}`,
          type: 'PAYOUT_EVENT_AMOUNT_MISMATCH',
          severity: 'CRITICAL',
          entity: 'Payout',
          entityId: String(p._id),
          message: 'A signed payout event disagrees with our payout amount; it was NOT applied',
          data: { eventId: e.eventId, expected: p.amountMinor, received: e.amountMinor },
        },
        session,
      );
      return 'PAYOUT_AMOUNT_MISMATCH';
    }
    if (e.type === 'payout.failed' && ['PAID', 'PROVIDER_PAID'].includes(p.status)) {
      await AlertService.raise(
        {
          key: `payout-contradiction:${e.eventId}`,
          type: 'PAYOUT_EVENT_CONTRADICTION',
          severity: 'CRITICAL',
          entity: 'Payout',
          entityId: String(p._id),
          message:
            'The provider reported a payout as failed after it was paid; funds were NOT returned, verify manually',
          data: { eventId: e.eventId },
        },
        session,
      );
      return 'PAYOUT_ALREADY_FINAL';
    }
    if (e.type === 'payout.paid') {
      const r = await this.finalizePaid(String(p._id), e.providerPayoutId!, session);
      return r.changed ? 'PAYOUT_PAID' : 'PAYOUT_ALREADY_FINAL';
    }
    await this.recordFailure(
      String(p._id),
      new ProviderError(e.failureReason ?? 'payout.failed'),
      new Date(),
      session,
      { definitive: true },
    );
    return 'PAYOUT_FAILURE_RECORDED';
  },

  async processDue(now = new Date(), limit = 50): Promise<Record<string, number>> {
    const due = await Payout.find({
      status: { $in: ['PENDING', 'PROCESSING', 'PROVIDER_PAID'] },
      nextRetryAt: { $lte: now },
    })
      .sort({ nextRetryAt: 1 })
      .limit(limit)
      .select('_id')
      .lean();
    const counts: Record<string, number> = {};
    for (const p of due) {
      const { outcome } = await this.process(String(p._id), now);
      counts[outcome] = (counts[outcome] ?? 0) + 1;
    }
    return counts;
  },
};
