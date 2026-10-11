/**
 * 4 Player Chess ONLINE - the matchmaker (src/game/fourPlayerMatchmaking.ts, workstream W4).
 *
 *   npm run test:fourplayerMatchmaking        (tsx; no server, no database; Node fake timers + Date)
 *
 * The matchmaker is driven with an injected `startGame` and `notify`, so every rule can be checked to the millisecond: 2 humans wait the
 * full fill time (measured from the moment the lobby FIRST holds two), 3 get one bot, 4 start at once, dropping below 2 cancels the timer
 * and re-reaching it restarts from zero, time controls never mix, "No time limit" and Daily are refused, one entry per socket, a failed
 * start puts the humans back, seats are assigned by a uniform shuffle (every permutation proven reachable, the default RNG checked
 * statistically), and every timer is accounted for.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mock } from 'node:test';
import { FOUR_BOT_ELO, FOUR_BOT_NAME, FOUR_FILL_WAIT_MAX_OVERRIDE_MS, FOUR_FILL_WAIT_MS, FOUR_MIN_HUMANS, resolveFourFillWaitMs } from '../src/game/fourPlayerConfig.ts';
import { FourPlayerMatchmaker, shuffled } from '../src/game/fourPlayerMatchmaking.ts';
import { startFakeTimers } from './fourplayer-test-kit.mjs';

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ok  ${message}`);
}
const { liveTimeouts } = startFakeTimers();

const TC = { initialSeconds: 600, incrementSeconds: 0 };

/** A matchmaker with recorded starts and updates. `humans(n)` makes entries for sockets H1..Hn. */
function setup({ fillWaitMs, randomInt, failStart = false } = {}) {
  const starts = [];
  const updates = [];
  const state = { failStart };
  const matchmaker = new FourPlayerMatchmaker({
    startGame: (seats, timeControl, label) => {
      if (state.failStart) throw new Error('boom');
      starts.push({ seats, timeControl, label, at: Date.now() });
    },
    notify: (socketId, update) => updates.push({ socketId, ...update, at: Date.now() }),
    ...(fillWaitMs ? { fillWaitMs } : {}),
    ...(randomInt ? { randomInt } : {}),
  });
  const entry = (n, tc = TC, label) => ({ socketId: `H${n}`, userId: n % 2 ? `u${n}` : null, name: `Human ${n}`, timeControl: tc, ...(label ? { timeControlLabel: label } : {}) });
  return { matchmaker, starts, updates, state, entry, join: (n, tc, label) => matchmaker.join(entry(n, tc, label)) };
}
const humansOf = (start) => start.seats.filter((s) => s.kind === 'human').map((s) => s.socketId).sort();
const botsOf = (start) => start.seats.filter((s) => s.kind === 'bot');

