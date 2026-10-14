/** Opt-in latency measurement (`npm run perf`): same harness as the integration tests, tests/perf only. */
const base = require('./jest.config');

module.exports = { ...base, testMatch: ['**/tests/perf/**/*.perf.ts'], testPathIgnorePatterns: ['/node_modules/'], testTimeout: 600000 };
