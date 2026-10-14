/**
 * Docker-free local MongoDB replica set (single node) on 127.0.0.1:27017, persisted in ./.mongo-dev.
 * Use when Docker is unavailable:  npm run dev:db
 */
import { mkdirSync } from 'node:fs';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

async function main(): Promise<void> {
  mkdirSync('.mongo-dev', { recursive: true });
  const rs = await MongoMemoryReplSet.create({
    replSet: { name: 'rs0', count: 1, dbName: 'care', storageEngine: 'wiredTiger' },
    instanceOpts: [{ port: 27017, dbPath: '.mongo-dev' }],
  });
  console.log(`MongoDB replica set ready: ${rs.getUri('care')}`);
  const stop = async () => {
    await rs.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
