/**
 * Shared helpers for the Bughouse server test scripts (test-bughouse-rooms.mjs, test-bughouse-messages.mjs, test-bughouse-matchmaking.mjs, test-bughouse-bot.mjs, test-bughouse-handlers.mjs):
 * a stub `io` that records every emit IN ORDER for every socket, a manual clock-and-timer set (`manualTimers`) with the room manager's own `BugTimers` shape, a hand-built position
 * builder (`scene`) and a game factory with white-box accessors.
 *
 * Not a test itself. Nothing here uses the wall clock: the manager under test reads ONE injected integer clock, so time only moves when a test moves it.
 */
import { BughouseRoomManager } from '../src/game/bughouseRooms.ts';
import { emptyReserve } from '../src/game/crazyhouse.ts';
import * as E from '../src/game/bughouse/index.ts';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const START = E.BOARD_START_FEN;
export const TC3 = { initialMs: 180000, incrementMs: 0 };
export const TC1 = { initialMs: 60000, incrementMs: 0 };
export const TC32 = { initialMs: 180000, incrementMs: 2000 };

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
 * A manual clock with timers. `now()` is an integer that only changes through `advance` (which fires every timer that falls due on the way, in due order, at its own due instant),
 * `jump` (moves the clock WITHOUT firing anything: the late-timer scenarios) and `fire` (runs one timer's callback right now, wherever the clock is: early or late). `live` is the set
 * of timers still pending, `delays` the delay each was armed with, `armed` every delay in order.
 */
const everArmed = [];
/** Every delay any manual clock of this process was ever armed with (a test pins that none was negative: the clamp in the room manager never acts). */
export const allArmedDelays = () => everArmed;

export function manualTimers(start = 1000) {
  let t = start;
  let nextId = 1;
  const live = new Map();
  const armed = everArmed;
  const timers = {
    now: () => t,
    setTimer: (callback, ms, options) => {
      const handle = { id: nextId++, due: t + ms, ms, callback, unref: !!options?.unref };
      live.set(handle.id, handle);
      armed.push(ms);
      return handle;
    },
    clearTimer: (handle) => {
      if (handle) live.delete(handle.id);
    },
  };
  const dueOrder = () => [...live.values()].sort((a, b) => a.due - b.due || a.id - b.id);
  return {
    timers,
    live,
    armed,
    now: () => t,
    pending: () => dueOrder(),
    /** Moves the clock forward by `ms`, running the timers that fall due on the way (each at its own instant, earliest first, creation order on ties). */
    advance(ms) {
      const target = t + ms;
      for (;;) {
        const next = dueOrder().find((h) => h.due <= target);
        if (!next) break;
        live.delete(next.id);
        t = Math.max(t, next.due);
        next.callback();
      }
      t = target;
    },
    /** Moves the clock WITHOUT firing anything (so a test can run the timers late, in any order, with `fire`). */
    jump(ms) {
      t += ms;
    },
    /** Runs one pending timer's callback now. */
    fire(handle) {
      if (!live.has(handle.id)) throw new Error('fire: that timer is not pending');
      live.delete(handle.id);
      handle.callback();
    },
  };
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
        events.push({ id, event, payload, index: events.length });
      },
    }),
  };
}
export const eventsOf = (io, event, id) => io.events.filter((e) => e.event === event && (id === undefined || e.id === id));

/** A hand-built match for a rule or a boundary (the engine's own state; the side to move on each board has its clock running since `startMs`). */
export function scene(o = {}) {
  const timeControl = o.timeControl ?? TC3;
  const startMs = o.startMs ?? 1000;
  const base = E.createMatch({ timeControl, roomNumber: o.roomNumber ?? 0, startMs });
  const fens = { A: o.a ?? START, B: o.b ?? START };
  const boards = {};
  for (const board of ['A', 'B']) {
    const chess = E.openBoard(fens[board]);
    if (chess === null) throw new Error(`scene: board ${board} is not a valid FEN: ${fens[board]}`);
    boards[board] = { fen: E.fenOf(chess), promoted: [...((board === 'A' ? o.promotedA : o.promotedB) ?? [])].sort(), plies: 0 };
  }
  const pockets = [0, 1, 2, 3].map((seat) => ({ ...emptyReserve(), ...(o.pockets?.[seat] ?? {}) }));
  const verdicts = {
    A: E.judgeBoardState('A', boards.A, pockets[E.seatAt('A', 'w')], pockets[E.seatAt('A', 'b')]),
    B: E.judgeBoardState('B', boards.B, pockets[E.seatAt('B', 'w')], pockets[E.seatAt('B', 'b')]),
  };
  const clocks = [0, 1, 2, 3].map((seat) => {
    const place = E.seatPlace(seat);
    const running = verdicts[place.board].turn === place.color;
    return { remainingMs: timeControl.initialMs, runningSince: running ? startMs : null, startSeq: 0, ...(o.clocks?.[seat] ?? {}) };
  });
  return { ...base, roomNumber: o.roomNumber ?? base.roomNumber, seq: o.seq ?? 0, boards, pockets, clocks, verdicts };
}

export const move = (board, from, to, promotion) => ({ board, from, to, ...(promotion ? { promotion } : {}) });

const games = [];
/** Disposes every game created so far (their timers) - a scenario leaves nothing behind for the next one. */
export function disposeAll() {
  for (const g of games.splice(0)) g.dispose();
}

/**
 * A game: by default four humans (S0..S3, named P0..P3); `bots` makes the LAST n seats bots, `kinds` ('human'|'bot' x4) overrides that. `clock` is the manualTimers set (a fresh one by
 * default). `scene` (SceneOptions) replaces the starting position right after creation (white-box: the manager's own state is swapped and its timers re-armed).
 */
export function newGame({ tc = TC3, clock = manualTimers(), io = stubIo(), kinds, bots = 0, names, elos, botRng, chooseBotAction, graceMs, allGoneMs, scene: sceneOptions, mgr: existing } = {}) {
  const options = { timers: clock.timers };
  if (botRng) options.botRng = botRng;
  if (chooseBotAction) options.chooseBotAction = chooseBotAction;
  if (graceMs !== undefined) options.graceMs = graceMs;
  if (allGoneMs !== undefined) options.allGoneMs = allGoneMs;
  const mgr = existing ?? new BughouseRoomManager(io, options);
  const kindOf = (i) => (kinds ? kinds[i] : i < 4 - bots ? 'human' : 'bot');
  const seats = [0, 1, 2, 3].map((i) =>
    kindOf(i) === 'human'
      ? { kind: 'human', socketId: `S${i}`, name: names?.[i] ?? `P${i}` }
      : { kind: 'bot', socketId: null, name: names?.[i] ?? 'Bot', elo: elos?.[i] ?? 1200, botReason: 'fill' },
  );
  const created = mgr.createRoom({ seats, timeControl: tc });
  // the room object outlives its entry in the manager (it is removed when the match ends), so a test can still read the final match
  const roomRef = mgr.rooms.get(created.roomId);
  const g = { io, mgr, clock, id: created.roomId, tokens: created.tokens, room: () => mgr.rooms.get(created.roomId) ?? roomRef, alive: () => mgr.rooms.has(created.roomId), sockets: ['S0', 'S1', 'S2', 'S3'] };
  let rejoins = 0;
  g.match = () => g.room().match;
  g.seq = () => g.room().match.seq;
  g.text = () => E.serializeMatch(g.room().match);
  g.mv = (seat, board, from, to, promotion) => mgr.makeMove(g.sockets[seat], { roomId: g.id, board, from, to, ...(promotion ? { promotion } : {}) });
  g.drop = (seat, board, piece, square) => mgr.makeDrop(g.sockets[seat], { roomId: g.id, board, piece, square });
  g.resign = (seat) => mgr.resign(g.sockets[seat], { roomId: g.id });
  g.chat = (seat, text, extra = {}) => mgr.sendChat(g.sockets[seat], { roomId: g.id, text, ...extra });
  g.quick = (seat, code, extra = {}) => mgr.sendQuick(g.sockets[seat], { roomId: g.id, code, ...extra });
  g.disconnect = (seat) => mgr.handleDisconnect(g.sockets[seat]);
  /** The seat's human comes back on a NEW socket with its token; returns the rejoin ack. */
  g.rejoin = (seat) => {
    const socket = `S${seat}.${++rejoins}`;
    const ack = mgr.rejoin(socket, { roomId: g.id, playerToken: g.tokens[seat] });
    if (ack.ok && !ack.finished) g.sockets[seat] = socket;
    return ack;
  };
  /** White-box: replace the position (test set-up only; production code changes it only through commit()). Timers are re-armed for the new clocks. */
  g.setScene = (options) => {
    g.room().match = scene({ startMs: clock.now(), roomNumber: g.room().match.roomNumber, ...options });
    mgr.armClockTimers(g.room());
    mgr.scheduleBots(g.room());
  };
  g.clear = () => (io.events.length = 0);
  g.pending = () => {
    const room = g.room();
    return {
      clock: Object.values(room.clockTimers).filter((h) => h !== null).length,
      bot: Object.values(room.botTimers).filter((h) => h !== null).length,
      allGone: room.allGoneTimer !== null,
      graces: room.seats.filter((s) => s.graceTimer !== null).length,
    };
  };
  g.dispose = () => {
    const room = g.room();
    if (!room) return;
    for (const h of Object.values(room.clockTimers)) if (h) clock.timers.clearTimer(h);
    for (const b of Object.values(room.botTimers)) if (b) clock.timers.clearTimer(b.handle);
    if (room.allGoneTimer) clock.timers.clearTimer(room.allGoneTimer);
    for (const s of room.seats) if (s.graceTimer) clock.timers.clearTimer(s.graceTimer);
    mgr.rooms.delete(created.roomId);
    for (const [socket, seated] of mgr.socketToSeat) if (seated.roomId === created.roomId) mgr.socketToSeat.delete(socket);
  };
  games.push(g);
  if (sceneOptions) g.setScene(sceneOptions);
  return g;
}
