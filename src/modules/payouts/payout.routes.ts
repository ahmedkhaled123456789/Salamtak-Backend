import '../../common/openapi/extend';
import { z } from 'zod';
import { AppError } from '../../common/errors';
import { createApi } from '../../common/openapi/route';
import { paginate, paginationQuery } from '../../common/pagination';
import { getPayoutProvider } from '../../providers/payment';
import { IDEMPOTENCY_KEY_PATTERN, IdempotencyService, hashPayload } from '../idempotency';
import { NurseService } from '../nurses';
import { PAYOUT_STATUSES, Payout, PayoutMethod, type PayoutDoc } from './payout.models';
import { PayoutService } from './payout.service';

const fils = z.number().int().openapi({ description: 'Integer minor units (fils)' });
export const PayoutSchema = z.object({
  id: z.string(),
  amountMinor: fils,
  currency: z.literal('AED'),
  status: z.enum(PAYOUT_STATUSES),
  provider: z.string(),
  attempts: z.number(),
  lastError: z.string().nullable(),
  nextRetryAt: z.date().nullable(),
  paidAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export const toPayoutDTO = (p: PayoutDoc) => ({
  id: String(p._id),
  amountMinor: p.amountMinor,
  currency: p.currency as 'AED',
  status: p.status,
  provider: p.provider,
  attempts: p.attempts,
  lastError: p.lastError ?? null,
  nextRetryAt: p.nextRetryAt ?? null,
  paidAt: p.paidAt ?? null,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

const MethodSchema = z.object({
  provider: z.string(),
  providerRef: z.string(),
  last4: z.string().nullable(),
  bankName: z.string().nullable(),
});
// A raw IBAN must never reach our database: only the provider's token is accepted.
const looksLikeIban = /^[A-Za-z]{2}\d{2}[A-Za-z0-9]{10,30}$/;

const myNurseId = async (userId: string) => String((await NurseService.getByUserId(userId))._id);
const api = createApi('Payouts');

api.route({
  method: 'get',
  path: '/nurses/me/payout-method',
  summary: 'My payout method (provider token only)',
  permission: 'payouts:request',
  response: MethodSchema.nullable(),
  handler: async ({ auth }) => {
    const m = await PayoutMethod.findOne({ nurseId: await myNurseId(auth.userId) });
    return (
      m && {
        provider: m.provider,
        providerRef: m.providerRef,
        last4: m.last4 ?? null,
        bankName: m.bankName ?? null,
      }
    );
  },
});

api.route({
  method: 'put',
  path: '/nurses/me/payout-method',
  summary: 'Set my payout method',
  description:
    "Send the token/account reference created by the payout provider's own client SDK. Raw IBAN/account numbers are rejected and never stored.",
  permission: 'payouts:request',
  body: z.strictObject({
    providerRef: z
      .string()
      .trim()
      .min(6)
      .max(120)
      .regex(/^[A-Za-z0-9_\-:.]+$/, 'letters, digits and _ - : . only'),
    last4: z
      .string()
      .regex(/^\d{4}$/)
      .optional(),
    bankName: z.string().trim().max(80).optional(),
  }),
  response: MethodSchema,
  handler: async ({ auth, body }) => {
    if (looksLikeIban.test(body.providerRef))
      throw new AppError(
        400,
        'RAW_BANK_DETAILS_NOT_ALLOWED',
        'Send the payout provider token, not bank account details',
      );
    const nurseId = await myNurseId(auth.userId);
    const provider = getPayoutProvider().name;
    const m = await PayoutMethod.findOneAndUpdate(
      { nurseId },
      {
        $set: {
          provider,
          providerRef: body.providerRef,
          last4: body.last4,
          bankName: body.bankName,
        },
      },
      { upsert: true, new: true, runValidators: true },
    );
    return {
      provider: m.provider,
      providerRef: m.providerRef,
      last4: m.last4 ?? null,
      bankName: m.bankName ?? null,
    };
  },
});

api.route({
  method: 'post',
  path: '/payouts',
  summary: 'Request a payout from my available balance',
  description:
    'Only `availableBalance` can be paid out (pending earnings cannot). Debits the wallet and creates the payout in one transaction. Requires an `Idempotency-Key`; repeating it returns the original payout. One open payout per nurse. Omit `amountMinor` to withdraw everything available.',
  permission: 'payouts:request',
  status: 201,
  headers: z.object({
    'idempotency-key': z
      .string()
      .regex(IDEMPOTENCY_KEY_PATTERN, '8-128 chars: letters, digits, _ - : .')
      .openapi({ description: 'REQUIRED. Unique per payout request.' }),
  }),
  body: z.strictObject({ amountMinor: z.number().int().min(1).max(1_000_000_000).optional() }),
  response: PayoutSchema,
  handler: async ({ auth, body, req, res }) => {
    const key = (req.valid.headers as { 'idempotency-key': string })['idempotency-key'];
    const nurseId = await myNurseId(auth.userId);
    const out = await IdempotencyService.execute<ReturnType<typeof toPayoutDTO>>(
      { scope: 'payouts.create', userId: auth.userId, key, requestHash: hashPayload(body) },
      async (ctx) => {
        const payout = await PayoutService.request(nurseId, body.amountMinor, key, {
          inTxn: (session, p) => ctx.complete(session, { status: 201, body: toPayoutDTO(p) }),
        });
        return { status: 201, body: toPayoutDTO(payout) };
      },
    );
    if (out.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return out.body;
  },
});

api.route({
  method: 'get',
  path: '/payouts',
  summary: 'My payouts',
  permission: 'payouts:request',
  query: paginationQuery.extend({ status: z.enum(PAYOUT_STATUSES).optional() }).strict(),
  response: z.object({
    items: z.array(PayoutSchema),
    meta: z.object({
      page: z.number(),
      limit: z.number(),
      total: z.number(),
      totalPages: z.number(),
    }),
  }),
  handler: async ({ auth, query }) => {
    const nurseId = await myNurseId(auth.userId);
    const page = await paginate(
      Payout,
      { nurseId, ...(query.status && { status: query.status }) },
      { page: query.page, limit: query.limit },
    );
    const docs = await Payout.find({ _id: { $in: page.items.map((i) => i._id) } }).sort({
      createdAt: -1,
    });
    return { items: docs.map(toPayoutDTO), meta: page.meta };
  },
});

api.route({
  method: 'post',
  path: '/payouts/:id/cancel',
  summary: 'Cancel a payout that has not been processed yet',
  description: 'Funds return to `availableBalance` through a compensating ledger entry.',
  permission: 'payouts:request',
  params: z.strictObject({ id: z.string().regex(/^[a-f\d]{24}$/i, 'invalid id') }),
  response: PayoutSchema,
  handler: async ({ auth, params }) =>
    toPayoutDTO(await PayoutService.cancel(params.id, await myNurseId(auth.userId))),
});

export default api.router;
