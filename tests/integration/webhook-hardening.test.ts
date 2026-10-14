import type { Express } from 'express';
import request from 'supertest';
import { logger } from '../../src/config/logger';
import { AdminAlert } from '../../src/modules/alerts';
import { Booking } from '../../src/modules/bookings';
import { Payment, PaymentWebhook } from '../../src/modules/payments';
import type { MockPaymentProvider } from '../../src/providers/payment';
import { API, resetState, startApp, stopApp, type Session } from '../helpers/harness';
import {
  createPayment,
  deliver,
  freshProvider,
  resetLimits,
  succeed,
  walletOf,
} from '../helpers/finance';
import { at, baseWorld, bookIt, type BookArgs, type Nurse } from '../helpers/world';

let app: Express;
let serviceId: string;
let nurse: Nurse;
let patient: Session;
let D: string;
let mock: MockPaymentProvider;

beforeAll(async () => {
  app = await startApp();
});
afterAll(stopApp);
beforeEach(async () => {
  await resetState();
  resetLimits();
  mock = freshProvider();
  ({ serviceId, nurse, patient, D } = await baseWorld(app));
});
afterEach(() => jest.restoreAllMocks());

const args = (): BookArgs => ({
  serviceId,
  nurseId: nurse.profileId,
  start: at(D, '08:00'),
  end: at(D, '12:00'),
});

describe('P5: a signed payment event for an unknown payment is surfaced, never silently ignored', () => {
  const ghost = () =>
    mock.signEvent(
      'payment.succeeded',
      { providerTransactionId: 'pi_ghost_123', amountMinor: 16000, currency: 'AED' },
      { eventId: 'evt_ghost_1' },
    );

  it('raises exactly one CRITICAL alert with safe metadata and creates nothing', async () => {
    const bookings = await Booking.countDocuments();
    const payments = await Payment.countDocuments();
    const res = await deliver(app, ghost());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'IGNORED', outcome: 'IGNORED_UNKNOWN_PAYMENT' });

    const alerts = await AdminAlert.find({ type: 'UNKNOWN_PAYMENT_EVENT' }).lean();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: 'CRITICAL',
      status: 'OPEN',
      entity: 'PaymentWebhook',
    });
    expect(alerts[0]!.data).toMatchObject({
      provider: 'mock',
      eventId: 'evt_ghost_1',
      providerTransactionId: 'pi_ghost_123',
      amountMinor: 16000,
      currency: 'AED',
      eventType: 'payment.succeeded',
      reason: 'NO_MATCHING_PAYMENT',
    });
    expect(alerts[0]!.data.receivedAt).toBeTruthy();
    // no secrets / signatures / raw payload in the alert
    const blob = JSON.stringify(alerts[0]);
    expect(blob).not.toMatch(/whsec|v1=|x-mock-signature|secret/i);

    expect(await Booking.countDocuments()).toBe(bookings);
    expect(await Payment.countDocuments()).toBe(payments);
  });

  it('a redelivery of the same event does not raise a second alert', async () => {
    const signed = ghost();
    await deliver(app, signed);
    const again = await deliver(app, signed);
    expect(again.body.data.status).toBe('DUPLICATE');
    const alerts = await AdminAlert.find({ type: 'UNKNOWN_PAYMENT_EVENT' }).lean();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.count).toBe(1);
  });

  it('an unknown non-success payment event is only a WARNING', async () => {
    await deliver(
      app,
      mock.signEvent('payment.failed', { providerTransactionId: 'pi_ghost_9' }, { eventId: 'e9' }),
    );
    expect(await AdminAlert.findOne({ type: 'UNKNOWN_PAYMENT_EVENT' })).toMatchObject({
      severity: 'WARNING',
    });
  });
});

describe('B: a success event without amount/currency is verified with the provider', () => {
  async function openPayment() {
    const { booking } = await bookIt(app, patient, args());
    const pay = await createPayment(app, patient, booking.body.data.id);
    return (await Payment.findById(pay.body.data.id))!;
  }
  const bare = (txId: string) =>
    mock.signEvent('payment.succeeded', { providerTransactionId: txId });

  it('uses the provider lookup for amount/currency and applies the payment', async () => {
    const p = await openPayment();
    mock.markPaid(p.providerTransactionId!);
    const res = await deliver(app, bare(p.providerTransactionId!));
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('PAYMENT_APPLIED');
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(13600);
  });

  it('does not trust the bare event when the provider does not confirm PAID (retryable, nothing applied)', async () => {
    const p = await openPayment();
    const res = await deliver(app, bare(p.providerTransactionId!));
    expect(res.status).toBe(409);
    expect((await Payment.findById(p._id))!.status).not.toBe('PAID');
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(0);
    // once the provider confirms, the redelivery applies it
    mock.markPaid(p.providerTransactionId!);
    const ok = await deliver(app, bare(p.providerTransactionId!));
    expect(ok.body.data.outcome).toBe('PAYMENT_APPLIED');
  });

  it('a provider-reported amount that differs from ours is never applied', async () => {
    const p = await openPayment();
    mock.markPaid(p.providerTransactionId!);
    jest
      .spyOn(mock, 'verifyPayment')
      .mockResolvedValue({ status: 'PAID', amountMinor: 1, currency: 'AED' });
    const res = await deliver(app, bare(p.providerTransactionId!));
    expect(res.body.data.outcome).toBe('PAYMENT_AMOUNT_MISMATCH');
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(0);
    expect(await AdminAlert.findOne({ type: 'PAYMENT_AMOUNT_MISMATCH' })).toMatchObject({
      severity: 'CRITICAL',
    });
  });

  it('events that carry amount and currency never trigger a provider lookup', async () => {
    const p = await openPayment();
    const spy = jest.spyOn(mock, 'verifyPayment');
    await succeed(app, mock, String(p._id));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('C: invalid-signature floods are throttled without affecting valid traffic', () => {
  const bad = () =>
    request(app)
      .post(`${API}/payments/webhook`)
      .set('x-mock-signature', 't=1,v1=deadbeef')
      .set('content-type', 'application/json')
      .send('{"id":"x","type":"payment.succeeded","data":{}}');

  it('answers 429 with Retry-After after the failure budget and logs quietly', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const codes: number[] = [];
    let retryAfter: string | undefined;
    for (let i = 0; i < 40; i++) {
      const r = await bad();
      codes.push(r.status);
      if (r.status === 429) retryAfter = r.headers['retry-after'];
    }
    expect(codes.slice(0, 20).every((c) => c === 400)).toBe(true);
    expect(codes.slice(25).every((c) => c === 429)).toBe(true);
    expect(Number(retryAfter)).toBeGreaterThan(0);
    const invalidLogs = warn.mock.calls.filter((c) =>
      String(c[1] ?? '').includes('invalid signature'),
    ).length;
    expect(invalidLogs).toBeLessThanOrEqual(21); // not one log line per request
    expect(await PaymentWebhook.countDocuments()).toBe(0); // nothing stored for unauthenticated input
  });

  it('valid signed events from the same source are still processed while the flood is throttled', async () => {
    for (let i = 0; i < 30; i++) await bad();
    expect((await bad()).status).toBe(429);
    const { booking } = await bookIt(app, patient, args());
    const pay = await createPayment(app, patient, booking.body.data.id);
    const ok = await succeed(app, mock, pay.body.data.id);
    expect(ok.status).toBe(200);
    expect(ok.body.data.outcome).toBe('PAYMENT_APPLIED');
  });
});
