// GENERATED FILE - DO NOT EDIT BY HAND.
// Source: src/logic/bughouse/wire.ts in the EM-Chess app repo. Regenerate with `npm run sync:bughouse`; CI runs it with --check.
// The only difference from the source is that relative imports carry the '.js' suffix NodeNext requires.

/**
 * Bughouse W2: the wire contract (BUGHOUSE_SPEC.md HP1, HP5, HP6, HP10) - every `bug_*` event, its payload, the closed list of refusal reasons and the pure validators the server runs on
 * EVERY inbound payload. Types, literals and pure functions only. MIRRORED to the backend (backend/src/game/bughouse/wire.ts), so a client and the server cannot disagree about a field
 * (the same idea as fourPlayerWire.ts, which this module does NOT import: a mirrored file may import only mirrored files).
 *
 * THE BOARD IS NAMED ON THE WIRE (HP9). A move and a drop carry `board: 'A' | 'B'`; the server refuses one whose board is not the sender's own seat's board. Squares are the plain
 * algebraic names of ONE board ("e4"); which board they belong to is the `board` field next to them, never an implicit default.
 *
 * THE PAYLOAD OF A POSITION IS `serializeMatch` (snapshot.ts): one JSON line, fixed key order, byte-identical on the client and on the server. Time is the match's own monotonic clock
 * in integer milliseconds; every payload that carries a position also carries `serverNowMs`, the instant on that clock when the payload was made, so a client can show
 * `remainingMs - (serverNowMs - runningSince)` for a running clock without ever reading the server's wall clock.
 */
import { RESERVE_PIECE_TYPES, type ReservePieceType } from '../crazyhouse.js';
import { BUGHOUSE_TIME_CONTROLS, type BughouseEvent, type BughouseTimeControl, type MatchResult, type PromotionPiece, type RejectReason } from './rules.js';
import type { BoardId, BughouseSeat } from './types.js';

// --- Limits both sides enforce ------------------------------------------------------------------------------------------------

/** Team chat: same cap as the other chats. Longer text is cut, not refused. */
export const BUG_CHAT_MAX_LENGTH = 500;
/** A roomId / playerToken is a UUID (36 chars); anything longer than this is not one. */
export const BUG_ID_MAX_LENGTH = 64;
/** Quick messages are a closed set of ten codes, 0..9 (HP10); the receiving client renders the wording, so the wire never carries text. */
export const BUG_QUICK_CODE_COUNT = 10;

// --- Shapes -------------------------------------------------------------------------------------------------------------------

/**
 * Why a request was refused: the engine's own closed list (rules.ts `RejectReason`) plus the server's. A refusal always carries one of these in `reason` next to the human-readable
 * `error`, so a client can react (roll back an optimistic drop on `dropNotInPocket`, say) without reading prose.
 *   invalidRequest : the payload is not the shape this event takes
 *   noGame         : the socket does not sit in the room it names (a spectator, or a stranger)
 *   rateLimited    : too many requests from this seat
 *   duplicate      : the same quick-message code again within a second
 *   partnerIsBot   : team chat / quick message to a seat a bot plays (nothing is delivered)
 */
export type BugRejectReason = RejectReason | 'invalidRequest' | 'noGame' | 'rateLimited' | 'duplicate' | 'partnerIsBot';

export const BUG_REJECT_REASONS = [
  'over',
  'time',
  'flagDue',
  'malformed',
  'wrongBoard',
  'notYourTurn',
  'illegalMove',
  'dropNotInPocket',
  'illegalDrop',
  'invalidRequest',
  'noGame',
  'rateLimited',
  'duplicate',
  'partnerIsBot',
] as const satisfies readonly BugRejectReason[];

/** `{ ok: true, ...T } | { ok: false, error, reason }` - the ack shape every client->server event uses. */
export type BugAck<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string; reason: BugRejectReason };

export const bugRefusal = (reason: BugRejectReason, error: string): { ok: false; error: string; reason: BugRejectReason } => ({ ok: false, error, reason });

/** Who plays a seat. A seat a bot took over keeps `originalHuman` so the client can say "your seat was taken over". */
export interface BugSeatInfo {
  seat: BughouseSeat;
  kind: 'human' | 'bot';
  botReason?: 'fill' | 'takeover';
  name: string;
  elo?: number;
  connected: boolean;
  /** A disconnected human whose seat is still waiting to be taken over: how long it has left (the client counts down from this). */
  graceMsLeft?: number;
}
export type BugSeats = [BugSeatInfo, BugSeatInfo, BugSeatInfo, BugSeatInfo];

