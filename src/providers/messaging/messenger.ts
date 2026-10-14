import { randomUUID } from 'node:crypto';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { SesEmailProvider } from '../notification/ses';
import type { EmailProvider } from '../notification/types';
import { TwilioSmsProvider, type SmsProvider } from './twilio';

export interface OutboundMessage {
  channel: 'EMAIL' | 'SMS';
  to: string;
  /** Machine-readable purpose, e.g. PASSWORD_RESET, EMAIL_VERIFY, PHONE_OTP. */
  purpose: string;
  subject?: string;
  body: string;
}

/** Abstraction over email/SMS. Real providers (SMTP, SMS gateway) plug in here in Phase 4. */
export interface Messenger {
  send(message: OutboundMessage): Promise<void>;
}

/**
 * Development/test messenger: keeps messages in memory (so tests and local devs can read
 * reset links/OTPs) and logs metadata only. Message bodies are logged at debug level in
 * non-production only, never in production.
 */
export class LogMessenger implements Messenger {
  readonly outbox: OutboundMessage[] = [];

  async send(message: OutboundMessage): Promise<void> {
    if (env.isProd) {
      logger.warn(
        { channel: message.channel, purpose: message.purpose },
        'No messaging provider configured; message dropped',
      );
      return;
    }
    this.outbox.push(message);
    if (this.outbox.length > 200) this.outbox.shift();
    logger.info(
      { channel: message.channel, purpose: message.purpose },
      'Message queued (dev outbox)',
    );
    logger.debug({ to: message.to, body: message.body }, 'Dev message body');
  }

  last(purpose: string, to?: string): OutboundMessage | undefined {
    return [...this.outbox].reverse().find((m) => m.purpose === purpose && (!to || m.to === to));
  }

  clear(): void {
    this.outbox.length = 0;
  }
}

/**
 * Production messenger: EMAIL through the configured EmailProvider (SES), SMS through Twilio. A channel without a
 * real provider falls back to the dev outbox (which drops in production — startup validation prevents that).
 */
export class ProviderMessenger implements Messenger {
  constructor(
    private readonly fallback: Messenger,
    private readonly email?: EmailProvider,
    private readonly sms?: SmsProvider,
  ) {}

  async send(message: OutboundMessage): Promise<void> {
    if (message.channel === 'EMAIL' && this.email) {
      await this.email.send({
        to: message.to,
        subject: message.subject ?? 'CareFlow',
        body: message.body,
        reference: `${message.purpose}:${randomUUID()}`,
      });
      logger.info({ channel: 'EMAIL', purpose: message.purpose, provider: this.email.name }, 'Message sent');
      return;
    }
    if (message.channel === 'SMS' && this.sms) {
      await this.sms.send(message.to, message.body);
      logger.info({ channel: 'SMS', purpose: message.purpose, provider: this.sms.name }, 'Message sent');
      return;
    }
    await this.fallback.send(message);
  }
}

function defaultMessenger(): Messenger {
  const outbox = new LogMessenger();
  const credentials = { accessKeyId: env.AWS_ACCESS_KEY_ID ?? '', secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? '', sessionToken: env.AWS_SESSION_TOKEN };
  const email = env.EMAIL_PROVIDER === 'ses' ? new SesEmailProvider({ region: env.SES_REGION!, from: env.EMAIL_FROM!, credentials }) : undefined;
  const sms =
    env.SMS_PROVIDER === 'twilio'
      ? new TwilioSmsProvider({
          accountSid: env.TWILIO_ACCOUNT_SID!,
          authToken: env.TWILIO_AUTH_TOKEN!,
          from: env.TWILIO_FROM,
          messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
        })
      : undefined;
  return email || sms ? new ProviderMessenger(outbox, email, sms) : outbox;
}

let messenger: Messenger = defaultMessenger();
export const getMessenger = (): Messenger => messenger;
export const setMessenger = (m: Messenger): void => {
  messenger = m;
};
