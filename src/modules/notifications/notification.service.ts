import type { ClientSession } from 'mongoose';
import { Types } from 'mongoose';
import {
  Notification,
  NotificationDelivery,
  type Channel,
  type NotificationDoc,
} from './notification.models';

export interface NotifyInput {
  recipientId: string;
  /** e.g. BOOKING_CONFIRMED. Together with `referenceKey` it makes the notification idempotent. */
  type: string;
  title: string;
  body: string;
  data?: Record<string, string | number | boolean | null>;
  /** Deterministic business reference, e.g. `${bookingId}:CONFIRMED`. */
  referenceKey: string;
  /** IN_APP is always created (it is the inbox row); EMAIL / PUSH are optional extra deliveries. */
  channels?: Exclude<Channel, 'IN_APP'>[];
}

export const NotificationService = {
  /**
   * Idempotent create (an outbox write: call it INSIDE the domain transaction so the notification
   * exists if and only if the domain change committed). A repeat with the same
   * recipient + type + referenceKey changes nothing and returns `created:false`.
   */
  async notify(
    n: NotifyInput,
    session?: ClientSession,
  ): Promise<{ notification: NotificationDoc; created: boolean }> {
    const r = await Notification.findOneAndUpdate(
      { recipientId: n.recipientId, type: n.type, referenceKey: n.referenceKey },
      {
        $setOnInsert: {
          title: n.title,
          body: n.body,
          ...(n.data && { data: n.data }),
        },
      },
      { upsert: true, new: true, includeResultMetadata: true, session },
    );
    const notification = r.value as NotificationDoc;
    const created = r.lastErrorObject?.updatedExisting === false;
    if (created) {
      const now = new Date();
      const rows = [
        { channel: 'IN_APP' as const, status: 'SENT' as const, sentAt: now },
        ...(n.channels ?? []).map((channel) => ({
          channel,
          status: 'PENDING' as const,
          nextAttemptAt: now,
        })),
      ];
      await NotificationDelivery.bulkWrite(
        rows.map((row) => ({
          updateOne: {
            filter: { notificationId: notification._id, channel: row.channel },
            update: {
              $setOnInsert: {
                recipientId: new Types.ObjectId(n.recipientId),
                attempts: 0,
                ...row,
              },
            },
            upsert: true,
          },
        })),
        { session },
      );
    }
    return { notification, created };
  },

  async list(
    userId: string,
    q: { page: number; limit: number; unreadOnly?: boolean },
  ): Promise<{ items: NotificationDoc[]; total: number }> {
    const filter = { recipientId: userId, ...(q.unreadOnly && { readAt: { $exists: false } }) };
    const [items, total] = await Promise.all([
      Notification.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((q.page - 1) * q.limit)
        .limit(q.limit),
      Notification.countDocuments(filter),
    ]);
    return { items, total };
  },

  unreadCount: (userId: string) =>
    Notification.countDocuments({ recipientId: userId, readAt: { $exists: false } }),

  /** Only the owner can mark it read; anyone else gets "not found" (no existence leak). Idempotent. */
  async markRead(userId: string, id: string): Promise<NotificationDoc | null> {
    const n = await Notification.findOneAndUpdate(
      { _id: id, recipientId: userId, readAt: { $exists: false } },
      { $set: { readAt: new Date() } },
      { new: true },
    );
    return n ?? (await Notification.findOne({ _id: id, recipientId: userId }));
  },

  async markAllRead(userId: string): Promise<number> {
    const r = await Notification.updateMany(
      { recipientId: userId, readAt: { $exists: false } },
      { $set: { readAt: new Date() } },
    );
    return r.modifiedCount;
  },
};
