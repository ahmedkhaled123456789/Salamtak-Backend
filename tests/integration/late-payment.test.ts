import type { Express } from 'express';
import { AdminAlert } from '../../src/modules/alerts';
import { Booking, BookingService } from '../../src/modules/bookings';
import { ReconciliationService } from '../../src/modules/finance';
import { Payment } from '../../src/modules/payments';
import { Refund } from '../../src/modules/refunds';
import { WalletTransaction } from '../../src/modules/wallets';
import type { MockPaymentProvider } from '../../src/providers/payment';
import { resetState, startApp, stopApp, type Session } from '../helpers/harness';
import { createPayment, deliver, freshProvider, walletOf } from '../helpers/finance';
import { at, baseWorld, bookIt, timeTravel, type BookArgs, type Nurse } from '../helpers/world';

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
  mock = freshProvider();
  ({ serviceId, nurse, patient, D } = await baseWorld(app));
});

const MIN = 60_000;
const args = (): BookArgs => ({
  serviceId,
  nurseId: nurse.profileId,
  start: at(D, '08:00'),
  end: at(D, '12:00'),
});

/** A booking with an open payment whose hold expired `expiredMinAgo` minutes ago (not yet swept). */
async function lapsedHold(expiredMinAgo = 1) {
  const { booking } = await bookIt(app, patient, args());
  const bookingId = booking.body.data.id as string;
  const pay = await createPayment(app, patient, bookingId);
  expect(pay.status).toBe(201);
  const payment = (await Payment.findById(pay.body.data.id))!;
  await timeTravel(bookingId, { holdExpiresAt: new Date(Date.now() - expiredMinAgo * MIN) });
  // the payment was opened 20 minutes ago, i.e. before the hold lapsed
  await Payment.collection.updateOne(
    { _id: payment._id },
    { $set: { createdAt: new Date(Date.now() - 20 * MIN) } },
  );
  payment.createdAt = new Date(Date.now() - 20 * MIN);
  mock.markPaid(payment.providerTransactionId!);
  return { bookingId, payment };
}
const send = (
  payment: { providerTransactionId?: string | null; amountMinor: number },
  paidAt?: string,
  eventId?: string,
) =>
  deliver(
    app,
    mock.signEvent(
      'payment.succeeded',
      {
        providerTransactionId: payment.providerTransactionId,
        amountMinor: payment.amountMinor,
        currency: 'AED',
        paidAt,
      },
      { eventId },
    ),
  );
const ago = (min: number) => new Date(Date.now() - min * MIN).toISOString();
const statusOf = async (id: string) => (await Booking.findById(id))!.status;
const earnings = () => WalletTransaction.countDocuments({ type: 'EARNING' });

