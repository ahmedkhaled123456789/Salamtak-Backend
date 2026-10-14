import { randomBytes, randomUUID } from 'node:crypto';
import { env } from '../../config/env';
import { signPayload, verifySignedPayload, headerValue } from './signature';
import {
  ProviderError,
  WebhookSignatureError,
  type CreatePaymentInput,
  type CreatePaymentResult,
  type HeaderBag,
  type PayoutInput,
  type PayoutResult,
  type PaymentProvider,
  type ProviderEvent,
  type RefundInput,
  type RefundResult,
  type VerifyPaymentResult,
} from './types';

interface MockPayment {
  amountMinor: number;
  currency: string;
  status: VerifyPaymentResult['status'];
}

/**
 * Development/test provider. REFUSES TO RUN IN PRODUCTION. Webhooks go through exactly the same
 * signature verification as a real provider (HMAC over timestamp + raw body); tests build signed
 * deliveries with `signEvent` and POST them to the real webhook endpoint.
 * Provider operations are idempotent per idempotencyKey, like real gateways.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';
  private readonly secret: string;
  private payments = new Map<string, MockPayment>();
  private byKey = new Map<string, CreatePaymentResult>();
  private refunds = new Map<string, RefundResult>();
  private payouts = new Map<string, PayoutResult>();
  private refundsById = new Map<string, RefundResult>();
  private payoutsById = new Map<string, PayoutResult>();
  /** Test controls */
  refundFailuresRemaining = 0;
  refundFailRetryable = true;
  refundMode: 'SYNC' | 'ASYNC' = 'SYNC';
  payoutFailuresRemaining = 0;
  payoutFailRetryable = true;
  payoutMode: 'SYNC' | 'ASYNC' = 'SYNC';
  getRefundFailures = 0;
  readonly calls = { refund: 0, payout: 0, create: 0, getRefund: 0 };

  constructor(secret = env.PAYMENT_WEBHOOK_SECRET) {
    MockPaymentProvider.assertAllowed();
    this.secret = secret ?? randomBytes(32).toString('hex'); // dev convenience; never a fixed literal
  }

  static assertAllowed(): void {
    if (env.isProd && !env.DEMO_MODE) throw new Error('MockPaymentProvider is disabled in production');
  }

  get webhookSecret(): string {
    return this.secret;
  }

  async createPayment(i: CreatePaymentInput): Promise<CreatePaymentResult> {
    MockPaymentProvider.assertAllowed();
    const prior = this.byKey.get(i.idempotencyKey);
    if (prior) return prior;
    this.calls.create += 1;
    const id = `mock_pi_${randomBytes(9).toString('hex')}`;
    this.payments.set(id, { amountMinor: i.amountMinor, currency: i.currency, status: 'PENDING' });
    const res: CreatePaymentResult = {
      providerTransactionId: id,
      status: 'PENDING',
      clientSecret: `${id}_secret_${randomBytes(6).toString('hex')}`,
    };
    this.byKey.set(i.idempotencyKey, res);
    return res;
  }

  async verifyPayment(id: string): Promise<VerifyPaymentResult> {
    MockPaymentProvider.assertAllowed();
    const p = this.payments.get(id);
    if (!p) throw new ProviderError('unknown payment', false, 'resource_missing');
    return { status: p.status, amountMinor: p.amountMinor, currency: p.currency };
  }

  async cancelPayment(id: string): Promise<void> {
    MockPaymentProvider.assertAllowed();
    const p = this.payments.get(id);
    if (p && p.status === 'PENDING') p.status = 'CANCELLED';
  }

  async refundPayment(i: RefundInput): Promise<RefundResult> {
    MockPaymentProvider.assertAllowed();
    const prior = this.refunds.get(i.idempotencyKey);
    if (prior) return prior; // idempotent: a retry of the same refund never refunds twice
    this.calls.refund += 1;
    if (this.refundFailuresRemaining > 0) {
      this.refundFailuresRemaining -= 1;
      throw new ProviderError(
        'mock provider refund failure',
        this.refundFailRetryable,
        'mock_refund_failed',
      );
    }
    const res: RefundResult = {
      providerRefundId: `mock_re_${randomBytes(9).toString('hex')}`,
      status: this.refundMode === 'SYNC' ? 'SUCCEEDED' : 'PENDING',
      raw: { amount: i.amountMinor, currency: i.currency, reason: i.reason },
    };
    this.refunds.set(i.idempotencyKey, res);
    this.refundsById.set(res.providerRefundId, res);
    return res;
  }

  async createPayout(i: PayoutInput): Promise<PayoutResult> {
    MockPaymentProvider.assertAllowed();
    const prior = this.payouts.get(i.idempotencyKey);
    if (prior) return prior;
    this.calls.payout += 1;
    if (this.payoutFailuresRemaining > 0) {
      this.payoutFailuresRemaining -= 1;
      throw new ProviderError(
        'mock provider payout failure',
        this.payoutFailRetryable,
        'mock_payout_failed',
      );
    }
    const res: PayoutResult = {
      providerPayoutId: `mock_po_${randomBytes(9).toString('hex')}`,
      status: this.payoutMode === 'SYNC' ? 'PAID' : 'PENDING',
    };
    this.payouts.set(i.idempotencyKey, res);
    this.payoutsById.set(res.providerPayoutId, res);
    return res;
  }

  async getRefund(providerRefundId: string): Promise<RefundResult> {
    MockPaymentProvider.assertAllowed();
    this.calls.getRefund += 1;
    if (this.getRefundFailures > 0) {
      this.getRefundFailures -= 1;
      throw new ProviderError('mock provider lookup failure', true, 'mock_lookup_failed');
    }
    const r = this.refundsById.get(providerRefundId);
    if (!r) throw new ProviderError('unknown refund', false, 'resource_missing');
    return r;
  }

  async getPayout(providerPayoutId: string): Promise<PayoutResult> {
    MockPaymentProvider.assertAllowed();
    const r = this.payoutsById.get(providerPayoutId);
    if (!r) throw new ProviderError('unknown payout', false, 'resource_missing');
    return r;
  }

  /** Test control: the provider eventually settles an asynchronous refund/payout. */
  settleRefund(providerRefundId: string, status: 'SUCCEEDED' | 'FAILED'): void {
    const r = this.refundsById.get(providerRefundId);
    if (r) r.status = status;
  }
  settlePayout(providerPayoutId: string, status: 'PAID' | 'FAILED'): void {
    const r = this.payoutsById.get(providerPayoutId);
    if (r) r.status = status;
  }

  verifyWebhook(rawBody: Buffer, headers: HeaderBag): ProviderEvent {
    MockPaymentProvider.assertAllowed();
    verifySignedPayload(this.secret, rawBody, headerValue(headers, 'x-mock-signature'));
    let j: { id?: unknown; type?: unknown; data?: Record<string, unknown> };
    try {
      j = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new WebhookSignatureError('Malformed payload');
    }
    if (typeof j.id !== 'string' || typeof j.type !== 'string')
      throw new WebhookSignatureError('Malformed payload');
    const d = j.data ?? {};
    const known = [
      'payment.processing',
      'payment.succeeded',
      'payment.failed',
      'payment.cancelled',
      'refund.succeeded',
      'refund.failed',
      'payout.paid',
      'payout.failed',
    ];
    return {
      eventId: j.id,
      type: (known.includes(j.type) ? j.type : 'unknown') as ProviderEvent['type'],
      providerTransactionId:
        typeof d.providerTransactionId === 'string' ? d.providerTransactionId : undefined,
      providerRefundId: typeof d.providerRefundId === 'string' ? d.providerRefundId : undefined,
      providerPayoutId: typeof d.providerPayoutId === 'string' ? d.providerPayoutId : undefined,
      amountMinor: typeof d.amountMinor === 'number' ? d.amountMinor : undefined,
      currency: typeof d.currency === 'string' ? d.currency : undefined,
      failureReason: typeof d.failureReason === 'string' ? d.failureReason : undefined,
      paidAt: typeof d.paidAt === 'string' ? new Date(d.paidAt) : undefined,
    };
  }

  // ---------- test / dev helpers (signed exactly like a real delivery) ----------
  /** Marks the mock-side payment as paid and returns a signed `payment.succeeded` delivery. */
  signEvent(
    type: ProviderEvent['type'],
    data: Record<string, string | number | null | undefined> = {},
    opts: { eventId?: string; secret?: string; timestamp?: number } = {},
  ): { rawBody: Buffer; headers: Record<string, string> } {
    const payload = {
      id: opts.eventId ?? `evt_${randomUUID()}`,
      type,
      data,
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const header = signPayload(
      opts.secret ?? this.secret,
      rawBody,
      opts.timestamp ?? Math.floor(Date.now() / 1000),
    );
    return { rawBody, headers: { 'x-mock-signature': header, 'content-type': 'application/json' } };
  }

  /** Records provider-side state, e.g. after a simulated customer payment. */
  markPaid(providerTransactionId: string): void {
    const p = this.payments.get(providerTransactionId);
    if (p) p.status = 'PAID';
  }
}
