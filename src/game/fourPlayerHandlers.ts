/**
 * 4 Player Chess ONLINE - the Socket.IO surface (workstream W4; the `four_*` protocol of fourPlayerWire.ts).
 *
 * `registerFourPlayerHandlers(io)` is the ONLY thing index.ts calls. It adds its OWN `connection` listener (the 2-player
 * `registerSocketHandlers` is untouched: no shared code path, no shared state, no event names in common - every event here is `four_*`),
 * builds the room manager (W2/W3) and the matchmaker, and wires each socket's nine client->server events to them. All the rules live in
 * those two classes; this file only PARSES, DELEGATES and REPLIES.
 *
 * WHAT IT GUARANTEES, because it is the boundary with the network:
 *  - A client can send anything. `listen()` normalises socket.io's argument shapes (a client that sends no payload passes the ack FIRST;
 *    one that sends a non-function where the ack belongs would make the 2-player `ack?.()` throw), replies through a safe `reply`, and
 *    catches BOTH a synchronous throw and a rejected promise: nothing a client does can become an uncaught exception, which would kill
 *    every game on the process. Payloads reach the manager as `unknown` and are validated there with the shared wire validators.
 *  - The seat is the SOCKET's. Identity is the optional JWT in the handshake (the same rule as the 2-player server's extractUserId: a
 *    valid token gives a user, anything else a guest); a username is looked up when a player QUEUES (one query per join; a failed lookup
 *    falls back to "Player" instead of blocking the queue), so creating a room stays synchronous and race-free.
 *  - A socket that is seated in a game cannot queue; one that is queued cannot queue again; a socket that disconnected while its username
 *    was being looked up is never queued.
 *  - `disconnect` leaves the queue AND tells the room manager (grace countdown, takeover, all-gone), each guarded so one cannot skip the other.
 */
import type { Server, Socket } from 'socket.io';
import { prisma } from '../lib/prisma.js';
import { verifyToken } from '../lib/jwt.js';
import { clientIpOf, resolveTrustedHops } from '../lib/clientIp.js';
import { FOUR_BOT_ELO, FOUR_BOT_NAME } from './fourPlayerConfig.js';
import { FriendRooms, type FriendRoomMember, type FriendRoomMessages } from './friendRooms.js';
import { FourPlayerMatchmaker, shuffled, type FourMatchmakerDeps } from './fourPlayerMatchmaking.js';
import { FourRoomManager, type FourSeatSetup, type FourSeatSetups } from './fourPlayerRooms.js';
import {
  FOUR_ROOM_BUSY_MESSAGE,
  FOUR_ROOM_CAP_MESSAGE,
  FOUR_ROOM_HAVE_ROOM_MESSAGE,
  FOUR_ROOM_LOGIN_MESSAGE,
  FOUR_ROOM_MAX_MEMBERS,
  FOUR_ROOM_NOT_FOUND_MESSAGE,
  FOUR_ROOM_NOT_HOST_MESSAGE,
  FOUR_ROOM_NOT_IN_ROOM_MESSAGE,
  FOUR_ROOM_NO_FRIEND_MESSAGE,
  FOUR_ROOM_OWN_MESSAGE,
  fourControlLabel,
  validateFourRoomCreate,
  validateFourRoomJoin,
  type FourFriendRoomView,
} from './fourPlayerRoomWire.js';
import { validateFourJoinQueue, type FourQueueUpdatePayload, type FourTimeControl, type FourVariant } from './fourPlayerWire.js';

const FOUR_ROOM_MESSAGES: FriendRoomMessages = {
  login: FOUR_ROOM_LOGIN_MESSAGE,
  haveRoom: FOUR_ROOM_HAVE_ROOM_MESSAGE,
  busy: FOUR_ROOM_BUSY_MESSAGE,
  cap: FOUR_ROOM_CAP_MESSAGE,
  own: FOUR_ROOM_OWN_MESSAGE,
  noFriend: FOUR_ROOM_NO_FRIEND_MESSAGE,
  notHost: FOUR_ROOM_NOT_HOST_MESSAGE,
  notInRoom: FOUR_ROOM_NOT_IN_ROOM_MESSAGE,
  notFound: FOUR_ROOM_NOT_FOUND_MESSAGE,
};

