import { NotificationProviderError } from '../notification/types';

export interface SmsProvider {
  readonly name: string;
  send(to: string, body: string): Promise<{ providerMessageId?: string }>;
}

// Twilio errors that will never succeed on retry (invalid/unreachable number, blocked, unverified sender...).
const PERMANENT = new Set([21211, 21212, 21408, 21610, 21612, 21614, 21606, 21659]);

/** Twilio Programmable Messaging over HTTPS. Bodies are short codes/notices only (no clinical content). */
export class TwilioSmsProvider implements SmsProvider {
  readonly name = 'twilio';
  constructor(
    private readonly o: {
      accountSid: string;
      authToken: string;
      from?: string;
      messagingServiceSid?: string;
      timeoutMs?: number;
    },
  ) {}

  async send(to: string, body: string): Promise<{ providerMessageId?: string }> {
    const form = new URLSearchParams({ To: to, Body: body });
    if (this.o.messagingServiceSid) form.set('MessagingServiceSid', this.o.messagingServiceSid);
    else if (this.o.from) form.set('From', this.o.from);
    let res: Response;
    try {
      res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.o.accountSid)}/Messages.json`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${this.o.accountSid}:${this.o.authToken}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
      });
    } catch (err) {
      throw new NotificationProviderError(`Twilio unreachable: ${(err as Error).name}`, true);
    }
    const j = (await res.json().catch(() => ({}))) as { sid?: string; code?: number };
    if (res.ok) return { providerMessageId: j.sid };
    const retryable = res.status === 429 || res.status >= 500;
    throw new NotificationProviderError(
      `Twilio rejected the SMS (${res.status}${j.code ? `/${j.code}` : ''})`,
      retryable && !(j.code && PERMANENT.has(j.code)),
    );
  }
}
