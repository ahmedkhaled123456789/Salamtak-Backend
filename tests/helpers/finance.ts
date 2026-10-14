import type { Express } from 'express';
import request from 'supertest';
import {
  MockPaymentProvider,
  setPaymentProvider,
  setPayoutProvider,
} from '../../src/providers/payment';
import { Booking, BookingService } from '../../src/modules/bookings';
import { Payment } from '../../src/modules/payments';
import { SettingsService } from '../../src/modules/settings';
import { WalletService } from '../../src/modules/wallets';
import { resetRateLimiters } from '../../src/common/middleware/rateLimit';
import { API, type Session } from './harness';
import { bookIt, type BookArgs, type Nurse } from './world';

export const H = 3_600_000;

/** Fresh mock provider (clears call counters, scripted failures and idempotency memory). */
export function freshProvider(): MockPaymentProvider {
  const p = new MockPaymentProvider();
  setPaymentProvider(p);
  setPayoutProvider(undefined);
  return p;
}

export const deliver = (
  app: Express,
  signed: { rawBody: Buffer; headers: Record<string, string> },
) =>
  request(app)
    .post(`${API}/payments/webhook`)
    .set(signed.headers)
    .set('content-type', 'application/json')
    .send(signed.rawBody.toString('utf8')); // string => sent byte-for-byte (a Buffer would be JSON-serialised)

export async function createPayment(app: Express, patient: Session, bookingId: string) {
  const res = await request(app)
    .post(`${API}/payments/create`)
    .set(patient.auth)
    .send({ bookingId });
  return res;
}

/** Signs and delivers payment.succeeded for a payment document. */
export async function succeed(
  app: Express,
  provider: MockPaymentProvider,
  paymentId: string,
  eventId?: string,
) {
  const p = (await Payment.findById(paymentId))!;
  provider.markPaid(p.providerTransactionId!);
  return deliver(
    app,
    provider.signEvent(
      'payment.succeeded',
      {
        providerTransactionId: p.providerTransactionId,
        amountMinor: p.amountMinor,
        currency: p.currency,
      },
      { eventId },
    ),
  );
}

/** quote -> booking -> payment -> signed webhook. Returns ids and the webhook response. */
export async function payFully(
  app: Express,
  provider: MockPaymentProvider,
  patient: Session,
  a: BookArgs,
) {
  const { booking } = await bookIt(app, patient, a);
  if (booking.status !== 201)
    throw new Error(`booking failed ${booking.status} ${JSON.stringify(booking.body)}`);
  const bookingId = booking.body.data.id as string;
  const pay = await createPayment(app, patient, bookingId);
  if (pay.status !== 201)
    throw new Error(`payment failed ${pay.status} ${JSON.stringify(pay.body)}`);
  const paymentId = pay.body.data.id as string;
  const hook = await succeed(app, provider, paymentId);
  return { bookingId, paymentId, hook };
}

export const walletOf = async (nurse: Nurse) =>
  (await WalletService.ensure(nurse.profileId)).toObject();
export const bookingDoc = async (id: string) => (await Booking.findById(id).lean())!;
export const setSetting = (k: string, v: unknown) => SettingsService.set(k, v);

/** Fast-forwards a COMPLETED booking so it is eligible for release. Test-only (native write). */
export async function completeBooking(id: string, nurse: Nurse, app: Express, hoursAgo = 0) {
  const now = Date.now();
  await Booking.collection.updateOne(
    { _id: new Booking.base.Types.ObjectId(id) },
    { $set: { startDateTime: new Date(now - 10 * 60_000), endDateTime: new Date(now + 3 * H) } },
  );
  await request(app).post(`${API}/bookings/${id}/accept`).set(nurse.session.auth).send({});
  const st = await request(app)
    .post(`${API}/bookings/${id}/start`)
    .set(nurse.session.auth)
    .send({});
  const done = await request(app)
    .post(`${API}/bookings/${id}/complete`)
    .set(nurse.session.auth)
    .send({});
  if (done.status !== 200)
    throw new Error(`complete failed ${st.status}/${done.status} ${JSON.stringify(done.body)}`);
  if (hoursAgo)
    await Booking.collection.updateOne(
      { _id: new Booking.base.Types.ObjectId(id) },
      { $set: { completedAt: new Date(now - hoursAgo * H) } },
    );
}

export const resetLimits = () => resetRateLimiters();
export { BookingService };
