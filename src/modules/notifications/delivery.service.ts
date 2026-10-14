import { logger } from '../../config/logger';
import {
  NotificationProviderError,
  getEmailProvider,
  getPushProvider,
} from '../../providers/notification';
import { AlertService } from '../alerts';
import { DeviceService } from '../devices';
import { SettingsService } from '../settings';
import { User } from '../users';
import {
  Notification,
  NotificationDelivery,
  type NotificationDeliveryDoc,
} from './notification.models';

const LEASE_MS = 5 * 60_000;
const MAX_BACKOFF_SECONDS = 3600;
const clean = (m: string) =>
  m
    .replace(/\b(sk|rk|pk|whsec)_[A-Za-z0-9_]+/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(0, 300);

export type DeliveryOutcome = 'SENT' | 'SKIPPED' | 'RETRY' | 'FAILED' | 'NOOP';

export const DeliveryService = {
  /**
   * Claims and delivers ONE channel of a notification. The claim is an atomic conditional update
   * (a lease), so duplicate jobs or several workers can never send the same delivery twice at the
   * same time; a crashed worker's lease lapses and the delivery is retried (providers de-duplicate
   * on `reference` = delivery id, so the worst case is one provider-deduplicated resend).
   */
  async deliver(deliveryId: string, now = new Date()): Promise<DeliveryOutcome> {
    const d = await NotificationDelivery.findOneAndUpdate(
      {
        _id: deliveryId,
        status: { $in: ['PENDING', 'PROCESSING'] },
        nextAttemptAt: { $lte: now },
      },
      {
        $set: { status: 'PROCESSING', nextAttemptAt: new Date(now.getTime() + LEASE_MS) },
        $inc: { attempts: 1 },
      },
      { new: true },
    );
    if (!d) return 'NOOP';
    const settings = await SettingsService.getAll();
    try {
      const n = await Notification.findById(d.notificationId).lean();
      const user = n ? await User.findById(d.recipientId).select('email isActive').lean() : null;
      if (!n || !user || !user.isActive) return await this.skip(d, 'RECIPIENT_UNAVAILABLE');

      if (d.channel === 'EMAIL') {
        const provider = getEmailProvider();
        if (!provider) return await this.unconfigured(d, 'EMAIL');
        const res = await provider.send({
          to: user.email,
          subject: n.title,
          body: n.body,
          reference: String(d._id),
        });
        return await this.sent(d, res.providerMessageId);
      }
      if (d.channel === 'PUSH') {
        const provider = getPushProvider();
        if (!provider) return await this.unconfigured(d, 'PUSH');
        const devices = await DeviceService.activeFor(String(d.recipientId));
        if (!devices.length) return await this.skip(d, 'NO_DEVICE');
        const res = await provider.send({
          userId: String(d.recipientId),
          tokens: devices.map((x) => ({ token: x.token, platform: x.platform })),
          title: n.title,
          body: n.body,
          data: { notificationId: String(n._id), type: n.type },
          reference: String(d._id),
        });
        if (res.invalidTokens?.length) await DeviceService.deactivateTokens(res.invalidTokens);
        return await this.sent(d, res.providerMessageId);
      }
      return await this.sent(d); // IN_APP rows are created as SENT; this is only a safety net
    } catch (err) {
      return this.failed(
        d,
        err,
        now,
        settings['notification.maxAttempts'],
        settings['notification.retryBaseSeconds'],
      );
    }
  },

  async sent(d: NotificationDeliveryDoc, providerMessageId?: string): Promise<DeliveryOutcome> {
    await NotificationDelivery.updateOne(
      { _id: d._id, status: 'PROCESSING' },
      {
        $set: {
          status: 'SENT',
          sentAt: new Date(),
          ...(providerMessageId && { providerMessageId }),
        },
        $unset: { lastError: 1, nextAttemptAt: 1 },
      },
    );
    return 'SENT';
  },

  async skip(d: NotificationDeliveryDoc, reason: string): Promise<DeliveryOutcome> {
    await NotificationDelivery.updateOne(
      { _id: d._id, status: 'PROCESSING' },
      { $set: { status: 'SKIPPED', skippedReason: reason }, $unset: { nextAttemptAt: 1 } },
    );
    return 'SKIPPED';
  },

  /** No provider configured: recorded as SKIPPED (never an error) and flagged once per channel. */
  async unconfigured(d: NotificationDeliveryDoc, channel: string): Promise<DeliveryOutcome> {
    await this.skip(d, 'PROVIDER_NOT_CONFIGURED');
    await AlertService.raise({
      key: `notification-provider-unconfigured:${channel}`,
      type: 'NOTIFICATION_PROVIDER_UNCONFIGURED',
      severity: 'INFO',
      entity: 'NotificationDelivery',
      message: `No ${channel} provider is configured; ${channel} notifications are being skipped`,
      data: { channel },
    }).catch(() => undefined);
    return 'SKIPPED';
  },

  async failed(
    d: NotificationDeliveryDoc,
    err: unknown,
    now: Date,
    maxAttempts: number,
    baseSeconds: number,
  ): Promise<DeliveryOutcome> {
    const message = clean(err instanceof Error ? err.message : String(err));
    const retryable = !(err instanceof NotificationProviderError) || err.retryable;
    if (!retryable || d.attempts >= maxAttempts) {
      await NotificationDelivery.updateOne(
        { _id: d._id, status: 'PROCESSING' },
        { $set: { status: 'FAILED', lastError: message }, $unset: { nextAttemptAt: 1 } },
      );
      logger.warn(
        { deliveryId: String(d._id), channel: d.channel, attempts: d.attempts },
        'Notification delivery failed permanently',
      );
      await AlertService.raise({
        key: `notification-failed:${String(d._id)}`,
        type: 'NOTIFICATION_DELIVERY_FAILED',
        severity: 'WARNING',
        entity: 'NotificationDelivery',
        entityId: String(d._id),
        message: 'A notification could not be delivered after retries',
        data: { channel: d.channel, attempts: d.attempts, lastError: message },
      }).catch(() => undefined);
      return 'FAILED';
    }
    const delay = Math.min(baseSeconds * 2 ** Math.max(0, d.attempts - 1), MAX_BACKOFF_SECONDS);
    await NotificationDelivery.updateOne(
      { _id: d._id, status: 'PROCESSING' },
      {
        $set: {
          status: 'PENDING',
          lastError: message,
          nextAttemptAt: new Date(now.getTime() + delay * 1000),
        },
      },
    );
    return 'RETRY';
  },

  /** Ids of deliveries that are due (PENDING, or PROCESSING with a lapsed lease). */
  async dueIds(now = new Date(), limit = 100): Promise<string[]> {
    const rows = await NotificationDelivery.find({
      status: { $in: ['PENDING', 'PROCESSING'] },
      nextAttemptAt: { $lte: now },
    })
      .sort({ nextAttemptAt: 1 })
      .limit(limit)
      .select('_id')
      .lean();
    return rows.map((r) => String(r._id));
  },

  /** Sweep used by tests and as a fallback when no queue is available. */
  async processDue(now = new Date(), limit = 100): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const id of await this.dueIds(now, limit)) {
      const o = await this.deliver(id, now);
      counts[o] = (counts[o] ?? 0) + 1;
    }
    return counts;
  },
};
