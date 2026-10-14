import type { ProviderError } from '../../src/providers/payment';
import {
  StripePaymentProvider,
  signPayload,
  verifySignedPayload,
  WebhookSignatureError,
} from '../../src/providers/payment';

type Call = {
  url: string;
  init: { method: string; headers: Record<string, string>; body?: string };
};

function fakeFetch(responses: { status: number; json: Record<string, unknown> }[]) {
  const calls: Call[] = [];
  const impl = async (url: string, init: Call['init']) => {
    calls.push({ url, init });
    const r = responses.shift() ?? { status: 200, json: {} };
    return { ok: r.status < 400, status: r.status, json: async () => r.json };
  };
  return { calls, impl };
}
const SECRET = 'sk_test_unit_secret';
const WH = 'whsec_unit_secret';
const make = (responses: { status: number; json: Record<string, unknown> }[] = []) => {
  const f = fakeFetch(responses);
  return { f, p: new StripePaymentProvider(SECRET, WH, f.impl as never) };
};
const sign = (payload: object, ts = Math.floor(Date.now() / 1000), secret = WH) => {
  const raw = Buffer.from(JSON.stringify(payload));
  return { raw, headers: { 'stripe-signature': signPayload(secret, raw, ts) } };
};

describe('StripePaymentProvider (skeleton, injected fetch)', () => {
  it('refuses to exist without secrets (nothing hard-coded)', () => {
    expect(() => new StripePaymentProvider('', 'x')).toThrow(/requires/);
    expect(() => new StripePaymentProvider('sk', '')).toThrow(/requires/);
  });

  it('createPayment: integer minor units, lowercase currency, idempotency header, bearer secret', async () => {
    const { f, p } = make([{ status: 200, json: { id: 'pi_1', client_secret: 'pi_1_secret_x' } }]);
    const r = await p.createPayment({
      reference: 'PAY-1',
      amountMinor: 16000,
      currency: 'AED',
      metadata: { bookingId: 'b1' },
      idempotencyKey: 'payment-1',
    });
    expect(r).toEqual({
      providerTransactionId: 'pi_1',
      status: 'PENDING',
      clientSecret: 'pi_1_secret_x',
    });
    const c = f.calls[0]!;
    expect(c.url).toBe('https://api.stripe.com/v1/payment_intents');
    expect(c.init.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(c.init.headers['Idempotency-Key']).toBe('payment-1');
    expect(c.init.body).toContain('amount=16000');
    expect(c.init.body).toContain('currency=aed');
    expect(c.init.body).toContain('metadata%5BbookingId%5D=b1');
  });

  it('refundPayment sends the payment intent, amount and a stable idempotency key; maps statuses', async () => {
    const { f, p } = make([
      { status: 200, json: { id: 're_1', status: 'succeeded' } },
      { status: 200, json: { id: 're_2', status: 'pending' } },
      {
        status: 200,
        json: { id: 're_3', status: 'failed', failure_reason: 'lost_or_stolen_card' },
      },
    ]);
    const input = {
      providerTransactionId: 'pi_1',
      amountMinor: 8000,
      currency: 'AED',
      idempotencyKey: 'refund-abc',
      reason: 'NURSE_REJECTED',
    };
    expect((await p.refundPayment(input)).status).toBe('SUCCEEDED');
    expect((await p.refundPayment(input)).status).toBe('PENDING');
    expect((await p.refundPayment(input)).status).toBe('FAILED');
    expect(f.calls[0]!.init.headers['Idempotency-Key']).toBe('refund-abc');
    expect(f.calls[0]!.init.body).toContain('payment_intent=pi_1');
    expect(f.calls[0]!.init.body).toContain('amount=8000');
  });

  it('classifies errors: network/5xx/429/409 are retryable, other 4xx are not', async () => {
    const run = async (status: number) => {
      const { p } = make([{ status, json: { error: { message: 'boom', code: 'c' } } }]);
      try {
        await p.refundPayment({
          providerTransactionId: 'pi',
          amountMinor: 1,
          currency: 'AED',
          idempotencyKey: 'k',
          reason: 'r',
        });
      } catch (e) {
        return (e as ProviderError).retryable;
      }
      return undefined;
    };
    expect(await run(500)).toBe(true);
    expect(await run(503)).toBe(true);
    expect(await run(429)).toBe(true);
    expect(await run(409)).toBe(true);
    expect(await run(400)).toBe(false);
    expect(await run(402)).toBe(false);
    expect(await run(404)).toBe(false);
    const down = new StripePaymentProvider(SECRET, WH, (async () => {
      throw new Error('ECONNRESET');
    }) as never);
    await expect(down.verifyPayment('pi')).rejects.toMatchObject({ retryable: true });
  });

  it('verifyPayment maps intent states', async () => {
    const { p } = make([
      { status: 200, json: { status: 'succeeded', amount: 16000, currency: 'aed' } },
    ]);
    expect(await p.verifyPayment('pi_1')).toEqual({
      status: 'PAID',
      amountMinor: 16000,
      currency: 'AED',
    });
  });

  it('verifies webhook signatures and normalises events (amount in minor units, upper-case currency)', () => {
    const { p } = make();
    const evt = {
      id: 'evt_1',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_1', amount: 16000, amount_received: 16000, currency: 'aed' } },
    };
    const { raw, headers } = sign(evt);
    expect(p.verifyWebhook(raw, headers)).toEqual({
      eventId: 'evt_1',
      type: 'payment.succeeded',
      providerTransactionId: 'pi_1',
      amountMinor: 16000,
      currency: 'AED',
    });
    const refund = sign({
      id: 'evt_2',
      type: 'refund.updated',
      data: { object: { id: 're_1', status: 'succeeded', payment_intent: 'pi_1' } },
    });
    expect(p.verifyWebhook(refund.raw, refund.headers)).toMatchObject({
      type: 'refund.succeeded',
      providerRefundId: 're_1',
    });
    const failed = sign({
      id: 'evt_3',
      type: 'payment_intent.payment_failed',
      data: { object: { id: 'pi_1', last_payment_error: { code: 'card_declined' } } },
    });
    expect(p.verifyWebhook(failed.raw, failed.headers)).toMatchObject({
      type: 'payment.failed',
      failureReason: 'card_declined',
    });
    const other = sign({ id: 'evt_4', type: 'customer.created', data: { object: {} } });
    expect(p.verifyWebhook(other.raw, other.headers).type).toBe('unknown');
  });

  it('rejects bad, missing, stale and wrong-secret signatures', () => {
    const { p } = make();
    const evt = { id: 'evt_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_1' } } };
    const good = sign(evt);
    expect(() => p.verifyWebhook(good.raw, {})).toThrow(WebhookSignatureError);
    expect(() => p.verifyWebhook(Buffer.from(good.raw.toString() + ' '), good.headers)).toThrow(
      WebhookSignatureError,
    );
    const wrong = sign(evt, undefined, 'whsec_other');
    expect(() => p.verifyWebhook(wrong.raw, wrong.headers)).toThrow(WebhookSignatureError);
    const stale = sign(evt, Math.floor(Date.now() / 1000) - 3600);
    expect(() => p.verifyWebhook(stale.raw, stale.headers)).toThrow(/tolerance/);
  });
});

describe('signature scheme', () => {
  it('accepts any matching v1 candidate (secret rotation) within the tolerance window', () => {
    const raw = Buffer.from('{"a":1}');
    const t = 1_800_000_000;
    const good = signPayload('new', raw, t).split(',')[1]!;
    const header = `t=${t},v1=deadbeef,${good}`;
    expect(() => verifySignedPayload('new', raw, header, t + 10)).not.toThrow();
    expect(() => verifySignedPayload('old', raw, header, t + 10)).toThrow(WebhookSignatureError);
    expect(() => verifySignedPayload('new', raw, header, t + 301)).toThrow(WebhookSignatureError);
    expect(() => verifySignedPayload('new', raw, 'garbage', t)).toThrow(WebhookSignatureError);
  });
});
