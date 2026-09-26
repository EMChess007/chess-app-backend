import type { PieceColor } from './RoomChessEngine.js';

export type { PieceColor };

export interface TimeControl {
  initialSeconds: number;
  incrementSeconds: number;
}

export type GameOverReason = 'checkmate' | 'stalemate' | 'draw' | 'timeout' | 'abandonment' | 'resignation';

// --- Client -> server payloads ---------------------------------------------

export interface JoinQueuePayload {
  timeControl: TimeControl;
  isChess960?: boolean;
  /** The client's own display label for `timeControl` (e.g. "10 min", "3 | 2") — carried through
   * to the saved game history row so online games show the same labels Local/Bot games do,
   * without duplicating the client's preset table server-side. Optional for backward
   * compatibility; falls back to a generic computed label if omitted. */
  timeControlLabel?: string;
  /** Accepted but not yet used for matching — see ROADMAP note in matchmaking.ts. */
  rating?: number;
}

export interface MakeMovePayload {
  roomId: string;
  from: string;
  to: string;
  promotion?: 'n' | 'b' | 'r' | 'q';
}

export interface RejoinGamePayload {
  roomId: string;
  playerToken: string;
}

export interface ResignPayload {
  roomId: string;
}

export interface OfferDrawPayload {
  roomId: string;
}

export interface RespondDrawPayload {
  roomId: string;
  accept: boolean;
}

export interface SendChatPayload {
  roomId: string;
  text: string;
}

// --- Server -> client payloads ----------------------------------------------

export interface MatchFoundPayload {
  roomId: string;
  color: PieceColor;
  playerToken: string;
  opponent: { userId: string | null };
  timeControl: TimeControl;
  isChess960: boolean;
  fen: string;
  whiteMs: number;
  blackMs: number;
}

export interface OpponentMovePayload {
  from: string;
  to: string;
  promotion?: 'n' | 'b' | 'r' | 'q';
  san: string;
  fen: string;
  turn: PieceColor;
  whiteMs: number;
  blackMs: number;
}

export interface GameOverPayload {
  reason: GameOverReason;
  winner: PieceColor | null;
}

export interface DrawOfferedPayload {
  by: PieceColor;
}

export interface ChatMessagePayload {
  from: PieceColor;
  text: string;
  sentAt: number;
}

export interface RejoinStatePayload {
  fen: string;
  turn: PieceColor;
  color: PieceColor;
  timeControl: TimeControl;
  isChess960: boolean;
  whiteMs: number;
  blackMs: number;
  moves: { from: string; to: string; promotion?: string; san: string }[];
  opponentConnected: boolean;
}

/** Same live game state a rejoining player gets (see RejoinStatePayload), minus the two fields
 * that only make sense for an actual seated player (which color is "theirs", whether their
 * opponent is connected) — a spectator has neither. */
export type SpectateStatePayload = Omit<RejoinStatePayload, 'color' | 'opponentConnected'>;

export interface SpectatorMovePayload extends OpponentMovePayload {
  /** Which side actually made this move — a spectator, unlike a player, has no fixed "opponent"
   * color to infer it from. */
  mover: PieceColor;
}

export interface ActiveGameSummary {
  roomId: string;
  timeControlLabel: string;
  isChess960: boolean;
  whiteUsername: string;
  blackUsername: string;
}

export interface CreateChallengePayload {
  timeControl: TimeControl;
  isChess960?: boolean;
  timeControlLabel?: string;
}

export interface JoinChallengePayload {
  code: string;
}

// Generic acknowledgement shape used by every request/response-style client event
// (join_queue, leave_queue, make_move, rejoin_game) — success payload varies, failure is uniform.
export type Ack<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };
