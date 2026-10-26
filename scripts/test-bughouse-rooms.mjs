/**
 * Bughouse ONLINE - the room manager (src/game/bughouseRooms.ts, workstream W2; BUGHOUSE_SPEC.md HP1, HP2, HP5, HP6).
 *
 *   npm run test:bughouseRooms        (tsx; no server, no database; an INJECTED clock and timers - nothing here waits, nothing reads the wall clock)
 *
 * The manager is driven through its public methods with a stub `io` that records every emit in order, a manual clock (`manualTimers`) and hand-built positions (`scene`). Covered: the
 * starting payloads, the one funnel (checked in the source too), a capture on board A that the partner drops on board B at that very seq (both arrival orders), flag ordering with late
 * and early timers, the exact-millisecond tie at both levels, a stuck player freed by the partner's capture (human and bot), resignation, takeover / hand-back / the all-gone void,
 * the 5-minute retention, spectators, the rejoin snapshot, a faulty bot, and hostile payloads. Team chat and quick messages have their own script (test-bughouse-messages.mjs).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  BUG_ACTION_RATE_LIMIT,
  BUG_ALL_GONE_MS,
  BUG_BOT_ELO,
  BUG_FILL_WAIT_MS,
  BUG_FINISHED_RETENTION_MS,
  BUG_TAKEOVER_GRACE_MS,
  resolveBugFillWaitMs,
  resolveBugGraceMs,
} from '../src/game/bughouseConfig.ts';
import { BughouseRoomManager } from '../src/game/bughouseRooms.ts';
import * as E from '../src/game/bughouse/index.ts';
import { START, TC1, TC3, TC32, UUID, allArmedDelays, disposeAll, eventsOf, manualTimers, newGame, stubIo } from './bughouse-test-kit.mjs';

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ok  ${message}`);
}
const same = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message);
  passed++;
  console.log(`  ok  ${message}`);
};

const states = (g, socket) => eventsOf(g.io, 'bug_state', socket);
const gameOvers = (g, socket) => eventsOf(g.io, 'bug_game_over', socket);
const reasonsOk = (ack) => ack.ok === false && E.BUG_REJECT_REASONS.includes(ack.reason) && typeof ack.error === 'string' && ack.error.length > 0;

// Positions. A: White (seat 0) can take Black's rook; B: Black (seat 3) is to move. After seat 0 takes on a8, seat 3 holds a rook.
const CAPTURE_A = 'r3k3/8/8/8/8/8/8/R3K3 w - - 0 1';
const KINGS_BLACK_TO_MOVE = '4k3/8/8/8/8/8/8/4K3 b - - 0 1';
// Seat 1 (A Black) is in check from a8 along rank 8 with nothing to move and nothing to drop: stuck. Its partner is seat 2 (B White), who can take a rook on a8.
const STUCK_A = 'R6k/6pp/8/8/8/8/8/K7 b - - 0 1';

console.log('\n=== 0. The numbers, and the dev/test overrides ===');
{
  check(BUG_TAKEOVER_GRACE_MS === 45_000 && BUG_ALL_GONE_MS === 45_000 && BUG_FINISHED_RETENTION_MS === 300_000 && BUG_FILL_WAIT_MS === 30_000 && BUG_BOT_ELO === 1200, 'grace 45 s, all-gone 45 s, retention 5 min, fill wait 30 s, Amateur bots (1200)');
  check(BUG_ACTION_RATE_LIMIT.windowMs === 1000 && BUG_ACTION_RATE_LIMIT.max === 10, 'at most 10 move / drop calls per second per seat');
  check(resolveBugFillWaitMs({}) === 30_000 && resolveBugFillWaitMs({ FOUR_FILL_MS: '3000' }) === 3000 && resolveBugFillWaitMs({ FOUR_FILL_MS: '3000', NODE_ENV: 'production' }) === 30_000, 'the fill wait takes the 4-seat games\' FOUR_FILL_MS (no new variable): honoured outside production and ignored in it');
  check(resolveBugGraceMs({}) === 45_000 && resolveBugGraceMs({ FOUR_GRACE_MS: '1500' }) === 1500 && resolveBugGraceMs({ FOUR_GRACE_MS: '1500', NODE_ENV: 'production' }) === 45_000, 'the takeover grace takes FOUR_GRACE_MS: honoured outside production and ignored in it');
  check(resolveBugFillWaitMs({ BUGHOUSE_FILL_MS: '3000' }) === 30_000 && resolveBugGraceMs({ BUGHOUSE_GRACE_MS: '1500' }) === 45_000, 'there is no BUGHOUSE_FILL_MS / BUGHOUSE_GRACE_MS: those names do nothing');
  check(resolveBugFillWaitMs({ FOUR_FILL_MS: '1' }) === 1 && resolveBugFillWaitMs({ FOUR_FILL_MS: '600000' }) === 600_000 && resolveBugGraceMs({ FOUR_GRACE_MS: '1' }) === 1 && resolveBugGraceMs({ FOUR_GRACE_MS: '600000' }) === 600_000, 'the accepted range is 1 ms .. 600000 ms, boundaries included');
  for (const bad of ['0', '-5', '1.5', '600001', 'abc', '', ' 3000', '3e3', '0x10', 'Infinity']) {
    assert.equal(resolveBugFillWaitMs({ FOUR_FILL_MS: bad }), 30_000, `FOUR_FILL_MS=${JSON.stringify(bad)} must be ignored`);
    assert.equal(resolveBugGraceMs({ FOUR_GRACE_MS: bad }), 45_000, `FOUR_GRACE_MS=${JSON.stringify(bad)} must be ignored`);
  }
  passed++;
  console.log('  ok  anything else (0, negative, fractional, too large, text, hex, exponent, empty) is ignored: the defaults');
}

console.log('\n=== 1. Creation: what every player receives ===');
{
  const g = newGame({ names: ['Ann', 'Bob', 'Cy', 'Di'] });
  const found = eventsOf(g.io, 'bug_match_found');
  check(found.length === 4 && found.every((e, i) => e.id === `S${i}` && e.payload.seat === i), 'each of the four humans gets exactly one bug_match_found, for its own seat');
  check(found.every((e) => UUID.test(e.payload.playerToken) && e.payload.playerToken === g.tokens[e.payload.seat]) && new Set(found.map((e) => e.payload.playerToken)).size === 4, 'every token is its own random UUID and equals the one the manager returned for that seat');
  check(found.every((e) => found.filter((o) => o !== e).every((o) => !JSON.stringify(e.payload).includes(o.payload.playerToken))), 'a payload never contains another seat\'s token');
  const first = JSON.stringify({ ...found[0].payload, seat: 0, playerToken: '' });
  check(found.every((e) => JSON.stringify({ ...e.payload, seat: 0, playerToken: '' }) === first), 'the four payloads are byte-identical apart from the seat and the token (ONE reading of the clock)');
  check(found[0].payload.seq === 0 && found[0].payload.state === E.serializeMatch(E.createMatch({ timeControl: TC3, roomNumber: 0, startMs: g.clock.now() })) && found[0].payload.serverNowMs === g.clock.now(), 'seq 0, the serialized starting match, and the instant on the match clock');
  same(found[0].payload.seats.map((s) => [s.seat, s.kind, s.name, s.connected]), [[0, 'human', 'Ann', true], [1, 'human', 'Bob', true], [2, 'human', 'Cy', true], [3, 'human', 'Di', true]], 'the seat list names the four humans, all connected');
  check(found[0].payload.timeControl.initialMs === 180000 && found[0].payload.timeControlLabel === '3 min', 'the time control and its label travel with it');
  same(g.pending(), { clock: 2, bot: 0, allGone: false, graces: 0 }, 'one clock timer per board, no bot timer, nothing else pending');
  same(g.clock.pending().map((h) => h.ms), [180000, 180000], '...each armed for the full 3 minutes (White\'s clock runs on both boards from the start)');
  disposeAll();

  const bots = newGame({ kinds: ['bot', 'human', 'bot', 'human'], tc: TC1 });
  same(bots.pending(), { clock: 2, bot: 2, allGone: false, graces: 0 }, 'a bot on White of both boards: a bot timer on each board');
  same(bots.clock.pending().filter((h) => h.ms !== 60000).map((h) => h.ms), [200, 200], '...armed for 200 ms in bullet (1 min)');
  disposeAll();
  const blitz = newGame({ kinds: ['bot', 'human', 'human', 'human'] });
  same(blitz.clock.pending().filter((h) => h.ms !== 180000).map((h) => h.ms), [450], 'a bot that thinks 450 ms in a blitz control');
  disposeAll();
}
{
  const io = stubIo();
  const clock = manualTimers();
  const mgr = new BughouseRoomManager(io, { timers: clock.timers });
  const seats = (n) => Array.from({ length: n }, (_, i) => ({ kind: 'human', socketId: `X${i}`, name: 'x' }));
  const bots = [0, 1, 2, 3].map(() => ({ kind: 'bot', socketId: null, name: 'b', elo: 1200 }));
  const refused = (params) => {
    try {
      mgr.createRoom(params);
      return false;
    } catch {
      return true;
    }
  };
  check(refused({ seats: seats(4), timeControl: { initialMs: 600000, incrementMs: 0 } }), 'a time control outside the six is refused (a programming error)');
  check(refused({ seats: seats(3), timeControl: TC3 }), 'three seats are refused');
  check(refused({ seats: bots, timeControl: TC3 }), 'a room with no human is refused');
  check(refused({ seats: [{ kind: 'human', socketId: 'X0', name: 'a' }, { kind: 'human', socketId: 'X0', name: 'b' }, bots[2], bots[3]], timeControl: TC3 }), 'two humans on one socket are refused');
  mgr.createRoom({ seats: seats(4), timeControl: TC3 });
  check(refused({ seats: seats(4), timeControl: TC3 }), 'a socket that is already seated cannot be seated again');
  const a = mgr.createRoom({ seats: [0, 1, 2, 3].map((i) => ({ kind: 'human', socketId: `Y${i}`, name: 'x' })), timeControl: TC3 });
  const b = mgr.createRoom({ seats: [0, 1, 2, 3].map((i) => ({ kind: 'human', socketId: `Z${i}`, name: 'x' })), timeControl: TC3 });
  check(mgr.rooms.get(a.roomId).match.roomNumber === 1 && mgr.rooms.get(b.roomId).match.roomNumber === 2, 'rooms are numbered by a monotonic counter (only its parity matters, for the flag tie-break)');
}

console.log('\n=== 2. The funnel, at source level ===');
{
  const source = fs.readFileSync(new URL('../src/game/bughouseRooms.ts', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const assignments = code.match(/\broom\.match\s*=(?!=)/g) ?? [];
  check(assignments.length === 1, 'room.match is assigned in exactly one place (commit)');
  check(/private commit\([^)]*\): void \{\s*room\.match = next;/.test(code), '...and that place is commit()');
  check((code.match(/\bsettle\(/g) ?? []).length === 1, 'the engine\'s settle is called in exactly one place (run), so every input of a match goes through one funnel');
  check((code.match(/\bvoidMatch\(/g) ?? []).length === 1 && /this\.commit\(room, next, \[\{ kind: 'result'/.test(code), 'the all-gone void is the only other engine entry and it too ends in commit()');
  check(!/Date\.now|new Date|performance\.now\b(?!\(\)\))/.test(code.replace('now: () => Math.floor(performance.now())', '')), 'no wall clock anywhere but the default monotonic clock');
  check(!/fourPlayer/i.test(code), 'the manager imports nothing from the 4-seat stack (no shared code path)');
  same([...code.matchAll(/this\.broadcast\(room, '(\w+)'/g)].map((m) => m[1]).sort(), ['bug_game_over', 'bug_seat_update', 'bug_state'], 'broadcast() (every seat and spectator) carries only the state, the game over and the seat update - never a chat line or a quick message');
}

console.log('\n=== 3. A legal move: one bug_state to every seat and spectator ===');
{
  const g = newGame();
  const spectate = g.mgr.spectate('W1', { roomId: g.id });
  check(spectate.ok === true && spectate.state.seq === 0 && spectate.state.state === g.text(), 'a spectator joins and gets the current snapshot');
  g.clear();
  g.clock.jump(1500);
  const ack = g.mv(0, 'A', 'e2', 'e4');
  check(ack.ok === true && ack.seq === 1, 'the ack carries the new seq (1)');
  const recipients = ['S0', 'S1', 'S2', 'S3', 'W1'];
  check(recipients.every((id) => states(g, id).length === 1) && eventsOf(g.io, 'bug_state').length === 5, 'exactly one bug_state per seat and spectator, nobody else');
  const payloads = recipients.map((id) => JSON.stringify(states(g, id)[0].payload));
  check(new Set(payloads).size === 1, 'the five payloads are byte-identical');
  const p = states(g, 'S0')[0].payload;
  check(p.seq === 1 && p.state === g.text() && p.serverNowMs === g.clock.now() && p.events.length === 1 && p.events[0].kind === 'move' && p.events[0].san === 'e4' && p.events[0].board === 'A' && p.events[0].seq === 1, 'seq 1, the serialized match, the instant of the commit and the move event');
  check(E.deserializeMatch(p.state).ok === true, '...and the text reads back through the engine\'s own deserializer');
  same(g.room().log, [{ seq: 1, seat: 0, board: 'A', san: 'e4' }], 'the room log has the move (for a rejoin)');
  same(g.pending(), { clock: 2, bot: 0, allGone: false, graces: 0 }, 'the timers are re-armed: one per board');
  const second = g.mv(1, 'A', 'e7', 'e5');
  check(second.ok === true && second.seq === 2 && states(g, 'W1').map((e) => e.payload.seq).join() === '1,2', 'seq grows by exactly one per commit');
  disposeAll();
}

console.log('\n=== 4. Refusals change nothing and carry a reason from the closed list ===');
{
  const g = newGame();
  const before = g.text();
  g.clear();
  const refusals = {
    notYourTurn: g.mv(1, 'A', 'e7', 'e5'),
    wrongBoard: g.mv(0, 'B', 'e2', 'e4'),
    illegalMove: g.mv(0, 'A', 'e2', 'e5'),
    dropNotInPocket: g.drop(0, 'A', 'n', 'e4'),
  };
  for (const [reason, ack] of Object.entries(refusals)) check(reasonsOk(ack) && ack.reason === reason, `${reason}: refused with that reason`);
  check(g.text() === before && g.seq() === 0 && eventsOf(g.io, 'bug_state').length === 0, 'none of the four changed the match or published anything');
  check(reasonsOk(g.mgr.makeMove('S9', { roomId: g.id, board: 'A', from: 'e2', to: 'e4' })) && g.mgr.makeMove('S9', { roomId: g.id, board: 'A', from: 'e2', to: 'e4' }).reason === 'noGame', 'a socket that sits in no room (a stranger or a spectator) is told noGame');
  g.mgr.spectate('W1', { roomId: g.id });
  check(g.mgr.makeMove('W1', { roomId: g.id, board: 'A', from: 'e2', to: 'e4' }).reason === 'noGame' && g.mgr.resign('W1', { roomId: g.id }).reason === 'noGame', 'a spectator cannot move or resign');
  check(g.mgr.makeMove('S0', { roomId: 'nope', board: 'A', from: 'e2', to: 'e4' }).reason === 'noGame', 'a room id the socket does not sit in is noGame');

  const hostile = [undefined, null, 0, 7, 'x', true, [], {}, { roomId: 5 }, { roomId: g.id }, { roomId: g.id, board: 'C', from: 'e2', to: 'e4' }, { roomId: g.id, board: 'A', from: 'E2', to: 'e4' }, { roomId: g.id, board: 'A', from: 'e2', to: 'e04' }, { roomId: g.id, board: 'A', from: 'e2', to: 'e4', promotion: 'k' }, { roomId: g.id, board: 'A', from: 'e2', to: 'e4', baseSeq: -1 }, { roomId: 'x'.repeat(65), board: 'A', from: 'e2', to: 'e4' }, { roomId: g.id, board: 'A', piece: 'k', square: 'e4' }, { roomId: g.id, board: 'A', piece: 'q', square: 'z9' }];
  let allRefused = true;
  for (const payload of hostile) {
    for (const call of [() => g.mgr.makeMove('S0', payload), () => g.mgr.makeDrop('S0', payload), () => g.mgr.resign('S0', payload), () => g.mgr.sendChat('S0', payload), () => g.mgr.sendQuick('S0', payload), () => g.mgr.spectate('W2', payload), () => g.mgr.rejoin('S0', payload)]) {
      let ack;
      try {
        ack = call();
      } catch (err) {
        allRefused = false;
        console.log('  threw:', err);
        continue;
      }
      if (ack.ok !== false || !E.BUG_REJECT_REASONS.includes(ack.reason)) {
        // the one hostile payload that is a valid request for some call is not a hostile one for it: { roomId } resigns, spectates...
        if (!(payload && payload.roomId === g.id && !('board' in payload))) allRefused = false;
      }
    }
  }
  check(allRefused, 'every hostile payload on every call is answered with a refusal from the closed list and never throws');
  check(g.seq() === 0 || g.match().result !== null, 'and nothing happened to the match unless the one valid { roomId } resigned');
  disposeAll();
}
{
  const g = newGame();
  g.clear();
  // the rate limit: ten calls in one second (legal or not), the eleventh refused, the window is exact
  const acks = [];
  for (let i = 0; i < 10; i++) acks.push(g.mv(1, 'A', 'e7', 'e5'));
  check(acks.every((a) => a.reason === 'notYourTurn'), 'ten refused moves in the same millisecond are all judged by the engine');
  check(g.mv(1, 'A', 'e7', 'e5').reason === 'rateLimited', 'the eleventh call within the second is rateLimited');
  g.clock.jump(999);
  check(g.mv(1, 'A', 'e7', 'e5').reason === 'rateLimited', '999 ms later it is still limited');
  g.clock.jump(1);
  check(g.mv(1, 'A', 'e7', 'e5').reason === 'notYourTurn', '1000 ms later the window has moved on and the engine judges again');
  check(g.mv(0, 'A', 'e2', 'e4').ok === true, 'the limit is per seat: another seat is not affected');
  disposeAll();
}

console.log('\n=== 5. HP1: a capture on board A is droppable by the partner on board B at that very seq ===');
{
  const g = newGame({ scene: { a: CAPTURE_A, b: KINGS_BLACK_TO_MOVE } });
  g.clock.jump(2000);
  const capture = g.mv(0, 'A', 'a1', 'a8');
  check(capture.ok === true && capture.seq === 1, 'seat 0 takes the rook on board A (seq 1)');
  const p = states(g, 'S3').at(-1).payload;
  check(p.seq === 1 && p.events.some((e) => e.kind === 'bank' && e.seat === 3 && e.piece === 'r' && e.seq === 1), 'the same bug_state carries the credit to seat 3 (the capturer\'s partner), at seq 1');
  const drop = g.drop(3, 'B', 'r', 'a5');
  check(drop.ok === true && drop.seq === 2, 'seat 3 drops the rook on board B immediately: seq 2');
  check(g.match().pockets[3].r === 0 && g.match().boards.B.fen.startsWith('4k3/8/8/r7') && g.match().pockets[0].r === 0, 'the rook left seat 3\'s pocket and stands on board B; the capturer\'s own pocket never held it');
  disposeAll();

  // the other arrival order: the drop reaches the server BEFORE the capture and is refused; nothing changes; after the capture it works
  const h = newGame({ scene: { a: CAPTURE_A, b: KINGS_BLACK_TO_MOVE } });
  h.clock.jump(2000);
  const early = h.drop(3, 'B', 'r', 'a5');
  check(reasonsOk(early) && early.reason === 'dropNotInPocket' && h.seq() === 0, 'a drop that arrives before the capture is refused (dropNotInPocket) and changes nothing');
  check(h.mv(0, 'A', 'a1', 'a8').ok === true && h.drop(3, 'B', 'r', 'a5').ok === true, '...and the same drop sent after the capture is accepted');
  check(h.seq() === 2, 'seq 2 after the two commits');
  disposeAll();
}

console.log('\n=== 6. HP2: flag ordering, late and early timers ===');
{
  // two clocks about to flag: board B\'s deadline (4000) is earlier than board A\'s (6000)
  const g = newGame({ scene: { a: START, b: START, startMs: 1000, clocks: { 0: { remainingMs: 5000 }, 2: { remainingMs: 3000 } } } });
  const timers = g.clock.pending();
  same(timers.map((h) => h.due).sort((x, y) => x - y), [4000, 6000], 'one timer per board, due at each board\'s own flag deadline (4000 and 6000)');
  g.clock.jump(6000); // BOTH are now due, and no timer has run yet
  const aTimer = timers.find((h) => h.due === 6000);
  g.clock.fire(aTimer); // board A's timer is the one that runs first - late, and for the LATER deadline
  const result = g.match().result;
  same(result, { winnerTeam: 1, reason: 'flag', board: 'B', loserSeat: 2 }, 'the later timer ran first, yet the EARLIEST deadline loses: seat 2 on board B');
  check(g.seq() === 1 && states(g, 'S0').length === 1 && gameOvers(g, 'S0').length === 1 && g.clock.live.size === 1, 'one commit, one bug_state, one bug_game_over; only the retention timer is left (the other board\'s timer was cleared)');
  const frozen = g.match().clocks;
  check(frozen.every((c) => c.runningSince === null) && frozen[0].remainingMs === 5000 - (4000 - 1000), 'the other board\'s clock froze at the instant the first flag fell (4000), not at the late callback');
  disposeAll();
}
{
  // a move that arrives after a flag fell is discarded: the flag wins, the sender is told, no move is played
  const g = newGame({ scene: { a: START, b: START, startMs: 1000, clocks: { 0: { remainingMs: 2000 } } } });
  g.clock.jump(2001); // seat 0's deadline is 3000; now = 3001 and no timer ran
  const ack = g.mv(0, 'A', 'e2', 'e4');
  check(reasonsOk(ack) && ack.reason === 'flagDue', 'a move that arrives after its own flag fell is refused with flagDue');
  same(g.match().result, { winnerTeam: 2, reason: 'flag', board: 'A', loserSeat: 0 }, '...and the match is over by that flag');
  check(g.match().boards.A.plies === 0 && states(g, 'S1').length === 1 && states(g, 'S1')[0].payload.events.length === 1 && states(g, 'S1')[0].payload.events[0].kind === 'result', 'the published commit is the flag fall only: the move was never played');
  check(g.mv(1, 'A', 'e7', 'e5').reason === 'noGame' && !g.alive(), 'afterwards the room is gone: every call is noGame');
  disposeAll();
}
{
  // flag against checkmate: the mate arrives exactly at the flag instant (the flag wins) and one millisecond before it (the mate wins)
  const mateScene = { a: START, b: '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1', startMs: 1000, clocks: { 2: { remainingMs: 2000 } } };
  const early = newGame({ scene: mateScene });
  early.clock.jump(1999); // 2999: one millisecond before seat 2's deadline (3000)
  const mate = early.mv(2, 'B', 'f7', 'g7');
  check(mate.ok === true && early.match().result?.reason === 'checkmate' && early.match().result.winnerTeam === 2, 'a mating move one millisecond before the flag deadline mates');
  disposeAll();
  const at = newGame({ scene: mateScene });
  at.clock.jump(2000); // 3000: exactly seat 2's deadline
  const lateMate = at.mv(2, 'B', 'f7', 'g7');
  check(lateMate.reason === 'flagDue' && at.match().result?.reason === 'flag' && at.match().result.loserSeat === 2, 'a mating move received exactly at the flag deadline loses to the flag (due flags are committed first)');
  disposeAll();
}
{
  // the exact-millisecond tie: both deadlines are 5000. Equal start seq -> the room number's parity picks the board (even: A loses)
  const mgr = newGame({ scene: { a: START, b: START, startMs: 1000, clocks: { 0: { remainingMs: 4000 }, 2: { remainingMs: 4000 } } } });
  mgr.clock.advance(4000);
  same(mgr.match().result, { winnerTeam: 2, reason: 'flag', board: 'A', loserSeat: 0 }, 'tie at the same start seq, room 0 (even): board A loses');
  const second = newGame({ mgr: mgr.mgr, clock: mgr.clock, io: mgr.io, scene: { a: START, b: START, clocks: { 0: { remainingMs: 4000 }, 2: { remainingMs: 4000 } } } });
  check(second.match().roomNumber === 1, 'the next room on the same manager is room 1');
  second.clock.advance(4000);
  same(second.match().result, { winnerTeam: 1, reason: 'flag', board: 'B', loserSeat: 2 }, 'tie at the same start seq, room 1 (odd): board B loses');
  disposeAll();
  const lower = newGame({ scene: { a: START, b: START, startMs: 1000, seq: 5, clocks: { 0: { remainingMs: 4000, startSeq: 5 }, 2: { remainingMs: 4000, startSeq: 2 } } } });
  lower.clock.advance(4000);
  check(lower.match().result.loserSeat === 2, 'tie with different start seqs: the clock that started at the LOWER seq (seat 2, seq 2) loses, whatever the parity');
  disposeAll();
}
{
  // an early timer settles nothing and is re-armed; a flag one millisecond away is still not due
  const g = newGame({ scene: { a: START, b: START, startMs: 1000, clocks: { 0: { remainingMs: 2000 }, 2: { remainingMs: 9000 } } } });
  const [handle] = g.clock.pending().filter((h) => h.due === 3000);
  g.clock.jump(1999); // 2999
  g.clock.fire(handle);
  check(g.match().result === null && g.seq() === 0 && eventsOf(g.io, 'bug_state').length === 0, 'a timer that woke one millisecond early changes nothing and publishes nothing');
  same(g.clock.pending().filter((h) => h.due === 3000).map((h) => h.ms), [1], '...it is re-armed for the 1 ms that remain');
  g.clock.advance(1);
  check(g.match().result?.reason === 'flag' && g.match().result.loserSeat === 0, '...and the flag falls when that millisecond has passed');
  disposeAll();
}
{
  // a clock that goes backwards cannot wedge a room
  const clock = manualTimers(5000);
  const g = newGame({ clock });
  g.mv(0, 'A', 'e2', 'e4');
  const wild = { ...clock.timers, now: () => 10 };
  g.mgr.timers = wild;
  const ack = g.mv(1, 'A', 'e7', 'e5');
  check(ack.ok === true && g.match().nowMs >= 5000, 'an injected clock that reads an earlier instant is held at the match\'s last instant: the move is still accepted');
  disposeAll();
}

console.log('\n=== 7. HP8: a stuck player waits for the partner\'s capture ===');
{
  const g = newGame({ scene: { a: STUCK_A, b: 'r3k3/8/8/8/8/8/8/R3K3 w - - 0 1' } });
  check(g.match().verdicts.A.status === 'stuck' && g.match().verdicts.A.stuck === 'check', 'seat 1 (A Black) is stuck: in check, nothing to move, nothing to drop');
  const refused = g.drop(1, 'A', 'r', 'd8');
  check(refused.reason === 'dropNotInPocket' && g.match().result === null, 'it has nothing to drop yet; the match goes on');
  g.clock.jump(1000);
  check(g.mv(2, 'B', 'a1', 'a8').ok === true && g.match().pockets[1].r === 1, 'seat 2 (its partner) takes a rook on board B: the rook is in seat 1\'s pocket');
  check(g.match().verdicts.A.status === 'check', 'the same commit un-sticks seat 1 (it can answer the check now)');
  const ok = g.drop(1, 'A', 'r', 'd8');
  check(ok.ok === true && g.match().boards.A.fen.startsWith('R2r3k/'), 'seat 1 blocks the check with the rook on d8: accepted');
  disposeAll();

  // the same with a BOT in seat 1: no bot timer while stuck, one the moment the capture commit un-sticks it, and it plays the only legal action (a drop)
  const b = newGame({ kinds: ['human', 'bot', 'human', 'human'], scene: { a: STUCK_A, b: 'r3k3/8/8/8/8/8/8/R3K3 w - - 0 1' } });
  same(b.pending().bot, 0, 'a stuck bot has nothing to schedule');
  b.clock.jump(1000);
  b.mv(2, 'B', 'a1', 'a8');
  same(b.pending().bot, 1, 'the partner\'s capture un-sticks the bot: its move is scheduled');
  b.clock.advance(450);
  check(b.match().boards.A.plies === 1 && b.room().log.at(-1).seat === 1 && b.room().log.at(-1).san.startsWith('R@'), 'the bot answered the check with a drop of the rook (the only legal action)');
  disposeAll();
}

console.log('\n=== 8. Resignation ===');
{
  const g = newGame();
  g.clear();
  const ack = g.resign(1); // off turn: seat 1 is not on move at the start
  check(ack.ok === true, 'a resignation is accepted from any seat, also off turn');
  same(g.match().result, { winnerTeam: 1, reason: 'resign', board: 'A', loserSeat: 1 }, 'the resigning player\'s team loses at once: team 1 wins');
  check(g.seq() === 1 && states(g, 'S2').length === 1 && gameOvers(g, 'S2').length === 1 && gameOvers(g, 'S2')[0].payload.result.reason === 'resign', 'one bug_state then one bug_game_over to every seat');
  check(states(g, 'S3')[0].index < gameOvers(g, 'S3')[0].index, '...in that order');
  check(g.mgr.isSeated('S0') === false && g.mgr.rooms.size === 0, 'the sockets are released and the room is gone');
  disposeAll();
}
{
  const g = newGame();
  check(g.resign(3).ok === true && g.match().result.winnerTeam === 2 && g.match().result.board === 'B' && g.match().result.loserSeat === 3, 'seat 3 (team 1) resigning gives team 2 the match, decided on board B');
  disposeAll();
}

console.log('\n=== 9. A match decided on board B while board A is mid-game ===');
{
  const g = newGame();
  // board A: one move each way and White to move; board B: the scholar's mate by seat 2 (White). (The fool's mate is NOT a mate here: a piece dropped on f2 or g3 could block it - rule 18, the player is stuck.)
  check(g.mv(0, 'A', 'e2', 'e4').ok && g.mv(1, 'A', 'e7', 'e5').ok, 'board A is mid-game (two plies played, White to move)');
  const scholar = [[2, 'e2', 'e4'], [3, 'e7', 'e5'], [2, 'f1', 'c4'], [3, 'b8', 'c6'], [2, 'd1', 'h5'], [3, 'g8', 'f6']];
  check(scholar.every(([seat, from, to]) => g.mv(seat, 'B', from, to).ok), 'board B plays 1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6');
  const mate = g.mv(2, 'B', 'h5', 'f7');
  check(mate.ok === true && g.match().result?.reason === 'checkmate' && g.match().result.board === 'B' && g.match().result.winnerTeam === 2 && g.match().result.loserSeat === 3, 'Qxf7# ends the match on board B: team 2 wins');
  check(g.match().boards.A.plies === 2 && g.match().clocks.every((c) => c.runningSince === null), 'board A stays as it was and all four clocks are stopped');
  check(states(g, 'S0').at(-1).payload.events.map((e) => e.kind).join() === 'move,bank,result' && gameOvers(g, 'S1').length === 1, 'the mating commit carries the move, the pawn banked for seat 1 (the capturer\'s partner) and the result; every seat gets the game over');
  disposeAll();
}

console.log('\n=== 10. Takeover, hand-back and the all-gone void (B19, rule 22) ===');
{
  const g = newGame();
  g.clear();
  g.disconnect(1);
  const update = eventsOf(g.io, 'bug_seat_update', 'S0').at(-1).payload.seats[1];
  check(update.connected === false && update.kind === 'human' && update.graceMsLeft === 45000, 'the others are told seat 1 disconnected, with the grace it has left');
  check(g.pending().graces === 1 && g.pending().allGone === false && g.mgr.isSeated('S1') === false, 'a grace countdown runs; the other three humans are still there, so no all-gone countdown');
  g.clock.advance(44999);
  check(g.room().seats[1].controller === 'human', '44.999 s later the seat is still its human\'s');
  g.clock.advance(1);
  const seat = g.room().seats[1];
  check(seat.controller === 'bot' && seat.botReason === 'takeover' && seat.elo === 1200 && seat.originalHuman === true, 'at 45 s a bot takes the seat (takeover, Amateur) and the seat remembers it was a human\'s');
  const info = eventsOf(g.io, 'bug_seat_update', 'S2').at(-1).payload.seats[1];
  check(info.kind === 'bot' && info.botReason === 'takeover' && info.connected === true && info.graceMsLeft === undefined, 'everyone is told');
  check(g.match().result === null, 'a disconnect never loses the match');
  // seat 0 moves; seat 1 (a bot now) answers after its think time
  check(g.mv(0, 'A', 'e2', 'e4').ok === true && g.pending().bot === 1, 'seat 0 moves: the bot on board A is scheduled');
  g.clock.advance(450);
  check(g.match().boards.A.plies === 2 && g.room().log.at(-1).seat === 1, 'the bot played black\'s reply through the funnel');
  // hand-back: the human returns on a new socket
  g.clear();
  const ack = g.rejoin(1);
  check(ack.ok === true && ack.state.seat === 1 && ack.state.state === g.text() && ack.state.seq === g.seq(), 'the human gets the full snapshot of the match and its seat');
  check(g.room().seats[1].controller === 'human' && g.room().seats[1].botReason === undefined && g.room().seats[1].elo === undefined && g.room().seats[1].connected, 'the seat is the human\'s again');
  check(eventsOf(g.io, 'bug_seat_update', 'S0').at(-1).payload.seats[1].kind === 'human', 'everyone is told the seat is back');
  disposeAll();
}
{
  // a pending bot move is cancelled by the hand-back
  const g = newGame();
  g.mv(0, 'A', 'e2', 'e4');
  g.disconnect(1);
  g.clock.advance(45000); // the bot takes seat 1, which is on move: its move is scheduled
  same(g.pending().bot, 1, 'the taken-over seat is on move: a bot move is pending');
  g.rejoin(1);
  same(g.pending().bot, 0, 'rejoining cancels it');
  g.clock.advance(1000);
  check(g.match().boards.A.plies === 1, '...and nothing is played for the human');
  disposeAll();
}
{
  // all humans gone: no bot is handed an empty room; the match is voided after 45 s
  const g = newGame();
  for (const s of [0, 1, 2, 3]) g.disconnect(s);
  same(g.pending(), { clock: 2, bot: 0, allGone: true, graces: 4 }, 'all four gone: four grace countdowns and ONE all-gone countdown');
  g.clock.advance(44999);
  check(g.match().result === null, 'nothing happens before 45 s');
  g.clock.advance(1);
  check(!g.alive() && g.match().result?.voided === true && g.match().result.reason === 'abandoned', 'at 45 s the match ends VOIDED (abandoned): the room is gone and nobody won');
  check(g.room().seats.every((s) => s.controller === 'human'), 'no bot was handed the empty room');
  const rejoin = g.mgr.rejoin('Z', { roomId: g.id, playerToken: g.tokens[0] });
  check(rejoin.ok === true && rejoin.finished === true && rejoin.gameOver.result.voided === true && rejoin.gameOver.result.reason === 'abandoned', 'a late rejoin reads the voided result');
  const final = E.deserializeMatch(rejoin.gameOver.state);
  check(final.ok === true && final.match.result.voided === true && final.match.seq === 1, 'the final snapshot is the start position with the void as one more commit');
  disposeAll();
}
{
  // three disconnect, one stays: all three seats go to bots; then the last human leaves: voided after 45 s even though bots are playing on
  const g = newGame({ chooseBotAction: (m, s) => E.firstLegalAction(m, s) });
  for (const s of [1, 2, 3]) g.disconnect(s);
  g.clock.advance(45000);
  check([1, 2, 3].every((s) => g.room().seats[s].controller === 'bot') && g.room().seats[0].controller === 'human', 'three seats are taken over while one human remains');
  g.disconnect(0);
  same(g.pending().allGone, true, 'the last human leaving starts the all-gone countdown (bots do not count as people)');
  g.clock.advance(45000);
  check(!g.alive() && g.match().result?.voided === true, 'the match is voided 45 s later');
  const gone = g.mgr.rejoin('Z', { roomId: g.id, playerToken: g.tokens[1] });
  check(gone.ok === true && gone.finished === true && gone.gameOver.result.voided === true, 'and its result is kept for a late rejoin');
  disposeAll();
}
{
  // rejoin cancels the all-gone countdown, and a human who returns in time keeps the match alive
  const g = newGame({ chooseBotAction: (m, s) => E.firstLegalAction(m, s) });
  for (const s of [0, 1, 2, 3]) g.disconnect(s);
  g.clock.advance(30000);
  g.rejoin(2);
  check(g.pending().allGone === false && g.pending().graces === 3, 'a returning human cancels the all-gone countdown and its own grace');
  g.clock.advance(45000);
  check(g.match().result === null && g.alive() && [0, 1, 3].every((s) => g.room().seats[s].controller === 'bot'), 'the other three are taken over (a human is present) and the match goes on');
  disposeAll();
}

console.log('\n=== 11. The retention: the result is kept for exactly 5 minutes, then the room is cleaned up (B22) ===');
{
  const g = newGame();
  g.resign(0);
  const timersAfterEnd = g.clock.pending();
  check(timersAfterEnd.length === 1 && timersAfterEnd[0].ms === 300000 && timersAfterEnd[0].unref === true, 'a finished match owns exactly ONE timer: the (unref\'d) 5-minute cleanup');
  g.clock.advance(299999);
  const early = g.mgr.rejoin('Z1', { roomId: g.id, playerToken: g.tokens[2] });
  check(early.ok === true && early.finished === true && early.gameOver.result.reason === 'resign' && gameOvers(g, 'S0')[0].payload.state === early.gameOver.state, '299.999 s after the end the result is still there (the same game over the players got)');
  check(g.mgr.rejoin('Z1', { roomId: g.id, playerToken: 'not-a-token' }).reason === 'noGame', 'a wrong token gets nothing');
  g.clock.advance(1);
  const late = g.mgr.rejoin('Z1', { roomId: g.id, playerToken: g.tokens[2] });
  check(late.ok === false && late.reason === 'noGame' && g.mgr.finishedRooms.size === 0 && g.clock.live.size === 0, 'at exactly 5 minutes it is gone: no record, no timer');
  disposeAll();
}

console.log('\n=== 12. Spectators (HP6) ===');
{
  const g = newGame();
  const ack = g.mgr.spectate('W1', { roomId: g.id });
  check(ack.ok === true && JSON.stringify(ack.state).includes(g.tokens[0]) === false, 'a spectator\'s snapshot carries no token');
  check(g.mgr.spectate('S0', { roomId: g.id }).ok === false, 'a seated player cannot also watch');
  g.mv(0, 'A', 'e2', 'e4');
  g.disconnect(1);
  g.resign(2);
  check(states(g, 'W1').length === 2 && eventsOf(g.io, 'bug_seat_update', 'W1').length >= 1 && gameOvers(g, 'W1').length === 1, 'a spectator receives the states (the move and the resignation), seat updates and the game over');
  check(g.mgr.spectate('W1', { roomId: g.id }).ok === false, 'once the match is over it can no longer be watched');
  disposeAll();
  const h = newGame();
  for (let i = 0; i < 50; i++) h.mgr.spectate(`W${i}`, { roomId: h.id });
  check(h.mgr.spectate('W50', { roomId: h.id }).ok === false && h.mgr.spectate('W7', { roomId: h.id }).ok === true, 'a room holds 50 spectators; one who already watches is never refused');
  h.mgr.stopSpectating('W3');
  check(h.mgr.spectate('W50', { roomId: h.id }).ok === true, 'a place frees when a spectator leaves');
  h.mgr.handleDisconnect('W4');
  check(h.room().spectators.has('W4') === false, 'a spectator that disconnects is removed');
  const list = h.mgr.listActiveGames();
  check(list.length === 1 && list[0].roomId === h.id && list[0].timeControlLabel === '3 min' && !JSON.stringify(list).includes(h.tokens[0]) && !JSON.stringify(list).includes('S0'), 'the active list shows names and kinds, never a token or a socket id');
  disposeAll();
}

console.log('\n=== 13. The rejoin snapshot restores everything (HP5) ===');
{
  const g = newGame();
  g.clock.jump(1200);
  g.mv(0, 'A', 'e2', 'e4');
  g.clock.jump(800);
  g.mv(2, 'B', 'd2', 'd4');
  g.clock.jump(500);
  g.mv(1, 'A', 'd7', 'd5');
  g.clock.jump(300);
  g.mv(0, 'A', 'e4', 'd5'); // a capture: seat 3 now holds a pawn
  g.disconnect(3);
  g.clock.jump(100);
  const ack = g.rejoin(3);
  check(ack.ok === true && ack.state.seat === 3 && ack.state.roomId === g.id && ack.state.seq === g.seq(), 'the answer names the room, the seat and the current seq');
  const back = E.deserializeMatch(ack.state.state);
  check(back.ok === true && E.serializeMatch(back.match) === g.text(), 'the snapshot reads back through the engine and is byte-identical to the live match');
  check(back.match.pockets[3].p === 1 && back.match.boards.A.plies === 3 && back.match.boards.B.plies === 1, 'it holds both boards\' plies and the pocket the capture filled');
  check(back.match.clocks.every((c, i) => c.remainingMs === g.match().clocks[i].remainingMs && c.runningSince === g.match().clocks[i].runningSince && c.startSeq === g.match().clocks[i].startSeq), 'and all four clocks, with the instant each runs since');
  check(ack.state.serverNowMs === g.clock.now() && ack.state.serverNowMs > g.match().nowMs, 'serverNowMs is the instant on the match clock when the answer was made, so a client can show the running clocks');
  same(ack.state.log.map((e) => e.san), ['e4', 'd4', 'd5', 'exd5'], 'the log has the four moves in order');
  disposeAll();
  const h = newGame();
  const s2 = h.mgr.rejoin('NEW', { roomId: h.id, playerToken: h.tokens[2] });
  check(s2.ok === true && h.mgr.isSeated('NEW') && !h.mgr.isSeated('S2'), 'a second device replaces the older connection: the old socket no longer owns the seat');
  h.clear();
  h.mgr.handleDisconnect('S2');
  check(h.room().seats[2].connected === true && h.room().seats[2].socketId === 'NEW' && h.pending().graces === 0, 'the late disconnect of the replaced socket is ignored');
  h.mv(0, 'A', 'e2', 'e4');
  check(eventsOf(h.io, 'bug_state', 'S2').length === 0 && eventsOf(h.io, 'bug_state', 'NEW').length === 1, 'events go to the new socket only');
  check(h.mgr.rejoin('S9', { roomId: h.id, playerToken: h.tokens[0] }).ok === true && h.mgr.rejoin('S1', { roomId: h.id, playerToken: h.tokens[3] }).reason === 'noGame', 'a socket seated in this room cannot take a second seat');
  disposeAll();
}

console.log('\n=== 14. A faulty bot can never stall a board or take the loop down ===');
{
  const bad = {
    'throws': () => {
      throw new Error('boom');
    },
    'returns null': () => null,
    'plays an illegal move': () => ({ kind: 'move', board: 'A', from: 'a1', to: 'a8' }),
    'plays on the wrong board': () => ({ kind: 'move', board: 'B', from: 'e2', to: 'e4' }),
    'plays a drop it does not have': () => ({ kind: 'drop', board: 'A', piece: 'q', square: 'e4' }),
  };
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  for (const [label, chooser] of Object.entries(bad)) {
    const g = newGame({ kinds: ['bot', 'human', 'human', 'human'], chooseBotAction: chooser });
    g.clock.advance(450);
    check(g.match().boards.A.plies === 1 && g.room().log[0].seat === 0, `a bot that ${label}: the first legal action is played instead`);
    disposeAll();
  }
  console.error = original;
  check(errors.length >= 5 && errors.every((e) => e.includes('[bughouseRooms]')), 'each fault is logged once');
}
{
  // the bot's pending move survives a commit on the OTHER board (no postponement), and is replaced when its own board moves
  const g = newGame({ kinds: ['bot', 'human', 'human', 'human'], chooseBotAction: () => ({ kind: 'move', board: 'A', from: 'e2', to: 'e4' }) });
  const [pending] = g.clock.pending().filter((h) => h.ms === 450);
  g.clock.advance(100);
  g.mv(2, 'B', 'e2', 'e4'); // a commit on board B
  const still = g.clock.pending().filter((h) => h.ms === 450);
  check(still.length === 1 && still[0] === pending && still[0].due === pending.due, 'a commit on the other board leaves the bot\'s pending move exactly where it was (same timer, same due instant)');
  g.clock.advance(350);
  check(g.match().boards.A.plies === 1, 'and it plays on time');
  disposeAll();
}
{
  // humans that never move lose on time with a bot at the table: the earliest deadline (seat 2, running since the start) loses
  const g = newGame({ kinds: ['bot', 'human', 'human', 'human'], chooseBotAction: (m, s) => E.firstLegalAction(m, s) });
  g.clock.advance(180000);
  same(g.match().result, { winnerTeam: 1, reason: 'flag', board: 'B', loserSeat: 2 }, 'the bot played its move; the humans never did: seat 2 (deadline 180000) flags before seat 1 (deadline 180450)');
  disposeAll();
}

console.log('\n=== 15. Odds and ends: names, a spectator who sits down, the list, a failing send, a resignation under the rate limit ===');
{
  const g = newGame({ names: ['A'.repeat(60), 'Bob', 'Cy', 'Di'] });
  check(g.room().seats[0].name === 'A'.repeat(40) && eventsOf(g.io, 'bug_match_found', 'S1')[0].payload.seats[0].name === 'A'.repeat(40), 'a display name is cut to 40 characters');
  disposeAll();
}
{
  // a socket that watches and is then seated (a match made for it) stops watching
  const clock = manualTimers();
  const io = stubIo();
  const mgr = new BughouseRoomManager(io, { timers: clock.timers });
  const watched = newGame({ clock, io, mgr });
  check(mgr.spectate('X0', { roomId: watched.id }).ok === true && watched.room().spectators.has('X0'), 'a socket watches a match');
  const second = mgr.createRoom({ seats: [0, 1, 2, 3].map((i) => ({ kind: 'human', socketId: i === 0 ? 'X0' : `Z${i}`, name: 'n' })), timeControl: TC3 });
  check(!watched.room().spectators.has('X0') && mgr.isSeated('X0') && mgr.rooms.get(second.roomId) !== undefined, 'when a match is made for it, it stops watching the first one (a player cannot also be a spectator)');
  disposeAll();
}
{
  const clock = manualTimers();
  const io = stubIo();
  const mgr = new BughouseRoomManager(io, { timers: clock.timers });
  const ids = [];
  for (let n = 0; n < 103; n++) {
    const created = mgr.createRoom({ seats: [0, 1, 2, 3].map((i) => ({ kind: 'human', socketId: `L${n}.${i}`, name: `room ${n}` })), timeControl: n % 2 ? TC3 : TC32 });
    ids.push(created.roomId);
  }
  const list = mgr.listActiveGames();
  check(list.length === 100 && list[0].roomId === ids[102] && list[99].roomId === ids[3], 'the active list is NEWEST first and at most 100 long');
  check(list[0].timeControlLabel === '3 | 2' && list[1].timeControlLabel === '3 min' && list[0].seats.length === 4 && Object.keys(list[0]).sort().join() === 'roomId,seats,timeControlLabel', 'each row has the room, the label and the four seats (name and kind) - nothing else');
  for (const id of ids) {
    const room = mgr.rooms.get(id);
    for (const h of Object.values(room.clockTimers)) clock.timers.clearTimer(h);
  }
}
{
  // a send that throws (a socket going away) cannot abort a commit or skip the other recipients
  const g = newGame();
  g.io.failing.add('S1');
  const errors = [];
  const original = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  const ack = g.mv(0, 'A', 'e2', 'e4');
  console.error = original;
  check(ack.ok === true && g.seq() === 1, 'the move is committed although the send to seat 1 throws');
  check(eventsOf(g.io, 'bug_state', 'S0').length === 1 && eventsOf(g.io, 'bug_state', 'S2').length === 1 && eventsOf(g.io, 'bug_state', 'S3').length === 1 && eventsOf(g.io, 'bug_state', 'S1').length === 0, '...the other three still get their bug_state');
  check(errors.length === 1 && errors[0].includes('[bughouseRooms] failed to send bug_state to S1'), '...and the failure is logged once, naming the event and the socket');
  disposeAll();
}
{
  // a resignation is never rate limited: after ten refused calls the seat can still resign
  const g = newGame();
  for (let i = 0; i < 10; i++) g.mv(1, 'A', 'e7', 'e5');
  check(g.mv(1, 'A', 'e7', 'e5').reason === 'rateLimited', 'seat 1 has used its ten calls this second');
  check(g.resign(1).ok === true && g.match().result?.reason === 'resign', '...and can still resign');
  disposeAll();
}
{
  // the takeover bot is an Amateur and the fill bots keep the strength the matchmaker gave them
  const g = newGame({ kinds: ['human', 'human', 'bot', 'human'], elos: [undefined, undefined, 900, undefined] });
  check(g.room().seats[2].elo === 900 && g.room().seats[2].botReason === 'fill' && g.room().seats[2].originalHuman === false, 'a fill bot keeps the strength it was given and was never a human');
  const info = eventsOf(g.io, 'bug_match_found', 'S0')[0].payload.seats[2];
  check(info.kind === 'bot' && info.botReason === 'fill' && info.elo === 900 && info.connected === true, '...and the seat list says so');
  g.disconnect(0);
  g.clock.advance(45000);
  check(g.room().seats[0].controller === 'bot' && g.room().seats[0].elo === 1200 && g.room().seats[0].botReason === 'takeover', 'a takeover bot is Amateur (1200)');
  disposeAll();
}

console.log('\n=== 16. Pins for the second lines of defence, the exact refusals of createRoom, and the bookkeeping that is easy to get subtly wrong ===');
{
  // createRoom refuses a programming error with a message that says which (so a different refusal cannot hide behind a generic crash)
  const mgr = new BughouseRoomManager(stubIo(), { timers: manualTimers().timers });
  const seats = (n) => Array.from({ length: n }, (_, i) => ({ kind: 'human', socketId: `X${i}`, name: 'x' }));
  const bots = [0, 1, 2, 3].map(() => ({ kind: 'bot', socketId: null, name: 'b', elo: 1200 }));
  const message = (params) => {
    try {
      mgr.createRoom(params);
      return null;
    } catch (err) {
      return err.message;
    }
  };
  same(message({ seats: seats(4), timeControl: { initialMs: 600000, incrementMs: 0 } }), 'createRoom: Unknown time control.', 'a time control outside the six: refused as such');
  same(message({ seats: seats(3), timeControl: TC3 }), 'createRoom: exactly four seats are required', 'three seats: refused as such');
  same(message({ seats: 'four', timeControl: TC3 }), 'createRoom: exactly four seats are required', 'seats that are not a list: refused as such');
  same(message({ seats: bots, timeControl: TC3 }), 'createRoom: at least one human seat is required', 'no human: refused as such');
  same(message({ seats: [{ kind: 'human', socketId: 'X0', name: 'a' }, { kind: 'human', socketId: 'X0', name: 'b' }, bots[2], bots[3]], timeControl: TC3 }), 'createRoom: every human seat needs its own socket', 'one socket twice: refused as such');
  same(message({ seats: [{ kind: 'human', socketId: null, name: 'a' }, bots[1], bots[2], bots[3]], timeControl: TC3 }), 'createRoom: every human seat needs its own socket', 'a human with no socket: refused as such');
  same(message({ seats: [{ kind: 'human', socketId: 'Y0', name: 'a' }, { kind: 'human', socketId: 'Y1', name: 'b' }, bots[2], bots[3]], timeControl: TC3 }), null, 'two humans and two bots are fine');
  same(message({ seats: [{ kind: 'human', socketId: 'Y0', name: 'a' }, bots[1], bots[2], bots[3]], timeControl: TC3 }), 'createRoom: a socket is already seated in another game', 'a seated socket: refused as such');
  check(mgr.rooms.size === 1, '...and the refused attempts created nothing');
}
{
  const g = newGame({ kinds: ['human', 'human', 'bot', 'bot'] });
  const created = [g.tokens[0], g.tokens[1]];
  check(created.every((t) => UUID.test(t)) && g.tokens[2] === null && g.tokens[3] === null && g.room().seats[2].playerToken === null, 'only humans have a token: a bot seat\'s is null');
  same(eventsOf(g.io, 'bug_match_found').map((e) => e.id).sort(), ['S0', 'S1'], 'bug_match_found goes to the humans only');
  disposeAll();
}
{
  // what the bot is asked: the room's match, its seat, its strength and the bot random stream (nothing else)
  const calls = [];
  const rng = () => 0.5;
  const g = newGame({ kinds: ['bot', 'human', 'human', 'human'], botRng: rng, elos: [900, undefined, undefined, undefined], chooseBotAction: (match, seat, elo, r) => (calls.push({ match, seat, elo, r }), E.firstLegalAction(match, seat)) });
  g.clock.advance(450);
  check(calls.length === 1 && calls[0].seat === 0 && calls[0].elo === 900 && calls[0].r === rng && calls[0].match.seq === 0, 'the chooser is called with the match, the seat, the seat\'s own strength (900) and the injected bot random stream');
  disposeAll();
  const h = newGame({ botRng: rng, chooseBotAction: (match, seat, elo, r) => (calls.push({ match, seat, elo, r }), E.firstLegalAction(match, seat)) });
  h.disconnect(0);
  h.clock.advance(45000);
  h.clock.advance(450);
  const last = calls.at(-1);
  check(last.seat === 0 && last.elo === 1200, 'a takeover bot is asked at 1200');
  disposeAll();
}
{
  // callbacks that outlive what armed them do nothing (white-box: they are called directly, the way a late timer would)
  const g = newGame({ kinds: ['bot', 'human', 'human', 'human'], chooseBotAction: (m, s) => E.firstLegalAction(m, s) });
  const room = g.room();
  g.mgr.playBotTurn(room, 'A', 1); // armed for a seat that is not on move, and is a human
  g.mgr.playBotTurn(room, 'B', 2); // seat 2 is on move but is a human
  check(g.seq() === 0, 'a bot callback for a seat that is not a bot, or not on move, plays nothing');
  g.rejoin(1);
  room.status = 'finished';
  g.mgr.playBotTurn(room, 'A', 0);
  check(g.seq() === 0, '...nor does one for a finished room');
  room.status = 'active';
  disposeAll();
  const h = newGame();
  const hr = h.room();
  h.mgr.onGraceExpired(hr, 1); // seat 1 is connected
  check(hr.seats[1].controller === 'human', 'a grace callback for a seat that is connected changes nothing');
  h.disconnect(1);
  hr.status = 'finished';
  h.mgr.onGraceExpired(hr, 1);
  check(hr.seats[1].controller === 'human', '...nor does one for a finished room');
  hr.status = 'active';
  h.rejoin(1);
  h.mgr.endAbandoned(hr); // somebody is connected
  check(hr.status === 'active' && h.match().result === null, 'an all-gone callback with a human connected ends nothing');
  for (const s of [0, 1, 2, 3]) h.disconnect(s); // everybody is gone ...
  hr.status = 'finished'; // ... but the room is already over
  h.mgr.endAbandoned(hr);
  check(h.match().result === null, '...nor does one for a finished room (even with nobody connected)');
  hr.status = 'active';
  disposeAll();
  const c = newGame();
  const cr = c.room();
  c.clock.jump(180000); // both White clocks are due, no timer has run
  cr.status = 'finished';
  c.mgr.onClockTimer(cr, 'A');
  check(c.match().result === null && c.seq() === 0, 'a clock callback for a finished room settles nothing');
  cr.status = 'active';
  c.mgr.onClockTimer(cr, 'A');
  check(c.match().result?.reason === 'flag', '...the same callback for an active room settles the flag');
  disposeAll();
}
{
  // a bot whose own clock ran out when its move fired: the flag is the result, and no complaint
  const g = newGame({ kinds: ['bot', 'human', 'human', 'human'], chooseBotAction: (m, s) => E.firstLegalAction(m, s) });
  const bot = g.room().botTimers.A;
  const errors = [];
  const original = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  g.clock.jump(180000);
  g.clock.fire(bot.handle);
  console.error = original;
  check(g.match().result?.reason === 'flag' && g.match().result.loserSeat === 0 && errors.length === 0 && g.seq() === 1, 'a bot timer that fires after its clock ran out ends the match by flag (one commit) and is not reported as a fault');
  disposeAll();
}
{
  // the rate limit counts the calls the engine judged, not the ones it refused for rate: a seat that keeps hammering does not extend its own sentence
  const g = newGame();
  for (let i = 0; i < 10; i++) g.mv(1, 'A', 'e7', 'e5');
  g.clock.jump(500);
  for (let i = 0; i < 10; i++) check(g.mv(1, 'A', 'e7', 'e5').reason === 'rateLimited', `${i + 1}/10 attempts at +500 ms are refused`);
  g.clock.jump(500);
  check(g.mv(1, 'A', 'e7', 'e5').reason === 'notYourTurn', 'at +1000 ms the ten calls of the first window are out and the refused attempts did not count: the engine judges again');
  disposeAll();
}
{
  // timers: exactly what should be pending is pending (the room's own handles AND the clock's real count)
  const g = newGame();
  g.mv(0, 'A', 'e2', 'e4');
  g.mv(1, 'A', 'e7', 'e5');
  check(g.clock.live.size === 2 && g.pending().clock === 2, 'after two moves exactly two clock timers are live (one per board): the re-arm replaced them, it did not add');
  disposeAll();
  const h = newGame({ kinds: ['human', 'human', 'human', 'bot'], chooseBotAction: (m, s) => E.firstLegalAction(m, s) });
  h.mv(2, 'B', 'e2', 'e4');
  check(h.clock.live.size === 3, 'with a bot to move on board B: two clock timers and one bot timer');
  h.resign(1);
  check(h.clock.live.size === 1 && h.clock.pending()[0].ms === 300000, 'when the match ends everything the room owned is cleared (clock and bot timers): only the retention timer is left');
  disposeAll();
  const k = newGame();
  k.disconnect(1);
  k.resign(2);
  check(k.clock.live.size === 1 && k.mgr.socketToSpectating.size === 0, '...also a grace countdown');
  disposeAll();
  const m = newGame();
  m.mgr.spectate('W1', { roomId: m.id });
  m.resign(0);
  check(m.mgr.socketToSpectating.size === 0 && m.mgr.socketToSeat.size === 0, 'when a match ends no socket is left mapped to it (neither a seat nor a spectator)');
  disposeAll();
}
{
  // a spectator who comes back as a player stops watching; a rejoin clears the disconnect stamp
  const g = newGame();
  g.mgr.spectate('W9', { roomId: g.id });
  g.disconnect(2);
  const ack = g.mgr.rejoin('W9', { roomId: g.id, playerToken: g.tokens[2] });
  check(ack.ok === true && !g.room().spectators.has('W9') && !g.mgr.socketToSpectating.has('W9') && g.mgr.isSeated('W9'), 'a spectator socket that rejoins a seat is a player, no longer a spectator');
  check(g.room().seats[2].disconnectedAt === null && g.room().seats[2].graceTimer === null, '...and the seat\'s disconnect stamp and grace are cleared');
  // the room state hands out copies
  const seen = g.mgr.spectate('W8', { roomId: g.id }).state;
  seen.log.push({ junk: true });
  seen.seats.pop();
  check(g.room().log.length === 0 && g.mgr.spectate('W7', { roomId: g.id }).state.seats.length === 4 && g.mgr.spectate('W7', { roomId: g.id }).state.log.length === 0, 'the log and the seats a snapshot carries are copies: changing them does not change the room');
  disposeAll();
}
{
  // a clock that misbehaves cannot wedge the all-gone void
  const clock = manualTimers(5000);
  const g = newGame({ clock });
  g.mv(0, 'A', 'e2', 'e4');
  g.mgr.timers = { ...clock.timers, now: () => 10 };
  for (const s of [0, 1, 2, 3]) g.disconnect(s);
  g.mgr.timers = clock.timers;
  const stale = { ...clock.timers, now: () => 10 };
  g.mgr.timers = stale;
  g.mgr.endAbandoned(g.room());
  check(g.match().result?.voided === true, 'the void is applied at the match\'s own last instant when the injected clock reads an earlier one');
  disposeAll();
}

console.log('\n=== 17. More pins: promotion, drops under the rate limit, the words of a refusal, a young clock, two rooms, the lazy retention bound ===');
{
  // a promotion piece reaches the engine
  const g = newGame({ scene: { a: '8/P6k/8/8/8/8/8/K7 w - - 0 1', b: START } });
  const ack = g.mv(0, 'A', 'a7', 'a8', 'n');
  check(ack.ok === true && g.match().boards.A.fen.startsWith('N7/'), 'a promotion to a knight is played as a knight (the piece in the payload reaches the engine)');
  disposeAll();
  const h = newGame({ scene: { a: '8/P6k/8/8/8/8/8/K7 w - - 0 1', b: START } });
  check(h.mv(0, 'A', 'a7', 'a8', 'q').ok === true && h.match().boards.A.fen.startsWith('Q7/'), '...and to a queen as a queen');
  disposeAll();
}
{
  // drops are counted by the rate limit like moves
  const g = newGame({ scene: { a: START, b: START, pockets: { 0: { n: 1 } } } });
  const reasons = [];
  for (let i = 0; i < 11; i++) reasons.push(g.drop(0, 'A', 'n', 'a1').reason); // a1 is occupied: the engine refuses each, the limiter counts each
  check(reasons.slice(0, 10).every((r) => r === 'illegalDrop') && reasons[10] === 'rateLimited', 'ten drops are judged by the engine, the eleventh is rateLimited');
  const ok = g.drop(0, 'A', 'p', 'e4');
  check(ok.reason === 'rateLimited', '...a drop of another piece is limited the same (the limit is per seat, not per request)');
  disposeAll();
}
{
  // the words a refusal carries (the client shows them as they are)
  const g = newGame();
  const text = (ack) => ack.error;
  same(
    [text(g.mv(1, 'A', 'e7', 'e5')), text(g.mv(0, 'B', 'e2', 'e4')), text(g.mv(0, 'A', 'e2', 'e5')), text(g.drop(0, 'A', 'n', 'e4'))],
    ['Not your turn.', 'That is not your board.', 'Illegal move.', 'That piece is not in your pocket.'],
    'the refusals say: Not your turn. / That is not your board. / Illegal move. / That piece is not in your pocket.',
  );
  g.clock.jump(1100);
  same([text(g.mv(3, 'B', 'e7', 'e5'))], ['Not your turn.'], 'the wording does not depend on the seat');
  const stranger = g.mgr.makeMove('Z9', { roomId: g.id, board: 'A', from: 'e2', to: 'e4' });
  same([stranger.error, stranger.reason], ['No active game found for this connection.', 'noGame'], 'a stranger is told there is no game for this connection');
  const bad = g.mgr.makeMove('S0', { roomId: g.id, board: 'C', from: 'e2', to: 'e4' });
  same([bad.error, bad.reason], ['Invalid board.', 'invalidRequest'], 'a payload the validator refuses keeps the validator\'s words');
  disposeAll();
  const f = newGame({ scene: { a: START, b: START, clocks: { 0: { remainingMs: 100 } } } });
  f.clock.jump(200);
  same([f.mv(0, 'A', 'e2', 'e4').error], ['A flag had already fallen.'], 'a move after a flag says so');
  disposeAll();
  const r = newGame();
  for (let i = 0; i < 10; i++) r.mv(1, 'A', 'e7', 'e5');
  same([r.mv(1, 'A', 'e7', 'e5').error], ['Too many requests - slow down.'], 'the rate limit says so');
  disposeAll();
}
{
  // a young clock: the first chat and quick message of a seat work whatever the clock reads (the real clock counts from the process start)
  const g = newGame({ clock: manualTimers(100) });
  check(g.chat(0, 'first').ok === true && g.quick(0, 3).ok === true, 'with the clock at 100 ms the first chat line and the first quick message are accepted (a seat that never wrote has no last time)');
  disposeAll();
  const h = newGame({ clock: manualTimers(0) });
  check(h.chat(0, 'first').ok === true && h.quick(0, 3).ok === true, '...also at 0');
  disposeAll();
}
{
  // two rooms: an id of ANOTHER running match is not a way into it
  const clock = manualTimers();
  const io = stubIo();
  const mgr = new BughouseRoomManager(io, { timers: clock.timers });
  const one = newGame({ clock, io, mgr });
  const two = mgr.createRoom({ seats: [0, 1, 2, 3].map((i) => ({ kind: 'human', socketId: `T${i}`, name: `t${i}` })), timeControl: TC3 });
  const ack = mgr.makeMove('S0', { roomId: two.roomId, board: 'A', from: 'e2', to: 'e4' });
  check(ack.ok === false && ack.reason === 'noGame' && one.seq() === 0 && mgr.rooms.get(two.roomId).match.seq === 0, 'a seated socket naming another room\'s id is told noGame and neither room changes');
  check(mgr.resign('S0', { roomId: two.roomId }).reason === 'noGame' && mgr.sendChat('S0', { roomId: two.roomId, text: 'x' }).reason === 'noGame' && mgr.sendQuick('S0', { roomId: two.roomId, code: 1 }).reason === 'noGame', '...for a resignation, a chat line and a quick message too');
  check(mgr.spectate('W1', { roomId: one.id }).ok === true && mgr.spectate('W1', { roomId: two.roomId }).ok === true && !one.room().spectators.has('W1') && mgr.rooms.get(two.roomId).spectators.has('W1'), 'a spectator who starts watching another match stops watching the first');
  for (const id of [one.id, two.roomId]) for (const h of Object.values(mgr.rooms.get(id).clockTimers)) clock.timers.clearTimer(h);
}
{
  // the think delay: bullet is 200 ms up to and including 2 | 1, 450 ms above; the labels
  const bullet = newGame({ kinds: ['bot', 'human', 'human', 'human'], tc: { initialMs: 120000, incrementMs: 1000 } });
  same(bullet.clock.pending().filter((h) => h.ms < 1000).map((h) => h.ms), [200], '2 | 1 is bullet: the bot thinks 200 ms');
  same(eventsOf(bullet.io, 'bug_match_found', 'S1')[0].payload.timeControlLabel, '2 | 1', '...and its label is "2 | 1"');
  disposeAll();
  const blitz = newGame({ kinds: ['bot', 'human', 'human', 'human'], tc: { initialMs: 180000, incrementMs: 2000 } });
  same(blitz.clock.pending().filter((h) => h.ms < 1000).map((h) => h.ms), [450], '3 | 2 is not bullet: 450 ms');
  disposeAll();
  const one = newGame({ tc: TC1 });
  same(eventsOf(one.io, 'bug_match_found', 'S0')[0].payload.timeControlLabel, '1 min', 'the label of the 1-minute control is "1 min"');
  disposeAll();
  const five = newGame({ tc: { initialMs: 300000, incrementMs: 2000 } });
  same(eventsOf(five.io, 'bug_match_found', 'S0')[0].payload.timeControlLabel, '5 | 2', '...and of 5 | 2 is "5 | 2"');
  disposeAll();
}
{
  // the retention is also checked lazily: a late cleanup timer does not extend it
  const g = newGame();
  g.resign(0);
  g.clock.jump(299999);
  check(g.mgr.rejoin('Z', { roomId: g.id, playerToken: g.tokens[1] }).finished === true, 'at 299.999 s (the cleanup timer has not run yet) the result is still handed out');
  g.clock.jump(1);
  const late = g.mgr.rejoin('Z', { roomId: g.id, playerToken: g.tokens[1] });
  check(late.ok === false && late.reason === 'noGame' && g.mgr.finishedRooms.size === 1, 'at exactly 300 s it is refused even though the cleanup timer has not run (it is checked on the clock, not only by the timer)');
  disposeAll();
}
{
  // a match that ends while every human is away clears the all-gone countdown too
  const g = newGame({ scene: { a: START, b: START, clocks: { 0: { remainingMs: 10000 }, 2: { remainingMs: 10000 } } } });
  for (const s of [0, 1, 2, 3]) g.disconnect(s);
  check(g.clock.live.size === 2 + 4 + 1, 'two clock timers, four graces and the all-gone countdown are pending');
  g.clock.advance(10000);
  check(g.match().result?.reason === 'flag' && g.clock.live.size === 1, 'the clocks run out first (10 s < 45 s): the flag ends the match and ONLY the retention timer remains - the grace and all-gone countdowns were cleared');
  disposeAll();
}
{
  // a bot created without a strength is asked at 1200
  const calls = [];
  const clock = manualTimers();
  const mgr = new BughouseRoomManager(stubIo(), { timers: clock.timers, chooseBotAction: (m, s, elo) => (calls.push(elo), E.firstLegalAction(m, s)) });
  const created = mgr.createRoom({ seats: [{ kind: 'bot', socketId: null, name: 'b' }, { kind: 'human', socketId: 'S1', name: 'h' }, { kind: 'human', socketId: 'S2', name: 'h' }, { kind: 'human', socketId: 'S3', name: 'h' }], timeControl: TC3 });
  clock.advance(450);
  same(calls, [1200], 'a fill bot given no strength is asked at 1200 (Amateur)');
  const room = mgr.rooms.get(created.roomId);
  for (const h of Object.values(room.clockTimers)) clock.timers.clearTimer(h);
}
{
  // the grace a client is told counts down
  const g = newGame();
  g.disconnect(1);
  g.clock.jump(10000);
  g.disconnect(2);
  const seats = eventsOf(g.io, 'bug_seat_update', 'S0').at(-1).payload.seats;
  check(seats[1].graceMsLeft === 35000 && seats[2].graceMsLeft === 45000, 'seat 1 has 35 s of its 45 s left after 10 s; seat 2, just gone, has the whole 45 s');
  disposeAll();
  const h = newGame({ graceMs: 20000 });
  h.disconnect(1);
  check(eventsOf(h.io, 'bug_seat_update', 'S0').at(-1).payload.seats[1].graceMsLeft === 20000, 'an injected grace (20 s) is the one that is told and used');
  h.clock.advance(19999);
  check(h.room().seats[1].controller === 'human', '...a human is not replaced one millisecond early');
  h.clock.advance(1);
  check(h.room().seats[1].controller === 'bot', '...and is at exactly 20 s');
  disposeAll();
  const k = newGame({ allGoneMs: 5000 });
  for (const s of [0, 1, 2, 3]) k.disconnect(s);
  k.clock.advance(4999);
  check(k.match().result === null, 'an injected all-gone time (5 s): nothing at 4.999 s');
  k.clock.advance(1);
  check(k.match().result?.voided === true, '...the void at exactly 5 s');
  disposeAll();
}
{
  // a bot's cancelled move leaves no live timer behind
  const g = newGame();
  g.mv(0, 'A', 'e2', 'e4');
  g.disconnect(1);
  g.clock.advance(45000);
  const liveWithBot = g.clock.live.size;
  g.rejoin(1);
  check(liveWithBot === 3 && g.clock.live.size === 2, 'a takeover bot\'s pending move is a live timer (3 in all) and a hand-back cancels it for real (2 left)');
  disposeAll();
}

console.log('\n=== 18. Survivors of the first mutation run, killed (a late flag, a stale callback, the counts of live timers, an unknown token ...) ===');
{
  // a fill bot given no reason is a FILL bot; a bot seat whose grace ran out is not "taken over" again
  const clock = manualTimers();
  const mgr = new BughouseRoomManager(stubIo(), { timers: clock.timers });
  const created = mgr.createRoom({ seats: [{ kind: 'bot', socketId: null, name: 'b' }, { kind: 'human', socketId: 'S1', name: 'h' }, { kind: 'human', socketId: 'S2', name: 'h' }, { kind: 'human', socketId: 'S3', name: 'h' }], timeControl: TC3 });
  const room = mgr.rooms.get(created.roomId);
  same([room.seats[0].botReason, mgr.seatInfos(room)[0].botReason], ['fill', 'fill'], 'a bot created with no reason is a fill bot (in the room and in the seat list)');
  for (const h of Object.values(room.clockTimers)) clock.timers.clearTimer(h);
  for (const b of Object.values(room.botTimers)) if (b) clock.timers.clearTimer(b.handle);
  const g = newGame({ kinds: ['human', 'human', 'bot', 'human'], elos: [undefined, undefined, 900, undefined] });
  const botSeat = g.room().seats[2];
  botSeat.connected = false;
  g.mgr.onGraceExpired(g.room(), 2);
  same([botSeat.controller, botSeat.botReason, botSeat.elo], ['bot', 'fill', 900], 'a grace callback for a seat a bot already plays changes nothing: it stays a 900-rated fill bot');
  disposeAll();
}
{
  // the clock timers are re-armed by a commit: a clock that starts with LESS time than the old timer's deadline flags on time
  const g = newGame({ scene: { a: START, b: START, startMs: 1000, clocks: { 1: { remainingMs: 5000 } } } });
  g.mv(0, 'A', 'e2', 'e4'); // seat 1's clock (5 s) starts now
  const aTimer = g.room().clockTimers.A;
  check(aTimer.due === g.clock.now() + 5000, 'after the move, board A\'s timer is due when SEAT 1\'S clock runs out (5 s), not when White\'s old deadline would have');
  g.clock.advance(5000);
  same(g.match().result, { winnerTeam: 1, reason: 'flag', board: 'A', loserSeat: 1 }, '...and the flag is published at exactly that instant');
  disposeAll();
}
{
  // each board's timer belongs to ITS clock
  const g = newGame({ scene: { a: START, b: START, startMs: 1000, clocks: { 0: { remainingMs: 5000 }, 2: { remainingMs: 3000 } } } });
  same([g.room().clockTimers.A.due, g.room().clockTimers.B.due], [6000, 4000], 'board A\'s timer is due at seat 0\'s deadline (6000) and board B\'s at seat 2\'s (4000)');
  disposeAll();
}
{
  // an unknown token for a running match
  const g = newGame();
  const before = g.text();
  const ack = g.mgr.rejoin('Z1', { roomId: g.id, playerToken: 'not-a-token-of-this-match' });
  check(ack.ok === false && ack.reason === 'noGame' && ack.error === 'Invalid playerToken.' && !g.mgr.isSeated('Z1') && g.text() === before, 'a rejoin with a token that belongs to no seat of a running match is refused (Invalid playerToken.) and changes nothing');
  disposeAll();
}
{
  // countdowns a rejoin ends are really ended (live timers, not only the room's own references)
  const g = newGame();
  g.disconnect(1);
  check(g.clock.live.size === 3, 'a disconnect adds one live timer (the grace)');
  g.rejoin(1);
  check(g.clock.live.size === 2, '...and the rejoin removes it for real');
  disposeAll();
  const h = newGame();
  for (const s of [0, 1, 2, 3]) h.disconnect(s);
  check(h.clock.live.size === 2 + 4 + 1, 'four gone: two clock timers, four graces, one all-gone countdown');
  h.rejoin(2);
  check(h.clock.live.size === 2 + 3, 'one human back: its own grace and the all-gone countdown are gone for real (two clock timers and three graces remain)');
  disposeAll();
}
{
  // a spectate answer is exactly a room state
  const g = newGame();
  const state = g.mgr.spectate('W1', { roomId: g.id }).state;
  same(Object.keys(state).sort(), ['log', 'roomId', 'seats', 'seq', 'serverNowMs', 'state', 'timeControl', 'timeControlLabel'], 'a spectator\'s snapshot has exactly the room-state fields (and no seat of its own)');
  disposeAll();
}
{
  // W3a audit: the clamp in armClockTimers CAN act. The funnel reads the instant once, but the re-arm reads the clock again AFTER the broadcast; a broadcast that takes longer than a
  // running clock's remaining time (many sockets, a slow host) leaves that deadline behind the second read. Node 24 then prints a TimeoutNegativeWarning for a negative delay
  // (and treats it as 1 ms, as it treats 0), so the clamp is not dead code: every delay handed to the timers must stay >= 0.
  const clock = manualTimers();
  const io = stubIo();
  const slowTo = io.to;
  io.to = (id) => {
    const target = slowTo(id);
    return { emit: (event, payload) => { target.emit(event, payload); if (event === 'bug_state') clock.jump(70_000); } };
  };
  const g = newGame({ tc: TC1, clock, io });
  const before = clock.armed.length;
  const ack = g.mv(0, 'A', 'e2', 'e4');
  const rearmed = clock.armed.slice(before);
  check(ack.ok === true && rearmed.length >= 2 && rearmed.every((ms) => ms >= 0) && rearmed.includes(0), `a broadcast slower than the remaining time re-arms the clock timers with 0, never a negative delay (armed: ${rearmed.join(', ')})`);
  disposeAll();
}
{
  // W3a audit: the "no legal action" report of playBotTurn IS reachable by a white-box state (a verdict that says "playing" over a position with no move and no drop); the real engine
  // never produces one, but the report is the safety net for exactly that, so it must be an ERROR line (a mutant that only debug-logs it was labelled equivalent).
  const g = newGame({ kinds: ['human', 'bot', 'human', 'human'], chooseBotAction: () => null });
  const room = g.room();
  room.match = {
    ...room.match,
    boards: { ...room.match.boards, A: { ...room.match.boards.A, fen: '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1' } },
    verdicts: { ...room.match.verdicts, A: { status: 'playing', turn: 'b', inCheck: false, stuck: null } },
  };
  g.mgr.scheduleBots(room);
  const bot = room.botTimers.A;
  const errors = [];
  const original = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  g.clock.fire(bot.handle);
  console.error = original;
  check(errors.length === 2 && /returned no action/.test(errors[0]) && /seat 1 of room .* is on move with no legal action/.test(errors[1]), 'a bot seat with no action and no legal action is reported twice, as errors: the bot answered nothing, then nothing is legal');
  disposeAll();
}
{
  // the proofs behind the equivalent mutants
  const clocks = allArmedDelays();
  check(clocks.length > 100 && clocks.every((ms) => Number.isInteger(ms) && ms >= 0), `across every scenario of this script (${clocks.length} timers) no timer was ever armed with a negative delay (the clamp in armClockTimers acts only under a broadcast slower than a clock's remaining time: pinned in the block above)`);
  const live = E.createMatch({ timeControl: TC3, roomNumber: 0, startMs: 0 });
  const voided = E.voidMatch(live, 5);
  check(voided !== null && voided.result?.voided === true && E.voidMatch(voided, 6) === null && E.voidMatch(live, -1) === null, 'voidMatch answers null only for a finished match or an instant before the last one, and always sets a result otherwise');
}

console.log(`\nALL ${passed} CHECKS PASSED`);
