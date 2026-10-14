import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { AdminAlert, AlertService } from '../../src/modules/alerts';
import { Booking, BookingService } from '../../src/modules/bookings';
import {
  DeliveryService,
  Notification,
  NotificationDelivery,
  NotificationService,
} from '../../src/modules/notifications';
import { PayoutMethod, PayoutService } from '../../src/modules/payouts';
import { RefundService } from '../../src/modules/refunds';
import { WalletService } from '../../src/modules/wallets';
import { executeJob } from '../../src/jobs';
import { DeviceService } from '../../src/modules/devices';
import {
  MockEmailProvider,
  MockPushProvider,
  setEmailProvider,
  setPushProvider,
} from '../../src/providers/notification';
import type { MockPaymentProvider } from '../../src/providers/payment';
import { API, createAdmin, resetState, startApp, stopApp, type Session } from '../helpers/harness';
import { H, completeBooking, freshProvider, payFully, setSetting } from '../helpers/finance';
import { confirmedPastBooking, memoryQueue } from '../helpers/jobs';
import { at, baseWorld, bookIt, timeTravel, type BookArgs, type Nurse } from '../helpers/world';

let app: Express;
let admin: Session;
let serviceId: string;
let nurse: Nurse;
let patient: Session;
let patient2: Session;
let D: string;
let mock: MockPaymentProvider;
let email: MockEmailProvider;
let push: MockPushProvider;

beforeAll(async () => {
  app = await startApp();
});
afterAll(stopApp);
beforeEach(async () => {
  await resetState();
  memoryQueue().jobs.length = 0;
  mock = freshProvider();
  email = new MockEmailProvider();
  push = new MockPushProvider();
  setEmailProvider(email);
  setPushProvider(push);
  ({ admin, serviceId, nurse, patient, patient2, D } = await baseWorld(app));
});
afterEach(() => jest.restoreAllMocks());

const args = (s = '08:00', e = '12:00'): BookArgs => ({
  serviceId,
  nurseId: nurse.profileId,
  start: at(D, s),
  end: at(D, e),
});
const post = (s: Session, path: string, body: object = {}) =>
  request(app).post(`${API}${path}`).set(s.auth).send(body);
const get = (s: Session, path: string) => request(app).get(`${API}${path}`).set(s.auth);
const types = async (userId: string) =>
  (await Notification.find({ recipientId: userId }).sort({ createdAt: 1, _id: 1 }).lean()).map(
    (n) => n.type,
  );
const later = (s: number) => new Date(Date.now() + s * 1000);
const deliveries = (channel?: string) =>
  NotificationDelivery.find(channel ? { channel } : {}).sort({ createdAt: 1 });

