import { z, type ZodType } from 'zod';
import { BookingService } from '../modules/bookings';
import { PaymentPollingService } from '../modules/finance';
import { VerificationService } from '../modules/nurse-verification';
import { EmergencyService } from '../modules/emergency';
import { ReviewService } from '../modules/reviews';
import { DeliveryService, NotificationDelivery } from '../modules/notifications';
import { Payout, PayoutService } from '../modules/payouts';
import { Refund, RefundService } from '../modules/refunds';
import { WalletService } from '../modules/wallets';
import { QUEUES, enqueue, type QueueName } from '../queues';
import { checkQueueHealth } from './queue-health';
import { runScheduledReconciliation } from './reconciliation.job';

export interface JobContext {
  now: Date;
  jobId?: string;
  attempt: number;
}
export interface JobDef {
  queue: QueueName;
  /** Payload schema. Payloads carry reference ids only (never patient or payment data). */
  schema: ZodType;
  run(data: never, ctx: JobContext): Promise<Record<string, unknown>>;
}

const none = z.object({}).strict();
const objectId = z.string().regex(/^[a-f\d]{24}$/i);
const refundPayload = z.object({ refundId: objectId }).strict();
const payoutPayload = z.object({ payoutId: objectId }).strict();
const requestPayload = z.object({ requestId: objectId }).strict();
const deliveryPayload = z.object({ deliveryId: objectId }).strict();

const define = <S extends ZodType>(
  queue: QueueName,
  schema: S,
  run: (data: z.output<S>, ctx: JobContext) => Promise<Record<string, unknown>>,
): JobDef => ({ queue, schema, run: run as JobDef['run'] });

/**
 * Every job is a thin adapter over a domain service. NO business rule lives here: the services own
 * correctness, conditional state transitions and idempotency. A job that runs twice, concurrently
 * or after a crash is therefore harmless.
 */
