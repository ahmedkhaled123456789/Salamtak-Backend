import '../../common/openapi/extend';
import { z } from 'zod';
import { createApi } from '../../common/openapi/route';
import { paginate, paginationQuery } from '../../common/pagination';
import { NurseService } from '../nurses';
import { LEDGER_TYPES, WalletTransaction } from './wallet.models';
import { WalletService } from './wallet.service';

const fils = z.number().int().openapi({ description: 'Integer minor units (fils)' });
const WalletSchema = z.object({
  availableBalanceMinor: fils.openapi({ description: 'Withdrawable now' }),
  pendingBalanceMinor: fils.openapi({
    description: 'Earned but not yet released (delay after completion)',
  }),
  totalEarnedMinor: fils,
  totalWithdrawnMinor: fils,
  currency: z.literal('AED'),
});
const TxSchema = z.object({
  id: z.string(),
  type: z.enum(LEDGER_TYPES),
  bucket: z.enum(['PENDING', 'AVAILABLE', 'NONE']),
  amountMinor: fils,
  balanceBefore: fils,
  balanceAfter: fils,
  referenceType: z.string(),
  referenceId: z.string(),
  note: z.string().nullable(),
  createdAt: z.date(),
});

const api = createApi('Wallet');

api.route({
  method: 'get',
  path: '/wallets/me',
  summary: 'My wallet balances',
  description: 'Balances are derived from the immutable ledger; every change has a ledger row.',
  permission: 'wallet:self',
  response: WalletSchema,
  handler: async ({ auth }) => {
    const nurse = await NurseService.getByUserId(auth.userId);
    const w = await WalletService.ensure(String(nurse._id));
    return {
      availableBalanceMinor: w.availableBalanceMinor,
      pendingBalanceMinor: w.pendingBalanceMinor,
      totalEarnedMinor: w.totalEarnedMinor,
      totalWithdrawnMinor: w.totalWithdrawnMinor,
      currency: w.currency as 'AED',
    };
  },
});

api.route({
  method: 'get',
  path: '/wallets/me/transactions',
  summary: 'My wallet ledger (newest first)',
  permission: 'wallet:self',
  query: paginationQuery.extend({ type: z.enum(LEDGER_TYPES).optional() }).strict(),
  response: z.object({
    items: z.array(TxSchema),
    meta: z.object({
      page: z.number(),
      limit: z.number(),
      total: z.number(),
      totalPages: z.number(),
    }),
  }),
  handler: async ({ auth, query }) => {
    const nurse = await NurseService.getByUserId(auth.userId);
    const page = await paginate(
      WalletTransaction,
      { nurseId: nurse._id, ...(query.type && { type: query.type }) },
      { page: query.page, limit: query.limit, sort: { createdAt: -1, _id: -1 } },
    );
    return {
      meta: page.meta,
      items: page.items.map((t) => ({
        id: String(t._id),
        type: t.type,
        bucket: t.bucket,
        amountMinor: t.amountMinor,
        balanceBefore: t.balanceBefore,
        balanceAfter: t.balanceAfter,
        referenceType: t.referenceType,
        referenceId: String(t.referenceId),
        note: t.note ?? null,
        createdAt: t.createdAt,
      })),
    };
  },
});

export default api.router;
