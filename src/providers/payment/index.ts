import { env } from '../../config/env';
import { MockPaymentProvider } from './mock.provider';
import { StripePaymentProvider } from './stripe.provider';
import type { PayoutProvider, PaymentProvider } from './types';

export * from './types';
export { MockPaymentProvider } from './mock.provider';
export { StripePaymentProvider } from './stripe.provider';
export { signPayload, verifySignedPayload } from './signature';

let instance: PaymentProvider | undefined;
let payoutInstance: PayoutProvider | undefined;

/** The active provider is chosen by PAYMENT_PROVIDER. Adding Telr/PayTabs = one more case here. */
export function getPaymentProvider(): PaymentProvider {
  if (!instance) {
    switch (env.PAYMENT_PROVIDER) {
      case 'stripe':
        instance = new StripePaymentProvider();
        break;
      case 'mock':
        instance = new MockPaymentProvider();
        break;
    }
  }
  return instance as PaymentProvider;
}

/** Payouts default to the payment provider but may be a separate PayoutProvider. */
export const getPayoutProvider = (): PayoutProvider => payoutInstance ?? getPaymentProvider();

export function setPaymentProvider(p: PaymentProvider | undefined): void {
  instance = p;
}
export function setPayoutProvider(p: PayoutProvider | undefined): void {
  payoutInstance = p;
}
