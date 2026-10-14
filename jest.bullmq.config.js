/**
 * BullMQ suites need a REAL Redis (ioredis-mock cannot run BullMQ's Lua scripts / blocking commands).
 * Usage: REDIS_TEST_URL=redis://127.0.0.1:6379 npm run test:bullmq
 * Same real MongoDB replica set global setup as the main suite.
 * @type {import('jest').Config}
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests/bullmq'],
  testMatch: ['**/*.test.ts'],
  globalSetup: '<rootDir>/tests/helpers/global-setup.ts',
  globalTeardown: '<rootDir>/tests/helpers/global-teardown.ts',
  setupFiles: ['<rootDir>/tests/helpers/env.ts', '<rootDir>/tests/bullmq/redis-env.ts'],
  testTimeout: 60000,
  clearMocks: true,
};
