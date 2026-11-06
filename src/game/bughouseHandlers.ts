/**
 * Bughouse ONLINE - the Socket.IO surface (workstream W2; the `bug_*` protocol of bughouse/wire.ts).
 *
 * `registerBughouseHandlers(io)` is the ONLY thing index.ts calls. It adds its OWN `connection` listener (the 2-player and the 4-seat handlers are untouched: no shared code path, no shared
 * state, no event name in common - every event here is `bug_*`), builds the room manager and the matchmaker, and wires each socket's eleven client->server events to them. All the rules live
 * in those two classes; this file only PARSES, DELEGATES and REPLIES (it is the boundary with the network, written like fourPlayerHandlers.ts):
 *  - A client can send anything. `listen()` normalises socket.io's argument shapes (a client that sends no payload passes the ack FIRST), replies through a safe `reply`, and catches BOTH
 *    a synchronous throw and a rejected promise: nothing a client does can become an uncaught exception, which would kill every game on the process.
 *  - The seat is the SOCKET's. Identity is the optional JWT in the handshake (a valid token gives a user, anything else a guest); a username is looked up when a player QUEUES (one query
 *    per join; a failed lookup falls back to "Player"), so creating a room stays synchronous and race-free.
 *  - A socket that is seated in a match cannot queue; one that is queued cannot queue again; a socket that disconnected while its username was being looked up is never queued.
 *  - `disconnect` leaves the queue AND tells the room manager (grace countdown, takeover, all-gone), each guarded so one cannot skip the other.
 */
import type { Server, Socket } from 'socket.io';
import { prisma } from '../lib/prisma.js';
import { verifyToken } from '../lib/jwt.js';
import { clientIpOf, resolveTrustedHops } from '../lib/clientIp.js';
import { bugRefusal, validateBugJoinQueue, validateBugRoomCreate, validateBugRoomJoin, validateBugRoomStart, type BugFriendRoomView, type BugQueueUpdatePayload, type BugRoomClosedReason } from './bughouse/index.js';
import { BughouseFriendRooms, type FriendRoomDeps, type FriendRoomMember } from './bughouseFriendRooms.js';
import { BUG_ROOM_SWEEP_MS } from './bughouseRoomLimiter.js';
import { BughouseMatchmaker, placeGroups, type BugMatchmakerDeps } from './bughouseMatchmaking.js';
import { BughouseRoomManager } from './bughouseRooms.js';
import { resolveBugRoomTtlMs } from './bughouseTestSwitches.js';

export interface BugHandlerDeps {
  /** A user's display name; default: the username from the database. A rejection falls back to "Player". */
  resolveName?: (userId: string) => Promise<string>;
  /** A socket's user id (null = guest); default: the JWT in `handshake.auth.token`. */
  userIdOf?: (socket: Socket) => string | null;
  /** Options for the room manager (clock and timers, bot randomness, an injected bot chooser) - tests. */
  roomOptions?: ConstructorParameters<typeof BughouseRoomManager>[1];
  /** Options for the matchmaker (fill wait, random source) - tests and the dev override. */
  matchmakerOptions?: Pick<BugMatchmakerDeps, 'fillWaitMs' | 'randomInt'>;
  /** Options for the friend rooms (room life, cap, code randomness, limiter) - tests; the room life otherwise comes from the guarded test-only override (bughouseTestSwitches.ts). */
  friendRoomOptions?: Partial<Pick<FriendRoomDeps, 'ttlMs' | 'capacity' | 'randomInt' | 'limiter'>>;
  /** How many trusted proxies sit in front (lib/clientIp.ts); default TRUSTED_PROXY_HOPS or the production rule. */
  trustedProxyHops?: number;
}

type Reply = (response: unknown) => void;

/** The same rule as the other servers' `extractUserId`: a valid JWT identifies a user; no token, or a bad one, is a guest. */
function userIdFromHandshake(socket: Socket): string | null {
  const token = socket.handshake?.auth?.token;
  if (typeof token !== 'string' || !token) return null;
  try {
    return verifyToken(token).userId;
  } catch {
    return null;
  }
}

async function usernameFromDatabase(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { username: true } });
  return user?.username ?? 'Player';
}

/**
 * Registers one event with every protection described in the file header. The handler gets the payload (as `unknown`) and a `reply` that is safe to call whatever the client sent;
 * whatever it throws or rejects with is logged and answered with a generic error.
 */
