import type { Express } from 'express';
import request from 'supertest';
import { AdminAlert } from '../../src/modules/alerts';
import { AuditLog } from '../../src/modules/audit';
import { FileObject } from '../../src/modules/files';
import { Notification } from '../../src/modules/notifications';
import { NurseDocument, VerificationService } from '../../src/modules/nurse-verification';
import { NurseProfile } from '../../src/modules/nurses';
import type { MemoryStorageProvider } from '../../src/providers/storage';
import { getStorageProvider } from '../../src/providers/storage';
import { SettingsService } from '../../src/modules/settings';
import { executeJob } from '../../src/jobs';
import { API, createAdmin, resetState, startApp, stopApp, type Session } from '../helpers/harness';
import { EXE, JPG, PDF, PNG, uniquePdf, upload } from '../helpers/files';
import { baseWorld, mkNurse, mkService, type Nurse } from '../helpers/world';

let app: Express;
let admin: Session;
let serviceId: string;
let patient: Session;
let nurse: Nurse; // unverified, no documents yet
let other: Nurse;
let approver: Session;
let n = 0;

beforeAll(async () => {
  app = await startApp();
});
afterAll(stopApp);
beforeEach(async () => {
  await resetState();
  (getStorageProvider() as MemoryStorageProvider).objects.clear();
  ({ admin, serviceId, patient } = await baseWorld(app));
  nurse = await mkNurse(app, admin, { serviceIds: [serviceId], verify: false });
  other = await mkNurse(app, admin, { serviceIds: [serviceId], verify: false });
  approver = await createAdmin(app, 'FINANCE_APPROVER');
});

const post = (s: Session, path: string, body: object = {}) =>
  request(app).post(`${API}${path}`).set(s.auth).send(body);
const get = (s: Session, path: string) => request(app).get(`${API}${path}`).set(s.auth);
const profile = async (x: Nurse) => (await NurseProfile.findById(x.profileId))!;
const future = (days = 365) => new Date(Date.now() + days * 86_400_000).toISOString();

async function addDoc(
  who: Nurse,
  type: string,
  o: { expiresAt?: string; number?: string; file?: Buffer } = {},
) {
  n += 1;
  const up = await upload(app, who.session, o.file ?? uniquePdf(`${type}-${n}`), {
    filename: `${type.toLowerCase()}.pdf`,
  });
  expect(up.status).toBe(201);
  const res = await post(who.session, '/nurses/me/documents', {
    type,
    fileId: up.body.data.id,
    ...(o.number && { documentNumber: o.number }),
    ...(o.expiresAt && { expiresAt: o.expiresAt }),
  });
  expect(res.status).toBe(201);
  return res.body.data as { id: string; fileId: string; documentNumber: string | null };
}
async function submitted(who: Nurse, exp = future()) {
  const lic = await addDoc(who, 'NURSING_LICENSE', { expiresAt: exp, number: 'DHA-1234567' });
  const idd = await addDoc(who, 'IDENTITY_DOCUMENT', { expiresAt: future(900) });
  const sub = await post(who.session, '/nurses/me/verification/submit');
  expect(sub.status).toBe(200);
  return { lic, idd };
}
async function verified(who: Nurse, exp = future()) {
  const { lic, idd } = await submitted(who, exp);
  await post(admin, `/admin/nurse-documents/${lic.id}/approve`);
  await post(admin, `/admin/nurse-documents/${idd.id}/approve`);
  const a = await post(admin, `/admin/nurses/${who.profileId}/verification/approve`);
  expect(a.status).toBe(200);
  return { lic, idd };
}

describe('files: upload security', () => {
  it('accepts PDF / JPEG / PNG whose content, extension and declared type agree; never returns the storage key', async () => {
    for (const [buf, name, type] of [
      [PDF, 'a.pdf', 'application/pdf'],
      [PNG, 'b.png', 'image/png'],
      [JPG, 'c.jpeg', 'image/jpeg'],
    ] as const) {
      const r = await upload(app, nurse.session, Buffer.concat([buf, Buffer.from(name)]), {
        filename: name,
        contentType: type,
      });
      expect(r.status).toBe(201);
      expect(r.body.data.contentType).toBe(type);
      expect(JSON.stringify(r.body)).not.toMatch(/storageKey|nurse_document\//);
    }
  });

  it('rejects dangerous or mismatching files', async () => {
    const cases: [Buffer, string, string, string][] = [
      [EXE, 'setup.exe', 'application/octet-stream', 'FILE_TYPE_NOT_ALLOWED'],
      [EXE, 'license.pdf', 'application/pdf', 'FILE_TYPE_NOT_ALLOWED'], // exe disguised as pdf
      [PDF, 'evil.php.pdf', 'application/pdf', 'FILE_TYPE_NOT_ALLOWED'], // double extension
      [PDF, 'license.png', 'application/pdf', 'FILE_TYPE_MISMATCH'], // extension vs content
      [PDF, 'license.pdf', 'image/png', 'FILE_TYPE_MISMATCH'], // declared vs content
      [Buffer.from('<svg onload=alert(1)>'), 'x.svg', 'image/svg+xml', 'FILE_TYPE_NOT_ALLOWED'],
      [Buffer.from('<html></html>'), 'x.html', 'text/html', 'FILE_TYPE_NOT_ALLOWED'],
      [PDF, 'noextension', 'application/pdf', 'FILE_TYPE_NOT_ALLOWED'],
    ];
    for (const [buf, filename, contentType, code] of cases) {
      const r = await upload(app, nurse.session, buf, { filename, contentType });
      expect([r.status, r.body.errorCode]).toEqual([422, code]);
    }
    expect(await FileObject.countDocuments()).toBe(0);
  });

  it('enforces the size limit (setting) and the multipart hard cap', async () => {
    await SettingsService.set('files.maxUploadBytes', 2048);
    const big = Buffer.concat([PDF, Buffer.alloc(4096, 1)]);
    const r = await upload(app, nurse.session, big);
    expect([r.status, r.body.errorCode]).toEqual([413, 'FILE_TOO_LARGE']);
  });

  it('sanitises path-traversal file names and never uses them in the storage key', async () => {
    const r = await upload(app, nurse.session, uniquePdf('trav'), {
      filename: '../../etc/passwd.pdf',
    });
    expect(r.status).toBe(201);
    expect(r.body.data.originalName).toBe('passwd.pdf');
    const f = (await FileObject.findById(r.body.data.id))!;
    expect(f.storageKey).toMatch(
      new RegExp(`^nurse_document/${nurse.session.id}/[0-9a-f-]{36}\\.pdf$`),
    );
  });

  it('requires authentication and the right role; duplicates are returned, not stored twice', async () => {
    expect(
      (
        await request(app)
          .post(`${API}/files`)
          .field('purpose', 'NURSE_DOCUMENT')
          .attach('file', PDF, { filename: 'a.pdf', contentType: 'application/pdf' })
      ).status,
    ).toBe(401);
    expect((await upload(app, patient, PDF)).status).toBe(403);
    const a = await upload(app, nurse.session, uniquePdf('dup'));
    const b = await upload(app, nurse.session, uniquePdf('dup'));
    expect(a.body.data.id).toBe(b.body.data.id);
    expect(b.body.data.duplicate).toBe(true);
    expect(await FileObject.countDocuments()).toBe(1);
  });

  it('a storage outage fails the upload cleanly and leaves no metadata behind', async () => {
    (getStorageProvider() as MemoryStorageProvider).failNextPut = true;
    const r = await upload(app, nurse.session, uniquePdf('outage'));
    expect(r.status).toBe(500);
    expect(await FileObject.countDocuments()).toBe(0);
  });
});

describe('files: private access', () => {
  it('only the owner or an authorised admin gets a short-lived link; others see 404', async () => {
    const up = await upload(app, nurse.session, uniquePdf('priv'));
    const id = up.body.data.id as string;
    expect((await post(other.session, `/files/${id}/access-url`)).status).toBe(404);
    expect((await get(other.session, `/files/${id}`)).status).toBe(404);
    expect((await post(patient, `/files/${id}/access-url`)).status).toBe(403);
    expect((await post(approver, `/files/${id}/access-url`)).status).toBe(403);
    const mine = await post(nurse.session, `/files/${id}/access-url`);
    const adm = await post(admin, `/files/${id}/access-url`);
    expect(mine.status).toBe(200);
    expect(adm.status).toBe(200);
    const dl = await request(app).get(mine.body.data.url);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toContain('application/pdf');
    expect(dl.headers['cache-control']).toContain('no-store');
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.headers['content-disposition']).toContain('attachment');
  });

  it('links expire, cannot be tampered with and are bound to the requester', async () => {
    const up = await upload(app, nurse.session, uniquePdf('exp'));
    const id = up.body.data.id as string;
    const url = (await post(nurse.session, `/files/${id}/access-url`)).body.data.url as string;
    const u = new URL(url, 'http://x');
    const q = (o: Record<string, string>) =>
      `/api/v1/files/${id}/content?${new URLSearchParams({ exp: u.searchParams.get('exp')!, u: u.searchParams.get('u')!, sig: u.searchParams.get('sig')!, ...o })}`;
    expect((await request(app).get(q({}))).status).toBe(200);
    expect((await request(app).get(q({ sig: 'a'.repeat(64) }))).status).toBe(403);
    expect((await request(app).get(q({ u: other.session.id }))).status).toBe(403); // another user
    expect(
      (await request(app).get(q({ exp: String(Number(u.searchParams.get('exp')) + 600) }))).status,
    ).toBe(403);
    // time passes
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'],
      now: Date.now() + 3 * 60_000,
    });
    const late = await request(app).get(q({}));
    jest.useRealTimers();
    expect([late.status, late.body.errorCode]).toEqual([403, 'INVALID_FILE_LINK']);
  });
});

