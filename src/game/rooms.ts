import { randomUUID } from 'node:crypto';
import type { Server } from 'socket.io';
import { prisma } from '../lib/prisma.js';
import { generateChess960Position } from './chess960.js';
import { buildRedactedFen, getFogOfWarWinner, getVisibleSquares, redactMoveHistory } from './fogOfWar.js';
import { getAtomicKingWinner, isAtomicThreefoldRepetition } from './atomic.js';
import { describeGiveawayRejection, getGiveawayWinner, isLegalGiveawayMove } from './giveaway.js';
import { buildPgn } from './pgn.js';
import { RoomChessEngine, START_FEN, type AppliedMove, type PieceColor } from './RoomChessEngine.js';
import type {
  ActiveGameSummary,
  Ack,
  ChatMessagePayload,
  DrawOfferedPayload,
  GameOverPayload,
  GameOverReason,
  MakeMovePayload,
  OpponentMovePayload,
  RejoinGamePayload,
  RejoinStatePayload,
  SpectateStatePayload,
  SpectatorMovePayload,
  TimeControl,
} from './types.js';

/** How long a disconnected player has to reconnect before their opponent is awarded the win
 * on abandonment — independent of (and in addition to) the normal clock/timeout mechanism, so
 * a disconnect with minutes still on the clock doesn't force the opponent to wait that long. */
const ABANDONMENT_GRACE_MS = 45_000;

/** Minimum time a player must wait after a draw offer (whether accepted, declined, or still
 * unanswered) before sending another one — the simplest possible spam guard, per-player. */
const DRAW_OFFER_COOLDOWN_MS = 30_000;

const CHAT_MAX_LENGTH = 500;

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
  kingOfTheHill: boolean;
  threeCheck: boolean;
  setupChess: boolean;
  fogOfWar: boolean;
  giveaway: boolean;
  atomic: boolean;
  /** Atomic only: the FEN of the starting position and after every move, for the history-based threefold
   * repetition draw (chess.js cannot see repetitions here — the Atomic engine is not chess.js). */
  atomicFens: string[];
  timeControl: TimeControl;
  /** Display label for `timeControl` (e.g. "10 min"), for the saved game-history row — see
   * JoinQueuePayload.timeControlLabel. */
  timeControlLabel: string;
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
  /** The color that currently has an outstanding, unanswered draw offer, if any — at most one
   * offer may be pending at a time (see offerDraw). */
  pendingDrawOfferBy: PieceColor | null;
  /** Server timestamp of each color's most recent draw offer, for the cooldown in offerDraw. */
  lastDrawOfferAt: Partial<Record<PieceColor, number>>;
  /** Sockets watching this game read-only (see spectate) — every active game is spectatable by
   * default, same as Lichess's own default. */
  spectators: Set<string>;
  /** Set only for a room created on behalf of TournamentManager (see tournaments.ts) — called
   * once, right after this room's own game_over notifications go out, so the tournament can
   * update points and pair up whoever's newly free. Kept as a plain optional callback rather than
   * importing TournamentManager here, so this module stays unaware tournaments exist at all. */
  onFinished?: (winner: PieceColor | null) => void;
}

export interface CreateRoomParams {
  white: { socketId: string; userId: string | null };
  black: { socketId: string; userId: string | null };
  timeControl: TimeControl;
  timeControlLabel?: string;
  chess960: boolean;
  kingOfTheHill: boolean;
  threeCheck: boolean;
  setupChess: boolean;
  fogOfWar: boolean;
  giveaway: boolean;
  atomic: boolean;
  /** Required when `setupChess` is true — the merged, already-validated starting position built by
   * both players' armies. Every other variant's production caller omits it and still self-generates
   * its own starting position (classical, or a random Chess960 back rank) as before; the regression
   * scripts (e.g. scripts/test-giveaway.mjs) pass one to start a room from a hand-built position. */
  initialFen?: string;
  /** See Room.onFinished. */
  onFinished?: (winner: PieceColor | null) => void;
}

function defaultTimeControlLabel(tc: TimeControl): string {
  if (tc.initialSeconds <= 0) return 'No time limit';
  const minutes = Math.round(tc.initialSeconds / 60);
  return tc.incrementSeconds > 0 ? `${minutes} | ${tc.incrementSeconds}` : `${minutes} min`;
}

