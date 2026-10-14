import type { Express } from 'express';
import request from 'supertest';
import { env } from '../../src/config/env';
import { AdminAlert } from '../../src/modules/alerts';
import { Booking, BookingHistory, BookingService } from '../../src/modules/bookings';
import { Payment, PaymentWebhook } from '../../src/modules/payments';
import { Refund } from '../../src/modules/refunds';
import { WalletService, WalletTransaction } from '../../src/modules/wallets';
import { MockPaymentProvider } from '../../src/providers/payment';
import { API, register, resetState, startApp, stopApp, type Session } from '../helpers/harness';
import {
  createPayment,
  deliver,
  freshProvider,
  payFully,
  succeed,
  walletOf,
} from '../helpers/finance';
import { at, baseWorld, bookIt, type BookArgs, type Nurse } from '../helpers/world';

let app: Express;
let admin: Session;
let serviceId: string;
let nurse: Nurse;
let patient: Session;
let patient2: Session;
let D: string;
let mock: MockPaymentProvider;

beforeAll(async () => {
  app = await startApp();
});
afterAll(stopApp);
beforeEach(async () => {
  await resetState();
  mock = freshProvider();
  ({ admin, serviceId, nurse, patient, patient2, D } = await baseWorld(app));
});
afterEach(() => jest.restoreAllMocks());

const args = (s = '08:00', e = '12:00'): BookArgs => ({
  serviceId,
  nurseId: nurse.profileId,
  start: at(D, s),
  end: at(D, e),
});
const get = (s: Session, path: string) => request(app).get(`${API}${path}`).set(s.auth);
const statusOf = async (id: string) => (await Booking.findById(id))!.status;
const states = async (id: string) =>
  (await BookingHistory.find({ bookingId: id }).sort({ createdAt: 1, _id: 1 }).lean()).map(
    (h) => h.newState,
  );

async function newBooking(who = patient, a = args()) {
  const { booking } = await bookIt(app, who, a);
  expect(booking.status).toBe(201);
  return booking.body.data.id as string;
}

describe('payment creation', () => {
  it('prices from the server-side booking snapshot; the client only names the booking', async () => {
    const bookingId = await newBooking();
    const res = await createPayment(app, patient, bookingId);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      bookingId,
      status: 'PENDING',
      amountMinor: 16000,
      currency: 'AED',
      provider: 'mock',
      settlement: null,
    });
    expect(res.body.data.clientSecret).toMatch(/_secret_/);
    // the secret is returned once and never stored
    const doc = await Payment.findById(res.body.data.id).lean();
    expect(JSON.stringify(doc)).not.toContain('_secret_');
    expect(doc!.providerTransactionId).toMatch(/^mock_pi_/);
    expect(mock.calls.create).toBe(1);
  });

  it('rejects client supplied amounts and unknown fields', async () => {
    const bookingId = await newBooking();
    for (const extra of [{ amountMinor: 1 }, { status: 'PAID' }, { currency: 'USD' }]) {
      const r = await request(app)
        .post(`${API}/payments/create`)
        .set(patient.auth)
        .send({ bookingId, ...extra });
      expect(r.status).toBe(400);
    }
    expect(await Payment.countDocuments()).toBe(0);
  });

  it('is repeatable: the open payment is reused and the provider is called once', async () => {
    const bookingId = await newBooking();
    const a = await createPayment(app, patient, bookingId);
    const b = await createPayment(app, patient, bookingId);
    expect(b.body.data.id).toBe(a.body.data.id);
    expect(await Payment.countDocuments()).toBe(1);
    expect(mock.calls.create).toBe(1);
  });

  it('simultaneous create requests open exactly one payment and one provider intent', async () => {
    const bookingId = await newBooking();
    const res = await Promise.all(
      Array.from({ length: 5 }, () => createPayment(app, patient, bookingId)),
    );
    expect(res.every((r) => r.status === 201)).toBe(true);
    expect(new Set(res.map((r) => r.body.data.id)).size).toBe(1);
    expect(await Payment.countDocuments()).toBe(1);
    expect(mock.calls.create).toBe(1);
  });

  it('only the booking patient can pay; nurses and anonymous callers cannot', async () => {
    const bookingId = await newBooking();
    expect((await createPayment(app, patient2, bookingId)).status).toBe(404);
    expect((await createPayment(app, nurse.session, bookingId)).status).toBe(403);
    expect((await request(app).post(`${API}/payments/create`).send({ bookingId })).status).toBe(
      401,
    );
    expect(await Payment.countDocuments()).toBe(0);
  });

  it('cannot pay an expired, cancelled or already paid booking', async () => {
    const expired = await newBooking();
    await BookingService.expireDue(new Date(Date.now() + 20 * 60_000));
    const r = await createPayment(app, patient, expired);
    expect([r.status, r.body.errorCode]).toEqual([409, 'BOOKING_EXPIRED']);

    const cancelled = await newBooking(patient, args('14:00', '16:00'));
    await request(app).post(`${API}/bookings/${cancelled}/cancel`).set(patient.auth).send({});
    expect((await createPayment(app, patient, cancelled)).status).toBe(409);

    const paid = await newBooking(patient, args('17:00', '19:00'));
    const p = await createPayment(app, patient, paid);
    await succeed(app, mock, p.body.data.id);
    expect((await createPayment(app, patient, paid)).body.errorCode).toBe('BOOKING_NOT_PAYABLE');
  });

  it('payment status is readable by the owner and admin only', async () => {
    const bookingId = await newBooking();
    const p = await createPayment(app, patient, bookingId);
    const id = p.body.data.id;
    expect((await get(patient, `/payments/${id}`)).body.data.status).toBe('PENDING');
    expect((await get(admin, `/payments/${id}`)).status).toBe(200);
    expect((await get(patient2, `/payments/${id}`)).status).toBe(404);
    expect((await get(nurse.session, `/payments/${id}`)).status).toBe(403);
  });
});