export interface FourHandlerDeps {
  /** A user's display name; default: the username from the database. A rejection falls back to "Player". */
  resolveName?: (userId: string) => Promise<string>;
  /** A socket's user id (null = guest); default: the JWT in `handshake.auth.token`. */
  userIdOf?: (socket: Socket) => string | null;
  /** Options for the room manager (engine / bot randomness, an injected bot chooser) - tests. */
  roomOptions?: ConstructorParameters<typeof FourRoomManager>[1];
  /** Options for the matchmaker (fill wait, random source) - tests and the dev override. */
  matchmakerOptions?: Pick<FourMatchmakerDeps, 'fillWaitMs' | 'randomInt'>;
  /** TEST ONLY (src/game/fourTestSwitches.ts): a start snapshot armed for the next room of this variant, or undefined. Absent in production. */
  startSnapshotFor?: (variant: FourVariant) => string | undefined;
  /** Hops of trusted proxies in front of the server (the join limiter's client address); default resolveTrustedHops(). */
  trustedProxyHops?: number;
  /** Options for the friend rooms (the clock, the limiter, the code source, the life) - tests. */
  friendRoomOptions?: Partial<Pick<ConstructorParameters<typeof FriendRooms<FourTimeControl, FourVariant, FourFriendRoomView>>[0], 'timers' | 'randomInt' | 'ttlMs' | 'capacity' | 'limiter'>>;
}

type Reply = (response: unknown) => void;

/** The same rule as the 2-player server's `extractUserId` (socketHandlers.ts): a valid JWT identifies a user; no token, or a bad one, is a guest. */
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
 * Registers one event with every protection described in the file header. The handler gets the payload (as `unknown`) and a `reply`
 * that is safe to call whatever the client sent; whatever it throws or rejects with is logged and answered with a generic error.
 * EQUIVALENT-MUTANT NOTE (W4 set, "an ack passed first is also taken as the payload"): `typeof first === 'function' ? undefined : first` could be just
 * `first` - every event validates its payload as `unknown`, and a function and `undefined` are both "not an object", so the reply is the same refusal.
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
        console.error(`[fourSocket] the ack of ${event} threw:`, err);
      }
    };
    const fail = (err: unknown): void => {
      console.error(`[fourSocket] ${event} failed:`, err);
      reply({ ok: false, error: 'Something went wrong.' });
    };
    try {
      const result = handler(payload, reply);
      if (result && typeof (result as Promise<void>).then === 'function') (result as Promise<void>).then(undefined, fail);
    } catch (err) {
      fail(err);
    }
  });
}

