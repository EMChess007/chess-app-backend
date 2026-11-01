/**
 * Bughouse ONLINE - FRIEND ROOMS (workstream W6; BUGHOUSE_SPEC.md 5.7, HP11, B16, Q2).
 *
 * A room is a private meeting place for two logged-in friends: the host creates it (a 6-character code, 10 minutes), the friend joins with the code, and the host starts - either with the two
 * bots on the other team at once, or by entering the matchmaking as a PAIR (one group of two, via the matchmaker's `joinGroup`; there is no second code path to a match). The friends are always
 * teammates (seats 0 + 3, `placeGroups`) and a bot never partners them.
 *
 * Like the matchmaker this class knows neither sockets nor the room manager: telling a member about the room, starting a match, entering the queue and asking "is this socket busy" are INJECTED,
 * and the clock and timers are the injected `BugTimers`, so the tests drive every leaving case and every expiry with a fake clock and no network.
 *
 * ABUSE (HP11):
 *  - CODE GUESSING. Failed joins are limited per socket, per user and per client address (bughouseRoomLimiter.ts, built on the shared AttemptLimiter); a blocked scope refuses WITHOUT looking
 *    at the code, with its own cooldown message; every other failure - unknown, expired, full, closed, already started, malformed - gives ONE identical sentence. Only failures count; a
 *    success counts for nothing and resets nothing. A code is never logged and never reaches the limiter.
 *  - ONE open room per user (as host OR friend) and a process-wide cap (BUG_ROOM_CAP).
 *  - LIFETIME. In memory; a room dies BUG_ROOM_TTL_MS after its creation (checked on every lookup, and swept every 5 minutes), when its host leaves or disconnects, and when its match starts
 *    (the code is consumed). A friend who leaves or disconnects frees the friend slot and the code stays valid.
 *
 * LEAVING, every case (`leave` / `disconnect` are the same rule):
 *   host, room open     -> the room is deleted, the friend is told 'hostLeft'
 *   host, pair queued   -> the pair entry is cancelled, then as above
 *   friend, room open   -> the slot is freed, the host is told (the code stays valid)
 *   friend, pair queued -> the pair entry is cancelled, the slot is freed, the host is back on the room screen
 *   a member CANCELS the queue (not a disconnect) -> the pair entry is cancelled and both are back in the open room (the matchmaker calls `pairCancelled`)
 */
import { randomInt as cryptoRandomInt } from 'node:crypto';
import type { AttemptLimiter } from '../lib/attemptLimiter.js';
import { BUG_ROOM_CAP, createBugRoomJoinLimiter } from './bughouseRoomLimiter.js';
import type { BugTimers } from './bughouseRooms.js';
import { realTimers } from './bughouseRooms.js';
import { bugTimeControlLabel } from './bughouseConfig.js';
import {
  BUG_ROOM_BUSY_MESSAGE,
  BUG_ROOM_CAP_MESSAGE,
  BUG_ROOM_CODE_ALPHABET,
  BUG_ROOM_CODE_LENGTH,
  BUG_ROOM_HAVE_ROOM_MESSAGE,
  BUG_ROOM_LOGIN_MESSAGE,
  BUG_ROOM_NO_FRIEND_MESSAGE,
  BUG_ROOM_NOT_FOUND_MESSAGE,
  BUG_ROOM_NOT_HOST_MESSAGE,
  BUG_ROOM_NOT_IN_ROOM_MESSAGE,
  BUG_ROOM_OWN_MESSAGE,
  BUG_ROOM_TTL_MS,
  bugRefusal,
  bugRoomCooldownMessage,
  type BugAck,
  type BugFriendRoomView,
  type BugRoomClosedReason,
  type BugRoomPhase,
  type BugRoomStartMode,
  type BughouseTimeControl,
} from './bughouse/index.js';

export interface FriendRoomMember {
  socketId: string;
  userId: string | null;
  name: string;
}

/** Who is asking and from where: the three keys the limiter counts failures under. */
export interface FriendRoomCaller extends FriendRoomMember {
  ip: string | null;
}

