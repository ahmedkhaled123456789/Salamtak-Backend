import type { Express } from 'express';
import request from 'supertest';
import { AuditLog } from '../../src/modules/audit';
import { NurseProfile } from '../../src/modules/nurses';
import {
  API,
  createAdmin,
  register,
  resetState,
  startApp,
  stopApp,
  type Session,
} from '../helpers/harness';

let app: Express;
let admin: Session;
beforeAll(async () => {
  app = await startApp();
});
afterAll(stopApp);
beforeEach(async () => {
  await resetState();
  admin = await createAdmin(app);
});

const nurseProfileId = async (userId: string) =>
  String((await NurseProfile.findOne({ userId }))!._id);
const patch = (path: string, body: object) =>
  request(app).patch(`${API}${path}`).set(admin.auth).send(body);
const get = (path: string) => request(app).get(`${API}${path}`).set(admin.auth);

describe('admin lists', () => {
  it('paginates users with meta, filters by role and search', async () => {
    for (let i = 0; i < 4; i++) await register(app, 'PATIENT');
    await register(app, 'NURSE');
    const page1 = await get('/admin/users?page=1&limit=2');
    expect(page1.body.data.items).toHaveLength(2);
    expect(page1.body.data.meta).toEqual({ page: 1, limit: 2, total: 6, totalPages: 3 });
    expect(JSON.stringify(page1.body)).not.toMatch(/passwordHash/);

    const nurses = await get('/admin/users?role=NURSE');
    expect(nurses.body.data.meta.total).toBe(1);
    const search = await get(`/admin/users?search=${encodeURIComponent('.*')}`);
    expect(search.body.data.meta.total).toBe(0); // regex metacharacters are escaped
    expect((await get('/admin/users?limit=1000')).status).toBe(400);
    expect((await get('/admin/users?page=0')).status).toBe(400);
  });

  it('lists nurse profiles with user info and filters', async () => {
    const n = await register(app, 'NURSE', { firstName: 'Layla' });
    const res = await get('/admin/nurses?verificationStatus=PENDING');
    expect(res.body.data.meta.total).toBe(1);
    expect(res.body.data.items[0].userId).toMatchObject({ firstName: 'Layla', email: n.email });
    expect((await get('/admin/nurses?verificationStatus=VERIFIED')).body.data.meta.total).toBe(0);
    expect((await get('/admin/nurses?status=BOGUS')).status).toBe(400);
  });
});

describe('nurse verification & suspension', () => {
  it('VERIFIED activates a pending nurse and makes them bookable; audit-logged', async () => {
    const n = await register(app, 'NURSE');
    const id = await nurseProfileId(n.id);
    const res = await patch(`/admin/nurses/${id}/verify`, { decision: 'VERIFIED' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      verificationStatus: 'VERIFIED',
      status: 'ACTIVE',
      isBookable: true,
    });

    const log = await AuditLog.findOne({ action: 'nurse.verification_changed' }).lean();
    expect(log).toMatchObject({
      actorRole: 'ADMIN',
      entity: 'NurseProfile',
      oldData: { verificationStatus: 'PENDING', status: 'PENDING' },
      newData: { verificationStatus: 'VERIFIED', status: 'ACTIVE' },
    });
    expect(String(log!.actorId)).toBe(admin.id);
  });

  it('REJECTED requires a reason and keeps the nurse non-bookable', async () => {
    const n = await register(app, 'NURSE');
    const id = await nurseProfileId(n.id);
    const bad = await patch(`/admin/nurses/${id}/verify`, { decision: 'REJECTED' });
    expect(bad.body.errorCode).toBe('REASON_REQUIRED');
    const ok = await patch(`/admin/nurses/${id}/verify`, {
      decision: 'REJECTED',
      reason: 'License unreadable',
    });
    expect(ok.body.data).toMatchObject({
      verificationStatus: 'REJECTED',
      isBookable: false,
      statusReason: 'License unreadable',
    });
  });

  it('suspend -> not bookable, nurse cannot self-reactivate; reactivate restores', async () => {
    const n = await register(app, 'NURSE');
    const id = await nurseProfileId(n.id);
    await patch(`/admin/nurses/${id}/verify`, { decision: 'VERIFIED' });

    expect((await patch(`/admin/nurses/${id}/suspend`, {})).status).toBe(400);
    const sus = await patch(`/admin/nurses/${id}/suspend`, { reason: 'Patient complaint #123' });
    expect(sus.body.data).toMatchObject({ status: 'SUSPENDED', isBookable: false });
    expect((await patch(`/admin/nurses/${id}/suspend`, { reason: 'again again' })).status).toBe(
      409,
    );

    const self = await request(app)
      .patch(`${API}/nurses/me/status`)
      .set(n.auth)
      .send({ status: 'ACTIVE' });
    expect(self.status).toBe(409);
    expect((await NurseProfile.findById(id))?.isBookable).toBe(false);

    const re = await patch(`/admin/nurses/${id}/reactivate`, {});
    expect(re.body.data).toMatchObject({ status: 'ACTIVE', isBookable: true });
    expect((await patch(`/admin/nurses/${id}/reactivate`, {})).status).toBe(409);
    expect(
      await AuditLog.countDocuments({ action: { $in: ['nurse.suspended', 'nurse.reactivated'] } }),
    ).toBe(2);
  });

  it('a verified nurse can pause/resume themselves; isBookable follows', async () => {
    const n = await register(app, 'NURSE');
    const id = await nurseProfileId(n.id);
    await patch(`/admin/nurses/${id}/verify`, { decision: 'VERIFIED' });
    const off = await request(app)
      .patch(`${API}/nurses/me/status`)
      .set(n.auth)
      .send({ status: 'INACTIVE' });
    expect(off.body.data).toMatchObject({ status: 'INACTIVE', isBookable: false });
    const on = await request(app)
      .patch(`${API}/nurses/me/status`)
      .set(n.auth)
      .send({ status: 'ACTIVE' });
    expect(on.body.data).toMatchObject({ status: 'ACTIVE', isBookable: true });
  });

  it('expiring verification (EXPIRED) is not exposed via admin verify; unknown id is 404', async () => {
    expect(
      (await patch('/admin/nurses/64b7f0f0f0f0f0f0f0f0f0f0/verify', { decision: 'VERIFIED' }))
        .status,
    ).toBe(404);
    expect((await patch('/admin/nurses/not-an-id/verify', { decision: 'VERIFIED' })).status).toBe(
      400,
    );
    const n = await register(app, 'NURSE');
    const id = await nurseProfileId(n.id);
    expect((await patch(`/admin/nurses/${id}/verify`, { decision: 'EXPIRED' })).status).toBe(400);
  });
});

