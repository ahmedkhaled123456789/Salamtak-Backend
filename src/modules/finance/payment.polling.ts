import { createHash } from 'node:crypto';
import { logger } from '../../config/logger';
import { getPaymentProvider, type ProviderEvent } from '../../providers/payment';
import { AlertService } from '../alerts';
import { Payment } from '../payments';
import { SettingsService } from '../settings';
import { PaymentWebhookService } from './webhook.service';

export interface PollSummary {
  checked: number;
  applied: number;
  unchanged: number;
  stale: number;
  errors: number;
  invalid: number;
}

const KNOWN = ['PENDING', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED'];

/**
 * Status polling for payments whose webhook never arrived (or is delayed). It NEVER decides that a
 * payment is paid: it asks the provider's authoritative lookup and feeds the answer through exactly
 * the same pipeline as a verified webhook (`processVerified`: inbox row, amount/currency checks,
 * late-payment rules, single transaction). Pending answers change nothing.
 */
export const PaymentPollingService = {
  async pollDue(now = new Date(), limit = 50): Promise<PollSummary> {
    const settings = await SettingsService.getAll();
    const provider = getPaymentProvider();
    const olderThan = new Date(now.getTime() - settings['payment.pollAfterMinutes'] * 60_000);
    const staleBefore = new Date(now.getTime() - settings['payment.staleAlertMinutes'] * 60_000);
    const due = await Payment.find({
      status: { $in: ['PENDING', 'PROCESSING'] },
      providerTransactionId: { $exists: true },
      createdAt: { $lte: olderThan },
    })
      .sort({ createdAt: 1 })
      .limit(limit);

    const out: PollSummary = {
      checked: 0,
      applied: 0,
      unchanged: 0,
      stale: 0,
      errors: 0,
      invalid: 0,
    };
    for (const p of due) {
      out.checked += 1;
      const tx = p.providerTransactionId as string;
      try {
        const v = await provider.verifyPayment(tx);
        if (!KNOWN.includes(v.status)) {
          out.invalid += 1;
          await AlertService.raise({
            key: `payment-poll-invalid-status:${String(p._id)}`,
            type: 'PAYMENT_POLL_INVALID_STATUS',
            severity: 'WARNING',
            entity: 'Payment',
            entityId: String(p._id),
            message:
              'The payment provider returned an unrecognised payment status; nothing was changed',
            data: { provider: provider.name },
          });
          continue;
        }
        const type: ProviderEvent['type'] | undefined =
          v.status === 'PAID'
            ? 'payment.succeeded'
            : v.status === 'FAILED'
              ? 'payment.failed'
              : v.status === 'CANCELLED'
                ? 'payment.cancelled'
                : undefined;
        if (!type) {
          out.unchanged += 1;
          if (p.createdAt <= staleBefore) {
            out.stale += 1;
            await AlertService.raise({
              key: `payment-stale:${String(p._id)}`,
              type: 'PAYMENT_STALE',
              severity: 'WARNING',
              entity: 'Payment',
              entityId: String(p._id),
              message: 'A payment has been unresolved at the provider for a long time',
              data: { providerStatus: v.status, createdAt: p.createdAt },
            });
          }
          continue;
        }
        const event: ProviderEvent = {
          // one logical event per payment+outcome: repeated polls are duplicates of the inbox row
          eventId: `poll:${tx}:${v.status}`,
          type,
          providerTransactionId: tx,
          ...(type === 'payment.succeeded' && { amountMinor: v.amountMinor, currency: v.currency }),
        };
        const hash = createHash('sha256').update(JSON.stringify(event)).digest('hex');
        const res = await PaymentWebhookService.processVerified(event, hash);
        if (res.status === 'PROCESSED') out.applied += 1;
        else out.unchanged += 1;
      } catch (err) {
        out.errors += 1;
        logger.warn(
          { paymentId: String(p._id), err: (err as Error).message },
          'Payment status poll failed (will be retried)',
        );
      }
    }
    return out;
  },
};
