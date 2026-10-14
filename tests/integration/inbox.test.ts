import type { Express } from 'express';
import request from 'supertest';
import { AuditLog } from '../../src/modules/audit';
import { ContactMessage, NewsletterSubscriber } from '../../src/modules/inbox';
import { API, createAdmin, outbox, register, resetState, startApp, stopApp } from '../helpers/harness';

let app: Express;
beforeAll(async () => {
  app = await startApp();
});
afterAll(stopApp);
beforeEach(resetState);

const post = (path: string, body: object, headers: Record<string, string> = {}) =>
  request(app).post(`${API}${path}`).set(headers).send(body);
const message = {
  name: 'Mariam Ali',
  email: 'Mariam@Example.test',
  topic: 'CARE',
  message: 'I need overnight care for my father in Dubai next week.',
  locale: 'en',
};

describe('contact form', () => {
  it('stores a valid message (email normalised) and nothing else', async () => {
    const res = await post('/public/contact', { ...message, phone: '+971501234567' });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ received: true });
    const saved = await ContactMessage.find().lean();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ email: 'mariam@example.test', status: 'NEW', phone: '+971501234567' });
    expect(Object.keys(saved[0]!)).not.toEqual(expect.arrayContaining(['ip', 'userAgent']));
  });

  it('answers a filled honeypot normally but stores nothing', async () => {
    const res = await post('/public/contact', { ...message, website: 'http://spam.example' });
    expect(res.status).toBe(201);
    expect(await ContactMessage.countDocuments()).toBe(0);
  });

  it('validates input and rate-limits per IP', async () => {
    expect((await post('/public/contact', { ...message, email: 'nope' })).status).toBe(400);
    expect((await post('/public/contact', { ...message, message: 'short' })).status).toBe(400);
    expect((await post('/public/contact', { ...message, extra: 1 })).status).toBe(400);
    for (let i = 0; i < 2; i++) expect((await post('/public/contact', message)).status).toBe(201);
    expect((await post('/public/contact', message)).status).toBe(429); // 5/hour, 3 used by the failures above
  });
});

describe('newsletter double opt-in', () => {
  const tokensFrom = (body: string) => body.match(/: ([A-Za-z0-9_-]{30,})/g)!.map((m) => m.slice(2));

  it('subscribes only after confirmation, never reveals state, and unsubscribes idempotently', async () => {
    const first = await post('/public/newsletter', { email: 'reader@example.test', locale: 'ar' });
    expect(first.status).toBe(202);
    expect((await NewsletterSubscriber.findOne().lean())?.status).toBe('PENDING');
    const mail = outbox().last('NEWSLETTER_CONFIRM', 'reader@example.test')!;
    expect(mail.subject).toContain('كيرفلو');
    const [confirm, unsubscribe] = tokensFrom(mail.body);

    expect((await post('/public/newsletter/confirm', { token: confirm })).status).toBe(200);
    const sub = await NewsletterSubscriber.findOne().lean();
    expect(sub).toMatchObject({ status: 'SUBSCRIBED' });
    expect(sub?.consentAt).toBeInstanceOf(Date);
    expect(JSON.stringify(sub)).not.toContain(confirm!); // only hashes are stored
    // the confirm link is single-use
    expect((await post('/public/newsletter/confirm', { token: confirm })).body.errorCode).toBe('INVALID_TOKEN');

    // same answer for an already-confirmed address, and no new email
    outbox().clear();
    const again = await post('/public/newsletter', { email: 'reader@example.test' });
    expect(again.status).toBe(first.status);
    expect(again.body).toEqual(first.body);
    expect(outbox().last('NEWSLETTER_CONFIRM')).toBeUndefined();

    expect((await post('/public/newsletter/unsubscribe', { token: unsubscribe })).status).toBe(200);
    expect((await post('/public/newsletter/unsubscribe', { token: unsubscribe })).status).toBe(200);
    expect((await NewsletterSubscriber.findOne().lean())?.status).toBe('UNSUBSCRIBED');
    expect((await post('/public/newsletter/unsubscribe', { token: 'x'.repeat(40) })).status).toBe(400);
  });

  it('drops honeypot submissions silently', async () => {
    const res = await post('/public/newsletter', { email: 'bot@example.test', website: 'x' });
    expect(res.status).toBe(202);
    expect(await NewsletterSubscriber.countDocuments()).toBe(0);
    expect(outbox().last('NEWSLETTER_CONFIRM')).toBeUndefined();
  });
});

describe('admin inbox', () => {
  it('is ADMIN-only; handling a message is audit-logged', async () => {
    await post('/public/contact', message);
    const patient = await register(app, 'PATIENT');
    const finance = await createAdmin(app, 'FINANCE_APPROVER');
    const admin = await createAdmin(app);
    expect((await request(app).get(`${API}/admin/contact-messages`).set(patient.auth)).status).toBe(403);
    expect((await request(app).get(`${API}/admin/contact-messages`).set(finance.auth)).status).toBe(403);

    const list = await request(app).get(`${API}/admin/contact-messages?status=NEW`).set(admin.auth);
    expect(list.status).toBe(200);
    expect(list.body.data.meta.total).toBe(1);
    const id = list.body.data.items[0].id;

    const handled = await post(`/admin/contact-messages/${id}/handle`, { note: 'Called back' }, admin.auth);
    expect(handled.body.data).toMatchObject({ status: 'HANDLED', note: 'Called back' });
    expect(await AuditLog.countDocuments({ action: 'CONTACT_MESSAGE_HANDLED', entityId: id })).toBe(1);

    const counts = await request(app).get(`${API}/admin/inbox/counts`).set(admin.auth);
    expect(counts.body.data).toEqual({ newContactMessages: 0, subscribers: 0 });
  });

  it('never exposes newsletter token hashes', async () => {
    await post('/public/newsletter', { email: 'reader@example.test' });
    const admin = await createAdmin(app);
    const res = await request(app).get(`${API}/admin/newsletter-subscribers`).set(admin.auth);
    expect(res.body.data.items).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toMatch(/TokenHash|confirmExpires/);
  });
});

describe('public policies', () => {
  it('returns the live refund tiers (patient share only), longest notice first', async () => {
    const res = await request(app).get(`${API}/public/policies`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ currency: 'AED', timezone: 'Asia/Dubai' });
    expect(res.body.data.cancellationRefunds).toEqual([
      { minHoursBeforeStart: 48, refundPercent: 100 },
      { minHoursBeforeStart: 24, refundPercent: 50 },
      { minHoursBeforeStart: 0, refundPercent: 0 },
    ]);
    expect(JSON.stringify(res.body)).not.toContain('nurseCompensation');
  });
});
