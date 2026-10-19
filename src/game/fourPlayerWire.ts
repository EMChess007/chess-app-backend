// GENERATED FILE - DO NOT EDIT BY HAND.
// Source: src/logic/fourPlayerWire.ts in the EM-Chess app repo. Regenerate with `npm run sync:fourplayer`; CI runs it with --check.
// The only difference from the source is that relative imports carry the '.js' suffix NodeNext requires.

/**
 * 4 Player Chess ONLINE — the wire contract: every payload, ack and event name of the `four_*` Socket.IO protocol, the limits both
 * sides must agree on, and the few pure validators that enforce them. See FOUR_PLAYER_ONLINE_SPEC.md §3 for the design.
 *
 * ONE SOURCE OF TRUTH, COPIED BY A GENERATOR. This file (and the engine modules it builds on) is the only place the protocol is
 * written down. The backend's `src/game/fourPlayerWire.ts` is GENERATED from it by `backend/scripts/sync-fourplayer.mjs` — never edited
 * by hand — so the client and the server cannot disagree about a field name or a limit; a protocol change is one edit here plus
 * `npm run sync:fourplayer` in the backend. The backend CI fails if the committed copy is stale. Consequences for this file:
 *   - it may import ONLY from the mirrored engine modules (`./fourPlayer/board`, `./fourPlayer/elimination`, …, listed in
 *     `fourPlayer/MIRRORED_TO_BACKEND.json`) — no React Native, no `src/types`, no packages — or the generator refuses to run;
 *   - relative imports stay EXTENSIONLESS here (Metro/vitest style); the generator adds the `.js` the backend's NodeNext needs.
 *
 * THE UNIT OF SYNC IS A SNAPSHOT. Every state change is sent as `serialize(FourPlayerState)` (the engine's own exact round-trip text)
 * plus the engine's `GameEvent`s for presentation. Clients adopt the snapshot and never replay moves to derive a position, because the
 * engine plays random dead-king walks that a client cannot predict. `seq` orders the snapshots (see FourStatePayload).
 *
 * Squares travel as names ("e2", files a-n, ranks 1-14); seats as 0|1|2|3 = Red, Blue, Yellow, Green (the engine's clockwise order).
 * No userId, token or other private field ever appears in a payload that goes to more than one recipient (only `four_match_found` and
 * the rejoin answer carry a `playerToken`, and only to the seat's own human).
 */

import { CROSS14, type Geometry, type Seat } from './fourPlayer/board.js';
import type { GameEvent } from './fourPlayer/elimination.js';
import type { FourPlayerResult, FourVariant } from './fourPlayer/state.js';

// --- Limits both sides enforce ------------------------------------------------------------------------------------------------

/** Online 4 Player is live play only (Bullet / Blitz / Rapid presets): the clock is the only guard against an idle seat, so "No time limit"
 * and Daily are refused. */
export const FOUR_TC_MIN_INITIAL_SECONDS = 60;
export const FOUR_TC_MAX_INITIAL_SECONDS = 3600;
export const FOUR_TC_MAX_INCREMENT_SECONDS = 30;
/** Same cap as the 2-player chat. Longer text is cut, not refused (also like 2-player). */
export const FOUR_CHAT_MAX_LENGTH = 500;
/** A roomId / playerToken is a UUID (36 chars); anything longer than this is not one. */
export const FOUR_ID_MAX_LENGTH = 64;

// --- Shapes -------------------------------------------------------------------------------------------------------------------

/** `{ ok: true, ...T } | { ok: false, error }` — the ack shape every client->server event uses, exactly like the 2-player events. */
export type FourAck<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };

export type FourClocksMs = [number, number, number, number];

export interface FourTimeControl {
  initialSeconds: number;
  incrementSeconds: number;
}

export type FourPromotion = 'q' | 'r' | 'b' | 'n';

/** Which four-player game a room / queue / payload is about (defined with the rules in fourPlayer/state.ts). A room has exactly one variant, fixed when it is created. */
export type { FourVariant };