console.log('\n=== 0. The numbers, and the dev/test override of the fill wait ===');
{
  check(FOUR_MIN_HUMANS === 2 && FOUR_FILL_WAIT_MS === 30_000 && FOUR_BOT_ELO === 1200 && FOUR_BOT_NAME === 'Bot (Amateur)', 'two humans minimum, a 30 s fill wait, Amateur (1200) bots named "Bot (Amateur)"');
  check(resolveFourFillWaitMs({}) === 30_000 && resolveFourFillWaitMs({ NODE_ENV: 'production' }) === 30_000, 'no override: 30 s (also in production)');
  check(resolveFourFillWaitMs({ FOUR_FILL_MS: '3000' }) === 3000 && resolveFourFillWaitMs({ FOUR_FILL_MS: '3000', NODE_ENV: 'development' }) === 3000 && resolveFourFillWaitMs({ FOUR_FILL_MS: '3000', NODE_ENV: 'test' }) === 3000, 'FOUR_FILL_MS is honoured when NODE_ENV is unset, development or test');
  check(resolveFourFillWaitMs({ FOUR_FILL_MS: '3000', NODE_ENV: 'production' }) === 30_000, '...but NEVER in production (a misconfigured box cannot shorten the wait)');
  check(resolveFourFillWaitMs({ FOUR_FILL_MS: '1' }) === 1 && resolveFourFillWaitMs({ FOUR_FILL_MS: String(FOUR_FILL_WAIT_MAX_OVERRIDE_MS) }) === FOUR_FILL_WAIT_MAX_OVERRIDE_MS, 'the accepted range is 1 ms .. 600000 ms, boundaries included');
  for (const bad of ['0', '-5', '1.5', '600001', '3000000', 'abc', '', ' 3000', '3e3', '0x10', 'Infinity', 'NaN']) {
    assert.equal(resolveFourFillWaitMs({ FOUR_FILL_MS: bad }), 30_000, `FOUR_FILL_MS=${JSON.stringify(bad)} must be ignored`);
  }
  passed++;
  console.log('  ok  anything else (0, negative, fractional, too large, text, hex, exponent, empty) is ignored: the default 30 s');
  const defaultWait = new FourPlayerMatchmaker({ startGame() {}, notify() {} });
  defaultWait.join({ socketId: 'D1', userId: null, name: 'd1', timeControl: TC });
  defaultWait.join({ socketId: 'D2', userId: null, name: 'd2', timeControl: TC });
  check(liveTimeouts.size === 1, 'a matchmaker built with no options arms its fill timer (the default wait comes from resolveFourFillWaitMs)');
  defaultWait.leave('D1');
  defaultWait.leave('D2');
}

