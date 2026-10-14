import '../../common/openapi/extend';
import { z } from 'zod';
import { createApi } from '../../common/openapi/route';
import { PaymentSchema } from './payment.schemas';
import { runAfterCreate } from './payment.hooks';
import { Payment } from './payment.models';
import { PaymentService, toPaymentDTO } from './payment.service';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'invalid id');

const api = createApi('Payments');

api.route({
  method: 'post',
  path: '/payments/create',
  summary: 'Start paying for a booking hold',
  description:
    "The amount is taken from the booking's server-side pricing snapshot; the client only names the booking. Safe to call repeatedly: an open payment is reused and the provider call is idempotent. The payment becomes `PAID` ONLY when the provider's signed webhook arrives; nothing the client reports is trusted. `clientSecret` is returned once and never stored.",
  permission: 'payments:create',
  status: 201,
  body: z.strictObject({ bookingId: objectId }),
  response: PaymentSchema.extend({
    clientSecret: z
      .string()
      .nullable()
      .openapi({ description: 'Pass to the provider SDK; not stored by the API' }),
    redirectUrl: z.string().nullable(),
  }),
  handler: async ({ auth, body }) => {
    const r = await PaymentService.create(auth.userId, body.bookingId);
    await runAfterCreate(r.payment); // demo deployments only (see finance.hooks.ts)
    const payment = (await Payment.findById(r.payment._id)) ?? r.payment;
    return {
      ...toPaymentDTO(payment),
      clientSecret: r.clientSecret ?? null,
      redirectUrl: r.redirectUrl ?? null,
    };
  },
});

api.route({
  method: 'get',
  path: '/payments/:id',
  summary: 'Payment status (read from the database only)',
  description: 'Owner or admin. Reflects webhook-confirmed state.',
  permission: 'payments:read',
  params: z.strictObject({ id: objectId }),
  response: PaymentSchema,
  handler: async ({ auth, params }) =>
    toPaymentDTO(await PaymentService.getForViewer(params.id, auth)),
});

export default api.router;
