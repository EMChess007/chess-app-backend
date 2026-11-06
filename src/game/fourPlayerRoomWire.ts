// GENERATED FILE - DO NOT EDIT BY HAND.
// Source: src/logic/fourPlayerRoomWire.ts in the EM-Chess app repo. Regenerate with `npm run sync:fourplayer`; CI runs it with --check.
// The only difference from the source is that relative imports carry the '.js' suffix NodeNext requires.

/**
 * 4 Player FRIEND ROOMS - the wire contract (command #35; the twin of bughouse/roomWire.ts): events, payloads, the one error sentence and the pure code rules for "Challenge a Friend" in 4 Player
 * Chess, 4 Player Giveaway and Chaturaji. Types, literals and pure functions only, MIRRORED to the backend (backend/src/game/fourPlayerRoomWire.ts) so a client and the server cannot disagree about a
 * code, a field or a message. The server side is the ONE friend-room manager (backend friendRooms.ts) that Bughouse's rooms use too.
 *
 * THE FLOW (one host, up to three friends, in memory on the server):
 *   four_room_create { variant, timeControl } -> ack { room }   the host opens a room and gets a 6-character code (10 minutes)
 *   four_room_join   { code }                 -> ack { room }   a friend enters it (the room holds four members at most)
 *   four_room_leave                           -> ack            the host leaving closes the room; a friend leaving frees a slot (the code stays valid)
 *   four_room_start                           -> ack            the host starts: the friends are seated at random, BOTS FILL every empty seat, the game begins at once (four_match_found)
 *   four_room_update (server -> every member) the room as it is now      four_room_closed (server -> the friends) the room is gone
 * Every member is LOGGED IN. A code is consumed when the game starts and is invalid after its life (10 minutes). The code alphabet and length are the 2-player challenge's and Bughouse's.
 *
 * ONE ERROR. A code that is unknown, expired, full, closed or already started is refused with the same sentence, so the answer is no oracle for which it was. Repeated failures are the limiter's
 * (5 per 5 minutes per socket, then a 5 minute cooldown; 10 per 15 minutes per user; 30 per 15 minutes per address): the refusal says how long to wait and is the same whatever the code was.
 */
import type { FourAck, FourTimeControl, FourVariant } from './fourPlayerWire.js';
import { validateFourTimeControl, validateFourVariant } from './fourPlayerWire.js';

export const FOUR_ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const FOUR_ROOM_CODE_LENGTH = 6;
export const FOUR_ROOM_TTL_MS = 10 * 60 * 1000;
/** The host and up to three friends. */
export const FOUR_ROOM_MAX_MEMBERS = 4;

