import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { env } from '../../src/config/env';
import { resetRateLimiters } from '../../src/common/middleware/rateLimit';
import { AuthService, RefreshToken } from '../../src/modules/auth';
import { NurseProfile } from '../../src/modules/nurses';
import { PatientProfile } from '../../src/modules/patients';
import { User } from '../../src/modules/users';
import {
  API,
  PASSWORD,
  outbox,
  register,
  resetState,
  startApp,
  stopApp,
  userInput,
} from '../helpers/harness';

let app: Express;
beforeAll(async () => {
  app = await startApp();
});
afterAll(stopApp);
beforeEach(resetState);

const post = (path: string, body?: object, headers: Record<string, string> = {}) =>
  request(app).post(`${API}${path}`).set(headers).send(body);

describe('register', () => {
  it('creates a patient + empty profile atomically and never leaks secrets', async () => {
    const body = userInput('PATIENT');
    const res = await post('/auth/register', body);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ success: true, message: 'Registered' });
    expect(res.body.data.user).toMatchObject({
      email: body.email,
      role: 'PATIENT',
      isVerified: false,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
    expect(res.body.data.tokens).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
    expect(await PatientProfile.countDocuments({ userId: res.body.data.user.id })).toBe(1);
  });

  it('creates a nurse with PENDING/PENDING, non-bookable profile', async () => {
    const res = await post('/auth/register', userInput('NURSE'));
    const nurse = await NurseProfile.findOne({ userId: res.body.data.user.id });
    expect(nurse).toMatchObject({
      status: 'PENDING',
      verificationStatus: 'PENDING',
      isBookable: false,
    });
  });

  it('stores only a bcrypt hash', async () => {
    const body = userInput('PATIENT');
    await post('/auth/register', body);
    const u = await User.findOne({ email: body.email }).select('+passwordHash');
    expect(u?.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(u?.passwordHash).not.toContain(PASSWORD);
  });

  it('cannot self-register as ADMIN or inject unknown fields', async () => {
    expect((await post('/auth/register', userInput('PATIENT', { role: 'ADMIN' }))).status).toBe(
      400,
    );
    const res = await post(
      '/auth/register',
      userInput('PATIENT', { isActive: false, isVerified: true }),
    );
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('rejects weak passwords and bad phone/email', async () => {
    const res = await post(
      '/auth/register',
      userInput('PATIENT', { password: 'short', phone: '0501234567', email: 'nope' }),
    );
    expect(res.status).toBe(400);
    const fields = res.body.details.map((d: { field: string }) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['body.password', 'body.phone', 'body.email']));
  });

  it('409 on duplicate email / phone and leaves no orphan rows (transaction rollback)', async () => {
    const first = userInput('PATIENT');
    await post('/auth/register', first);
    const dupEmail = await post(
      '/auth/register',
      userInput('PATIENT', { email: first.email.toUpperCase() }),
    );
    expect(dupEmail.status).toBe(409);
    expect(dupEmail.body.errorCode).toBe('EMAIL_TAKEN');
    const dupPhone = await post('/auth/register', userInput('NURSE', { phone: first.phone }));
    expect(dupPhone.body.errorCode).toBe('PHONE_TAKEN');
    expect(await User.countDocuments()).toBe(1);
    expect(await PatientProfile.countDocuments()).toBe(1);
    expect(await NurseProfile.countDocuments()).toBe(0);
  });
});

describe('login', () => {
  it('logs in and updates lastLoginAt', async () => {
    const s = await register(app, 'PATIENT');
    const res = await post('/auth/login', { email: s.email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.tokens.accessToken).toBeTruthy();
    expect((await User.findById(s.id))?.lastLoginAt).toBeInstanceOf(Date);
  });

  it('uses the same generic error for wrong password and unknown email', async () => {
    const s = await register(app, 'PATIENT');
    const wrong = await post('/auth/login', { email: s.email, password: 'Wrong-Password1' });
    const unknown = await post('/auth/login', {
      email: 'ghost@example.test',
      password: 'Wrong-Password1',
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.errorCode).toBe('INVALID_CREDENTIALS');
  });

  it('locks the account after 5 failures (423), even with the right password', async () => {
    const s = await register(app, 'PATIENT');
    for (let i = 0; i < 5; i++) {
      resetRateLimiters(); // isolate account lockout from the IP rate limiter
      await post('/auth/login', { email: s.email, password: 'Wrong-Password1' });
    }
    resetRateLimiters();
    const res = await post('/auth/login', { email: s.email, password: PASSWORD });
    expect(res.status).toBe(423);
    expect(res.body.errorCode).toBe('ACCOUNT_LOCKED');
  });

  it('rate-limits repeated login attempts (429)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++)
      statuses.push(
        (await post('/auth/login', { email: 'x@example.test', password: 'Wrong-Password1' }))
          .status,
      );
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
  });

  it('refuses disabled accounts', async () => {
    const s = await register(app, 'PATIENT');
    await User.updateOne({ _id: s.id }, { isActive: false });
    const res = await post('/auth/login', { email: s.email, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.errorCode).toBe('ACCOUNT_DISABLED');
  });
});

describe('refresh token rotation', () => {
  it('rotates: new pair works, old refresh token is reuse', async () => {
    const s = await register(app, 'PATIENT');
    const r1 = await post('/auth/refresh', { refreshToken: s.refreshToken });
    expect(r1.status).toBe(200);
    const newRefresh = r1.body.data.refreshToken;
    expect(newRefresh).not.toBe(s.refreshToken);
    expect(
      (
        await request(app)
          .get(`${API}/users/me`)
          .set('Authorization', `Bearer ${r1.body.data.accessToken}`)
      ).status,
    ).toBe(200);

    // Reuse of the rotated token => 401 and the whole family (including the new token) is revoked
    const reuse = await post('/auth/refresh', { refreshToken: s.refreshToken });
    expect(reuse.status).toBe(401);
    expect(reuse.body.errorCode).toBe('REFRESH_TOKEN_REUSED');
    const after = await post('/auth/refresh', { refreshToken: newRefresh });
    expect(after.status).toBe(401);
    expect(await RefreshToken.countDocuments({ revokedAt: { $exists: false } })).toBe(0);
  });

  it('only one of two concurrent refreshes with the same token succeeds', async () => {
    const s = await register(app, 'PATIENT');
    const results = await Promise.all([
      post('/auth/refresh', { refreshToken: s.refreshToken }),
      post('/auth/refresh', { refreshToken: s.refreshToken }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it('stores only hashes of refresh tokens', async () => {
    const s = await register(app, 'PATIENT');
    expect(await RefreshToken.countDocuments({ tokenHash: s.refreshToken })).toBe(0);
    expect(await RefreshToken.countDocuments()).toBe(1);
  });

  it('rejects garbage and expired refresh tokens', async () => {
    expect((await post('/auth/refresh', { refreshToken: 'x'.repeat(60) })).body.errorCode).toBe(
      'INVALID_REFRESH_TOKEN',
    );
    const s = await register(app, 'PATIENT');
    await RefreshToken.updateOne({}, { expiresAt: new Date(Date.now() - 1000) });
    expect((await post('/auth/refresh', { refreshToken: s.refreshToken })).status).toBe(401);
  });

  it('logout revokes the session family and is idempotent', async () => {
    const s = await register(app, 'PATIENT');
    const refreshed = await post('/auth/refresh', { refreshToken: s.refreshToken });
    const current = refreshed.body.data.refreshToken;
    expect((await post('/auth/logout', { refreshToken: current })).status).toBe(200);
    expect((await post('/auth/logout', { refreshToken: current })).status).toBe(200);
    expect((await post('/auth/logout', { refreshToken: 'unknown'.repeat(5) })).status).toBe(200);
    const res = await post('/auth/refresh', { refreshToken: current });
    expect(res.status).toBe(401);
    expect(res.body.errorCode).toBe('INVALID_REFRESH_TOKEN');
  });
});

describe('access token (RS256)', () => {
  it('is signed RS256 with iss/aud/sub/role', async () => {
    const s = await register(app, 'NURSE');
    const decoded = jwt.decode(s.accessToken, { complete: true })!;
    expect(decoded.header.alg).toBe('RS256');
    expect(decoded.payload).toMatchObject({
      sub: s.id,
      role: 'NURSE',
      iss: env.jwt.issuer,
      aud: env.jwt.audience,
    });
  });

  it('rejects tampered, unsigned (alg=none), HS256-forged and expired tokens', async () => {
    const s = await register(app, 'PATIENT');
    const get = (t: string) =>
      request(app).get(`${API}/users/me`).set('Authorization', `Bearer ${t}`);
    const [h, p, sig] = s.accessToken.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ sub: s.id, role: 'ADMIN', pv: 0 })).toString(
      'base64url',
    );
    expect((await get(`${h}.${forgedPayload}.${sig}`)).status).toBe(401);
    expect((await get(`${Buffer.from('{"alg":"none"}').toString('base64url')}.${p}.`)).status).toBe(
      401,
    );
    const hs = jwt.sign({ role: 'ADMIN', pv: 0 }, env.jwt.publicKey as string, {
      algorithm: 'HS256',
      subject: s.id,
      issuer: env.jwt.issuer,
      audience: env.jwt.audience,
    });
    expect((await get(hs)).status).toBe(401);
    const expired = jwt.sign({ role: 'PATIENT', pv: 0 }, env.jwt.privateKey as string, {
      algorithm: 'RS256',
      subject: s.id,
      issuer: env.jwt.issuer,
      audience: env.jwt.audience,
      expiresIn: -10,
    });
    const res = await get(expired);
    expect(res.status).toBe(401);
    expect(res.body.errorCode).toBe('TOKEN_EXPIRED');
    const wrongAud = jwt.sign({ role: 'PATIENT', pv: 0 }, env.jwt.privateKey as string, {
      algorithm: 'RS256',
      subject: s.id,
      issuer: env.jwt.issuer,
      audience: 'someone-else',
    });
    expect((await get(wrongAud)).status).toBe(401);
  });
});

describe('password flows', () => {
  it('forgot-password responds identically for known and unknown emails', async () => {
    const s = await register(app, 'PATIENT');
    const known = await post('/auth/forgot-password', { email: s.email });
    const unknown = await post('/auth/forgot-password', { email: 'ghost@example.test' });
    expect(known.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
    expect(outbox().last('PASSWORD_RESET', s.email)).toBeDefined();
    expect(outbox().last('PASSWORD_RESET', 'ghost@example.test')).toBeUndefined();
  });

  it('reset-password: single-use token, revokes sessions, new password works', async () => {
    const s = await register(app, 'PATIENT');
    await post('/auth/forgot-password', { email: s.email });
    const token = outbox().last('PASSWORD_RESET', s.email)!.body.split(': ')[1]!;
    const newPassword = 'An0therStrongOne';
    expect((await post('/auth/reset-password', { token, newPassword })).status).toBe(200);
    const again = await post('/auth/reset-password', { token, newPassword: 'Yet4notherStrong' });
    expect(again.status).toBe(400);
    expect(again.body.errorCode).toBe('INVALID_OR_EXPIRED_TOKEN');
    expect((await post('/auth/refresh', { refreshToken: s.refreshToken })).status).toBe(401);
    expect((await post('/auth/login', { email: s.email, password: PASSWORD })).status).toBe(401);
    resetRateLimiters();
    expect((await post('/auth/login', { email: s.email, password: newPassword })).status).toBe(200);
    // Old access token dies with the password change
    expect((await request(app).get(`${API}/users/me`).set(s.auth)).body.errorCode).toBe(
      'TOKEN_REVOKED',
    );
  });

  it('reset-password rejects unknown tokens', async () => {
    const res = await post('/auth/reset-password', {
      token: 'a'.repeat(43),
      newPassword: 'An0therStrongOne',
    });
    expect(res.status).toBe(400);
  });

  it('change-password: needs current password, revokes old sessions, returns new tokens', async () => {
    const s = await register(app, 'PATIENT');
    const bad = await post(
      '/auth/change-password',
      { currentPassword: 'Nope-Password1', newPassword: 'An0therStrongOne' },
      s.auth,
    );
    expect(bad.body.errorCode).toBe('INVALID_CURRENT_PASSWORD');
    const same = await post(
      '/auth/change-password',
      { currentPassword: PASSWORD, newPassword: PASSWORD },
      s.auth,
    );
    expect(same.status).toBe(400);

    const ok = await post(
      '/auth/change-password',
      { currentPassword: PASSWORD, newPassword: 'An0therStrongOne' },
      s.auth,
    );
    expect(ok.status).toBe(200);
    const fresh = ok.body.data;
    expect((await request(app).get(`${API}/users/me`).set(s.auth)).status).toBe(401);
    expect(
      (
        await request(app)
          .get(`${API}/users/me`)
          .set('Authorization', `Bearer ${fresh.accessToken}`)
      ).status,
    ).toBe(200);
    expect((await post('/auth/refresh', { refreshToken: s.refreshToken })).status).toBe(401);
    expect((await post('/auth/refresh', { refreshToken: fresh.refreshToken })).status).toBe(200);
  });
});

describe('verification', () => {
  it('verifies email via token (single use) and phone via OTP; isVerified needs both', async () => {
    const s = await register(app, 'PATIENT');
    const emailToken = outbox().last('EMAIL_VERIFY', s.email)!.body.split(': ')[1]!;
    expect((await post('/auth/verify-email', { token: emailToken })).status).toBe(200);
    expect((await post('/auth/verify-email', { token: emailToken })).status).toBe(400);
    expect((await User.findById(s.id))?.isVerified).toBe(false);

    const phone = (await User.findById(s.id))!.phone;
    const otp = outbox().last('PHONE_OTP', phone)!.body.match(/\d{6}/)![0];
    const wrong = await post(
      '/auth/verify-phone',
      { otp: otp === '000000' ? '111111' : '000000' },
      s.auth,
    );
    expect(wrong.body.errorCode).toBe('INVALID_OTP');
    expect((await post('/auth/verify-phone', { otp }, s.auth)).status).toBe(200);
    const user = await User.findById(s.id);
    expect(user?.isVerified).toBe(true);
    expect((await post('/auth/verify-phone', { otp }, s.auth)).body.errorCode).toBe('OTP_EXPIRED');
  });

  it('locks OTP after too many wrong attempts', async () => {
    const s = await register(app, 'PATIENT');
    const phone = (await User.findById(s.id))!.phone;
    const otp = outbox().last('PHONE_OTP', phone)!.body.match(/\d{6}/)![0]!;
    const bad = otp === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await post('/auth/verify-phone', { otp: bad }, s.auth);
    const res = await post('/auth/verify-phone', { otp }, s.auth);
    expect(res.body.errorCode).toBe('OTP_ATTEMPTS_EXCEEDED');
  });

  it('caps OTP guesses even when they arrive concurrently', async () => {
    const s = await register(app, 'PATIENT');
    const phone = (await User.findById(s.id))!.phone;
    const otp = outbox().last('PHONE_OTP', phone)!.body.match(/\d{6}/)![0]!;
    const bad = otp === '000000' ? '111111' : '000000';
    // Called at the service level so all 8 guesses read the stored code before any of them records an
    // attempt (over HTTP, auth round-trips spread the requests out and hide the race).
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => AuthService.verifyPhone(s.id, bad)),
    );
    const codes = results.map((r) =>
      r.status === 'rejected' ? (r.reason as { errorCode?: string }).errorCode : 'OK',
    );
    expect(codes.filter((c) => c === 'INVALID_OTP')).toHaveLength(5);
    // the rest are refused: over the cap, or the code was already discarded by the request that hit it
    expect(
      codes.filter((c) => c === 'OTP_ATTEMPTS_EXCEEDED' || c === 'OTP_EXPIRED'),
    ).toHaveLength(3);
    const res = await post('/auth/verify-phone', { otp }, s.auth);
    expect(res.body.errorCode).toBe('OTP_EXPIRED');
    expect((await User.findById(s.id))?.phoneVerifiedAt).toBeFalsy();
  });

  it('verify-phone requires authentication', async () => {
    expect((await post('/auth/verify-phone', { otp: '123456' })).status).toBe(401);
  });
});
