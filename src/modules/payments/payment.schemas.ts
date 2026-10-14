import '../../common/openapi/extend';
import { z } from 'zod';
import { PAYMENT_STATUSES } from './payment.models';

export const PaymentSchema = z.object({
  id: z.string(),
  bookingId: z.string(),
  provider: z.string(),
  reference: z.string(),
  amountMinor: z.number().int(),
  currency: z.literal('AED'),
  status: z.enum(PAYMENT_STATUSES),
  refundedMinor: z.number().int(),
  settlement: z.enum(['APPLIED', 'LATE_REFUND', 'DUPLICATE_REFUND']).nullable(),
  paidAt: z.date().nullable(),
  failureReason: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