export interface FriendRoomDeps {
  /** Sends a member the room as they see it now. Must not throw. */
  notifyRoom(socketId: string, view: BugFriendRoomView): void;
  /** Tells a member the room is gone. Must not throw. */
  notifyClosed(socketId: string, reason: BugRoomClosedReason): void;
  /** Starts a match for the pair with the other team filled by bots (seats 0 + 3 are the friends). May throw: the room is then kept. */
  startWithBots(members: [FriendRoomMember, FriendRoomMember], timeControl: BughouseTimeControl, timeControlLabel: string): void;
  /** Enters the matchmaking: a group of two (the pair) or of one (the host alone). */
  enqueue(members: FriendRoomMember[], timeControl: BughouseTimeControl): BugAck;
  /** Takes a socket (and, for a pair, its friend) out of the queue; the matchmaker's `leave`. */
  cancelQueue(socketId: string): void;
  /** Whether the socket sits in a match or in a queue already. */
  isBusy(socketId: string): boolean;
  timers?: BugTimers;
  /** A uniform integer in [0, maxExclusive); default crypto.randomInt. */
  randomInt?: (maxExclusive: number) => number;
  /** The room's life; default BUG_ROOM_TTL_MS. The test-only override is resolved by the caller (bughouseTestSwitches.ts). */
  ttlMs?: number;
  /** The process-wide cap; default BUG_ROOM_CAP. */
  capacity?: number;
  /** The join limiter; default the production one on the injected clock. */
  limiter?: AttemptLimiter;
}

interface Room {
  code: string;
  host: FriendRoomMember;
  friend: FriendRoomMember | null;
  timeControl: BughouseTimeControl;
  label: string;
  createdAt: number;
  phase: BugRoomPhase;
}

export class BughouseFriendRooms {
  private rooms = new Map<string, Room>();
  private bySocket = new Map<string, string>();
  private byUser = new Map<string, string>();
  private readonly timers: BugTimers;
  private readonly randomInt: (maxExclusive: number) => number;
  private readonly ttlMs: number;
  private readonly capacity: number;
  readonly limiter: AttemptLimiter;

  constructor(private deps: FriendRoomDeps) {
    this.timers = deps.timers ?? realTimers;
    this.randomInt = deps.randomInt ?? ((n) => cryptoRandomInt(n));
    this.ttlMs = deps.ttlMs ?? BUG_ROOM_TTL_MS;
    this.capacity = deps.capacity ?? BUG_ROOM_CAP;
    this.limiter = deps.limiter ?? createBugRoomJoinLimiter(() => this.timers.now());
  }

  // --- create / join -----------------------------------------------------------------------------------------------------------

  /** Opens a room for a logged-in user who is in no room, no queue and no match. */
  create(host: FriendRoomMember, timeControl: BughouseTimeControl): BugAck<{ room: BugFriendRoomView }> {
    if (host.userId === null) return bugRefusal('invalidRequest', BUG_ROOM_LOGIN_MESSAGE);
    this.dropExpired();
    if (this.bySocket.has(host.socketId) || this.byUser.has(host.userId)) return bugRefusal('invalidRequest', BUG_ROOM_HAVE_ROOM_MESSAGE);
    if (this.deps.isBusy(host.socketId)) return bugRefusal('invalidRequest', BUG_ROOM_BUSY_MESSAGE);
    if (this.rooms.size >= this.capacity) return bugRefusal('rateLimited', BUG_ROOM_CAP_MESSAGE);
    const code = this.newCode();
    const room: Room = { code, host, friend: null, timeControl, label: bugTimeControlLabel(timeControl.initialMs, timeControl.incrementMs), createdAt: this.timers.now(), phase: 'open' };
    this.rooms.set(code, room);
    this.bySocket.set(host.socketId, code);
    this.byUser.set(host.userId, code);
    return { ok: true, room: this.viewOf(room, 'host') };
  }

  /**
   * The friend enters with the code. Order matters: who the caller is (login, already in a room, busy) is answered before the code is looked at and is not a guess; a blocked limiter scope
   * refuses without looking at the code; EVERY failure about the code itself is one sentence and counts as a failed guess.
   */
  join(caller: FriendRoomCaller, code: string | null): BugAck<{ room: BugFriendRoomView }> {
    if (caller.userId === null) return bugRefusal('invalidRequest', BUG_ROOM_LOGIN_MESSAGE);
    if (this.bySocket.has(caller.socketId) || this.byUser.has(caller.userId)) return bugRefusal('invalidRequest', BUG_ROOM_HAVE_ROOM_MESSAGE);
    if (this.deps.isBusy(caller.socketId)) return bugRefusal('invalidRequest', BUG_ROOM_BUSY_MESSAGE);
    const keys = { socket: caller.socketId, user: caller.userId, ip: caller.ip };
    const verdict = this.limiter.check(keys);
    if (!verdict.allowed) return bugRefusal('rateLimited', bugRoomCooldownMessage(verdict.retryAfterMs));
    const room = code === null ? null : this.find(code);
    if (room === null || room.friend !== null || room.phase !== 'open') {
      this.limiter.recordFailure(keys);
      return bugRefusal('invalidRequest', BUG_ROOM_NOT_FOUND_MESSAGE);
    }
    if (room.host.userId === caller.userId || room.host.socketId === caller.socketId) return bugRefusal('invalidRequest', BUG_ROOM_OWN_MESSAGE);
    room.friend = { socketId: caller.socketId, userId: caller.userId, name: caller.name };
    this.bySocket.set(caller.socketId, room.code);
    this.byUser.set(caller.userId, room.code);
    this.deps.notifyRoom(room.host.socketId, this.viewOf(room, 'host'));
    return { ok: true, room: this.viewOf(room, 'friend') };
  }