export function registerFourPlayerHandlers(
  io: Server,
  deps: FourHandlerDeps = {}
): { rooms: FourRoomManager; matchmaker: FourPlayerMatchmaker; friendRooms: FriendRooms<FourTimeControl, FourVariant, FourFriendRoomView> } {
  const rooms = new FourRoomManager(io, deps.roomOptions);
  const userIdOf = deps.userIdOf ?? userIdFromHandshake;
  const resolveName = deps.resolveName ?? usernameFromDatabase;
  const trustedProxyHops = deps.trustedProxyHops ?? resolveTrustedHops();
  const randomInt = deps.matchmakerOptions?.randomInt ?? ((n: number) => Math.floor(Math.random() * n));

  const matchmaker = new FourPlayerMatchmaker({
    ...deps.matchmakerOptions,
    startGame: (seats, timeControl, timeControlLabel, variant) => {
      const startSnapshot = deps.startSnapshotFor?.(variant);
      const created = rooms.createRoom({ seats, timeControl, timeControlLabel, variant, ...(startSnapshot === undefined ? {} : { startSnapshot }) });
      console.log(`[fourSocket] match_found room=${created.roomId} variant=${variant} humans=${seats.filter((s) => s.kind === 'human').length} bots=${seats.filter((s) => s.kind === 'bot').length} ${timeControl.initialSeconds}+${timeControl.incrementSeconds}`);
    },
    notify: (socketId, update: FourQueueUpdatePayload) => {
      try {
        io.to(socketId).emit('four_queue_update', update);
      } catch (err) {
        console.error(`[fourSocket] failed to send four_queue_update to ${socketId}:`, err);
      }
    },
  });

  // --- friend rooms (command #35): the ONE friend-room manager of friendRooms.ts, here for the 4-seat games (up to four friends, bots fill the empty seats) ---
  const friendRooms = new FriendRooms<FourTimeControl, FourVariant, FourFriendRoomView>({
    maxMembers: FOUR_ROOM_MAX_MEMBERS,
    messages: FOUR_ROOM_MESSAGES,
    ...deps.friendRoomOptions,
    labelOf: fourControlLabel,
    makeView: (room, youAre, expiresInMs) => ({
      code: room.code,
      variant: room.extra,
      timeControl: room.timeControl,
      timeControlLabel: room.label,
      youAre,
      hostName: room.host.name,
      members: [room.host.name, ...room.friends.map((f) => f.name)],
      maxMembers: FOUR_ROOM_MAX_MEMBERS,
      phase: 'open',
      expiresInMs,
    }),
    notifyRoom: (socketId, view) => {
      try {
        io.to(socketId).emit('four_room_update', view);
      } catch (err) {
        console.error('[fourSocket] failed to send four_room_update:', err);
      }
    },
    notifyClosed: (socketId, reason) => {
      try {
        io.to(socketId).emit('four_room_closed', { reason });
      } catch (err) {
        console.error('[fourSocket] failed to send four_room_closed:', err);
      }
    },
    startWithBots: (members: FriendRoomMember[], timeControl, timeControlLabel, variant) => {
      const humans: FourSeatSetup[] = members.map((m) => ({ kind: 'human', socketId: m.socketId, name: m.name }));
      const bots: FourSeatSetup[] = Array.from({ length: 4 - humans.length }, () => ({ kind: 'bot', socketId: null, name: FOUR_BOT_NAME, elo: FOUR_BOT_ELO, botReason: 'fill' }));
      const seats = shuffled([...humans, ...bots], randomInt) as FourSeatSetups;
      const startSnapshot = deps.startSnapshotFor?.(variant);
      const created = rooms.createRoom({ seats, timeControl, timeControlLabel, variant, ...(startSnapshot === undefined ? {} : { startSnapshot }) });
      console.log(`[fourSocket] match_found room=${created.roomId} variant=${variant} humans=${humans.length} bots=${bots.length} friends ${timeControlLabel}`);
    },
    isBusy: (socketId) => rooms.isSeated(socketId) || matchmaker.isQueued(socketId),
  });
  setInterval(() => friendRooms.sweep(), 5 * 60 * 1000).unref();

  io.on('connection', (socket) => {
    const userId = userIdOf(socket);
    const callerOf = async (): Promise<FriendRoomMember & { ip: string }> => {
      let name = 'Player';
      if (userId) {
        try {
          name = await resolveName(userId);
        } catch (err) {
          console.error('[fourSocket] username lookup failed, using "Player":', err);
        }
      }
      const ip = clientIpOf({ peer: socket.handshake?.address ?? '', forwardedFor: socket.handshake?.headers?.['x-forwarded-for'] }, trustedProxyHops);
      return { socketId: socket.id, userId, name, ip };
    };

    listen(socket, 'four_room_create', async (payload, reply) => {
      const parsed = validateFourRoomCreate(payload);
      if (!parsed.ok) return reply(parsed);
      const caller = await callerOf();
      if (!socket.connected) return;
      const created = friendRooms.create(caller, parsed.value.timeControl, parsed.value.variant);
      reply(created.ok ? created : { ok: false, error: created.error });
    });
    listen(socket, 'four_room_join', async (payload, reply) => {
      // a malformed code is a failed guess like a wrong one: it goes through the limiter too (with the one sentence), so the answer is no oracle
      const parsed = validateFourRoomJoin(payload);
      const caller = await callerOf();
      if (!socket.connected) return;
      const joined = friendRooms.join(caller, parsed.ok ? parsed.value.code : null);
      reply(joined.ok ? joined : { ok: false, error: joined.error });
    });
    listen(socket, 'four_room_leave', (_payload, reply) => {
      const left = friendRooms.leave(socket.id);
      reply(left.ok ? left : { ok: false, error: left.error });
    });
    listen(socket, 'four_room_start', (_payload, reply) => {
      const started = friendRooms.start(socket.id, 'bots');
      reply(started.ok ? { ok: true, outcome: 'started' } : { ok: false, error: started.error });
    });

    listen(socket, 'four_join_queue', async (payload, reply) => {
      const parsed = validateFourJoinQueue(payload);
      if (!parsed.ok) return reply(parsed);
      const refusal = (): { ok: false; error: string } | null =>
        rooms.isSeated(socket.id)
          ? { ok: false, error: 'You are already in a game.' }
          : matchmaker.isQueued(socket.id)
            ? { ok: false, error: 'You are already in a queue.' }
            : friendRooms.viewFor(socket.id) !== null
              ? { ok: false, error: 'Leave your friend room first, or start from it.' }
              : null;
      const early = refusal();
      if (early) return reply(early);

      let name = 'Guest';
      if (userId) {
        try {
          name = await resolveName(userId);
        } catch (err) {
          console.error('[fourSocket] username lookup failed, using "Player":', err);
          name = 'Player';
        }
      }
      if (!socket.connected) return; // it left while its username was being looked up: never queue a dead socket
      const late = refusal(); // ...and something else may have happened to this socket meanwhile
      if (late) return reply(late);
      reply(matchmaker.join({ socketId: socket.id, userId, name, timeControl: parsed.value.timeControl, timeControlLabel: parsed.value.timeControlLabel, variant: parsed.value.variant }));
    });

    listen(socket, 'four_leave_queue', (_payload, reply) => {
      matchmaker.leave(socket.id);
      reply({ ok: true });
    });

    listen(socket, 'four_make_move', (payload, reply) => reply(rooms.makeMove(socket.id, payload)));
    listen(socket, 'four_resign', (payload, reply) => reply(rooms.resign(socket.id, payload)));
    listen(socket, 'four_rejoin', (payload, reply) => reply(rooms.rejoin(socket.id, payload)));
    listen(socket, 'four_send_chat', (payload, reply) => reply(rooms.sendChat(socket.id, payload)));
    listen(socket, 'four_list_active_games', (_payload, reply) => reply({ ok: true, games: rooms.listActiveGames() }));
    listen(socket, 'four_spectate_game', (payload, reply) => reply(rooms.spectate(socket.id, payload)));
    listen(socket, 'four_stop_spectating', (_payload, reply) => {
      rooms.stopSpectating(socket.id);
      reply({ ok: true });
    });

    socket.on('disconnect', () => {
      try {
        friendRooms.disconnect(socket.id); // first: it settles the room before the plain queue leave below
      } catch (err) {
        console.error('[fourSocket] leaving the friend room on disconnect failed:', err);
      }
      try {
        matchmaker.leave(socket.id);
      } catch (err) {
        console.error('[fourSocket] leaving the queue on disconnect failed:', err);
      }
      try {
        rooms.handleDisconnect(socket.id);
      } catch (err) {
        console.error('[fourSocket] room disconnect handling failed:', err);
      }
    });
  });

  return { rooms, matchmaker, friendRooms };
}
