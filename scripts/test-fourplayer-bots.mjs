/**
 * 4 Player Chess ONLINE - bots, takeover, retake, abandonment, fast-forward (workstream W3, on src/game/fourPlayerRooms.ts).
 *
 *   npm run test:fourplayerBots        (tsx; no server, no database; stub sockets + Node fake timers + Date)
 *
 * W2's script (test-fourplayer-rooms.mjs) covers the room manager itself; this one covers what W3 adds: a bot's move through the same funnel
 * (pacing to the millisecond, increment, stale callbacks, a faulty or throwing bot, the ELO clamp), a disconnected human's seat being taken
 * over after the grace and RETAKEN at every stage, the all-humans-gone rule and its ordering against the takeover, fast-forward when only
 * eliminated humans are left watching, a count of every pending timer, and seeded games with random disconnects, rejoins and resignations
 * checked move by move against an independent replay on the engine.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mock } from 'node:test';
import {
  FOUR_ALL_GONE_MS,
  FOUR_BOT_ELO,
  FOUR_BOT_THINK_BULLET_MS,
  FOUR_BOT_THINK_MS,
  FOUR_FAST_FORWARD_DELAY_MS,
  FOUR_SERVER_BOT_MAX_ELO,
  FOUR_TAKEOVER_GRACE_MS,
  fourBotThinkMs,
} from '../src/game/fourPlayerConfig.ts';
import * as E from '../src/game/fourPlayer/index.ts';
import { disposeAll, eventsOf, mulberry32, newGame as newGameInKit, startFakeTimers } from './fourplayer-test-kit.mjs';

/** Every scenario starts from a clean slate: fake timers are global, so a game left running by the previous scenario (its bots, its graces)
 * would be driven by this one's `tick()`. (Scenarios that need TWO games at once create the second with `newGameInKit`.) */
function newGame(options) {
  disposeAll();
  return newGameInKit(options);
}

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ok  ${message}`);
}
const { liveTimeouts, armedDelays, delayOf } = startFakeTimers();
const sq = (name) => E.parseSquare(name);
const PROMO = { q: E.QUEEN, r: E.ROOK, b: E.BISHOP, n: E.KNIGHT };

/** Runs `fn` with console.error captured (the manager logs bot faults there). */
function captureErrors(fn) {
  const real = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    return { result: fn(), logged };
  } finally {
    console.error = real;
  }
}

/** Replays every published four_state seen by `socket` on an INDEPENDENT engine (same engine randomness) and requires each snapshot to match. */
function replayCheck(g, socket, engineSeed, label) {
  const refRng = mulberry32(engineSeed);
  let ref = E.initialState();
  let n = 0;
  for (const { payload: p } of eventsOf(g.io, 'four_state', socket)) {
    n++;
    assert.equal(p.seq, n, `${label}: seq is contiguous (state ${n})`);
    if (p.actor === 'human' || p.actor === 'bot') {
      assert.ok(p.move, `${label}: a ${p.actor} state carries its move`);
      assert.equal(ref.turn, p.move.seat, `${label}: the move was made by the seat on move`);
      const move = E.findLegalMove(ref, p.move.seat, sq(p.move.from), sq(p.move.to), p.move.promotion ? PROMO[p.move.promotion] : E.QUEEN);
      assert.ok(move, `${label}: the published ${p.actor} move ${p.move.from}-${p.move.to} is LEGAL in the independent replay (state ${n})`);
      ref = E.playMove(ref, move, refRng).state;
    } else {
      const out = p.events.find((e) => e.kind === 'eliminated');
      assert.ok(out, `${label}: a ${p.actor} state carries its elimination`);
      assert.equal(out.reason, p.actor === 'clock' ? 'timeout' : 'resign', `${label}: elimination reason matches the actor`);
      ref = E.resign(ref, out.seat, refRng, out.reason).state;
    }
    assert.equal(E.serialize(ref), p.state, `${label}: published position ${n} equals the independent replay's`);
  }
  return { ref, states: n };
}

console.log('\n=== 0. The configured numbers (pinned as literals) ===');
{
  check(FOUR_TAKEOVER_GRACE_MS === 45_000 && FOUR_ALL_GONE_MS === 45_000, 'takeover grace 45 s, all-gone 45 s');
  check(FOUR_BOT_ELO === 1200, 'fill and takeover bots are Amateur (1200)');
  check(FOUR_SERVER_BOT_MAX_ELO === 1700 && FOUR_SERVER_BOT_MAX_ELO < E.DEEP_FROM_ELO && E.botStrength(FOUR_SERVER_BOT_MAX_ELO).tier === 'careful' && E.botStrength(E.DEEP_FROM_ELO).tier === 'deep', 'the server clamp is 1700: the top of the careful tier, below the deep tier that can hold the event loop for ~200 ms');
  check(FOUR_BOT_THINK_MS === 450 && FOUR_BOT_THINK_BULLET_MS === 200 && FOUR_FAST_FORWARD_DELAY_MS === 0, 'think pacing 450 ms, bullet 200 ms, fast-forward 0');
  check([60, 120].every((s) => fourBotThinkMs(s) === 200) && [121, 180, 600, 3600].every((s) => fourBotThinkMs(s) === 450), "pacing follows the app's rule: 1 and 2 minute games are Bullet (<= 120 s), everything else 450 ms");
}

