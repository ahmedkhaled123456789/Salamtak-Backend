import '../../common/openapi/extend';
import { z } from 'zod';
import { AppError, NotFoundError } from '../../common/errors';
import { createApi } from '../../common/openapi/route';
import { paginate, paginationQuery } from '../../common/pagination';
import { env } from '../../config/env';
import { MockPaymentProvider, getPaymentProvider } from '../../providers/payment';
import { AdminAlert, AlertService } from '../alerts';
import { AuditService, auditContext } from '../audit';
import { IDEMPOTENCY_KEY_PATTERN } from '../idempotency';
import { PAYMENT_STATUSES, Payment, PaymentSchema, toPaymentDTO } from '../payments';
import { PAYOUT_STATUSES, Payout, PayoutService } from '../payouts';
import { REFUND_REASONS, REFUND_STATUSES, Refund, RefundService, type RefundDoc } from '../refunds';
import { ADJUSTMENT_STATUSES, Wallet, WalletAdjustment, WalletAdjustmentService } from '../wallets';
import { runFinanceSweeps } from './finance.hooks';
import { ReconciliationService } from './reconciliation.service';
import { PaymentWebhookService } from './webhook.service';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'invalid id');
const idParams = z.strictObject({ id: objectId });
const fils = z.number().int();
const pageMeta = z.object({
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  totalPages: z.number(),
});
const idemHeader = z.object({
  'idempotency-key': z
    .string()
    .regex(IDEMPOTENCY_KEY_PATTERN, '8-128 chars: letters, digits, _ - : .')
    .openapi({ description: 'REQUIRED' }),
});

