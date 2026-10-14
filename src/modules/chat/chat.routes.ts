import '../../common/openapi/extend';
import { z } from 'zod';
import { createApi } from '../../common/openapi/route';
import { ChatService, toMessageDTO } from './chat.service';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'invalid id');
const idParams = z.strictObject({ id: objectId });
const ConversationSchema = z.object({
  id: z.string(),
  type: z.enum(['BOOKING', 'SUPPORT']),
  bookingId: z.string().nullable(),
  bookingNumber: z.string().nullable(),
  counterpart: z.string().openapi({ description: 'First name + initial, or "Support"' }),
  unread: z.number().int(),
  lastMessageAt: z.date().nullable(),
  createdAt: z.date(),
});
const MessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  type: z.enum(['TEXT', 'SYSTEM']),
  senderRole: z.enum(['PATIENT', 'NURSE', 'ADMIN', 'SYSTEM']),
  mine: z.boolean(),
  text: z.string(),
  readAt: z.date().nullable(),
  createdAt: z.date(),
});

const api = createApi('Chat');

const toConversation = (c: Awaited<ReturnType<typeof ChatService.list>>['items'][number]) => c;

api.route({
  method: 'post',
  path: '/conversations',
  summary: 'Open (or get) the chat of a paid booking',
  description:
    'Only the patient or the nurse of the booking, only once it is paid. Idempotent: the same booking always yields the same conversation.',
  permission: 'chat:use',
  rateLimit: { name: 'chat-open', config: { points: 60, durationSeconds: 3600 } },
  body: z.strictObject({ bookingId: objectId }),
  response: z.object({ id: z.string() }),
  handler: async ({ auth, body }) => ({
    id: String((await ChatService.openForBooking(auth, body.bookingId))._id),
  }),
});

api.route({
  method: 'post',
  path: '/conversations/support',
  summary: 'Open (or get) my support conversation',
  description: 'Patients and nurses only; staff answer from the admin side.',
  permission: 'chat:use',
  rateLimit: { name: 'chat-open', config: { points: 60, durationSeconds: 3600 } },
  response: z.object({ id: z.string() }),
  handler: async ({ auth }) => ({ id: String((await ChatService.openSupport(auth))._id) }),
});

api.route({
  method: 'get',
  path: '/conversations',
  summary: 'My conversations (ADMIN: support conversations)',
  permission: 'chat:use',
  query: z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    })
    .strict(),
  response: z.object({
    items: z.array(ConversationSchema),
    meta: z.object({
      page: z.number(),
      limit: z.number(),
      total: z.number(),
      totalPages: z.number(),
    }),
  }),
  handler: async ({ auth, query }) => {
    const r = await ChatService.list(auth, query);
    return {
      items: r.items.map(toConversation),
      meta: {
        page: query.page,
        limit: query.limit,
        total: r.total,
        totalPages: Math.max(1, Math.ceil(r.total / query.limit)),
      },
    };
  },
});

api.route({
  method: 'get',
  path: '/conversations/unread-count',
  summary: 'Total unread messages',
  permission: 'chat:use',
  response: z.object({ unread: z.number().int() }),
  handler: async ({ auth }) => ({ unread: await ChatService.unreadCount(auth) }),
});

api.route({
  method: 'get',
  path: '/conversations/:id/messages',
  summary: 'Message history (cursor pagination, newest first)',
  description:
    'Pass `nextCursor` as `before` to load older messages. Realtime delivery is a convenience; this endpoint is the source of truth.',
  permission: 'chat:use',
  params: idParams,
  query: z
    .object({
      before: objectId.optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
    })
    .strict(),
  response: z.object({ items: z.array(MessageSchema), nextCursor: z.string().nullable() }),
  handler: async ({ auth, params, query }) => {
    const r = await ChatService.history(auth, params.id, query);
    return { items: r.items.map((m) => toMessageDTO(m, auth.userId)), nextCursor: r.nextCursor };
  },
});

api.route({
  method: 'post',
  path: '/conversations/:id/messages',
  summary: 'Send a message',
  description:
    'The sender is always the authenticated user. `clientMessageId` makes retries idempotent (a repeat returns the original message with `duplicate: true` and does not notify or broadcast again). Limited per user per minute (`chat.messagesPerMinute`).',
  permission: 'chat:use',
  status: 201,
  params: idParams,
  body: z.strictObject({
    text: z.string().min(1).max(10_000),
    clientMessageId: z.string().trim().min(8).max(80).optional(),
  }),
  response: MessageSchema.extend({ duplicate: z.boolean() }),
  handler: async ({ auth, params, body }) => {
    await ChatService.consumeSendBudget(auth.userId);
    const r = await ChatService.send(auth, params.id, body);
    return { ...toMessageDTO(r.message, auth.userId), duplicate: r.duplicate };
  },
});

api.route({
  method: 'post',
  path: '/conversations/:id/read',
  summary: 'Mark the conversation as read',
  permission: 'chat:use',
  params: idParams,
  response: z.object({ marked: z.number().int() }),
  handler: async ({ auth, params }) => ({ marked: await ChatService.markRead(auth, params.id) }),
});

export default api.router;
