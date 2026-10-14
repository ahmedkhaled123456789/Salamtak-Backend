import { BadRequestError, NotFoundError } from '../../common/errors';
import { paginate } from '../../common/pagination';
import { randomToken, sha256 } from '../../common/utils/crypto';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { getMessenger } from '../../providers/messaging/messenger';
import { AuditService, type AuditContext } from '../audit';
import {
  ContactMessage,
  NewsletterSubscriber,
  type ContactMessageDoc,
  type ContactTopic,
  type NewsletterSubscriberDoc,
} from './inbox.models';

const CONFIRM_TTL_MS = 48 * 3600 * 1000;
type Locale = 'en' | 'ar';

const link = (path: string, token: string) =>
  env.PUBLIC_WEB_URL ? `${env.PUBLIC_WEB_URL.replace(/\/+$/, '')}${path}?token=${encodeURIComponent(token)}` : token;

/** Email delivery never blocks or fails the request (and its timing must not reveal existing subscribers). */
function sendLater(label: string, fn: () => Promise<void>): void {
  void fn().catch((err: Error) => logger.warn({ label, err: err.message }, 'Inbox email delivery failed'));
}

export const toContactDTO = (m: ContactMessageDoc | Record<string, unknown>) => {
  const d = m as unknown as ContactMessageDoc;
  return {
    id: String(d._id),
    name: d.name,
    email: d.email,
    phone: d.phone ?? null,
    topic: d.topic,
    message: d.message,
    locale: d.locale,
    status: d.status,
    note: d.note ?? null,
    handledAt: d.handledAt ?? null,
    createdAt: d.createdAt,
  };
};

export const toSubscriberDTO = (s: NewsletterSubscriberDoc | Record<string, unknown>) => {
  const d = s as unknown as NewsletterSubscriberDoc;
  return {
    id: String(d._id),
    email: d.email,
    locale: d.locale,
    status: d.status,
    consentAt: d.consentAt ?? null,
    unsubscribedAt: d.unsubscribedAt ?? null,
    createdAt: d.createdAt,
  };
};

export const InboxService = {
  async submitContact(input: {
    name: string;
    email: string;
    phone?: string;
    topic: ContactTopic;
    message: string;
    locale: Locale;
  }): Promise<{ id: string }> {
    const m = await ContactMessage.create(input);
    return { id: String(m._id) };
  },

  /** Always answers the same way; a confirmation email is (re)sent unless the address is already confirmed. */
  async subscribe(email: string, locale: Locale): Promise<void> {
    const existing = await NewsletterSubscriber.findOne({ email });
    if (existing?.status === 'SUBSCRIBED') return;
    const confirmToken = randomToken(32);
    const unsubscribeToken = randomToken(32);
    await NewsletterSubscriber.updateOne(
      { email },
      {
        $set: {
          locale,
          status: 'PENDING',
          confirmTokenHash: sha256(confirmToken),
          confirmExpiresAt: new Date(Date.now() + CONFIRM_TTL_MS),
          unsubscribeTokenHash: sha256(unsubscribeToken),
        },
        $unset: { unsubscribedAt: 1 },
      },
      { upsert: true },
    );
    const ar = locale === 'ar';
    sendLater('newsletter-confirm', () =>
      getMessenger().send({
        channel: 'EMAIL',
        to: email,
        purpose: 'NEWSLETTER_CONFIRM',
        subject: ar ? 'أكّد اشتراكك في نشرة كيرفلو' : 'Confirm your CareFlow newsletter subscription',
        body: ar
          ? `لتأكيد الاشتراك: ${link('/newsletter/confirm', confirmToken)}\nلإلغاء الاشتراك في أي وقت: ${link('/newsletter/unsubscribe', unsubscribeToken)}\nإن لم تطلب ذلك، تجاهل هذه الرسالة.`
          : `Confirm your subscription: ${link('/newsletter/confirm', confirmToken)}\nUnsubscribe at any time: ${link('/newsletter/unsubscribe', unsubscribeToken)}\nIf you didn't ask for this, ignore this email.`,
      }),
    );
  },

  /**
   * Adds an address that already consented elsewhere (imports, demo data). Idempotent; never downgrades an
   * unsubscribed address back to subscribed.
   */
  async importConfirmed(email: string, locale: Locale, consentAt = new Date()): Promise<void> {
    const existing = await NewsletterSubscriber.findOne({ email });
    if (existing) return;
    await NewsletterSubscriber.create({
      email,
      locale,
      status: 'SUBSCRIBED',
      consentAt,
      unsubscribeTokenHash: sha256(randomToken(32)),
      source: 'import',
    });
  },

  async confirm(token: string): Promise<void> {
    const s = await NewsletterSubscriber.findOneAndUpdate(
      { confirmTokenHash: sha256(token), confirmExpiresAt: { $gt: new Date() } },
      { $set: { status: 'SUBSCRIBED', consentAt: new Date() }, $unset: { confirmTokenHash: 1, confirmExpiresAt: 1 } },
    );
    if (!s) throw new BadRequestError('This confirmation link is invalid or has expired', 'INVALID_TOKEN');
  },

  /** Idempotent: the same link keeps working. */
  async unsubscribe(token: string): Promise<void> {
    const s = await NewsletterSubscriber.findOne({ unsubscribeTokenHash: sha256(token) });
    if (!s) throw new BadRequestError('This unsubscribe link is invalid', 'INVALID_TOKEN');
    if (s.status !== 'UNSUBSCRIBED')
      await NewsletterSubscriber.updateOne(
        { _id: s._id },
        { $set: { status: 'UNSUBSCRIBED', unsubscribedAt: new Date() }, $unset: { confirmTokenHash: 1, confirmExpiresAt: 1 } },
      );
  },

  listContact(q: { page: number; limit: number; status?: string }) {
    return paginate(ContactMessage, q.status ? { status: q.status } : {}, { page: q.page, limit: q.limit });
  },

  async handleContact(id: string, note: string | undefined, ctx: AuditContext) {
    const before = await ContactMessage.findById(id);
    if (!before) throw new NotFoundError('Message not found', 'CONTACT_MESSAGE_NOT_FOUND');
    const after = await ContactMessage.findByIdAndUpdate(
      id,
      { $set: { status: 'HANDLED', handledAt: new Date(), handledBy: ctx.actorId, ...(note ? { note } : {}) } },
      { new: true },
    );
    await AuditService.record(ctx, {
      action: 'CONTACT_MESSAGE_HANDLED',
      entity: 'ContactMessage',
      entityId: id,
      oldData: { status: before.status },
      newData: { status: 'HANDLED', note: note ?? null },
    });
    return after!;
  },

  listSubscribers(q: { page: number; limit: number; status?: string }) {
    return paginate(NewsletterSubscriber, q.status ? { status: q.status } : {}, {
      page: q.page,
      limit: q.limit,
      select: '-confirmTokenHash -unsubscribeTokenHash -confirmExpiresAt',
    });
  },

  async counts(): Promise<{ newContactMessages: number; subscribers: number }> {
    const [newContactMessages, subscribers] = await Promise.all([
      ContactMessage.countDocuments({ status: 'NEW' }),
      NewsletterSubscriber.countDocuments({ status: 'SUBSCRIBED' }),
    ]);
    return { newContactMessages, subscribers };
  },
};