console.log('\n=== 1. The lobby rules ===');
{
  const { matchmaker, starts, updates, join } = setup();
  check(join(1).ok === true, 'one human joins');
  check(updates.length === 1 && updates[0].queued === 1 && updates[0].fillInMs === null, 'a lone human is told { queued: 1, fillInMs: null }: no timer');
  check(liveTimeouts.size === 0, '...and no timer exists');
  mock.timers.tick(3_600_000);
  check(starts.length === 0 && matchmaker.isQueued('H1'), 'a lone human waits indefinitely: an hour later nothing has started and it is still queued');
  matchmaker.leave('H1');
}
{
  const { matchmaker, starts, updates, join } = setup();
  join(1);
  updates.length = 0;
  join(2);
  check(updates.length === 2 && updates.every((u) => u.queued === 2 && u.fillInMs === 30_000), 'the second human starts the timer: BOTH get { queued: 2, fillInMs: 30000 }');
  check(liveTimeouts.size === 1, '...one timer');
  mock.timers.tick(29_999);
  check(starts.length === 0, 'at 29.999 s nothing has started');
  mock.timers.tick(1);
  check(starts.length === 1 && starts[0].seats.length === 4, 'at 30 s a game starts');
  check(JSON.stringify(humansOf(starts[0])) === '["H1","H2"]' && botsOf(starts[0]).length === 2, 'two humans and two bots: the two bots fill the empty seats');
  check(botsOf(starts[0]).every((b) => b.name === 'Bot (Amateur)' && b.elo === 1200 && b.botReason === 'fill' && b.socketId === null), 'the bots are Amateur (1200), reason "fill", named "Bot (Amateur)"');
  check(starts[0].seats.filter((s) => s.kind === 'human').map((s) => s.name).sort().join() === 'Human 1,Human 2', 'the humans keep the names they queued with');
  check(starts[0].timeControl.initialSeconds === 600 && starts[0].timeControl.incrementSeconds === 0, 'the game gets the lobby\'s time control');
  check(!matchmaker.isQueued('H1') && !matchmaker.isQueued('H2') && matchmaker.size() === 0 && liveTimeouts.size === 0, 'both are out of the queue and no timer is left');
  const before = updates.length;
  mock.timers.tick(60_000);
  check(updates.length === before && starts.length === 1, 'nothing more is sent or started afterwards');
}
{
  // The 30 s run from the moment the lobby FIRST holds two humans - not from each player's own join.
  const { starts, join } = setup();
  join(1); // t = 0: alone
  mock.timers.tick(20_000);
  join(2); // t = 20 s: the lobby holds two - the countdown starts NOW
  mock.timers.tick(29_999);
  check(starts.length === 0, 'H1 waited alone for 20 s, then H2 joined: at 49.999 s (30 s minus 1 ms after H2) nothing has started');
  mock.timers.tick(1);
  check(starts.length === 1 && starts[0].at === Date.now(), '...the game starts 30 s after the lobby reached two (t = 50 s), not 30 s after H1\'s own join (t = 30 s)');
}
{
  // Three humans: one bot. The third does not restart the timer.
  const { updates, starts, join } = setup();
  join(1);
  join(2); // t = 0: countdown starts
  mock.timers.tick(10_000);
  updates.length = 0;
  join(3);
  check(updates.length === 3 && updates.every((u) => u.queued === 3 && u.fillInMs === 20_000), 'a third human at +10 s: all three are told { queued: 3, fillInMs: 20000 } - the countdown was not restarted');
  mock.timers.tick(19_999);
  check(starts.length === 0, '...nothing at 29.999 s');
  mock.timers.tick(1);
  check(starts.length === 1 && JSON.stringify(humansOf(starts[0])) === '["H1","H2","H3"]' && botsOf(starts[0]).length === 1, 'at 30 s: three humans and exactly ONE bot');
}
{
  // The fourth starts at once.
  const { updates, starts, join, matchmaker } = setup();
  join(1);
  join(2);
  join(3);
  mock.timers.tick(5_000);
  updates.length = 0;
  join(4);
  check(starts.length === 1 && JSON.stringify(humansOf(starts[0])) === '["H1","H2","H3","H4"]' && botsOf(starts[0]).length === 0, 'the fourth human starts the game AT ONCE: four humans, no bots');
  check(updates.length === 0 && liveTimeouts.size === 0 && matchmaker.size() === 0, '...with no queue update (the match is found instead), the timer cancelled and nobody left in the queue');
  mock.timers.tick(60_000);
  check(starts.length === 1, 'and the cancelled timer never starts a second game');
}
{
  // Dropping below two cancels the timer; reaching two again starts it from ZERO.
  const { updates, starts, join, matchmaker } = setup();
  join(1);
  join(2); // t = 0
  mock.timers.tick(10_000);
  updates.length = 0;
  check(matchmaker.leave('H2') === true, 'H2 leaves at +10 s');
  check(updates.length === 1 && updates[0].socketId === 'H1' && updates[0].queued === 1 && updates[0].fillInMs === null, 'the remaining human is told { queued: 1, fillInMs: null }');
  check(liveTimeouts.size === 0, '...and the timer is cancelled');
  mock.timers.tick(3_600_000);
  check(starts.length === 0, 'nothing starts for a lone human');
  join(3);
  mock.timers.tick(29_999);
  check(starts.length === 0, 'a new second human: the countdown starts from ZERO (29.999 s later nothing)');
  mock.timers.tick(1);
  check(starts.length === 1 && JSON.stringify(humansOf(starts[0])) === '["H1","H3"]', '...and the game starts 30 s after THAT');
}
{
  const { starts, join, matchmaker } = setup();
  join(1);
  join(2);
  mock.timers.tick(20_000);
  matchmaker.leave('H2');
  mock.timers.tick(5_000);
  join(2); // t = 25 s
  mock.timers.tick(29_999);
  check(starts.length === 0, 'H2 leaves at +20 s and comes back at +25 s: nothing at 54.999 s (not the old 30 s)');
  mock.timers.tick(1);
  check(starts.length === 1, '...the game starts at 55 s: a full 30 s after the lobby re-reached two');
}
{
  const { matchmaker, updates, join } = setup();
  check(matchmaker.leave('NOBODY') === false, 'leaving when not queued is a harmless no-op that returns false');
  join(1);
  join(2);
  join(3);
  updates.length = 0;
  matchmaker.leave('H2');
  check(updates.length === 2 && updates.every((u) => u.queued === 2) && updates.every((u) => u.socketId !== 'H2'), 'a leave updates everyone who is left (not the leaver)');
  matchmaker.leave('H1');
  matchmaker.leave('H3');
  check(matchmaker.size() === 0 && matchmaker.lobbySize(TC) === 0 && liveTimeouts.size === 0, 'an emptied lobby is gone: nobody queued, no timer');
}