console.log('\n=== 1. The bot driver ===');
{
  const g = newGame({ kinds: ['human', 'bot', 'bot', 'bot'], names: ['Ann', 'Bot B', 'Bot Y', 'Bot G'] });
  g.stopTimer();
  g.clear();
  g.playFirst(0);
  check(g.pending().bot === true && delayOf(g.room().botTimer) === 450, 'after a human move the bot on move arms ONE timer, 450 ms');
  mock.timers.tick(449);
  check(g.seq() === 1, '...nothing happens at 449 ms');
  const prev = g.state();
  mock.timers.tick(1);
  const s = eventsOf(g.io, 'four_state', 'S0').at(-1).payload;
  check(g.seq() === 2 && s.actor === 'bot' && s.move.seat === 1 && s.seq === 2, 'at 450 ms Blue (a bot) plays: one four_state, actor "bot", the move of seat 1');
  check(E.findLegalMove(prev, 1, sq(s.move.from), sq(s.move.to), s.move.promotion ? PROMO[s.move.promotion] : E.QUEEN) !== null, "...a legal move (the bot's choice is checked against the engine's legal moves)");
  check(s.clocksMs[1] === 600_000 - 450 && s.clocksMs[0] === 600_000 && s.clocksMs[2] === 600_000, "...and the bot's clock is charged for its 450 ms like anyone's (599.55 s)");
  mock.timers.tick(450);
  mock.timers.tick(450);
  check(g.seq() === 4 && eventsOf(g.io, 'four_state', 'S0').slice(-3).map((e) => `${e.payload.actor}${e.payload.move.seat}`).join() === 'bot1,bot2,bot3', 'Yellow and Green follow, each 450 ms after the previous move');
  check(g.state().turn === 0 && g.pending().bot === false, 'back to the human: no bot timer is pending');
  check(g.room().log.length === 4 && g.room().log[1].seat === 1, 'bot moves are in the move list');
}
{
  const g = newGame({ kinds: ['human', 'bot', 'bot', 'bot'], tc: { initialSeconds: 60, incrementSeconds: 0 } });
  g.playFirst(0);
  check(delayOf(g.room().botTimer) === 200, 'a 1-minute game (Bullet) paces the bot at 200 ms');
  mock.timers.tick(200);
  check(g.seq() === 2, '...and it plays at 200 ms');
}
{
  const g = newGame({ kinds: ['bot', 'human', 'human', 'human'] });
  check(g.pending().bot === true && delayOf(g.room().botTimer) === 450, 'Red can be a bot: its first move is already scheduled when the room is created');
  g.clear();
  mock.timers.tick(450);
  const first = eventsOf(g.io, 'four_state', 'S1')[0];
  check(first && first.payload.actor === 'bot' && first.payload.move.seat === 0 && first.payload.seq === 1, '...and it opens the game at 450 ms');
}
{
  const g = newGame({ kinds: ['human', 'bot', 'human', 'human'], tc: { initialSeconds: 300, incrementSeconds: 5 } });
  g.playFirst(0);
  mock.timers.tick(450);
  check(eventsOf(g.io, 'four_state', 'S0').at(-1).payload.clocksMs[1] === 300_000 - 450 + 5_000, "a bot's increment is added after its move (300 - 0.45 + 5 = 304.55 s)");
}
{
  // Stale callbacks are harmless: the position moved on, or the seat is not a bot's.
  const g = newGame({ kinds: ['human', 'bot', 'bot', 'bot'] });
  g.stopTimer();
  g.playFirst(0); // Blue's move is now pending
  const room = g.room();
  const armedFor = room.seq;
  g.clear();
  clearTimeout(room.botTimer); // (calling the callback by hand consumes the handle, so the real pending timer is cancelled first)
  room.botTimer = null;
  g.mgr.playBotTurn(room, armedFor - 1);
  check(g.io.events.length === 0 && g.seq() === armedFor, 'a bot callback armed for an OLDER seq does nothing');
  const g2 = newGame({ kinds: ['human', 'bot', 'bot', 'bot'] });
  g2.stopTimer();
  g2.clear();
  g2.mgr.playBotTurn(g2.room(), g2.room().seq);
  check(g2.io.events.length === 0 && g2.seq() === 0, 'a bot callback while a HUMAN is on move does nothing');
}
{
  // A faulty bot can never stall a room or take the process down.
  const faulty = (what, chooser, expectedLog) => {
    const g = newGame({ kinds: ['human', 'bot', 'bot', 'bot'], chooseBotMove: chooser });
    g.playFirst(0);
    const prev = g.state();
    const { logged } = captureErrors(() => mock.timers.tick(450));
    const s = eventsOf(g.io, 'four_state', 'S0').at(-1).payload;
    const first = E.legalMoves(prev, 1)[0];
    assert.ok(g.seq() === 2 && s.actor === 'bot', `${what}: the room is not stalled: a bot move was still published`);
    assert.ok(s.move.from === E.squareName(first.from) && s.move.to === E.squareName(first.to), `${what}: the fallback is the FIRST legal move`);
    assert.ok(logged.length === 1 && expectedLog.test(logged[0]) && /seat 1/.test(logged[0]), `${what}: the fault was logged once (${logged[0]})`);
    passed++;
    console.log(`  ok  ${what}: the first legal move is played, the fault is logged, the room carries on`);
  };
  faulty('a bot that returns NO move', () => null, /no move/);
  faulty('a bot that returns an ILLEGAL move (another seat\'s piece)', () => ({ from: sq('e2'), to: sq('e4'), captured: 0, flags: 1 }), /illegal move/);
  faulty('a bot that returns a legal from/to with the wrong flags', (state) => {
    const m = E.legalMoves(state, state.turn)[0];
    return { ...m, flags: m.flags ^ 4 };
  }, /illegal move/);
  faulty('a bot that THROWS (an exception in a timer callback would be an uncaught exception that kills every game)', () => {
    throw new Error('boom');
  }, /an error \(boom\)/);
}
{
  // The clamp: a server bot never runs above the careful tier, and always gets the BOTS' random stream, not the engine's.
  const seen = [];
  const botRng = mulberry32(5);
  const rng = mulberry32(6);
  const recorder = (state, elo, r) => {
    seen.push({ elo, r });
    return E.legalMoves(state, state.turn)[0];
  };
  const cases = [[3000, 1700], [2500, 1700], [1800, 1700], [1701, 1700], [1700, 1700], [1500, 1500], [1200, 1200], [400, 400]];
  for (const [seatElo, expected] of cases) {
    newGame({ kinds: ['bot', 'human', 'human', 'human'], elos: [seatElo], chooseBotMove: recorder, rng, botRng });
    mock.timers.tick(450);
    const call = seen.at(-1);
    assert.ok(call && call.elo === expected, `a bot of ELO ${seatElo} decides at ${expected} (got ${call?.elo})`);
    assert.ok(E.botStrength(call.elo).tier !== 'deep', `ELO ${call.elo} is not the deep tier`);
    assert.ok(call.r === botRng && call.r !== rng, 'the bots\' own random stream is passed, not the engine\'s');
  }
  passed++;
  console.log(`  ok  every bot is clamped to ${FOUR_SERVER_BOT_MAX_ELO} (${cases.map(([a, b]) => `${a}->${b}`).join(', ')}), never reaches the deep tier, and gets the bots' own random stream`);
  // a bot seat with no elo at all gets the fill strength
  const noElo = (() => {
    const calls = [];
    newGame({ kinds: ['bot', 'human', 'human', 'human'], elos: [null], chooseBotMove: (s, elo) => (calls.push(elo), E.legalMoves(s, s.turn)[0]) });
    mock.timers.tick(450);
    return calls;
  })();
  check(noElo.length === 1 && noElo[0] === 1200, 'a bot seat created without an elo plays at the fill strength (1200)');
}
{
  disposeAll();
  const base = liveTimeouts.size;
  const g = newGame({ kinds: ['human', 'bot', 'bot', 'bot'] });
  check(liveTimeouts.size === base + 1, 'a human on move: one pending timer (the clock)');
  g.playFirst(0);
  check(liveTimeouts.size === base + 2, 'a bot on move: two (the clock and the bot\'s move) - never more');
  mock.timers.tick(450);
  check(liveTimeouts.size === base + 2, '...still two after the bot moved (the next bot is armed)');
}

