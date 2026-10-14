import { createHmac, timingSafeEqual } from 'node:crypto';
import { WebhookSignatureError, type HeaderBag } from './types';

const TOLERANCE_SECONDS = 300;

export const headerValue = (h: HeaderBag, name: string): string | undefined => {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

/** `t=<unix>,v1=<hex>[,v1=<hex>]` (Stripe-compatible scheme; also used by the mock provider). */
export function signPayload(secret: string, rawBody: Buffer | string, timestamp: number): string {
  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const sig = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

/** Constant-time HMAC check with replay protection (timestamp tolerance). Throws WebhookSignatureError. */
export function verifySignedPayload(
  secret: string,
  rawBody: Buffer,
  header: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): void {
  if (!header) throw new WebhookSignatureError('Missing signature header');
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const candidates = parts.filter(([k]) => k === 'v1').map(([, v]) => v ?? '');
  if (!Number.isFinite(t) || candidates.length === 0) throw new WebhookSignatureError();
  if (Math.abs(nowSeconds - t) > TOLERANCE_SECONDS)
    throw new WebhookSignatureError('Timestamp outside tolerance');
  const expected = Buffer.from(
    createHmac('sha256', secret)
      .update(`${t}.${rawBody.toString('utf8')}`)
      .digest('hex'),
  );
  const ok = candidates.some((c) => {
    const got = Buffer.from(c);
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
  if (!ok) throw new WebhookSignatureError();
}