export interface CreateRoomResult {
  roomId: string;
  whitePlayerToken: string;
  blackPlayerToken: string;
  fen: string;
  whiteMs: number;
  blackMs: number;
  /** Fog of War only — each color's own redacted view of the starting position, for the very
   * first `match_found` payload: even the classical starting position isn't fully visible to
   * either side under this variant's visibility rule (nothing on the back rank is reachable yet),
   * so `fen` above (the true position) is never what either client should actually be shown.
   * Undefined outside Fog of War. */
  whiteView?: { fen: string; visibleSquares: string[] };
  blackView?: { fen: string; visibleSquares: string[] };
}

function initialClockMs(timeControl: TimeControl): number {
  // A non-positive initialSeconds means "no clock" (matches the mobile app's "No time limit"
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
  private socketToSpectatingRoom = new Map<string, string>();

  constructor(private io: Server) {}

  createRoom(params: CreateRoomParams): CreateRoomResult {
    const id = randomUUID();
    const initialFen = params.initialFen ?? (params.chess960 ? generateChess960Position() : START_FEN);
    const engine = new RoomChessEngine(initialFen, { chess960: params.chess960, initialFen, giveaway: params.giveaway, atomic: params.atomic });
    const ms = initialClockMs(params.timeControl);
    const whitePlayerToken = randomUUID();
    const blackPlayerToken = randomUUID();

    const room: Room = {
      id,
      engine,
      initialFen,
      chess960: params.chess960,
      kingOfTheHill: params.kingOfTheHill,
      threeCheck: params.threeCheck,
      setupChess: params.setupChess,
      fogOfWar: params.fogOfWar,
      giveaway: params.giveaway,
      atomic: params.atomic,
      atomicFens: [initialFen],
      timeControl: params.timeControl,
      timeControlLabel: params.timeControlLabel ?? defaultTimeControlLabel(params.timeControl),
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
      pendingDrawOfferBy: null,
      lastDrawOfferAt: {},
      spectators: new Set(),
      onFinished: params.onFinished,
    };

    this.rooms.set(id, room);
    this.socketToRoom.set(params.white.socketId, { roomId: id, color: 'w' });
    this.socketToRoom.set(params.black.socketId, { roomId: id, color: 'b' });

    this.scheduleTimeout(room);
    const result: CreateRoomResult = { roomId: id, whitePlayerToken, blackPlayerToken, fen: initialFen, whiteMs: ms, blackMs: ms };
    if (params.fogOfWar) {
      result.whiteView = { fen: buildRedactedFen(engine, 'w'), visibleSquares: [...getVisibleSquares(engine, 'w')] };
      result.blackView = { fen: buildRedactedFen(engine, 'b'), visibleSquares: [...getVisibleSquares(engine, 'b')] };
    }
    return result;
  }

  /** Validates and applies a move submitted by `socketId` — the single point where a client's
   * claim about a move becomes real game state. Rejects anything chess.js (or the Chess960
   * castling logic) doesn't accept, and anything from a socket that isn't actually the side to
   * move in that room. */
  applyMove(
    socketId: string,
    payload: MakeMovePayload
  ): Ack<{ fen: string; san: string; turn: PieceColor; whiteMs: number; blackMs: number; visibleSquares?: string[] }> {
    const location = this.socketToRoom.get(socketId);
    if (!location || location.roomId !== payload.roomId) {
      return { ok: false, error: 'No active game found for this connection.' };
    }
    const room = this.rooms.get(location.roomId);
    if (!room || room.status !== 'active') {
      return { ok: false, error: 'The game is no longer active.' };
    }

    const mover = location.color;
    if (room.engine.getTurn() !== mover) {
      return { ok: false, error: "It's not your turn." };
    }

    const opponentColor: PieceColor = mover === 'w' ? 'b' : 'w';
    // Fog of War only — needed BEFORE the move is applied, to later decide (together with the
    // post-move visibility) whether the opponent actually witnessed it — see
    // redactMoveHistory's own pre/post-visibility-union rationale (mobile app's fogOfWar.ts).
    const opponentVisibleBefore = room.fogOfWar ? getVisibleSquares(room.engine, opponentColor) : null;

    // Giveaway: the server is the authority on mandatory capture — a move that is not in the legal
    // Giveaway set (any non-capturing move while a capture exists, castling, a wrong promotion piece...)
    // is rejected here BEFORE it can touch the position; chess.js's own move() would also refuse
    // king captures and king promotion, so Giveaway applies through movePseudoLegal like Fog of War.
    if (room.giveaway && !isLegalGiveawayMove(room.engine, payload.from, payload.to, payload.promotion)) {
      return { ok: false, error: describeGiveawayRejection(room.engine) };
    }

    // A king promotion only exists in Giveaway; chess.js would refuse it for the other variants too, but
    // rejecting it explicitly keeps the wire type's 'k' from ever reaching move().
    if (!room.giveaway && payload.promotion === 'k') {
      return { ok: false, error: 'Invalid move.' };
    }

    const result =
      room.fogOfWar || room.giveaway
        ? room.engine.movePseudoLegal(payload.from, payload.to, payload.promotion)
        : room.engine.move(payload.from, payload.to, payload.promotion as 'n' | 'b' | 'r' | 'q' | undefined);
    if (!result) {
      return { ok: false, error: 'Invalid move.' };
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
    if (room.atomic) room.atomicFens.push(room.engine.getFen());

    const newTurn = room.engine.getTurn();
    const opponentSlot = room.players[opponentColor];
    let moverVisibleSquares: string[] | undefined;

    if (room.fogOfWar) {
      const opponentVisibleAfter = getVisibleSquares(room.engine, opponentColor);
      const revealedToOpponent = opponentVisibleBefore!.has(result.to) || opponentVisibleAfter.has(result.to);
      const opponentPayload: OpponentMovePayload = {
        ...(revealedToOpponent ? { from: result.from, to: result.to, promotion: result.promotion, san: result.san } : {}),
        fen: buildRedactedFen(room.engine, opponentColor),
        turn: newTurn,
        whiteMs: room.whiteMs,
        blackMs: room.blackMs,
        visibleSquares: [...opponentVisibleAfter],
      };
      if (opponentSlot.socketId) {
        this.io.to(opponentSlot.socketId).emit('opponent_move', opponentPayload);
      }
      // Spectators always see the full true position (see fogOfWar.ts's design notes) — never
      // redacted, regardless of either player's own visibility.
      const spectatorPayload: SpectatorMovePayload = {
        from: result.from,
        to: result.to,
        promotion: result.promotion,
        san: result.san,
        fen: room.engine.getFen(),
        turn: newTurn,
        whiteMs: room.whiteMs,
        blackMs: room.blackMs,
        mover,
      };
      this.broadcastToSpectators(room, 'spectator_move', spectatorPayload);
      moverVisibleSquares = [...getVisibleSquares(room.engine, mover)];
    } else {
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
      if (opponentSlot.socketId) {
        this.io.to(opponentSlot.socketId).emit('opponent_move', movePayload);
      }
      const spectatorPayload: SpectatorMovePayload = { ...movePayload, mover };
      this.broadcastToSpectators(room, 'spectator_move', spectatorPayload);
    }

    if (room.fogOfWar) {
      // Fog of War's ONLY win condition — no checkmate/stalemate/draw concept at all (see
      // ChessBoard's own fogOfWar doc comment), so room.engine.isGameOver() is never consulted
      // here: moves went through movePseudoLegal above, which can perfectly well reach a
      // position chess.js would call checkmate/stalemate without anyone's king actually being
      // captured, and that must NOT end the game.
      const winner = getFogOfWarWinner(result, mover);
      if (winner) {
        this.endGame(room, 'fogOfWar', winner);
      } else {
        this.scheduleTimeout(room);
      }
    } else if (room.giveaway) {
      // Giveaway has no checkmate/stalemate/draw either — whoever is now to move with no legal move WINS
      // (see giveaway.ts). Kings are ordinary capturable pieces, so there is no king-capture win; a
      // game can only otherwise end by clock, resignation, abandonment or an agreed draw.
      const winner = getGiveawayWinner(room.engine);
      if (winner) {
        this.endGame(room, 'giveaway', winner);
      } else {
        this.scheduleTimeout(room);
      }
    } else if (room.atomic) {
      // Atomic: a blown-up king ends the game on the spot (reason 'atomic'); otherwise the usual
      // checkmate / stalemate / draw — all judged by atomic.ts (adjacent kings are never in check, ...) — plus
      // the threefold-repetition draw, which only the room's own FEN history can see.
      const kingWinner = getAtomicKingWinner(room.engine.getAtomicPosition());
      if (kingWinner) {
        this.endGame(room, 'atomic', kingWinner);
      } else if (room.engine.isGameOver()) {
        const status = room.engine.getStatus();
        const reason: GameOverReason = status === 'checkmate' ? 'checkmate' : status === 'stalemate' ? 'stalemate' : 'draw';
        this.endGame(room, reason, status === 'checkmate' ? mover : null);
      } else if (isAtomicThreefoldRepetition(room.atomicFens)) {
        this.endGame(room, 'draw', null);
      } else {
        this.scheduleTimeout(room);
      }
    } else {
      // Checked before the normal chess.js-driven end-of-game logic — reaching the center wins
      // outright regardless of the rest of the position (check/material/etc. don't matter), and
      // chess.js has no idea this rule exists at all, so it can never surface via getStatus()/
      // isGameOver() on its own.
      const kingOfTheHillWinner = room.kingOfTheHill ? room.engine.getKingOfTheHillWinner() : null;
      // Same "checked before the normal chess.js end-of-game logic" reasoning as King of the Hill
      // above — three-checks wins outright regardless of the rest of the position, and chess.js
      // has no idea this rule exists either.
      const threeCheckWinner = room.threeCheck ? room.engine.getThreeCheckWinner() : null;
      if (kingOfTheHillWinner) {
        this.endGame(room, 'kingOfTheHill', kingOfTheHillWinner);
      } else if (threeCheckWinner) {
        this.endGame(room, 'threeCheck', threeCheckWinner);
      } else if (room.engine.isGameOver()) {
        const status = room.engine.getStatus();
        const reason: GameOverReason = status === 'checkmate' ? 'checkmate' : status === 'stalemate' ? 'stalemate' : 'draw';
        const winner: PieceColor | null = status === 'checkmate' ? mover : null;
        this.endGame(room, reason, winner);
      } else {
        this.scheduleTimeout(room);
      }
    }

    const moverFen = room.fogOfWar ? buildRedactedFen(room.engine, mover) : room.engine.getFen();
    return { ok: true, fen: moverFen, san: result.san, turn: newTurn, whiteMs: room.whiteMs, blackMs: room.blackMs, visibleSquares: moverVisibleSquares };
  }

  rejoin(socketId: string, payload: RejoinGamePayload): Ack<{ state: RejoinStatePayload }> {
    const room = this.rooms.get(payload.roomId);
    if (!room || room.status !== 'active') {
      return { ok: false, error: 'The game was not found or has already ended.' };
    }

    let color: PieceColor | null = null;
    if (room.players.w.playerToken === payload.playerToken) color = 'w';
    else if (room.players.b.playerToken === payload.playerToken) color = 'b';
    if (!color) {
      return { ok: false, error: 'Invalid playerToken.' };
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
        fen: room.fogOfWar ? buildRedactedFen(room.engine, color) : room.engine.getFen(),
        turn: room.engine.getTurn(),
        color,
        timeControl: room.timeControl,
        isChess960: room.chess960,
        isKingOfTheHill: room.kingOfTheHill,
        isThreeCheck: room.threeCheck,
        isSetupChess: room.setupChess,
        isFogOfWar: room.fogOfWar,
        isGiveaway: room.giveaway,
        isAtomic: room.atomic,
        whiteMs: room.whiteMs,
        blackMs: room.blackMs,
        moves: room.fogOfWar ? redactedMovesFor(room, color) : room.moves,
        visibleSquares: room.fogOfWar ? [...getVisibleSquares(room.engine, color)] : undefined,
        opponentConnected: opponentSlot.socketId !== null,
      },
    };
  }

  /** Resolves `socketId` to its active room + seat color, or null if it isn't currently seated
   * in a still-active game — the shared guard every action below (resign, draw, chat) needs. */
  private locateActiveRoom(socketId: string): { room: Room; color: PieceColor } | null {
    const location = this.socketToRoom.get(socketId);
    if (!location) return null;
    const room = this.rooms.get(location.roomId);
    if (!room || room.status !== 'active') return null;
    return { room, color: location.color };
  }

  resign(socketId: string, roomId: string): Ack {
    const located = this.locateActiveRoom(socketId);
    if (!located || located.room.id !== roomId) {
      return { ok: false, error: 'No active game found for this connection.' };
    }
    const { room, color } = located;
    const winner: PieceColor = color === 'w' ? 'b' : 'w';
    this.endGame(room, 'resignation', winner);
    return { ok: true };
  }

  /** Sends a draw offer to the opponent. Guards against spam with a simple per-player cooldown
   * and by only ever allowing one outstanding offer in a room at a time. */
  offerDraw(socketId: string, roomId: string): Ack {
    const located = this.locateActiveRoom(socketId);
    if (!located || located.room.id !== roomId) {
      return { ok: false, error: 'No active game found for this connection.' };
    }
    const { room, color } = located;

    if (room.pendingDrawOfferBy) {
      return { ok: false, error: 'A draw offer is already pending.' };
    }
    const lastOfferAt = room.lastDrawOfferAt[color];
    if (lastOfferAt !== undefined && Date.now() - lastOfferAt < DRAW_OFFER_COOLDOWN_MS) {
      const waitSeconds = Math.ceil((DRAW_OFFER_COOLDOWN_MS - (Date.now() - lastOfferAt)) / 1000);
      return { ok: false, error: `Please wait ${waitSeconds}s before offering another draw.` };
    }

    room.pendingDrawOfferBy = color;
    room.lastDrawOfferAt[color] = Date.now();

    const opponentColor: PieceColor = color === 'w' ? 'b' : 'w';
    const opponentSlot = room.players[opponentColor];
    if (opponentSlot.socketId) {
      const payload: DrawOfferedPayload = { by: color };
      this.io.to(opponentSlot.socketId).emit('draw_offered', payload);
    }
    return { ok: true };
  }

  /** The opponent's response to a pending draw offer — accepting ends the game as a draw;
   * declining just clears the pending flag so a new offer can be made later (subject to the
   * same cooldown as any other offer). */
  respondToDraw(socketId: string, roomId: string, accept: boolean): Ack {
    const located = this.locateActiveRoom(socketId);
    if (!located || located.room.id !== roomId) {
      return { ok: false, error: 'No active game found for this connection.' };
    }
    const { room, color } = located;

    if (!room.pendingDrawOfferBy || room.pendingDrawOfferBy === color) {
      return { ok: false, error: 'There is no draw offer waiting for your response.' };
    }
    const offeredBy = room.pendingDrawOfferBy;
    room.pendingDrawOfferBy = null;

    if (accept) {
      this.endGame(room, 'draw', null);
      return { ok: true };
    }

    const offererSlot = room.players[offeredBy];
    if (offererSlot.socketId) {
      this.io.to(offererSlot.socketId).emit('draw_declined', {});
    }
    return { ok: true };
  }

  /** Relays a chat message to the opponent — no history is kept server-side (nothing to persist
   * or moderate beyond a length cap), it's a pure live relay for the lifetime of the room. */
  sendChatMessage(socketId: string, roomId: string, text: string): Ack {
    const located = this.locateActiveRoom(socketId);
    if (!located || located.room.id !== roomId) {
      return { ok: false, error: 'No active game found for this connection.' };
    }
    const { room, color } = located;

    const trimmed = text.trim().slice(0, CHAT_MAX_LENGTH);
    if (!trimmed) {
      return { ok: false, error: 'Message is empty.' };
    }

    const opponentColor: PieceColor = color === 'w' ? 'b' : 'w';
    const opponentSlot = room.players[opponentColor];
    if (opponentSlot.socketId) {
      const payload: ChatMessagePayload = { from: color, text: trimmed, sentAt: Date.now() };
      this.io.to(opponentSlot.socketId).emit('chat_message', payload);
    }
    return { ok: true };
  }

  /** Every active game, most-recent-first — for the "spectate a game" browse list. Usernames are
   * resolved fresh from the DB each call (rooms only track userId day-to-day) rather than cached,
   * since this is called on-demand (opening the browse screen), not a hot path. */
  async listActiveGames(): Promise<ActiveGameSummary[]> {
    const rooms = [...this.rooms.values()].filter((r) => r.status === 'active');
    const userIds = [...new Set(rooms.flatMap((r) => [r.players.w.userId, r.players.b.userId].filter((id): id is string => id !== null)))];
    const users = userIds.length > 0 ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true } }) : [];
    const usernameById = new Map(users.map((u) => [u.id, u.username]));
    const nameFor = (userId: string | null) => (userId ? (usernameById.get(userId) ?? 'Player') : 'Guest');

    return rooms.map((r) => ({
      roomId: r.id,
      timeControlLabel: r.timeControlLabel,
      isChess960: r.chess960,
      whiteUsername: nameFor(r.players.w.userId),
      blackUsername: nameFor(r.players.b.userId),
    }));
  }

  /** Joins `socketId` as a read-only spectator of `roomId` — never touches player slots, and
   * `applyMove`'s own "who's the side to move" check means a spectator's socket could never make
   * a move even if it tried (it isn't seated as either color). */
  spectate(socketId: string, roomId: string): Ack<{ state: SpectateStatePayload }> {
    const room = this.rooms.get(roomId);
    if (!room || room.status !== 'active') {
      return { ok: false, error: 'This game is no longer active.' };
    }
    // A socket switching straight from spectating room A to room B without an intervening
    // stop_spectating (the client always does call it on unmount, but this guards against any
    // path that doesn't) would otherwise leave it registered in room A's spectators forever.
    this.stopSpectating(socketId);
    room.spectators.add(socketId);
    this.socketToSpectatingRoom.set(socketId, roomId);

    return {
      ok: true,
      state: {
        // Spectators always see the full true position, never redacted — see fogOfWar.ts's
        // design notes ("they're not cheating anyone since they're not competing").
        fen: room.engine.getFen(),
        turn: room.engine.getTurn(),
        timeControl: room.timeControl,
        isChess960: room.chess960,
        isKingOfTheHill: room.kingOfTheHill,
        isThreeCheck: room.threeCheck,
        isSetupChess: room.setupChess,
        isFogOfWar: room.fogOfWar,
        isGiveaway: room.giveaway,
        isAtomic: room.atomic,
        whiteMs: room.whiteMs,
        blackMs: room.blackMs,
        moves: room.moves,
      },
    };
  }

  stopSpectating(socketId: string): void {
    const roomId = this.socketToSpectatingRoom.get(socketId);
    if (!roomId) return;
    this.socketToSpectatingRoom.delete(socketId);
    this.rooms.get(roomId)?.spectators.delete(socketId);
  }

  private broadcastToSpectators<T>(room: Room, event: string, payload: T): void {
    for (const spectatorSocketId of room.spectators) {
      this.io.to(spectatorSocketId).emit(event, payload);
    }
  }

  /** Called from the io-level 'disconnect' handler for every socket, regardless of whether it
   * was actually in a room — a no-op if it wasn't. */
  handleDisconnect(socketId: string): void {
    this.stopSpectating(socketId);

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

    const gameOverPayload: GameOverPayload = { reason, winner };
    this.broadcastToSpectators(room, 'game_over', gameOverPayload);
    for (const spectatorSocketId of room.spectators) {
      this.socketToSpectatingRoom.delete(spectatorSocketId);
    }

    // Fire-and-forget: persistence is a best-effort side effect and must never delay or risk
    // the game_over broadcast above, which already happened by this point.
    this.persistGameResult(room, winner).catch((err) => {
      console.error(`[rooms] failed to save online game history for room ${room.id}:`, err);
    });

    room.onFinished?.(winner);
    this.rooms.delete(room.id);
  }

  /** Saves one Game row per logged-in player (guests, who have no userId, are skipped — there's
   * no account to attach history to) so every online game — whatever it ended by — shows up in
   * both players' history the same way a Local/Bot game does. Uses the exact same Game model,
   * just with opponentType 'online' plus the two online-only fields (opponentUsername, color). */
  private async persistGameResult(room: Room, winner: PieceColor | null): Promise<void> {
    const userIds = (['w', 'b'] as const)
      .map((c) => room.players[c].userId)
      .filter((id): id is string => id !== null);
    if (userIds.length === 0) return; // both players were guests — nothing to save

    const result = winner === 'w' ? '1-0' : winner === 'b' ? '0-1' : '1/2-1/2';
    const pgn = buildPgn(room.initialFen, room.moves, result, room.giveaway ? 'Antichess' : room.atomic ? 'Atomic' : undefined);

    const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true } });
    const usernameById = new Map(users.map((u) => [u.id, u.username]));

    const rows = (['w', 'b'] as const)
      .map((color) => {
        const userId = room.players[color].userId;
        if (!userId) return null;
        const opponentColor: PieceColor = color === 'w' ? 'b' : 'w';
        const opponentUserId = room.players[opponentColor].userId;
        return {
          userId,
          opponentType: 'online' as const,
          opponentUsername: opponentUserId ? (usernameById.get(opponentUserId) ?? null) : null,
          color,
          result,
          pgn,
          timeControl: room.timeControlLabel,
          isChess960: room.chess960,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    await prisma.$transaction(rows.map((data) => prisma.game.create({ data })));
  }
}

/** Fog of War only — `room.moves` redacted for a rejoining player's own point of view (see
 * redactMoveHistory). Each entry's fields are all omitted together for a move this viewer never
 * witnessed; always fully populated for one they did. */
function redactedMovesFor(room: Room, viewer: PieceColor): RejoinStatePayload['moves'] {
  return redactMoveHistory(room.initialFen, room.moves, viewer).map((entry) =>
    entry.revealed ? { from: entry.from, to: entry.to, san: entry.san } : {}
  );
}
