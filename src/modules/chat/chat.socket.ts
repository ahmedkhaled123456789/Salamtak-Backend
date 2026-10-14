import type http from 'node:http';
import { Server, type Socket } from 'socket.io';
import { hasPermission, type Role } from '../../common/constants/rbac';
import { verifyAccessToken } from '../../common/utils/jwt';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { UserService } from '../users';
import { ChatService, setChatPublisher, toMessageDTO, type Viewer } from './chat.service';

const room = (conversationId: string) => `conv:${conversationId}`;
type Ack = (r: { ok: boolean; error?: string; data?: unknown }) => void;
const safeAck = (ack: unknown): Ack => (typeof ack === 'function' ? (ack as Ack) : () => undefined);
const errCode = (e: unknown) => (e as { errorCode?: string }).errorCode ?? 'ERROR';

/**
 * Realtime delivery for chat. MongoDB stays the source of truth: every message is stored first (via
 * ChatService, the same path as REST), the socket only pushes it. Security:
 *  - the connection is authenticated with the SAME RS256 access token and the user is re-checked in
 *    the database (blocked users / revoked tokens cannot connect);
 *  - room membership is decided by the SERVER: a client asks to join and ChatService.access() must
 *    approve it; there is no way to name an arbitrary room;
 *  - the sender is always the authenticated user; sends share the REST per-user rate limit;
 *  - message bodies are never logged.
 */
export function attachChatSocket(server: http.Server): Server {
  const io = new Server(server, {
    path: '/socket.io',
    cors: { origin: env.corsOrigins.length ? env.corsOrigins : false, credentials: true },
    maxHttpBufferSize: 32 * 1024, // text only
    serveClient: false,
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== 'string' || !token) return next(new Error('UNAUTHENTICATED'));
      const payload = verifyAccessToken(token);
      const subject = await UserService.getAuthSubject(payload.sub);
      if (!subject || !subject.isActive || subject.pv !== payload.pv)
        return next(new Error('UNAUTHENTICATED'));
      if (!hasPermission(subject.role as Role, 'chat:use')) return next(new Error('FORBIDDEN'));
      socket.data.viewer = { userId: subject.id, role: subject.role } satisfies Viewer;
      next();
    } catch {
      next(new Error('UNAUTHENTICATED'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const viewer = socket.data.viewer as Viewer;
    void socket.join(`user:${viewer.userId}`); // server-controlled personal room

    socket.on('conversation:join', async (payload: unknown, ack?: unknown) => {
      const cb = safeAck(ack);
      try {
        const id = (payload as { conversationId?: unknown })?.conversationId;
        if (typeof id !== 'string') return cb({ ok: false, error: 'INVALID_PAYLOAD' });
        const c = await ChatService.access(viewer, id); // throws 404 for anyone not allowed
        await socket.join(room(String(c._id)));
        cb({ ok: true });
      } catch (e) {
        cb({ ok: false, error: errCode(e) });
      }
    });

    socket.on('conversation:leave', async (payload: unknown, ack?: unknown) => {
      const id = (payload as { conversationId?: unknown })?.conversationId;
      if (typeof id === 'string') await socket.leave(room(id));
      safeAck(ack)({ ok: true });
    });

    socket.on('message:send', async (payload: unknown, ack?: unknown) => {
      const cb = safeAck(ack);
      try {
        const p = payload as {
          conversationId?: unknown;
          text?: unknown;
          clientMessageId?: unknown;
        };
        if (typeof p?.conversationId !== 'string' || typeof p?.text !== 'string')
          return cb({ ok: false, error: 'INVALID_PAYLOAD' });
        // NOTE: any senderId in the payload is ignored on purpose
        await ChatService.consumeSendBudget(viewer.userId);
        const r = await ChatService.send(viewer, p.conversationId, {
          text: p.text,
          clientMessageId: typeof p.clientMessageId === 'string' ? p.clientMessageId : undefined,
        });
        cb({
          ok: true,
          data: { ...toMessageDTO(r.message, viewer.userId), duplicate: r.duplicate },
        });
      } catch (e) {
        cb({ ok: false, error: errCode(e) });
      }
    });

    socket.on('conversation:read', async (payload: unknown, ack?: unknown) => {
      const cb = safeAck(ack);
      try {
        const id = (payload as { conversationId?: unknown })?.conversationId;
        if (typeof id !== 'string') return cb({ ok: false, error: 'INVALID_PAYLOAD' });
        cb({ ok: true, data: { marked: await ChatService.markRead(viewer, id) } });
      } catch (e) {
        cb({ ok: false, error: errCode(e) });
      }
    });
  });

  // REST and socket sends both end here: only members of the room receive it
  setChatPublisher((event, conversationId, payload) => {
    if (event === 'message:new') {
      const m = payload as Parameters<typeof toMessageDTO>[0];
      // each member gets the message relative to THEM (`mine`)
      void io
        .in(room(conversationId))
        .fetchSockets()
        .then((sockets) => {
          for (const s of sockets)
            s.emit('message:new', toMessageDTO(m, (s.data.viewer as Viewer).userId));
        });
    } else {
      io.to(room(conversationId)).emit(event, payload);
    }
  });
  logger.info('Chat socket attached');
  return io;
}
