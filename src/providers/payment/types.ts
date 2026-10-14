export type ProviderEventType =
  | 'payment.processing'
  | 'payment.succeeded'
  | 'payment.failed'
  | 'payment.cancelled'
  | 'refund.succeeded'
  | 'refund.failed'
  | 'payout.paid'
  | 'payout.failed'
  | 'unknown';

/** Provider-neutral event produced by verifyWebhook. Never contains card data or secrets. */
export interface ProviderEvent {
  eventId: string;
  type: ProviderEventType;
  providerTransactionId?: string;
  providerRefundId?: string;
  providerPayoutId?: string;
  amountMinor?: number;
  currency?: string;
  failureReason?: string;
  /**
   * When the PROVIDER says the payment succeeded/was authorised. Only ever set from provider data that
   * passed signature verification; the consumer still sanity-checks it before relying on it.
   */
  paidAt?: Date;
}

export interface CreatePaymentInput {
  reference: string;
  amountMinor: number;
  currency: 'AED';
  description?: string;
  metadata: Record<string, string>;
  /** Same key => same provider payment (safe to retry). */
  idempotencyKey: string;
}
export interface CreatePaymentResult {
  providerTransactionId: string;
  status: 'PENDING' | 'PROCESSING';
  /** Handed to the client once; NEVER persisted. */
  clientSecret?: string;
  redirectUrl?: string;
}
export interface VerifyPaymentResult {
  status: 'PENDING' | 'PROCESSING' | 'PAID' | 'FAILED' | 'CANCELLED';
  amountMinor: number;
  currency: string;
}
export interface RefundInput {
  providerTransactionId: string;
  amountMinor: number;
  currency: string;
  /** Constant across retries of the same refund => the provider can never refund twice. */
  idempotencyKey: string;
  reason: string;
}
export interface RefundResult {
  providerRefundId: string;
  status: 'SUCCEEDED' | 'PENDING' | 'FAILED';
  /** Sanitised provider response kept for operations (no secrets/card data). */
  raw?: Record<string, unknown>;
}
export interface PayoutInput {
  /** Provider-managed token/account reference. Raw bank details are never accepted. */
  providerRef: string;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
  reference: string;
}
export interface PayoutResult {
  providerPayoutId: string;
  status: 'PAID' | 'PENDING' | 'FAILED';
}

/** Failure of a provider call. `retryable=false` means retrying cannot help (e.g. invalid request). */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable = true,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export type HeaderBag = Record<string, string | string[] | undefined>;

/**
 * Business code depends ONLY on this interface. Telr, PayTabs, Network International etc. are new
 * implementations of it; nothing in bookings/wallets/refunds knows about Stripe.
 */
export interface PaymentProvider {
  readonly name: string;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  verifyPayment(providerTransactionId: string): Promise<VerifyPaymentResult>;
  cancelPayment(providerTransactionId: string): Promise<void>;
  refundPayment(input: RefundInput): Promise<RefundResult>;
  /**
   * Authoritative refund status lookup (optional: providers without it rely on webhooks only).
   * Used to settle refunds the provider accepted asynchronously, without issuing them again.
   */
  getRefund?(providerRefundId: string): Promise<RefundResult>;
  createPayout(input: PayoutInput): Promise<PayoutResult>;
  getPayout?(providerPayoutId: string): Promise<PayoutResult>;
  /** Verifies the signature over the RAW body and returns a normalised event. Throws on any failure. */
  verifyWebhook(rawBody: Buffer, headers: HeaderBag): ProviderEvent;
}

export type PayoutProvider = Pick<PaymentProvider, 'name' | 'createPayout'>;

export class WebhookSignatureError extends Error {
  constructor(message = 'Invalid webhook signature') {
    super(message);
    this.name = 'WebhookSignatureError';
  }
}
