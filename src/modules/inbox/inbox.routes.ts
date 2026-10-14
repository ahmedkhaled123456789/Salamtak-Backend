import '../../common/openapi/extend';
import { z } from 'zod';
import { createApi } from '../../common/openapi/route';
import { paginationQuery } from '../../common/pagination';
import { auditContext } from '../audit';
import { CONTACT_STATUSES, CONTACT_TOPICS, SUBSCRIBER_STATUSES } from './inbox.models';
import { InboxService, toContactDTO, toSubscriberDTO } from './inbox.service';

const email = z.string().trim().toLowerCase().email().max(254);
const locale = z.enum(['en', 'ar']).default('en');
/** Honeypot: a field humans never see. Bots that fill it get a normal-looking answer and nothing is stored. */
const honeypot = z.string().max(200).optional();
const token = z.strictObject({ token: z.string().trim().min(20).max(200) });
const pageMeta = z.object({ page: z.number(), limit: z.number(), total: z.number(), totalPages: z.number() });

const ContactSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  topic: z.enum(CONTACT_TOPICS),
  message: z.string(),
  locale: z.enum(['en', 'ar']),
  status: z.enum(CONTACT_STATUSES),
  note: z.string().nullable(),
  handledAt: z.date().nullable(),
  createdAt: z.date(),
});
const SubscriberSchema = z.object({
  id: z.string(),
  email: z.string(),
  locale: z.enum(['en', 'ar']),
  status: z.enum(SUBSCRIBER_STATUSES),
  consentAt: z.date().nullable(),
  unsubscribedAt: z.date().nullable(),
  createdAt: z.date(),
});

const api = createApi('Inbox');

api.route({
  method: 'post',
  path: '/public/contact',
  summary: 'Public: send a message through the contact form',
  description: 'Stored for the support team (deleted after two years). Rate limited per IP.',
  public: true,
  rateLimit: { name: 'contact', config: { points: 5, durationSeconds: 3600 } },
  status: 201,
  message: 'Message received',
  body: z.strictObject({
    name: z.string().trim().min(2).max(120),
    email,
    phone: z
      .string()
      .trim()
      .regex(/^\+[1-9]\d{6,14}$/, 'E.164 phone number, e.g. +971501234567')
      .optional(),
    topic: z.enum(CONTACT_TOPICS),
    message: z.string().trim().min(10).max(4000),
    locale,
    website: honeypot,
  }),
  response: z.object({ received: z.literal(true) }),
  handler: async ({ body }) => {
    const { website, ...input } = body;
    if (!website) await InboxService.submitContact(input);
    return { received: true as const };
  },
});

api.route({
  method: 'post',
  path: '/public/newsletter',
  summary: 'Public: subscribe to the newsletter (double opt-in)',
  description:
    'Always answers the same way (never reveals whether an address is subscribed). A confirmation link is emailed; nothing is sent to the address until it is confirmed.',
  public: true,
  rateLimit: { name: 'newsletter', config: { points: 5, durationSeconds: 3600 } },
  status: 202,
  message: 'Check your inbox to confirm',
  body: z.strictObject({ email, locale, website: honeypot }),
  response: z.object({ pendingConfirmation: z.literal(true) }),
  handler: async ({ body }) => {
    if (!body.website) await InboxService.subscribe(body.email, body.locale);
    return { pendingConfirmation: true as const };
  },
});

api.route({
  method: 'post',
  path: '/public/newsletter/confirm',
  summary: 'Public: confirm a newsletter subscription',
  public: true,
  rateLimit: { name: 'newsletter-token', config: { points: 20, durationSeconds: 3600 } },
  body: token,
  response: z.object({ subscribed: z.literal(true) }),
  handler: async ({ body }) => {
    await InboxService.confirm(body.token);
    return { subscribed: true as const };
  },
});

api.route({
  method: 'post',
  path: '/public/newsletter/unsubscribe',
  summary: 'Public: unsubscribe (link from any newsletter email)',
  public: true,
  rateLimit: { name: 'newsletter-token', config: { points: 20, durationSeconds: 3600 } },
  body: token,
  response: z.object({ unsubscribed: z.literal(true) }),
  handler: async ({ body }) => {
    await InboxService.unsubscribe(body.token);
    return { unsubscribed: true as const };
  },
});

api.route({
  method: 'get',
  path: '/admin/contact-messages',
  summary: 'Contact form messages',
  permission: 'admin:inbox:manage',
  query: paginationQuery.extend({ status: z.enum(CONTACT_STATUSES).optional() }).strict(),
  response: z.object({ items: z.array(ContactSchema), meta: pageMeta }),
  handler: async ({ query }) => {
    const page = await InboxService.listContact(query);
    return { items: page.items.map(toContactDTO), meta: page.meta };
  },
});

api.route({
  method: 'post',
  path: '/admin/contact-messages/:id/handle',
  summary: 'Mark a contact message as handled',
  description: 'Audit-logged.',
  permission: 'admin:inbox:manage',
  params: z.strictObject({ id: z.string().regex(/^[a-f\d]{24}$/i, 'invalid id') }),
  body: z.strictObject({ note: z.string().trim().max(1000).optional() }),
  response: ContactSchema,
  handler: async ({ params, body, req }) =>
    toContactDTO(await InboxService.handleContact(params.id, body.note, auditContext(req))),
});

api.route({
  method: 'get',
  path: '/admin/newsletter-subscribers',
  summary: 'Newsletter subscribers',
  permission: 'admin:inbox:manage',
  query: paginationQuery.extend({ status: z.enum(SUBSCRIBER_STATUSES).optional() }).strict(),
  response: z.object({ items: z.array(SubscriberSchema), meta: pageMeta }),
  handler: async ({ query }) => {
    const page = await InboxService.listSubscribers(query);
    return { items: page.items.map(toSubscriberDTO), meta: page.meta };
  },
});

api.route({
  method: 'get',
  path: '/admin/inbox/counts',
  summary: 'Unhandled contact messages and confirmed subscribers',
  permission: 'admin:inbox:manage',
  response: z.object({ newContactMessages: z.number(), subscribers: z.number() }),
  handler: () => InboxService.counts(),
});

export default api.router;