describe('payment confirmation is driven ONLY by the verified webhook', () => {
  it('successful payment: PAID -> booking PAID -> NURSE_PENDING, nurse pendingBalance credited from the snapshot, one ledger row', async () => {
    const { bookingId, paymentId, hook } = await payFully(app, mock, patient, args());
    expect(hook.status).toBe(200);
    expect(hook.body.data).toMatchObject({ status: 'PROCESSED', outcome: 'PAYMENT_APPLIED' });

    const p = (await Payment.findById(paymentId).lean())!;
    expect(p).toMatchObject({ status: 'PAID', settlement: 'APPLIED' });
    expect(p.paidAt).toBeInstanceOf(Date);
    const b = (await Booking.findById(bookingId).lean())!;
    expect(b.status).toBe('NURSE_PENDING');
    expect(String(b.paymentId)).toBe(paymentId);
    expect(await states(bookingId)).toEqual([
      'PENDING',
      'PAYMENT_PENDING',
      'PAID',
      'NURSE_PENDING',
    ]);

    const w = await walletOf(nurse);
    expect(w).toMatchObject({
      pendingBalanceMinor: 13600,
      availableBalanceMinor: 0,
      totalEarnedMinor: 0,
    });
    const rows = await WalletTransaction.find({ nurseId: nurse.profileId }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'EARNING',
      bucket: 'PENDING',
      amountMinor: 13600,
      balanceBefore: 0,
      balanceAfter: 13600,
      referenceType: 'BOOKING',
    });
    expect(String(rows[0]!.referenceId)).toBe(bookingId);
  });

  it('the patient/frontend cannot mark a payment or booking as paid', async () => {
    const bookingId = await newBooking();
    const p = await createPayment(app, patient, bookingId);
    expect(
      (
        await request(app)
          .post(`${API}/payments/${p.body.data.id}/confirm`)
          .set(patient.auth)
          .send({})
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .patch(`${API}/payments/${p.body.data.id}`)
          .set(patient.auth)
          .send({ status: 'PAID' })
      ).status,
    ).toBe(404);
    expect((await get(patient, `/payments/${p.body.data.id}`)).body.data.status).toBe('PENDING');
    expect(await statusOf(bookingId)).toBe('PAYMENT_PENDING');
    // the dev simulator exists only for admins
    const sim = await request(app)
      .post(`${API}/payments/dev/simulate`)
      .set(patient.auth)
      .send({ providerTransactionId: 'x'.repeat(10), outcome: 'succeeded' });
    expect(sim.status).toBe(403);
  });

  it('dev simulator drives the SAME verified pipeline (admin, mock provider only)', async () => {
    const bookingId = await newBooking();
    const p = await createPayment(app, patient, bookingId);
    const doc = (await Payment.findById(p.body.data.id).lean())!;
    const r = await request(app)
      .post(`${API}/payments/dev/simulate`)
      .set(admin.auth)
      .send({ providerTransactionId: doc.providerTransactionId, outcome: 'succeeded' });
    expect(r.status).toBe(200);
    expect(r.body.data.outcome).toBe('PAYMENT_APPLIED');
    expect(await PaymentWebhook.countDocuments({ processingStatus: 'PROCESSED' })).toBe(1);
  });

  it('failed payment: payment FAILED, booking keeps its hold, a new attempt can still succeed', async () => {
    const bookingId = await newBooking();
    const p = await createPayment(app, patient, bookingId);
    const doc = (await Payment.findById(p.body.data.id).lean())!;
    const f = await deliver(
      app,
      mock.signEvent('payment.failed', {
        providerTransactionId: doc.providerTransactionId,
        failureReason: 'card_declined',
      }),
    );
    expect(f.body.data.outcome).toBe('PAYMENT_FAILED');
    expect(await Payment.findById(p.body.data.id)).toMatchObject({
      status: 'FAILED',
      failureReason: 'card_declined',
    });
    expect(await statusOf(bookingId)).toBe('PAYMENT_PENDING');
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(0);

    const retry = await createPayment(app, patient, bookingId);
    expect(retry.body.data.id).not.toBe(p.body.data.id);
    const ok = await succeed(app, mock, retry.body.data.id);
    expect(ok.body.data.outcome).toBe('PAYMENT_APPLIED');
    expect(await statusOf(bookingId)).toBe('NURSE_PENDING');
  });

  it('processing then cancelled/failed events update the payment without touching the booking', async () => {
    const bookingId = await newBooking();
    const p = await createPayment(app, patient, bookingId);
    const doc = (await Payment.findById(p.body.data.id).lean())!;
    await deliver(
      app,
      mock.signEvent('payment.processing', { providerTransactionId: doc.providerTransactionId }),
    );
    expect((await Payment.findById(p.body.data.id))!.status).toBe('PROCESSING');
    await deliver(
      app,
      mock.signEvent('payment.cancelled', { providerTransactionId: doc.providerTransactionId }),
    );
    expect((await Payment.findById(p.body.data.id))!.status).toBe('CANCELLED');
    expect(await statusOf(bookingId)).toBe('PAYMENT_PENDING');
  });

  it('a late failure event cannot undo a payment that already succeeded', async () => {
    const { paymentId } = await payFully(app, mock, patient, args());
    const doc = (await Payment.findById(paymentId).lean())!;
    const r = await deliver(
      app,
      mock.signEvent('payment.failed', { providerTransactionId: doc.providerTransactionId }),
    );
    expect(r.body.data.outcome).toBe('IGNORED_PAYMENT_ALREADY_FINAL');
    expect((await Payment.findById(paymentId))!.status).toBe('PAID');
  });
});

