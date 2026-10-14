import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app';
import { connectDatabase, disconnectDatabase, initModels } from '../../src/config/database';
import { disconnectRedis, getRedis } from '../../src/config/redis';
import { resetRateLimiters } from '../../src/common/middleware/rateLimit';
import { getMessenger, type LogMessenger } from '../../src/providers/messaging/messenger';
import { User } from '../../src/modules/users';
import { MemoryQueueBackend, setQueueBackend } from '../../src/queues';
import { resetNotificationProviders } from '../../src/providers/notification';

export const PASSWORD = 'Str0ngPassword!';
export const API = '/api/v1';

export async function startApp(): Promise<Express> {
  await connectDatabase();
  await initModels();
  setQueueBackend(new MemoryQueueBackend()); // BullMQ itself is covered by tests/bullmq (real Redis)
  return createApp();
}

export async function stopApp(): Promise<void> {
  await mongoose.connection.dropDatabase();
  await disconnectDatabase();
  await disconnectRedis();
}

export async function resetState(): Promise<void> {
  await Promise.all(
    Object.values(mongoose.models).map((m) => m.collection.deleteMany({})), // native: bypasses append-only/immutability hooks,
  );
  await getRedis().flushall();
  resetRateLimiters();
  (getMessenger() as LogMessenger).clear();
  resetNotificationProviders();
}

export const outbox = () => getMessenger() as LogMessenger;

let counter = 0;
export function userInput(role: 'PATIENT' | 'NURSE', overrides: Record<string, unknown> = {}) {
  counter += 1;
  return {
    firstName: 'Test',
    lastName: role === 'NURSE' ? 'Nurse' : 'Patient',
    email: `${role.toLowerCase()}${counter}@example.test`,
    phone: `+97150${String(1000000 + counter)}`,
    password: PASSWORD,
    role,
    ...overrides,
  };
}

export interface Session {
  id: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  auth: { Authorization: string };
}

export async function register(
  app: Express,
  role: 'PATIENT' | 'NURSE',
  overrides: Record<string, unknown> = {},
): Promise<Session> {
  const body = userInput(role, overrides);
  const res = await request(app).post(`${API}/auth/register`).send(body);
  if (res.status !== 201)
    throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  const { user, tokens } = res.body.data;
  return {
    id: user.id,
    email: body.email,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    auth: { Authorization: `Bearer ${tokens.accessToken}` },
  };
}

export async function createAdmin(
  app: Express,
  role: 'ADMIN' | 'FINANCE_APPROVER' = 'ADMIN',
): Promise<Session> {
  counter += 1;
  const email = `admin${counter}@example.test`;
  await User.create({
    firstName: 'Ad',
    lastName: 'Min',
    email,
    phone: `+97155${String(1000000 + counter)}`,
    passwordHash: await bcrypt.hash(PASSWORD, 4),
    role,
  });
  const res = await request(app).post(`${API}/auth/login`).send({ email, password: PASSWORD });
  const { user, tokens } = res.body.data;
  return {
    id: user.id,
    email,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    auth: { Authorization: `Bearer ${tokens.accessToken}` },
  };
}