describe('lifecycle notifications are written with the domain change', () => {
  it('patient and nurse receive the booking lifecycle in order', async () => {
    const r = await payFully(app, mock, patient, args());
    expect(await types(patient.id)).toEqual(['BOOKING_CREATED', 'PAYMENT_SUCCESSFUL']);
    await completeBooking(r.bookingId, nurse, app); // accept, start, complete
    expect(await types(patient.id)).toEqual([
      'BOOKING_CREATED',
      'PAYMENT_SUCCESSFUL',
      'NURSE_ACCEPTED',
      'BOOKING_STARTED',
      'BOOKING_COMPLETED',
    ]);
    const nurseUser = await Notification.find({ recipientId: nurse.session.id }).lean();
    expect(nurseUser.map((n) => n.type).sort()).toEqual([
      'BOOKING_ACCEPTED',
      'NEW_BOOKING_REQUEST',
    ]);
  });

  it('rejection and refund notify the patient (initiated, then completed)', async () => {
    const r = await payFully(app, mock, patient, args());
    await post(nurse.session, `/bookings/${r.bookingId}/reject`);
    expect(await types(patient.id)).toEqual(
      expect.arrayContaining(['NURSE_REJECTED', 'REFUND_INITIATED']),
    );
    await RefundService.processDue();
    expect(await types(patient.id)).toContain('REFUND_COMPLETED');
  });

  it('cancellation, expiry and dispute notify the right people', async () => {
    const a = await bookIt(app, patient, args('06:00', '08:00'));
    const unpaid = a.booking.body.data.id as string;
    await timeTravel(unpaid, { holdExpiresAt: new Date(Date.now() - 60_000) });
    await BookingService.expireDue(new Date());
    expect(await types(patient.id)).toContain('BOOKING_EXPIRED');

    const paid = await payFully(app, mock, patient, args('10:00', '12:00'));
    const start = Date.now() + 100 * H;
    await timeTravel(paid.bookingId, {
      startDateTime: new Date(start),
      endDateTime: new Date(start + 2 * H),
    });
    await post(patient, `/bookings/${paid.bookingId}/cancel`);
    expect(await types(patient.id)).toContain('BOOKING_CANCELLED');
    expect(await types(nurse.session.id)).toContain('BOOKING_CANCELLED_NURSE');

    const ns = await confirmedPastBooking(app, mock, patient, nurse, args('13:00', '15:00'), 45);
    await executeJob('booking.flagNoShows', {});
    await executeJob('booking.flagNoShows', {}); // duplicate job
    expect(await Notification.countDocuments({ type: 'BOOKING_DISPUTED' })).toBe(1);
    expect(await Notification.countDocuments({ type: 'BOOKING_DISPUTED_NURSE' })).toBe(1);
    expect(ns.bookingId).toBeTruthy();
  });

  it('different bookings and different lifecycle events never collapse into one notification', async () => {
    await payFully(app, mock, patient, args('06:00', '08:00'));
    await payFully(app, mock, patient, args('09:00', '11:00'));
    expect(
      await Notification.countDocuments({ recipientId: patient.id, type: 'PAYMENT_SUCCESSFUL' }),
    ).toBe(2);
    expect(
      await Notification.countDocuments({ recipientId: patient.id, type: 'BOOKING_CREATED' }),
    ).toBe(2);
  });

  it('notification texts carry no clinical or contact details', async () => {
    const quote = await bookIt(app, patient, { ...args(), notes: 'diabetic, insulin at 9am' });
    expect(quote.booking.status).toBe(201);
    const all = JSON.stringify(await Notification.find().lean());
    expect(all).not.toMatch(/diabet|insulin|Marina Walk/i);
  });

  it('is idempotent: re-notifying the same event creates nothing new', async () => {
    const input = {
      recipientId: patient.id,
      type: 'TEST_EVENT',
      title: 't',
      body: 'b',
      referenceKey: 'ref-1',
      channels: ['EMAIL' as const, 'PUSH' as const],
    };
    const a = await NotificationService.notify(input);
    const b = await NotificationService.notify(input);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(await Notification.countDocuments({ type: 'TEST_EVENT' })).toBe(1);
    expect(await NotificationDelivery.countDocuments({ notificationId: a.notification._id })).toBe(
      3,
    );
    const c = await NotificationService.notify({ ...input, referenceKey: 'ref-2' });
    expect(c.created).toBe(true);
  });
});

