import type { ClientSession } from 'mongoose';
import { AppError } from '../../common/errors';
import { AuditService } from '../audit';
import { BookingService, type BookingDoc } from '../bookings';
import { Payment } from '../payments';
import { WalletService } from '../wallets';

/**
 * Explicit zero-payment flow for fully discounted bookings (a coupon reduced the payable amount to
 * 0). There is NO provider payment and nothing a client can trigger: it runs only inside the booking
 * creation transaction, after the server priced the booking. It records an internal PAID payment of
 * 0 (provider `internal`, reference `PAY-ZERO-<booking>`), confirms the booking through the normal
 * `confirmPayment` path and credits the nurse the GROSS-based earning from the booking snapshot, so
 * wallet, ledger and reconciliation stay consistent. Unique indexes make a repeat impossible.
 */
export const ZeroPayment = {
  async prepare(b: { nurseId: string }): Promise<void> {
    await WalletService.ensure(b.nurseId); // wallets are created outside money transactions
  },

  async settle(booking: BookingDoc, session: ClientSession): Promise<void> {
    if (booking.pricingSnapshot!.patientPayableMinor !== 0)
      throw new AppError(500, 'ZERO_PAYMENT_MISUSE', 'Zero-payment requires a payable amount of 0');
    const now = new Date();
    const [payment] = await Payment.create(
      [
        {
          bookingId: booking._id,
          patientId: booking.patientId,
          nurseId: booking.nurseId,
          provider: 'internal',
          reference: `PAY-ZERO-${booking.bookingNumber}`,
          amountMinor: 0,
          currency: 'AED',
          status: 'PAID',
          paidAt: now,
          paidTimeSource: 'PROCESSING',
          settlement: 'APPLIED',
        },
      ],
      { session },
    );
    const conf = await BookingService.confirmPayment(String(booking._id), {
      paymentId: String(payment!._id),
      session,
      now,
    });
    if (conf.result !== 'PAID')
      throw new AppError(409, 'ZERO_PAYMENT_FAILED', 'The booking could not be confirmed');
    await WalletService.creditPendingEarning(conf.booking, String(payment!._id), session);
    await AuditService.record(
      { actorId: String(booking.patientId), actorRole: 'SYSTEM' },
      {
        action: 'payment.zero_settled',
        entity: 'Booking',
        entityId: String(booking._id),
        newData: {
          paymentId: String(payment!._id),
          grossMinor: booking.pricingSnapshot!.grossMinor,
          discountMinor: booking.pricingSnapshot!.discountMinor,
          coupon: booking.couponSnapshot?.code ?? null,
        },
      },
      session,
    );
  },
};
