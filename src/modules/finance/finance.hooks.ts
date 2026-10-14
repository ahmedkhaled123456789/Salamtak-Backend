import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { MockPaymentProvider, getPaymentProvider } from '../../providers/payment';
import { registerPaymentHooks, type PaymentDoc } from '../payments';
import { PaymentWebhookService } from './webhook.service';
import { registerBookingHooks } from '../bookings';
import { BookingService } from '../bookings';
import { PayoutService } from '../payouts';
import { RefundService } from '../refunds';
import { WalletService } from '../wallets';
import { ZeroPayment } from './zero-payment';

/** Wires the finance modules into booking transitions. Called once from createApp(). */
export function registerFinancialHooks(): void {
  registerBookingHooks({
    onRefundPending: (booking, session) => RefundService.onBookingRefundPending(booking, session),
    zeroPayment: ZeroPayment,
  });
  // Portfolio demo only (DEMO_MODE requires the mock provider): confirm each new payment at once through the same
  // signed-webhook pipeline a real provider uses, so every ledger/booking effect is the real one.
  registerPaymentHooks({ afterCreate: env.DEMO_MODE ? confirmDemoPayment : undefined });
}

async function confirmDemoPayment(payment: PaymentDoc): Promise<void> {
  const provider = getPaymentProvider();
  if (!env.DEMO_MODE || !(provider instanceof MockPaymentProvider) || !payment.providerTransactionId) return;
  if (payment.status !== 'PENDING' && payment.status !== 'PROCESSING') return;
  const { rawBody, headers } = provider.signEvent('payment.succeeded', {
    providerTransactionId: payment.providerTransactionId,
    amountMinor: payment.amountMinor,
    currency: payment.currency,
  });
  provider.markPaid(payment.providerTransactionId);
  await PaymentWebhookService.handle(rawBody, headers);
}

/**
 * One pass over every time-driven obligation. All steps are idempotent and safe to run on several
 * instances at once. Phase 4 schedules this with BullMQ; until then it can be run by an admin
 * (POST /admin/finance/process-due) or by the optional in-process timer (INLINE_JOBS=true).
 */
export async function runFinanceSweeps(now = new Date()) {
  const expired = await BookingService.expireDue(now);
  const noShows = await BookingService.flagNoShows(now);
  const completed = await BookingService.autoCompleteDue(now);
  const refundRequests = await BookingService.reconcileRefundRequests(now);
  const refunds = await RefundService.processDue(now);
  const released = await WalletService.releaseDue(now);
  const payouts = await PayoutService.processDue(now);
  return { expired, noShows, completed, refundRequests, refunds, released, payouts };
}

export function startInlineJobs(intervalMs = 30_000): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    runFinanceSweeps()
      .catch((err) => logger.error({ err: (err as Error).message }, 'Inline finance sweep failed'))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
