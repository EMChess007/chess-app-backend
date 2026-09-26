import type { Server, Socket } from 'socket.io';
import { verifyToken } from '../lib/jwt.js';
import { ChallengeManager } from './challenges.js';
import { Matchmaker } from './matchmaking.js';
import { RoomManager } from './rooms.js';
import type {
  Ack,
  CreateChallengePayload,
  JoinChallengePayload,
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

interface PairableEntry {
  socketId: string;
  userId: string | null;
  timeControl: TimeControl;
  timeControlLabel?: string;
  isChess960: boolean;
}

export function registerSocketHandlers(io: Server): void {
  const matchmaker = new Matchmaker();
  const rooms = new RoomManager(io);
  const challenges = new ChallengeManager();

  /** Creates a room for two already-paired entries (from the anonymous queue or a challenge code
   * alike) and pushes `match_found` to both — the one piece of logic join_queue's pairing and
   * join_challenge's pairing both need identically. */
  function pairAndCreateRoom(a: PairableEntry, b: PairableEntry): void {
    // Coin flip for colors, per "random or alternating" — a simple 50/50 is enough for now.
    const aIsWhite = Math.random() < 0.5;
    const whiteEntry = aIsWhite ? a : b;
    const blackEntry = aIsWhite ? b : a;

    const created = rooms.createRoom({
      white: { socketId: whiteEntry.socketId, userId: whiteEntry.userId },
      black: { socketId: blackEntry.socketId, userId: blackEntry.userId },
      timeControl: a.timeControl,
      timeControlLabel: a.timeControlLabel ?? b.timeControlLabel,
      chess960: a.isChess960,
    });

    const basePayload = {
      roomId: created.roomId,
      timeControl: a.timeControl,
      isChess960: a.isChess960,
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
  }

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
        timeControlLabel: typeof payload.timeControlLabel === 'string' ? payload.timeControlLabel : undefined,
        isChess960: Boolean(payload.isChess960),
        rating: typeof payload.rating === 'number' ? payload.rating : undefined,
        queuedAt: Date.now(),
      };

      const opponent = matchmaker.join(entry);
      ack?.({ ok: true });
      if (!opponent) return;
      pairAndCreateRoom(entry, opponent);
    });

    socket.on('leave_queue', (_payload: unknown, ack?: (res: Ack) => void) => {
      matchmaker.leave(socket.id);
      ack?.({ ok: true });
    });

    socket.on('create_challenge', (payload: CreateChallengePayload, ack?: (res: Ack<{ code: string }>) => void) => {
      if (!isValidTimeControl(payload?.timeControl)) {
        ack?.({ ok: false, error: 'Invalid time control.' });
        return;
      }
      const challenge = challenges.create({
        creatorSocketId: socket.id,
        creatorUserId: userId,
        timeControl: payload.timeControl,
        timeControlLabel: typeof payload.timeControlLabel === 'string' ? payload.timeControlLabel : undefined,
        isChess960: Boolean(payload.isChess960),
      });
      ack?.({ ok: true, code: challenge.code });
    });

    socket.on('cancel_challenge', (payload: JoinChallengePayload, ack?: (res: Ack) => void) => {
      const challenge = challenges.find(payload?.code);
      if (!challenge || challenge.creatorSocketId !== socket.id) {
        ack?.({ ok: false, error: 'Challenge not found.' });
        return;
      }
      challenges.remove(payload.code);
      ack?.({ ok: true });
    });

    socket.on('join_challenge', (payload: JoinChallengePayload, ack?: (res: Ack) => void) => {
      const code = typeof payload?.code === 'string' ? payload.code.trim().toUpperCase() : '';
      const challenge = challenges.find(code);
      if (!challenge) {
        ack?.({ ok: false, error: 'That challenge code was not found or has expired.' });
        return;
      }
      if (challenge.creatorSocketId === socket.id) {
        ack?.({ ok: false, error: "You can't join your own challenge." });
        return;
      }
      challenges.remove(code);
      ack?.({ ok: true });
      pairAndCreateRoom(
        {
          socketId: challenge.creatorSocketId,
          userId: challenge.creatorUserId,
          timeControl: challenge.timeControl,
          timeControlLabel: challenge.timeControlLabel,
          isChess960: challenge.isChess960,
        },
        { socketId: socket.id, userId, timeControl: challenge.timeControl, timeControlLabel: challenge.timeControlLabel, isChess960: challenge.isChess960 }
      );
    });

    socket.on('list_active_games', async (_payload: unknown, ack?: (res: Ack<{ games: Awaited<ReturnType<typeof rooms.listActiveGames>> }>) => void) => {
      const games = await rooms.listActiveGames();
      ack?.({ ok: true, games });
    });

    socket.on('spectate_game', (payload: { roomId: string }, ack?: (res: Ack) => void) => {
      const result = rooms.spectate(socket.id, payload?.roomId);
      ack?.(result);
    });

    socket.on('stop_spectating', (_payload: unknown, ack?: (res: Ack) => void) => {
      rooms.stopSpectating(socket.id);
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
      challenges.removeByCreator(socket.id);
      rooms.handleDisconnect(socket.id);
      console.log(`[socket] disconnected ${socket.id}`);
    });
  });
}