console.log('\n=== 2. Disconnect and takeover ===');
{
  const g = newGame({ names: ['Ann', 'Ben', 'Cy', 'Di'] });
  g.mgr.spectate('SP', { roomId: g.id });
  g.clear();
  g.disconnect(1);
  const first = eventsOf(g.io, 'four_seat_update', 'S0')[0].payload.seats[1];
  check(first.connected === false && first.kind === 'human' && first.graceMsLeft === 45_000, 'a disconnect announces the seat as away with graceMsLeft: 45000');
  check(g.pending().graces === 1 && delayOf(g.room().seats[1].graceTimer) === 45_000, '...and starts ONE 45 s grace countdown');
  mock.timers.tick(10_000);
  g.clear();
  g.mgr.sendChat('S0', { roomId: g.id, text: 'hi' });
  mock.timers.tick(34_999);
  check(g.io.events.filter((e) => e.event === 'four_seat_update').length === 0 && g.room().seats[1].controller === 'human', 'at 44.999 s nothing has happened: the seat is still the human\'s');
  mock.timers.tick(1);
  const updates = eventsOf(g.io, 'four_seat_update');
  check(updates.length === 4 && ['S0', 'S2', 'S3', 'SP'].every((id) => updates.some((e) => e.id === id)), 'at 45 s the takeover is announced to the other seats and the spectator');
  const seat = updates[0].payload.seats[1];
  check(seat.kind === 'bot' && seat.botReason === 'takeover' && seat.elo === 1200 && seat.name === 'Ben' && seat.connected === true && seat.graceMsLeft === undefined, "...a bot, reason takeover, ELO 1200, STILL named Ben, connected, no countdown");
  check(g.pending().graces === 0 && g.room().seats[1].controller === 'bot', '...and the grace countdown is over');
  const spec = g.mgr.spectate('SP2', { roomId: g.id });
  check(spec.state.seats[1].kind === 'bot' && spec.state.seats[1].botReason === 'takeover', 'a new spectator sees the seat as a bot');
  check(g.mgr.listActiveGames()[0].seats[1].kind === 'bot' && g.mgr.listActiveGames()[0].seats[1].name === 'Ben', 'the active-games list shows it as a bot too');
}
{
  // graceMsLeft is what a client counts down from, so it must be right LATER in the grace too, not only at the moment of the disconnect.
  const g = newGame();
  g.disconnect(1);
  mock.timers.tick(10_000);
  g.clear();
  g.disconnect(2); // any later seat update carries every seat's countdown
  let seats = eventsOf(g.io, 'four_seat_update', 'S0').at(-1).payload.seats;
  check(seats[1].graceMsLeft === 35_000 && seats[2].graceMsLeft === 45_000 && seats[0].graceMsLeft === undefined, '10 s into Blue\'s grace a seat update shows Blue with 35000 ms left (and Yellow, who just left, with 45000)');
  mock.timers.tick(34_999); // t = 44.999 s
  g.clear();
  g.disconnect(3);
  seats = eventsOf(g.io, 'four_seat_update', 'S0').at(-1).payload.seats;
  check(seats[1].graceMsLeft === 1 && seats[3].graceMsLeft === 45_000, '...and 1 ms before the takeover it shows 1 ms');
}
{
  // The seat's own clock keeps running through the grace; if it is on move when the bot takes over, the bot plays after its think delay.
  const g = newGame();
  g.playFirst(0); // Blue is on move from t = 0
  g.disconnect(1);
  mock.timers.tick(45_000);
  check(g.room().seats[1].controller === 'bot' && g.pending().bot === true, 'a seat on move at the takeover: the bot arms its move');
  g.clear();
  mock.timers.tick(449);
  check(g.io.events.length === 0, '...which comes after the think delay, not instantly (449 ms: nothing)');
  mock.timers.tick(1);
  const s = eventsOf(g.io, 'four_state', 'S0').at(-1).payload;
  check(s.actor === 'bot' && s.move.seat === 1 && s.clocksMs[1] === 600_000 - 45_450, "...and Blue's clock shows the 45.45 s it has been on move (grace + think delay): the clock never stopped");
  g.playFirst(2);
  g.playFirst(3);
  g.playFirst(0);
  mock.timers.tick(450);
  const later = eventsOf(g.io, 'four_state', 'S0').at(-1).payload;
  check(later.actor === 'bot' && later.move.seat === 1, 'the bot keeps playing the seat on every later turn');
}
{
  // A seat eliminated during the grace has nothing left to take over.
  const g = newGame({ tc: { initialSeconds: 60, incrementSeconds: 0 } });
  g.playFirst(0); // Blue's 60 s run from t = 0
  mock.timers.tick(20_000);
  g.disconnect(1); // 20 s in: 40 s left, but 45 s of grace
  mock.timers.tick(40_000);
  check(g.state().status[1] === 'dead-king', "Blue's clock runs out at 60 s, inside the grace");
  g.clear();
  mock.timers.tick(5_000); // t = 65 s: the grace ends
  check(g.io.events.filter((e) => e.event === 'four_seat_update').length === 0 && g.room().seats[1].controller === 'human' && g.pending().graces === 0, 'at the end of the grace the eliminated seat is NOT taken over (no seat update, still the human\'s)');
}
{
  const g = newGame();
  g.resign(1);
  g.disconnect(1);
  check(g.pending().graces === 0, 'an ELIMINATED human who disconnects starts no grace countdown (nothing to take over)');
}
{
  // Leaving, coming back, leaving again: the second countdown starts from the second departure.
  const g = newGame();
  g.disconnect(1);
  mock.timers.tick(10_000);
  g.rejoin(1);
  check(g.pending().graces === 0, 'coming back ends the countdown');
  mock.timers.tick(10_000);
  g.disconnect(1); // t = 20 s
  mock.timers.tick(44_999);
  check(g.room().seats[1].controller === 'human', 'the second countdown runs from the SECOND departure (not taken over 45 s after the first: 44.999 s later nothing)');
  mock.timers.tick(1);
  check(g.room().seats[1].controller === 'bot', '...and the takeover comes 45 s after the second departure');
}

