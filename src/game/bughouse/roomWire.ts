// GENERATED FILE - DO NOT EDIT BY HAND.
// Source: src/logic/bughouse/roomWire.ts in the EM-Chess app repo. Regenerate with `npm run sync:bughouse`; CI runs it with --check.
// The only difference from the source is that relative imports carry the '.js' suffix NodeNext requires.

/**
 * Bughouse W6: the wire contract of FRIEND ROOMS ("play with a friend", BUGHOUSE_SPEC.md 5.7, HP11, B16) - the events, their payloads, the one error text and the pure code rules. Types,
 * literals and pure functions only, MIRRORED to the backend (backend/src/game/bughouse/roomWire.ts) like wire.ts, so a client and the server cannot disagree about a code, a field or a message.
 *
 * THE FLOW (one host, one friend, in memory on the server):
 *   bug_room_create { timeControl }   -> ack { room }          the host opens a room and gets a 6-character code (10 minutes)
 *   bug_room_join   { code }          -> ack { room }          the friend enters it: they are TEAMMATES (seats 0 + 3 of the match)
 *   bug_room_leave                    -> ack                   the host leaving closes the room; the friend leaving frees the friend slot (the code stays valid)
 *   bug_room_start  { mode }          -> ack                   the host starts: 'bots' = the two bots fill the other team at once; 'queue' = the pair enters the matchmaking as ONE group
 *   bug_room_update  (server -> both) the room as it is now        bug_room_closed (server -> the friend) the room is gone
 * Both host and friend are LOGGED IN (Q2). A code is consumed when the match starts and is invalid after its life (10 minutes).
 *
 * ONE ERROR. A code that is unknown, expired, full, closed or already started is refused with the same sentence (`BUG_ROOM_NOT_FOUND_MESSAGE`), so the answer is no oracle for which it was.
 * Repeated failures are the limiter's (backend: 5 per 5 minutes per socket, then a 5 minute cooldown; 10 per 15 minutes per user; 30 per 15 minutes per address): that refusal says how long
 * to wait and carries the reason 'rateLimited' - it is the same whatever the code was, so it tells nothing about any code either.
 */
import { BUGHOUSE_TIME_CONTROLS, type BughouseTimeControl } from './rules.js';
import { validateBugTimeControl, type BugAck, type BugValidation } from './wire.js';

// --- The code ------------------------------------------------------------------------------------------------------------------

/** No 0 / O / 1 / I / L: a code a person reads aloud or glances at. The same alphabet and length as the 2-player challenge codes (31 characters, 6 long: about 887 million codes). */
export const BUG_ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const BUG_ROOM_CODE_LENGTH = 6;
/** A room lives 10 minutes from its creation, until the match starts. */
export const BUG_ROOM_TTL_MS = 10 * 60 * 1000;

/**
 * What a person typed or pasted, as a code: trimmed, upper-cased, spaces and dashes removed ("abc-234" is a code someone wrote down), and null when it is not exactly BUG_ROOM_CODE_LENGTH
 * characters of the alphabet. A pasted invite LINK is reduced to its code by `codeFromInviteText`.
 */