/**
 * Why a game ended: the engine's own result reasons (FFA: elimination | cap | deadPosition; Giveaway: outOfPieces | stuck | lastStanding |
 * cap) plus `abandoned` = every human left: no result (winners is empty, scores are not shown). Derived from the engine type on purpose, so
 * a reason added to the engine cannot be missing from the wire; `FOUR_REASONS` below is the runtime list (and fails to compile if it lags).
 */
export type FourReason = FourPlayerResult['reason'] | 'abandoned';

const REASON_FLAGS: Record<FourReason, true> = { elimination: true, cap: true, deadPosition: true, outOfPieces: true, stuck: true, lastStanding: true, abandoned: true };
export const FOUR_REASONS: readonly FourReason[] = Object.keys(REASON_FLAGS) as FourReason[];

export type FourActor = 'human' | 'bot' | 'clock' | 'resign';

export interface FourSeatInfo {
  seat: Seat;
  kind: 'human' | 'bot';
  /** Why a bot holds the seat: filled at match start, or taking over for a human who left. */
  botReason?: 'fill' | 'takeover';
  /** Display name: a username, "Guest" or "Bot". Never a userId. */
  name: string;
  /** Bots only. */
  elo?: number;
  /** Humans only; a bot is always connected. */
  connected: boolean;
  /** A disconnected human still inside the grace period: how long until a bot takes the seat. */
  graceMsLeft?: number;
}

export type FourSeats = [FourSeatInfo, FourSeatInfo, FourSeatInfo, FourSeatInfo];

/** One move-list entry (`moveLabel` text, as the local game's list shows it). */
export interface FourLogEntry {
  seat: Seat;
  text: string;
}

/** The move that caused a `four_state` (null for a flag fall or a resignation, which are not moves). */
export interface FourMoveInfo {
  seat: Seat;
  from: string;
  to: string;
  promotion?: FourPromotion;
  label: string;
}

/** The engine's events as they are: already plain JSON (numbers, strings, arrays), so no conversion exists to get wrong. Presentation
 * only — move log, sounds, "Blue was checkmated by Red (+20)" — the snapshot is the authority. */
export type FourWireEvent = GameEvent;

// --- Client -> server payloads -------------------------------------------------------------------------------------------------

export interface FourJoinQueuePayload {
  timeControl: FourTimeControl;
  timeControlLabel?: string;
  /** Which game to queue for. OMITTED = `'ffa'` (4 Player Chess), exactly what every client released before Giveaway sends. Lobbies never mix variants. */
  variant?: FourVariant;
}
export interface FourMakeMovePayload {
  roomId: string;
  from: string;
  to: string;
  promotion?: FourPromotion;
}
export interface FourRoomPayload {
  roomId: string;
}
export interface FourRejoinPayload {
  roomId: string;
  playerToken: string;
}
export interface FourSendChatPayload {
  roomId: string;
  text: string;
}

// --- Server -> client payloads -------------------------------------------------------------------------------------------------

export interface FourQueueUpdatePayload {
  /** Humans waiting in this time control's queue. */
  queued: number;
  /** Milliseconds until the bots fill the empty seats; null while fewer than two humans are waiting. */
  fillInMs: number | null;
}

export interface FourMatchFoundPayload {
  roomId: string;
  /** The room's game; a server that knows Giveaway ALWAYS sends it. Optional in the TYPE because an older server does not send it (read it with `fourVariantOf`):
   * a client that asked for Giveaway MUST see `'giveaway'` echoed here - an older server ignores the field it does not know and would start a 4 Player
   * Chess game - so the client refuses to play on when the echo is missing or different (decision D15). */
  variant?: FourVariant;
  /** THIS recipient's seat and token (every human gets their own). */
  seat: Seat;
  playerToken: string;
  seats: FourSeats;
  timeControl: FourTimeControl;
  timeControlLabel: string;
  state: string;
  clocksMs: FourClocksMs;
  seq: 0;
}

/** After EVERY state change, to every seat and spectator. `seq` starts at 0 (the match-found snapshot) and grows by exactly 1 per
 * `four_state`: a client ignores `seq <= current` and on a gap (`seq > current + 1`) resyncs with `four_rejoin`. */
