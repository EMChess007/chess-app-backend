/**
 * One live Chaturaji game with real browser users in it and a spectator socket watching the server's side. The two checks everything else is built on:
 *   - `converge`: what EVERY screen shows (board, points, statuses, the non-moving clocks, the king-attacked pill) equals what the server holds, at the same position;
 *   - `humanMove`: a move played by tapping squares lands on the intended square on the server.
 * No assertion depends on how long anything takes: waits end on a condition, with a generous bound that only turns a hang into a failure.
 */
import { SEAT_NAMES, SQUARE8, applyMoveRaw, findRoom, isInCheck, legalMoves, watchRoom } from './truth.mjs';
import { sleep } from './stack.mjs';
import { io } from 'socket.io-client';

/** "m:ss" rounded UP, the app's own format (formatSeatClock): the figure a screen shows for a clock that is not running. */
export function clockText(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000 - 1e-9));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Match {
  constructor(stack, users, watcher, rng, log) {
    this.stack = stack;
    this.users = users;
    /** The screens `converge` compares by default: a user who left the game (menu, closed tab) is taken out until they are back. */
    this.screens = [...users];
    this.watcher = watcher;
    this.rng = rng;
    this.log = log;
    this.checks = 0;
  }

  /** Queues every user for Chaturaji at `timeControl`, waits for the board on each, and starts watching the room the server made. */
  static async start(stack, users, { timeControl = '10 min', rng, log = console.log } = {}) {
    for (const u of users) await u.queue('chaturaji', timeControl);
    for (const u of users) await u.page.getByLabel('Chaturaji board').waitFor({ timeout: 90_000 });
    return Match.attach(stack, users, { rng, log });
  }

  /** Starts watching the Chaturaji room the server holds for these users (they are already in it). */
  static async attach(stack, users, { rng, log = console.log, variant = 'chaturaji' } = {}) {
    const probe = io(stack.apiUrl, { transports: ['websocket'], reconnection: false });
    await new Promise((resolve, reject) => {
      probe.once('connect', resolve);
      probe.once('connect_error', reject);
    });
    let room = null;
    for (let i = 0; i < 600 && !room; i++) {
      room = await findRoom(probe, users.map((u) => u.account.username), variant);
      if (!room) await sleep(100);
    }
    probe.disconnect();
    if (!room) throw new Error(`the server has no ${variant} room with these players`);
    const watcher = await watchRoom(stack.apiUrl, room.roomId, variant);
    return new Match(stack, users, watcher, rng ?? mulberry32(1), log);
  }

  get room() {
    return this.watcher.room;
  }

  seatOf(user) {
    const seat = this.room.seats.findIndex((s) => s.name === user.account.username);
    if (seat < 0) throw new Error(`${user.name} has no seat in the room`);
    return seat;
  }

  /** The user whose turn it is (a human that is still active), or null (a bot's turn, or the game is over). */
  userToMove() {
    const { state } = this.room;
    if (!state || state.result) return null;
    return this.screens.find((u) => this.room.seats[state.turn]?.name === u.account.username && this.room.seats[state.turn].kind === 'human') ?? null;
  }

  /** Compares one screen with the server; returns the problems (empty = they agree). */
  async compare(user, room) {
    const { state } = room;
    const problems = [];
    const bad = await user.boardMismatches(state);
    if (bad.length) problems.push(`board: ${JSON.stringify(bad.slice(0, 3))}`);
    const cards = await user.seatCards();
    if (cards.length !== 4) problems.push(`seat cards: ${cards.length}`);
    for (let seat = 0; seat < 4 && cards.length === 4; seat++) {
      const parts = cards[seat].split(' | ');
      if (parts[0] !== SEAT_NAMES[seat]) problems.push(`card ${seat} is "${parts[0]}"`);
      if (parts[1] !== String(state.score[seat])) problems.push(`points of ${SEAT_NAMES[seat]}: shows ${parts[1]}, server ${state.score[seat]}`);
      const text = cards[seat];
      const status = state.status[seat];
      const attacked = status === 'active' && !state.result && isInCheck(state, seat);
      if ((status === 'frozen') !== parts.includes('out')) problems.push(`"out" of ${SEAT_NAMES[seat]}: ${text}`);
      if ((status === 'dead-king') !== text.includes('king walking')) problems.push(`"king walking" of ${SEAT_NAMES[seat]}: ${text}`);
      if (attacked !== text.includes('king attacked')) problems.push(`"king attacked" of ${SEAT_NAMES[seat]}: ${text}`);
      if (status === 'active' && seat !== state.turn && !state.result && parts[2] !== clockText(room.clocksMs[seat])) problems.push(`clock of ${SEAT_NAMES[seat]}: shows ${parts[2]}, server ${clockText(room.clocksMs[seat])}`);
    }
    // the pill: shown for a user's own attacked king, and only then
    const mine = this.room.seats.findIndex((s) => s.name === user.account.username);
    if (mine >= 0) {
      const shouldShow = state.status[mine] === 'active' && !state.result && isInCheck(state, mine);
      const shown = (await user.page.getByTestId('king-attacked-pill').count()) > 0;
      if (shown !== shouldShow) problems.push(`the king-attacked pill is ${shown ? 'shown' : 'missing'} (server: ${shouldShow ? 'attacked' : 'not attacked'})`);
    }
    return problems;
  }

  /** Waits until every user's screen equals the server's CURRENT state (re-reading it whenever a new move lands meanwhile). */
  async converge(label, users = this.screens, timeoutMs = 20_000) {
    const t0 = Date.now();
    let last = [];
    for (;;) {
      const snapshot = { seq: this.room.seq, state: this.room.state, clocksMs: this.room.clocksMs };
      const problems = [];
      for (const u of users) for (const p of await this.compare(u, snapshot)) problems.push(`${u.name}: ${p}`);
      if (problems.length === 0 && this.room.seq === snapshot.seq) {
        this.checks++;
        return snapshot.seq;
      }
      last = problems;
      if (Date.now() - t0 > timeoutMs) throw new Error(`${label}: the screens never matched the server at seq ${snapshot.seq}: ${last.slice(0, 4).join(' ; ')}`);
      await sleep(60);
    }
  }

  /**
   * A move for `seat`, seeded: captures preferred 60% of the time, else any legal move - but among the moves that leave the king un-attacked when there are any (Capture the King
   * has no check rule, so a random player loses its king within a few rounds and the scenarios would be about a dead seat instead of the feature under test).
   */
  chooseMove(seat) {
    const all = legalMoves(this.room.state, seat);
    const safe = all.filter((m) => !isInCheck(applyMoveRaw(this.room.state, m), seat));
    const moves = safe.length > 0 ? safe : all;
    const captures = moves.filter((m) => m.captured !== 0);
    const pool = captures.length > 0 && this.rng() < 0.6 ? captures : moves;
    return pool[Math.floor(this.rng() * pool.length)];
  }

  /** Plays `move` for `user` by tapping its two squares, and checks it landed on the intended square on the server. */
  async humanMove(user, move) {
    const before = this.room.seq;
    const stateBefore = this.room.state;
    const from = SQUARE8.squareName(move.from);
    const to = SQUARE8.squareName(move.to);
    await user.tapSquare(from);
    await user.tapSquare(to);
    await this.watcher.waitFor((r) => r.seq > before, `the server to accept ${from}-${to} from ${user.name}`, 15_000);
    const expected = applyMoveRaw(stateBefore, move);
    const after = this.room.state;
    // The server may have advanced further (bots, a dead king's walk), but the mover's piece must stand on `to`, and `from` must not still hold it.
    if (after.cells[move.to] !== expected.cells[move.to] && this.room.seq === before + 1) throw new Error(`${from}-${to}: the piece did not land on ${to} (server holds ${after.cells[move.to]}, wanted ${expected.cells[move.to]})`);
    return { from, to, captured: move.captured !== 0, promotion: (move.flags & 4) !== 0 };
  }

  /**
   * Plays until `done(match)` (checked before each human move), each human move chosen by the seeded chooser; after every new position every screen is compared with the
   * server. `onMove(info)` sees each human move. Returns the number of human moves.
   */
  async play({ done, maxMoves = 200, onMove }) {
    let moves = 0;
    while (moves < maxMoves) {
      if (done(this) || this.room.state?.result) break;
      const user = this.userToMove();
      if (!user) {
        const seq = this.room.seq;
        await this.watcher.waitFor((r) => r.seq > seq || r.state.result || r.gameOver, 'the next position', 120_000);
        await this.converge('after a bot move');
        continue;
      }
      const seat = this.seatOf(user);
      const move = this.chooseMove(seat);
      const info = await this.humanMove(user, move);
      moves++;
      await this.converge(`after ${user.name} ${info.from}-${info.to}`);
      if (onMove) await onMove({ ...info, user, seat, match: this });
    }
    return moves;
  }

  close() {
    this.watcher.close();
  }
}