export function normalizeBugRoomCode(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const code = value.trim().toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== BUG_ROOM_CODE_LENGTH) return null;
  for (const ch of code) if (!BUG_ROOM_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

/** The characters of the alphabet in what a person is typing, upper-cased, at most the length of a code: the join field's filter (31 allowed characters, paste accepted). */
export function filterBugRoomCodeInput(text: string): string {
  let out = '';
  for (const ch of text.toUpperCase()) if (BUG_ROOM_CODE_ALPHABET.includes(ch)) out += ch;
  return out.slice(0, BUG_ROOM_CODE_LENGTH);
}

/** The path an invite link carries: `<app URL>/bughouse/join/<code>`. */
export const BUG_ROOM_INVITE_PATH = '/bughouse/join/';
export const bugRoomInviteLink = (baseUrl: string, code: string): string => `${baseUrl.replace(/\/+$/, '')}${BUG_ROOM_INVITE_PATH}${code}`;

/** The code inside a pasted invite link (`.../bughouse/join/ABC234`), or in a bare code; null when there is none. */
export function codeFromInviteText(text: string): string | null {
  const link = /\/bughouse\/join\/([A-Za-z0-9-]{1,16})(?:[/?#]|$)/.exec(text);
  return normalizeBugRoomCode(link ? link[1] : text);
}

// --- Messages -------------------------------------------------------------------------------------------------------------------

/** The ONE answer to a join that fails for any reason about the code itself (unknown, expired, full, closed, started, or not a code at all). */
export const BUG_ROOM_NOT_FOUND_MESSAGE = 'That code was not found or has expired.';
export const BUG_ROOM_LOGIN_MESSAGE = 'Sign in to play Crazy Bughouse with a friend.';
export const BUG_ROOM_HAVE_ROOM_MESSAGE = 'You already have an open room. Leave it first.';
export const BUG_ROOM_BUSY_MESSAGE = 'Finish or leave your current game or queue first.';
export const BUG_ROOM_CAP_MESSAGE = 'There are too many open rooms right now. Try again in a few minutes.';
export const BUG_ROOM_OWN_MESSAGE = "You can't join your own room.";
export const BUG_ROOM_NO_FRIEND_MESSAGE = 'Wait for your friend to join first.';
export const BUG_ROOM_NOT_HOST_MESSAGE = 'Only the host can start the match.';
export const BUG_ROOM_NOT_IN_ROOM_MESSAGE = 'You are not in a room.';

/** "Too many wrong codes. Try again in 5 minutes." - the limiter's refusal, rounded UP to whole seconds and shown in minutes from 60 s. */
export function bugRoomCooldownMessage(retryAfterMs: number): string {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  const wait = seconds >= 60 ? `${Math.ceil(seconds / 60)} minute${Math.ceil(seconds / 60) === 1 ? '' : 's'}` : `${seconds} second${seconds === 1 ? '' : 's'}`;
  return `Too many wrong codes. Try again in ${wait}.`;
}

// --- Shapes ---------------------------------------------------------------------------------------------------------------------

/** 'open': in the room. 'queued': the pair is in the matchmaking (the friend's screen shows the same queue). */
export type BugRoomPhase = 'open' | 'queued';

/** The room as ONE of its two members sees it. `code` is shown to both (the friend may pass it on); the other fields are names and numbers only. */
export interface BugFriendRoomView {
  code: string;
  timeControl: BughouseTimeControl;
  timeControlLabel: string;
  youAre: 'host' | 'friend';
  hostName: string;
  /** null while the friend slot is free. */
  friendName: string | null;
  phase: BugRoomPhase;
  /** How long the code stays valid, from `serverNowMs`' moment (a countdown the client runs on its own clock). */
  expiresInMs: number;
}

export type BugRoomClosedReason = 'hostLeft' | 'expired';

export type BugRoomStartMode = 'bots' | 'queue';

export interface BugRoomCreatePayload {
  timeControl: BughouseTimeControl;
}
export interface BugRoomJoinPayload {
  code: string;
}
export interface BugRoomStartPayload {
  mode: BugRoomStartMode;
}

/** `bug_room_start` answers whether the host is now in a match ('started'), in the pair queue ('queued'), or in a solo queue because no friend had joined ('solo'). */
export type BugRoomStartAck = BugAck<{ outcome: 'started' | 'queued' | 'solo' }>;
export type BugRoomAck = BugAck<{ room: BugFriendRoomView }>;

export interface BugRoomClosedPayload {
  reason: BugRoomClosedReason;
}

export interface BugRoomClientToServerEvents {
  bug_room_create: (payload: BugRoomCreatePayload, ack: (res: BugRoomAck) => void) => void;
  bug_room_join: (payload: BugRoomJoinPayload, ack: (res: BugRoomAck) => void) => void;
  bug_room_leave: (ack: (res: BugAck) => void) => void;
  bug_room_start: (payload: BugRoomStartPayload, ack: (res: BugRoomStartAck) => void) => void;
}
export interface BugRoomServerToClientEvents {
  bug_room_update: (payload: BugFriendRoomView) => void;
  bug_room_closed: (payload: BugRoomClosedPayload) => void;
}

export const BUG_ROOM_CLIENT_EVENT_NAMES = ['bug_room_create', 'bug_room_join', 'bug_room_leave', 'bug_room_start'] as const satisfies readonly (keyof BugRoomClientToServerEvents)[];
export const BUG_ROOM_SERVER_EVENT_NAMES = ['bug_room_update', 'bug_room_closed'] as const satisfies readonly (keyof BugRoomServerToClientEvents)[];

// --- Validation ------------------------------------------------------------------------------------------------------------------

const invalid = (error: string): { ok: false; error: string; reason: 'invalidRequest' } => ({ ok: false, error, reason: 'invalidRequest' });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function validateBugRoomCreate(value: unknown): BugValidation<BugRoomCreatePayload> {
  if (!isRecord(value)) return invalid('Invalid request.');
  const timeControl = validateBugTimeControl(value.timeControl);
  return timeControl.ok ? { ok: true, value: { timeControl: timeControl.value } } : timeControl;
}

/** A join with anything but a well-formed code is refused with the ONE message (it is a failed guess like a wrong code). */
export function validateBugRoomJoin(value: unknown): BugValidation<BugRoomJoinPayload> {
  if (!isRecord(value)) return invalid(BUG_ROOM_NOT_FOUND_MESSAGE);
  const code = normalizeBugRoomCode(value.code);
  return code === null ? invalid(BUG_ROOM_NOT_FOUND_MESSAGE) : { ok: true, value: { code } };
}

export function validateBugRoomStart(value: unknown): BugValidation<BugRoomStartPayload> {
  if (!isRecord(value)) return invalid('Invalid request.');
  return value.mode === 'bots' || value.mode === 'queue' ? { ok: true, value: { mode: value.mode } } : invalid('Invalid request.');
}

/** The six time controls of B11 as a list for the room's picker (the same list as the queue's). */
export const BUG_ROOM_TIME_CONTROLS: readonly BughouseTimeControl[] = BUGHOUSE_TIME_CONTROLS;
