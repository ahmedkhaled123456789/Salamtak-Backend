import '../../common/openapi/extend';
import { z } from 'zod';
import { createApi } from '../../common/openapi/route';
import { Conversation } from '../chat';
import { Coupon, CouponRedemption } from '../coupons';
import { DeviceToken } from '../devices';
import { EmergencyRequest } from '../emergency';
import { NurseDocument } from '../nurse-verification';
import { NurseProfile } from '../nurses';
import { Review } from '../reviews';

const counts = z.record(z.string(), z.number().int());

const group = async (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: { aggregate: (p: any[]) => Promise<{ _id: string; n: number }[]> },
  field: string,
  match: Record<string, unknown> = {},
) =>
  Object.fromEntries(
    (
      await model.aggregate([{ $match: match }, { $group: { _id: `$${field}`, n: { $sum: 1 } } }])
    ).map((r) => [String(r._id), r.n]),
  );

const api = createApi('Admin');

api.route({
  method: 'get',
  path: '/admin/reports/marketplace',
  summary: 'Marketplace overview (verification, reviews, coupons, emergency, chat)',
  description:
    'Aggregate counts only: no personal data. `from`/`to` limit time-based counts (reviews, emergency requests, redemptions).',
  permission: 'admin:reports:read',
  query: z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }).strict(),
  response: z.object({
    nursesByVerification: counts,
    nursesByStatus: counts,
    documentsByStatus: counts,
    documentsPendingReview: z.number().int(),
    reviewsByStatus: counts,
    averageRatingActive: z.number().nullable(),
    coupons: z.object({
      total: z.number().int(),
      active: z.number().int(),
      redemptionsApplied: z.number().int(),
      redemptionsReleased: z.number().int(),
      discountGrantedMinor: z.number().int(),
    }),
    emergencyByStatus: counts,
    conversations: z.object({ booking: z.number().int(), support: z.number().int() }),
    activeDevices: z.number().int(),
  }),
  handler: async ({ query }) => {
    const created =
      query.from || query.to
        ? {
            createdAt: {
              ...(query.from && { $gte: query.from }),
              ...(query.to && { $lte: query.to }),
            },
          }
        : {};
    const [
      nursesByVerification,
      nursesByStatus,
      documentsByStatus,
      reviewsByStatus,
      emergencyByStatus,
      avg,
      couponTotal,
      couponActive,
      applied,
      released,
      discount,
      booking,
      support,
      devices,
    ] = await Promise.all([
      group(NurseProfile, 'verificationStatus'),
      group(NurseProfile, 'status'),
      group(NurseDocument, 'status'),
      group(Review, 'status', created),
      group(EmergencyRequest, 'status', created),
      Review.aggregate<{ avg: number }>([
        { $match: { status: 'ACTIVE', ...created } },
        { $group: { _id: null, avg: { $avg: '$rating' } } },
      ]),
      Coupon.countDocuments(),
      Coupon.countDocuments({ active: true }),
      CouponRedemption.countDocuments({ status: 'APPLIED', ...created }),
      CouponRedemption.countDocuments({ status: 'RELEASED', ...created }),
      CouponRedemption.aggregate<{ total: number }>([
        { $match: { status: 'APPLIED', ...created } },
        { $group: { _id: null, total: { $sum: '$discountMinor' } } },
      ]),
      Conversation.countDocuments({ type: 'BOOKING' }),
      Conversation.countDocuments({ type: 'SUPPORT' }),
      DeviceToken.countDocuments({ active: true }),
    ]);
    return {
      nursesByVerification,
      nursesByStatus,
      documentsByStatus,
      documentsPendingReview:
        (documentsByStatus.PENDING ?? 0) + (documentsByStatus.UNDER_REVIEW ?? 0),
      reviewsByStatus,
      averageRatingActive: avg[0] ? Math.round(avg[0].avg * 100) / 100 : null,
      coupons: {
        total: couponTotal,
        active: couponActive,
        redemptionsApplied: applied,
        redemptionsReleased: released,
        discountGrantedMinor: discount[0]?.total ?? 0,
      },
      emergencyByStatus,
      conversations: { booking, support },
      activeDevices: devices,
    };
  },
});

export default api.router;
