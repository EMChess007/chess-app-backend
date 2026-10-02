import type { PieceColor } from './RoomChessEngine.js';

export type { PieceColor };

export interface TimeControl {
  initialSeconds: number;
  incrementSeconds: number;
}

export type GameOverReason =
  | 'checkmate'
  | 'stalemate'
  | 'draw'
  | 'timeout'
  | 'abandonment'
  | 'resignation'
  | 'kingOfTheHill'
  | 'threeCheck'
  | 'fogOfWar';

// --- Client -> server payloads ---------------------------------------------

export interface JoinQueuePayload {
  timeControl: TimeControl;
  isChess960?: boolean;
  isKingOfTheHill?: boolean;
  isThreeCheck?: boolean;
  isSetupChess?: boolean;
  isFogOfWar?: boolean;
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
  isKingOfTheHill: boolean;
  isThreeCheck: boolean;
  isSetupChess: boolean;
  isFogOfWar: boolean;
  fen: string;
  whiteMs: number;
  blackMs: number;
  /** Fog of War only — this recipient's own current visibility (square names). Even the
   * classical starting position isn't fully visible to either side under this variant's
   * visibility rule, so this is populated from the very first `match_found`, same as every later
   * `opponent_move`/`rejoin_game` state. Omitted outside Fog of War. */
  visibleSquares?: string[];
}

export interface OpponentMovePayload {
  /** Omitted together (along with `san`) when this move happened outside the Fog of War
   * recipient's own visibility — they still get the new (redacted) `fen`/`turn`/clocks/
   * `visibleSquares`, just not what specifically happened. Always present outside Fog of War. */
  from?: string;
  to?: string;
  promotion?: 'n' | 'b' | 'r' | 'q';
  san?: string;
  fen: string;
  turn: PieceColor;
  whiteMs: number;
  blackMs: number;
  /** Fog of War only — see MatchFoundPayload.visibleSquares. */
  visibleSquares?: string[];
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
  isKingOfTheHill: boolean;
  isThreeCheck: boolean;
  isSetupChess: boolean;
  isFogOfWar: boolean;
  whiteMs: number;
  blackMs: number;
  /** Each entry's fields are all omitted together for a Fog of War move this viewer never
   * witnessed (see redactMoveHistory) — always fully populated outside Fog of War. */
  moves: { from?: string; to?: string; promotion?: string; san?: string }[];
  /** Fog of War only — see MatchFoundPayload.visibleSquares; recomputed fresh for whoever's
   * rejoining/spectating. */
  visibleSquares?: string[];
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
  isKingOfTheHill?: boolean;
  isThreeCheck?: boolean;
  isSetupChess?: boolean;
  isFogOfWar?: boolean;
  timeControlLabel?: string;
}

export interface JoinChallengePayload {
  code: string;
}

// --- Setup Chess (blind, simultaneous army-building before the room is created) --------------

export interface SetupChessPieceWire {
  square: string;
  type: 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
}

/** Sent to both players the instant they're paired for a Setup Chess game (queue or challenge)
 * — replaces `match_found` for this one variant, since the room itself can't exist yet (there's
 * no starting position until both armies are submitted and merged). `color` is this player's own
 * assigned color, decided once at pairing time so their builder knows which two ranks are theirs. */
export interface SetupChessPairedPayload {
  pairingId: string;
  color: PieceColor;
  opponent: { userId: string | null };
  timeControl: TimeControl;
}

export interface SubmitSetupChessPayload {
  pairingId: string;
  pieces: SetupChessPieceWire[];
}

// --- Tournaments -------------------------------------------------------------

export type TournamentStatus = 'lobby' | 'active' | 'finished';

export interface CreateTournamentPayload {
  name: string;
  timeControl: TimeControl;
  timeControlLabel?: string;
  isChess960?: boolean;
  isKingOfTheHill?: boolean;
  isThreeCheck?: boolean;
}

export interface JoinTournamentPayload {
  code: string;
}

export interface TournamentIdPayload {
  tournamentId: string;
}

export interface TournamentParticipantSummary {
  userId: string;
  username: string;
}

export interface TournamentLobbyState {
  id: string;
  code: string;
  name: string;
  timeControl: TimeControl;
  isChess960: boolean;
  isKingOfTheHill: boolean;
  isThreeCheck: boolean;
  status: TournamentStatus;
  creatorUserId: string;
  participants: TournamentParticipantSummary[];
}

export interface TournamentStandingRow {
  userId: string;
  username: string;
  points: number;
  played: number;
}

/** Pushed to one specific player's own socket (see TournamentManager.broadcastStandings) — unlike
 * TournamentStandingRow, this can safely carry that player's own playerToken/color/roomId because
 * it's never broadcast to anyone else. `status` is the match's status ('pending' until an
 * opponent is also free, 'active' once a room exists), and roomId/playerToken/color are only
 * populated once it's 'active'. */
export interface TournamentNextMatch {
  status: 'pending' | 'active';
  opponentUsername: string;
  timeControl: TimeControl;
  isChess960: boolean;
  isKingOfTheHill: boolean;
  isThreeCheck: boolean;
  roomId: string | null;
  playerToken: string | null;
  color: PieceColor | null;
  /** The room's state at creation time — only correct for entering a match that just became
   * active, not a fully-current resync after navigating away mid-game (see Match's own comment
   * in tournaments.ts). Null until status is 'active'. */
  fen: string | null;
  whiteMs: number | null;
  blackMs: number | null;
}

export interface TournamentStandingsPayload {
  standings: TournamentStandingRow[];
  status: TournamentStatus;
  yourNextMatch: TournamentNextMatch | null;
}

/** Same shape as MatchFoundPayload (see below) — a tournament match is an ordinary game room in
 * every respect once it starts, so the client reuses the exact same "enter the game" flow. */
export interface TournamentMatchReadyPayload {
  roomId: string;
  color: PieceColor;
  playerToken: string;
  opponent: { userId: string; username: string };
  timeControl: TimeControl;
  isChess960: boolean;
  isKingOfTheHill: boolean;
  isThreeCheck: boolean;
  fen: string;
  whiteMs: number;
  blackMs: number;
}

// Generic acknowledgement shape used by every request/response-style client event
// (join_queue, leave_queue, make_move, rejoin_game) — success payload varies, failure is uniform.
export type Ack<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };
