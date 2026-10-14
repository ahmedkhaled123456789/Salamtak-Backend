import type { Express } from 'express';
import request from 'supertest';
import { User } from '../../src/modules/users';
import {
  API,
  PASSWORD,
  createAdmin,
  register,
  resetState,
  startApp,
  stopApp,
} from '../helpers/harness';

let app: Express;
beforeAll(async () => {
  app = await startApp();
});
afterAll(stopApp);
beforeEach(resetState);

const objectId = '64b7f0f0f0f0f0f0f0f0f0f0';
const adminRoutes: [string, string][] = [
  ['get', '/admin/dashboard'],
  ['get', '/admin/users'],
  ['get', '/admin/nurses'],
  ['get', '/admin/audit-logs'],
  ['patch', `/admin/nurses/${objectId}/verify`],
  ['patch', `/admin/nurses/${objectId}/suspend`],
  ['patch', `/admin/nurses/${objectId}/reactivate`],
  ['patch', `/admin/users/${objectId}/block`],
];
const protectedRoutes: [string, string][] = [
  ['get', '/users/me'],
  ['patch', '/users/me'],
  ['get', '/patients/me'],
  ['patch', '/patients/me'],
  ['get', '/nurses/me'],
  ['patch', '/nurses/me'],
  ['patch', '/nurses/me/status'],
  ['post', '/auth/change-password'],
  ['post', '/auth/verify-phone'],
  ['post', '/auth/resend-verification'],
  ...adminRoutes,
];

const call = (method: string, path: string, headers: Record<string, string> = {}) =>
  (request(app) as unknown as Record<string, (p: string) => request.Test>)[method]!(`${API}${path}`)
    .set(headers)
    .send({});

describe('authentication required', () => {
  it.each(protectedRoutes)('%s %s -> 401 without a token', async (method, path) => {
    const res = await call(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false, errorCode: 'UNAUTHORIZED' });
  });

  it('rejects malformed Authorization headers', async () => {
    expect((await call('get', '/users/me', { Authorization: 'Basic abc' })).status).toBe(401);
    expect((await call('get', '/users/me', { Authorization: 'Bearer not.a.jwt' })).status).toBe(
      401,
    );
  });
});

describe('role-based access', () => {
  it.each(adminRoutes)('patient and nurse get 403 on %s %s', async (method, path) => {
    const patient = await register(app, 'PATIENT');
    const nurse = await register(app, 'NURSE');
    expect((await call(method, path, patient.auth)).status).toBe(403);
    expect((await call(method, path, nurse.auth)).status).toBe(403);
  });

  it('patient cannot use nurse endpoints and vice versa', async () => {
    const patient = await register(app, 'PATIENT');
    const nurse = await register(app, 'NURSE');
    expect((await call('get', '/nurses/me', patient.auth)).status).toBe(403);
    expect((await call('patch', '/nurses/me/status', patient.auth)).status).toBe(403);
    expect((await call('get', '/patients/me', nurse.auth)).status).toBe(403);
    expect((await call('patch', '/patients/me', nurse.auth)).status).toBe(403);
    expect((await call('get', '/patients/me', patient.auth)).status).toBe(200);
    expect((await call('get', '/nurses/me', nurse.auth)).status).toBe(200);
  });

  it('admin can reach admin endpoints but has no patient/nurse profile', async () => {
    const admin = await createAdmin(app);
    expect((await call('get', '/admin/dashboard', admin.auth)).status).toBe(200);
    expect((await call('get', '/users/me', admin.auth)).status).toBe(200);
    expect((await call('get', '/patients/me', admin.auth)).status).toBe(403);
    expect((await call('get', '/nurses/me', admin.auth)).status).toBe(403);
  });

  it('a user can only ever read their own account (no id in path)', async () => {
    const a = await register(app, 'PATIENT');
    const b = await register(app, 'PATIENT');
    const res = await call('get', '/users/me', a.auth);
    expect(res.body.data.id).toBe(a.id);
    expect(res.body.data.id).not.toBe(b.id);
  });
});

describe('account state is enforced on every request', () => {
  it('blocked users are rejected immediately even with a valid access token', async () => {
    const admin = await createAdmin(app);
    const victim = await register(app, 'PATIENT');
    expect((await call('get', '/users/me', victim.auth)).status).toBe(200);

    const block = await request(app)
      .patch(`${API}/admin/users/${victim.id}/block`)
      .set(admin.auth)
      .send({ blocked: true, reason: 'fraud suspicion' });
    expect(block.status).toBe(200);

    const res = await call('get', '/users/me', victim.auth);
    expect(res.status).toBe(403);
    expect(res.body.errorCode).toBe('ACCOUNT_DISABLED');
    expect(
      (await request(app).post(`${API}/auth/refresh`).send({ refreshToken: victim.refreshToken }))
        .status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post(`${API}/auth/login`)
          .send({ email: victim.email, password: PASSWORD })
      ).status,
    ).toBe(403);

    await request(app)
      .patch(`${API}/admin/users/${victim.id}/block`)
      .set(admin.auth)
      .send({ blocked: false });
    expect((await User.findById(victim.id))?.isActive).toBe(true);
  });

  it('role changes in the DB take effect without waiting for token expiry', async () => {
    const s = await register(app, 'PATIENT');
    await User.updateOne({ _id: s.id }, { role: 'NURSE' });
    // token still says PATIENT; the DB role wins
    expect((await call('get', '/patients/me', s.auth)).status).toBe(403);
  });
});

describe('injection hardening', () => {
  it('rejects NoSQL operator payloads on login', async () => {
    const res = await request(app)
      .post(`${API}/auth/login`)
      .send({ email: { $gt: '' }, password: { $gt: '' } });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe('INVALID_INPUT');
  });

  it('rejects operator keys in the query string', async () => {
    const admin = await createAdmin(app);
    const res = await request(app).get(`${API}/admin/users?role[$ne]=ADMIN`).set(admin.auth);
    expect(res.status).toBe(400);
  });

  it('rejects prototype-pollution keys', async () => {
    const res = await request(app)
      .post(`${API}/auth/login`)
      .set('Content-Type', 'application/json')
      .send('{"__proto__":{"admin":true},"email":"a@b.co","password":"x"}');
    expect(res.status).toBe(400);
  });
});