console.log('\n=== 2. Time controls never mix, and only live ones are accepted ===');
{
  const A = { initialSeconds: 300, incrementSeconds: 0 };
  const B = { initialSeconds: 300, incrementSeconds: 2 };
  const C = { initialSeconds: 600, incrementSeconds: 0 };
  const { starts, join, matchmaker } = setup();
  join(1, A);
  join(2, A);
  join(3, B);
  join(4, C);
  check(matchmaker.lobbySize(A) === 2 && matchmaker.lobbySize(B) === 1 && matchmaker.lobbySize(C) === 1, 'three time controls make three lobbies (300+0, 300+2 and 600+0 are all different)');
  check(liveTimeouts.size === 1, 'only the lobby with two humans has a timer');
  mock.timers.tick(30_000);
  check(starts.length === 1 && JSON.stringify(humansOf(starts[0])) === '["H1","H2"]' && starts[0].timeControl.initialSeconds === 300 && starts[0].timeControl.incrementSeconds === 0, 'only the 300+0 lobby starts; the lone humans in the others keep waiting');
  join(5, B);
  mock.timers.tick(30_000);
  check(starts.length === 2 && JSON.stringify(humansOf(starts[1])) === '["H3","H5"]' && starts[1].timeControl.incrementSeconds === 2, 'a second human at 300+2 starts THAT lobby (with the increment)');
  const label = setup();
  label.join(1, TC, 'ten minutes');
  label.join(2, TC, 'other label');
  mock.timers.tick(30_000);
  check(label.starts[0].label === 'ten minutes', 'one lobby per time control, whatever the labels: the first entry\'s label is used');
  label.join(3, TC);
  label.join(4, TC);
  mock.timers.tick(30_000);
  check(label.starts[1].label === undefined, '...and no label at all is passed on as undefined (the manager makes one)');
}
{
  const { matchmaker, updates, join } = setup();
  const bad = [
    [{ initialSeconds: 0, incrementSeconds: 0 }, 'No time limit'],
    [{ initialSeconds: 86_400, incrementSeconds: 0 }, 'Daily'],
    [{ initialSeconds: 59, incrementSeconds: 0 }, 'below the range'],
    [{ initialSeconds: 3601, incrementSeconds: 0 }, 'above the range'],
    [{ initialSeconds: 600, incrementSeconds: 31 }, 'increment too large'],
    [{ initialSeconds: 600, incrementSeconds: -1 }, 'negative increment'],
    [{ initialSeconds: 600.5, incrementSeconds: 0 }, 'fractional'],
    [{ initialSeconds: NaN, incrementSeconds: 0 }, 'NaN'],
    [null, 'null'],
    ['600', 'a string'],
  ];
  for (const [tc, what] of bad) {
    const res = join(1, tc);
    assert.equal(res.ok, false, `${what} is refused`);
    assert.ok(typeof res.error === 'string' && res.error.length > 0, `${what}: an error message`);
  }
  passed++;
  console.log(`  ok  ${bad.length} unacceptable time controls (No time limit, Daily, out of range, bad increments, NaN, junk) are refused with a message`);
  check(matchmaker.size() === 0 && updates.length === 0 && liveTimeouts.size === 0, '...and a refusal changes nothing: nobody queued, nothing sent, no timer');
  check(join(1, { initialSeconds: 60, incrementSeconds: 0 }).ok && join(2, { initialSeconds: 3600, incrementSeconds: 30 }).ok, 'the boundaries themselves (60 s + 0, 3600 s + 30) are accepted');
}
{
  const { matchmaker, join } = setup();
  join(1);
  const again = join(1);
  check(again.ok === false && /already in a queue/.test(again.error), 'a socket already queued cannot queue again (same time control)');
  const other = join(1, { initialSeconds: 300, incrementSeconds: 0 });
  check(other.ok === false && matchmaker.lobbySize({ initialSeconds: 300, incrementSeconds: 0 }) === 0 && matchmaker.lobbySize(TC) === 1, '...nor in another lobby: one entry per socket across ALL lobbies, and the first entry stays');
  matchmaker.leave('H1');
  check(join(1, { initialSeconds: 300, incrementSeconds: 0 }).ok, 'after leaving it can queue anywhere');
}