/** Trimmed, upper-cased, spaces and dashes removed; null unless exactly FOUR_ROOM_CODE_LENGTH characters of the alphabet. */
export function normalizeFourRoomCode(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const code = value.trim().toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== FOUR_ROOM_CODE_LENGTH) return null;
  for (const ch of code) if (!FOUR_ROOM_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

export const FOUR_ROOM_NOT_FOUND_MESSAGE = 'That code was not found or has expired.';
export const FOUR_ROOM_LOGIN_MESSAGE = 'Sign in to play with friends.';
export const FOUR_ROOM_HAVE_ROOM_MESSAGE = 'You already have an open room. Leave it first.';
export const FOUR_ROOM_BUSY_MESSAGE = 'Finish or leave your current game or queue first.';
export const FOUR_ROOM_CAP_MESSAGE = 'There are too many open rooms right now. Try again in a few minutes.';
export const FOUR_ROOM_OWN_MESSAGE = "You can't join your own room.";
export const FOUR_ROOM_NO_FRIEND_MESSAGE = 'Wait for a friend to join first.';
export const FOUR_ROOM_NOT_HOST_MESSAGE = 'Only the host can start the game.';
export const FOUR_ROOM_NOT_IN_ROOM_MESSAGE = 'You are not in a room.';

/** The label a room (and the queue) shows for a control: "No time limit", "5 min", "15 | 10", "1 day", "7 days" - the app's own labels (timeControlsEverywhere.test.ts compares them). */
export function fourControlLabel(timeControl: FourTimeControl): string {
  const { initialSeconds, incrementSeconds } = timeControl;
  if (initialSeconds === 0) return 'No time limit';
  if (initialSeconds >= 86_400) {
    const days = initialSeconds / 86_400;
    return days === 1 ? '1 day' : `${days} days`;
  }
  const minutes = initialSeconds / 60;
  return incrementSeconds === 0 ? `${minutes} min` : `${minutes} | ${incrementSeconds}`;
}

export type FourRoomPhase = 'open';

/** The room as ONE member sees it: names and numbers only (never a socket id or a user id). `members` lists the host first, then the friends in the order they came. */
export interface FourFriendRoomView {
  code: string;
  variant: FourVariant;
  timeControl: FourTimeControl;
  timeControlLabel: string;
  youAre: 'host' | 'friend';
  hostName: string;
  members: string[];
  /** The most members the room holds (the empty seats are filled with bots when the host starts). */
  maxMembers: number;
  phase: FourRoomPhase;
  /** How long the code stays valid, counted by the client on its own clock from the moment the view arrived. */
  expiresInMs: number;
}

export type FourRoomClosedReason = 'hostLeft' | 'expired';

export interface FourRoomCreatePayload {
  variant: FourVariant;
  timeControl: FourTimeControl;
}
export interface FourRoomJoinPayload {
  code: string;
}

export type FourRoomAck = FourAck<{ room: FourFriendRoomView }>;
export type FourRoomStartAck = FourAck<{ outcome: 'started' }>;
export interface FourRoomClosedPayload {
  reason: FourRoomClosedReason;
}

export interface FourRoomClientToServerEvents {
  four_room_create: (payload: FourRoomCreatePayload, ack: (res: FourRoomAck) => void) => void;
  four_room_join: (payload: FourRoomJoinPayload, ack: (res: FourRoomAck) => void) => void;
  four_room_leave: (payload: object, ack: (res: FourAck) => void) => void;
  four_room_start: (payload: object, ack: (res: FourRoomStartAck) => void) => void;
}
export interface FourRoomServerToClientEvents {
  four_room_update: (payload: FourFriendRoomView) => void;
  four_room_closed: (payload: FourRoomClosedPayload) => void;
}
export const FOUR_ROOM_CLIENT_EVENT_NAMES = ['four_room_create', 'four_room_join', 'four_room_leave', 'four_room_start'] as const satisfies readonly (keyof FourRoomClientToServerEvents)[];
export const FOUR_ROOM_SERVER_EVENT_NAMES = ['four_room_update', 'four_room_closed'] as const satisfies readonly (keyof FourRoomServerToClientEvents)[];

type Validation<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A create names its game (a client that sends none is refused: a room is never quietly 4 Player Chess) and one control of the app's list. */
export function validateFourRoomCreate(value: unknown): Validation<FourRoomCreatePayload> {
  if (!isRecord(value)) return fail('Invalid request.');
  if (value.variant === undefined) return fail('Unknown game mode.');
  const variant = validateFourVariant(value.variant);
  if (!variant.ok) return variant;
  const timeControl = validateFourTimeControl(value.timeControl);
  if (!timeControl.ok) return timeControl;
  return { ok: true, value: { variant: variant.value, timeControl: timeControl.value } };
}

/** A join with anything but a well-formed code is refused with the ONE message (it is a failed guess like a wrong code). */
export function validateFourRoomJoin(value: unknown): Validation<FourRoomJoinPayload> {
  if (!isRecord(value)) return fail(FOUR_ROOM_NOT_FOUND_MESSAGE);
  const code = normalizeFourRoomCode(value.code);
  return code === null ? fail(FOUR_ROOM_NOT_FOUND_MESSAGE) : { ok: true, value: { code } };
}
