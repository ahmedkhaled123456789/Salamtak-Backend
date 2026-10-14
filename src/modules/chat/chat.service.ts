import { Types } from 'mongoose';
import { AppError, NotFoundError, TooManyRequestsError } from '../../common/errors';
import { consumeFailure } from '../../common/middleware/rateLimit';
import { Booking } from '../bookings';
import { NotificationService } from '../notifications';
import { SettingsService } from '../settings';
import { User } from '../users';
import { Conversation, Message, type ConversationDoc, type MessageDoc } from './chat.models';

export interface Viewer {
  userId: string;
  role: string;
}

const isParticipant = (c: ConversationDoc, userId: string) =>
  c.participants.some((p) => String(p.userId) === userId);
const staffOf = (c: ConversationDoc, v: Viewer) => v.role === 'ADMIN' && c.type === 'SUPPORT';

const notFound = () => new NotFoundError('Conversation not found', 'CONVERSATION_NOT_FOUND');

/** Realtime fan-out hook (Socket.IO registers itself here). MongoDB stays the source of truth. */
type Publisher = (event: string, conversationId: string, payload: unknown) => void;
let publisher: Publisher | undefined;
export const setChatPublisher = (p: Publisher | undefined): void => {
  publisher = p;
};

/** `mine` is relative to the viewer; sender ids and admin identities are never exposed. */
export const toMessageDTO = (m: MessageDoc, viewerId: string) => ({
  id: String(m._id),
  conversationId: String(m.conversationId),
  type: m.type,
  senderRole: m.senderRole,
  mine: !!m.senderId && String(m.senderId) === viewerId,
  text: m.text,
  readAt: m.readAt ?? null,
  createdAt: m.createdAt,
});