describe('delivery pipeline', () => {
  it('IN_APP is delivered immediately; EMAIL/PUSH are queued PENDING and swept into deterministic jobs', async () => {
    await payFully(app, mock, patient, args());
    expect((await deliveries('IN_APP')).every((d) => d.status === 'SENT')).toBe(true);
    const pending = await deliveries('EMAIL');
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((d) => d.status === 'PENDING')).toBe(true);
    const sweep = await executeJob('notification.sweep', {});
    expect(sweep.enqueued).toBe(sweep.due);
    expect((await executeJob('notification.sweep', {})).enqueued).toBe(0); // same ids => deduplicated
    const jobs = memoryQueue().jobs.filter((j) => j.name === 'notification.deliver');
    expect(jobs.length).toBe(sweep.due);
    expect(Object.keys(jobs[0]!.data)).toEqual(['deliveryId']);
  });

  it('delivers through the providers with the delivery id as provider reference', async () => {
    // push needs a registered device (Phase 5); email needs none
    await DeviceService.register(patient.id, {
      token: 'device-token-0123456789abcdef',
      platform: 'IOS',
    });
    await payFully(app, mock, patient, args());
    const due = await DeliveryService.dueIds();
    for (const id of due) await executeJob('notification.deliver', { deliveryId: id });
    expect(email.sent.length).toBeGreaterThan(0);
    expect(push.sent.length).toBeGreaterThan(0);
    expect(new Set(email.sent.map((m) => m.reference)).size).toBe(email.sent.length);
    const sent = await NotificationDelivery.find({ channel: 'EMAIL' });
    expect(sent.every((d) => d.status === 'SENT' && d.providerMessageId)).toBe(true);
    expect(email.sent[0]!.body).not.toMatch(/secret|token/i);
  });

  it('duplicate and concurrent delivery jobs send each message once', async () => {
    await payFully(app, mock, patient, args());
    const [d] = await deliveries('EMAIL');
    const outs = await Promise.all(
      [1, 2, 3, 4].map(() => executeJob('notification.deliver', { deliveryId: String(d!._id) })),
    );
    expect(outs.filter((o) => o.outcome === 'SENT')).toHaveLength(1);
    expect(email.sent.filter((m) => m.reference === String(d!._id))).toHaveLength(1);
  });

  it('retries a transient provider failure with backoff, then succeeds', async () => {
    await payFully(app, mock, patient, args());
    const [d] = await deliveries('EMAIL');
    email.failuresRemaining = 2;
    expect((await executeJob('notification.deliver', { deliveryId: String(d!._id) })).outcome).toBe(
      'RETRY',
    );
    const mid = (await NotificationDelivery.findById(d!._id))!;
    expect(mid).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(mid.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect((await executeJob('notification.deliver', { deliveryId: String(d!._id) })).outcome).toBe(
      'NOOP',
    ); // not due
    expect(
      (await executeJob('notification.deliver', { deliveryId: String(d!._id) }, { now: later(60) }))
        .outcome,
    ).toBe('RETRY');
    expect(
      (
        await executeJob(
          'notification.deliver',
          { deliveryId: String(d!._id) },
          { now: later(600) },
        )
      ).outcome,
    ).toBe('SENT');
    expect((await NotificationDelivery.findById(d!._id))!.attempts).toBe(3);
  });

  it('a permanent provider error fails immediately and raises one warning; exhausted retries fail too', async () => {
    await payFully(app, mock, patient, args());
    const [d, d2] = await deliveries('EMAIL');
    email.failuresRemaining = 99;
    email.failRetryable = false;
    expect((await executeJob('notification.deliver', { deliveryId: String(d!._id) })).outcome).toBe(
      'FAILED',
    );
    expect(await AdminAlert.countDocuments({ type: 'NOTIFICATION_DELIVERY_FAILED' })).toBe(1);
    email.failRetryable = true;
    await setSetting('notification.maxAttempts', 2);
    await executeJob('notification.deliver', { deliveryId: String(d2!._id) });
    const o = await executeJob(
      'notification.deliver',
      { deliveryId: String(d2!._id) },
      { now: later(600) },
    );
    expect(o.outcome).toBe('FAILED');
  });

  it('no provider configured: deliveries are SKIPPED (not errors) and flagged once', async () => {
    setEmailProvider(undefined);
    setPushProvider(undefined);
    await payFully(app, mock, patient, args());
    const counts = await DeliveryService.processDue();
    expect(counts.SKIPPED).toBeGreaterThan(0);
    expect(counts.FAILED).toBeUndefined();
    const skipped = await NotificationDelivery.find({ status: 'SKIPPED' });
    expect(skipped.every((d) => d.skippedReason === 'PROVIDER_NOT_CONFIGURED')).toBe(true);
    const alerts = await AdminAlert.find({ type: 'NOTIFICATION_PROVIDER_UNCONFIGURED' });
    expect(alerts.map((a) => a.key).sort()).toEqual([
      'notification-provider-unconfigured:EMAIL',
      'notification-provider-unconfigured:PUSH',
    ]);
    // the in-app notification itself is unaffected
    expect(await Notification.countDocuments({ recipientId: patient.id })).toBeGreaterThan(0);
  });

  it('a worker that crashed mid-delivery is recovered once its lease lapses; the provider reference stays stable', async () => {
    await payFully(app, mock, patient, args());
    const [d] = await deliveries('EMAIL');
    email.crashAfterSend = 1; // provider accepted the message, then the worker died
    await expect(
      executeJob('notification.deliver', { deliveryId: String(d!._id) }),
    ).resolves.toMatchObject({ outcome: 'RETRY' });
    // simulate the lease lapsing on a hard crash: PROCESSING with an expired lease
    await NotificationDelivery.collection.updateOne(
      { _id: d!._id },
      { $set: { status: 'PROCESSING', nextAttemptAt: new Date(Date.now() - 1000) } },
    );
    expect((await executeJob('notification.deliver', { deliveryId: String(d!._id) })).outcome).toBe(
      'SENT',
    );
    const refs = email.sent.filter((m) => m.reference === String(d!._id));
    expect(refs.length).toBe(2); // at-least-once; the SAME reference lets the provider de-duplicate
  });

  it('inactive recipients are skipped, never emailed', async () => {
    await payFully(app, mock, patient, args());
    const { User } = await import('../../src/modules/users');
    await User.updateOne({ _id: patient.id }, { $set: { isActive: false } });
    await DeliveryService.processDue();
    const mine = await NotificationDelivery.find({ recipientId: patient.id, channel: 'EMAIL' });
    expect(mine.every((d) => d.status === 'SKIPPED')).toBe(true);
    expect(email.sent.filter((m) => m.to === patient.email)).toHaveLength(0);
  });
});