console.log('\n=== 3. Retaking a seat ===');
{
  const g = newGame();
  g.disconnect(1);
  mock.timers.tick(30_000);
  g.clear();
  const ack = g.rejoin(1);
  const update = eventsOf(g.io, 'four_seat_update', 'S0')[0].payload.seats[1];
  check(ack.ok && update.connected === true && update.kind === 'human' && update.graceMsLeft === undefined && g.pending().graces === 0, 'back during the grace: the seat is shown connected, no countdown, the grace is cancelled');
  mock.timers.tick(30_000);
  check(g.room().seats[1].controller === 'human', '...so at 45 s there is no takeover');
}
{
  // After the takeover, while the seat is NOT on move.
  const g = newGame();
  g.disconnect(1); // Red is on move
  mock.timers.tick(45_000);
  g.clear();
  const ack = g.rejoin(1);
  const update = eventsOf(g.io, 'four_seat_update', 'S0')[0].payload.seats[1];
  check(ack.ok && ack.state.seat === 1 && ack.state.seats[1].kind === 'human', 'a taken-over seat is retaken with the token: ok, seat 1, shown as human in the answer');
  check(update.kind === 'human' && update.botReason === undefined && update.elo === undefined && update.connected === true, '...and announced as human again (no bot reason, no elo)');
  g.playFirst(0);
  check(g.pending().bot === false, "Red moves; Blue is on move and is the HUMAN's again: no bot timer");
  g.clear();
  mock.timers.tick(5_000);
  check(g.io.events.filter((e) => e.event === 'four_state').length === 0, '...and nothing plays Blue\'s move for it');
  check(g.mv(1, g.firstMove(1).from, g.firstMove(1).to).ok === true && eventsOf(g.io, 'four_state', 'S0').at(-1).payload.actor === 'human', 'the human plays its own move');
}
{
  // While the bot's move is already pending.
  const g = newGame();
  g.playFirst(0); // Blue on move
  g.disconnect(1);
  mock.timers.tick(45_000); // takeover; the bot's move is armed for +450 ms
  check(g.pending().bot === true, 'the bot is about to play Blue');
  mock.timers.tick(100);
  const armedFor = g.room().seq;
  g.clear();
  g.rejoin(1);
  check(g.pending().bot === false, 'a retake at +100 ms CANCELS the bot\'s pending move');
  mock.timers.tick(5_000);
  check(g.io.events.filter((e) => e.event === 'four_state').length === 0, '...and it never plays');
  g.mgr.playBotTurn(g.room(), armedFor);
  check(g.io.events.filter((e) => e.event === 'four_state').length === 0 && g.seq() === armedFor, 'even a callback that somehow still fires is a no-op: the seat is a human\'s');
  check(g.mv(1, g.firstMove(1).from, g.firstMove(1).to).ok === true, 'the human plays its move; its clock has run the whole time');
}
{
  // After the bot has already played for the seat.
  const g = newGame();
  g.playFirst(0);
  g.disconnect(1);
  mock.timers.tick(45_000); // taken over...
  mock.timers.tick(450); // ...and the bot has moved (two ticks: Node's fake timers time a timer set INSIDE a tick from the end of that tick)
  check(g.seq() === 2 && eventsOf(g.io, 'four_state', 'S0').at(-1).payload.actor === 'bot', 'the bot played Blue\'s move');
  g.playFirst(2);
  g.playFirst(3);
  g.playFirst(0);
  g.clear();
  mock.timers.tick(200); // Blue is on move again, the bot is thinking
  g.rejoin(1);
  check(g.pending().bot === false && g.room().seats[1].controller === 'human', 'retaking while the bot is mid-turn hands the NEXT move back to the human');
  check(g.mv(1, g.firstMove(1).from, g.firstMove(1).to).ok === true, '...who plays it');
}
{
  const g = newGame();
  g.disconnect(1);
  mock.timers.tick(45_000);
  const wrong = g.mgr.rejoin('X', { roomId: g.id, playerToken: g.tokens[2] }); // Yellow's token, which is connected elsewhere
  check(wrong.ok && wrong.state.seat === 2 && g.room().seats[1].controller === 'bot', "another seat's token never retakes Blue's seat (it opens its own)");
}

