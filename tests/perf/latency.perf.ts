/**
 * In-process API latency measurement (opt-in: `npm run perf`). Lab numbers on a disposable in-memory MongoDB
 * replica set and mock Redis — useful to compare changes and spot slow endpoints, NOT a production load test.
 *
 * Data is created through the real API (no seed scripts): 3 services, 24 verified nurses, 1 patient with 30 bookings.
 * One HTTP server, keep-alive fetch; rate limiters are reset between batches so they don't distort the numbers.
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Express } from 'express';
import { resetRateLimiters } from '../../src/common/middleware/rateLimit';
import { createAdmin, register, startApp, stopApp, type Session } from '../helpers/harness';
import { at, bookIt, day, mkNurse, mkService } from '../helpers/world';

const N = Number(process.env.PERF_REQUESTS ?? 200);
const CONCURRENCY = 10;
let app: Express;
let server: Server;
let base: string;
const results: Record<string, unknown>[] = [];

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
function summarise(name: string, mode: string, times: number[], wallMs: number, failures: number) {
  const s = [...times].sort((a, b) => a - b);
  const row = {
    endpoint: name,
    mode,
    requests: times.length,
    failures,
    p50: +pct(s, 50).toFixed(1),
    p95: +pct(s, 95).toFixed(1),
    p99: +pct(s, 99).toFixed(1),
    max: +s[s.length - 1]!.toFixed(1),
    rps: +((times.length / wallMs) * 1000).toFixed(0),
  };
  results.push(row);
  return row;
}

async function measure(name: string, req: () => Promise<Response>) {
  for (const [mode, conc] of [['sequential', 1], [`${CONCURRENCY} concurrent`, CONCURRENCY]] as const) {
    const times: number[] = [];
    let failures = 0;
    for (let w = 0; w < 5; w++) await req(); // warm-up
    const started = performance.now();
    for (let done = 0; done < N; ) {
      if (done % 50 === 0) resetRateLimiters();
      const batch = Math.min(conc, N - done);
      await Promise.all(
        Array.from({ length: batch }, async () => {
          const t0 = performance.now();
          const res = await req();
          await res.arrayBuffer();
          times.push(performance.now() - t0);
          if (!res.ok) failures += 1;
        }),
      );
      done += batch;
    }
    const row = summarise(name, mode, times, performance.now() - started, failures);
    expect(row.failures).toBe(0);
  }
}

const get = (path: string, auth?: Record<string, string>) => () => fetch(`${base}/api/v1${path}`, { headers: auth });
const post = (path: string, body: unknown, auth?: Record<string, string>) => () =>
  fetch(`${base}/api/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify(body) });

let admin: Session;
let patient: Session;
let serviceIds: string[];
let nurseIds: string[];

beforeAll(async () => {
  app = await startApp();
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  admin = await createAdmin(app);
  serviceIds = [];
  for (let i = 0; i < 3; i++) serviceIds.push(await mkService(app, admin));
  nurseIds = [];
  for (let i = 0; i < 24; i++) {
    if (i % 8 === 0) resetRateLimiters(); // registration is limited to 10/hour per IP
    nurseIds.push((await mkNurse(app, admin, { serviceIds })).profileId);
  }
  resetRateLimiters();
  patient = await register(app, 'PATIENT');
  for (let i = 0; i < 30; i++) {
    if (i % 10 === 0) resetRateLimiters();
    const d = day(3 + Math.floor(i / 6));
    await bookIt(app, patient, { serviceId: serviceIds[i % 3]!, nurseId: nurseIds[i % 24]!, start: at(d, '09:00'), end: at(d, '13:00') });
  }
}, 600_000);

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await stopApp();
  // eslint-disable-next-line no-console
  console.table(results);
});

describe('API latency (lab, in-memory)', () => {
  it('public catalogue', async () => {
    await measure('GET /public/services', get('/public/services'));
    await measure('GET /public/nurses?limit=20', get('/public/nurses?limit=20'));
    await measure('GET /public/nurses/:id', get(`/public/nurses/${nurseIds[0]}`));
    await measure('GET /public/policies', get('/public/policies'));
  });

  it('patient', async () => {
    const d = day(12);
    await measure(
      'POST /bookings/quote',
      post(
        '/bookings/quote',
        { serviceId: serviceIds[0], nurseId: nurseIds[5], startDateTime: at(d, '09:00').toISOString(), endDateTime: at(d, '13:00').toISOString(), location: { latitude: 25.2048, longitude: 55.2708 } },
        patient.auth,
      ),
    );
    await measure('GET /bookings?limit=20 (patient)', get('/bookings?limit=20', patient.auth));
    await measure('GET /users/me', get('/users/me', patient.auth));
  });

  it('admin', async () => {
    await measure('GET /bookings?limit=20 (admin)', get('/bookings?limit=20', admin.auth));
    await measure('GET /admin/users?limit=20', get('/admin/users?limit=20', admin.auth));
  });
});
