/**
 * Bughouse ONLINE - the matchmaker (src/game/bughouseMatchmaking.ts, workstream W2; BUGHOUSE_SPEC.md B11, B17, B20, HP11).
 *
 *   npm run test:bughouseMatchmaking        (tsx; no server, no database; an injected clock and timers)
 *
 * The matchmaker is driven with an injected `startGame` and `notify`, so every rule is checked to the millisecond: 2 humans wait the full fill time (measured from the moment the lobby
 * FIRST holds two), 3 get one bot, 4 start at once, dropping below 2 cancels the timer and re-reaching it restarts from zero, only the six time controls of B11 are accepted and they
 * never mix, one entry per socket, a failed start puts the humans back, the seats are assigned by a uniform shuffle (every placement proven reachable), and the SEAM for friend pairs
 * (HP11 / W6): a group of two is never split and the placement is one replaceable function.
 */
import assert from 'node:assert/strict';
import { BUG_BOT_ELO, BUG_BOT_NAME, BUG_FILL_WAIT_MS, BUG_MIN_HUMANS } from '../src/game/bughouseConfig.ts';
import { BughouseMatchmaker, placeGroups, shuffled } from '../src/game/bughouseMatchmaking.ts';
import { BUGHOUSE_TIME_CONTROLS } from '../src/game/bughouse/index.ts';
import { manualTimers } from './bughouse-test-kit.mjs';

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ok  ${message}`);
}

const TC = { initialMs: 180000, incrementMs: 0 };
const FILL = 30_000;

function setup({ fillWaitMs = FILL, randomInt, failStart = false } = {}) {
  const clock = manualTimers();
  const starts = [];
  const updates = [];
  const state = { failStart };
  const matchmaker = new BughouseMatchmaker({
    startGame: (seats, timeControl, label) => {
      if (state.failStart) throw new Error('boom');
      starts.push({ seats, timeControl, label, at: clock.now() });
    },
    notify: (socketId, update) => updates.push({ socketId, ...update, at: clock.now() }),
    fillWaitMs,
    timers: clock.timers,
    ...(randomInt ? { randomInt } : {}),
  });
  const entry = (n, tc = TC) => ({ socketId: `H${n}`, userId: n % 2 ? `u${n}` : null, name: `Human ${n}`, timeControl: tc });
  return { matchmaker, clock, starts, updates, state, entry, join: (n, tc) => matchmaker.join(entry(n, tc)) };
}
const humansOf = (start) => start.seats.filter((s) => s.kind === 'human').map((s) => s.socketId).sort();
const botsOf = (start) => start.seats.filter((s) => s.kind === 'bot');

console.log('\n=== 0. The numbers ===');
{
  check(BUG_MIN_HUMANS === 2 && BUG_FILL_WAIT_MS === 30_000 && BUG_BOT_ELO === 1200 && BUG_BOT_NAME === 'Bot (Amateur)', 'two humans minimum, a 30 s fill wait, Amateur (1200) bots named "Bot (Amateur)"');
  check(BUGHOUSE_TIME_CONTROLS.length === 6, 'the spec\'s six time controls (B11)');
}

console.log('\n=== 1. The lobby rules ===');
{
  const { matchmaker, starts, updates, join, clock } = setup();
  check(join(1).ok === true, 'one human joins');
  check(updates.length === 1 && updates[0].queued === 1 && updates[0].fillInMs === null, 'a lone human is told { queued: 1, fillInMs: null }: no timer');
  check(clock.live.size === 0, '...and no timer exists');
  clock.advance(3_600_000);
  check(starts.length === 0 && matchmaker.isQueued('H1'), 'a lone human waits indefinitely: an hour later nothing has started and it is still queued');
  matchmaker.leave('H1');
}
{
  const { matchmaker, starts, updates, join, clock } = setup();
  join(1);
  clock.advance(10_000);
  join(2);
  check(updates.at(-1).queued === 2 && updates.at(-1).fillInMs === 30_000, 'the second human starts the 30 s countdown FROM NOW (not from the first human\'s join): both are told fillInMs 30000');
  check(updates.filter((u) => u.at === clock.now()).length === 2, '...both queued humans were told');
  clock.advance(29_999);
  check(starts.length === 0, '29.999 s after the second human: nothing yet');
  clock.advance(1);
  check(starts.length === 1 && starts[0].at === clock.now(), 'at exactly 30 s the match starts');
  check(humansOf(starts[0]).join() === 'H1,H2' && botsOf(starts[0]).length === 2, '...with the two humans and two bots');
  check(starts[0].seats.length === 4 && botsOf(starts[0]).every((b) => b.name === 'Bot (Amateur)' && b.elo === 1200 && b.botReason === 'fill' && b.socketId === null), '...the bots are Amateur fill bots without a socket');
  check(starts[0].timeControl.initialMs === 180000 && starts[0].label === '3 min', '...and the time control and its label are passed on');
  check(matchmaker.size() === 0 && clock.live.size === 0, 'the lobby is empty and no timer is left');
}
{
  const { starts, join, clock } = setup();
  join(1);
  join(2);
  clock.advance(5_000);
  join(3);
  clock.advance(24_999);
  check(starts.length === 0, 'a third human does not restart the countdown (24.999 s after it joined, 29.999 s after the second)');
  clock.advance(1);
  check(starts.length === 1 && humansOf(starts[0]).join() === 'H1,H2,H3' && botsOf(starts[0]).length === 1, 'three humans and ONE bot start when the original countdown ends');
}
{
  const { starts, join, matchmaker, clock, updates } = setup();
  join(1);
  join(2);
  join(3);
  join(4);
  check(starts.length === 1 && starts[0].at === clock.now() && humansOf(starts[0]).length === 4 && botsOf(starts[0]).length === 0, 'the 4th human starts the match AT ONCE with four humans and no bot');
  check(clock.live.size === 0 && matchmaker.size() === 0, '...and cancels the countdown');
  join(5);
  check(updates.at(-1).queued === 1 && updates.at(-1).fillInMs === null, 'the next human starts a fresh lobby');
}
{
  const { starts, join, matchmaker, clock, updates } = setup();
  join(1);
  join(2);
  clock.advance(20_000);
  matchmaker.leave('H2');
  check(clock.live.size === 0 && updates.at(-1).queued === 1 && updates.at(-1).fillInMs === null, 'dropping below two cancels the countdown');
  clock.advance(60_000);
  check(starts.length === 0, '...and nothing starts');
  join(3);
  check(updates.at(-1).fillInMs === 30_000, 'reaching two again restarts it from ZERO (a full 30 s)');
  clock.advance(30_000);
  check(starts.length === 1 && humansOf(starts[0]).join() === 'H1,H3', '...and the match starts with who is there');
}

console.log('\n=== 2. Time controls: only the six, and they never mix ===');
{
  const { matchmaker, join, entry } = setup();
  const refused = [
    { initialMs: 600000, incrementMs: 0 },
    { initialMs: 180000, incrementMs: 1000 },
    { initialMs: 0, incrementMs: 0 },
    { initialMs: -1, incrementMs: 0 },
    { initialMs: 180000.5, incrementMs: 0 },
    { initialMs: '180000', incrementMs: 0 },
    { initialMs: 180000 },
    null,
    undefined,
    5,
    'No time limit',
    { initialSeconds: 180, incrementSeconds: 0 },
  ];
  for (const tc of refused) {
    const ack = matchmaker.join({ ...entry(9), timeControl: tc });
    assert.ok(ack.ok === false && ack.reason === 'invalidRequest', `time control ${JSON.stringify(tc)} must be refused`);
  }
  passed++;
  console.log(`  ok  ${refused.length} time controls outside the six (a free-form one, "No time limit", seconds instead of ms, junk) are refused and none queues the socket`);
  check(matchmaker.size() === 0, '...the queue is empty');
  for (const [i, tc] of BUGHOUSE_TIME_CONTROLS.entries()) check(join(10 + i, tc).ok === true, `${tc.initialMs / 1000} s + ${tc.incrementMs / 1000} s is accepted`);
}
{
  const { matchmaker, starts, join, clock } = setup();
  join(1, BUGHOUSE_TIME_CONTROLS[0]);
  join(2, BUGHOUSE_TIME_CONTROLS[2]);
  join(3, BUGHOUSE_TIME_CONTROLS[0]);
  check(matchmaker.lobbySize(BUGHOUSE_TIME_CONTROLS[0]) === 2 && matchmaker.lobbySize(BUGHOUSE_TIME_CONTROLS[2]) === 1 && matchmaker.lobbySize(BUGHOUSE_TIME_CONTROLS[1]) === 0, 'lobbies are per time control');
  clock.advance(30_000);
  check(starts.length === 1 && starts[0].timeControl.initialMs === 60000 && humansOf(starts[0]).join() === 'H1,H3', 'only the lobby with two humans started, with its own time control, and the lone human of 3 min is still queued');
  check(matchmaker.isQueued('H2'), '...a human of another time control is never pulled in');
  const same = BUGHOUSE_TIME_CONTROLS.filter((tc) => tc.initialMs === 180000);
  check(same.length === 2 && same[0].incrementMs !== same[1].incrementMs, '3 min and 3 | 2 are different time controls (different lobbies)');
  join(4, same[0]);
  join(5, same[1]);
  check(matchmaker.lobbySize(same[0]) === 2 && matchmaker.lobbySize(same[1]) === 1, '...three humans queued over the two 3-minute controls: 2 and 1, not mixed');
}

console.log('\n=== 3. One entry per socket ===');
{
  const { matchmaker, join, entry } = setup();
  join(1);
  const again = join(1);
  check(again.ok === false && /already in a queue/.test(again.error) && matchmaker.size() === 1, 'a socket already queued cannot queue again');
  const other = matchmaker.join({ ...entry(1), timeControl: BUGHOUSE_TIME_CONTROLS[0] });
  check(other.ok === false && matchmaker.size() === 1, '...also not for another time control');
  check(matchmaker.leave('H1') === true && matchmaker.leave('H1') === false && matchmaker.size() === 0, 'leaving is idempotent: the second leave is a no-op');
}

console.log('\n=== 4. A failed start puts the humans back ===');
{
  const { matchmaker, starts, join, clock, state, updates } = setup({ failStart: true });
  const originalError = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  join(1);
  join(2);
  clock.advance(30_000);
  console.error = originalError;
  check(starts.length === 0 && matchmaker.isQueued('H1') && matchmaker.isQueued('H2') && matchmaker.size() === 2, 'the start threw: both humans are back in the queue, not lost');
  check(logged.length === 1 && /starting a match/.test(logged[0]), '...and it was logged once');
  check(updates.at(-1).queued === 2 && updates.at(-1).fillInMs === 30_000, '...with a fresh countdown they are told about');
  state.failStart = false;
  clock.advance(30_000);
  check(starts.length === 1 && humansOf(starts[0]).join() === 'H1,H2', 'the countdown runs again and the match starts');
}

console.log('\n=== 5. Seats: a uniform shuffle (B20) - every placement is reachable ===');
{
  const perms = new Set();
  const seen = new Set();
  // enumerate every output of the Fisher-Yates over 4 items: the random source is driven through all 24 sequences
  for (let a = 0; a < 4; a++) for (let b = 0; b < 3; b++) for (let c = 0; c < 2; c++) {
    const script = [a, b, c];
    let k = 0;
    const out = shuffled(['h1', 'h2', 'b1', 'b2'], () => script[k++]);
    perms.add(out.join());
    out.forEach((item, seat) => seen.add(`${item}@${seat}`));
  }
  check(perms.size === 24, 'the shuffle reaches all 24 orders of four seats');
  check([...seen].filter((s) => s.startsWith('h1@')).length === 4, '...so a human can land on every seat, including the first');
  const calls = [];
  const placed = placeGroups([{ members: [{ socketId: 'a', name: 'A' }] }, { members: [{ socketId: 'b', name: 'B' }] }], (n) => (calls.push(n), 0));
  check(calls.join() === '4,3,2' && placed.length === 4, 'placeGroups draws randomInt(4), (3), (2): a Fisher-Yates over four seats');
  const { starts, join, clock } = setup({ randomInt: (n) => n - 1 });
  join(1);
  join(2);
  clock.advance(30_000);
  check(starts[0].seats.map((s) => s.kind).join() === 'human,human,bot,bot', 'the injected random source decides the order (n - 1 each time swaps nothing: the humans keep the first two seats)');
  const { starts: reversed, join: join2, clock: clock2 } = setup({ randomInt: () => 0 });
  join2(1);
  join2(2);
  clock2.advance(30_000);
  check(reversed[0].seats.map((s) => s.kind).join() === 'human,bot,bot,human' && reversed[0].seats[0].socketId === 'H2' && reversed[0].seats[3].socketId === 'H1', 'randomInt = 0 each time gives another, fixed placement (H2, bot, bot, H1)');
}
{
  // statistically, with the real crypto source: each human lands on each seat about a quarter of the time
  const clock = manualTimers();
  const counts = { 0: [0, 0, 0, 0], 1: [0, 0, 0, 0] };
  const matchmaker = new BughouseMatchmaker({
    startGame: (seats) => seats.forEach((s, i) => s.socketId === 'H1' && counts[0][i]++, seats.forEach((s, i) => s.socketId === 'H2' && counts[1][i]++)),
    notify() {},
    timers: clock.timers,
    fillWaitMs: 1000,
  });
  const N = 2000;
  for (let i = 0; i < N; i++) {
    matchmaker.join({ socketId: 'H1', userId: null, name: 'a', timeControl: TC });
    matchmaker.join({ socketId: 'H2', userId: null, name: 'b', timeControl: TC });
    clock.advance(1000);
  }
  const fair = [...counts[0], ...counts[1]].every((n) => n > N * 0.2 && n < N * 0.3);
  check(fair, `with the default (crypto) source each human lands on each seat about a quarter of the time (${counts[0].join('/')} and ${counts[1].join('/')} of ${N})`);
}

console.log('\n=== 6. The seam for friend pairs (HP11, W6): a group is never split ===');
{
  const { matchmaker, starts, clock } = setup();
  const e = (n) => ({ socketId: `P${n}`, userId: null, name: `P${n}`, timeControl: TC });
  check(matchmaker.joinGroup([e(1), e(2)]).ok === true && matchmaker.size() === 2, 'a pair enters the queue as one group (two humans queued)');
  check(clock.live.size === 1, '...and two humans already start the fill countdown');
  matchmaker.join(e(3));
  matchmaker.join(e(4));
  check(starts.length === 1 && humansOf(starts[0]).join() === 'P1,P2,P3,P4', 'pair + two solos: four humans start at once');
}
{
  const { matchmaker, starts, clock, updates } = setup();
  const e = (n) => ({ socketId: `P${n}`, userId: null, name: `P${n}`, timeControl: TC });
  matchmaker.join(e(1));
  matchmaker.join(e(2));
  matchmaker.join(e(3));
  matchmaker.joinGroup([e(4), e(5)]);
  check(starts.length === 1 && humansOf(starts[0]).join() === 'P1,P2,P3' && botsOf(starts[0]).length === 1, 'three solos then a pair: the match starts with the three solos and a bot - the pair is NOT split to fill the fourth seat');
  check(matchmaker.isQueued('P4') && matchmaker.isQueued('P5') && matchmaker.size() === 2, '...the pair stays queued together');
  check(updates.at(-1).queued === 2 && updates.at(-1).fillInMs === 30_000, '...with a fresh countdown (two humans)');
  matchmaker.leave('P4');
  check(matchmaker.isQueued('P5') && matchmaker.size() === 1 && clock.live.size === 0, 'one member of a pair leaving leaves the other queued alone (W6 decides what a broken pair means); the countdown stops');
}
{
  const { matchmaker } = setup();
  const e = (n, tc = TC) => ({ socketId: `P${n}`, userId: null, name: `P${n}`, timeControl: tc });
  check(matchmaker.joinGroup([e(1), e(2, BUGHOUSE_TIME_CONTROLS[0])]).ok === false, 'a group whose members asked for different time controls is refused');
  check(matchmaker.joinGroup([e(1), e(1)]).ok === false, 'a group of the same socket twice is refused');
  matchmaker.join(e(5));
  check(matchmaker.joinGroup([e(5), e(6)]).ok === false && !matchmaker.isQueued('P6'), 'a group with an already-queued member is refused whole: nobody of it is queued');
  check(matchmaker.joinGroup([]).ok === false && matchmaker.joinGroup([e(7), e(8), e(9)]).ok === false, 'a group has one or two members');
}

console.log('\n=== 7. More pins ===');
{
  // a third human is told the time that is LEFT, not a fresh countdown
  const { join, updates, clock } = setup();
  join(1);
  join(2);
  clock.advance(5_000);
  join(3);
  const last = updates.filter((u) => u.socketId === 'H3').at(-1);
  check(last.queued === 3 && last.fillInMs === 25_000, 'a third human joining 5 s into the countdown is told 25 s are left');
  check(updates.filter((u) => u.at === clock.now() && u.queued === 3).map((u) => u.socketId).sort().join() === 'H1,H2,H3', '...and so are the two who were already waiting');
}
{
  // two solos and a pair fill exactly four: they start at once, nobody is left behind
  const { matchmaker, starts, clock } = setup();
  const e = (n) => ({ socketId: `P${n}`, userId: null, name: `P${n}`, timeControl: TC });
  matchmaker.join(e(1));
  matchmaker.join(e(2));
  matchmaker.joinGroup([e(3), e(4)]);
  check(starts.length === 1 && starts[0].at === clock.now() && humansOf(starts[0]).join() === 'P1,P2,P3,P4' && matchmaker.size() === 0, 'two solos and a pair make exactly four: the match starts at once with all four and the queue is empty');
}
{
  // a failed start with humans queued behind it: the taken humans go back to the FRONT, in their order
  const { matchmaker, starts, state, clock } = setup({ failStart: true });
  const original = console.error;
  console.error = () => {};
  const e = (n) => ({ socketId: `P${n}`, userId: null, name: `P${n}`, timeControl: TC });
  matchmaker.join(e(1));
  matchmaker.join(e(2));
  matchmaker.join(e(3));
  matchmaker.joinGroup([e(4), e(5)]);
  console.error = original;
  check(starts.length === 0 && matchmaker.size() === 5, 'a start that fails with a pair queued behind it loses nobody');
  state.failStart = false;
  clock.advance(30_000);
  check(humansOf(starts[0]).join() === 'P1,P2,P3' && matchmaker.isQueued('P4') && matchmaker.isQueued('P5'), '...the three go back in FRONT of the pair: the next start takes the same three, the pair is still behind');
}
{
  // callbacks that outlive their lobby start nothing (white-box, the way a late timer would call)
  const { matchmaker, starts, join, clock } = setup();
  join(1);
  join(2);
  const lobby = [...matchmaker.lobbies.values()][0];
  matchmaker.leave('H2'); // below two: the timer is cleared and the lobby shrinks
  matchmaker.onFillTimer(lobby);
  check(starts.length === 0 && matchmaker.isQueued('H1'), 'a fill callback for a lobby that dropped below two humans starts nothing');
  matchmaker.leave('H1'); // the lobby is gone from the map
  matchmaker.onFillTimer(lobby);
  check(starts.length === 0 && matchmaker.size() === 0 && clock.live.size === 0, '...nor does one for a lobby that no longer exists');
}
{
  // placeGroups: bots fill what the humans leave
  const members = (n) => ({ members: Array.from({ length: n }, (_, i) => ({ socketId: `H${i}`, name: `h${i}` })) });
  for (const humans of [1, 2, 3, 4]) {
    const placed = placeGroups([members(humans)], (n) => n - 1);
    check(placed.filter((s) => s.kind === 'human').length === humans && placed.filter((s) => s.kind === 'bot').length === 4 - humans && placed.length === 4, `${humans} human(s): ${4 - humans} bot(s) fill the table`);
  }
  const bot = placeGroups([members(1)], (n) => n - 1).find((s) => s.kind === 'bot');
  check(bot.name === 'Bot (Amateur)' && bot.elo === 1200 && bot.botReason === 'fill' && bot.socketId === null, 'a fill bot is named, rated and marked as the table expects');
}

console.log('\n=== 8. Survivors of the first mutation run, killed ===');
{
  // an emptied lobby is removed (by a leave, and by a start)
  const { matchmaker, join, clock, starts } = setup();
  join(1);
  check(matchmaker.lobbies.size === 1, 'one lobby after one join');
  matchmaker.leave('H1');
  check(matchmaker.lobbies.size === 0 && matchmaker.socketToKey.size === 0, 'the only human leaving removes the lobby (and every key)');
  join(2);
  join(3);
  clock.advance(30_000);
  check(starts.length === 1 && matchmaker.lobbies.size === 0 && matchmaker.socketToKey.size === 0, 'a start that takes everybody removes the lobby');
  // a leave inside a pair removes the empty group only when the whole group is gone
  const e = (n) => ({ socketId: `P${n}`, userId: null, name: `P${n}`, timeControl: TC });
  matchmaker.joinGroup([e(4), e(5)]);
  matchmaker.leave('P4');
  const lobby = [...matchmaker.lobbies.values()][0];
  check(lobby.groups.length === 1 && lobby.groups[0].members.length === 1, 'one member of a pair leaving leaves a group of one');
  matchmaker.leave('P5');
  check(matchmaker.lobbies.size === 0, '...and the last member leaving removes the lobby (an empty group is not kept)');
}
{
  // a fill callback of a lobby that is no longer THE lobby of its key starts nothing, however many humans it still lists
  const { matchmaker, starts, join, clock } = setup();
  join(1);
  join(2);
  const real = [...matchmaker.lobbies.values()][0];
  const stale = { ...real, groups: [...real.groups], timer: null };
  matchmaker.onFillTimer(stale);
  check(starts.length === 0 && matchmaker.isQueued('H1') && matchmaker.isQueued('H2'), 'a callback for a copy of the lobby (not the one in the map) starts nothing');
  clock.advance(30_000);
  check(starts.length === 1, '...and the real lobby\'s own timer still starts the match');
}
{
  // the label travels with the time control that started
  const { starts, join, clock } = setup();
  join(1, { initialMs: 300000, incrementMs: 2000 });
  join(2, { initialMs: 300000, incrementMs: 2000 });
  clock.advance(30_000);
  check(starts[0].label === '5 | 2' && starts[0].timeControl.initialMs === 300000 && starts[0].timeControl.incrementMs === 2000, 'a 5 | 2 lobby starts a 5 | 2 match labelled "5 | 2"');
  const other = setup();
  other.join(1, { initialMs: 60000, incrementMs: 0 });
  other.join(2, { initialMs: 60000, incrementMs: 0 });
  other.clock.advance(30_000);
  check(other.starts[0].label === '1 min' && other.starts[0].timeControl.initialMs === 60000, 'a 1-minute lobby starts a 1-minute match labelled "1 min"');
}
{
  // a failed start tells the humans again, at the moment it failed
  const { matchmaker, updates, state, clock } = setup({ failStart: true });
  const originalError = console.error;
  console.error = () => {};
  const e = (n) => ({ socketId: `P${n}`, userId: null, name: `P${n}`, timeControl: TC });
  matchmaker.join(e(1));
  matchmaker.join(e(2));
  clock.advance(30_000);
  console.error = originalError;
  const told = updates.filter((u) => u.at === clock.now());
  check(told.length === 2 && told.every((u) => u.queued === 2 && u.fillInMs === 30_000), 'at the moment the start failed both humans were told again (queued 2, a fresh 30 s countdown)');
  void state;
}

console.log(`\nALL ${passed} CHECKS PASSED`);