/** One played move or drop in the room's log (nothing else is kept): enough to rebuild a move list after a rejoin. */
export interface BugLogEntry {
  seq: number;
  seat: BughouseSeat;
  board: BoardId;
  /** The notation the engine wrote ("Nf3", "N@f3+"). */
  san: string;
}

// --- Client -> server payloads -------------------------------------------------------------------------------------------------

export interface BugJoinQueuePayload {
  timeControl: BughouseTimeControl;
}
export interface BugRoomPayload {
  roomId: string;
}
/** `baseSeq` is the `seq` of the snapshot the client validated against; it is diagnostic only - the server judges against its CURRENT state (HP3). */
export interface BugMovePayload {
  roomId: string;
  board: BoardId;
  from: string;
  to: string;
  promotion?: PromotionPiece;
  baseSeq?: number;
}
export interface BugDropPayload {
  roomId: string;
  board: BoardId;
  piece: ReservePieceType;
  square: string;
  baseSeq?: number;
}
export interface BugRejoinPayload {
  roomId: string;
  playerToken: string;
}
export interface BugChatPayload {
  roomId: string;
  text: string;
}
export interface BugQuickPayload {
  roomId: string;
  code: number;
}

// --- Server -> client payloads -------------------------------------------------------------------------------------------------

export interface BugQueueUpdatePayload {
  /** Humans waiting in this time control's queue. */
  queued: number;
  /** Milliseconds until the bots fill the empty seats; null while fewer than two humans are waiting. */
  fillInMs: number | null;
}

export interface BugMatchFoundPayload {
  roomId: string;
  /** THIS recipient's seat and token (every human gets their own). */
  seat: BughouseSeat;
  playerToken: string;
  seats: BugSeats;
  timeControl: BughouseTimeControl;
  timeControlLabel: string;
  /** `serializeMatch` of the starting position (seq 0). */
  state: string;
  serverNowMs: number;
  seq: 0;
}

/** After EVERY change of the match, to every seat and spectator. `seq` grows by exactly 1 per `bug_state`: a client ignores `seq <= current` and on a gap resyncs with `bug_rejoin`. */
export interface BugStatePayload {
  roomId: string;
  seq: number;
  /** What the commit did, in order (moves, drops, the credit to the partner's pocket, the result). Display only - the snapshot is the authority. */
  events: BughouseEvent[];
  state: string;
  serverNowMs: number;
}

export interface BugSeatUpdatePayload {
  roomId: string;
  seats: BugSeats;
}

export interface BugGameOverPayload {
  roomId: string;
  result: MatchResult;
  state: string;
}

/** Team chat line: delivered to the sender (the echo) and the sender's partner, and to no one else. */
export interface BugChatFromPayload {
  seat: BughouseSeat;
  name: string;
  text: string;
}
/** A quick message: delivered to the sender's partner only. */
export interface BugQuickFromPayload {
  seat: BughouseSeat;
  code: number;
}

/** Everything a client needs to (re)build a room it is part of or watching. */
export interface BugRoomState {
  roomId: string;
  seats: BugSeats;
  timeControl: BughouseTimeControl;
  timeControlLabel: string;
  seq: number;
  state: string;
  serverNowMs: number;
  log: BugLogEntry[];
}
export interface BugRejoinState extends BugRoomState {
  seat: BughouseSeat;
}
export type BugSpectateState = BugRoomState;

export interface BugActiveGameSummary {
  roomId: string;
  timeControlLabel: string;
  seats: { name: string; kind: 'human' | 'bot' }[];
}

/** `bug_rejoin` on a match that already ENDED (within the 5-minute retention) answers with the result instead of "not found". */
export interface BugRejoinFinished {
  ok: true;
  finished: true;
  gameOver: BugGameOverPayload;
}
export type BugRejoinAck = BugAck<{ state: BugRejoinState }> | BugRejoinFinished;

// --- Event names (typed for Socket.IO's generics) -------------------------------------------------------------------------------

