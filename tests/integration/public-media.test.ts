import type { Express } from 'express';
import request from 'supertest';
import { FileObject } from '../../src/modules/files';
import {
  API,
  createAdmin,
  register,
  resetState,
  startApp,
  stopApp,
  type Session,
} from '../helpers/harness';
import { JPG, PDF, PNG, upload } from '../helpers/files';
import { mkNurse, mkService } from '../helpers/world';

let app: Express;
let admin: Session;
let patient: Session;
beforeAll(async () => {
  app = await startApp();
});
afterAll(stopApp);
beforeEach(async () => {
  await resetState();
  admin = await createAdmin(app);
  patient = await register(app, 'PATIENT');
});

const putImage = (path: string, who: Session, file: Buffer, filename = 'photo.jpg', type = 'image/jpeg') =>
  request(app).put(`${API}${path}`).set(who.auth).attach('file', file, { filename, contentType: type });
const origin = (url: string) => url; // imageUrl is relative to the API origin ("/api/v1/media/:id")

describe('service pictures', () => {
  it('stores the picture in the backend and serves it publicly with cache + cross-origin headers', async () => {
    const serviceId = await mkService(app, admin, { billingUnit: 'DAILY', name: 'Elderly Care' });
    const up = await putImage(`/admin/services/${serviceId}/image`, admin, JPG);
    expect(up.status).toBe(200);
    expect(up.body.data.imageUrl).toMatch(/^\/api\/v1\/media\/[a-f\d]{24}$/);

    // no Authorization header: a website visitor
    const img = await request(app).get(origin(up.body.data.imageUrl));
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    expect(img.headers['cache-control']).toContain('immutable');
    expect(img.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(img.headers['x-content-type-options']).toBe('nosniff');
    expect(img.body.equals(JPG)).toBe(true);

    const list = await request(app).get(`${API}/public/services`); // anonymous
    expect(list.status).toBe(200);
    expect(list.body.data.items[0]).toMatchObject({ id: serviceId, imageUrl: up.body.data.imageUrl });
    const bySlug = await request(app).get(`${API}/public/services/elderly-care`);
    expect(bySlug.body.data.imageUrl).toBe(up.body.data.imageUrl);
  });

  it('replacing the picture deletes the old one', async () => {
    const serviceId = await mkService(app, admin);
    const first = await putImage(`/admin/services/${serviceId}/image`, admin, JPG);
    const second = await putImage(`/admin/services/${serviceId}/image`, admin, PNG, 'p.png', 'image/png');
    expect(second.status).toBe(200);
    expect(second.body.data.imageUrl).not.toBe(first.body.data.imageUrl);
    expect((await request(app).get(first.body.data.imageUrl)).status).toBe(404);
    expect((await request(app).get(second.body.data.imageUrl)).status).toBe(200);
  });

  it('only an admin with services:manage can set it, and only real images are accepted', async () => {
    const serviceId = await mkService(app, admin);
    expect((await putImage(`/admin/services/${serviceId}/image`, patient, JPG)).status).toBe(403);
    expect((await request(app).put(`${API}/admin/services/${serviceId}/image`).attach('file', JPG, 'a.jpg')).status).toBe(401);
    const pdf = await putImage(`/admin/services/${serviceId}/image`, admin, PDF, 'doc.pdf', 'application/pdf');
    expect(pdf.status).toBe(422);
    const lie = await putImage(`/admin/services/${serviceId}/image`, admin, PDF, 'doc.jpg', 'image/jpeg');
    expect(lie.status).toBe(422);
    const none = await request(app).put(`${API}/admin/services/${serviceId}/image`).set(admin.auth);
    expect(none.status).toBe(400);
  });
});

describe('private documents stay private', () => {
  it('a NURSE_DOCUMENT is never served from /media and public purposes cannot be uploaded to /files', async () => {
    const doc = await upload(app, admin, PDF);
    expect(doc.status).toBe(201);
    expect((await request(app).get(`${API}/media/${doc.body.data.id}`)).status).toBe(404);

    const viaFiles = await upload(app, admin, JPG, { purpose: 'SERVICE_IMAGE', filename: 'a.jpg', contentType: 'image/jpeg' });
    expect(viaFiles.status).toBe(400);
    expect((await FileObject.findById(doc.body.data.id))!.isPublic).toBe(false);
  });
});

describe('profile photos', () => {
  it('a user uploads their own photo; the nurse photo appears in the public catalogue', async () => {
    const serviceId = await mkService(app, admin, { billingUnit: 'DAILY' });
    const nurse = await mkNurse(app, admin, { serviceIds: [serviceId] });
    const me = await putImage('/users/me/avatar', nurse.session, JPG);
    expect(me.status).toBe(200);
    expect(me.body.data.profileImageUrl).toMatch(/^\/api\/v1\/media\//);
    expect((await request(app).get(me.body.data.profileImageUrl)).status).toBe(200);

    const list = await request(app).get(`${API}/public/nurses`);
    expect(list.status).toBe(200);
    expect(list.body.data.items).toHaveLength(1);
    expect(list.body.data.items[0]).toMatchObject({
      id: nurse.profileId,
      imageUrl: me.body.data.profileImageUrl,
      serviceIds: [serviceId],
    });
    const one = await request(app).get(`${API}/public/nurses/${nurse.profileId}`);
    expect(one.body.data).toMatchObject({ id: nurse.profileId, imageUrl: me.body.data.profileImageUrl });
    // privacy: public cards never carry contact details
    expect(JSON.stringify(list.body)).not.toMatch(/email|phone|lastName/i);
  });

  it('an admin can set a photo on behalf of a user; other roles cannot', async () => {
    const asAdmin = await putImage(`/admin/users/${patient.id}/avatar`, admin, JPG);
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body.data.profileImageUrl).toBeTruthy();
    const other = await register(app, 'PATIENT');
    expect((await putImage(`/admin/users/${patient.id}/avatar`, other, JPG)).status).toBe(403);
  });

  it('unverified nurses stay out of the public catalogue', async () => {
    const serviceId = await mkService(app, admin, { billingUnit: 'DAILY' });
    await mkNurse(app, admin, { serviceIds: [serviceId], verify: false });
    const list = await request(app).get(`${API}/public/nurses`);
    expect(list.body.data.items).toHaveLength(0);
  });
});