console.log('\n=== 3. A failed start puts the humans back ===');
{
  const { matchmaker, starts, updates, state, join } = setup({ failStart: true });
  const realError = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  join(1);
  join(2);
  join(3);
  updates.length = 0;
  mock.timers.tick(30_000);
  console.error = realError;
  check(starts.length === 0 && matchmaker.size() === 3 && matchmaker.lobbySize(TC) === 3, 'startGame throws: all three humans are STILL queued (a bug never eats a lobby)');
  check(logged.length === 1 && /failed/.test(logged[0]), '...and the failure is logged once');
  check(updates.length === 3 && updates.every((u) => u.queued === 3 && u.fillInMs === 30_000) && liveTimeouts.size === 1, '...the lobby is told its state again and the fill timer is re-armed (it will retry)');
  state.failStart = false;
  mock.timers.tick(30_000);
  check(starts.length === 1 && JSON.stringify(humansOf(starts[0])) === '["H1","H2","H3"]' && botsOf(starts[0]).length === 1, 'when starting works again the retry starts the game with the same three humans');
  check(matchmaker.size() === 0 && liveTimeouts.size === 0, '...and the queue is empty');
}
{
  // After a failed start the humans are back in the queue IN ORDER and complete a later game together. (A restore happens synchronously, so nobody can
  // be in the lobby while it runs: putting them at the front rather than the back is a safeguard that no test can observe.)
  const { matchmaker, state, join, starts } = setup({ failStart: true });
  const realError = console.error;
  console.error = () => {};
  join(1);
  join(2);
  mock.timers.tick(30_000);
  console.error = realError;
  join(3);
  state.failStart = false;
  join(4); // the lobby now holds H1 H2 H3 H4 -> an immediate start of the first four, in queue order
  check(starts.length === 1 && JSON.stringify(humansOf(starts[0])) === '["H1","H2","H3","H4"]' && matchmaker.size() === 0, 'the restored humans are still queued in order: H1 and H2 are in the game that H3 and H4 complete');
}

console.log('\n=== 4. Seat assignment is a uniform shuffle ===');
{
  // Every permutation is reachable: drive Fisher-Yates through EVERY sequence of choices.
  const seen = new Set();
  for (let a = 0; a < 4; a++) {
    for (let b = 0; b < 3; b++) {
      for (let c = 0; c < 2; c++) {
        const choices = [a, b, c];
        seen.add(JSON.stringify(shuffled(['A', 'B', 'C', 'D'], () => choices.shift())));
      }
    }
  }
  check(seen.size === 24, 'shuffled(): the 24 sequences of random choices give 24 DIFFERENT orders - every permutation of four seats is reachable');
  const identity = shuffled([1, 2, 3, 4], (n) => n - 1);
  check(JSON.stringify(identity) === '[1,2,3,4]', 'and the "no swap" choice (always the last index) leaves the order unchanged');
  const input = ['x', 'y', 'z'];
  shuffled(input, () => 0);
  check(JSON.stringify(input) === '["x","y","z"]', 'the input array is not modified');
  const arrangements = new Set();
  for (let a = 0; a < 4; a++) {
    for (let b = 0; b < 3; b++) {
      for (let c = 0; c < 2; c++) {
        const choices = [a, b, c];
        const { starts, join } = setup({ randomInt: () => choices.shift() });
        join(1);
        join(2);
        mock.timers.tick(30_000);
        arrangements.add(starts[0].seats.map((s) => (s.kind === 'bot' ? 'bot' : s.socketId)).join());
      }
    }
  }
  check(arrangements.size === 12, 'through the matchmaker: 2 humans + 2 bots reach all 12 distinct arrangements of the four seats');
}
{
  // The default RNG (crypto): over many starts each human lands on each seat about equally often.
  const N = 2400;
  const seatOfH1 = [0, 0, 0, 0];
  const humanInRed = { count: 0 };
  for (let i = 0; i < N; i++) {
    const { starts, join } = setup();
    join(1);
    join(2);
    mock.timers.tick(30_000);
    seatOfH1[starts[0].seats.findIndex((s) => s.socketId === 'H1')]++;
    if (starts[0].seats[0].kind === 'human') humanInRed.count++;
  }
  const expected = N / 4;
  check(seatOfH1.every((n) => Math.abs(n - expected) < 150), `with the default (crypto) RNG one human lands on each seat about equally often over ${N} games: ${seatOfH1.join(', ')} (each ~${expected}, tolerance 150 = 7 sigma)`);
  check(Math.abs(humanInRed.count - N / 2) < 150, `...and Red (who moves first) goes to a human in ${humanInRed.count} of ${N} games (expected ${N / 2}): the bots get no systematic advantage`);
}
{
  const src = fs.readFileSync(new URL('../src/game/fourPlayerMatchmaking.ts', import.meta.url), 'utf8').split('\r\n').join('\n');
  check(!/Math\.random/.test(src) && /cryptoRandomInt/.test(src) && /shuffled\(\[\.\.\.humans, \.\.\.bots\], this\.randomInt\)/.test(src), 'source pin: seats come from shuffled() over the injected/crypto integer source, and Math.random does not appear in the file');
}

