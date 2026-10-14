import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { AuditLog } from '../../src/modules/audit';
import { ReconciliationService } from '../../src/modules/finance';
import { PayoutMethod } from '../../src/modules/payouts';
import {
  WalletAdjustment,
  WalletAdjustmentService,
  WalletTransaction,
} from '../../src/modules/wallets';
import { API, createAdmin, resetState, startApp, stopApp, type Session } from '../helpers/harness';
import { freshProvider, setSetting, walletOf } from '../helpers/finance';
import { baseWorld, type Nurse } from '../helpers/world';

let app: Express;
let admin: Session;
let admin2: Session;
let nurse: Nurse;
let patient: Session;

beforeAll(async () => {
  app = await startApp();
});
afterAll(stopApp);
beforeEach(async () => {
  await resetState();
  freshProvider();
  ({ admin, nurse, patient } = await baseWorld(app));
  admin2 = await createAdmin(app, 'FINANCE_APPROVER');
  await setSetting('adjustment.maxImmediateMinor', 10_000);
  await setSetting('adjustment.maxDailyMinor', 30_000);
});

const adjust = (
  who: Session,
  body: { bucket?: string; amountMinor: number; reason?: string },
  key: string | null = randomUUID(),
) => {
  const r = request(app).post(`${API}/admin/wallets/${nurse.profileId}/adjustments`).set(who.auth);
  return (key ? r.set('Idempotency-Key', key) : r).send({
    bucket: 'AVAILABLE',
    reason: 'goodwill credit',
    ...body,
  });
};
const decide = (who: Session, id: string, action: 'approve' | 'reject', body: object = {}) =>
  request(app).post(`${API}/admin/wallet-adjustments/${id}/${action}`).set(who.auth).send(body);
const ledger = () => WalletTransaction.countDocuments({ type: 'ADJUSTMENT' });