console.log('\n=== 4. Everyone leaves ===');
{
  const g = newGame({ kinds: ['human', 'human', 'bot', 'bot'], names: ['Ann', 'Ben', 'Bot', 'Bot'] });
  g.mgr.spectate('SP', { roomId: g.id });
  g.clear();
  g.disconnect(0); // t = 0: Red is on move
  check(g.pending().allGone === false, 'one human is still connected: no all-gone countdown');
  mock.timers.tick(10_000);
  g.disconnect(1); // t = 10 s: nobody left
  check(g.pending().allGone === true && delayOf(g.room().allGoneTimer) === 45_000, 'the last human leaving starts the 45 s all-gone countdown');
  mock.timers.tick(35_000); // t = 45 s: Red\'s grace ends - but nobody is connected
  check(g.room().seats[0].controller === 'human' && g.pending().graces === 1, "Red's grace expires with nobody connected: NO takeover (a bot is never handed an empty room) - only Blue's grace is left");
  mock.timers.tick(9_999); // t = 54.999 s
  check(g.mgr.rooms.has(g.id) && eventsOf(g.io, 'four_game_over').length === 0, 'at 54.999 s the game is still on (45 s after the LAST departure, not the first)');
  mock.timers.tick(1);
  const over = eventsOf(g.io, 'four_game_over');
  check(over.length === 1 && over[0].id === 'SP' && over[0].payload.reason === 'abandoned' && over[0].payload.winners.length === 0, 'at 55 s the game ends: four_game_over, reason "abandoned", NO winners - sent to the spectator (the only one connected)');
  check(Array.isArray(over[0].payload.scores) && over[0].payload.scores.length === 4 && E.deserialize(over[0].payload.state).result === null, '...with the scores as they stood and the snapshot (whose engine result is none: it was not decided by play)');
  check(!g.mgr.rooms.has(g.id) && g.mgr.socketToSeat.size === 0 && g.mgr.socketToSpectating.size === 0, 'the room is removed and every socket released');
  const late = g.mgr.rejoin('late', { roomId: g.id, playerToken: g.tokens[0] });
  check(late.ok && late.finished === true && late.gameOver.reason === 'abandoned' && late.gameOver.winners.length === 0, 'a late rejoin learns it was abandoned (the result is kept like any other)');
  check(g.mgr.makeMove('S0', { roomId: g.id, from: 'e2', to: 'e4' }).ok === false && g.mgr.listActiveGames().length === 0, 'no more moves, and it is not in the active-games list');
}
{
  const g = newGame();
  mock.timers.tick(100);
  for (let i = 0; i < 4; i++) g.disconnect(i);
  check(g.pending().allGone === true && g.pending().graces === 4, 'four humans leave together: one all-gone countdown and four graces');
  mock.timers.tick(44_999);
  check(g.mgr.rooms.has(g.id), 'still on at 44.999 s');
  mock.timers.tick(1);
  check(!g.mgr.rooms.has(g.id) && eventsOf(g.io, 'four_game_over').length === 0 && g.room() === undefined, 'at 45 s it ends (nobody is connected to be told)');
  check(g.mgr.rejoin('b', { roomId: g.id, playerToken: g.tokens[2] }).gameOver.reason === 'abandoned', '...and the late rejoin learns "abandoned"');
  check([...g.mgr.finishedRooms.values()].some((f) => f.gameOver.roomId === g.id && f.gameOver.reason === 'abandoned'), '...the record is kept');
}
{
  // The last human coming back cancels it - and the first leaver's seat can then be taken over.
  const g = newGame({ kinds: ['human', 'human', 'bot', 'bot'] });
  g.disconnect(0);
  mock.timers.tick(10_000);
  g.disconnect(1);
  mock.timers.tick(20_000); // t = 30 s
  g.rejoin(1);
  check(g.pending().allGone === false, 'a human coming back cancels the all-gone countdown');
  mock.timers.tick(15_000); // t = 45 s: Red\'s grace ends, Blue is connected
  check(g.room().seats[0].controller === 'bot', "...and Red's seat IS taken over at 45 s (somebody is connected again)");
  mock.timers.tick(10_000);
  check(g.mgr.rooms.has(g.id), 'the game is still on at 55 s (the cancelled countdown never fires)');
}
{
  // All-gone counts ORIGINAL humans: a seat a bot has taken over does not keep the game alive.
  const g = newGame({ kinds: ['human', 'human', 'bot', 'bot'] });
  g.disconnect(0);
  mock.timers.tick(45_000);
  check(g.room().seats[0].controller === 'bot' && g.pending().allGone === false, 'Red is taken over (Blue is connected): no countdown yet');
  mock.timers.tick(15_000); // t = 60 s
  g.disconnect(1);
  check(g.pending().allGone === true, 'Blue leaving too starts it although a bot holds Red\'s seat: the bots do not keep a game alive by themselves');
  mock.timers.tick(45_000);
  check(!g.mgr.rooms.has(g.id), '...and 45 s later the game ends');
}
{
  const g = newGame({ kinds: ['human', 'human', 'bot', 'bot'] });
  g.disconnect(0);
  check(g.pending().allGone === false, 'while one human is still connected there is no countdown');
  g.disconnect(1);
  g.rejoin(0);
  check(g.pending().allGone === false, 'and the first human back cancels it at once');
  g.mgr.spectate('SPX', { roomId: g.id });
  g.disconnect(0);
  check(g.pending().allGone === true, 'a spectator does not count as "someone is here"');
}

