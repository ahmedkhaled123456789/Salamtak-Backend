import type { ClientSession } from 'mongoose';
import { AppError, ConflictError, NotFoundError } from '../../common/errors';
import { withTransaction } from '../../config/database';
import { logger } from '../../config/logger';
import {
  getPaymentProvider,
  ProviderError,
  type ProviderEvent,
  type RefundResult,
} from '../../providers/payment';
import { AlertService } from '../alerts';
import { AuditService, type AuditContext } from '../audit';
import {
  Booking,
  BookingService,
  BookingStateMachine,
  SYSTEM_ACTOR,
  type BookingDoc,
  type BookingRefund,
} from '../bookings';
import { Payment, type PaymentDoc } from '../payments';
import { SettingsService } from '../settings';
import { WalletService } from '../wallets';
import { Refund, type RefundDoc, type RefundReason } from './refund.models';

const LEASE_MS = 5 * 60_000;
const MAX_BACKOFF_SECONDS = 6 * 3600;
const FINALIZE_RETRY_SECONDS = 30;

/** Never persist anything that could carry a secret or card data. */
export function sanitizeError(msg: string): string {
  return msg
    .replace(/\b(sk|rk|pk|whsec)_[A-Za-z0-9_]+/g, '[redacted]')
    .replace(/\b\d{12,19}\b/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(0, 300);
}

export const backoffSeconds = (failures: number, base: number): number =>
  Math.min(base * 2 ** Math.max(0, failures - 1), MAX_BACKOFF_SECONDS);

/**
 * Provider idempotency key. CONSTANT across retries of an unknown outcome (so a retry can never
 * refund twice). It only changes after the provider DEFINITIVELY reported failure, because then a
 * fresh attempt cannot duplicate anything and the provider would otherwise replay the failed result.
 */
export const providerRefundKey = (r: Pick<RefundDoc, '_id' | 'providerKeySeq'>): string =>
  r.providerKeySeq ? `refund-${String(r._id)}-${r.providerKeySeq}` : `refund-${String(r._id)}`;

export interface RefundObligation {
  bookingId?: string;
  paymentId: string;
  amountMinor: number;
  reason: RefundReason;
}

export type AttemptOutcome =
  'SUCCEEDED' | 'PENDING_PROVIDER' | 'FINALIZE_PENDING' | 'RETRY' | 'FAILED' | 'SKIPPED';

const ACTIVE = ['PENDING', 'PROCESSING', 'PROVIDER_SUCCEEDED'] as const;

export const RefundService = {
  /**
   * Records the obligation to refund (idempotent per booking/payment+reason: a repeat returns the
   * existing refund). Runs inside the transaction that created the reason for the refund.
   */
  async createObligation(
    a: RefundObligation,
    session: ClientSession,
  ): Promise<{ refund: RefundDoc; created: boolean }> {
    const key = a.bookingId
      ? `refund:booking:${a.bookingId}`
      : `refund:payment:${a.paymentId}:${a.reason}`;
    const existing = await Refund.findOne({ idempotencyKey: key }).session(session);
    if (existing) return { refund: existing, created: false };
    const payment = await Payment.findById(a.paymentId).session(session);
    if (!payment || !payment.providerTransactionId) throw new Error('payment not refundable');
    const refundable = payment.amountMinor - payment.refundedMinor;
    if (a.amountMinor < 1 || a.amountMinor > refundable)
      throw new Error('refund amount exceeds the refundable balance');
    const percent = Math.round((a.amountMinor * 100) / payment.amountMinor);
    const [refund] = await Refund.create(
      [
        {
          bookingId: a.bookingId,
          paymentId: payment._id,
          patientId: payment.patientId,
          provider: payment.provider,
          providerTransactionId: payment.providerTransactionId,
          amountMinor: a.amountMinor,
          currency: payment.currency,
          percent: Math.min(100, Math.max(1, percent)),
          type: a.amountMinor === payment.amountMinor ? 'FULL' : 'PARTIAL',
          reason: a.reason,
          status: 'PENDING',
          nextRetryAt: new Date(),
          idempotencyKey: key,
        },
      ],
      { session },
    );
    return { refund: refund!, created: true };
  },

  /**
   * BookingFinancialHooks.onRefundPending: runs INSIDE the booking transition transaction.
   *  1. reverse the nurse's pending earnings immediately (ledger-backed, idempotent)
   *  2. create the refund obligation for the provider
   * Bookings that never had a payment (legacy/test flows) simply have nothing to refund.
   */
  async onBookingRefundPending(b: BookingDoc, session: ClientSession): Promise<void> {
    const amount = b.refund?.amountMinor ?? 0;
    if (amount <= 0) {
      // fully discounted booking: nothing to refund at the provider, but the nurse share that the
      // policy does not keep must still be reversed (same ledger path, no obligation)
      if (b.pricingSnapshot!.patientPayableMinor === 0 && (b.refund?.percent ?? 0) > 0)
        await WalletService.reverseForRefund(b, 0, 1, session);
      return;
    }
    await WalletService.reverseForRefund(b, amount, 1, session);
    if (b.paymentId) {
      await this.createObligation(
        {
          bookingId: String(b._id),
          paymentId: String(b.paymentId),
          amountMinor: amount,
          reason: b.refund!.reason as RefundReason,
        },
        session,
      );
    }
  },

  // ------------------------------------------------------------------ provider attempt
  /**
   * One step of a refund. The kinds of work are kept strictly apart:
   *  A. PROVIDER work     (refundPayment / getRefund): its failures are provider failures.
   *  B. PERSISTING the provider's success (PROVIDER_SUCCEEDED) and
   *  C. LOCAL finalization (booking, payment, ledger): failures of B/C are LOCAL failures. They never
   *     count as provider failures, never fail the refund and never restore nurse earnings, because
   *     the customer has already been refunded. They are retried until local state catches up,
   *     without calling the provider's refund endpoint again.
   */
  async attempt(refundId: string, now = new Date()): Promise<{ outcome: AttemptOutcome }> {
    const claim = await this.claim(refundId, now);
    if (!claim) return { outcome: 'SKIPPED' };
    const { refund } = claim;

    if (claim.mode === 'FINALIZE') return { outcome: await this.finalizeLocally(refund, now) };
    if (refund.providerRefundId) return { outcome: await this.pollProvider(refund, now) };

    let res: RefundResult;
    try {
      res = await getPaymentProvider().refundPayment({
        providerTransactionId: refund.providerTransactionId,
        amountMinor: refund.amountMinor,
        currency: refund.currency,
        idempotencyKey: providerRefundKey(refund),
        reason: refund.reason,
      });
    } catch (err) {
      return { outcome: await this.recordFailure(String(refund._id), err, now) };
    }
    return { outcome: await this.handleProviderResult(refund, res, now) };
  },

  /** Atomically claims the next step. A claim doubles as a lease for crashed workers. */
  async claim(
    refundId: string,
    now: Date,
  ): Promise<{ refund: RefundDoc; mode: 'FINALIZE' | 'PROVIDER' } | null> {
    const due = { _id: refundId, nextRetryAt: { $lte: now } };
    const lease = new Date(now.getTime() + LEASE_MS);
    const fin = await Refund.findOneAndUpdate(
      { ...due, status: 'PROVIDER_SUCCEEDED' },
      { $set: { lastAttemptAt: now, nextRetryAt: lease } },
      { new: true },
    );
    if (fin) return { refund: fin, mode: 'FINALIZE' };
    const doc = await Refund.findOneAndUpdate(
      { ...due, status: { $in: ['PENDING', 'PROCESSING'] } },
      {
        $set: { status: 'PROCESSING', lastAttemptAt: now, nextRetryAt: lease },
        $inc: { attempts: 1 },
      },
      { new: true },
    );
    return doc ? { refund: doc, mode: 'PROVIDER' } : null;
  },

  async handleProviderResult(
    refund: RefundDoc,
    res: RefundResult,
    now: Date,
  ): Promise<AttemptOutcome> {
    const id = String(refund._id);
    if (res.status === 'SUCCEEDED') return this.providerSucceeded(refund, res, now);
    if (res.status === 'PENDING') {
      const settings = await SettingsService.getAll();
      await Refund.updateOne(
        { _id: id, status: 'PROCESSING' },
        {
          $set: {
            providerRefundId: res.providerRefundId,
            providerResponse: res.raw,
            nextRetryAt: new Date(now.getTime() + settings['refund.statusPollSeconds'] * 1000),
            ...(refund.processingSince ? {} : { processingSince: now }),
          },
        },
      );
      return 'PENDING_PROVIDER';
    }
    return this.recordFailure(
      id,
      new ProviderError(`provider reported failure ${JSON.stringify(res.raw ?? {})}`, true),
      now,
      undefined,
      { definitive: true },
    );
  },

  /** B: remember that the PROVIDER refunded the customer, then C: finish locally. */
  async providerSucceeded(
    refund: RefundDoc,
    res: RefundResult,
    now: Date,
  ): Promise<AttemptOutcome> {
    const id = String(refund._id);
    try {
      await Refund.updateOne(
        { _id: id, status: { $in: ['PROCESSING', 'PENDING'] } },
        {
          $set: {
            status: 'PROVIDER_SUCCEEDED',
            providerRefundId: res.providerRefundId,
            providerResponse: res.raw,
            providerSucceededAt: now,
            nextRetryAt: now,
          },
        },
      );
    } catch (err) {
      // Could not even persist the fact. The refund stays PROCESSING under its lease; the retry asks
      // the provider again with the SAME idempotency key and receives the same successful refund.
      logger.error(
        { refundId: id, err: (err as Error).message },
        'Could not persist provider refund success',
      );
      return 'FINALIZE_PENDING';
    }
    const fresh = (await Refund.findById(id)) ?? refund;
    return this.finalizeLocally(fresh, now);
  },

  /** C: local finalization. Failures are LOCAL: retried with backoff, never converted to provider failure. */
  async finalizeLocally(refund: RefundDoc, now: Date): Promise<AttemptOutcome> {
    const id = String(refund._id);
    try {
      await withTransaction((s) =>
        this.finalizeSuccess(id, refund.providerRefundId ?? 'unknown', refund.providerResponse, s),
      );
      return 'SUCCEEDED';
    } catch (err) {
      const settings = await SettingsService.getAll();
      const message = sanitizeError((err as Error).message);
      const n = (refund.finalizeAttempts ?? 0) + 1;
      await Refund.updateOne(
        { _id: id, status: 'PROVIDER_SUCCEEDED' },
        {
          $set: {
            finalizeError: message,
            nextRetryAt: new Date(
              now.getTime() + Math.min(FINALIZE_RETRY_SECONDS * 2 ** (n - 1), 3600) * 1000,
            ),
          },
          $inc: { finalizeAttempts: 1 },
        },
      ).catch(() => undefined);
      if (n >= settings['refund.alertAfterAttempts'])
        await AlertService.raise({
          key: `refund-finalize-pending:${id}`,
          type: 'REFUND_FINALIZE_PENDING',
          severity: 'CRITICAL',
          entity: 'Refund',
          entityId: id,
          message: 'The provider refunded the customer but local finalization keeps failing',
          data: {
            finalizeAttempts: n,
            lastError: message,
            providerRefundId: refund.providerRefundId ?? null,
          },
        }).catch(() => undefined);
      return 'FINALIZE_PENDING';
    }
  },

  /**
   * The provider accepted the refund asynchronously: ask it for the outcome (never issue it again).
   * Providers without a lookup rely on the verified webhook. In both cases a maximum processing age
   * raises a CRITICAL alert; the state is never guessed (not REFUNDED, not FAILED).
   */
  async pollProvider(refund: RefundDoc, now: Date): Promise<AttemptOutcome> {
    const settings = await SettingsService.getAll();
    const provider = getPaymentProvider();
    const next = new Date(now.getTime() + settings['refund.statusPollSeconds'] * 1000);
    await this.checkStuck(refund, now, settings['refund.maxProcessingMinutes']);
    if (!provider.getRefund) {
      await Refund.updateOne(
        { _id: refund._id, status: 'PROCESSING' },
        { $set: { nextRetryAt: next } },
      );
      return 'PENDING_PROVIDER';
    }
    let res: RefundResult;
    try {
      res = await provider.getRefund(refund.providerRefundId as string);
    } catch (err) {
      // cannot tell: keep waiting (this is not a refund failure)
      await Refund.updateOne(
        { _id: refund._id, status: 'PROCESSING' },
        {
          $set: {
            nextRetryAt: next,
            lastError: sanitizeError((err as Error).message),
            lastErrorAt: now,
          },
        },
      );
      return 'PENDING_PROVIDER';
    }
    if (res.status === 'SUCCEEDED') return this.providerSucceeded(refund, res, now);
    if (res.status === 'FAILED')
      return this.recordFailure(
        String(refund._id),
        new ProviderError('provider reported the refund failed', true),
        now,
        undefined,
        { definitive: true },
      );
    await Refund.updateOne(
      { _id: refund._id, status: 'PROCESSING' },
      { $set: { nextRetryAt: next } },
    );
    return 'PENDING_PROVIDER';
  },

  async checkStuck(refund: RefundDoc, now: Date, maxMinutes: number): Promise<void> {
    if (!refund.processingSince) return;
    if (now.getTime() - refund.processingSince.getTime() < maxMinutes * 60_000) return;
    await AlertService.raise({
      key: `refund-stuck:${String(refund._id)}`,
      type: 'REFUND_STUCK_PROCESSING',
      severity: 'CRITICAL',
      entity: 'Refund',
      entityId: String(refund._id),
      message:
        'A refund accepted by the provider is still unconfirmed after the maximum processing time; verify it with the provider',
      data: {
        providerRefundId: refund.providerRefundId ?? null,
        processingSince: refund.processingSince,
        amountMinor: refund.amountMinor,
      },
    });
  },

  /**
   * Failure bookkeeping for PROVIDER failures: keeps the obligation retryable, alerts after repeated
   * failures, fails it for good when exhausted. `definitive` = the provider explicitly said the refund
   * failed (so the next attempt may use a fresh idempotency key).
   */
  async recordFailure(
    refundId: string,
    err: unknown,
    now: Date,
    session?: ClientSession,
    opts: { definitive?: boolean } = {},
  ): Promise<'RETRY' | 'FAILED'> {
    const settings = await SettingsService.getAll();
    const refund = await Refund.findById(refundId).session(session ?? null);
    // A refund the provider already completed can never become a failure.
    if (!refund || ['SUCCEEDED', 'FAILED', 'PROVIDER_SUCCEEDED'].includes(refund.status))
      return 'FAILED';
    const failures = refund.failureCount + 1;
    const message = sanitizeError(err instanceof Error ? err.message : String(err));
    const retryable = !(err instanceof ProviderError) || err.retryable;
    if (!retryable || failures >= settings['refund.maxAttempts']) {
      await this.failPermanently(refundId, message, failures, session);
      return 'FAILED';
    }
    await Refund.updateOne(
      { _id: refundId },
      {
        $set: {
          status: 'PENDING',
          failureCount: failures,
          lastError: message,
          lastErrorAt: now,
          nextRetryAt: new Date(
            now.getTime() + backoffSeconds(failures, settings['refund.retryBaseSeconds']) * 1000,
          ),
          ...(opts.definitive &&
            refund.providerRefundId && { lastFailedProviderRefundId: refund.providerRefundId }),
        },
        ...(opts.definitive
          ? { $inc: { providerKeySeq: 1 }, $unset: { providerRefundId: 1, processingSince: 1 } }
          : {}),
      },
      { session },
    );
    if (failures >= settings['refund.alertAfterAttempts']) {
      await AlertService.raise({
        key: `refund-retrying:${refundId}`,
        type: 'REFUND_RETRYING',
        severity: 'WARNING',
        entity: 'Refund',
        entityId: refundId,
        message: `Refund has failed ${failures} times at the provider and is being retried`,
        data: { failures, lastError: message },
      });
    }
    return 'RETRY';
  },

  /**
   * Provider success => SUCCEEDED, payment bookkeeping, booking -> REFUNDED, exactly once.
   * Also reconciles a refund that had been marked FAILED: the customer WAS refunded, so the booking
   * moves FAILED -> REFUNDED and any earnings restored by the failure are taken back with new rows.
   */
  async finalizeSuccess(
    refundId: string,
    providerRefundId: string,
    raw: Record<string, unknown> | undefined,
    session: ClientSession,
  ): Promise<{ changed: boolean; reconciledFromFailed: boolean }> {
    const before = await Refund.findOneAndUpdate(
      { _id: refundId, status: { $in: [...ACTIVE, 'FAILED'] } },
      {
        $set: {
          status: 'SUCCEEDED',
          succeededAt: new Date(),
          providerRefundId,
          ...(raw && { providerResponse: raw }),
        },
        $unset: { finalizeError: 1, processingSince: 1, failedAt: 1 },
      },
      { returnDocument: 'before', session },
    );
    if (!before) return { changed: false, reconciledFromFailed: false };
    const wasFailed = before.status === 'FAILED';

    const payment = await Payment.findOneAndUpdate(
      { _id: before.paymentId, status: { $in: ['PAID', 'PARTIALLY_REFUNDED'] } },
      { $inc: { refundedMinor: before.amountMinor } },
      { new: true, session },
    );
    if (payment) {
      await Payment.updateOne(
        { _id: payment._id },
        {
          $set: {
            status:
              payment.refundedMinor >= payment.amountMinor ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
          },
        },
        { session },
      );
    }
    if (before.bookingId) {
      const b = await Booking.findById(before.bookingId).session(session);
      if (b && (b.status === 'REFUND_PENDING' || b.status === 'FAILED')) {
        if (b.status === 'FAILED')
          await WalletService.undoRestoreAfterRefundSuccess(b, refundId, session);
        await BookingService.completeRefund(String(b._id), { providerRefundId, session });
      }
    }
    if (wasFailed) {
      await AlertService.resolveByKey(
        `refund-failed:${refundId}:g${before.generation}`,
        undefined,
        session,
      );
      await AuditService.record(
        { actorRole: 'SYSTEM' },
        {
          action: 'refund.reconciled_after_failure',
          entity: 'Refund',
          entityId: refundId,
          newData: { providerRefundId, amountMinor: before.amountMinor },
        },
        session,
      );
    }
    return { changed: true, reconciledFromFailed: wasFailed };
  },

  /** Retries exhausted (or a non-retryable provider error): FAILED + earnings restored + critical alert. */
  async failPermanently(
    refundId: string,
    message: string,
    failures: number,
    session?: ClientSession,
  ): Promise<void> {
    const run = async (s: ClientSession) => {
      const refund = await Refund.findOneAndUpdate(
        { _id: refundId, status: { $in: ['PENDING', 'PROCESSING'] } },
        {
          $set: {
            status: 'FAILED',
            failedAt: new Date(),
            failureCount: failures,
            lastError: message,
            lastErrorAt: new Date(),
          },
        },
        { new: true, session: s },
      );
      if (!refund) return;
      if (refund.bookingId) {
        const b = await Booking.findById(refund.bookingId).session(s);
        if (b && b.status === 'REFUND_PENDING') {
          await BookingStateMachine.transition(String(b._id), 'FAILED', SYSTEM_ACTOR, {
            session: s,
            reason: 'Provider refund failed permanently; awaiting admin',
            patch: {
              refund: {
                ...(b.refund as unknown as { toObject(): BookingRefund }).toObject(),
                status: 'FAILED',
              },
            },
          });
          await WalletService.restoreAfterRefundFailure(b, refundId, refund.generation, s);
        }
      }
      await AlertService.raise(
        {
          key: `refund-failed:${refundId}:g${refund.generation}`,
          type: 'REFUND_FAILED',
          severity: 'CRITICAL',
          entity: 'Refund',
          entityId: refundId,
          message:
            'Refund failed at the provider and needs admin attention; the customer has NOT been refunded',
          data: { failures, lastError: message, amountMinor: refund.amountMinor },
        },
        s,
      );
    };
    if (session) await run(session);
    else await withTransaction(run);
  },

  /**
   * Verified provider events for refunds. Event data is cross-checked against our record before it
   * is believed: amount and provider refund id must match, otherwise nothing is applied and a
   * CRITICAL alert is raised.
   */
  async onProviderEvent(e: ProviderEvent, session: ClientSession): Promise<string> {
    let refund = e.providerRefundId
      ? await Refund.findOne({ providerRefundId: e.providerRefundId }).session(session)
      : null;
    if (!refund && e.providerTransactionId) {
      refund = await Refund.findOne({
        providerTransactionId: e.providerTransactionId,
        status: { $in: [...ACTIVE, 'FAILED'] },
      })
        .sort({ createdAt: -1 })
        .session(session);
    }
    if (!refund) {
      await AlertService.raise(
        {
          key: `unknown-refund-event:${e.eventId}`,
          type: 'UNKNOWN_REFUND_EVENT',
          severity: 'WARNING',
          entity: 'PaymentWebhook',
          message: 'A signed refund event does not match any refund we issued',
          data: {
            eventId: e.eventId,
            eventType: e.type,
            providerRefundId: e.providerRefundId ?? null,
            providerTransactionId: e.providerTransactionId ?? null,
            amountMinor: e.amountMinor ?? null,
          },
        },
        session,
      );
      return 'UNKNOWN_REFUND';
    }
    const id = String(refund._id);
    const mismatch = async (kind: 'amount' | 'id') => {
      await AlertService.raise(
        {
          key: `refund-event-${kind}:${e.eventId}`,
          type: `REFUND_EVENT_${kind.toUpperCase()}_MISMATCH`,
          severity: 'CRITICAL',
          entity: 'Refund',
          entityId: id,
          message: `A signed refund event disagrees with our refund record (${kind}); it was NOT applied`,
          data: {
            eventId: e.eventId,
            expected:
              kind === 'amount'
                ? (refund as RefundDoc).amountMinor
                : ((refund as RefundDoc).providerRefundId ?? null),
            received: kind === 'amount' ? (e.amountMinor ?? null) : (e.providerRefundId ?? null),
          },
        },
        session,
      );
      return `REFUND_${kind.toUpperCase()}_MISMATCH`;
    };
    if (e.amountMinor !== undefined && e.amountMinor !== refund.amountMinor)
      return mismatch('amount');
    if (e.currency !== undefined && e.currency.toUpperCase() !== refund.currency)
      return mismatch('amount');
    if (
      refund.providerRefundId &&
      e.providerRefundId &&
      refund.providerRefundId !== e.providerRefundId
    )
      return mismatch('id');

    if (e.type === 'refund.succeeded') {
      const r = await this.finalizeSuccess(
        id,
        e.providerRefundId ?? refund.providerRefundId ?? 'unknown',
        undefined,
        session,
      );
      if (!r.changed) return 'REFUND_ALREADY_FINAL';
      return r.reconciledFromFailed ? 'REFUND_RECONCILED_AFTER_FAILURE' : 'REFUND_SUCCEEDED';
    }
    // refund.failed
    if (['SUCCEEDED', 'PROVIDER_SUCCEEDED'].includes(refund.status)) {
      await AlertService.raise(
        {
          key: `refund-contradiction:${e.eventId}`,
          type: 'REFUND_EVENT_CONTRADICTION',
          severity: 'CRITICAL',
          entity: 'Refund',
          entityId: id,
          message:
            'The provider reported a refund as failed after confirming it succeeded; no change was made',
        },
        session,
      );
      return 'REFUND_ALREADY_FINAL';
    }
    if (refund.status === 'FAILED') return 'REFUND_ALREADY_FINAL';
    await this.recordFailure(
      id,
      new ProviderError(e.failureReason ?? 'refund.failed', true),
      new Date(),
      session,
      { definitive: true },
    );
    return 'REFUND_FAILURE_RECORDED';
  },

  /** Sweep: attempt every refund that is due. Safe to run concurrently (claims are atomic). */
  async processDue(now = new Date(), limit = 50): Promise<Record<string, number>> {
    const due = await Refund.find({ status: { $in: ACTIVE }, nextRetryAt: { $lte: now } })
      .sort({ nextRetryAt: 1 })
      .limit(limit)
      .select('_id')
      .lean();
    const counts: Record<string, number> = {};
    for (const r of due) {
      const { outcome } = await this.attempt(String(r._id), now);
      counts[outcome] = (counts[outcome] ?? 0) + 1;
    }
    return counts;
  },

  /** Admin re-opens a FAILED refund: obligation back to PENDING, booking back to REFUND_PENDING, earnings re-reversed. */
  async adminRetry(refundId: string, ctx: AuditContext): Promise<RefundDoc> {
    const now = new Date();
    return withTransaction(async (session) => {
      const refund = await Refund.findOneAndUpdate(
        { _id: refundId, status: 'FAILED' },
        {
          $set: { status: 'PENDING', failureCount: 0, nextRetryAt: now },
          $inc: { generation: 1 },
          $unset: { failedAt: 1 },
        },
        { new: true, session },
      );
      if (!refund) {
        const exists = await Refund.exists({ _id: refundId }).session(session);
        if (!exists) throw new NotFoundError('Refund not found', 'REFUND_NOT_FOUND');
        throw new ConflictError('Only FAILED refunds can be retried', 'REFUND_NOT_RETRYABLE');
      }
      if (refund.bookingId) {
        const b = await Booking.findById(refund.bookingId).session(session);
        if (b && b.status === 'FAILED') {
          const reopened = await BookingStateMachine.transition(
            String(b._id),
            'REFUND_PENDING',
            { role: 'ADMIN', userId: ctx.actorId },
            {
              session,
              now,
              reason: 'Admin retried the failed refund',
              patch: {
                refund: {
                  status: 'PENDING',
                  reason: b.refund!.reason,
                  percent: b.refund!.percent,
                  amountMinor: b.refund!.amountMinor,
                  requestedAt: now,
                },
              },
            },
          );
          await WalletService.reverseForRefund(
            reopened,
            refund.amountMinor,
            refund.generation,
            session,
          );
        }
      }
      await AuditService.record(
        ctx,
        {
          action: 'refund.retry_requested',
          entity: 'Refund',
          entityId: refundId,
          newData: { generation: refund.generation, amountMinor: refund.amountMinor },
        },
        session,
      );
      return refund;
    });
  },

  /**
   * Late/duplicate payment: money was captured for a booking that can no longer use it. Creates the
   * 100% refund obligation. Runs inside the webhook transaction. Idempotent per payment+reason.
   */
  async createLateRefund(
    payment: PaymentDoc,
    reason: RefundReason,
    session: ClientSession,
  ): Promise<RefundDoc> {
    if (!payment.providerTransactionId)
      throw new AppError(500, 'PAYMENT_STATE', 'payment has no provider transaction');
    const { refund } = await this.createObligation(
      {
        paymentId: String(payment._id),
        amountMinor: payment.amountMinor - payment.refundedMinor,
        reason,
      },
      session,
    );
    return refund;
  },
};
