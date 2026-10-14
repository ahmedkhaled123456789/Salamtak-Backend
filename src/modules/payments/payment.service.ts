import { randomBytes } from 'node:crypto';
import { AppError, ConflictError, NotFoundError } from '../../common/errors';
import { getPaymentProvider } from '../../providers/payment';
import { Booking } from '../bookings';
import { Payment, type PaymentDoc } from './payment.models';

export interface CreatePaymentResponse {
  payment: PaymentDoc;
  /** returned to the client once, never stored */
  clientSecret?: string;
  redirectUrl?: string;
}

export const PaymentService = {
  /**
   * Starts a payment for a booking hold. Amount, currency and ownership come from the server-side
   * booking snapshot; the client only names the booking. Safe to call again for the same booking:
   * an open payment is reused (the provider call is idempotent on the payment id).
   */
  async create(
    patientId: string,
    bookingId: string,
    now = new Date(),
  ): Promise<CreatePaymentResponse> {
    const booking = await Booking.findOne({ _id: bookingId, patientId });
    if (!booking) throw new NotFoundError('Booking not found', 'BOOKING_NOT_FOUND');
    if (
      booking.status !== 'PAYMENT_PENDING' ||
      !booking.holdExpiresAt ||
      booking.holdExpiresAt <= now
    ) {
      throw new AppError(
        409,
        booking.status === 'PAYMENT_PENDING' || booking.status === 'EXPIRED'
          ? 'BOOKING_EXPIRED'
          : 'BOOKING_NOT_PAYABLE',
        'This booking can no longer be paid',
      );
    }
    if (!(booking.pricingSnapshot!.patientPayableMinor > 0))
      throw new AppError(
        422,
        'NOTHING_TO_PAY',
        'This booking has no payable amount; zero-amount settlement is not supported yet',
      );
    const provider = getPaymentProvider();
    let payment = await Payment.findOne({ bookingId, status: { $in: ['PENDING', 'PROCESSING'] } });
    if (!payment) {
      try {
        payment = await Payment.create({
          bookingId,
          patientId,
          nurseId: booking.nurseId,
          provider: provider.name,
          reference: `PAY-${now.toISOString().slice(2, 10).replace(/-/g, '')}-${randomBytes(5).toString('hex').toUpperCase()}`,
          amountMinor: booking.pricingSnapshot!.patientPayableMinor,
          currency: booking.pricingSnapshot!.currency,
          status: 'PENDING',
        });
      } catch (err) {
        if ((err as { code?: number }).code !== 11000) throw err;
        // a concurrent request opened the payment first: reuse it
        payment = await Payment.findOne({ bookingId, status: { $in: ['PENDING', 'PROCESSING'] } });
        if (!payment) throw new ConflictError('Please retry', 'PAYMENT_CONFLICT');
      }
    }
    const res = await provider.createPayment({
      reference: payment.reference,
      amountMinor: payment.amountMinor,
      currency: 'AED',
      description: `Booking ${booking.bookingNumber}`,
      metadata: { bookingId, paymentId: String(payment._id) },
      idempotencyKey: `payment-${String(payment._id)}`,
    });
    if (!payment.providerTransactionId) {
      payment.providerTransactionId = res.providerTransactionId;
      if (res.status === 'PROCESSING') payment.status = 'PROCESSING';
      await payment.save();
    }
    return { payment, clientSecret: res.clientSecret, redirectUrl: res.redirectUrl };
  },

  async getForViewer(id: string, viewer: { userId: string; role: string }): Promise<PaymentDoc> {
    const p = await Payment.findById(id);
    // 404 (not 403): other people's payment ids are not discoverable
    if (!p || (viewer.role !== 'ADMIN' && String(p.patientId) !== viewer.userId)) {
      throw new NotFoundError('Payment not found', 'PAYMENT_NOT_FOUND');
    }
    return p;
  },
};

export function toPaymentDTO(p: PaymentDoc) {
  return {
    id: String(p._id),
    bookingId: String(p.bookingId),
    provider: p.provider,
    reference: p.reference,
    amountMinor: p.amountMinor,
    currency: p.currency as 'AED',
    status: p.status,
    refundedMinor: p.refundedMinor,
    settlement: p.settlement ?? null,
    paidAt: p.paidAt ?? null,
    failureReason: p.failureReason ?? null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}