export interface FourStatePayload {
  roomId: string;
  seq: number;
  actor: FourActor;
  move: FourMoveInfo | null;
  events: FourWireEvent[];
  state: string;
  clocksMs: FourClocksMs;
}

export interface FourSeatUpdatePayload {
  roomId: string;
  seats: FourSeats;
}

export interface FourGameOverPayload {
  roomId: string;
  reason: FourReason;
  /** FFA: the seat(s) with the highest score. Giveaway: the winning seat, or the seats tied for the fewest pieces at the cap. Empty when `reason` is `abandoned`. */
  winners: Seat[];
  /** Per seat. FFA: the final POINTS. Giveaway: the PIECES LEFT (there are no points; the client knows the variant). */
  scores: number[];
  state: string;
}

export interface FourChatMessagePayload {
  fromSeat: Seat;
  name: string;
  text: string;
  sentAt: number;
}

/** Everything a client needs to (re)build a room it is part of or watching. */
export interface FourRoomState {
  roomId: string;
  /** The room's game (also carried by a spectate / rejoin answer, so a client reads the snapshot with the right rules). Always sent by a server that knows
   * Giveaway; absent from an older one (read it with `fourVariantOf`). */
  variant?: FourVariant;
  seats: FourSeats;
  timeControl: FourTimeControl;
  timeControlLabel: string;
  seq: number;
  state: string;
  clocksMs: FourClocksMs;
  log: FourLogEntry[];
}
export interface FourRejoinState extends FourRoomState {
  seat: Seat;
}
export type FourSpectateState = FourRoomState;

export interface FourActiveGameSummary {
  roomId: string;
  /** Always sent by a server that knows Giveaway; absent from an older one (read it with `fourVariantOf`). */
  variant?: FourVariant;
  timeControlLabel: string;
  seats: { name: string; kind: 'human' | 'bot' }[];
}

/** `four_rejoin` on a game that already ENDED (within the retention window) answers with the result instead of "not found". A new event,
 * so unlike the 2-player W0 answer there is no released client to protect: it is a plain success carrying `finished: true`. */
export interface FourRejoinFinished {
  ok: true;
  finished: true;
  gameOver: FourGameOverPayload;
}
export type FourRejoinAck = FourAck<{ state: FourRejoinState }> | FourRejoinFinished;

// --- Event names (typed for Socket.IO's generics) -------------------------------------------------------------------------------

export interface FourClientToServerEvents {
  four_join_queue: (payload: FourJoinQueuePayload, ack: (res: FourAck) => void) => void;
  four_leave_queue: (payload: object, ack: (res: FourAck) => void) => void;
  four_make_move: (payload: FourMakeMovePayload, ack: (res: FourAck<{ seq: number }>) => void) => void;
  four_resign: (payload: FourRoomPayload, ack: (res: FourAck) => void) => void;
  four_rejoin: (payload: FourRejoinPayload, ack: (res: FourRejoinAck) => void) => void;
  four_send_chat: (payload: FourSendChatPayload, ack: (res: FourAck) => void) => void;
  four_list_active_games: (payload: object, ack: (res: FourAck<{ games: FourActiveGameSummary[] }>) => void) => void;
  four_spectate_game: (payload: FourRoomPayload, ack: (res: FourAck<{ state: FourSpectateState }>) => void) => void;
  four_stop_spectating: (payload: object, ack: (res: FourAck) => void) => void;
}

export interface FourServerToClientEvents {
  four_queue_update: (payload: FourQueueUpdatePayload) => void;
  four_match_found: (payload: FourMatchFoundPayload) => void;
  four_state: (payload: FourStatePayload) => void;
  four_seat_update: (payload: FourSeatUpdatePayload) => void;
  four_game_over: (payload: FourGameOverPayload) => void;
  four_chat_message: (payload: FourChatMessagePayload) => void;
}

/** The event names as runtime values (a typo in a string literal is a compile error through the two interfaces above; these exist for
 * code that must iterate or register every event, and for the tests that pin the protocol's surface). */
