import type { PaymentDoc } from './payment.models';

/**
 * Optional listener run after a payment intent is created. Used ONLY by the portfolio demo (DEMO_MODE with the mock
 * provider, see finance.hooks.ts) to confirm the payment through the normal signed-webhook pipeline. Real providers
 * confirm asynchronously with their own webhooks and never use this.
 */
type AfterCreate = (payment: PaymentDoc) => Promise<void>;
let afterCreate: AfterCreate | undefined;

export const registerPaymentHooks = (h: { afterCreate?: AfterCreate }): void => {
  afterCreate = h.afterCreate;
};
export const runAfterCreate = async (payment: PaymentDoc): Promise<void> => {
  if (afterCreate) await afterCreate(payment);
};