  // --- leaving -----------------------------------------------------------------------------------------------------------------

  /** A member leaves on purpose. Not in a room: an error. */
  leave(socketId: string): BugAck {
    const room = this.roomOf(socketId);
    if (room === null) return bugRefusal('noGame', BUG_ROOM_NOT_IN_ROOM_MESSAGE);
    this.remove(room, socketId);
    return { ok: true };
  }

  /** A socket disconnected: the same rule as leaving, and safe for a socket that is in no room. */
  disconnect(socketId: string): void {
    const room = this.roomOf(socketId);
    if (room !== null) this.remove(room, socketId);
  }

  private remove(room: Room, socketId: string): void {
    const wasQueued = room.phase === 'queued';
    room.phase = 'open'; // (so the matchmaker's pairCancelled below finds nothing to do)
    if (wasQueued) this.deps.cancelQueue(socketId);
    if (room.host.socketId === socketId) {
      this.delete(room);
      if (room.friend) this.deps.notifyClosed(room.friend.socketId, 'hostLeft');
      return;
    }
    // the friend: the slot is freed and the code stays valid
    this.forget(room.friend as FriendRoomMember);
    room.friend = null;
    this.deps.notifyRoom(room.host.socketId, this.viewOf(room, 'host'));
  }

  /** The matchmaker cancelled a pair entry because a member left the queue on purpose: both are back in the OPEN room. (A disconnect has already been settled by `disconnect`.) */
  pairCancelled(leaverSocketId: string, otherSocketIds: string[]): void {
    const room = this.roomOf(leaverSocketId) ?? otherSocketIds.map((id) => this.roomOf(id)).find((r) => r !== null && r !== undefined) ?? null;
    if (room === null || room.phase !== 'queued') return;
    room.phase = 'open';
    this.notifyBoth(room);
  }

  /** A match started for these sockets: the rooms of queued pairs among them are consumed (their code no longer works). */
  matchStarted(socketIds: readonly string[]): void {
    for (const id of socketIds) {
      const room = this.roomOf(id);
      if (room !== null && room.phase === 'queued') this.delete(room);
    }
  }

  // --- starting ----------------------------------------------------------------------------------------------------------------

  /**
   * The host starts. 'bots': needs the friend; the match starts at once with the two bots on the other team and the room is consumed. 'queue': with the friend, the pair enters the matchmaking
   * as ONE group and the room waits in phase 'queued' (both screens show the queue); without a friend, the host enters a normal SOLO queue and the room is closed.
   */
  start(socketId: string, mode: BugRoomStartMode): BugAck<{ outcome: 'started' | 'queued' | 'solo' }> {
    const room = this.roomOf(socketId);
    if (room === null) return bugRefusal('noGame', BUG_ROOM_NOT_IN_ROOM_MESSAGE);
    if (room.host.socketId !== socketId) return bugRefusal('invalidRequest', BUG_ROOM_NOT_HOST_MESSAGE);
    if (room.phase !== 'open') return bugRefusal('invalidRequest', 'The room is already looking for a match.');
    if (this.expired(room)) {
      this.expire(room);
      return bugRefusal('noGame', BUG_ROOM_NOT_IN_ROOM_MESSAGE);
    }
    if (mode === 'bots') {
      if (room.friend === null) return bugRefusal('invalidRequest', BUG_ROOM_NO_FRIEND_MESSAGE);
      try {
        this.deps.startWithBots([room.host, room.friend], room.timeControl, room.label);
      } catch (err) {
        console.error('[bughouseFriendRooms] starting a match with bots failed; the room stays open:', err);
        return bugRefusal('invalidRequest', 'Could not start the match. Try again.');
      }
      this.delete(room);
      return { ok: true, outcome: 'started' };
    }
    if (room.friend === null) {
      // "Find a match alone": the host becomes a normal solo queue entry and the room is consumed
      const entered = this.deps.enqueue([room.host], room.timeControl);
      if (!entered.ok) return entered;
      this.delete(room);
      return { ok: true, outcome: 'solo' };
    }
    // 'queued' BEFORE the pair enters: a pair that completes a table (three or two humans already waiting) starts its match INSIDE `enqueue`, and `matchStarted` must find the room queued to consume it
    room.phase = 'queued';
    const entered = this.deps.enqueue([room.host, room.friend], room.timeControl);
    if (!entered.ok) {
      room.phase = 'open';
      return entered;
    }
    if (!this.rooms.has(room.code)) return { ok: true, outcome: 'started' }; // the match began at once; the room was consumed on the way (the clients already hold bug_match_found)
    this.notifyBoth(room);
    return { ok: true, outcome: 'queued' };
  }

