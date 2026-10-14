import { env } from '../../config/env';
import { headerValue, verifySignedPayload } from './signature';
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

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<Record<string, unknown>>;
}>;

const form = (o: Record<string, string | number | boolean | undefined>) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');

/**
 * Stripe adapter over the plain REST API (no SDK dependency). Skeleton: request shapes, error
 * classification and webhook verification are implemented and unit-tested with an injected fetch;
 * it has NOT been exercised against live Stripe. Secrets come only from env.
 * Business code never imports this file; it only sees the PaymentProvider interface.
 */
export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe';
  private readonly base = 'https://api.stripe.com/v1';

  constructor(
    private readonly secretKey = env.PAYMENT_SECRET_KEY,
    private readonly webhookSecret = env.PAYMENT_WEBHOOK_SECRET,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {
    if (!secretKey || !webhookSecret) {
      throw new Error(
        'StripePaymentProvider requires PAYMENT_SECRET_KEY and PAYMENT_WEBHOOK_SECRET',
      );
    }
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, string | number | boolean | undefined>,
    idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    let res;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(idempotencyKey && { 'Idempotency-Key': idempotencyKey }),
        },
        body: body ? form(body) : undefined,
      });
    } catch (err) {
      throw new ProviderError(`Stripe network error: ${(err as Error).message}`, true, 'network');
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const e = (json.error ?? {}) as { message?: string; code?: string };
      // 4xx (except 409/429) means the request itself is wrong: retrying cannot help.
      const retryable = res.status >= 500 || res.status === 429 || res.status === 409;
      throw new ProviderError(e.message ?? `Stripe error ${res.status}`, retryable, e.code);
    }
    return json;
  }

  async createPayment(i: CreatePaymentInput): Promise<CreatePaymentResult> {
    const meta = Object.fromEntries(
      Object.entries(i.metadata).map(([k, v]) => [`metadata[${k}]`, v]),
    );
    const j = await this.call(
      'POST',
      '/payment_intents',
      {
        amount: i.amountMinor,
        currency: i.currency.toLowerCase(),
        description: i.description,
        'automatic_payment_methods[enabled]': true,
        'metadata[reference]': i.reference,
        ...meta,
      },
      i.idempotencyKey,
    );
    return {
      providerTransactionId: String(j.id),
      status: 'PENDING',
      clientSecret: typeof j.client_secret === 'string' ? j.client_secret : undefined,
    };
  }

  async verifyPayment(id: string): Promise<VerifyPaymentResult> {
    const j = await this.call('GET', `/payment_intents/${encodeURIComponent(id)}`);
    const map: Record<string, VerifyPaymentResult['status']> = {
      succeeded: 'PAID',
      processing: 'PROCESSING',
      canceled: 'CANCELLED',
      requires_payment_method: 'PENDING',
      requires_action: 'PENDING',
      requires_confirmation: 'PENDING',
    };
    return {
      status: map[String(j.status)] ?? 'PENDING',
      amountMinor: Number(j.amount ?? 0),
      currency: String(j.currency ?? '').toUpperCase(),
    };
  }

  async cancelPayment(id: string): Promise<void> {
    await this.call('POST', `/payment_intents/${encodeURIComponent(id)}/cancel`);
  }

  async refundPayment(i: RefundInput): Promise<RefundResult> {
    const j = await this.call(
      'POST',
      '/refunds',
      {
        payment_intent: i.providerTransactionId,
        amount: i.amountMinor,
        reason: 'requested_by_customer',
        'metadata[reason]': i.reason,
      },
      i.idempotencyKey,
    );
    const status =
      j.status === 'succeeded'
        ? 'SUCCEEDED'
        : j.status === 'failed' || j.status === 'canceled'
          ? 'FAILED'
          : 'PENDING';
    return {
      providerRefundId: String(j.id),
      status,
      raw: { status: j.status, failure_reason: j.failure_reason },
    };
  }

  async getRefund(providerRefundId: string): Promise<RefundResult> {
    const j = await this.call('GET', `/refunds/${encodeURIComponent(providerRefundId)}`);
    const status =
      j.status === 'succeeded'
        ? 'SUCCEEDED'
        : j.status === 'failed' || j.status === 'canceled'
          ? 'FAILED'
          : 'PENDING';
    return {
      providerRefundId: String(j.id),
      status,
      raw: { status: j.status, failure_reason: j.failure_reason },
    };
  }

  /** Connect transfer to a connected account token (`acct_...`) held by the nurse. */
  async createPayout(i: PayoutInput): Promise<PayoutResult> {
    const j = await this.call(
      'POST',
      '/transfers',
      {
        amount: i.amountMinor,
        currency: i.currency.toLowerCase(),
        destination: i.providerRef,
        'metadata[reference]': i.reference,
      },
      i.idempotencyKey,
    );
    return { providerPayoutId: String(j.id), status: 'PAID' };
  }

  verifyWebhook(rawBody: Buffer, headers: HeaderBag): ProviderEvent {
    verifySignedPayload(
      this.webhookSecret as string,
      rawBody,
      headerValue(headers, 'stripe-signature'),
    );
    let e: {
      id?: string;
      type?: string;
      created?: number;
      data?: { object?: Record<string, unknown> };
    };
    try {
      e = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new WebhookSignatureError('Malformed payload');
    }
    if (!e.id || !e.type) throw new WebhookSignatureError('Malformed payload');
    const o = e.data?.object ?? {};
    const base = { eventId: e.id };
    switch (e.type) {
      case 'payment_intent.succeeded':
        return {
          ...base,
          type: 'payment.succeeded',
          providerTransactionId: String(o.id),
          amountMinor: Number(o.amount_received ?? o.amount),
          currency: String(o.currency).toUpperCase(),
          // the (signed) event creation time is when Stripe recorded the success
          paidAt: typeof e.created === 'number' ? new Date(e.created * 1000) : undefined,
        };
      case 'payment_intent.processing':
        return { ...base, type: 'payment.processing', providerTransactionId: String(o.id) };
      case 'payment_intent.payment_failed':
        return {
          ...base,
          type: 'payment.failed',
          providerTransactionId: String(o.id),
          failureReason: (o.last_payment_error as { code?: string } | undefined)?.code,
        };
      case 'payment_intent.canceled':
        return { ...base, type: 'payment.cancelled', providerTransactionId: String(o.id) };
      case 'refund.updated':
      case 'refund.created':
        if (o.status === 'succeeded')
          return {
            ...base,
            type: 'refund.succeeded',
            providerRefundId: String(o.id),
            providerTransactionId: String(o.payment_intent),
            amountMinor: Number(o.amount),
            currency: String(o.currency).toUpperCase(),
          };
        if (o.status === 'failed' || o.status === 'canceled')
          return {
            ...base,
            type: 'refund.failed',
            providerRefundId: String(o.id),
            providerTransactionId: String(o.payment_intent),
            failureReason: String(o.failure_reason ?? ''),
          };
        return { ...base, type: 'unknown' };
      default:
        return { ...base, type: 'unknown' };
    }
  }
}