describe('documents and the verification workflow', () => {
  it('registers documents (masked number for the owner), idempotently, and only for the owners own files', async () => {
    const d = await addDoc(nurse, 'NURSING_LICENSE', {
      number: 'DHA-1234567',
      expiresAt: future(),
    });
    expect(d.documentNumber).toBe('****4567');
    const again = await post(nurse.session, '/nurses/me/documents', {
      type: 'NURSING_LICENSE',
      fileId: d.fileId,
    });
    expect(again.body.data).toMatchObject({ id: d.id, created: false });
    expect(await NurseDocument.countDocuments()).toBe(1);
    const foreign = await post(other.session, '/nurses/me/documents', {
      type: 'CERTIFICATE',
      fileId: d.fileId,
    });
    expect([foreign.status, foreign.body.errorCode]).toEqual([404, 'FILE_NOT_FOUND']);
    const past = await post(nurse.session, '/nurses/me/documents', {
      type: 'OTHER',
      fileId: (await upload(app, nurse.session, uniquePdf('p'))).body.data.id,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(past.body.errorCode).toBe('DOCUMENT_ALREADY_EXPIRED');
    expect((await get(nurse.session, '/nurses/me/documents')).body.data[0].documentNumber).toBe(
      '****4567',
    );
  });

  it('submission needs the required documents; then PENDING -> UNDER_REVIEW, idempotently', async () => {
    const early = await post(nurse.session, '/nurses/me/verification/submit');
    expect([early.status, early.body.errorCode]).toEqual([409, 'REQUIRED_DOCUMENTS_MISSING']);
    await addDoc(nurse, 'NURSING_LICENSE', { expiresAt: future() });
    expect((await post(nurse.session, '/nurses/me/verification/submit')).body.errorCode).toBe(
      'REQUIRED_DOCUMENTS_MISSING',
    );
    await addDoc(nurse, 'IDENTITY_DOCUMENT');
    const sub = await post(nurse.session, '/nurses/me/verification/submit');
    expect(sub.body.data).toEqual({ changed: true, verificationStatus: 'UNDER_REVIEW' });
    expect((await post(nurse.session, '/nurses/me/verification/submit')).body.data.changed).toBe(
      false,
    );
    expect((await profile(nurse)).verificationStatus).toBe('UNDER_REVIEW');
    expect(await NurseDocument.countDocuments({ status: 'UNDER_REVIEW' })).toBe(2);
    expect(await AuditLog.countDocuments({ action: 'nurse.verification_submitted' })).toBe(1);
    expect(
      await Notification.countDocuments({ type: 'NURSE_VERIFICATION_SUBMITTED' }),
    ).toBeGreaterThan(0);
  });

  it('a nurse cannot approve themselves; patients and finance approvers cannot review', async () => {
    const { lic } = await submitted(nurse);
    for (const who of [nurse.session, patient, approver]) {
      expect((await post(who, `/admin/nurse-documents/${lic.id}/approve`)).status).toBe(403);
      expect(
        (await post(who, `/admin/nurses/${nurse.profileId}/verification/approve`)).status,
      ).toBe(403);
      expect((await get(who, `/admin/nurse-documents`)).status).toBe(403);
    }
    const legacy = await request(app)
      .patch(`${API}/admin/nurses/${nurse.profileId}/verify`)
      .set(nurse.session.auth)
      .send({ decision: 'VERIFIED' });
    expect(legacy.status).toBe(403);
    expect((await profile(nurse)).verificationStatus).toBe('UNDER_REVIEW');
  });

  it('approval requires verified required documents; then the nurse is VERIFIED, ACTIVE and bookable; everything is audited', async () => {
    const { lic, idd } = await submitted(nurse);
    const early = await post(admin, `/admin/nurses/${nurse.profileId}/verification/approve`);
    expect([early.status, early.body.errorCode]).toEqual([409, 'REQUIRED_DOCUMENTS_NOT_VERIFIED']);
    const a1 = await post(admin, `/admin/nurse-documents/${lic.id}/approve`);
    const a2 = await post(admin, `/admin/nurse-documents/${lic.id}/approve`);
    expect([a1.body.data.changed, a2.body.data.changed]).toEqual([true, false]);
    await post(admin, `/admin/nurse-documents/${idd.id}/approve`);
    const ok = await post(admin, `/admin/nurses/${nurse.profileId}/verification/approve`);
    expect(ok.body.data.nurse).toMatchObject({
      verificationStatus: 'VERIFIED',
      status: 'ACTIVE',
      isBookable: true,
    });
    expect(
      (await post(admin, `/admin/nurses/${nurse.profileId}/verification/approve`)).body.data
        .changed,
    ).toBe(false);
    const log = await AuditLog.findOne({ action: 'nurse.approved' }).lean();
    expect(String(log!.entityId)).toBe(nurse.profileId);
    expect(log!.oldData).toMatchObject({ verificationStatus: 'UNDER_REVIEW' });
    expect(String(log!.actorId)).toBe(admin.id);
    expect(JSON.stringify(await AuditLog.find().lean())).not.toContain('DHA-1234567'); // numbers never audited
    const detail = await get(admin, `/admin/nurses/${nurse.profileId}/verification`);
    expect(
      detail.body.data.documents.find((d: { type: string }) => d.type === 'NURSING_LICENSE')
        .documentNumber,
    ).toBe('DHA-1234567');
  });

  it('rejection needs a reason, keeps the nurse non-bookable, and a rejected nurse must go through review again', async () => {
    await submitted(nurse);
    expect(
      (await post(admin, `/admin/nurses/${nurse.profileId}/verification/reject`, { reason: 'abc' }))
        .status,
    ).toBe(400);
    const rej = await post(admin, `/admin/nurses/${nurse.profileId}/verification/reject`, {
      reason: 'License unreadable',
    });
    expect(rej.body.data.nurse).toMatchObject({
      verificationStatus: 'REJECTED',
      isBookable: false,
      statusReason: 'License unreadable',
    });
    expect(
      (
        await post(admin, `/admin/nurses/${nurse.profileId}/verification/reject`, {
          reason: 'License unreadable',
        })
      ).body.data.changed,
    ).toBe(false);
    // no silent reactivation: REJECTED cannot be approved or set VERIFIED directly
    expect(
      (await post(admin, `/admin/nurses/${nurse.profileId}/verification/approve`)).body.errorCode,
    ).toBe('INVALID_VERIFICATION_TRANSITION');
    const legacy = await request(app)
      .patch(`${API}/admin/nurses/${nurse.profileId}/verify`)
      .set(admin.auth)
      .send({ decision: 'VERIFIED' });
    expect([legacy.status, legacy.body.errorCode]).toEqual([
      409,
      'INVALID_VERIFICATION_TRANSITION',
    ]);
    const re = await post(nurse.session, '/nurses/me/verification/submit');
    expect(re.body.data.verificationStatus).toBe('UNDER_REVIEW');
    expect(await AuditLog.countDocuments({ action: 'nurse.rejected' })).toBe(1);
  });

  it('rejecting a document needs a reason; rejecting a verified credential sends a verified nurse back to review', async () => {
    const { lic } = await verified(nurse);
    expect(
      (await post(admin, `/admin/nurse-documents/${lic.id}/reject`, { reason: 'x' })).status,
    ).toBe(400);
    const r = await post(admin, `/admin/nurse-documents/${lic.id}/reject`, {
      reason: 'Photo is a different person',
    });
    expect(r.body.data).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'Photo is a different person',
    });
    expect(await profile(nurse)).toMatchObject({
      verificationStatus: 'UNDER_REVIEW',
      isBookable: false,
    });
    expect(
      (
        await post(admin, `/admin/nurse-documents/${lic.id}/reject`, {
          reason: 'Photo is a different person',
        })
      ).body.data.changed,
    ).toBe(false);
    expect(await AuditLog.countDocuments({ action: 'nurse_document.rejected' })).toBe(1);
  });

  it('concurrent admin decisions never produce an invalid state', async () => {
    const { lic } = await submitted(nurse);
    const admin2 = await createAdmin(app);
    await post(admin, `/admin/nurse-documents/${lic.id}/approve`);
    const idd = (await NurseDocument.findOne({ type: 'IDENTITY_DOCUMENT' }))!;
    await post(admin, `/admin/nurse-documents/${String(idd._id)}/approve`);
    const results = await Promise.all([
      post(admin, `/admin/nurses/${nurse.profileId}/verification/approve`),
      post(admin2, `/admin/nurses/${nurse.profileId}/verification/approve`),
      post(admin, `/admin/nurses/${nurse.profileId}/verification/reject`, {
        reason: 'conflicting decision',
      }),
      post(admin2, `/admin/nurses/${nurse.profileId}/verification/approve`),
    ]);
    expect(results.every((r) => [200, 409].includes(r.status))).toBe(true);
    const p = await profile(nurse);
    expect(['VERIFIED', 'REJECTED']).toContain(p.verificationStatus);
    expect(p.isBookable).toBe(p.verificationStatus === 'VERIFIED' && p.status === 'ACTIVE');
    expect(await AuditLog.countDocuments({ action: 'nurse.approved' })).toBeLessThanOrEqual(1);
  });

  it('document expiry: required credential lapses -> document EXPIRED, nurse EXPIRED and not bookable, one alert; renewal goes through review', async () => {
    const { lic } = await verified(nurse, future(1));
    expect((await profile(nurse)).isBookable).toBe(true);
    await NurseDocument.collection.updateOne(
      { _id: new NurseDocument.base.Types.ObjectId(lic.id) },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    expect(await executeJob('nurse.expireDocuments', {})).toEqual({ documents: 1, nurses: 1 });
    expect(await executeJob('nurse.expireDocuments', {})).toEqual({ documents: 0, nurses: 0 }); // idempotent
    expect((await NurseDocument.findById(lic.id))!.status).toBe('EXPIRED');
    expect(await profile(nurse)).toMatchObject({
      verificationStatus: 'EXPIRED',
      isBookable: false,
    });
    expect(await AdminAlert.countDocuments({ type: 'NURSE_CREDENTIAL_EXPIRED' })).toBe(1);
    expect(await AuditLog.countDocuments({ action: 'nurse_document.expired' })).toBe(1);
    expect(await FileObject.countDocuments()).toBe(2); // nothing deleted
    // not silently reactivated
    const legacy = await request(app)
      .patch(`${API}/admin/nurses/${nurse.profileId}/verify`)
      .set(admin.auth)
      .send({ decision: 'VERIFIED' });
    expect(legacy.status).toBe(409);
    // renewal: new license -> submit -> approve
    const renewed = await addDoc(nurse, 'NURSING_LICENSE', { expiresAt: future(400) });
    const sub = await post(nurse.session, '/nurses/me/verification/submit');
    expect(sub.body.data.verificationStatus).toBe('UNDER_REVIEW');
    await post(admin, `/admin/nurse-documents/${renewed.id}/approve`);
    const idd = (await NurseDocument.findOne({ type: 'IDENTITY_DOCUMENT' }))!;
    expect(idd.status).toBe('VERIFIED');
    const ok = await post(admin, `/admin/nurses/${nurse.profileId}/verification/approve`);
    expect(ok.body.data.nurse).toMatchObject({ verificationStatus: 'VERIFIED', isBookable: true });
  });

  it('a lapsed non-required document is only marked EXPIRED', async () => {
    await verified(nurse);
    const cert = await addDoc(nurse, 'CERTIFICATE', { expiresAt: future(1) });
    await post(admin, `/admin/nurse-documents/${cert.id}/approve`);
    await NurseDocument.collection.updateOne(
      { _id: new NurseDocument.base.Types.ObjectId(cert.id) },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    expect(await VerificationService.expireDue()).toEqual({ documents: 1, nurses: 0 });
    expect((await profile(nurse)).isBookable).toBe(true);
  });

  it('the review queue lists documents and supports filters', async () => {
    await submitted(nurse);
    const q = await get(admin, '/admin/nurse-documents?status=UNDER_REVIEW&type=NURSING_LICENSE');
    expect(q.body.data.items).toHaveLength(1);
    expect(q.body.data.items[0].documentNumber).toBe('DHA-1234567');
    expect(q.body.data.meta.total).toBe(1);
    void other;
    void mkService;
  });
});

describe('suspension, concurrency and logging', () => {
  it('suspension makes a verified nurse non-bookable and reactivation restores them (audited)', async () => {
    await verified(nurse);
    const s = await request(app)
      .patch(`${API}/admin/nurses/${nurse.profileId}/suspend`)
      .set(admin.auth)
      .send({ reason: 'complaint under review' });
    expect(s.body.data).toMatchObject({ status: 'SUSPENDED', isBookable: false });
    // a suspended nurse can not make themselves active, and re-submitting does not reactivate
    const self = await request(app)
      .patch(`${API}/nurses/me/status`)
      .set(nurse.session.auth)
      .send({ status: 'ACTIVE' });
    expect(self.status).toBe(409);
    const r = await request(app)
      .patch(`${API}/admin/nurses/${nurse.profileId}/reactivate`)
      .set(admin.auth);
    expect(r.body.data).toMatchObject({ status: 'ACTIVE', isBookable: true });
    const actions = (await AuditLog.find({ entityId: nurse.profileId }).lean()).map(
      (a) => a.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining(['nurse.suspended', 'nurse.reactivated', 'nurse.approved']),
    );
  });

  it('five concurrent registrations of the same uploaded file create one document', async () => {
    const up = await upload(app, nurse.session, uniquePdf('race'));
    const rs = await Promise.all(
      Array.from({ length: 5 }, () =>
        post(nurse.session, '/nurses/me/documents', {
          type: 'CERTIFICATE',
          fileId: up.body.data.id,
        }),
      ),
    );
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(new Set(rs.map((r) => r.body.data.id)).size).toBe(1);
    expect(await NurseDocument.countDocuments()).toBe(1);
  });

  it('document numbers and file contents never reach the logs', async () => {
    const { logger } = await import('../../src/config/logger');
    const { inspect } = await import('node:util');
    const spies = (['info', 'warn', 'error', 'debug'] as const).map((l) => jest.spyOn(logger, l));
    await addDoc(nurse, 'NURSING_LICENSE', { number: 'LOGLEAK-9988776', expiresAt: future() });
    const blob = inspect(
      spies.flatMap((s) => s.mock.calls),
      { depth: 4, maxStringLength: 100_000 },
    );
    expect(blob).not.toContain('LOGLEAK-9988776');
    expect(blob).not.toContain('%PDF');
    jest.restoreAllMocks();
  });

  it('a nurse can not read another nurse private files or documents', async () => {
    const d = await addDoc(other, 'NURSING_LICENSE', { expiresAt: future() });
    expect((await get(nurse.session, `/files/${d.fileId}`)).status).toBe(404);
    expect((await post(nurse.session, `/files/${d.fileId}/access-url`)).status).toBe(404);
    expect((await get(nurse.session, `/admin/nurses/${other.profileId}/verification`)).status).toBe(
      403,
    );
    expect((await get(nurse.session, '/nurses/me/documents')).body.data).toHaveLength(0);
  });
});