  // --- lifetime ----------------------------------------------------------------------------------------------------------------

  /** Deletes every room older than its life (and cancels a queued pair); returns how many. The owner calls it on an unref'd 5-minute interval. Also drops remembered limiter keys. */
  sweep(): number {
    let n = 0;
    for (const room of [...this.rooms.values()]) {
      if (this.expired(room)) {
        this.expire(room);
        n++;
      }
    }
    this.limiter.sweep();
    return n;
  }

  /** The number of open rooms (a metric and a test). */
  size(): number {
    return this.rooms.size;
  }

  /** The room a socket is in, as that member sees it, or null. */
  viewFor(socketId: string): BugFriendRoomView | null {
    const room = this.roomOf(socketId);
    return room === null ? null : this.viewOf(room, room.host.socketId === socketId ? 'host' : 'friend');
  }

  // --- internals ---------------------------------------------------------------------------------------------------------------

  private expired(room: Room): boolean {
    return this.timers.now() - room.createdAt >= this.ttlMs;
  }

  /** A room whose life is over: a queued pair is taken out of the queue, both members are told, the room is deleted. */
  private expire(room: Room): void {
    if (room.phase === 'queued') {
      room.phase = 'open';
      this.deps.cancelQueue(room.host.socketId);
    }
    this.delete(room);
    this.deps.notifyClosed(room.host.socketId, 'expired');
    if (room.friend) this.deps.notifyClosed(room.friend.socketId, 'expired');
  }

  private dropExpired(): void {
    for (const room of [...this.rooms.values()]) if (this.expired(room)) this.expire(room);
  }

  /** A room by code, or null; an expired one is deleted on the way (a joiner sees "not found" either way). */
  private find(code: string): Room | null {
    const room = this.rooms.get(code);
    if (!room) return null;
    if (this.expired(room)) {
      this.expire(room);
      return null;
    }
    return room;
  }

  private roomOf(socketId: string): Room | null {
    const code = this.bySocket.get(socketId);
    return code === undefined ? null : this.rooms.get(code) ?? null;
  }

  private forget(member: FriendRoomMember): void {
    this.bySocket.delete(member.socketId);
    if (member.userId !== null && this.byUser.get(member.userId) !== undefined) this.byUser.delete(member.userId);
  }

  private delete(room: Room): void {
    this.rooms.delete(room.code);
    this.forget(room.host);
    if (room.friend) this.forget(room.friend);
  }

  private notifyBoth(room: Room): void {
    this.deps.notifyRoom(room.host.socketId, this.viewOf(room, 'host'));
    if (room.friend) this.deps.notifyRoom(room.friend.socketId, this.viewOf(room, 'friend'));
  }

  private viewOf(room: Room, youAre: 'host' | 'friend'): BugFriendRoomView {
    return {
      code: room.code,
      timeControl: room.timeControl,
      timeControlLabel: room.label,
      youAre,
      hostName: room.host.name,
      friendName: room.friend ? room.friend.name : null,
      phase: room.phase,
      expiresInMs: Math.max(0, room.createdAt + this.ttlMs - this.timers.now()),
    };
  }

  private newCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < BUG_ROOM_CODE_LENGTH; i++) code += BUG_ROOM_CODE_ALPHABET[this.randomInt(BUG_ROOM_CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
  }
}