console.log('\n=== 5. Fast-forward: only eliminated humans are left watching ===');
/**
 * One bot ply, stepped by hand. (Node's fake timers run a delay-0 timer that is armed INSIDE a tick within that same tick, so a single
 * tick() would play a whole fast-forwarded game before anything could be inspected; a real setTimeout(0) is a separate event-loop turn.)
 * The pending timer is cancelled first, as the timer firing would have consumed it.
 */
function stepBot(g) {
  const room = g.room();
  if (room.botTimer) clearTimeout(room.botTimer);
  room.botTimer = null;
  g.mgr.playBotTurn(room, room.seq);
}
const ZERO_OR_PACED = (ms) => ms === 0 || ms === 450 || ms === 200; // a bot timer's delay (clock timers are thousands of ms)
{
  const g = newGame({ kinds: ['human', 'human', 'bot', 'bot'], tc: { initialSeconds: 3600, incrementSeconds: 0 }, rng: mulberry32(11), botRng: mulberry32(12) });
  g.mgr.spectate('SP', { roomId: g.id });
  g.resign(0);
  check(g.pending().bot === false, 'Red resigns: Blue is still a human, active and on move: no bot is on move, nothing is fast-forwarding');
  const mark = armedDelays.length;
  g.resign(1);
  check(g.pending().bot === true && delayOf(g.room().botTimer) === 0, 'once the last human-controlled seat is out (both still connected, watching) the bot on move is armed with NO think delay');
  let guard = 0;
  while (g.mgr.rooms.has(g.id) && guard++ < 20_000) mock.timers.tick(1);
  const plies = eventsOf(g.io, 'four_state', 'SP').length;
  const over = eventsOf(g.io, 'four_game_over', 'S0');
  check(over.length === 1 && over[0].payload.reason !== 'abandoned', `the game is played to its natural end (${over[0]?.payload.reason}) with the humans watching`);
  const botDelays = armedDelays.slice(mark).filter(ZERO_OR_PACED);
  check(botDelays.length > 50 && botDelays.every((ms) => ms === 0), `every bot ply after the last human was eliminated was armed with a ZERO delay (${botDelays.length} plies, none at the normal 450 ms: ${plies} states in all)`);
  const { ref } = replayCheck(g, 'SP', 11, 'fast-forward game');
  check(JSON.stringify(ref.result?.winners) === JSON.stringify(over[0].payload.winners) && JSON.stringify([...ref.score]) === JSON.stringify(over[0].payload.scores), '...and every position and the final result match an independent replay');
  check(g.room() === undefined, 'the room is gone');
}
{
  // An ACTIVE human - even one who is away - is still playing: no fast-forward until its seat is actually taken over.
  const g = newGame({ kinds: ['human', 'human', 'bot', 'bot'], tc: { initialSeconds: 3600, incrementSeconds: 0 }, rng: mulberry32(51), botRng: mulberry32(52) });
  g.mgr.spectate('SP', { roomId: g.id });
  g.resign(0);
  g.playFirst(1);
  check(delayOf(g.room().botTimer) === 450, 'Blue is still playing: the bot on move is armed at the normal 450 ms pace');
  g.disconnect(1);
  stepBot(g); // Yellow plays; Green is next
  check(delayOf(g.room().botTimer) === 450, '...also while Blue is DISCONNECTED (it may come back, so the game is not rushed past it)');
  stepBot(g); // Green plays; Red is out; Blue (away) is on move
  check(g.pending().bot === false && g.state().turn === 1, "now it is the away human's own turn: no bot has anything to do");
  const mark = armedDelays.length;
  mock.timers.tick(45_000); // the grace ends: Blue's seat is taken over, and everything after that is bots with Red watching
  const after = armedDelays.slice(mark).filter(ZERO_OR_PACED);
  check(eventsOf(g.io, 'four_seat_update', 'SP').some((e) => e.payload.seats[1].botReason === 'takeover'), "Blue's seat was taken over");
  check(after.length > 10 && after.every((ms) => ms === 0), `from the takeover on every bot ply is armed with a ZERO delay (${after.length} plies): the rest of the game fast-forwards`);
  check(g.room() === undefined && eventsOf(g.io, 'four_game_over', 'SP')[0].payload.reason !== 'abandoned', '...to a natural end');
  replayCheck(g, 'SP', 51, 'takeover then fast-forward');
  passed++;
  console.log('  ok  ...and every published position is the independent replay\'s');
}
{
  // The watchers leave and come back mid-fast-forward.
  const g = newGame({ kinds: ['human', 'human', 'bot', 'bot'], tc: { initialSeconds: 3600, incrementSeconds: 0 }, rng: mulberry32(21), botRng: mulberry32(22) });
  g.resign(0);
  g.resign(1);
  stepBot(g);
  stepBot(g);
  stepBot(g);
  check(g.seq() >= 5 && delayOf(g.room().botTimer) === 0, 'two bots are playing fast');
  g.disconnect(0);
  check(delayOf(g.room().botTimer) === 0, 'one watcher leaves, one is still there: still fast');
  g.disconnect(1);
  check(g.pending().allGone === true && delayOf(g.room().botTimer) === 450, 'the last watcher leaves: the all-gone countdown starts and the bot on move is re-armed at the NORMAL pace (nobody is watching)');
  stepBot(g);
  check(delayOf(g.room().botTimer) === 450, '...and so is the next ply');
  g.rejoin(0);
  check(g.pending().allGone === false && delayOf(g.room().botTimer) === 0, 'a watcher coming back cancels the countdown and the bots rush again');
}
{
  // One timer, one ply: a bot turn never loops.
  const g = newGame({ kinds: ['human', 'human', 'bot', 'bot'], tc: { initialSeconds: 3600, incrementSeconds: 0 } });
  g.resign(0);
  g.resign(1);
  const before = g.seq();
  stepBot(g);
  check(g.seq() === before + 1 && eventsOf(g.io, 'four_state', 'S0').at(-1).payload.actor === 'bot', 'one bot turn publishes exactly ONE state: the next ply is a separate timer, so the event loop is released between plies');
}