describe('P7: wallet adjustments use maker-checker above configurable limits', () => {
  it('a small adjustment applies immediately; limits come from settings, not code', async () => {
    const r = await adjust(admin, { amountMinor: 10_000 });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ status: 'APPLIED', applied: true });
    expect((await walletOf(nurse)).availableBalanceMinor).toBe(10_000);

    await setSetting('adjustment.maxImmediateMinor', 500);
    const over = await adjust(admin, { amountMinor: 1000 });
    expect(over.body.data).toMatchObject({ status: 'PENDING', applied: false, ledgerId: null });
  });

  it('a large adjustment becomes PENDING and changes NO balance until a DIFFERENT admin approves', async () => {
    const r = await adjust(admin, { amountMinor: 50_000, reason: 'large goodwill credit' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ status: 'PENDING', applied: false, ledgerId: null });
    expect(await walletOf(nurse)).toMatchObject({
      availableBalanceMinor: 0,
      pendingBalanceMinor: 0,
    });
    expect(await ledger()).toBe(0);
    expect(await AuditLog.countDocuments({ action: 'wallet.adjustment_requested' })).toBe(1);

    // the maker (a plain ADMIN) has no approval permission at all
    const self = await decide(admin, r.body.data.adjustmentId, 'approve');
    expect(self.status).toBe(403);
    expect(await ledger()).toBe(0);

    const ok = await decide(admin2, r.body.data.adjustmentId, 'approve', { note: 'verified' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'APPLIED', decidedBy: admin2.id });
    expect((await walletOf(nurse)).availableBalanceMinor).toBe(50_000);
    expect(await ledger()).toBe(1);
    expect(await AuditLog.countDocuments({ action: 'wallet.adjustment_approved' })).toBe(1);
    expect((await ReconciliationService.run()).ok).toBe(true);
  });

  it('approval is idempotent and race-safe: two concurrent approvals apply exactly once', async () => {
    const r = await adjust(admin, { amountMinor: 50_000 });
    const id = r.body.data.adjustmentId as string;
    const admin3 = await createAdmin(app, 'FINANCE_APPROVER');
    const results = await Promise.all([
      decide(admin2, id, 'approve'),
      decide(admin3, id, 'approve'),
    ]);
    expect(results.every((x) => [200, 409].includes(x.status))).toBe(true);
    expect(results.some((x) => x.status === 200)).toBe(true);
    expect(await ledger()).toBe(1);
    expect((await walletOf(nurse)).availableBalanceMinor).toBe(50_000);
    const again = await decide(admin2, id, 'approve');
    expect(again.status).toBe(200);
    expect(await ledger()).toBe(1);
  });

  it('reject never affects the balance, needs a note, is final and audited', async () => {
    const r = await adjust(admin, { amountMinor: 50_000 });
    const id = r.body.data.adjustmentId as string;
    expect((await decide(admin2, id, 'reject', {})).status).toBe(400);
    const rej = await decide(admin2, id, 'reject', { note: 'not justified' });
    expect(rej.body.data).toMatchObject({ status: 'REJECTED', decidedBy: admin2.id });
    expect(await ledger()).toBe(0);
    expect((await walletOf(nurse)).availableBalanceMinor).toBe(0);
    const late = await decide(admin2, id, 'approve');
    expect([late.status, late.body.errorCode]).toEqual([409, 'ADJUSTMENT_NOT_PENDING']);
    expect(await AuditLog.countDocuments({ action: 'wallet.adjustment_rejected' })).toBe(1);
  });

  it('an unapproved or rejected adjustment can never be paid out', async () => {
    await PayoutMethod.create({
      nurseId: nurse.profileId,
      provider: 'mock',
      providerRef: 'mock_acct_123456',
    });
    const r = await adjust(admin, { amountMinor: 1_000_000_000 });
    expect(r.body.data.status).toBe('PENDING');
    const pay = await request(app)
      .post(`${API}/payouts`)
      .set(nurse.session.auth)
      .set('Idempotency-Key', randomUUID())
      .send({ amountMinor: 50_000 });
    expect([pay.status, pay.body.errorCode]).toEqual([422, 'INSUFFICIENT_BALANCE']);
    await decide(admin2, r.body.data.adjustmentId, 'reject', { note: 'fraud suspected' });
    const pay2 = await request(app)
      .post(`${API}/payouts`)
      .set(nurse.session.auth)
      .set('Idempotency-Key', randomUUID())
      .send({ amountMinor: 50_000 });
    expect(pay2.body.errorCode).toBe('INSUFFICIENT_BALANCE');
  });

  it("the admin's rolling 24h total is capped: many small adjustments end up needing approval", async () => {
    const statuses: string[] = [];
    for (let i = 0; i < 4; i++)
      statuses.push((await adjust(admin, { amountMinor: 9_000 })).body.data.status);
    expect(statuses).toEqual(['APPLIED', 'APPLIED', 'APPLIED', 'PENDING']);
    // a different admin has their own daily budget
    const other = await createAdmin(app);
    expect((await adjust(other, { amountMinor: 9_000 })).body.data.status).toBe('APPLIED');
  });

  it('negative adjustments are limited the same way and still cannot overdraw', async () => {
    await adjust(admin, { amountMinor: 5_000 });
    const neg = await adjust(admin, { amountMinor: -9_000 });
    expect([neg.status, neg.body.errorCode]).toEqual([422, 'INSUFFICIENT_BALANCE']);
    expect((await walletOf(nurse)).availableBalanceMinor).toBe(5_000);
    // a large negative request is queued; approving it still cannot overdraw
    const big = await adjust(admin, { amountMinor: -20_000 });
    expect(big.body.data.status).toBe('PENDING');
    const approve = await decide(admin2, big.body.data.adjustmentId, 'approve');
    expect([approve.status, approve.body.errorCode]).toEqual([422, 'INSUFFICIENT_BALANCE']);
    expect((await WalletAdjustment.findById(big.body.data.adjustmentId))!.status).toBe('PENDING');
    expect((await walletOf(nurse)).availableBalanceMinor).toBe(5_000);
  });

  it('retrying a request with the same Idempotency-Key never creates a second adjustment; a different payload is refused', async () => {
    const key = randomUUID();
    const a = await adjust(admin, { amountMinor: 50_000 }, key);
    const b = await adjust(admin, { amountMinor: 50_000 }, key);
    expect(b.body.data.adjustmentId).toBe(a.body.data.adjustmentId);
    expect(await WalletAdjustment.countDocuments()).toBe(1);
    const c = await adjust(admin, { amountMinor: 60_000 }, key);
    expect([c.status, c.body.errorCode]).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);
  });

  it('the service itself refuses self-approval even for a caller that has the permission', async () => {
    const r = await adjust(admin, { amountMinor: 50_000 });
    await expect(
      WalletAdjustmentService.approve(r.body.data.adjustmentId, undefined, {
        actorId: admin.id,
        actorRole: 'FINANCE_APPROVER',
      }),
    ).rejects.toMatchObject({ errorCode: 'MAKER_CHECKER_VIOLATION' });
    expect(await ledger()).toBe(0);
  });

  it('limit boundaries: exactly at the limit applies, one fil above needs approval', async () => {
    expect((await adjust(admin, { amountMinor: 10_000 })).body.data.status).toBe('APPLIED');
    expect((await adjust(admin, { amountMinor: 10_001 })).body.data.status).toBe('PENDING');
    expect((await adjust(admin, { amountMinor: -10_001 })).body.data.status).toBe('PENDING');
  });

  it('the shipped defaults are AED 1,000 single and AED 10,000 daily, and are configurable settings', async () => {
    const { SETTINGS, SettingsService } = await import('../../src/modules/settings');
    expect(SETTINGS['adjustment.maxImmediateMinor'][1]).toBe(100_000);
    expect(SETTINGS['adjustment.maxDailyMinor'][1]).toBe(1_000_000);
    await SettingsService.set('adjustment.maxImmediateMinor', 100_000);
    await SettingsService.set('adjustment.maxDailyMinor', 1_000_000);
    expect((await adjust(admin, { amountMinor: 100_000 })).body.data.status).toBe('APPLIED');
    expect((await adjust(admin, { amountMinor: 100_001 })).body.data.status).toBe('PENDING');
  });

  it('concurrent adjustments by one admin can never overshoot the daily limit', async () => {
    // daily 30,000; each request is 9,000 and individually allowed => at most 3 may apply
    const results = await Promise.all(
      Array.from({ length: 6 }, () => adjust(admin, { amountMinor: 9_000 })),
    );
    const applied = results.filter((r) => r.body.data?.status === 'APPLIED').length;
    const pending = results.filter((r) => r.body.data?.status === 'PENDING').length;
    expect(applied).toBe(3);
    expect(pending).toBe(3);
    expect((await walletOf(nurse)).availableBalanceMinor).toBe(27_000);
    expect(await ledger()).toBe(3);
  });

  it('approval and rejection are each audited by the finance approver', async () => {
    const a = await adjust(admin, { amountMinor: 50_000 });
    const b = await adjust(admin, { amountMinor: 60_000 });
    await decide(admin2, a.body.data.adjustmentId, 'approve');
    await decide(admin2, b.body.data.adjustmentId, 'reject', { note: 'not justified' });
    const approved = await AuditLog.findOne({ action: 'wallet.adjustment_approved' }).lean();
    const rejected = await AuditLog.findOne({ action: 'wallet.adjustment_rejected' }).lean();
    expect(String(approved!.actorId)).toBe(admin2.id);
    expect(approved).toMatchObject({ actorRole: 'FINANCE_APPROVER' });
    expect(String(rejected!.actorId)).toBe(admin2.id);
    expect(rejected).toMatchObject({ actorRole: 'FINANCE_APPROVER' });
  });

  it('separation of duties: ADMIN cannot approve/reject; FINANCE_APPROVER cannot create adjustments or use other admin APIs', async () => {
    const r = await adjust(admin, { amountMinor: 50_000 });
    const id = r.body.data.adjustmentId as string;
    expect((await decide(admin, id, 'approve')).status).toBe(403);
    expect((await decide(admin, id, 'reject', { note: 'self reject' })).status).toBe(403);
    expect((await adjust(admin2, { amountMinor: 1000 })).status).toBe(403);
    for (const path of ['/admin/users', '/admin/audit-logs', '/admin/payouts', '/admin/refunds']) {
      const res = await request(app).get(`${API}${path}`).set(admin2.auth);
      if (path === '/admin/payouts' || path === '/admin/refunds')
        expect(res.status).toBe(200); // finance read is part of the role
      else expect(res.status).toBe(403);
    }
    const svc = await request(app)
      .post(`${API}/admin/services`)
      .set(admin2.auth)
      .send({ name: 'x', billingUnit: 'HOURLY' });
    expect(svc.status).toBe(403);
    // the request is still untouched and approvable by the approver
    expect((await WalletAdjustment.findById(id))!.status).toBe('PENDING');
    expect((await decide(admin2, id, 'approve')).status).toBe(200);
  });

  it('only admins can request, approve, reject or list', async () => {
    const r = await adjust(admin, { amountMinor: 50_000 });
    const id = r.body.data.adjustmentId as string;
    for (const who of [nurse.session, patient]) {
      expect((await adjust(who, { amountMinor: 1000 })).status).toBe(403);
      expect((await decide(who, id, 'approve')).status).toBe(403);
      expect((await decide(who, id, 'reject', { note: 'nope nope' })).status).toBe(403);
      const list = await request(app).get(`${API}/admin/wallet-adjustments`).set(who.auth);
      expect(list.status).toBe(403);
    }
    const list = await request(app)
      .get(`${API}/admin/wallet-adjustments?status=PENDING`)
      .set(admin.auth);
    expect(list.status).toBe(200);
    expect(list.body.data.items).toHaveLength(1);
    expect(list.body.data.items[0]).toMatchObject({ id, status: 'PENDING', requestedBy: admin.id });
  });
});
