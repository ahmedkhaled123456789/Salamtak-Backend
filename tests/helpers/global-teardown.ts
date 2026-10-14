import type { MongoMemoryReplSet } from 'mongodb-memory-server';

export default async function globalTeardown(): Promise<void> {
  await (globalThis as unknown as { __REPLSET__?: MongoMemoryReplSet }).__REPLSET__?.stop();
}
