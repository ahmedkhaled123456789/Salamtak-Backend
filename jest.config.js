/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  // real-Redis BullMQ suites run with jest.bullmq.config.js (npm run test:bullmq)
  testPathIgnorePatterns: ['/node_modules/', '/tests/bullmq/'],
  testMatch: ['**/*.test.ts'],
  globalSetup: '<rootDir>/tests/helpers/global-setup.ts',
  globalTeardown: '<rootDir>/tests/helpers/global-teardown.ts',
  setupFiles: ['<rootDir>/tests/helpers/env.ts', '<rootDir>/tests/helpers/mock-redis.ts'],
  testTimeout: 60000,
  clearMocks: true,
};
