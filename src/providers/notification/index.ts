import { env } from '../../config/env';
import { logger } from '../../config/logger';
import type { EmailMessage, EmailProvider, PushProvider, SendResult } from './types';

export * from './types';
export { MockEmailProvider, MockPushProvider } from './mock';
export { SesEmailProvider } from './ses';
export { ExpoPushProvider, isExpoPushToken } from './expo-push';
import { SesEmailProvider } from './ses';
import { ExpoPushProvider } from './expo-push';

/** Development email provider: logs metadata only (never the body). Selected with EMAIL_PROVIDER=log. */
class LogEmailProvider implements EmailProvider {
  readonly name = 'log-email';
  async send(m: EmailMessage): Promise<SendResult> {
    logger.info({ reference: m.reference }, 'Email (dev log provider)');
    return { providerMessageId: `log_${m.reference}` };
  }
}

let email: EmailProvider | undefined | null = null; // null = not resolved yet
let push: PushProvider | undefined | null = null;

/**
 * `undefined` means "no provider configured": deliveries are recorded as SKIPPED (never an error,
 * the app keeps running). Production providers are registered here when they exist.
 */
export function getEmailProvider(): EmailProvider | undefined {
  if (email === null)
    email =
      env.EMAIL_PROVIDER === 'log'
        ? new LogEmailProvider()
        : env.EMAIL_PROVIDER === 'ses'
          ? new SesEmailProvider({
              region: env.SES_REGION!,
              from: env.EMAIL_FROM!,
              credentials: {
                accessKeyId: env.AWS_ACCESS_KEY_ID ?? '',
                secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? '',
                sessionToken: env.AWS_SESSION_TOKEN,
              },
            })
          : undefined;
  return email;
}
export function getPushProvider(): PushProvider | undefined {
  if (push === null)
    push = env.PUSH_PROVIDER === 'expo' ? new ExpoPushProvider({ accessToken: env.EXPO_ACCESS_TOKEN }) : undefined;
  return push;
}
export const setEmailProvider = (p: EmailProvider | undefined): void => {
  email = p;
};
export const setPushProvider = (p: PushProvider | undefined): void => {
  push = p;
};
export const resetNotificationProviders = (): void => {
  email = null;
  push = null;
};