describe('webhook signature verification', () => {
  const body = () => mock.signEvent('payment.succeeded', { providerTransactionId: 'mock_pi_x' });

  it('rejects missing, tampered, wrong-secret and stale signatures; nothing is stored or changed', async () => {
    const bookingId = await newBooking();
    const p = await createPayment(app, patient, bookingId);
    const doc = (await Payment.findById(p.body.data.id).lean())!;
    const good = mock.signEvent('payment.succeeded', {
      providerTransactionId: doc.providerTransactionId,
      amountMinor: doc.amountMinor,
      currency: 'AED',
    });

    const missing = await deliver(app, { rawBody: good.rawBody, headers: {} });
    const tampered = await deliver(app, {
      rawBody: Buffer.from(good.rawBody.toString().replace('mock_pi', 'mock_xx')),
      headers: good.headers,
    });
    const wrongSecret = await deliver(
      app,
      mock.signEvent(
        'payment.succeeded',
        { providerTransactionId: doc.providerTransactionId, amountMinor: doc.amountMinor },
        { secret: 'whsec_attacker' },
      ),
    );
    const stale = await deliver(
      app,
      mock.signEvent(
        'payment.succeeded',
        { providerTransactionId: doc.providerTransactionId, amountMinor: doc.amountMinor },
        { timestamp: Math.floor(Date.now() / 1000) - 3600 },
      ),
    );
    const garbage = await deliver(app, {
      rawBody: Buffer.from('not json'),
      headers: { 'x-mock-signature': 't=1,v1=abc' },
    });
    for (const r of [missing, tampered, wrongSecret, stale, garbage]) {
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ success: false, errorCode: 'INVALID_WEBHOOK_SIGNATURE' });
    }
    expect(await PaymentWebhook.countDocuments()).toBe(0);
    expect((await Payment.findById(p.body.data.id))!.status).toBe('PENDING');
    expect(await statusOf(bookingId)).toBe('PAYMENT_PENDING');
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(0);
  });

  it('a validly signed request still cannot be replayed with a different body', async () => {
    const signed = body();
    const swapped = {
      rawBody: Buffer.from(
        signed.rawBody.toString().replace('payment.succeeded', 'payment.failed'),
      ),
      headers: signed.headers,
    };
    expect((await deliver(app, swapped)).status).toBe(400);
  });

  it('the webhook route needs no JWT but nothing else authenticates it', async () => {
    const r = await request(app)
      .post(`${API}/payments/webhook`)
      .send({ type: 'payment.succeeded' });
    expect(r.status).toBe(400);
  });
});

