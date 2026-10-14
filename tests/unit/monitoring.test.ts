import type { ErrorEvent } from '@sentry/node';
import { scrubEvent } from '../../src/config/monitoring';

describe('error-report scrubbing', () => {
  it('keeps the error and drops everything that can carry personal or health data', () => {
    const event = {
      type: undefined,
      exception: { values: [{ type: 'Error', value: 'boom' }] },
      request: {
        method: 'POST',
        url: 'https://api.careflow.ae/api/v1/bookings?patient=Mariam',
        data: { notes: 'diabetic, insulin at 8pm', address: 'Villa 12' },
        cookies: { session: 'x' },
        headers: { authorization: 'Bearer secret', 'x-forwarded-for': '1.2.3.4' },
        query_string: 'patient=Mariam',
      },
      user: { id: '6650', email: 'mariam@example.test', ip_address: '1.2.3.4' },
      extra: { body: 'anything' },
      breadcrumbs: [{ message: 'GET /patients/me' }],
      contexts: { runtime: { name: 'node' }, os: { name: 'linux' }, trace: { trace_id: 't' }, state: { x: 1 } },
    } as unknown as ErrorEvent;

    const out = scrubEvent(event);
    expect(out.exception?.values?.[0]?.value).toBe('boom');
    expect(out.request).toEqual({ method: 'POST', url: 'https://api.careflow.ae/api/v1/bookings' });
    expect(out.user).toEqual({ id: '6650' });
    expect(out.extra).toBeUndefined();
    expect(out.breadcrumbs).toBeUndefined();
    expect(Object.keys(out.contexts ?? {})).toEqual(['runtime', 'os']);
    expect(JSON.stringify(out)).not.toMatch(/Mariam|insulin|Villa|secret|1\.2\.3\.4|example\.test/);
  });
});
