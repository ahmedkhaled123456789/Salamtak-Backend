import Redis from 'ioredis';
import { env } from './env';
import { logger } from './logger';

let client: Redis | undefined;

export function getRedis(): Redis {
  if (!client) {
    if (env.REDIS_URL === 'memory') {
      // No Redis (serverless demo): an in-process implementation of the same commands. Per instance only, so rate
      // limits and phone codes are per instance; booking double-booking is still prevented by MongoDB unique indexes.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const RedisMock = require('ioredis-mock') as typeof Redis;
      client = new RedisMock();
      return client;
    }
    client = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 2,
    });
    client.on('error', (err) => logger.error({ err: err.message }, 'Redis error'));
  }
  return client;
}

export async function pingRedis(): Promise<boolean> {
  try {
    return (await getRedis().ping()) === 'PONG';
  } catch {
    return false;
  }
}

export async function disconnectRedis(): Promise<void> {
  if (client) {
    await client.quit().catch(() => client?.disconnect());
    client = undefined;
  }
}
