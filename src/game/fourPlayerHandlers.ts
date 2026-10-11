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
import { FourPlayerMatchmaker, type FourMatchmakerDeps } from './fourPlayerMatchmaking.js';
import { FourRoomManager } from './fourPlayerRooms.js';
import { validateFourJoinQueue, type FourQueueUpdatePayload } from './fourPlayerWire.js';

export interface FourHandlerDeps {
  /** A user's display name; default: the username from the database. A rejection falls back to "Player". */
  resolveName?: (userId: string) => Promise<string>;
  /** A socket's user id (null = guest); default: the JWT in `handshake.auth.token`. */
  userIdOf?: (socket: Socket) => string | null;
  /** Options for the room manager (engine / bot randomness, an injected bot chooser) - tests. */
  roomOptions?: ConstructorParameters<typeof FourRoomManager>[1];
  /** Options for the matchmaker (fill wait, random source) - tests and the dev override. */
  matchmakerOptions?: Pick<FourMatchmakerDeps, 'fillWaitMs' | 'randomInt'>;
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

export function registerFourPlayerHandlers(io: Server, deps: FourHandlerDeps = {}): { rooms: FourRoomManager; matchmaker: FourPlayerMatchmaker } {
  const rooms = new FourRoomManager(io, deps.roomOptions);
  const userIdOf = deps.userIdOf ?? userIdFromHandshake;
  const resolveName = deps.resolveName ?? usernameFromDatabase;

  const matchmaker = new FourPlayerMatchmaker({
    ...deps.matchmakerOptions,
    startGame: (seats, timeControl, timeControlLabel) => {
      const created = rooms.createRoom({ seats, timeControl, timeControlLabel });
      console.log(`[fourSocket] match_found room=${created.roomId} humans=${seats.filter((s) => s.kind === 'human').length} bots=${seats.filter((s) => s.kind === 'bot').length} ${timeControl.initialSeconds}+${timeControl.incrementSeconds}`);
    },
    notify: (socketId, update: FourQueueUpdatePayload) => {
      try {
        io.to(socketId).emit('four_queue_update', update);
      } catch (err) {
        console.error(`[fourSocket] failed to send four_queue_update to ${socketId}:`, err);
      }
    },
  });

  io.on('connection', (socket) => {
    const userId = userIdOf(socket);

    listen(socket, 'four_join_queue', async (payload, reply) => {
      const parsed = validateFourJoinQueue(payload);
      if (!parsed.ok) return reply(parsed);
      const refusal = (): { ok: false; error: string } | null =>
        rooms.isSeated(socket.id) ? { ok: false, error: 'You are already in a game.' } : matchmaker.isQueued(socket.id) ? { ok: false, error: 'You are already in a queue.' } : null;
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
      reply(matchmaker.join({ socketId: socket.id, userId, name, timeControl: parsed.value.timeControl, timeControlLabel: parsed.value.timeControlLabel }));
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

  return { rooms, matchmaker };
}
