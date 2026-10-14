import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { inspect } from 'node:util';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import request from 'supertest';
import { io as connectClient, type Socket } from 'socket.io-client';
import type { Server } from 'socket.io';
import { logger } from '../../src/config/logger';
import { Conversation, Message, attachChatSocket, setChatPublisher } from '../../src/modules/chat';
import { Notification } from '../../src/modules/notifications';
import { SettingsService } from '../../src/modules/settings';
import { User } from '../../src/modules/users';
import type { MockPaymentProvider } from '../../src/providers/payment';
import {
  API,
  createAdmin,
  register,
  resetState,
  startApp,
  stopApp,
  type Session,
} from '../helpers/harness';
import { freshProvider, payFully } from '../helpers/finance';
import { at, baseWorld, bookIt, type BookArgs, type Nurse } from '../helpers/world';

let app: Express;
let server: http.Server;
let io: Server;
let url: string;
let admin: Session;
let serviceId: string;
let nurse: Nurse;
let patient: Session;
let patient2: Session;
let D: string;
let mock: MockPaymentProvider;
const sockets: Socket[] = [];

beforeAll(async () => {
  app = await startApp();
  server = http.createServer(app);
  io = attachChatSocket(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  setChatPublisher(undefined);
  await io.close();
  await stopApp();
});
beforeEach(async () => {
  await resetState();
  mock = freshProvider();
  ({ admin, serviceId, nurse, patient, patient2, D } = await baseWorld(app));
});
afterEach(() => {
  sockets.splice(0).forEach((s) => s.disconnect());
  jest.restoreAllMocks();
});

const args = (): BookArgs => ({
  serviceId,
  nurseId: nurse.profileId,
  start: at(D, '08:00'),
  end: at(D, '12:00'),
});
const post = (s: Session, path: string, body: object = {}) =>
  request(app).post(`${API}${path}`).set(s.auth).send(body);
const get = (s: Session, path: string) => request(app).get(`${API}${path}`).set(s.auth);

async function paidChat() {
  const r = await payFully(app, mock, patient, args());
  const c = await post(patient, '/conversations', { bookingId: r.bookingId });
  expect(c.status).toBe(200);
  return { bookingId: r.bookingId, id: c.body.data.id as string };
}
const send = (who: Session, id: string, text: string, extra: object = {}) =>
  post(who, `/conversations/${id}/messages`, { text, ...extra });

describe('opening conversations', () => {
  it('patient and nurse of a PAID booking share one conversation (idempotent); unpaid or foreign bookings are refused', async () => {
    const { bookingId, id } = await paidChat();
    expect((await post(nurse.session, '/conversations', { bookingId })).body.data.id).toBe(id);
    const [a, b] = await Promise.all([
      post(patient, '/conversations', { bookingId }),
      post(patient, '/conversations', { bookingId }),
    ]);
    expect(a.body.data.id).toBe(id);
    expect(b.body.data.id).toBe(id);
    expect(await Conversation.countDocuments()).toBe(1);
    // unpaid booking
    const unpaid = await bookIt(app, patient2, {
      ...args(),
      start: at(D, '14:00'),
      end: at(D, '16:00'),
    });
    const un = await post(patient2, '/conversations', { bookingId: unpaid.booking.body.data.id });
    expect([un.status, un.body.errorCode]).toEqual([422, 'CHAT_NOT_AVAILABLE']);
    // not a participant: patient2, another nurse, admin
    expect((await post(patient2, '/conversations', { bookingId })).status).toBe(404);
    expect((await post(admin, '/conversations', { bookingId })).status).toBe(404);
    expect((await post(patient, '/conversations', { bookingId: 'nope' })).status).toBe(400);
  });

  it('requires authentication and the chat permission (finance approvers have none)', async () => {
    const approver = await createAdmin(app, 'FINANCE_APPROVER');
    expect((await get(approver, '/conversations')).status).toBe(403);
    expect((await request(app).get(`${API}/conversations`)).status).toBe(401);
  });
});

describe('messages', () => {
  it('stores messages with the AUTHENTICATED sender; a spoofed sender is rejected; marks mine relative to the viewer', async () => {
    const { id } = await paidChat();
    const spoof = await send(patient, id, 'hi', { senderId: nurse.session.id });
    expect(spoof.status).toBe(400);
    const r = await send(patient, id, 'Hello nurse');
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      text: 'Hello nurse',
      senderRole: 'PATIENT',
      mine: true,
      type: 'TEXT',
    });
    const m = (await Message.findById(r.body.data.id))!;
    expect(String(m.senderId)).toBe(patient.id);
    const hist = await get(nurse.session, `/conversations/${id}/messages`);
    expect(hist.body.data.items[0]).toMatchObject({ text: 'Hello nurse', mine: false });
    expect(JSON.stringify(hist.body)).not.toContain(patient.id); // no sender ids exposed
  });

  it('only participants can read, send or mark read; other users and admins get 404', async () => {
    const { id } = await paidChat();
    await send(patient, id, 'private');
    for (const who of [patient2, admin]) {
      expect((await get(who, `/conversations/${id}/messages`)).status).toBe(404);
      expect((await send(who, id, 'intrusion')).status).toBe(404);
      expect((await post(who, `/conversations/${id}/read`)).status).toBe(404);
    }
    expect((await get(patient2, '/conversations')).body.data.items).toHaveLength(0);
    expect(await Message.countDocuments()).toBe(1);
  });

  it('validates the text (required, trimmed, maximum length from settings)', async () => {
    const { id } = await paidChat();
    expect((await send(patient, id, '')).status).toBe(400);
    expect((await send(patient, id, '    ')).body.errorCode).toBe('EMPTY_MESSAGE');
    await SettingsService.set('chat.messageMaxLength', 20);
    expect((await send(patient, id, 'x'.repeat(21))).body.errorCode).toBe('MESSAGE_TOO_LONG');
    expect((await send(patient, id, 'x'.repeat(20))).status).toBe(201);
  });

  it('cursor pagination walks the whole history newest-first without gaps or repeats', async () => {
    const { id } = await paidChat();
    for (let i = 1; i <= 7; i++) await send(patient, id, `m${i}`);
    const seen: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < 5; page++) {
      const r = await get(
        nurse.session,
        `/conversations/${id}/messages?limit=3${before ? `&before=${before}` : ''}`,
      );
      seen.push(...r.body.data.items.map((m: { text: string }) => m.text));
      before = r.body.data.nextCursor ?? undefined;
      if (!before) break;
    }
    expect(seen).toEqual(['m7', 'm6', 'm5', 'm4', 'm3', 'm2', 'm1']);
    expect((await get(nurse.session, `/conversations/${id}/messages?before=bad`)).status).toBe(400);
  });

  it('tracks unread counts per user and clears them when read', async () => {
    const { id } = await paidChat();
    await send(patient, id, 'a');
    await send(patient, id, 'b');
    expect((await get(nurse.session, '/conversations/unread-count')).body.data.unread).toBe(2);
    expect((await get(patient, '/conversations/unread-count')).body.data.unread).toBe(0);
    const list = await get(nurse.session, '/conversations');
    expect(list.body.data.items[0]).toMatchObject({
      id,
      unread: 2,
      type: 'BOOKING',
      counterpart: expect.any(String),
    });
    expect(list.body.data.items[0].counterpart).not.toContain(' ' + 'Patient'.repeat(3));
    expect((await post(nurse.session, `/conversations/${id}/read`)).body.data.marked).toBe(2);
    expect((await post(nurse.session, `/conversations/${id}/read`)).body.data.marked).toBe(0);
    expect((await get(nurse.session, '/conversations/unread-count')).body.data.unread).toBe(0);
  });

  it('is idempotent per clientMessageId: concurrent retries create one message, one notification', async () => {
    const { id } = await paidChat();
    const cid = randomUUID();
    const rs = await Promise.all(
      Array.from({ length: 5 }, () => send(patient, id, 'same message', { clientMessageId: cid })),
    );
    expect(rs.every((r) => [200, 201].includes(r.status))).toBe(true);
    expect(rs.filter((r) => !r.body.data.duplicate)).toHaveLength(1);
    expect(new Set(rs.map((r) => r.body.data.id)).size).toBe(1);
    expect(await Message.countDocuments()).toBe(1);
    expect(await Notification.countDocuments({ type: 'NEW_MESSAGE' })).toBe(1);
  });

  it('notifies once per unread burst and never puts the text in a notification', async () => {
    const { id } = await paidChat();
    await send(patient, id, 'secret clinical detail one');
    await send(patient, id, 'secret clinical detail two');
    expect(
      await Notification.countDocuments({ type: 'NEW_MESSAGE', recipientId: nurse.session.id }),
    ).toBe(1);
    expect(JSON.stringify(await Notification.find({ type: 'NEW_MESSAGE' }).lean())).not.toContain(
      'secret clinical',
    );
    await post(nurse.session, `/conversations/${id}/read`);
    await send(patient, id, 'another');
    expect(
      await Notification.countDocuments({ type: 'NEW_MESSAGE', recipientId: nurse.session.id }),
    ).toBe(2);
  });

  it('rate limits message sending per user (setting), without affecting others', async () => {
    const { id } = await paidChat();
    await SettingsService.set('chat.messagesPerMinute', 3);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await send(patient, id, `m${i}`)).status);
    expect(codes).toEqual([201, 201, 201, 429, 429]);
    expect((await send(nurse.session, id, 'the nurse can still reply')).status).toBe(201);
  });
});

