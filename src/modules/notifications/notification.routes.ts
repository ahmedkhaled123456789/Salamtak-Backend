import '../../common/openapi/extend';
import { z } from 'zod';
import { NotFoundError } from '../../common/errors';
import { createApi } from '../../common/openapi/route';
import { paginationQuery } from '../../common/pagination';
import { NotificationService } from './notification.service';
import type { NotificationDoc } from './notification.models';

const NotificationSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  body: z.string(),
  data: z.record(z.string(), z.unknown()).nullable(),
  read: z.boolean(),
  readAt: z.date().nullable(),
  createdAt: z.date(),
});
const toDTO = (n: NotificationDoc) => ({
  id: String(n._id),
  type: n.type,
  title: n.title,
  body: n.body,
  data: (n.data as Record<string, unknown> | undefined) ?? null,
  read: !!n.readAt,
  readAt: n.readAt ?? null,
  createdAt: n.createdAt,
});

const api = createApi('Notifications');

api.route({
  method: 'get',
  path: '/notifications',
  summary: 'My notifications (newest first)',
  description: 'In-app inbox. A user can only ever see their own notifications.',
  permission: 'notifications:self',
  query: paginationQuery.extend({ unread: z.enum(['true', 'false']).optional() }).strict(),
  response: z.object({
    items: z.array(NotificationSchema),
    meta: z.object({
      page: z.number(),
      limit: z.number(),
      total: z.number(),
      totalPages: z.number(),
    }),
  }),
  handler: async ({ auth, query }) => {
    const { items, total } = await NotificationService.list(auth.userId, {
      page: query.page,
      limit: query.limit,
      unreadOnly: query.unread === 'true',
    });
    return {
      items: items.map(toDTO),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.limit)),
      },
    };
  },
});

api.route({
  method: 'get',
  path: '/notifications/unread-count',
  summary: 'Number of unread notifications',
  permission: 'notifications:self',
  response: z.object({ unread: z.number().int() }),
  handler: async ({ auth }) => ({ unread: await NotificationService.unreadCount(auth.userId) }),
});

api.route({
  method: 'post',
  path: '/notifications/read-all',
  summary: 'Mark all my notifications as read',
  permission: 'notifications:self',
  response: z.object({ updated: z.number().int() }),
  handler: async ({ auth }) => ({ updated: await NotificationService.markAllRead(auth.userId) }),
});

api.route({
  method: 'post',
  path: '/notifications/:id/read',
  summary: 'Mark one notification as read (idempotent)',
  permission: 'notifications:self',
  params: z.strictObject({ id: z.string().regex(/^[a-f\d]{24}$/i, 'invalid id') }),
  response: NotificationSchema,
  handler: async ({ auth, params }) => {
    const n = await NotificationService.markRead(auth.userId, params.id);
    if (!n) throw new NotFoundError('Notification not found', 'NOTIFICATION_NOT_FOUND');
    return toDTO(n);
  },
});

export default api.router;
