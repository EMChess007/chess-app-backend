import { randomUUID } from 'node:crypto';
import type { Server } from 'socket.io';
import { generateChess960Position } from './chess960.js';
import { RoomChessEngine, START_FEN, type AppliedMove, type PieceColor } from './RoomChessEngine.js';
import type {
  Ack,
  GameOverPayload,
  GameOverReason,
  MakeMovePayload,
  OpponentMovePayload,
  RejoinGamePayload,
  RejoinStatePayload,
  TimeControl,
} from './types.js';

/** How long a disconnected player has to reconnect before their opponent is awarded the win
 * on abandonment — independent of (and in addition to) the normal clock/timeout mechanism, so
 * a disconnect with minutes still on the clock doesn't force the opponent to wait that long. */
const ABANDONMENT_GRACE_MS = 45_000;

interface PlayerSlot {
  socketId: string | null;
  userId: string | null;
  playerToken: string;
  disconnectedAt: number | null;
  abandonTimer: NodeJS.Timeout | null;
}

interface Room {
  id: string;
  engine: RoomChessEngine;
  initialFen: string;
  chess960: boolean;
  timeControl: TimeControl;
  moves: AppliedMove[];
  whiteMs: number;
  blackMs: number;
  /** Server clock timestamp (Date.now()) of the last applied move, or room creation if none
   * yet — the sole source of truth for "how long has the mover been thinking", since the
   * client's own timing can't be trusted. */
  lastMoveAt: number;
  /** Fires when the side to move would hit 0 — rescheduled after every move. */
  clockTimer: NodeJS.Timeout | null;
  players: Record<PieceColor, PlayerSlot>;
  status: 'active' | 'finished';
}

export interface CreateRoomParams {
  white: { socketId: string; userId: string | null };
  black: { socketId: string; userId: string | null };
  timeControl: TimeControl;
  chess960: boolean;
}

export interface CreateRoomResult {
  roomId: string;
  whitePlayerToken: string;
  blackPlayerToken: string;
  fen: string;
  whiteMs: number;
  blackMs: number;
}

function initialClockMs(timeControl: TimeControl): number {
  // A non-positive initialSeconds means "no clock" (matches the mobile app's "Χωρίς χρόνο"
  // time control) — represented as a very large remaining time rather than 0, and the timeout
  // timer is never scheduled for it (see scheduleTimeout), so it's effectively never checked.
  return timeControl.initialSeconds > 0 ? timeControl.initialSeconds * 1000 : Number.MAX_SAFE_INTEGER;
}

/**
 * Owns every active game room: authoritative board state (via RoomChessEngine), server-side
 * clocks, and connection tracking. One instance per process, constructed with the Socket.IO
 * server it should push events through.
 */
export class RoomManager {
  private rooms = new Map<string, Room>();
  private socketToRoom = new Map<string, { roomId: string; color: PieceColor }>();

  constructor(private io: Server) {}

  createRoom(params: CreateRoomParams): CreateRoomResult {
    const id = randomUUID();
    const initialFen = params.chess960 ? generateChess960Position() : START_FEN;
    const engine = new RoomChessEngine(initialFen, { chess960: params.chess960, initialFen });
    const ms = initialClockMs(params.timeControl);
    const whitePlayerToken = randomUUID();
    const blackPlayerToken = randomUUID();

    const room: Room = {
      id,
      engine,
      initialFen,
      chess960: params.chess960,
      timeControl: params.timeControl,
      moves: [],
      whiteMs: ms,
      blackMs: ms,
      lastMoveAt: Date.now(),
      clockTimer: null,
      players: {
        w: { socketId: params.white.socketId, userId: params.white.userId, playerToken: whitePlayerToken, disconnectedAt: null, abandonTimer: null },
        b: { socketId: params.black.socketId, userId: params.black.userId, playerToken: blackPlayerToken, disconnectedAt: null, abandonTimer: null },
      },
      status: 'active',
    };

    this.rooms.set(id, room);
    this.socketToRoom.set(params.white.socketId, { roomId: id, color: 'w' });
    this.socketToRoom.set(params.black.socketId, { roomId: id, color: 'b' });

    this.scheduleTimeout(room);
    return { roomId: id, whitePlayerToken, blackPlayerToken, fen: initialFen, whiteMs: ms, blackMs: ms };
  }

