import { createHash } from 'node:crypto';
import { AppError, TooManyRequestsError } from '../../common/errors';
import { consumeFailure, webhookFailureLimit } from '../../common/middleware/rateLimit';
import { withTransaction } from '../../config/database';
import { logger } from '../../config/logger';
import { getPaymentProvider, type HeaderBag, type ProviderEvent } from '../../providers/payment';
import { AlertService } from '../alerts';
import { BookingService } from '../bookings';
import { Payment, PaymentWebhook } from '../payments';
import { PayoutService } from '../payouts';
import { RefundService, sanitizeError } from '../refunds';
import { WalletService } from '../wallets';
import type { ClientSession } from 'mongoose';

const LEASE_MS = 60_000;

export type WebhookResult = {
  status: 'PROCESSED' | 'IGNORED' | 'DUPLICATE';
  outcome: string;
};

/**
 * Applies a verified payment event. Runs INSIDE one MongoDB transaction, together with the webhook
 * inbox update, so payment state, booking transition, wallet ledger and refund obligation either all
 * happen or none do. Duplicate deliveries hit guarded updates and idempotency keys and change nothing.
 */
async function applyPaymentEvent(e: ProviderEvent, session: ClientSession): Promise<string> {
  const payment = await Payment.findOne({ providerTransactionId: e.providerTransactionId }).session(
    session,
  );
  if (!payment) {
    // A SIGNED event for a payment we have no record of: money may have moved that we cannot attach
    // to anything. Never create a booking/payment from it; make a human look. Metadata only, no payload.
    const succeeded = e.type === 'payment.succeeded';
    await AlertService.raise(
      {
        key: `unknown-payment:${getPaymentProvider().name}:${e.eventId}`,
        type: 'UNKNOWN_PAYMENT_EVENT',
        severity: succeeded ? 'CRITICAL' : 'WARNING',
        entity: 'PaymentWebhook',
        message: succeeded
          ? 'A signed payment confirmation arrived for a payment we have no record of; verify with the provider'
          : 'A signed payment event arrived for a payment we have no record of',
        data: {
          provider: getPaymentProvider().name,
          eventId: e.eventId,
          providerTransactionId: e.providerTransactionId ?? null,
          eventType: e.type,
          amountMinor: e.amountMinor ?? null,
          currency: e.currency ?? null,
          receivedAt: new Date(),
          reason: 'NO_MATCHING_PAYMENT',
        },
      },
      session,
    );
    return 'IGNORED_UNKNOWN_PAYMENT';
  }
  const open = ['PENDING', 'PROCESSING'];

  switch (e.type) {
    case 'payment.processing':
      if (payment.status !== 'PENDING') return 'IGNORED_NO_CHANGE';
      await Payment.updateOne(
        { _id: payment._id, status: 'PENDING' },
        { $set: { status: 'PROCESSING' } },
        { session },
      );
      return 'PAYMENT_PROCESSING';

    case 'payment.failed':
    case 'payment.cancelled': {
      if (!open.includes(payment.status)) return 'IGNORED_PAYMENT_ALREADY_FINAL';
      await Payment.updateOne(
        { _id: payment._id, status: { $in: open } },
        {
          $set: {
            status: e.type === 'payment.failed' ? 'FAILED' : 'CANCELLED',
            failedAt: new Date(),
            failureReason: e.failureReason
              ? sanitizeError(e.failureReason).slice(0, 200)
              : undefined,
          },
        },
        { session },
      );
      return e.type === 'payment.failed' ? 'PAYMENT_FAILED' : 'PAYMENT_CANCELLED';
    }

    case 'payment.succeeded': {
      if (['PAID', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(payment.status))
        return 'PAYMENT_ALREADY_APPLIED';

      // The provider-confirmed amount must equal what we asked for. Anything else is never applied.
      if (
        (e.amountMinor !== undefined && e.amountMinor !== payment.amountMinor) ||
        (e.currency !== undefined && e.currency.toUpperCase() !== payment.currency)
      ) {
        await Payment.updateOne(
          { _id: payment._id },
          { $set: { status: 'FAILED', failedAt: new Date(), failureReason: 'AMOUNT_MISMATCH' } },
          { session },
        );
        await AlertService.raise(
          {
            key: `payment-amount-mismatch:${String(payment._id)}`,
            type: 'PAYMENT_AMOUNT_MISMATCH',
            severity: 'CRITICAL',
            entity: 'Payment',
            entityId: String(payment._id),
            message:
              'Provider confirmed a payment whose amount differs from the booking; nothing was applied',
            data: { expectedMinor: payment.amountMinor, receivedMinor: e.amountMinor ?? null },
          },
          session,
        );
        return 'PAYMENT_AMOUNT_MISMATCH';
      }

      const now = new Date();
      const when = await effectivePaymentTime(e, payment, now, session);
      const paid = await Payment.findOneAndUpdate(
        { _id: payment._id, status: { $in: ['PENDING', 'PROCESSING', 'FAILED', 'CANCELLED'] } },
        {
          $set: {
            status: 'PAID',
            paidAt: now,
            paidTimeSource: when.source,
            ...(when.source === 'PROVIDER' && { providerPaidAt: when.at }),
          },
          $unset: { failureReason: 1, failedAt: 1 },
        },
        { new: true, session },
      );
      if (!paid) return 'PAYMENT_ALREADY_APPLIED';

      const conf = await BookingService.confirmPayment(String(payment.bookingId), {
        paymentId: String(payment._id),
        session,
        now,
        paymentTime: when.at,
      });
      if (conf.result === 'PAID') {
        // nurse pendingBalance += the booking's SNAPSHOTTED earning (+ ledger row), same transaction
        await WalletService.creditPendingEarning(conf.booking, String(payment._id), session);
        await Payment.updateOne(
          { _id: payment._id },
          { $set: { settlement: 'APPLIED' } },
          { session },
        );
        return 'PAYMENT_APPLIED';
      }
      if (conf.result === 'REPLAY') {
        await Payment.updateOne(
          { _id: payment._id },
          { $set: { settlement: 'APPLIED' } },
          { session },
        );
        return 'PAYMENT_ALREADY_APPLIED';
      }
      // Not payable: never revive the booking; refund 100%.
      const alreadyPaidByAnother = !!conf.booking?.paidAt && !!conf.booking.paymentId;
      const reason = alreadyPaidByAnother
        ? 'DUPLICATE_PAYMENT'
        : 'BOOKING_EXPIRED_BEFORE_PAYMENT_CONFIRMATION';
      await Payment.updateOne(
        { _id: payment._id },
        { $set: { settlement: alreadyPaidByAnother ? 'DUPLICATE_REFUND' : 'LATE_REFUND' } },
        { session },
      );
      await RefundService.createLateRefund(paid, reason, session);
      return `PAYMENT_LATE_REFUND_CREATED:${reason}`;
    }
    default:
      return 'IGNORED_TYPE';
  }
}

/**
 * A payment.succeeded event without amount/currency is never trusted on its own: the provider's
 * authoritative lookup supplies them (and must say PAID). Done before the transaction (network I/O).
 * If the lookup fails the event stays retryable (the provider redelivers).
 */
async function enrichPaymentEvent(e: ProviderEvent): Promise<ProviderEvent> {
  if (e.type !== 'payment.succeeded' || !e.providerTransactionId) return e;
  if (e.amountMinor !== undefined && e.currency !== undefined) return e;
  const known = await Payment.exists({ providerTransactionId: e.providerTransactionId });
  if (!known) return e; // unknown payments are alerted, nothing to verify against
  const v = await getPaymentProvider().verifyPayment(e.providerTransactionId);
  if (v.status !== 'PAID')
    throw new AppError(409, 'PAYMENT_NOT_CONFIRMED', 'Provider does not confirm the payment yet');
  return { ...e, amountMinor: e.amountMinor ?? v.amountMinor, currency: e.currency ?? v.currency };
}

const CLOCK_SKEW_MS = 2 * 60_000;

/**
 * Which clock decides whether the customer paid before the hold expired. The provider's timestamp
 * (from a signature-verified event) wins, but only if it is plausible: a valid date, not in the
 * future, and not before we even created the payment. Anything else is untrusted: the webhook
 * processing time is used and a WARNING alert records why.
 */
async function effectivePaymentTime(
  e: ProviderEvent,
  payment: { _id: unknown; createdAt?: Date },
  now: Date,
  session: ClientSession,
): Promise<{ at: Date; source: 'PROVIDER' | 'PROCESSING' }> {
  if (!e.paidAt) return { at: now, source: 'PROCESSING' };
  const t = e.paidAt.getTime();
  const created = payment.createdAt?.getTime() ?? 0;
  const reason = Number.isNaN(t)
    ? 'INVALID_TIMESTAMP'
    : t > now.getTime() + CLOCK_SKEW_MS
      ? 'TIMESTAMP_IN_THE_FUTURE'
      : t < created - CLOCK_SKEW_MS
        ? 'TIMESTAMP_BEFORE_PAYMENT_CREATED'
        : undefined;
  if (reason) {
    await AlertService.raise(
      {
        key: `payment-timestamp-untrusted:${e.eventId}`,
        type: 'PAYMENT_TIMESTAMP_UNTRUSTED',
        severity: 'WARNING',
        entity: 'Payment',
        entityId: String(payment._id),
        message: 'Provider payment timestamp was not trusted; webhook processing time was used',
        data: { eventId: e.eventId, reason },
      },
      session,
    );
    return { at: now, source: 'PROCESSING' };
  }
  return { at: e.paidAt, source: 'PROVIDER' };
}

async function dispatch(e: ProviderEvent, session: ClientSession): Promise<string> {
  if (e.type.startsWith('payment.')) return applyPaymentEvent(e, session);
  if (e.type === 'refund.succeeded' || e.type === 'refund.failed')
    return RefundService.onProviderEvent(e, session);
  if (e.type === 'payout.paid' || e.type === 'payout.failed')
    return PayoutService.onProviderEvent(e, session);
  return 'IGNORED_TYPE';
}

export const PaymentWebhookService = {
  /**
   * Webhook pipeline: verify signature -> store payload hash + insert inbox row (unique
   * provider+eventId) -> process transactionally -> record status. Duplicate deliveries of a
   * processed event return DUPLICATE and change nothing.
   */
  async handle(rawBody: Buffer, headers: HeaderBag, ip = 'unknown'): Promise<WebhookResult> {
    const provider = getPaymentProvider();
    let event: ProviderEvent;
    try {
      event = provider.verifyWebhook(rawBody, headers);
    } catch (err) {
      // Unauthenticated input: store nothing, reveal nothing about why. Only FAILURES are counted per
      // source, so a flood is throttled (and stops being logged) while valid signed traffic is untouched.
      const f = await consumeFailure('webhook-invalid-signature', webhookFailureLimit, ip);
      if (f.limited) throw new TooManyRequestsError(undefined, f.retryAfterSeconds);
      logger.warn({ reason: (err as Error).name }, 'Rejected webhook with invalid signature');
      throw new AppError(400, 'INVALID_WEBHOOK_SIGNATURE', 'Invalid webhook signature');
    }
    event = await enrichPaymentEvent(event);
    return this.processVerified(event, createHash('sha256').update(rawBody).digest('hex'));
  },

  /**
   * Applies an already AUTHENTICATED event: either a signature-verified webhook, or a normalised
   * result of the provider's authoritative lookup API (payment polling). Same inbox, same unique
   * (provider, eventId), same single transaction, so every path is idempotent and ordered alike.
   */
  async processVerified(event: ProviderEvent, payloadHash: string): Promise<WebhookResult> {
    const provider = getPaymentProvider();
    const now = new Date();

    // 1. inbox insert FIRST (the unique index decides who processes)
    let inboxId: string;
    try {
      const doc = await PaymentWebhook.create({
        provider: provider.name,
        eventId: event.eventId,
        eventType: event.type,
        payloadHash,
        processingStatus: 'PROCESSING',
        attempts: 1,
        leaseUntil: new Date(now.getTime() + LEASE_MS),
      });
      inboxId = String(doc._id);
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
      const existing = await PaymentWebhook.findOne({
        provider: provider.name,
        eventId: event.eventId,
      });
      if (!existing) throw err;
      if (existing.payloadHash !== payloadHash) {
        await AlertService.raise({
          key: `webhook-payload-mismatch:${provider.name}:${event.eventId}`,
          type: 'WEBHOOK_PAYLOAD_MISMATCH',
          severity: 'WARNING',
          entity: 'PaymentWebhook',
          entityId: String(existing._id),
          message: 'A webhook event id was re-delivered with a different payload (ignored)',
        });
      }
      if (['PROCESSED', 'IGNORED'].includes(existing.processingStatus)) {
        return { status: 'DUPLICATE', outcome: existing.outcome ?? existing.processingStatus };
      }
      // FAILED earlier, or a crashed worker's lapsed lease: take it over; a live worker => ask provider to retry
      const claimed = await PaymentWebhook.findOneAndUpdate(
        {
          _id: existing._id,
          $or: [
            { processingStatus: 'FAILED' },
            { processingStatus: { $in: ['RECEIVED', 'PROCESSING'] }, leaseUntil: { $lt: now } },
          ],
        },
        {
          $set: { processingStatus: 'PROCESSING', leaseUntil: new Date(now.getTime() + LEASE_MS) },
          $inc: { attempts: 1 },
        },
        { new: true },
      );
      if (!claimed)
        throw new AppError(
          409,
          'WEBHOOK_IN_PROGRESS',
          'This event is being processed; retry shortly',
        );
      inboxId = String(claimed._id);
    }

    // 2. process transactionally; wallet must exist before the money transaction
    try {
      if (event.type.startsWith('payment.') && event.providerTransactionId) {
        const p = await Payment.findOne({ providerTransactionId: event.providerTransactionId })
          .select('nurseId')
          .lean();
        if (p) await WalletService.ensure(String(p.nurseId));
      }
      const outcome = await withTransaction(async (session) => {
        const out = await dispatch(event, session);
        await PaymentWebhook.updateOne(
          { _id: inboxId },
          {
            $set: {
              processingStatus: out.startsWith('IGNORED') ? 'IGNORED' : 'PROCESSED',
              processedAt: new Date(),
              outcome: out.slice(0, 100),
            },
            $unset: { errorMessage: 1, leaseUntil: 1 },
          },
          { session },
        );
        return out;
      });
      return { status: outcome.startsWith('IGNORED') ? 'IGNORED' : 'PROCESSED', outcome };
    } catch (err) {
      await PaymentWebhook.updateOne(
        { _id: inboxId },
        {
          $set: {
            processingStatus: 'FAILED',
            errorMessage: sanitizeError((err as Error).message),
            leaseUntil: undefined,
          },
        },
      ).catch(() => undefined);
      logger.error(
        { eventId: event.eventId, type: event.type, err: (err as Error).message },
        'Webhook processing failed',
      );
      // 500 => the provider redelivers; the inbox row (FAILED) lets the retry be processed.
      throw new AppError(500, 'WEBHOOK_PROCESSING_FAILED', 'Webhook processing failed');
    }
  },
};
