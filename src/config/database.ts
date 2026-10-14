import mongoose from 'mongoose';
import { env } from './env';
import { logger } from './logger';

export async function connectDatabase(): Promise<typeof mongoose> {
  mongoose.set('strictQuery', true);
  mongoose.set('autoIndex', true); // indexes are created via Model.init() at boot (see initModels)
  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  await assertReplicaSet();
  logger.info('MongoDB connected');
  return mongoose;
}

/** Transactions require a replica set; refuse to run on a standalone mongod. */
export async function assertReplicaSet(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('MongoDB connection not ready');
  const hello = await db.admin().command({ hello: 1 });
  if (!hello.setName) {
    throw new Error(
      'MongoDB is not running as a replica set. Transactions are required; use a replica set (see docker-compose.yml).',
    );
  }
}

/** Create all declared indexes. Called at boot so deployments never run with missing indexes. */
export async function initModels(): Promise<void> {
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}

/** Run `fn` in a MongoDB transaction (retries transient errors). */
export function withTransaction<T>(
  fn: (session: mongoose.ClientSession) => Promise<T>,
): Promise<T> {
  return mongoose.connection.transaction(fn) as Promise<T>;
}