  /** Validates and applies a move submitted by `socketId` — the single point where a client's
   * claim about a move becomes real game state. Rejects anything chess.js (or the Chess960
   * castling logic) doesn't accept, and anything from a socket that isn't actually the side to
   * move in that room. */
  applyMove(socketId: string, payload: MakeMovePayload): Ack<{ fen: string; san: string; turn: PieceColor; whiteMs: number; blackMs: number }> {
    const location = this.socketToRoom.get(socketId);
    if (!location || location.roomId !== payload.roomId) {
      return { ok: false, error: 'Δεν βρέθηκε ενεργό παιχνίδι για αυτή τη σύνδεση.' };
    }
    const room = this.rooms.get(location.roomId);
    if (!room || room.status !== 'active') {
      return { ok: false, error: 'Το παιχνίδι δεν είναι πια ενεργό.' };
    }

    const mover = location.color;
    if (room.engine.getTurn() !== mover) {
      return { ok: false, error: 'Δεν είναι η σειρά σου.' };
    }

    const result = room.engine.move(payload.from, payload.to, payload.promotion);
    if (!result) {
      return { ok: false, error: 'Μη έγκυρη κίνηση.' };
    }

    const now = Date.now();
    const elapsed = now - room.lastMoveAt;
    const incrementMs = room.timeControl.incrementSeconds * 1000;
    if (mover === 'w') {
      room.whiteMs = Math.max(0, room.whiteMs - elapsed) + incrementMs;
    } else {
      room.blackMs = Math.max(0, room.blackMs - elapsed) + incrementMs;
    }
    room.lastMoveAt = now;
    room.moves.push(result);

    const newTurn = room.engine.getTurn();
    const opponentColor: PieceColor = mover === 'w' ? 'b' : 'w';
    const opponentSlot = room.players[opponentColor];

    if (opponentSlot.socketId) {
      const movePayload: OpponentMovePayload = {
        from: result.from,
        to: result.to,
        promotion: result.promotion,
        san: result.san,
        fen: room.engine.getFen(),
        turn: newTurn,
        whiteMs: room.whiteMs,
        blackMs: room.blackMs,
      };
      this.io.to(opponentSlot.socketId).emit('opponent_move', movePayload);
    }

    if (room.engine.isGameOver()) {
      const status = room.engine.getStatus();
      const reason: GameOverReason = status === 'checkmate' ? 'checkmate' : status === 'stalemate' ? 'stalemate' : 'draw';
      const winner: PieceColor | null = status === 'checkmate' ? mover : null;
      this.endGame(room, reason, winner);
    } else {
      this.scheduleTimeout(room);
    }

    return { ok: true, fen: room.engine.getFen(), san: result.san, turn: newTurn, whiteMs: room.whiteMs, blackMs: room.blackMs };
  }

  rejoin(socketId: string, payload: RejoinGamePayload): Ack<{ state: RejoinStatePayload }> {
    const room = this.rooms.get(payload.roomId);
    if (!room || room.status !== 'active') {
      return { ok: false, error: 'Το παιχνίδι δεν βρέθηκε ή έχει ήδη τελειώσει.' };
    }

    let color: PieceColor | null = null;
    if (room.players.w.playerToken === payload.playerToken) color = 'w';
    else if (room.players.b.playerToken === payload.playerToken) color = 'b';
    if (!color) {
      return { ok: false, error: 'Μη έγκυρο playerToken.' };
    }

    const slot = room.players[color];
    if (slot.abandonTimer) {
      clearTimeout(slot.abandonTimer);
      slot.abandonTimer = null;
    }
    slot.socketId = socketId;
    slot.disconnectedAt = null;
    this.socketToRoom.set(socketId, { roomId: room.id, color });

    const opponentColor: PieceColor = color === 'w' ? 'b' : 'w';
    const opponentSlot = room.players[opponentColor];
    if (opponentSlot.socketId) {
      this.io.to(opponentSlot.socketId).emit('opponent_reconnected', {});
    }

    return {
      ok: true,
      state: {
        fen: room.engine.getFen(),
        turn: room.engine.getTurn(),
        color,
        timeControl: room.timeControl,
        isChess960: room.chess960,
        whiteMs: room.whiteMs,
        blackMs: room.blackMs,
        moves: room.moves,
        opponentConnected: opponentSlot.socketId !== null,
      },
    };
  }

  /** Called from the io-level 'disconnect' handler for every socket, regardless of whether it
   * was actually in a room — a no-op if it wasn't. */
  handleDisconnect(socketId: string): void {
    const location = this.socketToRoom.get(socketId);
    if (!location) return;
    this.socketToRoom.delete(socketId);

    const room = this.rooms.get(location.roomId);
    if (!room || room.status !== 'active') return;

    const slot = room.players[location.color];
    if (slot.socketId !== socketId) return; // a newer connection already replaced this one

    slot.socketId = null;
    slot.disconnectedAt = Date.now();

    const opponentColor: PieceColor = location.color === 'w' ? 'b' : 'w';
    const opponentSlot = room.players[opponentColor];
    if (opponentSlot.socketId) {
      this.io.to(opponentSlot.socketId).emit('opponent_disconnected', { graceSeconds: ABANDONMENT_GRACE_MS / 1000 });
    }

    slot.abandonTimer = setTimeout(() => {
      if (room.status !== 'active') return;
      this.endGame(room, 'abandonment', opponentColor);
    }, ABANDONMENT_GRACE_MS);
  }

  private scheduleTimeout(room: Room): void {
    if (room.clockTimer) {
      clearTimeout(room.clockTimer);
      room.clockTimer = null;
    }
    if (room.timeControl.initialSeconds <= 0) return; // unlimited time control — nothing to schedule

    const turn = room.engine.getTurn();
    const remaining = turn === 'w' ? room.whiteMs : room.blackMs;
    room.clockTimer = setTimeout(() => {
      if (room.status !== 'active' || room.engine.getTurn() !== turn) return;
      const winner: PieceColor = turn === 'w' ? 'b' : 'w';
      this.endGame(room, 'timeout', winner);
    }, Math.max(0, remaining));
  }

  private endGame(room: Room, reason: GameOverReason, winner: PieceColor | null): void {
    room.status = 'finished';
    if (room.clockTimer) clearTimeout(room.clockTimer);

    for (const color of ['w', 'b'] as const) {
      const slot = room.players[color];
      if (slot.abandonTimer) clearTimeout(slot.abandonTimer);
      if (slot.socketId) {
        const payload: GameOverPayload = { reason, winner };
        this.io.to(slot.socketId).emit('game_over', payload);
        this.socketToRoom.delete(slot.socketId);
      }
    }

    this.rooms.delete(room.id);
  }
}
