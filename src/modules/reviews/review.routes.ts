import '../../common/openapi/extend';
import { z } from 'zod';
import { createApi } from '../../common/openapi/route';
import { auditContext } from '../audit';
import { NurseProfile } from '../nurses';
import { NotFoundError } from '../../common/errors';
import { REVIEW_STATUSES } from './review.models';
import { ReviewService, toAdminReviewDTO, toOwnReviewDTO } from './review.service';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'invalid id');
const idParams = z.strictObject({ id: objectId });
const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const meta = z.object({
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  totalPages: z.number(),
});
const mk = (page: number, limit: number, total: number) => ({
  page,
  limit,
  total,
  totalPages: Math.max(1, Math.ceil(total / limit)),
});
const OwnReview = z.object({
  id: z.string(),
  bookingId: z.string(),
  nurseId: z.string(),
  rating: z.number().int(),
  comment: z.string().nullable(),
  status: z.enum(REVIEW_STATUSES),
  createdAt: z.date(),
});
const AdminReview = OwnReview.extend({
  patientId: z.string(),
  moderationReason: z.string().nullable(),
  moderatedBy: z.string().nullable(),
  moderatedAt: z.date().nullable(),
});
const PublicReview = z.object({
  id: z.string(),
  rating: z.number().int(),
  comment: z.string().nullable(),
  reviewer: z.string().openapi({ description: 'First name only' }),
  createdAt: z.date(),
});

const api = createApi('Reviews');

api.route({
  method: 'post',
  path: '/bookings/:id/review',
  summary: 'Review a completed booking (patient)',
  description:
    'Only the booking patient, only once, only after the booking is COMPLETED (not cancelled, refunded, rejected, expired or disputed). The nurse rating aggregate is updated in the same transaction. A duplicate is `409 REVIEW_ALREADY_EXISTS`.',
  permission: 'reviews:create',
  rateLimit: { name: 'review-create', config: { points: 20, durationSeconds: 3600 } },
  status: 201,
  params: idParams,
  body: z.strictObject({
    rating: z.number().int().min(1).max(5),
    comment: z.string().trim().max(1000).optional(),
  }),
  response: OwnReview,
  handler: async ({ auth, params, body }) =>
    toOwnReviewDTO(await ReviewService.create(auth.userId, params.id, body)),
});

api.route({
  method: 'get',
  path: '/reviews/me',
  summary: 'My reviews',
  permission: 'reviews:create',
  query: pageQuery.strict(),
  response: z.object({ items: z.array(OwnReview), meta }),
  handler: async ({ auth, query }) => {
    const { items, total } = await ReviewService.listMine(auth.userId, query);
    return { items: items.map(toOwnReviewDTO), meta: mk(query.page, query.limit, total) };
  },
});

api.route({
  method: 'get',
  path: '/nurses/:id/reviews',
  summary: 'Public reviews of a nurse (ACTIVE only)',
  description:
    'Only ACTIVE reviews of bookable nurses. The reviewer is shown by first name only; no patient ids, booking ids or moderation data.',
  permission: 'nurses:search',
  params: idParams,
  query: pageQuery.strict(),
  response: z.object({ items: z.array(PublicReview), meta }),
  handler: async ({ auth, params, query }) => {
    const nurse = await NurseProfile.findById(params.id).select('isBookable').lean();
    if (!nurse || (!nurse.isBookable && auth.role !== 'ADMIN'))
      throw new NotFoundError('Nurse not found', 'NURSE_NOT_FOUND');
    const { items, total } = await ReviewService.listForNurse(params.id, query);
    return { items, meta: mk(query.page, query.limit, total) };
  },
});

api.route({
  method: 'get',
  path: '/admin/reviews',
  summary: 'Review moderation list',
  permission: 'admin:reviews:moderate',
  query: pageQuery
    .extend({ status: z.enum(REVIEW_STATUSES).optional(), nurseId: objectId.optional() })
    .strict(),
  response: z.object({ items: z.array(AdminReview), meta }),
  handler: async ({ query }) => {
    const { items, total } = await ReviewService.listAdmin(query);
    return { items: items.map(toAdminReviewDTO), meta: mk(query.page, query.limit, total) };
  },
});

api.route({
  method: 'get',
  path: '/admin/reviews/:id',
  summary: 'Inspect a review',
  permission: 'admin:reviews:moderate',
  params: idParams,
  response: AdminReview,
  handler: async ({ params }) => toAdminReviewDTO(await ReviewService.getAdmin(params.id)),
});

for (const [action, needsReason] of [
  ['hide', true],
  ['flag', true],
  ['restore', false],
] as const) {
  api.route({
    method: 'post',
    path: `/admin/reviews/:id/${action}`,
    summary: `${action[0]!.toUpperCase()}${action.slice(1)} a review`,
    description:
      'Idempotent and audit-logged. Hidden and flagged reviews are removed from the public list and from the nurse rating aggregate; restoring puts them back. Nothing is deleted.',
    permission: 'admin:reviews:moderate',
    rateLimit: { name: 'review-moderate', config: { points: 120, durationSeconds: 60 } },
    params: idParams,
    body: needsReason
      ? z.strictObject({ reason: z.string().trim().min(3).max(500) })
      : z.strictObject({ reason: z.string().trim().max(500).optional() }),
    response: AdminReview.extend({ changed: z.boolean() }),
    handler: async ({ params, body, req }) => {
      const r = await ReviewService.moderate(
        params.id,
        action.toUpperCase() as 'HIDE' | 'FLAG' | 'RESTORE',
        body.reason,
        auditContext(req),
      );
      return { ...toAdminReviewDTO(r.review), changed: r.changed };
    },
  });
}

export default api.router;