describe('webhook inbox: duplicates and unknown events', () => {
  it('stores provider, eventId, type and a payload hash (never the payload) with processing status', async () => {
    const { hook } = await payFully(app, mock, patient, args());
    expect(hook.status).toBe(200);
    const w = (await PaymentWebhook.findOne().lean())!;
    expect(w).toMatchObject({
      provider: 'mock',
      eventType: 'payment.succeeded',
      processingStatus: 'PROCESSED',
      outcome: 'PAYMENT_APPLIED',
    });
    expect(w.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(w.processedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(w)).not.toMatch(/providerTransactionId|amountMinor|mock_pi/);
  });

  it('a duplicate delivery (same eventId) is harmless: no second transition, credit or ledger row', async () => {
    const bookingId = await newBooking();
    const p = await createPayment(app, patient, bookingId);
    const doc = (await Payment.findById(p.body.data.id).lean())!;
    mock.markPaid(doc.providerTransactionId!);
    const evt = mock.signEvent(
      'payment.succeeded',
      {
        providerTransactionId: doc.providerTransactionId,
        amountMinor: doc.amountMinor,
        currency: 'AED',
      },
      { eventId: 'evt_dup_1' },
    );
    const first = await deliver(app, evt);
    const second = await deliver(app, evt);
    const third = await deliver(
      app,
      mock.signEvent(
        'payment.succeeded',
        { providerTransactionId: doc.providerTransactionId, amountMinor: doc.amountMinor },
        { eventId: 'evt_dup_1' },
      ),
    );
    expect(first.body.data.status).toBe('PROCESSED');
    expect(second.body.data).toMatchObject({ status: 'DUPLICATE', outcome: 'PAYMENT_APPLIED' });
    expect(third.body.data.status).toBe('DUPLICATE'); // same id, different bytes: still not reprocessed
    expect(await PaymentWebhook.countDocuments()).toBe(1);
    expect((await states(bookingId)).filter((s) => s === 'PAID')).toHaveLength(1);
    expect(await WalletTransaction.countDocuments()).toBe(1);
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(13600);
    expect(await AdminAlert.countDocuments({ type: 'WEBHOOK_PAYLOAD_MISMATCH' })).toBe(1);
  });

  it('the provider sending a SECOND success event (new eventId) for the same payment changes nothing', async () => {
    const { paymentId, bookingId } = await payFully(app, mock, patient, args());
    const again = await succeed(app, mock, paymentId, 'evt_other_id');
    expect(again.body.data.outcome).toBe('PAYMENT_ALREADY_APPLIED');
    expect(await WalletTransaction.countDocuments()).toBe(1);
    expect((await states(bookingId)).filter((s) => s === 'PAID')).toHaveLength(1);
    expect(await Refund.countDocuments()).toBe(0);
  });

  it('simultaneous duplicate deliveries: processed exactly once', async () => {
    const bookingId = await newBooking();
    const p = await createPayment(app, patient, bookingId);
    const doc = (await Payment.findById(p.body.data.id).lean())!;
    const evt = mock.signEvent(
      'payment.succeeded',
      {
        providerTransactionId: doc.providerTransactionId,
        amountMinor: doc.amountMinor,
        currency: 'AED',
      },
      { eventId: 'evt_race' },
    );
    const res = await Promise.all(Array.from({ length: 6 }, () => deliver(app, evt)));
    expect(res.every((r) => [200, 409].includes(r.status))).toBe(true);
    expect(res.filter((r) => r.status === 200 && r.body.data.status === 'PROCESSED')).toHaveLength(
      1,
    );
    expect(await PaymentWebhook.countDocuments()).toBe(1);
    expect((await states(bookingId)).filter((s) => s === 'PAID')).toHaveLength(1);
    expect(await WalletTransaction.countDocuments()).toBe(1);
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(13600);
  });

  it('unknown payment and unknown event types are stored as IGNORED with no side effects', async () => {
    const unknownPay = await deliver(
      app,
      mock.signEvent('payment.succeeded', {
        providerTransactionId: 'mock_pi_nope',
        amountMinor: 1,
        currency: 'AED',
      }),
    );
    expect(unknownPay.body.data).toMatchObject({
      status: 'IGNORED',
      outcome: 'IGNORED_UNKNOWN_PAYMENT',
    });
    const unknownType = await deliver(app, mock.signEvent('unknown', {}));
    expect(unknownType.body.data).toMatchObject({ status: 'IGNORED', outcome: 'IGNORED_TYPE' });
    expect(await PaymentWebhook.countDocuments({ processingStatus: 'IGNORED' })).toBe(2);
    expect(await WalletTransaction.countDocuments()).toBe(0);
  });

  it('a failure while processing rolls EVERYTHING back, returns 500, and the redelivery then succeeds', async () => {
    const bookingId = await newBooking();
    const p = await createPayment(app, patient, bookingId);
    const doc = (await Payment.findById(p.body.data.id).lean())!;
    mock.markPaid(doc.providerTransactionId!);
    const evt = mock.signEvent(
      'payment.succeeded',
      {
        providerTransactionId: doc.providerTransactionId,
        amountMinor: doc.amountMinor,
        currency: 'AED',
      },
      { eventId: 'evt_retry' },
    );

    jest
      .spyOn(WalletService, 'creditPendingEarning')
      .mockRejectedValueOnce(new Error('simulated wallet failure'));
    const failed = await deliver(app, evt);
    expect(failed.status).toBe(500);
    expect(failed.body.errorCode).toBe('WEBHOOK_PROCESSING_FAILED');
    // atomic: payment, booking and wallet are all untouched
    expect((await Payment.findById(p.body.data.id))!.status).toBe('PENDING');
    expect(await statusOf(bookingId)).toBe('PAYMENT_PENDING');
    expect(await WalletTransaction.countDocuments()).toBe(0);
    expect(await PaymentWebhook.findOne({ eventId: 'evt_retry' })).toMatchObject({
      processingStatus: 'FAILED',
    });

    const retried = await deliver(app, evt); // the provider redelivers
    expect(retried.status).toBe(200);
    expect(retried.body.data.outcome).toBe('PAYMENT_APPLIED');
    expect(await statusOf(bookingId)).toBe('NURSE_PENDING');
    expect(await WalletTransaction.countDocuments()).toBe(1);
    expect(await PaymentWebhook.findOne({ eventId: 'evt_retry' })).toMatchObject({
      processingStatus: 'PROCESSED',
      attempts: 2,
    });
  });

  it('an amount that differs from the booking is never applied (payment FAILED + critical alert)', async () => {
    const bookingId = await newBooking();
    const p = await createPayment(app, patient, bookingId);
    const doc = (await Payment.findById(p.body.data.id).lean())!;
    const r = await deliver(
      app,
      mock.signEvent('payment.succeeded', {
        providerTransactionId: doc.providerTransactionId,
        amountMinor: 100,
        currency: 'AED',
      }),
    );
    expect(r.body.data.outcome).toBe('PAYMENT_AMOUNT_MISMATCH');
    expect(await Payment.findById(p.body.data.id)).toMatchObject({
      status: 'FAILED',
      failureReason: 'AMOUNT_MISMATCH',
    });
    expect(await statusOf(bookingId)).toBe('PAYMENT_PENDING');
    expect(await WalletTransaction.countDocuments()).toBe(0);
    expect(await AdminAlert.findOne({ type: 'PAYMENT_AMOUNT_MISMATCH' })).toMatchObject({
      severity: 'CRITICAL',
      status: 'OPEN',
    });
  });
});

describe('late payment: confirmation arrives after the booking is no longer payable', () => {
  const REASON = 'BOOKING_EXPIRED_BEFORE_PAYMENT_CONFIRMATION';

  async function expiredWithOpenPayment() {
    const bookingId = await newBooking();
    const p = await createPayment(app, patient, bookingId);
    await BookingService.expireDue(new Date(Date.now() + 20 * 60_000));
    expect(await statusOf(bookingId)).toBe('EXPIRED');
    return { bookingId, paymentId: p.body.data.id as string };
  }

  it('does NOT revive the booking, credits no earnings and creates a 100% refund with the distinct reason', async () => {
    const { bookingId, paymentId } = await expiredWithOpenPayment();
    const r = await succeed(app, mock, paymentId);
    expect(r.body.data.outcome).toBe(`PAYMENT_LATE_REFUND_CREATED:${REASON}`);
    expect(await statusOf(bookingId)).toBe('EXPIRED'); // not revived
    expect(await states(bookingId)).toEqual(['PENDING', 'PAYMENT_PENDING', 'EXPIRED']);
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(0);
    expect(await WalletTransaction.countDocuments()).toBe(0);
    const p = (await Payment.findById(paymentId).lean())!;
    expect(p).toMatchObject({ status: 'PAID', settlement: 'LATE_REFUND' });
    const refund = (await Refund.findOne({ paymentId }).lean())!;
    expect(refund).toMatchObject({
      reason: REASON,
      amountMinor: 16000,
      percent: 100,
      type: 'FULL',
      status: 'PENDING',
    });
    expect(refund.bookingId).toBeUndefined();
    // no reservation re-created: the nurse's time stays free
    const again = await bookIt(app, patient2, args());
    expect(again.booking.status).toBe(201);
  });

  it('the refund goes to the provider and completes; the payment ends REFUNDED', async () => {
    const { paymentId } = await expiredWithOpenPayment();
    await succeed(app, mock, paymentId);
    const { RefundService } = await import('../../src/modules/refunds');
    expect(await RefundService.processDue()).toEqual({ SUCCEEDED: 1 });
    expect(mock.calls.refund).toBe(1);
    expect(await Payment.findById(paymentId)).toMatchObject({
      status: 'REFUNDED',
      refundedMinor: 16000,
    });
    expect(await Refund.findOne({ paymentId })).toMatchObject({ status: 'SUCCEEDED' });
  });

  it('duplicate deliveries create no second refund, no earnings, no revival and no extra ledger', async () => {
    const { bookingId, paymentId } = await expiredWithOpenPayment();
    const doc = (await Payment.findById(paymentId).lean())!;
    mock.markPaid(doc.providerTransactionId!);
    const evt = mock.signEvent(
      'payment.succeeded',
      {
        providerTransactionId: doc.providerTransactionId,
        amountMinor: doc.amountMinor,
        currency: 'AED',
      },
      { eventId: 'evt_late' },
    );
    await deliver(app, evt);
    await deliver(app, evt); // duplicate eventId
    await succeed(app, mock, paymentId, 'evt_late_2'); // new eventId, same payment
    await Promise.all([deliver(app, evt), deliver(app, evt)]);
    expect(await Refund.countDocuments({ paymentId })).toBe(1);
    expect(await WalletTransaction.countDocuments()).toBe(0);
    expect(await statusOf(bookingId)).toBe('EXPIRED');
    const { RefundService } = await import('../../src/modules/refunds');
    await Promise.all([RefundService.processDue(), RefundService.processDue()]);
    expect(mock.calls.refund).toBe(1);
  });

  it('also refunds payments for bookings the patient cancelled while the payment was in flight', async () => {
    const bookingId = await newBooking();
    const p = await createPayment(app, patient, bookingId);
    await request(app).post(`${API}/bookings/${bookingId}/cancel`).set(patient.auth).send({});
    const r = await succeed(app, mock, p.body.data.id);
    expect(r.body.data.outcome).toContain(REASON);
    expect(await statusOf(bookingId)).toBe('CANCELLED');
    expect(await Refund.countDocuments({ reason: REASON })).toBe(1);
  });

  it('a SECOND payment for an already paid booking is refunded as DUPLICATE_PAYMENT, never applied twice', async () => {
    const bookingId = await newBooking();
    const first = await createPayment(app, patient, bookingId);
    const doc1 = (await Payment.findById(first.body.data.id).lean())!;
    await succeed(app, mock, first.body.data.id); // the first payment settles the booking
    // ...then a second intent (opened earlier in another tab) is also captured by the provider
    const second = await Payment.create({
      bookingId,
      patientId: patient.id,
      nurseId: nurse.profileId,
      provider: 'mock',
      reference: 'PAY-SECOND-0001',
      providerTransactionId: 'mock_pi_second_intent',
      amountMinor: doc1.amountMinor,
      status: 'PENDING',
    });
    const r = await deliver(
      app,
      mock.signEvent('payment.succeeded', {
        providerTransactionId: 'mock_pi_second_intent',
        amountMinor: doc1.amountMinor,
        currency: 'AED',
      }),
    );
    expect(r.body.data.outcome).toBe('PAYMENT_LATE_REFUND_CREATED:DUPLICATE_PAYMENT');
    expect(await Refund.findOne({ paymentId: second._id })).toMatchObject({
      reason: 'DUPLICATE_PAYMENT',
      amountMinor: 16000,
    });
    expect(await WalletTransaction.countDocuments()).toBe(1); // only the first payment earned
    expect(await statusOf(bookingId)).toBe('NURSE_PENDING');
  });
});

describe('providers', () => {
  it('MockPaymentProvider refuses to operate in production', async () => {
    const original = env.isProd;
    Object.defineProperty(env, 'isProd', { value: true, configurable: true });
    try {
      expect(() => new MockPaymentProvider()).toThrow(/disabled in production/);
      await expect(
        mock.createPayment({
          reference: 'r',
          amountMinor: 1,
          currency: 'AED',
          metadata: {},
          idempotencyKey: 'k',
        }),
      ).rejects.toThrow(/production/);
      expect(() => mock.verifyWebhook(Buffer.from('{}'), {})).toThrow(/production/);
    } finally {
      Object.defineProperty(env, 'isProd', { value: original, configurable: true });
    }
  });

  it('provider calls are idempotent per key (retries never double-create or double-refund)', async () => {
    const a = await mock.createPayment({
      reference: 'r',
      amountMinor: 10,
      currency: 'AED',
      metadata: {},
      idempotencyKey: 'same',
    });
    const b = await mock.createPayment({
      reference: 'r',
      amountMinor: 10,
      currency: 'AED',
      metadata: {},
      idempotencyKey: 'same',
    });
    expect(b.providerTransactionId).toBe(a.providerTransactionId);
    const r1 = await mock.refundPayment({
      providerTransactionId: a.providerTransactionId,
      amountMinor: 10,
      currency: 'AED',
      idempotencyKey: 'refund-1',
      reason: 'x',
    });
    const r2 = await mock.refundPayment({
      providerTransactionId: a.providerTransactionId,
      amountMinor: 10,
      currency: 'AED',
      idempotencyKey: 'refund-1',
      reason: 'x',
    });
    expect(r2.providerRefundId).toBe(r1.providerRefundId);
    expect(mock.calls.refund).toBe(1);
  });

  it('a patient registering after the fact does not matter: unrelated users never see payments', async () => {
    const stranger = await register(app, 'PATIENT');
    const bookingId = await newBooking();
    const p = await createPayment(app, patient, bookingId);
    expect((await get(stranger, `/payments/${p.body.data.id}`)).status).toBe(404);
  });
});