export interface BugClientToServerEvents {
  bug_join_queue: (payload: BugJoinQueuePayload, ack: (res: BugAck) => void) => void;
  bug_leave_queue: (payload: object, ack: (res: BugAck) => void) => void;
  bug_move: (payload: BugMovePayload, ack: (res: BugAck<{ seq: number }>) => void) => void;
  bug_drop: (payload: BugDropPayload, ack: (res: BugAck<{ seq: number }>) => void) => void;
  bug_resign: (payload: BugRoomPayload, ack: (res: BugAck) => void) => void;
  bug_rejoin: (payload: BugRejoinPayload, ack: (res: BugRejoinAck) => void) => void;
  /** `delivered` is false when the partner is a human who is not connected right now (nothing is stored, so the line is gone); a BOT partner is a refusal (`partnerIsBot`) instead. */
  bug_chat: (payload: BugChatPayload, ack: (res: BugAck<{ delivered: boolean }>) => void) => void;
  bug_quick: (payload: BugQuickPayload, ack: (res: BugAck<{ delivered: boolean }>) => void) => void;
  bug_list_active_games: (payload: object, ack: (res: BugAck<{ games: BugActiveGameSummary[] }>) => void) => void;
  bug_spectate_game: (payload: BugRoomPayload, ack: (res: BugAck<{ state: BugSpectateState }>) => void) => void;
  bug_stop_spectating: (payload: object, ack: (res: BugAck) => void) => void;
}

export interface BugServerToClientEvents {
  bug_queue_update: (payload: BugQueueUpdatePayload) => void;
  bug_match_found: (payload: BugMatchFoundPayload) => void;
  bug_state: (payload: BugStatePayload) => void;
  bug_seat_update: (payload: BugSeatUpdatePayload) => void;
  bug_game_over: (payload: BugGameOverPayload) => void;
  bug_chat_from: (payload: BugChatFromPayload) => void;
  bug_quick_from: (payload: BugQuickFromPayload) => void;
}

/** The event names as runtime values (a typo in a literal is a compile error through the two interfaces above; these exist for code that must iterate or register every event, and
 * for the tests that pin the protocol's surface). */
export const BUG_CLIENT_EVENT_NAMES = [
  'bug_join_queue',
  'bug_leave_queue',
  'bug_move',
  'bug_drop',
  'bug_resign',
  'bug_rejoin',
  'bug_chat',
  'bug_quick',
  'bug_list_active_games',
  'bug_spectate_game',
  'bug_stop_spectating',
] as const satisfies readonly (keyof BugClientToServerEvents)[];

export const BUG_SERVER_EVENT_NAMES = [
  'bug_queue_update',
  'bug_match_found',
  'bug_state',
  'bug_seat_update',
  'bug_game_over',
  'bug_chat_from',
  'bug_quick_from',
] as const satisfies readonly (keyof BugServerToClientEvents)[];

// --- Validation (pure; the server enforces it on every event, the client uses it to avoid sending what would be refused) --------

export type BugValidation<T> = { ok: true; value: T } | { ok: false; error: string; reason: BugRejectReason };

const invalid = (error: string): { ok: false; error: string; reason: BugRejectReason } => ({ ok: false, error, reason: 'invalidRequest' });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const SQUARE = /^[a-h][1-8]$/;

/** A roomId / playerToken: a non-empty string, at most BUG_ID_MAX_LENGTH long. (Whether it names a real room is the server's business.) */
export function validateBugId(value: unknown, what = 'id'): BugValidation<string> {
  if (typeof value !== 'string' || value.length === 0 || value.length > BUG_ID_MAX_LENGTH) return invalid(`Invalid ${what}.`);
  return { ok: true, value };
}

export function validateBugBoard(value: unknown): BugValidation<BoardId> {
  return value === 'A' || value === 'B' ? { ok: true, value } : invalid('Invalid board.');
}

/** One of the spec's six time controls, exactly (B11): anything else - a free-form control, "No time limit" - is refused. The wire carries whole milliseconds like the engine. */
export function validateBugTimeControl(value: unknown): BugValidation<BughouseTimeControl> {
  if (!isRecord(value)) return invalid('Invalid time control.');
  const { initialMs, incrementMs } = value;
  const known = BUGHOUSE_TIME_CONTROLS.find((tc) => tc.initialMs === initialMs && tc.incrementMs === incrementMs);
  return known ? { ok: true, value: { initialMs: known.initialMs, incrementMs: known.incrementMs } } : invalid('Unknown time control.');
}

export function validateBugJoinQueue(value: unknown): BugValidation<BugJoinQueuePayload> {
  if (!isRecord(value)) return invalid('Invalid request.');
  const timeControl = validateBugTimeControl(value.timeControl);
  return timeControl.ok ? { ok: true, value: { timeControl: timeControl.value } } : timeControl;
}

