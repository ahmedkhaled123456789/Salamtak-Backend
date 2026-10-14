import type { Express } from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { Booking } from '../../src/modules/bookings';
import { ReconciliationService } from '../../src/modules/finance';
import { Payment } from '../../src/modules/payments';
import { RefundService } from '../../src/modules/refunds';
import { WalletService } from '../../src/modules/wallets';
import type { MockPaymentProvider } from '../../src/providers/payment';
import { API, resetState, startApp, stopApp, type Session } from '../helpers/harness';
import { H, createPayment, freshProvider, succeed, walletOf } from '../helpers/finance';
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

const args = (): BookArgs => ({
  serviceId,
  nurseId: nurse.profileId,
  start: at(D, '08:00'),
  end: at(D, '12:00'),
});

/**
 * Platform-funded discount. Real quotes have no coupons yet (Phase 4), so the discount is written
 * natively into the booking snapshot BEFORE payment: gross 16000, discount 3200, patient pays 12800,
 * the nurse's earning stays 13600 (85% of the GROSS), the platform absorbs the 800 difference.
 */
async function discountedPaidBooking(hoursBeforeStart: number) {
  const { booking } = await bookIt(app, patient, args());
  const id = booking.body.data.id as string;
  await Booking.collection.updateOne(
    { _id: new mongoose.Types.ObjectId(id) },
    {
      $set: {
        'pricingSnapshot.discountMinor': 3200,
        'pricingSnapshot.patientPayableMinor': 12800,
        'financialSnapshot.discountMinor': 3200,
        'financialSnapshot.patientPaidMinor': 12800,
        'financialSnapshot.platformFundedDiscountMinor': 3200,
      },
    },
  );
  const pay = await createPayment(app, patient, id);
  expect(pay.status).toBe(201);
  expect(pay.body.data.amountMinor).toBe(12800);
  const hook = await succeed(app, mock, pay.body.data.id);
  expect(hook.body.data.outcome).toBe('PAYMENT_APPLIED');
  const start = Date.now() + hoursBeforeStart * H;
  await timeTravel(id, { startDateTime: new Date(start), endDateTime: new Date(start + 4 * H) });
  return { id, paymentId: pay.body.data.id as string };
}
const cancel = (id: string) =>
  request(app).post(`${API}/bookings/${id}/cancel`).set(patient.auth).send({});

describe('P8: nurse earnings come from the gross snapshot; the platform absorbs discounts', () => {
  it('nurse is credited the snapshot earning (13600), not a share of the discounted payment', async () => {
    await discountedPaidBooking(100);
    expect((await walletOf(nurse)).pendingBalanceMinor).toBe(13600);
    expect((await ReconciliationService.run()).ok).toBe(true);
  });

  it.each([
    // hours before start, refund, nurse keeps, platform (negative = platform-funded)
    [5, 0, 13600, -800],
    [30, 6400, 6800, -400],
    [100, 12800, 0, 0],
  ])(
    'cancellation %ih before start: refund %i, ledger and outcome both say nurse %i, platform %i',
    async (hours, refund, nurseAmount, platformAmount) => {
      const { id, paymentId } = await discountedPaidBooking(hours);
      const res = await cancel(id);
      expect(res.status).toBe(200);
      const b = (await Booking.findById(id).lean())!;
      expect(b.cancellationOutcome).toMatchObject({
        refundMinor: refund,
        nurseCompensationMinor: nurseAmount,
        platformKeptMinor: platformAmount,
      });
      // refund + nurse + platform always equals what the patient paid
      expect(
        b.cancellationOutcome!.refundMinor +
          b.cancellationOutcome!.nurseCompensationMinor +
          b.cancellationOutcome!.platformKeptMinor,
      ).toBe(12800);
      // the wallet ledger represents exactly the same nurse amount
      expect((await walletOf(nurse)).pendingBalanceMinor).toBe(nurseAmount);
      expect(await WalletService.bookingNet(id)).toMatchObject({ pending: nurseAmount });

      if (refund > 0) {
        await RefundService.processDue();
        expect(await Payment.findById(paymentId)).toMatchObject({ refundedMinor: refund });
      }
      const rep = await ReconciliationService.run();
      expect(rep.checks.filter((c) => !c.ok)).toEqual([]); // no false alarm from a negative platform share
      expect(rep.ok).toBe(true);
    },
  );

  it('a refunded-in-full discounted booking leaves nothing for anyone', async () => {
    const { id } = await discountedPaidBooking(100);
    await cancel(id);
    await RefundService.processDue();
    expect(await walletOf(nurse)).toMatchObject({
      pendingBalanceMinor: 0,
      availableBalanceMinor: 0,
    });
  });
});

describe('zero-amount payments are refused until coupons exist', () => {
  it('a fully discounted booking cannot open a provider payment of 0', async () => {
    const { booking } = await bookIt(app, patient, args());
    const id = booking.body.data.id as string;
    await Booking.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      {
        $set: { 'pricingSnapshot.patientPayableMinor': 0, 'pricingSnapshot.discountMinor': 16000 },
      },
    );
    const pay = await createPayment(app, patient, id);
    expect([pay.status, pay.body.errorCode]).toEqual([422, 'NOTHING_TO_PAY']);
    expect(await Payment.countDocuments()).toBe(0);
  });
});
