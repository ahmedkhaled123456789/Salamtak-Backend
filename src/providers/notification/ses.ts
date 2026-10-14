import { sha256Hex, signRequest, type SigV4Credentials } from '../../common/utils/sigv4';
import { NotificationProviderError, type EmailMessage, type EmailProvider, type SendResult } from './types';

/** Amazon SES v2 `SendEmail` over HTTPS (SigV4). Plain-text bodies only: messages carry no clinical content. */
export class SesEmailProvider implements EmailProvider {
  readonly name = 'ses';
  constructor(
    private readonly o: { region: string; from: string; credentials: SigV4Credentials; timeoutMs?: number },
  ) {}

  async send(m: EmailMessage): Promise<SendResult> {
    const url = new URL(`https://email.${this.o.region}.amazonaws.com/v2/email/outbound-emails`);
    const body = JSON.stringify({
      FromEmailAddress: this.o.from,
      Destination: { ToAddresses: [m.to] },
      Content: {
        Simple: {
          Subject: { Data: m.subject, Charset: 'UTF-8' },
          Body: { Text: { Data: m.body, Charset: 'UTF-8' } },
        },
      },
    });
    const headers = signRequest(
      {
        method: 'POST',
        url,
        region: this.o.region,
        service: 'ses',
        headers: { 'content-type': 'application/json' },
        payloadHash: sha256Hex(body),
      },
      this.o.credentials,
    );
    delete headers.host;
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000) });
    } catch (err) {
      throw new NotificationProviderError(`SES unreachable: ${(err as Error).name}`, true);
    }
    if (res.ok) {
      const j = (await res.json().catch(() => ({}))) as { MessageId?: string };
      return { providerMessageId: j.MessageId };
    }
    // throttling and server errors are worth retrying; a rejected message/address is not
    throw new NotificationProviderError(`SES rejected the email (${res.status})`, res.status === 429 || res.status >= 500);
  }
}