const RefundAdminSchema = z.object({
  id: z.string(),
  bookingId: z.string().nullable(),
  paymentId: z.string(),
  provider: z.string(),
  amountMinor: fils,
  currency: z.literal('AED'),
  percent: z.number(),
  type: z.enum(['FULL', 'PARTIAL']),
  reason: z.enum(REFUND_REASONS),
  status: z.enum(REFUND_STATUSES),
  providerRefundId: z.string().nullable(),
  attempts: z.number(),
  failureCount: z.number(),
  lastError: z.string().nullable(),
  lastAttemptAt: z.date().nullable(),
  nextRetryAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
const toRefundDTO = (r: RefundDoc) => ({
  id: String(r._id),
  bookingId: r.bookingId ? String(r.bookingId) : null,
  paymentId: String(r.paymentId),
  provider: r.provider,
  amountMinor: r.amountMinor,
  currency: r.currency as 'AED',
  percent: r.percent,
  type: r.type,
  reason: r.reason,
  status: r.status,
  providerRefundId: r.providerRefundId ?? null,
  attempts: r.attempts,
  failureCount: r.failureCount,
  lastError: r.lastError ?? null,
  lastAttemptAt: r.lastAttemptAt ?? null,
  nextRetryAt: r.nextRetryAt ?? null,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const api = createApi('Admin Finance');

api.route({
  method: 'get',
  path: '/admin/payments',
  summary: 'List payments',
  permission: 'admin:finance:read',
  query: paginationQuery
    .extend({ status: z.enum(PAYMENT_STATUSES).optional(), bookingId: objectId.optional() })
    .strict(),
  response: z.object({ items: z.array(PaymentSchema), meta: pageMeta }),
  handler: async ({ query }) => {
    const filter = {
      ...(query.status && { status: query.status }),
      ...(query.bookingId && { bookingId: query.bookingId }),
    };
    const page = await paginate(Payment, filter, { page: query.page, limit: query.limit });
    const docs = await Payment.find({ _id: { $in: page.items.map((i) => i._id) } }).sort({
      createdAt: -1,
    });
    return { items: docs.map(toPaymentDTO), meta: page.meta };
  },
});

api.route({
  method: 'get',
  path: '/admin/refunds',
  summary: 'List refunds with provider status, attempts, last error and next retry time',
  permission: 'admin:finance:read',
  query: paginationQuery
    .extend({
      status: z.enum(REFUND_STATUSES).optional(),
      bookingId: objectId.optional(),
      reason: z.enum(REFUND_REASONS).optional(),
    })
    .strict(),
  response: z.object({ items: z.array(RefundAdminSchema), meta: pageMeta }),
  handler: async ({ query }) => {
    const filter = {
      ...(query.status && { status: query.status }),
      ...(query.bookingId && { bookingId: query.bookingId }),
      ...(query.reason && { reason: query.reason }),
    };
    const page = await paginate(Refund, filter, { page: query.page, limit: query.limit });
    const docs = await Refund.find({ _id: { $in: page.items.map((i) => i._id) } }).sort({
      createdAt: -1,
    });
    return { items: docs.map(toRefundDTO), meta: page.meta };
  },
});

api.route({
  method: 'post',
  path: '/admin/refunds/:id/retry',
  summary: 'Re-open a FAILED refund',
  description:
    'Only for refunds whose automatic retries were exhausted. The refund goes back to PENDING (attempt counter on the same record), the booking returns to REFUND_PENDING and the nurse earnings are reversed again. Audit-logged.',
  permission: 'admin:finance:manage',
  params: idParams,
  response: RefundAdminSchema,
  handler: async ({ params, req }) =>
    toRefundDTO(await RefundService.adminRetry(params.id, auditContext(req))),
});

const PayoutAdminSchema = z.object({
  id: z.string(),
  nurseId: z.string(),
  amountMinor: fils,
  status: z.enum(PAYOUT_STATUSES),
  provider: z.string(),
  providerPayoutId: z.string().nullable(),
  attempts: z.number(),
  lastError: z.string().nullable(),
  nextRetryAt: z.date().nullable(),
  paidAt: z.date().nullable(),
  createdAt: z.date(),
});
api.route({
  method: 'get',
  path: '/admin/payouts',
  summary: 'List payouts',
  permission: 'admin:finance:read',
  query: paginationQuery
    .extend({ status: z.enum(PAYOUT_STATUSES).optional(), nurseId: objectId.optional() })
    .strict(),
  response: z.object({ items: z.array(PayoutAdminSchema), meta: pageMeta }),
  handler: async ({ query }) => {
    const filter = {
      ...(query.status && { status: query.status }),
      ...(query.nurseId && { nurseId: query.nurseId }),
    };
    const page = await paginate(Payout, filter, { page: query.page, limit: query.limit });
    const docs = await Payout.find({ _id: { $in: page.items.map((i) => i._id) } }).sort({
      createdAt: -1,
    });
    return {
      items: docs.map((p) => ({
        id: String(p._id),
        nurseId: String(p.nurseId),
        amountMinor: p.amountMinor,
        status: p.status,
        provider: p.provider,
        providerPayoutId: p.providerPayoutId ?? null,
        attempts: p.attempts,
        lastError: p.lastError ?? null,
        nextRetryAt: p.nextRetryAt ?? null,
        paidAt: p.paidAt ?? null,
        createdAt: p.createdAt,
      })),
      meta: page.meta,
    };
  },
});

api.route({
  method: 'post',
  path: '/admin/payouts/:id/cancel',
  summary: 'Cancel an unprocessed payout',
  description:
    'Funds return to the nurse availableBalance via a compensating ledger row. Audit-logged.',
  permission: 'admin:finance:manage',
  params: idParams,
  response: z.object({ id: z.string(), status: z.enum(PAYOUT_STATUSES) }),
  handler: async ({ params, req }) => {
    const p = await PayoutService.cancel(params.id);
    await AuditService.record(auditContext(req), {
      action: 'payout.cancelled_by_admin',
      entity: 'Payout',
      entityId: params.id,
      newData: { amountMinor: p.amountMinor },
    });
    return { id: String(p._id), status: p.status };
  },
});

api.route({
  method: 'get',
  path: '/admin/wallets/:id',
  summary: 'A nurse wallet (id = nurse profile id)',
  permission: 'admin:finance:read',
  params: idParams,
  response: z.object({
    nurseId: z.string(),
    availableBalanceMinor: fils,
    pendingBalanceMinor: fils,
    totalEarnedMinor: fils,
    totalWithdrawnMinor: fils,
    currency: z.literal('AED'),
  }),
  handler: async ({ params }) => {
    const w = await Wallet.findOne({ nurseId: params.id });
    if (!w) throw new NotFoundError('Wallet not found', 'WALLET_NOT_FOUND');
    return {
      nurseId: String(w.nurseId),
      availableBalanceMinor: w.availableBalanceMinor,
      pendingBalanceMinor: w.pendingBalanceMinor,
      totalEarnedMinor: w.totalEarnedMinor,
      totalWithdrawnMinor: w.totalWithdrawnMinor,
      currency: w.currency as 'AED',
    };
  },
});

api.route({
  method: 'post',
  path: '/admin/wallets/:id/adjustments',
  summary: 'Admin wallet adjustment (ledger-backed)',
  description:
    "Signed amount in fils on PENDING or AVAILABLE. A reason is mandatory, the balance can never go negative, and the Idempotency-Key makes retries harmless. Audit-logged. Adjustments above `adjustment.maxImmediateMinor` (or beyond the admin's rolling 24h `adjustment.maxDailyMinor`) are created as PENDING and change NO balance until a DIFFERENT admin approves them (maker-checker).",
  permission: 'admin:finance:manage',
  status: 201,
  params: idParams,
  headers: idemHeader,
  body: z.strictObject({
    bucket: z.enum(['PENDING', 'AVAILABLE']),
    amountMinor: z
      .number()
      .int()
      .refine((n) => n !== 0, 'must not be zero')
      .refine((n) => Math.abs(n) <= 1_000_000_000),
    reason: z.string().trim().min(5).max(500),
  }),
  response: z.object({
    adjustmentId: z.string(),
    status: z.enum(ADJUSTMENT_STATUSES),
    ledgerId: z.string().nullable(),
    applied: z.boolean(),
  }),
  handler: async ({ params, body, req }) => {
    const key = (req.valid.headers as { 'idempotency-key': string })['idempotency-key'];
    const r = await WalletAdjustmentService.request(
      {
        nurseId: params.id,
        bucket: body.bucket,
        amountMinor: body.amountMinor,
        reason: body.reason,
        key,
      },
      auditContext(req),
    );
    return {
      adjustmentId: String(r.adjustment._id),
      status: r.adjustment.status,
      ledgerId: r.adjustment.ledgerId ? String(r.adjustment.ledgerId) : null,
      applied: r.applied,
    };
  },
});

const AdjustmentSchema = z.object({
  id: z.string(),
  nurseId: z.string(),
  bucket: z.enum(['PENDING', 'AVAILABLE']),
  amountMinor: fils,
  reason: z.string(),
  status: z.enum(ADJUSTMENT_STATUSES),
  requestedBy: z.string(),
  decidedBy: z.string().nullable(),
  approvalReason: z.string().nullable(),
  ledgerId: z.string().nullable(),
  createdAt: z.date(),
});
const toAdjustmentDTO = (a: InstanceType<typeof WalletAdjustment>) => ({
  id: String(a._id),
  nurseId: String(a.nurseId),
  bucket: a.bucket,
  amountMinor: a.amountMinor,
  reason: a.reason,
  status: a.status,
  requestedBy: String(a.requestedBy),
  decidedBy: a.decidedBy ? String(a.decidedBy) : null,
  approvalReason: a.approvalReason ?? null,
  ledgerId: a.ledgerId ? String(a.ledgerId) : null,
  createdAt: a.createdAt,
});

api.route({
  method: 'get',
  path: '/admin/wallet-adjustments',
  summary: 'List wallet adjustments (maker-checker queue)',
  permission: 'admin:finance:read',
  query: paginationQuery.extend({ status: z.enum(ADJUSTMENT_STATUSES).optional() }).strict(),
  response: z.object({ items: z.array(AdjustmentSchema), meta: pageMeta }),
  handler: async ({ query }) => {
    const page = await paginate(WalletAdjustment, query.status ? { status: query.status } : {}, {
      page: query.page,
      limit: query.limit,
    });
    const docs = await WalletAdjustment.find({ _id: { $in: page.items.map((i) => i._id) } }).sort({
      createdAt: -1,
    });
    return { meta: page.meta, items: docs.map(toAdjustmentDTO) };
  },
});

api.route({
  method: 'post',
  path: '/admin/wallet-adjustments/:id/approve',
  summary: 'Approve a PENDING wallet adjustment (a different admin)',
  description:
    'Applies the adjustment to the ledger exactly once. The requesting admin can never approve their own request. Audit-logged.',
  permission: 'admin:finance:approve',
  params: idParams,
  body: z.strictObject({ note: z.string().trim().max(500).optional() }),
  response: AdjustmentSchema,
  handler: async ({ params, body, req }) => {
    const r = await WalletAdjustmentService.approve(params.id, body.note, auditContext(req));
    return toAdjustmentDTO(r.adjustment);
  },
});

api.route({
  method: 'post',
  path: '/admin/wallet-adjustments/:id/reject',
  summary: 'Reject a PENDING wallet adjustment',
  description: 'Never affects any balance. A note is mandatory. Audit-logged.',
  permission: 'admin:finance:approve',
  params: idParams,
  body: z.strictObject({ note: z.string().trim().min(5).max(500) }),
  response: AdjustmentSchema,
  handler: async ({ params, body, req }) => {
    const r = await WalletAdjustmentService.reject(params.id, body.note, auditContext(req));
    return toAdjustmentDTO(r.adjustment);
  },
});

const AlertSchema = z.object({
  id: z.string(),
  key: z.string(),
  type: z.string(),
  severity: z.enum(['INFO', 'WARNING', 'CRITICAL']),
  entity: z.string(),
  entityId: z.string().nullable(),
  message: z.string(),
  status: z.enum(['OPEN', 'RESOLVED']),
  count: z.number(),
  lastSeenAt: z.date(),
  createdAt: z.date(),
});
api.route({
  method: 'get',
  path: '/admin/alerts',
  summary: 'Operational alerts (failed refunds, failed payouts, shortfalls, ...)',
  permission: 'admin:finance:read',
  query: paginationQuery.extend({ status: z.enum(['OPEN', 'RESOLVED']).optional() }).strict(),
  response: z.object({ items: z.array(AlertSchema), meta: pageMeta }),
  handler: async ({ query }) => {
    const page = await paginate(AdminAlert, query.status ? { status: query.status } : {}, {
      page: query.page,
      limit: query.limit,
      sort: { lastSeenAt: -1 },
    });
    return {
      meta: page.meta,
      items: page.items.map((a) => ({
        id: String(a._id),
        key: a.key as string,
        type: a.type as string,
        severity: a.severity as 'INFO' | 'WARNING' | 'CRITICAL',
        entity: a.entity as string,
        entityId: a.entityId ? String(a.entityId) : null,
        message: a.message as string,
        status: a.status as 'OPEN' | 'RESOLVED',
        count: a.count as number,
        lastSeenAt: a.lastSeenAt as Date,
        createdAt: a.createdAt as Date,
      })),
    };
  },
});
api.route({
  method: 'patch',
  path: '/admin/alerts/:id/resolve',
  summary: 'Mark an alert resolved',
  permission: 'admin:finance:manage',
  params: idParams,
  response: z.object({ resolved: z.boolean() }),
  handler: async ({ params, auth }) => ({
    resolved: await AlertService.resolve(params.id, auth.userId),
  }),
});

api.route({
  method: 'post',
  path: '/admin/finance/process-due',
  summary: 'Run all due financial sweeps once',
  description:
    'Expires holds, flags no-shows, auto-completes, requests missing refunds, attempts due refunds and payouts and releases eligible earnings. Idempotent; BullMQ will schedule the same sweeps in Phase 4.',
  permission: 'admin:finance:manage',
  response: z.record(z.string(), z.unknown()),
  handler: () => runFinanceSweeps(),
});

api.route({
  method: 'get',
  path: '/admin/reconciliation',
  summary: 'Financial reconciliation report (read-only)',
  description:
    'Verifies wallet balances against the ledger, pending/available/total balances, payments vs bookings, refunds vs payments, commission/allocation arithmetic against snapshots and payouts vs ledger. Never modifies data.',
  permission: 'admin:finance:read',
  response: z.object({
    ok: z.boolean(),
    generatedAt: z.string(),
    totals: z.record(z.string(), z.number()),
    checks: z.array(
      z.object({
        name: z.string(),
        ok: z.boolean(),
        checked: z.number(),
        problems: z.array(z.string()),
      }),
    ),
  }),
  handler: () => ReconciliationService.run(),
});

api.route({
  method: 'post',
  path: '/admin/reconciliation/repair/refund-obligations',
  summary: 'Explicit repair: create missing refund obligations',
  description:
    'The only repair operation. Idempotent; audit-logged. Reconciliation itself never repairs.',
  permission: 'admin:finance:manage',
  response: z.object({ repaired: z.number() }),
  handler: ({ req }) => ReconciliationService.repairRefundObligations(auditContext(req)),
});

api.route({
  method: 'post',
  path: '/payments/dev/simulate',
  summary: 'DEV ONLY: deliver a signed provider webhook through the real webhook pipeline',
  description:
    'Available only with the mock provider outside production. Builds a correctly signed event and processes it exactly like a real delivery.',
  permission: 'admin:finance:manage',
  body: z.strictObject({
    providerTransactionId: z.string().min(5).max(120),
    outcome: z.enum(['succeeded', 'failed', 'cancelled']),
  }),
  response: z.object({
    status: z.enum(['PROCESSED', 'IGNORED', 'DUPLICATE']),
    outcome: z.string(),
  }),
  handler: async ({ body }) => {
    const provider = getPaymentProvider();
    if (env.isProd || !(provider instanceof MockPaymentProvider))
      throw new AppError(404, 'ROUTE_NOT_FOUND', 'Not found');
    const p = await Payment.findOne({ providerTransactionId: body.providerTransactionId });
    if (!p) throw new NotFoundError('Payment not found', 'PAYMENT_NOT_FOUND');
    const type = `payment.${body.outcome}` as
      'payment.succeeded' | 'payment.failed' | 'payment.cancelled';
    const { rawBody, headers } = provider.signEvent(type, {
      providerTransactionId: body.providerTransactionId,
      amountMinor: p.amountMinor,
      currency: p.currency,
    });
    if (body.outcome === 'succeeded') provider.markPaid(body.providerTransactionId);
    return PaymentWebhookService.handle(rawBody, headers);
  },
});

export default api.router;