describe('user blocking', () => {
  it('admins cannot block themselves or other admins', async () => {
    const other = await createAdmin(app);
    expect(
      (await patch(`/admin/users/${admin.id}/block`, { blocked: true, reason: 'oops' })).body
        .errorCode,
    ).toBe('CANNOT_BLOCK_SELF');
    expect(
      (await patch(`/admin/users/${other.id}/block`, { blocked: true, reason: 'oops' })).body
        .errorCode,
    ).toBe('CANNOT_BLOCK_ADMIN');
  });

  it('writes an audit entry without sensitive fields', async () => {
    const p = await register(app, 'PATIENT');
    await patch(`/admin/users/${p.id}/block`, { blocked: true, reason: 'spam account' });
    const log = await AuditLog.findOne({ action: 'user.blocked' }).lean();
    expect(log).toMatchObject({
      entity: 'User',
      newData: { isActive: false, reason: 'spam account' },
    });
    expect(JSON.stringify(log)).not.toMatch(/password|token/i);
  });
});

describe('dashboard & audit logs', () => {
  it('returns counts, supports date filtering', async () => {
    await register(app, 'PATIENT');
    await register(app, 'PATIENT');
    const n = await register(app, 'NURSE');
    await patch(`/admin/nurses/${await nurseProfileId(n.id)}/verify`, { decision: 'VERIFIED' });
    await register(app, 'NURSE');

    const res = await get('/admin/dashboard');
    expect(res.body.data).toEqual({
      totalUsers: 5, // 2 patients + 2 nurses + the admin
      totalPatients: 2,
      totalNurses: 2,
      verifiedNurses: 1,
      pendingNurses: 1,
      suspendedNurses: 0,
    });
    const future = await get(
      `/admin/dashboard?from=${new Date(Date.now() + 86_400_000).toISOString()}`,
    );
    expect(future.body.data.totalUsers).toBe(0);
  });

  it('lists audit logs newest first with filters', async () => {
    const n = await register(app, 'NURSE');
    const id = await nurseProfileId(n.id);
    await patch(`/admin/nurses/${id}/verify`, { decision: 'UNDER_REVIEW' });
    await patch(`/admin/nurses/${id}/verify`, { decision: 'VERIFIED' });
    const res = await get(`/admin/audit-logs?entityId=${id}`);
    expect(res.body.data.meta.total).toBe(2);
    expect(res.body.data.items[0].newData.verificationStatus).toBe('VERIFIED');
  });

  it('audit log collection is append-only', async () => {
    await AuditLog.create({ action: 'x', entity: 'Y' });
    await expect(AuditLog.updateOne({}, { action: 'z' })).rejects.toThrow(/append-only/);
    await expect(AuditLog.deleteMany({})).rejects.toThrow(/append-only/);
  });
});
