import { MongoMemoryReplSet } from 'mongodb-memory-server';

export default async function globalSetup(): Promise<void> {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  process.env.TEST_MONGO_BASE_URI = replSet.getUri().split('?')[0]!.replace(/\/$/, '');
  process.env.TEST_MONGO_QUERY = replSet.getUri().includes('?')
    ? replSet.getUri().split('?')[1]!
    : '';
  (globalThis as unknown as { __REPLSET__: MongoMemoryReplSet }).__REPLSET__ = replSet;
}
