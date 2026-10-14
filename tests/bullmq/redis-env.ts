// Runs after tests/helpers/env.ts: point the app at the real Redis under test.
process.env.REDIS_URL = process.env.REDIS_TEST_URL ?? 'redis://127.0.0.1:6379';