export const FOUR_CLIENT_EVENT_NAMES = [
  'four_join_queue',
  'four_leave_queue',
  'four_make_move',
  'four_resign',
  'four_rejoin',
  'four_send_chat',
  'four_list_active_games',
  'four_spectate_game',
  'four_stop_spectating',
] as const satisfies readonly (keyof FourClientToServerEvents)[];

export const FOUR_SERVER_EVENT_NAMES = [
  'four_queue_update',
  'four_match_found',
  'four_state',
  'four_seat_update',
  'four_game_over',
  'four_chat_message',
] as const satisfies readonly (keyof FourServerToClientEvents)[];

// --- Validation (pure; the server enforces it on every event, the client uses it to avoid sending what would be refused) --------

export type FourValidation<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A roomId / playerToken: a non-empty string, at most FOUR_ID_MAX_LENGTH long. (Whether it names a real room is the server's business.) */
export function validateFourId(value: unknown, what = 'id'): FourValidation<string> {
  if (typeof value !== 'string' || value.length === 0 || value.length > FOUR_ID_MAX_LENGTH) return fail(`Invalid ${what}.`);
  return { ok: true, value };
}

/** Whole seconds, inside the live range, with a whole-second increment 0..30. "No time limit" (and anything else outside the range) is
 * refused: online it is the only idle guard there is. */
export function validateFourTimeControl(value: unknown): FourValidation<FourTimeControl> {
  if (!isRecord(value)) return fail('Invalid time control.');
  const { initialSeconds, incrementSeconds } = value;
  if (typeof initialSeconds !== 'number' || !Number.isInteger(initialSeconds)) return fail('Invalid time control.');
  if (typeof incrementSeconds !== 'number' || !Number.isInteger(incrementSeconds)) return fail('Invalid time control.');
  if (initialSeconds < FOUR_TC_MIN_INITIAL_SECONDS || initialSeconds > FOUR_TC_MAX_INITIAL_SECONDS) {
    return fail(`Online 4 Player needs a time limit of ${FOUR_TC_MIN_INITIAL_SECONDS / 60} to ${FOUR_TC_MAX_INITIAL_SECONDS / 60} minutes.`);
  }
  if (incrementSeconds < 0 || incrementSeconds > FOUR_TC_MAX_INCREMENT_SECONDS) return fail(`The increment must be 0 to ${FOUR_TC_MAX_INCREMENT_SECONDS} seconds.`);
  return { ok: true, value: { initialSeconds, incrementSeconds } };
}

/**
 * The game a client asks for. `undefined` (a client that predates Giveaway) is 4 Player Chess; `'ffa'`, `'giveaway'` and `'chaturaji'` are accepted;
 * EVERYTHING else - another string, `null`, a number, an object - is refused with an error rather than quietly played as Chess: queueing for a game the
 * server does not understand must fail loudly, never start the wrong one.
 */
export function validateFourVariant(value: unknown): FourValidation<FourVariant> {
  if (value === undefined) return { ok: true, value: 'ffa' };
  if (value === 'ffa' || value === 'giveaway' || value === 'chaturaji') return { ok: true, value };
  return fail('Unknown game mode.');
}

/** The variant of a server payload: what it says, or `'ffa'` when it says nothing (a server that predates Giveaway only ever hosted 4 Player Chess). */
export const fourVariantOf = (payload: { variant?: FourVariant }): FourVariant => payload.variant ?? 'ffa';

export function validateFourJoinQueue(value: unknown): FourValidation<FourJoinQueuePayload> {
  if (!isRecord(value)) return fail('Invalid request.');
  const timeControl = validateFourTimeControl(value.timeControl);
  if (!timeControl.ok) return timeControl;
  const label = value.timeControlLabel;
  if (label !== undefined && (typeof label !== 'string' || label.length > 40)) return fail('Invalid time control label.');
  const variant = validateFourVariant(value.variant);
  if (!variant.ok) return variant;
  // The variant is echoed only when the client SENT one, so a payload from an old client validates to exactly what it always did.
  return { ok: true, value: { timeControl: timeControl.value, ...(label === undefined ? {} : { timeControlLabel: label }), ...(value.variant === undefined ? {} : { variant: variant.value }) } };
}

const PROMOTIONS: readonly string[] = ['q', 'r', 'b', 'n'];

/** A square in its ONE canonical spelling ("e2", never "e02"): it must be a playable square AND survive `squareName(parseSquare(x))`
 * unchanged. `parseSquare` alone is deliberately lenient about leading zeros ("e02" parses as e2); this is client input at the server
 * boundary, so anything but the canonical form is refused instead of being quietly normalised. `geo` is the board the game is played on (the cross board
 * unless a room says otherwise: Chaturaji's 8 x 8 square has no cut corners and no files past h). */
export function isCanonicalSquareName(value: unknown, geo: Geometry = CROSS14): value is string {
  if (typeof value !== 'string') return false;
  const square = geo.parseSquare(value);
  return square >= 0 && geo.squareName(square) === value;
}

/** Shape only: both squares are canonical names of playable squares of the board the room is played on (the cross-shaped board unless `geometryOfRoom` says
 * otherwise for that room id) and the promotion piece (if any) is one of q/r/b/n. Whether the move is LEGAL for the sender's seat is the engine's job
 * (`findLegalMove`), never the client's word. */
export function validateFourMovePayload(value: unknown, geometryOfRoom: (roomId: string) => Geometry = () => CROSS14): FourValidation<FourMakeMovePayload> {
  if (!isRecord(value)) return fail('Invalid move.');
  const roomId = validateFourId(value.roomId, 'room');
  if (!roomId.ok) return roomId;
  const { from, to, promotion } = value;
  const geo = geometryOfRoom(roomId.value);
  if (!isCanonicalSquareName(from, geo) || !isCanonicalSquareName(to, geo)) return fail('Invalid move.');
  if (promotion !== undefined && (typeof promotion !== 'string' || !PROMOTIONS.includes(promotion))) return fail('Invalid promotion piece.');
  return { ok: true, value: { roomId: roomId.value, from, to, ...(promotion === undefined ? {} : { promotion: promotion as FourPromotion }) } };
}

/** Same rule as the 2-player chat: trim, cut to FOUR_CHAT_MAX_LENGTH, refuse what is then empty (or not text at all). */
export function normalizeFourChatText(value: unknown): FourValidation<string> {
  if (typeof value !== 'string') return fail('Message is empty.');
  const text = value.trim().slice(0, FOUR_CHAT_MAX_LENGTH);
  return text ? { ok: true, value: text } : fail('Message is empty.');
}

// --- Small shared helpers -----------------------------------------------------------------------------------------------------

/** The engine counts clocks in (fractional) seconds, the wire in whole milliseconds, and both sides must round the same way. Never
 * negative, never fractional. */
export function clocksToWireMs(seconds: readonly number[]): FourClocksMs {
  const ms = (seat: number): number => Math.max(0, Math.round((seconds[seat] ?? 0) * 1000));
  return [ms(0), ms(1), ms(2), ms(3)];
}

export type FourRejoinOutcome =
  | { kind: 'state'; state: FourRejoinState }
  | { kind: 'finished'; gameOver: FourGameOverPayload }
  | { kind: 'unavailable'; error: string };

/** The 4-player twin of `classifyRejoinAck` (onlineRejoin.ts): a live game resumes, a finished one hands back its result, anything else
 * (including a malformed answer) is "unavailable" so the client never hangs on "Reconnecting…". `finished` is checked first. */
export function classifyFourRejoinAck(ack: FourRejoinAck): FourRejoinOutcome {
  if ('finished' in ack && ack.finished === true) return { kind: 'finished', gameOver: ack.gameOver };
  if (!ack.ok) return { kind: 'unavailable', error: ack.error };
  if ('state' in ack && ack.state) return { kind: 'state', state: ack.state };
  return { kind: 'unavailable', error: 'Unexpected reply from the server.' };
}
