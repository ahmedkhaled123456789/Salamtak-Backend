import type { Express } from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { assertReplicaSet, withTransaction } from '../../src/config/database';
import { NurseProfile } from '../../src/modules/nurses';
import { User } from '../../src/modules/users';
import { API, register, resetState, startApp, stopApp } from '../helpers/harness';

let app: Express;
beforeAll(async () => {
  app = await startApp();
});
afterAll(stopApp);
beforeEach(resetState);

describe('http envelope & hardening', () => {
  it('wraps errors and unknown routes in the standard envelope', async () => {
    const res = await request(app).get(`${API}/nope`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      message: expect.any(String),
      errorCode: 'ROUTE_NOT_FOUND',
    });
  });

  it('returns 400 INVALID_JSON for malformed bodies and 413 for oversized bodies', async () => {
    const bad = await request(app)
      .post(`${API}/auth/login`)
      .set('Content-Type', 'application/json')
      .send('{oops');
    expect(bad.status).toBe(400);
    expect(bad.body.errorCode).toBe('INVALID_JSON');
    const big = await request(app)
      .post(`${API}/auth/login`)
      .send({ email: 'a@b.co', password: 'x'.repeat(200_000) });
    expect(big.status).toBe(413);
  });

  it('sets security headers, hides x-powered-by, echoes a request id', async () => {
    const res = await request(app).get('/health').set('x-request-id', 'req-123');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-request-id']).toBe('req-123');
  });

  it('only allows configured CORS origins', async () => {
    const ok = await request(app).get('/health').set('Origin', 'http://localhost:3000');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    const bad = await request(app).get('/health').set('Origin', 'http://evil.example');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('never exposes internals on server errors', async () => {
    const spy = jest.spyOn(User, 'findOne').mockImplementation(() => {
      throw new Error('mongo exploded: secret-connection-string');
    });
    const res = await request(app)
      .post(`${API}/auth/login`)
      .send({ email: 'a@b.co', password: 'x' });
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      success: false,
      errorCode: 'INTERNAL_ERROR',
      message: 'Something went wrong',
    });
    expect(JSON.stringify(res.body)).not.toContain('secret-connection-string');
  });
});

describe('health', () => {
  it('liveness and readiness (mongo + redis)', async () => {
    expect((await request(app).get('/health')).status).toBe(200);
    const ready = await request(app).get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.data).toEqual({ mongo: true, redis: true });
  });
});

describe('MongoDB replica set, transactions and indexes', () => {
  it('runs on a replica set', async () => {
    await expect(assertReplicaSet()).resolves.toBeUndefined();
  });

  it('transactions roll back atomically', async () => {
    await expect(
      withTransaction(async (session) => {
        await User.create(
          [
            {
              firstName: 'a',
              lastName: 'b',
              email: 'tx@example.test',
              phone: '+971501111111',
              passwordHash: 'x',
              role: 'PATIENT',
            },
          ],
          { session },
        );
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await User.countDocuments({ email: 'tx@example.test' })).toBe(0);
  });

  it('creates the declared indexes (unique email/phone, 2dsphere, compound)', async () => {
    const idx = async (name: string) => mongoose.connection.collection(name).indexes();
    const users = await idx('users');
    expect(users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: { email: 1 }, unique: true }),
        expect.objectContaining({ key: { phone: 1 }, unique: true }),
        expect.objectContaining({ key: { role: 1, isActive: 1 } }),
      ]),
    );
    const nurses = await idx('nurseProfiles');
    expect(nurses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: { location: '2dsphere' } }),
        expect.objectContaining({ key: { userId: 1 }, unique: true }),
        expect.objectContaining({ key: { status: 1 } }),
        expect.objectContaining({ key: { verificationStatus: 1 } }),
        expect.objectContaining({ key: { specializations: 1 } }),
        expect.objectContaining({ key: { averageRating: -1 } }),
      ]),
    );
    const refresh = await idx('refreshTokens');
    expect(refresh).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: { tokenHash: 1 }, unique: true }),
        expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }),
      ]),
    );
  });

  it('enforces unique email at the database level (race-safe)', async () => {
    const mk = () =>
      User.create({
        firstName: 'a',
        lastName: 'b',
        email: 'race@example.test',
        phone: `+97150${Math.floor(1e6 + Math.random() * 8e6)}`,
        passwordHash: 'x',
        role: 'PATIENT',
      });
    const results = await Promise.allSettled([mk(), mk(), mk()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('geospatial query works on nurse locations', async () => {
    const n = await register(app, 'NURSE');
    await request(app)
      .patch(`${API}/nurses/me`)
      .set(n.auth)
      .send({ location: { latitude: 25.2, longitude: 55.27 } });
    const near = await NurseProfile.find({
      location: {
        $near: { $geometry: { type: 'Point', coordinates: [55.27, 25.2] }, $maxDistance: 1000 },
      },
    });
    expect(near).toHaveLength(1);
  });

  it('rejects non-integer money at the schema level', async () => {
    const n = await register(app, 'NURSE');
    await expect(
      NurseProfile.updateOne({ userId: n.id }, { dailyRateMinor: 10.5 }, { runValidators: true }),
    ).rejects.toThrow(/minor units/);
  });
});

describe('swagger', () => {
  it('serves OpenAPI JSON with auth, roles, pagination and error docs', async () => {
    const res = await request(app).get('/docs.json');
    expect(res.status).toBe(200);
    const doc = res.body;
    expect(doc.openapi).toMatch(/^3\.1/);
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    const paths = Object.keys(doc.paths);
    for (const p of [
      '/api/v1/auth/register',
      '/api/v1/auth/login',
      '/api/v1/auth/refresh',
      '/api/v1/auth/logout',
      '/api/v1/auth/forgot-password',
      '/api/v1/auth/reset-password',
      '/api/v1/auth/change-password',
      '/api/v1/auth/verify-email',
      '/api/v1/auth/verify-phone',
      '/api/v1/users/me',
      '/api/v1/patients/me',
      '/api/v1/nurses/me',
      '/api/v1/admin/dashboard',
      '/api/v1/admin/users',
      '/api/v1/admin/nurses',
      '/api/v1/admin/nurses/{id}/verify',
      '/api/v1/admin/nurses/{id}/suspend',
    ])
      expect(paths).toContain(p);
    const list = doc.paths['/api/v1/admin/users'].get;
    expect(list.security).toEqual([{ bearerAuth: [] }]);
    expect(list.description).toContain('ADMIN');
    expect(list.parameters.map((x: { name: string }) => x.name)).toEqual(
      expect.arrayContaining(['page', 'limit']),
    );
    expect(Object.keys(list.responses)).toEqual(
      expect.arrayContaining(['200', '400', '401', '403']),
    );
    expect(doc.paths['/api/v1/auth/login'].post.security).toEqual([]);
  });

  it('serves the Swagger UI', async () => {
    const res = await request(app).get('/docs/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('swagger-ui');
  });
});