describe('support conversations', () => {
  it('a user talks to the support team; any admin sees and answers; other users cannot', async () => {
    const s = await post(patient, '/conversations/support');
    const id = s.body.data.id as string;
    expect((await post(patient, '/conversations/support')).body.data.id).toBe(id);
    await send(patient, id, 'I need help with my booking');
    const adminList = await get(admin, '/conversations');
    expect(adminList.body.data.items).toHaveLength(1);
    expect(adminList.body.data.items[0]).toMatchObject({ id, type: 'SUPPORT', unread: 1 });
    expect((await get(admin, '/conversations/unread-count')).body.data.unread).toBe(1);
    const reply = await send(admin, id, 'Happy to help');
    expect(reply.body.data).toMatchObject({ senderRole: 'ADMIN', mine: true });
    expect((await get(patient, '/conversations/unread-count')).body.data.unread).toBe(1);
    const hist = await get(patient, `/conversations/${id}/messages`);
    expect(hist.body.data.items[0]).toMatchObject({ senderRole: 'ADMIN', mine: false });
    expect((await post(admin, `/conversations/${id}/read`)).body.data.marked).toBe(1);
    // isolation
    expect((await get(patient2, `/conversations/${id}/messages`)).status).toBe(404);
    expect((await get(nurse.session, `/conversations/${id}/messages`)).status).toBe(404);
    expect((await post(admin, '/conversations/support')).status).toBe(403);
    // admins see only SUPPORT conversations, never booking chats
    const b = await paidChat();
    expect((await get(admin, `/conversations/${b.id}/messages`)).status).toBe(404);
    expect(
      (await get(admin, '/conversations')).body.data.items.every(
        (c: { type: string }) => c.type === 'SUPPORT',
      ),
    ).toBe(true);
  });
});