console.log('\n=== 5. Timers: one per lobby that holds two humans, none otherwise ===');
{
  const base = liveTimeouts.size;
  const { matchmaker, join } = setup();
  const tcs = [300, 600, 900, 1200].map((s) => ({ initialSeconds: s, incrementSeconds: 0 }));
  tcs.forEach((tc, i) => {
    join(i * 10 + 1, tc);
    join(i * 10 + 2, tc);
  });
  check(liveTimeouts.size === base + 4, 'four lobbies of two humans: four timers');
  check(join(99, tcs[0]).ok === true && liveTimeouts.size === base + 4, '...a third human (accepted) in one of them adds none');
  check(matchmaker.lobbySize(tcs[0]) === 3, '(the first lobby now holds three)');
  matchmaker.leave('H2');
  check(matchmaker.lobbySize(tcs[0]) === 2 && liveTimeouts.size === base + 4, 'one of the three leaves: the lobby still holds two, so it keeps its timer');
  mock.timers.tick(30_000);
  check(liveTimeouts.size === base && matchmaker.size() === 0, 'when every lobby has started nothing is left pending');
}

console.log('\n=== 6. Nothing accumulates (a lobby for every time control ever used would be a slow memory leak) ===');
{
  const { matchmaker, join } = setup();
  for (let i = 0; i < 40; i++) {
    const tc = { initialSeconds: 60 + i, incrementSeconds: i % 31 };
    join(i * 2 + 1, tc);
    join(i * 2 + 2, tc);
  }
  check(matchmaker.lobbies.size === 40 && matchmaker.socketToKey.size === 80, '40 lobbies of two humans exist while they wait');
  mock.timers.tick(30_000);
  check(matchmaker.lobbies.size === 0 && matchmaker.socketToKey.size === 0, 'once every game has started there is no lobby and no socket mapping left');
  for (let i = 0; i < 40; i++) join(500 + i, { initialSeconds: 60 + i, incrementSeconds: 0 });
  for (let i = 0; i < 40; i++) matchmaker.leave(`H${500 + i}`);
  check(matchmaker.lobbies.size === 0 && matchmaker.socketToKey.size === 0 && liveTimeouts.size === 0, 'and the same after 40 lone humans queue and leave');
  const four = setup();
  for (let i = 1; i <= 4; i++) four.join(i);
  check(four.matchmaker.lobbies.size === 0 && four.matchmaker.socketToKey.size === 0, 'a lobby that started at once (four humans) is gone too');
}

mock.timers.reset();
console.log(`\nAll ${passed} checks passed.`);
process.exit(0);
