import type { Express } from 'express';
import request from 'supertest';
import { DeviceToken } from '../../src/modules/devices';
import {
  DeliveryService,
  Notification,
  NotificationDelivery,
} from '../../src/modules/notifications';
import { SettingsService } from '../../src/modules/settings';
import {
  MockEmailProvider,
  MockPushProvider,
  setEmailProvider,
  setPushProvider,
} from '../../src/providers/notification';
import type { MockPaymentProvider } from '../../src/providers/payment';
import { API, createAdmin, resetState, startApp, stopApp, type Session } from '../helpers/harness';
import { freshProvider, payFully } from '../helpers/finance';
import { at, baseWorld, type Nurse } from '../helpers/world';

let app: Express;
let admin: Session;
let serviceId: string;
let nurse: Nurse;
let patient: Session;
let patient2: Session;
let D: string;
let mock: MockPaymentProvider;
let push: MockPushProvider;

beforeAll(async () => {
  app = await startApp();
});
afterAll(stopApp);
beforeEach(async () => {
  await resetState();
  mock = freshProvider();
  push = new MockPushProvider();
  setPushProvider(push);
  setEmailProvider(new MockEmailProvider());
  ({ admin, serviceId, nurse, patient, patient2, D } = await baseWorld(app));
});

const post = (s: Session, path: string, body: object = {}) =>
  request(app).post(`${API}${path}`).set(s.auth).send(body);
const get = (s: Session, path: string) => request(app).get(`${API}${path}`).set(s.auth);
const tok = (n: string) => `fcm-token-${n}-`.padEnd(40, 'x');
const reg = (who: Session, token: string, platform = 'ANDROID', extra: object = {}) =>
  post(who, '/devices', { token, platform, ...extra });

describe('device token registration', () => {
  it('registers, refreshes idempotently and never returns the full token', async () => {
    const a = await reg(patient, tok('a'), 'IOS', { appVersion: '1.2.0' });
    expect(a.status).toBe(201);
    expect(a.body.data).toMatchObject({
      created: true,
      platform: 'IOS',
      appVersion: '1.2.0',
      active: true,
    });
    expect(a.body.data.token).toBe(`…${tok('a').slice(-6)}`);
    expect(JSON.stringify(a.body)).not.toContain(tok('a'));
    const b = await reg(patient, tok('a'), 'IOS', { appVersion: '1.3.0' });
    expect(b.body.data).toMatchObject({ created: false, id: a.body.data.id, appVersion: '1.3.0' });
    expect(await DeviceToken.countDocuments()).toBe(1);
    const list = await get(patient, '/devices');
    expect(list.body.data).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(tok('a'));
  });

  it('concurrent duplicate registrations collapse into one row', async () => {
    const rs = await Promise.all(Array.from({ length: 6 }, () => reg(patient, tok('race'))));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(await DeviceToken.countDocuments({ token: tok('race') })).toBe(1);
  });

  it('validates the token and platform', async () => {
    expect((await reg(patient, 'short')).status).toBe(400);
    expect((await reg(patient, tok('a'), 'WINDOWS')).status).toBe(400);
    expect(
      (await post(patient, '/devices', { token: tok('a'), platform: 'IOS', userId: patient2.id }))
        .status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post(`${API}/devices`)
          .send({ token: tok('a'), platform: 'IOS' })
      ).status,
    ).toBe(401);
  });

  it('a token moves to the user who signed in on that device; the previous user stops receiving it', async () => {
    await reg(patient, tok('shared'));
    const moved = await reg(patient2, tok('shared'));
    expect(moved.status).toBe(201);
    expect((await get(patient, '/devices')).body.data).toHaveLength(0);
    expect((await get(patient2, '/devices')).body.data).toHaveLength(1);
    expect(await DeviceToken.countDocuments()).toBe(1);
  });

  it('users only ever see and change their own devices', async () => {
    const mine = await reg(patient, tok('mine'));
    const theirs = await reg(patient2, tok('theirs'));
    expect((await get(patient2, '/devices')).body.data.map((d: { id: string }) => d.id)).toEqual([
      theirs.body.data.id,
    ]);
    expect((await post(patient2, '/devices/unregister', { token: tok('mine') })).status).toBe(404);
    expect((await post(patient2, `/devices/${mine.body.data.id}/deactivate`)).status).toBe(404);
    expect((await DeviceToken.findOne({ token: tok('mine') }))!.active).toBe(true);
  });

  it('unregister / deactivate are idempotent and keep the row (inactive)', async () => {
    const d = await reg(patient, tok('x'));
    expect(
      (await post(patient, '/devices/unregister', { token: tok('x') })).body.data.changed,
    ).toBe(true);
    expect(
      (await post(patient, '/devices/unregister', { token: tok('x') })).body.data.changed,
    ).toBe(false);
    expect((await post(patient, `/devices/${d.body.data.id}/deactivate`)).body.data.changed).toBe(
      false,
    );
    expect((await DeviceToken.findOne({ token: tok('x') }))!.active).toBe(false);
    // re-registering re-activates
    expect((await reg(patient, tok('x'))).body.data.active).toBe(true);
  });

  it('caps active devices per user (oldest deactivated); all roles can register, finance approvers too', async () => {
    await SettingsService.set('devices.maxActivePerUser', 2);
    for (const n of ['1', '2', '3']) {
      await reg(nurse.session, tok(n));
      await new Promise((r) => setTimeout(r, 5));
    }
    const active = (await DeviceToken.find({ userId: nurse.session.id, active: true }).lean()).map(
      (d) => d.token,
    );
    expect(active.sort()).toEqual([tok('2'), tok('3')].sort());
    expect((await reg(admin, tok('adm'))).status).toBe(201);
    const approver = await createAdmin(app, 'FINANCE_APPROVER');
    expect((await reg(approver, tok('fin'))).status).toBe(201);
  });
});

