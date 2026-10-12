/**
 * Shared helpers for the 4 Player room-manager test scripts (test-fourplayer-rooms.mjs = W2, test-fourplayer-bots.mjs = W3): a stub `io`
 * that records every emit, fake timers with a COUNT of the timers still pending (and the delay each was armed with), a seeded random
 * generator, and a game factory with white-box accessors.
 *
 * Not a test itself. Everything here is test scaffolding: the white-box accessors (`room()`, `setPosition`, `stopTimer`) reach into the
 * manager's private state on purpose, to set up a scenario or to look at what production code must not expose.
 */
import { mock } from 'node:test';
import { FourRoomManager } from '../src/game/fourPlayerRooms.ts';
import * as E from '../src/game/fourPlayer/index.ts';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const TC = { initialSeconds: 600, incrementSeconds: 0 };
export const KINGS = ['rK@h1', 'bK@a8', 'yK@g14', 'gK@n7'];

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Enables Node's fake timers (setTimeout, setInterval, Date) and wraps setTimeout / clearTimeout to keep (a) the set of timeouts that are
 * actually still pending - the mocked setTimeout offers no such count: an active room must own exactly the timers it should, and a
 * finished one NONE, because a timer left behind keeps the whole room object alive until it fires - and (b) the delay each was armed with.
 * Call once, at the top of a script, before any manager is created.
 */
export function startFakeTimers() {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  const liveTimeouts = new Set();
  const delays = new Map();
  const armedDelays = []; // every delay a timeout was armed with, in order (a test can slice from a mark to see what happened since)
  const mockedSet = globalThis.setTimeout;
  const mockedClear = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => {
    const handle = mockedSet(() => {
      liveTimeouts.delete(handle);
      fn(...args);
    }, ms);
    liveTimeouts.add(handle);
    delays.set(handle, ms);
    armedDelays.push(ms);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    liveTimeouts.delete(handle);
    mockedClear(handle);
  };
  return { liveTimeouts, armedDelays, delayOf: (handle) => delays.get(handle) };
}

export function stubIo() {
  const events = [];
  const failing = new Set(); // 'socketId' (every event) or 'socketId:event'
  return {
    events,
    failing,
    to: (id) => ({
      emit: (event, payload) => {
        if (failing.has(id) || failing.has(`${id}:${event}`)) throw new Error(`stub: send to ${id} failed`);
        events.push({ id, event, payload });
      },
    }),
  };
}
export const eventsOf = (io, event, id) => io.events.filter((e) => e.event === event && (id === undefined || e.id === id));

const games = [];
/** Disposes every game created so far (see `g.dispose`). */
export function disposeAll() {
  for (const g of games.splice(0)) g.dispose();
}

/**
 * A game: by default four humans (S0..S3, named P0..P3); `bots` makes the LAST n seats bots, `kinds` ('human'|'bot' x4) overrides that,
 * `elos` gives bot seats their strength (default 1200). `rng` is the engine's randomness, `botRng` the bots', `chooseBotMove` an injected
 * decision function. Returns handles; `sockets[seat]` is the seat's CURRENT socket (rejoin() replaces it).
 */
export function newGame({ tc = TC, rng, botRng, chooseBotMove, graceMs, bots = 0, kinds, elos, label, names, io = stubIo() } = {}) {
  const options = {};
  if (graceMs) options.graceMs = graceMs;
  if (rng) options.rng = rng;
  if (botRng) options.botRng = botRng;
  if (chooseBotMove) options.chooseBotMove = chooseBotMove;
  const mgr = new FourRoomManager(io, options);
  const kindOf = (i) => (kinds ? kinds[i] : i < 4 - bots ? 'human' : 'bot');
  const seats = [0, 1, 2, 3].map((i) =>
    kindOf(i) === 'human'
      ? { kind: 'human', socketId: `S${i}`, name: names?.[i] ?? `P${i}` }
      : { kind: 'bot', socketId: null, name: names?.[i] ?? 'Bot', ...(elos?.[i] === null ? {} : { elo: elos?.[i] ?? 1200 }), botReason: 'fill' } // elos[i] === null: a bot seat with NO elo
  );
  const created = mgr.createRoom({ seats, timeControl: tc, timeControlLabel: label });
  const g = { io, mgr, id: created.roomId, tokens: created.tokens, room: () => mgr.rooms.get(created.roomId), sockets: ['S0', 'S1', 'S2', 'S3'] };
  let rejoins = 0;
  g.state = () => g.room().state;
  g.fp = () => E.serialize(g.room().state);
  g.seq = () => g.room().seq;
  g.mv = (seat, from, to, promotion) => mgr.makeMove(g.sockets[seat], { roomId: g.id, from, to, ...(promotion ? { promotion } : {}) });
  g.resign = (seat) => mgr.resign(g.sockets[seat], { roomId: g.id });
  /** The first legal move of the seat on move, as square names. */
  g.firstMove = (seat = g.state().turn) => {
    const m = E.legalMoves(g.state(), seat)[0];
    return { from: E.squareName(m.from), to: E.squareName(m.to) };
  };
  g.playFirst = (seat = g.state().turn) => {
    const { from, to } = g.firstMove(seat);
    return g.mv(seat, from, to);
  };
  g.disconnect = (seat) => mgr.handleDisconnect(g.sockets[seat]);
  /** The seat's human comes back on a NEW socket with its token; returns the rejoin ack. */
  g.rejoin = (seat) => {
    const socket = `S${seat}.${++rejoins}`;
    const ack = mgr.rejoin(socket, { roomId: g.id, playerToken: g.tokens[seat] });
    if (ack.ok && !ack.finished) g.sockets[seat] = socket;
    return ack;
  };
  /** White-box: replace the position (test set-up only; production code can only change it through commit()). */
  g.setPosition = (pieces, options = {}) => {
    g.room().state = E.stateFromPieces(pieces, options);
  };
  g.stopTimer = () => {
    const room = g.room();
    clearTimeout(room.clockTimer);
    room.clockTimer = null;
  };
  g.clear = () => (io.events.length = 0);
  /** What the room currently has pending: the clock timer, a bot move, the all-gone countdown and each seat's grace countdown. */
  g.pending = () => {
    const room = g.room();
    return { clock: !!room.clockTimer, bot: !!room.botTimer, allGone: !!room.allGoneTimer, graces: room.seats.filter((s) => s.graceTimer).length };
  };
  /**
   * White-box: cancels every timer the game owns and removes it, silently (nothing is sent). Fake timers are GLOBAL, so a game left running
   * by one scenario would be driven by the next scenario's `tick()` - disposeAll() gives each scenario a clean slate.
   */
  g.dispose = () => {
    const room = g.room();
    if (!room) return;
    for (const timer of [room.clockTimer, room.botTimer, room.allGoneTimer, ...room.seats.map((s) => s.graceTimer)]) if (timer) clearTimeout(timer);
    room.status = 'finished';
    for (const s of room.seats) if (s.socketId) mgr.socketToSeat.delete(s.socketId);
    for (const sp of room.spectators) mgr.socketToSpectating.delete(sp);
    mgr.rooms.delete(room.id);
  };
  games.push(g);
  /** The seat list as the last four_seat_update (or four_match_found) showed it to `socket`. */
  g.lastSeats = (socket) => {
    const updates = io.events.filter((e) => e.id === socket && (e.event === 'four_seat_update' || e.event === 'four_match_found'));
    return updates.at(-1)?.payload.seats;
  };
  return g;
}