console.log('\n=== 6. Every timer is accounted for ===');
{
  disposeAll();
  const base = liveTimeouts.size;
  const g = newGame({ kinds: ['human', 'human', 'bot', 'bot'] });
  check(liveTimeouts.size === base + 1, 'a new room: its clock');
  g.disconnect(0);
  g.disconnect(1);
  check(liveTimeouts.size === base + 1 + 2 + 1, 'two humans away: the clock + two graces + the all-gone countdown');
  g.rejoin(0);
  check(liveTimeouts.size === base + 1 + 1, 'one back: the clock + the other grace (the all-gone countdown and the first grace are cancelled)');
  mock.timers.tick(45_000);
  check(g.room().seats[1].controller === 'bot' && liveTimeouts.size === base + 1, 'takeover: the grace fired, only the clock is left (Red is on move: no bot move pending)');
  g.disconnect(0);
  check(liveTimeouts.size === base + 1 + 1 + 1, 'Red leaves: the clock, its grace and the all-gone countdown');
  mock.timers.tick(45_000);
  check(!g.mgr.rooms.has(g.id) && liveTimeouts.size === base, 'the game ends: NO timer of any kind is left behind (clock, bot, graces, all-gone)');
}
{
  disposeAll();
  const base = liveTimeouts.size;
  const g = newGame({ kinds: ['human', 'bot', 'bot', 'bot'] });
  g.playFirst(0);
  check(g.pending().bot === true, 'a bot move is pending...');
  g.resign(0); // the only human is eliminated (and still watching): the three bots play the game out
  for (let i = 0; i < 3000 && g.mgr.rooms.has(g.id); i++) mock.timers.tick(450);
  check(!g.mgr.rooms.has(g.id) && liveTimeouts.size === base, '...and when a bots-only game ends (a human watching) nothing is left pending');
}

console.log('\n=== 7. Random games with bots, takeovers, retakes and resignations - every position replayed on an independent engine ===');
{
  disposeAll();
  const base = liveTimeouts.size;
  const totals = { games: 0, states: 0, takeovers: 0, retakes: 0, abandoned: 0, natural: 0, bot: 0, human: 0, resign: 0, clock: 0 };
  const configs = [
    { kinds: ['human', 'human', 'bot', 'bot'], rejoin: 0.06 },
    { kinds: ['human', 'bot', 'bot', 'bot'], rejoin: 0.04 },
    { kinds: ['human', 'human', 'human', 'bot'], rejoin: 0.02 },
    { kinds: ['human', 'human', 'human', 'human'], rejoin: 0.01 },
    { kinds: ['bot', 'human', 'human', 'bot'], rejoin: 0.005 },
    { kinds: ['human', 'human', 'bot', 'bot'], rejoin: 0.001 },
  ];
  for (let seed = 1; seed <= 12; seed++) {
    const cfg = configs[seed % configs.length];
    const engineSeed = 40_000 + seed;
    const g = newGame({ kinds: cfg.kinds, tc: { initialSeconds: 600, incrementSeconds: 2 }, rng: mulberry32(engineSeed), botRng: mulberry32(engineSeed + 777), elos: [1200, 1700, 3000, 1200] });
    g.mgr.spectate('SP', { roomId: g.id });
    const script = mulberry32(seed * 13 + 5);
    const humans = [0, 1, 2, 3].filter((i) => cfg.kinds[i] === 'human');
    const connected = new Set(humans);
    for (let step = 0; step < 1500 && g.mgr.rooms.has(g.id); step++) {
      // Usually a moment passes; now and then a LONG time (20-70 s), so that absences outlast the 45 s grace and takeovers/retakes really happen.
      mock.timers.tick(script() < 0.06 ? 20_000 + Math.floor(script() * 50_000) : Math.floor(script() * 1500));
      if (!g.mgr.rooms.has(g.id)) break;
      const roll = script();
      const turn = g.state().turn;
      const away = humans.filter((h) => !connected.has(h));
      if (roll < 0.025 && connected.size > 0) {
        const h = [...connected][Math.floor(script() * connected.size)];
        g.disconnect(h);
        connected.delete(h);
      } else if (roll < 0.025 + cfg.rejoin && away.length > 0) {
        const h = away[Math.floor(script() * away.length)];
        const wasBot = g.room().seats[h].controller === 'bot';
        const ack = g.rejoin(h);
        if (ack.ok) {
          connected.add(h);
          if (wasBot) totals.retakes++;
        }
      } else if (roll < 0.04 + cfg.rejoin && connected.size > 0) {
        const h = [...connected][Math.floor(script() * connected.size)];
        if (g.state().status[h] === 'active') g.resign(h);
      } else if (humans.includes(turn) && connected.has(turn) && g.room().seats[turn].controller === 'human') {
        const moves = E.legalMoves(g.state(), turn);
        const m = moves[Math.floor(script() * moves.length)];
        const ack = g.mv(turn, E.squareName(m.from), E.squareName(m.to), m.flags & E.FLAG_PROMOTION ? 'qrbn'[E.PROMOTABLE_TYPES.indexOf(E.promotionOf(m))] : undefined);
        assert.ok(ack.ok, `[seed ${seed}] a human's legal move is accepted: ${JSON.stringify(ack)}`);
      }
    }
    const stillOn = g.mgr.rooms.has(g.id);
    // The replay is checked on what was published so far (the spectator saw every state)
    const { ref, states } = replayCheck(g, 'SP', engineSeed, `seed ${seed}`);
    totals.states += states;
    for (const e of eventsOf(g.io, 'four_state', 'SP')) totals[e.payload.actor]++;
    if (eventsOf(g.io, 'four_seat_update', 'SP').some((e) => e.payload.seats.some((s) => s.botReason === 'takeover'))) totals.takeovers++; // games in which a seat was taken over
    if (stillOn) {
      for (const h of connected) g.disconnect(h); // wind the game up: everybody leaves
      for (let i = 0; i < 40 && g.mgr.rooms.has(g.id); i++) mock.timers.tick(5_000);
    }
    const over = eventsOf(g.io, 'four_game_over', 'SP');
    assert.equal(over.length, 1, `[seed ${seed}] exactly one game over`);
    assert.equal(g.mgr.rooms.has(g.id), false, `[seed ${seed}] the game ended`);
    if (over[0].payload.reason === 'abandoned') {
      totals.abandoned++;
      assert.deepEqual(over[0].payload.winners, [], `[seed ${seed}] abandoned means no winners`);
    } else {
      totals.natural++;
      assert.deepEqual(over[0].payload.winners, ref.result.winners, `[seed ${seed}] winners match the replay`);
      assert.deepEqual(over[0].payload.scores, [...ref.score], `[seed ${seed}] scores match the replay`);
    }
    const order = g.io.events.filter((e) => e.id === 'SP').map((e) => e.event);
    assert.ok(order.lastIndexOf('four_state') < order.indexOf('four_game_over'), `[seed ${seed}] no four_state after the game over`);
    assert.equal(liveTimeouts.size, base, `[seed ${seed}] no timer is left behind after the game`);
    totals.games++;
  }
  console.log(`      ${JSON.stringify(totals)}`);
  check(totals.games === 12 && totals.states > 1500, `${totals.games} seeded games (${totals.states} published states): every position equals the independent replay's, every published move is legal, seq is contiguous, results match, no timer is left behind`);
  check(totals.bot > 200 && totals.human > 200 && totals.resign > 5, `...with real variety: ${totals.bot} bot moves, ${totals.human} human moves, ${totals.resign} resignations, ${totals.clock} flag falls`);
  check(totals.takeovers >= 3 && totals.retakes >= 1 && totals.abandoned >= 1 && totals.natural >= 1, `...and the interesting paths were exercised: games with a takeover ${totals.takeovers}, retakes ${totals.retakes}, abandoned ${totals.abandoned}, played to a result ${totals.natural}`);
}