describe('push delivery uses the registered devices', () => {
  const args = () => ({
    serviceId,
    nurseId: nurse.profileId,
    start: at(D, '08:00'),
    end: at(D, '12:00'),
  });

  it('sends to the active tokens with safe data only; devices of other users are never used', async () => {
    await reg(patient, tok('p1'), 'IOS');
    await reg(patient, tok('p2'), 'ANDROID');
    await reg(patient2, tok('other'));
    await payFully(app, mock, patient, args());
    await DeliveryService.processDue();
    const forPatient = push.sent.filter((m) => m.userId === patient.id);
    expect(forPatient.length).toBeGreaterThan(0);
    for (const m of forPatient) {
      expect(m.tokens.map((t) => t.token).sort()).toEqual([tok('p1'), tok('p2')].sort());
      expect(Object.keys(m.data ?? {}).sort()).toEqual(['notificationId', 'type']);
      expect(JSON.stringify(m)).not.toMatch(/Marina|insulin|notes/i);
    }
    expect(
      push.sent.some(
        (m) => m.tokens.some((t) => t.token === tok('other')) && m.userId === patient.id,
      ),
    ).toBe(false);
  });

  it('a user without any active device is SKIPPED (NO_DEVICE), not failed', async () => {
    await payFully(app, mock, patient, args());
    await DeliveryService.processDue();
    const d = await NotificationDelivery.find({ channel: 'PUSH', recipientId: patient.id });
    expect(d.length).toBeGreaterThan(0);
    expect(d.every((x) => x.status === 'SKIPPED' && x.skippedReason === 'NO_DEVICE')).toBe(true);
    expect(push.calls).toBe(0);
  });

  it('deactivated devices receive nothing; tokens the provider reports dead are deactivated', async () => {
    await reg(patient, tok('live'));
    await reg(patient, tok('dead'));
    await post(patient, '/devices/unregister', { token: tok('live') });
    const orig = push.send.bind(push);
    jest
      .spyOn(push, 'send')
      .mockImplementation(async (m) => ({ ...(await orig(m)), invalidTokens: [tok('dead')] }));
    await payFully(app, mock, patient, args());
    await DeliveryService.processDue();
    const sentTokens = push.sent
      .filter((m) => m.userId === patient.id)
      .flatMap((m) => m.tokens.map((t) => t.token));
    expect(sentTokens).not.toContain(tok('live'));
    expect((await DeviceToken.findOne({ token: tok('dead') }))!.active).toBe(false);
    expect(await Notification.countDocuments({ recipientId: patient.id })).toBeGreaterThan(0);
    jest.restoreAllMocks();
  });
});
