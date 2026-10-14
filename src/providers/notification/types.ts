/**
 * Delivery-provider contracts for notifications. Business code depends ONLY on these interfaces;
 * SMTP/SES/SendGrid, FCM/APNs etc. are new implementations (Phase 4 ships mocks and a dev log email).
 * Messages carry minimal, non-clinical text and reference ids only.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
  /** Stable reference (notification id) so providers can de-duplicate on their side. */
  reference: string;
}
export interface PushMessage {
  userId: string;
  /** The recipient's active device registrations (resolved by the delivery worker). */
  tokens: { token: string; platform: string }[];
  title: string;
  body: string;
  data?: Record<string, string>;
  reference: string;
}
export interface SendResult {
  providerMessageId?: string;
  /** Push only: tokens the provider reported dead (uninstalled / expired); they get deactivated. */
  invalidTokens?: string[];
}

/** Failure of a notification provider call. `retryable=false` => never retried (bad address, rejected payload). */
export class NotificationProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable = true,
  ) {
    super(message);
    this.name = 'NotificationProviderError';
  }
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<SendResult>;
}
export interface PushProvider {
  readonly name: string;
  send(message: PushMessage): Promise<SendResult>;
}
