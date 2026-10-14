import {
  hasPermission,
  ROLE_PERMISSIONS,
  SELF_REGISTERABLE_ROLES,
} from '../../src/common/constants/rbac';
import { randomOtp, safeEqual, sha256 } from '../../src/common/utils/crypto';
import { sanitizeForAudit } from '../../src/modules/audit';
import { fromGeoPoint, toGeoPoint } from '../../src/common/types/geo';

describe('rbac', () => {
  it('maps roles to permissions; unknown roles have none (default deny)', () => {
    expect(hasPermission('ADMIN', 'admin:dashboard')).toBe(true);
    expect(hasPermission('PATIENT', 'admin:dashboard')).toBe(false);
    expect(hasPermission('NURSE', 'nurse-profile:self')).toBe(true);
    expect(hasPermission('GHOST', 'profile:self')).toBe(false);
  });
  it('never allows self-registering privileged roles', () => {
    expect(SELF_REGISTERABLE_ROLES).toEqual(['PATIENT', 'NURSE']);
    expect(Object.keys(ROLE_PERMISSIONS)).toContain('ADMIN');
  });
});

describe('audit sanitisation', () => {
  it('strips secrets recursively', () => {
    const out = sanitizeForAudit({
      name: 'x',
      passwordHash: 'h',
      nested: { refreshToken: 't', accessToken: 'a', ok: 1, list: [{ otp: '123', keep: true }] },
      healthProfile: { diagnosis: 'x' },
    });
    expect(out).toEqual({ name: 'x', nested: { ok: 1, list: [{ keep: true }] } });
  });
});

describe('crypto helpers', () => {
  it('sha256 is stable; safeEqual is length-safe; otp is numeric of the right length', () => {
    expect(sha256('a')).toBe(sha256('a'));
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    for (let i = 0; i < 50; i++) expect(randomOtp(6)).toMatch(/^\d{6}$/);
  });
});

describe('geo', () => {
  it('stores [lng, lat] and reads back lat/lng', () => {
    const p = toGeoPoint({ latitude: 25, longitude: 55 });
    expect(p.coordinates).toEqual([55, 25]);
    expect(fromGeoPoint(p)).toEqual({ latitude: 25, longitude: 55 });
    expect(fromGeoPoint(undefined)).toBeNull();
  });
});