describe('in-app inbox API', () => {
  it('lists my notifications, tracks unread, marks read idempotently and isolates users', async () => {
    await payFully(app, mock, patient, args());
    const list = await get(patient, '/notifications');
    expect(list.status).toBe(200);
    expect(list.body.data.items.length).toBe(2);
    expect(list.body.data.items[0].read).toBe(false);
    expect(list.body.data.items[0].createdAt >= list.body.data.items[1].createdAt).toBe(true);
    expect((await get(patient, '/notifications/unread-count')).body.data.unread).toBe(2);

    const id = list.body.data.items[0].id as string;
    const r1 = await post(patient, `/notifications/${id}/read`);
    const r2 = await post(patient, `/notifications/${id}/read`);
    expect(r1.body.data.read).toBe(true);
    expect(r2.body.data.readAt).toBe(r1.body.data.readAt);
    expect((await get(patient, '/notifications/unread-count')).body.data.unread).toBe(1);
    expect((await get(patient, '/notifications?unread=true')).body.data.items).toHaveLength(1);

    // another user can neither see nor modify it, and learns nothing about its existence
    expect((await get(patient2, '/notifications')).body.data.items).toHaveLength(0);
    expect((await post(patient2, `/notifications/${id}/read`)).status).toBe(404);
    expect((await post(nurse.session, `/notifications/${id}/read`)).status).toBe(404);

    const all = await post(patient, '/notifications/read-all');
    expect(all.body.data.updated).toBe(1);
    expect((await get(patient, '/notifications/unread-count')).body.data.unread).toBe(0);
  });

  it('requires authentication and validates the id', async () => {
    expect((await request(app).get(`${API}/notifications`)).status).toBe(401);
    expect((await post(patient, '/notifications/not-an-id/read')).status).toBe(400);
    expect((await get(patient, '/notifications?bogus=1')).status).toBe(400);
  });
});

describe('finance and wallet notifications', () => {
  it('a CRITICAL alert notifies every admin and finance approver once; lower severities do not', async () => {
    const approver = await createAdmin(app, 'FINANCE_APPROVER');
    for (let i = 0; i < 3; i++)
      await AlertService.raise({
        key: 'k-critical',
        type: 'TEST_CRITICAL',
        severity: 'CRITICAL',
        entity: 'Test',
        message: 'something is wrong',
      });
    await AlertService.raise({
      key: 'k-warn',
      type: 'TEST_WARN',
      severity: 'WARNING',
      entity: 'Test',
      message: 'meh',
    });
    expect(
      await Notification.countDocuments({ type: 'CRITICAL_ALERT', recipientId: admin.id }),
    ).toBe(1);
    expect(
      await Notification.countDocuments({ type: 'CRITICAL_ALERT', recipientId: approver.id }),
    ).toBe(1);
    expect(await Notification.countDocuments({ type: 'CRITICAL_ALERT' })).toBe(2);
    expect(
      await Notification.countDocuments({ recipientId: patient.id, type: 'CRITICAL_ALERT' }),
    ).toBe(0);
    // resolved then recurring (re-opened) is announced again
    await AlertService.resolveByKey('k-critical');
    await AlertService.raise({
      key: 'k-critical',
      type: 'TEST_CRITICAL',
      severity: 'CRITICAL',
      entity: 'Test',
      message: 'again',
      reopen: true,
    });
    expect(await Notification.countDocuments({ type: 'CRITICAL_ALERT' })).toBe(4);
  });

  it('earnings release and the payout lifecycle notify the nurse', async () => {
    const r = await payFully(app, mock, patient, args());
    await completeBooking(r.bookingId, nurse, app);
    await WalletService.releaseDue(new Date(Date.now() + 49 * H));
    await WalletService.releaseDue(new Date(Date.now() + 49 * H)); // duplicate
    expect(await Notification.countDocuments({ type: 'EARNINGS_RELEASED' })).toBe(1);
    await PayoutMethod.create({
      nurseId: nurse.profileId,
      provider: 'mock',
      providerRef: 'mock_acct_123456',
    });
    const p = await PayoutService.request(nurse.profileId, 10_000, randomUUID());
    expect(await Notification.countDocuments({ type: 'PAYOUT_SUBMITTED' })).toBe(1);
    await PayoutService.process(String(p._id));
    expect(await Notification.countDocuments({ type: 'PAYOUT_COMPLETED' })).toBe(1);

    const r2 = await payFully(app, mock, patient, args('14:00', '17:00'));
    await completeBooking(r2.bookingId, nurse, app);
    await WalletService.releaseDue(new Date(Date.now() + 49 * H));
    await setSetting('payout.maxAttempts', 1);
    const p2 = await PayoutService.request(nurse.profileId, 5_000, randomUUID());
    mock.payoutFailuresRemaining = 5;
    await PayoutService.process(String(p2._id));
    expect(await Notification.countDocuments({ type: 'PAYOUT_FAILED' })).toBe(1);
    expect((await Booking.countDocuments()) > 0).toBe(true);
  });
});
