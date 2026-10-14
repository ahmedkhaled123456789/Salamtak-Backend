import type { Express } from 'express';
import request from 'supertest';
import { startApp, stopApp } from '../helpers/harness';

let app: Express;
beforeAll(async () => {
  app = await startApp();
});
afterAll(stopApp);

type Op = {
  security?: unknown[];
  parameters?: { name: string; in: string }[];
  responses: Record<string, unknown>;
  tags?: string[];
  summary?: string;
  requestBody?: unknown;
};
type Doc = {
  openapi: string;
  paths: Record<string, Record<string, Op>>;
  components: { securitySchemes: Record<string, unknown> };
};

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

describe('OpenAPI document', () => {
  let doc: Doc;
  beforeAll(async () => {
    doc = (await request(app).get('/docs.json')).body;
  });

  it('documents the Phase 2 endpoints', () => {
    const expected = [
      'get /api/v1/services',
      'get /api/v1/services/{id}',
      'post /api/v1/admin/services',
      'patch /api/v1/admin/services/{id}',
      'patch /api/v1/admin/services/{id}/activate',
      'patch /api/v1/admin/services/{id}/deactivate',
      'get /api/v1/admin/services/{id}/prices',
      'post /api/v1/admin/services/{id}/prices',
      'get /api/v1/admin/holidays',
      'post /api/v1/admin/holidays',
      'delete /api/v1/admin/holidays/{id}',
      'get /api/v1/admin/settings',
      'put /api/v1/admin/settings/{key}',
      'get /api/v1/nurses/me/services',
      'put /api/v1/nurses/me/services',
      'get /api/v1/nurses/me/availability',
      'post /api/v1/nurses/me/availability',
      'patch /api/v1/nurses/me/availability/{id}',
      'delete /api/v1/nurses/me/availability/{id}',
      'get /api/v1/nurses',
      'get /api/v1/nurses/{id}',
      'get /api/v1/nurses/{id}/availability',
      'post /api/v1/bookings/quote',
      'post /api/v1/bookings',
      'get /api/v1/bookings',
      'get /api/v1/bookings/{id}',
      'get /api/v1/bookings/{id}/history',
      'post /api/v1/bookings/{id}/cancel',
      'post /api/v1/bookings/{id}/accept',
      'post /api/v1/bookings/{id}/reject',
      'post /api/v1/bookings/{id}/start',
      'post /api/v1/bookings/{id}/complete',
      'get /api/v1/admin/bookings',
      'post /api/v1/admin/bookings/{id}/cancel',
      'post /api/v1/admin/bookings/{id}/resolve',
      'post /api/v1/payments/create',
      'get /api/v1/payments/{id}',
      'post /api/v1/payments/webhook',
      'post /api/v1/payments/dev/simulate',
      'get /api/v1/wallets/me',
      'get /api/v1/wallets/me/transactions',
      'get /api/v1/nurses/me/payout-method',
      'put /api/v1/nurses/me/payout-method',
      'post /api/v1/payouts',
      'get /api/v1/payouts',
      'post /api/v1/payouts/{id}/cancel',
      'get /api/v1/admin/payments',
      'get /api/v1/admin/refunds',
      'post /api/v1/admin/refunds/{id}/retry',
      'get /api/v1/admin/payouts',
      'post /api/v1/admin/payouts/{id}/cancel',
      'get /api/v1/admin/wallets/{id}',
      'post /api/v1/admin/wallets/{id}/adjustments',
      'get /api/v1/admin/wallet-adjustments',
      'post /api/v1/admin/wallet-adjustments/{id}/approve',
      'post /api/v1/admin/wallet-adjustments/{id}/reject',
      'get /api/v1/notifications',
      'get /api/v1/notifications/unread-count',
      'post /api/v1/notifications/read-all',
      'post /api/v1/notifications/{id}/read',
      'get /api/v1/admin/queues',
      'post /api/v1/files',
      'get /api/v1/files/{id}',
      'post /api/v1/files/{id}/access-url',
      'get /api/v1/files/{id}/content',
      'post /api/v1/nurses/me/documents',
      'get /api/v1/nurses/me/documents',
      'post /api/v1/nurses/me/verification/submit',
      'get /api/v1/admin/nurse-documents',
      'get /api/v1/admin/nurses/{id}/verification',
      'post /api/v1/admin/nurse-documents/{id}/approve',
      'post /api/v1/admin/nurse-documents/{id}/reject',
      'post /api/v1/admin/nurses/{id}/verification/approve',
      'post /api/v1/admin/nurses/{id}/verification/reject',
      'post /api/v1/bookings/{id}/review',
      'get /api/v1/reviews/me',
      'get /api/v1/nurses/{id}/reviews',
      'get /api/v1/admin/reviews',
      'get /api/v1/admin/reviews/{id}',
      'post /api/v1/admin/reviews/{id}/hide',
      'post /api/v1/admin/reviews/{id}/flag',
      'post /api/v1/admin/reviews/{id}/restore',
      'post /api/v1/coupons/validate',
      'post /api/v1/admin/coupons',
      'patch /api/v1/admin/coupons/{id}',
      'post /api/v1/admin/coupons/{id}/activate',
      'post /api/v1/admin/coupons/{id}/deactivate',
      'get /api/v1/admin/coupons',
      'get /api/v1/admin/coupons/{id}',
      'post /api/v1/emergency-requests',
      'get /api/v1/emergency-requests',
      'get /api/v1/emergency-requests/{id}',
      'post /api/v1/emergency-requests/{id}/cancel',
      'get /api/v1/emergency-offers',
      'post /api/v1/emergency-offers/{id}/accept',
      'post /api/v1/emergency-offers/{id}/decline',
      'get /api/v1/admin/emergency-requests',
      'get /api/v1/admin/emergency-requests/{id}',
      'post /api/v1/admin/emergency-requests/{id}/cancel',
      'post /api/v1/admin/emergency-requests/{id}/reopen',
      'post /api/v1/devices',
      'get /api/v1/devices',
      'post /api/v1/devices/unregister',
      'post /api/v1/devices/{id}/deactivate',
      'post /api/v1/conversations',
      'post /api/v1/conversations/support',
      'get /api/v1/conversations',
      'get /api/v1/conversations/unread-count',
      'get /api/v1/conversations/{id}/messages',
      'post /api/v1/conversations/{id}/messages',
      'post /api/v1/conversations/{id}/read',
      'get /api/v1/admin/reports/marketplace',
      'get /api/v1/admin/alerts',
      'patch /api/v1/admin/alerts/{id}/resolve',
      'post /api/v1/admin/finance/process-due',
      'get /api/v1/admin/reconciliation',
      'post /api/v1/admin/reconciliation/repair/refund-obligations',
      'get /api/v1/admin/commissions',
      'post /api/v1/admin/commissions',
    ];
    const have = Object.entries(doc.paths).flatMap(([p, ops]) =>
      Object.keys(ops).map((m) => `${m} ${p}`),
    );
    for (const e of expected) expect(have).toContain(e);
  });

  it('every documented endpoint really exists (no phantom docs)', async () => {
    const id = '64b7f0f0f0f0f0f0f0f0f0f0';
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const method of Object.keys(ops)) {
        const url = path.replace('{id}', id).replace('{key}', 'booking.holdMinutes');
        const res = await (request(app) as unknown as Record<string, (u: string) => request.Test>)[
          method
        ]!(url).send({});
        expect(`${method} ${path} ${res.body?.errorCode}`).not.toContain('ROUTE_NOT_FOUND');
      }
    }
  });

  it('every operation declares auth, error responses, a success response and a tag', () => {
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const m of METHODS) {
        const op = ops[m];
        if (!op) continue;
        const label = `${m} ${path}`;
        expect(op.tags?.length).toBeGreaterThan(0);
        expect(op.summary).toBeTruthy();
        const codes = Object.keys(op.responses);
        expect(codes.some((c) => c.startsWith('2'))).toBe(true);
        expect(codes).toContain('500');
        const isPublic = (op.security ?? []).length === 0;
        if (!isPublic) {
          expect([label, codes.includes('401')]).toEqual([label, true]);
          expect(op.security).toEqual([{ bearerAuth: [] }]);
        }
      }
    }
  });

  it('list endpoints document pagination parameters', () => {
    for (const p of [
      '/api/v1/nurses',
      '/api/v1/bookings',
      '/api/v1/admin/bookings',
      '/api/v1/admin/services',
      '/api/v1/admin/users',
    ]) {
      const names = doc.paths[p]!.get!.parameters!.map((x) => x.name);
      expect(names).toEqual(expect.arrayContaining(['page', 'limit']));
    }
    const search = doc.paths['/api/v1/nurses']!.get!.parameters!.map((x) => x.name);
    expect(search).toEqual(
      expect.arrayContaining([
        'serviceId',
        'gender',
        'startDateTime',
        'endDateTime',
        'lat',
        'lng',
        'maxDistanceKm',
        'minExperience',
        'minRating',
        'minPrice',
        'maxPrice',
        'language',
        'specialization',
        'sort',
      ]),
    );
  });

  it('documents request bodies for write endpoints and role restrictions in descriptions', () => {
    expect(doc.paths['/api/v1/bookings']!.post!.requestBody).toBeDefined();
    expect(doc.paths['/api/v1/bookings/quote']!.post!.requestBody).toBeDefined();
    expect(doc.paths['/api/v1/nurses/me/availability']!.post!.requestBody).toBeDefined();
    const desc = (
      doc.paths['/api/v1/bookings/{id}/accept']!.post as unknown as { description: string }
    ).description;
    expect(desc).toContain('NURSE');
    const admin = (doc.paths['/api/v1/admin/services']!.post as unknown as { description: string })
      .description;
    expect(admin).toContain('ADMIN');
    expect(doc.paths['/api/v1/bookings/{id}']!.get!.responses).toHaveProperty('404');
  });

  it('documents the Phase 3 contracts: signed public webhook, required idempotency headers, no secrets in examples', () => {
    const hook = doc.paths['/api/v1/payments/webhook']!.post!;
    expect(hook.security).toEqual([]);
    expect(Object.keys(hook.responses)).toEqual(
      expect.arrayContaining(['200', '400', '409', '500']),
    );
    for (const p of ['/api/v1/payouts', '/api/v1/admin/wallets/{id}/adjustments']) {
      const params = doc.paths[p]!.post!.parameters as {
        name: string;
        in: string;
        required: boolean;
      }[];
      expect(params).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'idempotency-key', in: 'header', required: true }),
        ]),
      );
    }
    expect(JSON.stringify(doc)).not.toMatch(/sk_live|sk_test|whsec_[a-z0-9]{8}/i);
    expect(doc.paths['/api/v1/admin/reconciliation']!.get!.responses).toHaveProperty('403');
  });

  it('is a valid OpenAPI 3.1 shape with a bearer scheme', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.components.securitySchemes).toHaveProperty('bearerAuth');
  });
});