// ------------------------------------------------------------------ Socket.IO
const connect = (token?: string) =>
  new Promise<{ socket: Socket; error?: string }>((resolve) => {
    const socket = connectClient(url, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      auth: token === undefined ? {} : { token },
    });
    sockets.push(socket);
    socket.once('connect', () => resolve({ socket }));
    socket.once('connect_error', (e) => resolve({ socket, error: e.message }));
  });
const emitAck = <T = { ok: boolean; error?: string; data?: unknown }>(
  s: Socket,
  ev: string,
  payload: unknown,
) => new Promise<T>((r) => s.emit(ev, payload, r));
const waitEvent = <T>(s: Socket, ev: string, ms = 2000) =>
  new Promise<T | null>((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    s.once(ev, (d: T) => {
      clearTimeout(t);
      resolve(d);
    });
  });

describe('Socket.IO security', () => {
  it('rejects connections without a valid token, for blocked users and for roles without chat access', async () => {
    expect((await connect()).error).toBe('UNAUTHENTICATED');
    expect((await connect('garbage')).error).toBe('UNAUTHENTICATED');
    expect((await connect(patient.refreshToken)).error).toBe('UNAUTHENTICATED'); // not an access token
    const ok = await connect(patient.accessToken);
    expect(ok.error).toBeUndefined();
    const approver = await createAdmin(app, 'FINANCE_APPROVER');
    expect((await connect(approver.accessToken)).error).toBe('FORBIDDEN');
    await User.updateOne({ _id: patient2.id }, { $set: { isActive: false } });
    expect((await connect(patient2.accessToken)).error).toBe('UNAUTHENTICATED');
  });

  it('room membership is server-controlled: only conversations the user may access can be joined', async () => {
    const { id } = await paidChat();
    const mine = (await connect(patient.accessToken)).socket;
    const stranger = (await connect(patient2.accessToken)).socket;
    expect(await emitAck(mine, 'conversation:join', { conversationId: id })).toEqual({ ok: true });
    expect(await emitAck(stranger, 'conversation:join', { conversationId: id })).toMatchObject({
      ok: false,
      error: 'CONVERSATION_NOT_FOUND',
    });
    expect(await emitAck(stranger, 'conversation:join', { conversationId: '*' })).toMatchObject({
      ok: false,
    });
    expect(await emitAck(stranger, 'conversation:join', {})).toMatchObject({
      ok: false,
      error: 'INVALID_PAYLOAD',
    });
    // clients cannot name rooms directly
    stranger.emit('join', `conv:${id}`);
    stranger.emit('conversation:join', { conversationId: `conv:${id}` });
    await send(patient, id, 'only members receive this');
    expect(await waitEvent(stranger, 'message:new', 500)).toBeNull();
    expect(io.sockets.adapter.rooms.get(`conv:${id}`)?.size).toBe(1);
  });

  it('delivers REST and socket messages to joined members only; the sender comes from the token', async () => {
    const { id } = await paidChat();
    const p = (await connect(patient.accessToken)).socket;
    const n = (await connect(nurse.session.accessToken)).socket;
    const other = (await connect(patient2.accessToken)).socket;
    await emitAck(p, 'conversation:join', { conversationId: id });
    await emitAck(n, 'conversation:join', { conversationId: id });
    await emitAck(other, 'conversation:join', { conversationId: id });

    const gotN = waitEvent<{ text: string; mine: boolean }>(n, 'message:new');
    const gotOther = waitEvent(other, 'message:new', 500);
    const ack = await emitAck<{ ok: boolean; data: { text: string; mine: boolean } }>(
      p,
      'message:send',
      {
        conversationId: id,
        text: 'via socket',
        senderId: nurse.session.id, // spoof attempt: ignored
      },
    );
    expect(ack.ok).toBe(true);
    expect(ack.data).toMatchObject({ text: 'via socket', mine: true, senderRole: 'PATIENT' });
    expect(await gotN).toMatchObject({ text: 'via socket', mine: false });
    expect(await gotOther).toBeNull();
    expect(String((await Message.findOne({ text: 'via socket' }))!.senderId)).toBe(patient.id);

    const gotP = waitEvent<{ text: string; mine: boolean }>(p, 'message:new');
    await send(nurse.session, id, 'via REST');
    expect(await gotP).toMatchObject({ text: 'via REST', mine: false });
  });

  it('rate limits socket sends and refuses sends to conversations the user cannot access', async () => {
    const { id } = await paidChat();
    const p = (await connect(patient.accessToken)).socket;
    expect(await emitAck(p, 'message:send', { conversationId: id })).toMatchObject({
      ok: false,
      error: 'INVALID_PAYLOAD',
    });
    const s2 = (await connect(patient2.accessToken)).socket;
    expect(await emitAck(s2, 'message:send', { conversationId: id, text: 'x' })).toMatchObject({
      ok: false,
      error: 'CONVERSATION_NOT_FOUND',
    });
    await SettingsService.set('chat.messagesPerMinute', 2);
    const results = [];
    for (let i = 0; i < 4; i++)
      results.push((await emitAck(p, 'message:send', { conversationId: id, text: `s${i}` })).ok);
    expect(results).toEqual([true, true, false, false]);
    expect(await Message.countDocuments()).toBe(2);
  });

  it('never logs message bodies', async () => {
    const { id } = await paidChat();
    const spies = (['info', 'warn', 'error', 'debug', 'trace'] as const).map((l) =>
      jest.spyOn(logger, l),
    );
    const p = (await connect(patient.accessToken)).socket;
    await emitAck(p, 'conversation:join', { conversationId: id });
    await emitAck(p, 'message:send', { conversationId: id, text: 'UNIQUE-SENSITIVE-BODY-123' });
    await send(patient, id, 'UNIQUE-SENSITIVE-BODY-456');
    const logged = inspect(
      spies.flatMap((s) => s.mock.calls),
      { depth: 4, maxStringLength: 100_000 },
    );
    expect(logged).not.toContain('UNIQUE-SENSITIVE-BODY');
    void register;
  });
});