function listen(socket: Socket, event: string, handler: (payload: unknown, reply: Reply) => void | Promise<void>): void {
  socket.on(event, (first: unknown, second: unknown) => {
    // socket.io puts the ack LAST: a client that sends no payload leaves it in first place; anything that is not a function is no ack.
    const ack = typeof second === 'function' ? second : typeof first === 'function' ? first : undefined;
    const payload = typeof first === 'function' ? undefined : first;
    const reply: Reply = (response) => {
      if (typeof ack !== 'function') return;
      try {
        ack(response);
      } catch (err) {
        console.error(`[bughouseSocket] the ack of ${event} threw:`, err);
      }
    };
    const fail = (err: unknown): void => {
      console.error(`[bughouseSocket] ${event} failed:`, err);
      reply(bugRefusal('invalidRequest', 'Something went wrong.'));
    };
    try {
      const result = handler(payload, reply);
      if (result && typeof (result as Promise<void>).then === 'function') (result as Promise<void>).then(undefined, fail);
    } catch (err) {
      fail(err);
    }
  });
}

export function registerBughouseHandlers(io: Server, deps: BugHandlerDeps = {}): { rooms: BughouseRoomManager; matchmaker: BughouseMatchmaker; friendRooms: BughouseFriendRooms } {
  const rooms = new BughouseRoomManager(io, deps.roomOptions);
  const userIdOf = deps.userIdOf ?? userIdFromHandshake;
  const resolveName = deps.resolveName ?? usernameFromDatabase;
  const trustedProxyHops = deps.trustedProxyHops ?? resolveTrustedHops();
  const randomInt = deps.matchmakerOptions?.randomInt ?? ((n: number) => Math.floor(Math.random() * n));
  // (assigned below; the matchmaker and the friend rooms point at each other)
  let friendRooms: BughouseFriendRooms;

  const matchmaker = new BughouseMatchmaker({
    ...deps.matchmakerOptions,
    ...(deps.roomOptions?.timers ? { timers: deps.roomOptions.timers } : {}),
    startGame: (seats, timeControl, timeControlLabel) => {
      const created = rooms.createRoom({ seats, timeControl, timeControlLabel });
      console.log(`[bughouseSocket] match_found room=${created.roomId} humans=${seats.filter((s) => s.kind === 'human').length} bots=${seats.filter((s) => s.kind === 'bot').length} ${timeControlLabel}`);
      // a queued friend pair's code is consumed when its match starts
      friendRooms.matchStarted(seats.flatMap((s) => (s.kind === 'human' && s.socketId ? [s.socketId] : [])));
    },
    onGroupCancelled: (leaver, others) => friendRooms.pairCancelled(leaver, others),
    notify: (socketId, update: BugQueueUpdatePayload) => {
      try {
        io.to(socketId).emit('bug_queue_update', update);
      } catch (err) {
        console.error(`[bughouseSocket] failed to send bug_queue_update to ${socketId}:`, err);
      }
    },
  });

  // --- friend rooms (W6) ---
  friendRooms = new BughouseFriendRooms({
    timers: deps.roomOptions?.timers,
    ttlMs: resolveBugRoomTtlMs(),
    ...deps.friendRoomOptions,
    notifyRoom: (socketId, view: BugFriendRoomView) => {
      try {
        io.to(socketId).emit('bug_room_update', view);
      } catch (err) {
        console.error('[bughouseSocket] failed to send bug_room_update:', err);
      }
    },
    notifyClosed: (socketId, reason: BugRoomClosedReason) => {
      try {
        io.to(socketId).emit('bug_room_closed', { reason });
      } catch (err) {
        console.error('[bughouseSocket] failed to send bug_room_closed:', err);
      }
    },
    startWithBots: (members, timeControl, timeControlLabel) => {
      const now = Date.now();
      const entries = members.map((m: FriendRoomMember) => ({ socketId: m.socketId, userId: m.userId, name: m.name, timeControl, joinedAt: now }));
      const seats = placeGroups([{ members: entries }], randomInt);
      const created = rooms.createRoom({ seats, timeControl, timeControlLabel });
      console.log(`[bughouseSocket] match_found room=${created.roomId} humans=2 bots=2 friends ${timeControlLabel}`);
    },
    enqueue: (members, timeControl) => matchmaker.joinGroup(members.map((m) => ({ socketId: m.socketId, userId: m.userId, name: m.name, timeControl }))),
    cancelQueue: (socketId) => void matchmaker.leave(socketId),
    isBusy: (socketId) => rooms.isSeated(socketId) || matchmaker.isQueued(socketId),
  });
  setInterval(() => friendRooms.sweep(), BUG_ROOM_SWEEP_MS).unref();

  io.on('connection', (socket) => {
    const userId = userIdOf(socket);
    const callerOf = async (): Promise<FriendRoomMember & { ip: string }> => {
      let name = 'Player';
      if (userId) {
        try {
          name = await resolveName(userId);
        } catch (err) {
          console.error('[bughouseSocket] username lookup failed, using "Player":', err);
        }
      }
      const ip = clientIpOf({ peer: socket.handshake?.address ?? '', forwardedFor: socket.handshake?.headers?.['x-forwarded-for'] }, trustedProxyHops);
      return { socketId: socket.id, userId, name, ip };
    };

    listen(socket, 'bug_room_create', async (payload, reply) => {
      const parsed = validateBugRoomCreate(payload);
      if (!parsed.ok) return reply(parsed);
      const caller = await callerOf();
      if (!socket.connected) return;
      reply(friendRooms.create(caller, parsed.value.timeControl));
    });
    listen(socket, 'bug_room_join', async (payload, reply) => {
      // a malformed code is a failed guess like a wrong one: it goes through the limiter too (with the one sentence), so the answer is no oracle
      const parsed = validateBugRoomJoin(payload);
      const caller = await callerOf();
      if (!socket.connected) return;
      reply(friendRooms.join(caller, parsed.ok ? parsed.value.code : null));
    });
    listen(socket, 'bug_room_leave', (_payload, reply) => reply(friendRooms.leave(socket.id)));
    listen(socket, 'bug_room_start', (payload, reply) => {
      const parsed = validateBugRoomStart(payload);
      if (!parsed.ok) return reply(parsed);
      reply(friendRooms.start(socket.id, parsed.value.mode));
    });

    listen(socket, 'bug_join_queue', async (payload, reply) => {
      const parsed = validateBugJoinQueue(payload);
      if (!parsed.ok) return reply(parsed);
      const refusal = () =>
        rooms.isSeated(socket.id)
          ? bugRefusal('noGame', 'You are already in a game.')
          : matchmaker.isQueued(socket.id)
            ? bugRefusal('invalidRequest', 'You are already in a queue.')
            : friendRooms.viewFor(socket.id) !== null
              ? bugRefusal('invalidRequest', 'Leave your friend room first, or start from it.')
              : null;
      const early = refusal();
      if (early) return reply(early);

      let name = 'Guest';
      if (userId) {
        try {
          name = await resolveName(userId);
        } catch (err) {
          console.error('[bughouseSocket] username lookup failed, using "Player":', err);
          name = 'Player';
        }
      }
      if (!socket.connected) return; // it left while its username was being looked up: never queue a dead socket
      const late = refusal(); // ...and something else may have happened to this socket meanwhile
      if (late) return reply(late);
      reply(matchmaker.join({ socketId: socket.id, userId, name, timeControl: parsed.value.timeControl }));
    });

    listen(socket, 'bug_leave_queue', (_payload, reply) => {
      matchmaker.leave(socket.id);
      reply({ ok: true });
    });

    listen(socket, 'bug_move', (payload, reply) => reply(rooms.makeMove(socket.id, payload)));
    listen(socket, 'bug_drop', (payload, reply) => reply(rooms.makeDrop(socket.id, payload)));
    listen(socket, 'bug_resign', (payload, reply) => reply(rooms.resign(socket.id, payload)));
    listen(socket, 'bug_rejoin', (payload, reply) => reply(rooms.rejoin(socket.id, payload)));
    listen(socket, 'bug_chat', (payload, reply) => reply(rooms.sendChat(socket.id, payload)));
    listen(socket, 'bug_quick', (payload, reply) => reply(rooms.sendQuick(socket.id, payload)));
    listen(socket, 'bug_list_active_games', (_payload, reply) => reply({ ok: true, games: rooms.listActiveGames() }));
    listen(socket, 'bug_spectate_game', (payload, reply) => reply(rooms.spectate(socket.id, payload)));
    listen(socket, 'bug_stop_spectating', (_payload, reply) => {
      rooms.stopSpectating(socket.id);
      reply({ ok: true });
    });

    socket.on('disconnect', () => {
      try {
        friendRooms.disconnect(socket.id); // first: it settles the room (and a queued pair) before the plain queue leave below
      } catch (err) {
        console.error('[bughouseSocket] leaving the friend room on disconnect failed:', err);
      }
      try {
        matchmaker.leave(socket.id);
      } catch (err) {
        console.error('[bughouseSocket] leaving the queue on disconnect failed:', err);
      }
      try {
        rooms.handleDisconnect(socket.id);
      } catch (err) {
        console.error('[bughouseSocket] room disconnect handling failed:', err);
      }
    });
  });

  return { rooms, matchmaker, friendRooms };
}
