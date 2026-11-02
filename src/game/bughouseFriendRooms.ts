/**
 * Bughouse ONLINE - FRIEND ROOMS (workstream W6; BUGHOUSE_SPEC.md 5.7, HP11, B16, Q2): the Bughouse instance of the ONE friend-room manager (friendRooms.ts, generalised by command #35 so that
 * 4 Player Chess, 4 Player Giveaway and Chaturaji use the same code). What is Bughouse's own is only: a room holds TWO members (the host and one friend, always teammates: seats 0 + 3), the
 * pair can enter the matchmaking as one group, and the view a member sees (`BugFriendRoomView`: host / friend names). The rules - the code, the 10 minute life, the cap, one room per user, the join
 * limiter, every leaving case - are friendRooms.ts's; read its header.
 */
import type { AttemptLimiter } from '../lib/attemptLimiter.js';
import { FriendRooms, type FriendRoomCaller, type FriendRoomMember, type FriendRoomRecord } from './friendRooms.js';
import type { BugTimers } from './bughouseRooms.js';
import { bughouseControlLabel, type BugAck, type BugFriendRoomView, type BugRoomClosedReason, type BugRoomStartMode, type BughouseTimeControl } from './bughouse/index.js';

export type { FriendRoomCaller, FriendRoomMember };

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

const viewOf = (room: FriendRoomRecord<BughouseTimeControl, undefined>, youAre: 'host' | 'friend', expiresInMs: number): BugFriendRoomView => ({
  code: room.code,
  timeControl: room.timeControl,
  timeControlLabel: room.label,
  youAre,
  hostName: room.host.name,
  friendName: room.friends[0] ? room.friends[0].name : null,
  phase: room.phase,
  expiresInMs,
});

export class BughouseFriendRooms extends FriendRooms<BughouseTimeControl, undefined, BugFriendRoomView> {
  constructor(deps: FriendRoomDeps) {
    super({
      maxMembers: 2,
      makeView: viewOf,
      labelOf: (timeControl) => bughouseControlLabel(timeControl),
      notifyRoom: deps.notifyRoom,
      notifyClosed: deps.notifyClosed,
      startWithBots: (members, timeControl, label) => deps.startWithBots([members[0], members[1]], timeControl, label),
      enqueue: deps.enqueue,
      cancelQueue: deps.cancelQueue,
      isBusy: deps.isBusy,
      timers: deps.timers,
      randomInt: deps.randomInt,
      ttlMs: deps.ttlMs,
      capacity: deps.capacity,
      limiter: deps.limiter,
    });
  }

  /** Opens a room for a logged-in user who is in no room, no queue and no match. */
  override create(host: FriendRoomMember, timeControl: BughouseTimeControl): BugAck<{ room: BugFriendRoomView }> {
    return super.create(host, timeControl, undefined);
  }

  override start(socketId: string, mode: BugRoomStartMode): BugAck<{ outcome: 'started' | 'queued' | 'solo' }> {
    return super.start(socketId, mode);
  }
}