export function validateBugRoomPayload(value: unknown): BugValidation<BugRoomPayload> {
  if (!isRecord(value)) return invalid('Invalid request.');
  const roomId = validateBugId(value.roomId, 'room');
  return roomId.ok ? { ok: true, value: { roomId: roomId.value } } : roomId;
}

function validateBaseSeq(value: unknown): BugValidation<number | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? { ok: true, value } : invalid('Invalid baseSeq.');
}

/** Shape only: the squares are canonical names ("e4", never "E4" or "e04") and the promotion piece is one of q/r/b/n. Whether the move is LEGAL for the sender's seat is the engine's job. */
export function validateBugMovePayload(value: unknown): BugValidation<BugMovePayload> {
  if (!isRecord(value)) return invalid('Invalid move.');
  const roomId = validateBugId(value.roomId, 'room');
  if (!roomId.ok) return roomId;
  const board = validateBugBoard(value.board);
  if (!board.ok) return board;
  const { from, to, promotion } = value;
  if (typeof from !== 'string' || !SQUARE.test(from) || typeof to !== 'string' || !SQUARE.test(to)) return invalid('Invalid move.');
  if (promotion !== undefined && !(promotion === 'q' || promotion === 'r' || promotion === 'b' || promotion === 'n')) return invalid('Invalid promotion piece.');
  const baseSeq = validateBaseSeq(value.baseSeq);
  if (!baseSeq.ok) return baseSeq;
  return {
    ok: true,
    value: { roomId: roomId.value, board: board.value, from, to, ...(promotion === undefined ? {} : { promotion }), ...(baseSeq.value === undefined ? {} : { baseSeq: baseSeq.value }) },
  };
}

/** Shape only: a pocket piece type (p/n/b/r/q - never a king) on a canonical square. */
export function validateBugDropPayload(value: unknown): BugValidation<BugDropPayload> {
  if (!isRecord(value)) return invalid('Invalid drop.');
  const roomId = validateBugId(value.roomId, 'room');
  if (!roomId.ok) return roomId;
  const board = validateBugBoard(value.board);
  if (!board.ok) return board;
  const { piece, square } = value;
  if (typeof piece !== 'string' || !(RESERVE_PIECE_TYPES as string[]).includes(piece)) return invalid('Invalid piece.');
  if (typeof square !== 'string' || !SQUARE.test(square)) return invalid('Invalid drop.');
  const baseSeq = validateBaseSeq(value.baseSeq);
  if (!baseSeq.ok) return baseSeq;
  return { ok: true, value: { roomId: roomId.value, board: board.value, piece: piece as ReservePieceType, square, ...(baseSeq.value === undefined ? {} : { baseSeq: baseSeq.value }) } };
}

export function validateBugRejoin(value: unknown): BugValidation<BugRejoinPayload> {
  if (!isRecord(value)) return invalid('Invalid request.');
  const roomId = validateBugId(value.roomId, 'room');
  const token = validateBugId(value.playerToken, 'token');
  if (!roomId.ok) return roomId;
  if (!token.ok) return token;
  return { ok: true, value: { roomId: roomId.value, playerToken: token.value } };
}

/** The same rule as the other chats: trim, cut to BUG_CHAT_MAX_LENGTH, refuse what is then empty (or not text at all). */
export function normalizeBugChatText(value: unknown): BugValidation<string> {
  if (typeof value !== 'string') return invalid('Message is empty.');
  const text = value.trim().slice(0, BUG_CHAT_MAX_LENGTH);
  return text ? { ok: true, value: text } : invalid('Message is empty.');
}

/** A quick-message code: an integer 0..9. Text, floats, negatives, 10 and everything else are refused - the wire never carries a message, only a code from the closed set. */
export function validateBugQuickCode(value: unknown): BugValidation<number> {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < BUG_QUICK_CODE_COUNT ? { ok: true, value } : invalid('Invalid quick message.');
}

export type BugRejoinOutcome =
  | { kind: 'state'; state: BugRejoinState }
  | { kind: 'finished'; gameOver: BugGameOverPayload }
  | { kind: 'unavailable'; error: string };

/** A live match resumes, a finished one hands back its result, anything else is unavailable (the client forgets the stored game). */
export function classifyBugRejoinAck(ack: BugRejoinAck): BugRejoinOutcome {
  if (ack.ok && 'finished' in ack && ack.finished) return { kind: 'finished', gameOver: ack.gameOver };
  if (ack.ok && 'state' in ack) return { kind: 'state', state: ack.state };
  return { kind: 'unavailable', error: ack.ok ? 'The game was not found or has already ended.' : ack.error };
}