export const ChatService = {
  // ------------------------------------------------------------------ access
  /** Participants of a conversation, plus ADMINs for SUPPORT conversations. Everyone else: 404. */
  async access(v: Viewer, conversationId: string): Promise<ConversationDoc> {
    if (!Types.ObjectId.isValid(conversationId)) throw notFound();
    const c = await Conversation.findById(conversationId);
    if (!c || !(isParticipant(c, v.userId) || staffOf(c, v))) throw notFound();
    return c;
  },

  /** Per-user message budget (settings), shared by REST and sockets. Redis only counts; it never decides correctness. */
  async consumeSendBudget(userId: string): Promise<void> {
    const points = await SettingsService.get('chat.messagesPerMinute');
    const r = await consumeFailure(`chat-send:${points}`, { points, durationSeconds: 60 }, userId);
    if (r.limited)
      throw new TooManyRequestsError('You are sending messages too quickly', r.retryAfterSeconds);
  },

  // ------------------------------------------------------------------ opening conversations
  /** Patient or nurse of a PAID booking; get-or-create (unique key makes concurrent calls collapse). */
  async openForBooking(v: Viewer, bookingId: string): Promise<ConversationDoc> {
    const b = Types.ObjectId.isValid(bookingId) ? await Booking.findById(bookingId) : null;
    const isPatient = !!b && String(b.patientId) === v.userId;
    const isNurse = !!b && String(b.nurseUserId) === v.userId;
    if (!b || !(isPatient || isNurse))
      throw new NotFoundError('Booking not found', 'BOOKING_NOT_FOUND');
    if (!b.paidAt || ['PENDING', 'PAYMENT_PENDING', 'EXPIRED'].includes(b.status))
      throw new AppError(422, 'CHAT_NOT_AVAILABLE', 'Chat opens once the booking is paid');
    return this.getOrCreate(`BOOKING:${bookingId}`, {
      type: 'BOOKING',
      bookingId,
      participants: [
        { userId: b.patientId, role: 'PATIENT' },
        { userId: b.nurseUserId, role: 'NURSE' },
      ],
    });
  },

  async openSupport(v: Viewer): Promise<ConversationDoc> {
    if (v.role !== 'PATIENT' && v.role !== 'NURSE')
      throw new AppError(403, 'FORBIDDEN', 'Only patients and nurses open support conversations');
    return this.getOrCreate(`SUPPORT:${v.userId}`, {
      type: 'SUPPORT',
      participants: [{ userId: v.userId, role: v.role as 'PATIENT' | 'NURSE' }],
    });
  },

  async getOrCreate(
    key: string,
    doc: {
      type: 'BOOKING' | 'SUPPORT';
      bookingId?: string;
      participants: { userId: unknown; role: 'PATIENT' | 'NURSE' }[];
    },
  ): Promise<ConversationDoc> {
    const run = () =>
      Conversation.findOneAndUpdate(
        { key },
        { $setOnInsert: { key, ...doc } },
        { upsert: true, new: true },
      );
    try {
      return (await run())!;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return (await run())!;
      throw err;
    }
  },

  // ------------------------------------------------------------------ messages
  /**
   * Stores a message. The sender is ALWAYS the authenticated viewer. A retry carrying the same
   * clientMessageId returns the original message (no duplicate row, notification or broadcast).
   */
  async send(
    v: Viewer,
    conversationId: string,
    input: { text: string; clientMessageId?: string },
  ): Promise<{ message: MessageDoc; duplicate: boolean }> {
    const c = await this.access(v, conversationId);
    const max = await SettingsService.get('chat.messageMaxLength');
    const text = input.text.trim();
    if (!text) throw new AppError(400, 'EMPTY_MESSAGE', 'Message text is required');
    if (text.length > max)
      throw new AppError(400, 'MESSAGE_TOO_LONG', `Messages are limited to ${max} characters`);

    let message: MessageDoc;
    try {
      message = await Message.create({
        conversationId: c._id,
        senderId: v.userId,
        senderRole: v.role,
        type: 'TEXT',
        text,
        ...(input.clientMessageId && { clientMessageId: input.clientMessageId }),
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000 && input.clientMessageId) {
        const existing = await Message.findOne({
          conversationId: c._id,
          senderId: v.userId,
          clientMessageId: input.clientMessageId,
        });
        if (existing) return { message: existing, duplicate: true };
      }
      throw err;
    }
    await Conversation.updateOne({ _id: c._id }, { $set: { lastMessageAt: message.createdAt } });

    // one generic push per unread burst (never the text), to the other side
    const recipients =
      c.type === 'BOOKING'
        ? c.participants.map((p) => String(p.userId)).filter((id) => id !== v.userId)
        : v.role === 'ADMIN'
          ? c.participants.map((p) => String(p.userId))
          : [];
    if (recipients.length) {
      const unread = await Message.countDocuments({
        conversationId: c._id,
        readAt: { $exists: false },
        senderId: { $ne: new Types.ObjectId(recipients[0]) },
      });
      if (unread === 1)
        for (const r of recipients)
          await NotificationService.notify({
            recipientId: r,
            type: 'NEW_MESSAGE',
            title: 'New message',
            body: 'You have a new message.',
            data: { conversationId: String(c._id) },
            referenceKey: `${String(c._id)}:${String(message._id)}`,
            channels: ['PUSH'],
          }).catch(() => undefined);
    }
    publisher?.('message:new', String(c._id), message);
    return { message, duplicate: false };
  },

  /** Cursor pagination (newest first): pass the last id as `before` to get the next page. */
  async history(v: Viewer, conversationId: string, q: { before?: string; limit: number }) {
    const c = await this.access(v, conversationId);
    const filter: Record<string, unknown> = { conversationId: c._id };
    if (q.before) {
      if (!Types.ObjectId.isValid(q.before))
        throw new AppError(400, 'INVALID_CURSOR', 'Invalid cursor');
      filter._id = { $lt: new Types.ObjectId(q.before) };
    }
    const rows = await Message.find(filter)
      .sort({ _id: -1 })
      .limit(q.limit + 1);
    const hasMore = rows.length > q.limit;
    const items = rows.slice(0, q.limit);
    return {
      items,
      nextCursor: hasMore ? String(items[items.length - 1]!._id) : null,
    };
  },

  async markRead(v: Viewer, conversationId: string): Promise<number> {
    const c = await this.access(v, conversationId);
    const res = await Message.updateMany(
      v.role === 'ADMIN' && c.type === 'SUPPORT'
        ? { conversationId: c._id, readAt: { $exists: false }, senderRole: { $ne: 'ADMIN' } }
        : {
            conversationId: c._id,
            readAt: { $exists: false },
            senderId: { $ne: new Types.ObjectId(v.userId) },
          },
      { $set: { readAt: new Date() } },
    );
    if (isParticipant(c, v.userId))
      await Conversation.updateOne(
        { _id: c._id, 'participants.userId': v.userId },
        { $set: { 'participants.$.lastReadAt': new Date() } },
      );
    if (res.modifiedCount > 0) publisher?.('conversation:read', String(c._id), { by: v.userId });
    return res.modifiedCount;
  },

  async scopeIds(v: Viewer): Promise<Types.ObjectId[]> {
    const filter =
      v.role === 'ADMIN'
        ? { type: 'SUPPORT' }
        : { 'participants.userId': new Types.ObjectId(v.userId) };
    return (await Conversation.find(filter).select('_id').limit(1000).lean()).map((c) => c._id);
  },

  async unreadCount(v: Viewer): Promise<number> {
    const ids = await this.scopeIds(v);
    if (!ids.length) return 0;
    return Message.countDocuments(
      v.role === 'ADMIN'
        ? { conversationId: { $in: ids }, readAt: { $exists: false }, senderRole: { $ne: 'ADMIN' } }
        : {
            conversationId: { $in: ids },
            readAt: { $exists: false },
            senderId: { $ne: new Types.ObjectId(v.userId) },
          },
    );
  },

  async list(v: Viewer, q: { page: number; limit: number }) {
    const filter =
      v.role === 'ADMIN'
        ? { type: 'SUPPORT' }
        : { 'participants.userId': new Types.ObjectId(v.userId) };
    const [rows, total] = await Promise.all([
      Conversation.find(filter)
        .sort({ lastMessageAt: -1, _id: -1 })
        .skip((q.page - 1) * q.limit)
        .limit(q.limit),
      Conversation.countDocuments(filter),
    ]);
    const ids = rows.map((c) => c._id);
    const unread = await Message.aggregate<{ _id: Types.ObjectId; n: number }>([
      {
        $match: {
          conversationId: { $in: ids },
          readAt: { $exists: false },
          ...(v.role === 'ADMIN'
            ? { senderRole: { $ne: 'ADMIN' } }
            : { senderId: { $ne: new Types.ObjectId(v.userId) } }),
        },
      },
      { $group: { _id: '$conversationId', n: { $sum: 1 } } },
    ]);
    const unreadBy = new Map(unread.map((u) => [String(u._id), u.n]));
    const otherIds = rows.flatMap((c) =>
      c.participants.map((p) => p.userId).filter((id) => String(id) !== v.userId),
    );
    const users = await User.find({ _id: { $in: otherIds } })
      .select('firstName lastName')
      .lean();
    const names = new Map(
      users.map((u) => [String(u._id), `${u.firstName} ${u.lastName.charAt(0)}.`]),
    );
    const bookings = await Booking.find({
      _id: { $in: rows.flatMap((c) => (c.bookingId ? [c.bookingId] : [])) },
    })
      .select('bookingNumber')
      .lean();
    const numbers = new Map(bookings.map((b) => [String(b._id), b.bookingNumber]));
    return {
      total,
      items: rows.map((c) => ({
        id: String(c._id),
        type: c.type,
        bookingId: c.bookingId ? String(c.bookingId) : null,
        bookingNumber: c.bookingId ? (numbers.get(String(c.bookingId)) ?? null) : null,
        counterpart:
          c.type === 'SUPPORT'
            ? v.role === 'ADMIN'
              ? (names.get(String(c.participants[0]!.userId)) ?? 'User')
              : 'Support'
            : (c.participants.map((p) => names.get(String(p.userId))).find((n) => !!n) ?? 'User'),
        unread: unreadBy.get(String(c._id)) ?? 0,
        lastMessageAt: c.lastMessageAt ?? null,
        createdAt: c.createdAt,
      })),
    };
  },
};