export const JOBS: Record<string, JobDef> = {
  // ---- bookings: time-driven transitions (existing Phase 2/2.1 logic)
  'booking.expireDue': define(QUEUES.booking, none, (_d, c) => BookingService.expireDue(c.now)),
  'booking.flagNoShows': define(QUEUES.booking, none, (_d, c) => BookingService.flagNoShows(c.now)),
  'booking.autoComplete': define(QUEUES.booking, none, (_d, c) =>
    BookingService.autoCompleteDue(c.now),
  ),
  'booking.reconcileRefundRequests': define(QUEUES.booking, none, (_d, c) =>
    BookingService.reconcileRefundRequests(c.now),
  ),

  // ---- wallets: release re-checks eligibility inside its own transaction (Phase 3 hardening)
  'wallet.releaseDue': define(QUEUES.wallet, none, (_d, c) => WalletService.releaseDue(c.now)),

  // ---- refunds: sweep finds due obligations, one job per refund (deterministic id)
  'refund.sweep': define(QUEUES.refund, none, async (_d, c) => {
    const due = await Refund.find({
      status: { $in: ['PENDING', 'PROCESSING', 'PROVIDER_SUCCEEDED'] },
      nextRetryAt: { $lte: c.now },
    })
      .sort({ nextRetryAt: 1 })
      .limit(100)
      .select('_id nextRetryAt')
      .lean();
    let enqueued = 0;
    for (const r of due) {
      const ok = await enqueue(
        QUEUES.refund,
        'refund.attempt',
        { refundId: String(r._id) },
        { jobId: `refund-${String(r._id)}-${r.nextRetryAt?.getTime() ?? 0}` },
      );
      if (ok) enqueued += 1;
    }
    return { due: due.length, enqueued };
  }),
  'refund.attempt': define(QUEUES.refund, refundPayload, async (d, c) => ({
    // the service claims a lease, never calls the provider again after a provider success,
    // and polls asynchronous refunds instead of re-issuing them
    ...(await RefundService.attempt(d.refundId, c.now)),
  })),

  // ---- payouts
  'payout.sweep': define(QUEUES.payout, none, async (_d, c) => {
    const due = await Payout.find({
      status: { $in: ['PENDING', 'PROCESSING', 'PROVIDER_PAID'] },
      nextRetryAt: { $lte: c.now },
    })
      .sort({ nextRetryAt: 1 })
      .limit(100)
      .select('_id nextRetryAt')
      .lean();
    let enqueued = 0;
    for (const p of due) {
      const ok = await enqueue(
        QUEUES.payout,
        'payout.process',
        { payoutId: String(p._id) },
        { jobId: `payout-${String(p._id)}-${p.nextRetryAt?.getTime() ?? 0}` },
      );
      if (ok) enqueued += 1;
    }
    return { due: due.length, enqueued };
  }),
  'payout.process': define(QUEUES.payout, payoutPayload, async (d, c) => ({
    ...(await PayoutService.process(d.payoutId, c.now)),
  })),

  // ---- payments: polling feeds the provider's AUTHORITATIVE lookup through the webhook pipeline
  'payment.pollProcessing': define(QUEUES.payment, none, async (_d, c) => ({
    ...(await PaymentPollingService.pollDue(c.now)),
  })),

  // ---- reconciliation: read-only, alert-only, never overlapping
  'reconciliation.run': define(QUEUES.reconciliation, none, () => runScheduledReconciliation()),

  // ---- notifications
  'notification.sweep': define(QUEUES.notification, none, async (_d, c) => {
    const due = await NotificationDelivery.find({
      status: { $in: ['PENDING', 'PROCESSING'] },
      nextAttemptAt: { $lte: c.now },
    })
      .sort({ nextAttemptAt: 1 })
      .limit(200)
      .select('_id nextAttemptAt')
      .lean();
    let enqueued = 0;
    for (const x of due) {
      const ok = await enqueue(
        QUEUES.notification,
        'notification.deliver',
        { deliveryId: String(x._id) },
        { jobId: `delivery-${String(x._id)}-${x.nextAttemptAt?.getTime() ?? 0}` },
      );
      if (ok) enqueued += 1;
    }
    return { due: due.length, enqueued };
  }),
  'notification.deliver': define(QUEUES.notification, deliveryPayload, async (d, c) => ({
    outcome: await DeliveryService.deliver(d.deliveryId, c.now),
  })),

  // ---- marketplace
  'nurse.expireDocuments': define(QUEUES.marketplace, none, (_d, c) =>
    VerificationService.expireDue(c.now),
  ),

  'review.reconcileAggregates': define(QUEUES.marketplace, none, () =>
    ReviewService.reconcileAggregates(),
  ),

  'emergency.sweep': define(QUEUES.marketplace, none, (_d, c) => EmergencyService.sweep(c.now)),
  'emergency.match': define(QUEUES.marketplace, requestPayload, async (d, c) => ({
    outcome: await EmergencyService.matchNext(d.requestId, c.now),
  })),

  // ---- operations
  'alerts.queueHealth': define(QUEUES.alert, none, () => checkQueueHealth()),
};

/** Scheduled jobs: name -> settings key holding its interval (seconds, or minutes for reconciliation). */
export const SCHEDULES = [
  { job: 'booking.expireDue', every: 'jobs.bookingExpireSeconds', unit: 's' },
  { job: 'booking.flagNoShows', every: 'jobs.noShowSeconds', unit: 's' },
  { job: 'booking.autoComplete', every: 'jobs.autoCompleteSeconds', unit: 's' },
  { job: 'booking.reconcileRefundRequests', every: 'jobs.refundSweepSeconds', unit: 's' },
  { job: 'wallet.releaseDue', every: 'jobs.walletReleaseSeconds', unit: 's' },
  { job: 'refund.sweep', every: 'jobs.refundSweepSeconds', unit: 's' },
  { job: 'payout.sweep', every: 'jobs.payoutSweepSeconds', unit: 's' },
  { job: 'payment.pollProcessing', every: 'jobs.paymentPollSeconds', unit: 's' },
  { job: 'reconciliation.run', every: 'jobs.reconciliationMinutes', unit: 'm' },
  { job: 'notification.sweep', every: 'jobs.notificationSweepSeconds', unit: 's' },
  { job: 'alerts.queueHealth', every: 'jobs.queueHealthSeconds', unit: 's' },
  { job: 'nurse.expireDocuments', every: 'jobs.documentExpiryMinutes', unit: 'm' },
  { job: 'emergency.sweep', every: 'jobs.emergencySweepSeconds', unit: 's' },
  { job: 'review.reconcileAggregates', every: 'jobs.reviewReconcileMinutes', unit: 'm' },
] as const;