describe('late payment uses the verified provider timestamp', () => {
  it('paid BEFORE the hold expired but the webhook arrives after: the payment is accepted', async () => {
    const { bookingId, payment } = await lapsedHold(1);
    const res = await send(payment, ago(5));
    expect(res.body.data.outcome).toBe('PAYMENT_APPLIED');
    expect(await statusOf(bookingId)).toBe('NURSE_PENDING');
    expect(await Payment.findById(payment._id)).toMatchObject({
      status: 'PAID',
      paidTimeSource: 'PROVIDER',
      settlement: 'APPLIED',
    });
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(13600);
    expect(await Refund.countDocuments()).toBe(0);
    expect((await ReconciliationService.run()).ok).toBe(true);
  });

  it('paid AFTER the hold expired: 100% refund, booking not revived, no earnings', async () => {
    const { bookingId, payment } = await lapsedHold(5);
    const res = await send(payment, ago(1));
    expect(res.body.data.outcome).toBe(
      'PAYMENT_LATE_REFUND_CREATED:BOOKING_EXPIRED_BEFORE_PAYMENT_CONFIRMATION',
    );
    expect(await statusOf(bookingId)).toBe('PAYMENT_PENDING'); // untouched; the sweep expires it
    expect(await earnings()).toBe(0);
    expect(await Refund.findOne({ paymentId: payment._id })).toMatchObject({
      amountMinor: 16000,
      reason: 'BOOKING_EXPIRED_BEFORE_PAYMENT_CONFIRMATION',
    });
    expect(await Payment.findById(payment._id)).toMatchObject({ settlement: 'LATE_REFUND' });
  });

  it('missing provider timestamp: falls back to webhook processing time', async () => {
    const lapsed = await lapsedHold(1);
    const res = await send(lapsed.payment, undefined);
    expect(res.body.data.outcome).toContain('PAYMENT_LATE_REFUND_CREATED');
    expect(await earnings()).toBe(0);
    // and on a hold that is still live the fallback accepts the payment
    await resetState();
    mock = freshProvider();
    ({ serviceId, nurse, patient, D } = await baseWorld(app));
    const { booking } = await bookIt(app, patient, args());
    const pay = await createPayment(app, patient, booking.body.data.id);
    const p = (await Payment.findById(pay.body.data.id))!;
    mock.markPaid(p.providerTransactionId!);
    const ok = await send(p, undefined);
    expect(ok.body.data.outcome).toBe('PAYMENT_APPLIED');
    expect((await Payment.findById(p._id))!.paidTimeSource).toBe('PROCESSING');
  });

  it.each([
    ['garbage', 'not-a-date'],
    ['in the future', '2099-01-01T00:00:00.000Z'],
    ['before the payment even existed', '2000-01-01T00:00:00.000Z'],
  ])(
    'an invalid/untrusted provider timestamp (%s) is ignored, processing time is used and an alert is raised',
    async (_label, bad) => {
      const { bookingId, payment } = await lapsedHold(1);
      const res = await send(payment, bad);
      // processing time is after expiry => refund; the bad timestamp cannot "rescue" the payment
      expect(res.body.data.outcome).toContain('PAYMENT_LATE_REFUND_CREATED');
      expect(await earnings()).toBe(0);
      expect(await statusOf(bookingId)).toBe('PAYMENT_PENDING');
      expect((await Payment.findById(payment._id))!.paidTimeSource).toBe('PROCESSING');
      expect(await AdminAlert.countDocuments({ type: 'PAYMENT_TIMESTAMP_UNTRUSTED' })).toBe(1);
    },
  );

  it('an expired booking is never revived even if the provider time was before expiry', async () => {
    const { bookingId, payment } = await lapsedHold(2);
    await BookingService.expireDue(new Date());
    expect(await statusOf(bookingId)).toBe('EXPIRED');
    const res = await send(payment, ago(10));
    expect(res.body.data.outcome).toContain('PAYMENT_LATE_REFUND_CREATED');
    expect(await statusOf(bookingId)).toBe('EXPIRED');
    expect(await earnings()).toBe(0);
    expect(await Refund.countDocuments({ paymentId: payment._id })).toBe(1);
  });

  it('a booking whose start already passed cannot be fulfilled and is refunded', async () => {
    const { bookingId, payment } = await lapsedHold(1);
    await timeTravel(bookingId, {
      startDateTime: new Date(Date.now() - 30 * MIN),
      endDateTime: new Date(Date.now() + 3 * 60 * MIN),
    });
    const res = await send(payment, ago(5));
    expect(res.body.data.outcome).toContain('PAYMENT_LATE_REFUND_CREATED');
    expect(await earnings()).toBe(0);
  });

  it('is idempotent: a duplicate event and a second event for the same payment change nothing', async () => {
    const { payment } = await lapsedHold(5);
    const first = await send(payment, ago(1), 'evt_late_1');
    const dup = await send(payment, ago(1), 'evt_late_1');
    const other = await send(payment, ago(1), 'evt_late_2');
    expect(first.body.data.status).toBe('PROCESSED');
    expect(dup.body.data.status).toBe('DUPLICATE');
    expect(other.body.data.outcome).toBe('PAYMENT_ALREADY_APPLIED');
    expect(await Refund.countDocuments({ paymentId: payment._id })).toBe(1);
  });

  it('is idempotent for the accepted path too', async () => {
    const { bookingId, payment } = await lapsedHold(1);
    await send(payment, ago(5), 'evt_ok_1');
    const dup = await send(payment, ago(5), 'evt_ok_1');
    const other = await send(payment, ago(5), 'evt_ok_2');
    expect(dup.body.data.status).toBe('DUPLICATE');
    expect(other.body.data.outcome).toBe('PAYMENT_ALREADY_APPLIED');
    expect(await earnings()).toBe(1);
    expect(await statusOf(bookingId)).toBe('NURSE_PENDING');
  });

  it('concurrent expiry sweep and payment confirmation end in exactly one consistent outcome', async () => {
    for (let i = 0; i < 4; i++) {
      await resetState();
      mock = freshProvider();
      ({ serviceId, nurse, patient, D } = await baseWorld(app));
      const { bookingId, payment } = await lapsedHold(1);
      await Promise.all([BookingService.expireDue(new Date()), send(payment, ago(5))]);
      await BookingService.expireDue(new Date());
      const status = await statusOf(bookingId);
      const refunds = await Refund.countDocuments({ paymentId: payment._id });
      const credits = await earnings();
      if (status === 'EXPIRED') {
        // the sweep won: the late payment was refunded in full, nothing was credited
        expect([refunds, credits]).toEqual([1, 0]);
      } else {
        // the payment won: booking proceeded and the nurse was credited once; never both
        expect(status).toBe('NURSE_PENDING');
        expect([refunds, credits]).toEqual([0, 1]);
      }
      expect((await ReconciliationService.run()).ok).toBe(true);
    }
  });
});
