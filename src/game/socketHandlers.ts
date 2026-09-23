import type { Server, Socket } from 'socket.io';
import { verifyToken } from '../lib/jwt.js';
import { Matchmaker } from './matchmaking.js';
import { RoomManager } from './rooms.js';
import type {
  Ack,
  JoinQueuePayload,
  MakeMovePayload,
  MatchFoundPayload,
  OfferDrawPayload,
  RejoinGamePayload,
  ResignPayload,
  RespondDrawPayload,
  SendChatPayload,
  TimeControl,
} from './types.js';

/** Optional: a logged-in user can pass their existing JWT via `socket.handshake.auth.token` to
 * be identified by userId (for future rating/history use); guests simply omit it and play
 * anonymously — auth was never made mandatory for gameplay elsewhere in this app either. */
function extractUserId(socket: Socket): string | null {
  const token = socket.handshake.auth?.token;
  if (typeof token !== 'string' || !token) return null;
  try {
    return verifyToken(token).userId;
  } catch {
    return null;
  }
}

function isValidTimeControl(value: unknown): value is TimeControl {
  if (typeof value !== 'object' || value === null) return false;
  const tc = value as Record<string, unknown>;
  return (
    typeof tc.initialSeconds === 'number' &&
    tc.initialSeconds >= 0 &&
    typeof tc.incrementSeconds === 'number' &&
    tc.incrementSeconds >= 0
  );
}

export function registerSocketHandlers(io: Server): void {
  const matchmaker = new Matchmaker();
  const rooms = new RoomManager(io);

  io.on('connection', (socket) => {
    const userId = extractUserId(socket);
    console.log(`[socket] connected ${socket.id}${userId ? ` (user ${userId})` : ' (guest)'} — queue size ${matchmaker.size()}`);

    socket.on('join_queue', (payload: JoinQueuePayload, ack?: (res: Ack) => void) => {
      if (!isValidTimeControl(payload?.timeControl)) {
        ack?.({ ok: false, error: 'Invalid time control.' });
        return;
      }

      const entry = {
        socketId: socket.id,
        userId,
        timeControl: payload.timeControl,
        isChess960: Boolean(payload.isChess960),
        rating: typeof payload.rating === 'number' ? payload.rating : undefined,
        queuedAt: Date.now(),
      };

      const opponent = matchmaker.join(entry);
      ack?.({ ok: true });
      if (!opponent) return;

      // Coin flip for colors, per "random or alternating" — a simple 50/50 is enough for now.
      const entryIsWhite = Math.random() < 0.5;
      const whiteEntry = entryIsWhite ? entry : opponent;
      const blackEntry = entryIsWhite ? opponent : entry;

      const created = rooms.createRoom({
        white: { socketId: whiteEntry.socketId, userId: whiteEntry.userId },
        black: { socketId: blackEntry.socketId, userId: blackEntry.userId },
        timeControl: entry.timeControl,
        chess960: entry.isChess960,
      });

      const basePayload = {
        roomId: created.roomId,
        timeControl: entry.timeControl,
        isChess960: entry.isChess960,
        fen: created.fen,
        whiteMs: created.whiteMs,
        blackMs: created.blackMs,
      };
      const whitePayload: MatchFoundPayload = {
        ...basePayload,
        color: 'w',
        playerToken: created.whitePlayerToken,
        opponent: { userId: blackEntry.userId },
      };
      const blackPayload: MatchFoundPayload = {
        ...basePayload,
        color: 'b',
        playerToken: created.blackPlayerToken,
        opponent: { userId: whiteEntry.userId },
      };

      io.to(whiteEntry.socketId).emit('match_found', whitePayload);
      io.to(blackEntry.socketId).emit('match_found', blackPayload);
      console.log(`[socket] match_found room=${created.roomId} white=${whiteEntry.socketId} black=${blackEntry.socketId}`);
    });

    socket.on('leave_queue', (_payload: unknown, ack?: (res: Ack) => void) => {
      matchmaker.leave(socket.id);
      ack?.({ ok: true });
    });

    socket.on('make_move', (payload: MakeMovePayload, ack?: (res: Ack) => void) => {
      const result = rooms.applyMove(socket.id, payload);
      ack?.(result);
    });

    socket.on('rejoin_game', (payload: RejoinGamePayload, ack?: (res: Ack) => void) => {
      const result = rooms.rejoin(socket.id, payload);
      ack?.(result);
    });

    socket.on('resign', (payload: ResignPayload, ack?: (res: Ack) => void) => {
      ack?.(rooms.resign(socket.id, payload?.roomId));
    });

    socket.on('offer_draw', (payload: OfferDrawPayload, ack?: (res: Ack) => void) => {
      ack?.(rooms.offerDraw(socket.id, payload?.roomId));
    });

    socket.on('respond_draw', (payload: RespondDrawPayload, ack?: (res: Ack) => void) => {
      ack?.(rooms.respondToDraw(socket.id, payload?.roomId, Boolean(payload?.accept)));
    });

    socket.on('send_chat', (payload: SendChatPayload, ack?: (res: Ack) => void) => {
      ack?.(rooms.sendChatMessage(socket.id, payload?.roomId, typeof payload?.text === 'string' ? payload.text : ''));
    });

    socket.on('disconnect', () => {
      matchmaker.leave(socket.id);
      rooms.handleDisconnect(socket.id);
      console.log(`[socket] disconnected ${socket.id}`);
    });
  });
}
