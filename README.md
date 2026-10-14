# Care Backend (Phase 1)

Home Care / Nursing marketplace API. Express 5, TypeScript (strict), MongoDB replica set + Mongoose, Redis, JWT RS256.
Design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Run

```bash
cp .env.example .env
npm run keys:generate          # RS256 keypair -> ./keys (gitignored); paste values / use *_FILE in .env
docker compose up --build      # api + mongo (replica set rs0) + redis
```

Without Docker: run Mongo as a **replica set** (`npm run dev:db`) and a Redis, then `npm run dev`.

- Swagger UI: http://localhost:5000/docs (JSON: `/docs.json`), enabled outside production.
- Health: `/health` (liveness), `/health/ready` (mongo + redis).
- First admin: `ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run seed:admin` (admins are never created via the API).

## Scripts

`npm run build | typecheck | lint | test | format`. Tests use an in-memory MongoDB **replica set** and `ioredis-mock`.

## Payments (Phase 3)

- `PAYMENT_PROVIDER=mock` (default outside production) or `stripe`; set `PAYMENT_WEBHOOK_SECRET` (and `PAYMENT_SECRET_KEY` for Stripe). The webhook endpoint is `POST /api/v1/payments/webhook` (signature-authenticated, raw body).
- Dev flow: create a booking + `POST /payments/create`, then as admin `POST /payments/dev/simulate` (mock provider only) to deliver a signed success event through the real pipeline.
- Time-driven obligations (refund/payout retries, earnings release, hold expiry, no-show flagging, payment polling, reconciliation, notification delivery) run as BullMQ jobs: start workers with `RUN_WORKERS=true` (inside the API) or `npm run worker` (separate process). `POST /admin/finance/process-due` still runs the sweeps once on demand. BullMQ tests need a real Redis: `REDIS_TEST_URL=redis://127.0.0.1:6379 npm run test:bullmq`.
- `GET /admin/reconciliation` verifies wallets, ledger, payments, refunds, commissions and payouts (read-only).

## Phase 1 scope

Auth (register/login/refresh rotation + reuse detection/logout/forgot+reset/change password/verify email+phone),
users, patient + nurse profiles, admin (dashboard, user/nurse lists, nurse verify/suspend/reactivate, user block, audit logs), RBAC, Swagger.
Later phases (services, pricing, availability, bookings, payments, ...) are intentionally not implemented yet.