console.log('\n=== 8. What a bot decision costs inside the manager ===');
{
  const durations = [];
  const bySeat = [[], [], [], []];
  for (let gameNo = 0; gameNo < 12 && durations.length < 900; gameNo++) {
    const g = newGame({ kinds: ['human', 'bot', 'bot', 'bot'], tc: { initialSeconds: 3600, incrementSeconds: 0 }, elos: [1200, 1200, 1700, 3000], rng: mulberry32(31 + gameNo), botRng: mulberry32(131 + gameNo) });
    const original = g.mgr.playBotTurn.bind(g.mgr);
    g.mgr.playBotTurn = (room, armedFor) => {
      const seat = room.state.turn;
      const started = process.hrtime.bigint();
      original(room, armedFor);
      const took = Number(process.hrtime.bigint() - started) / 1e6;
      durations.push(took);
      bySeat[seat].push(took);
    };
    for (let guard = 0; g.mgr.rooms.has(g.id) && guard < 400; guard++) {
      if (g.state().turn === 0 && g.state().status[0] === 'active') {
        const moves = E.legalMoves(g.state(), 0);
        const m = moves[guard % moves.length];
        g.mv(0, E.squareName(m.from), E.squareName(m.to), m.flags & E.FLAG_PROMOTION ? 'q' : undefined);
      }
      mock.timers.tick(450);
    }
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const p99 = sorted[Math.floor(sorted.length * 0.99)];
  const max = sorted.at(-1);
  console.log(`      ${sorted.length} bot decisions across several games: mean ${mean.toFixed(2)} ms, p99 ${p99.toFixed(2)} ms, max ${max.toFixed(2)} ms (seat 3, configured at ELO 3000 and held at 1700: ${bySeat[3].length} decisions, max ${Math.max(0, ...bySeat[3]).toFixed(2)} ms)`);
  check(sorted.length >= 400 && bySeat[3].length >= 100, `${sorted.length} bot decisions were timed, ${bySeat[3].length} of them by the seat configured at ELO 3000`);
  check(max < 100, 'no decision - including the ELO-3000 seat, clamped to 1700 - holds the event loop for anything like the ~200 ms a deep-tier decision can take');
}

console.log('\n=== 9. Source-level pins ===');
{
  const src = fs.readFileSync(new URL('../src/game/fourPlayerRooms.ts', import.meta.url), 'utf8').split('\r\n').join('\n');
  const body = (name) => {
    const start = src.indexOf(name);
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
      if (src[i] === '{') depth++;
      if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    return '';
  };
  const assigns = src.match(/\.controller = /g) ?? [];
  check(assigns.length === 2 && body('  private onGraceExpired(').includes("runtime.controller = 'bot'") && body('  rejoin(socketId: string, payload: unknown)').includes("runtime.controller = 'human'"), "after creation a seat's controller changes in exactly two places: the takeover (onGraceExpired) and the retake (rejoin)");
  check(src.includes('Math.min(runtime.elo ?? FOUR_BOT_ELO, FOUR_SERVER_BOT_MAX_ELO)') && (src.match(/this\.chooseBot\(/g) ?? []).length === 1, 'the bot decision is made in ONE place, with the elo clamped by Math.min against FOUR_SERVER_BOT_MAX_ELO');
  check((src.match(/setTimeout\(/g) ?? []).length === 4, 'exactly four setTimeout calls - the clock, the bot move, a seat\'s grace and the all-gone countdown - so a NEW kind of timer cannot appear without someone adding it to finish() on purpose');
  check(src.includes('[room.clockTimer, room.botTimer, room.allGoneTimer, ...room.seats.map((s) => s.graceTimer)]'), 'finish() clears every kind of timer a room owns');
}

mock.timers.reset();
console.log(`\nAll ${passed} checks passed.`);
process.exit(0);
