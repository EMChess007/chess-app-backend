#!/usr/bin/env node
/**
 * End-to-end test for BUGHOUSE ONLINE (workstream W2): connects to an ALREADY RUNNING backend as plain socket.io-client "players" (up to four per match, plus seat-less spectators) and
 * exercises the real `bug_*` protocol, exactly as the app would. No mocking: the actual server, matchmaker and room manager, over actual sockets.
 *
 * WHY IT EXISTS. The in-process scripts (test-bughouse-rooms / -messages / -matchmaking / -handlers / -bot) drive the server logic on stub sockets and an injected clock. None of them
 * holds several INDEPENDENT REAL CONNECTIONS to the same match, so none can prove what the feature rests on: after every commit all players (and a spectator) hold byte-identical
 * snapshots with the same `seq`, a team-chat line or a quick message reaches the partner and NOBODY ELSE (every socket's events recorded), and a bot, a takeover and a rejoin behave over a
 * real transport. Time here is real, so nothing asserts a duration: waits end on a condition and their bounds only turn a hang into a failure.
 *
 * Usage (the shortened fill wait and takeover grace are the 4-seat games' two existing test overrides, which Bughouse reads too; both are ignored when NODE_ENV=production):
 *   FOUR_GRACE_MS=1500 FOUR_FILL_MS=8000 npm run dev               (in one terminal, from backend/)
 *   npm run test:bughouseOnline                                      (in another)
 *
 * Runs under tsx because legal moves come from the GENERATED TypeScript mirror of the engine (src/game/bughouse/index.ts) - the same code the server runs: transport and
 * synchronisation are what is under test here, not the rules (the lockstep with the app's engine is test-bughouse-engine.mjs's job).
 *
 * BACKEND_URL overrides the default http://localhost:3000. BUGHOUSE_E2E_SEED (a number) reseeds the pseudo-random move choice.
 *
 * COUNTING. `check` counts a check whose number is the same on every run. `checkConditional` is asserted like any other but counted apart, because how many of them there are depends on
 * what the unseeded server did (which seats the humans were dealt, how many moves the bots made meanwhile): the printed fixed total is the same on every run.
 */
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
import { BUG_REJECT_REASONS, deserializeMatch, legalActions, seatPlace, serializeMatch } from '../src/game/bughouse/index.ts';

const SERVER_URL = process.env.BACKEND_URL ?? 'http://localhost:3000';
const SEED = Number(process.env.BUGHOUSE_E2E_SEED ?? 20261021);
const TC3 = { initialMs: 180000, incrementMs: 0 };
const TC32 = { initialMs: 180000, incrementMs: 2000 };
let passedChecks = 0;
let conditionalChecks = 0;

function check(condition, message) {
  assert.ok(condition, message);
  passedChecks++;
  console.log(`  ✓ ${message}`);
}
function checkConditional(condition, message) {
  assert.ok(condition, message);
  conditionalChecks++;
  console.log(`  ~ ${message}`);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(name, url = SERVER_URL) {
  return new Promise((resolve, reject) => {
    const socket = io(url, { transports: ['websocket'], reconnection: false });
    const timer = setTimeout(() => reject(new Error(`${name}: connect timed out`)), 5000);
    socket.on('connect', () => {
      clearTimeout(timer);
      console.log(`[${name}] connected (socket ${socket.id})`);
      resolve(socket);
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(new Error(`${name}: connect_error — ${err.message}`));
    });
  });
}

function emitAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(5000).emit(event, payload, (err, response) => {
      if (err) {
        reject(new Error(`"${event}" ack never arrived (timeout)`));
        return;
      }
      resolve(response);
    });
  });
}

/** Resolves with the next `event` on `socket`; the listener must be attached BEFORE the emit that provokes the event (see test-fourplayer-online.mjs `waitFor`). */
function waitFor(socket, event, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** Polls until `test()` is truthy (the events of several sockets arrive independently). */
async function until(what, test, timeoutMs = 10_000) {
  const t0 = Date.now();
  while (!test()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting until ${what}`);
    await sleep(10);
  }
}

/** Records every bug_* event a socket receives from the moment it is attached (attach it right after connect(), BEFORE any emit). */
function record(socket) {
  const inbox = { matchFound: [], queueUpdates: [], states: [], seatUpdates: [], gameOvers: [], chats: [], quicks: [], all: [] };
  const into = { bug_match_found: inbox.matchFound, bug_queue_update: inbox.queueUpdates, bug_state: inbox.states, bug_seat_update: inbox.seatUpdates, bug_game_over: inbox.gameOvers, bug_chat_from: inbox.chats, bug_quick_from: inbox.quicks };
  for (const [event, list] of Object.entries(into)) {
    socket.on(event, (payload) => {
      list.push(payload);
      inbox.all.push(event);
    });
  }
  return inbox;
}

const disconnectAll = (sockets) => sockets.forEach((s) => s.connected && s.disconnect());

/** Four humans queue for the same control; the 4th starts the match at once. Returns sockets[i], inboxes[i], and `bySeat[seat]` = index into sockets. */
async function fourHumans(name, timeControl = TC3) {
  const sockets = [];
  const inboxes = [];
  for (let i = 0; i < 4; i++) {
    const s = await connect(`${name}${i}`);
    sockets.push(s);
    inboxes.push(record(s));
  }
  const found = sockets.map((s) => waitFor(s, 'bug_match_found'));
  found.forEach((p) => p.catch(() => {}));
  for (const s of sockets) {
    const ack = await emitAck(s, 'bug_join_queue', { timeControl });
    assert.ok(ack.ok === true, `${name}: join refused: ${JSON.stringify(ack)}`);
  }
  const matches = await Promise.all(found);
  const bySeat = [];
  matches.forEach((m, i) => (bySeat[m.seat] = i));
  return { sockets, inboxes, matches, bySeat, roomId: matches[0].roomId };
}

/** The latest match text a socket has seen. */
const latestText = (inbox) => (inbox.states.length > 0 ? inbox.states[inbox.states.length - 1].state : inbox.matchFound[0].state);

/** A legal action for `seat` from the match text (the server's own engine), preferring captures and drops a little; null when it cannot act. */
function pickAction(text, seat) {
  const parsed = deserializeMatch(text);
  if (!parsed.ok) throw new Error(`cannot read the match: ${parsed.error}`);
  const { moves, drops } = legalActions(parsed.match, seat);
  const board = seatPlace(seat).board;
  if (drops.length > 0 && rng() < 0.5) {
    const drop = drops[Math.floor(rng() * drops.length)];
    return { event: 'bug_drop', payload: { board, piece: drop.piece, square: drop.square } };
  }
  if (moves.length === 0) return drops.length === 0 ? null : { event: 'bug_drop', payload: { board, piece: drops[0].piece, square: drops[0].square } };
  const queenOnly = moves.filter((m) => !m.promotion || m.promotion === 'q');
  const move = queenOnly[Math.floor(rng() * queenOnly.length)];
  return { event: 'bug_move', payload: { board, from: move.from, to: move.to, ...(move.promotion ? { promotion: move.promotion } : {}) } };
}

const turnOf = (text, seat) => {
  const parsed = deserializeMatch(text);
  if (!parsed.ok) return false;
  const place = seatPlace(seat);
  return parsed.match.result === null && parsed.match.verdicts[place.board].turn === place.color;
};

/** Every seq that appears in all the given inboxes must carry the very same text; returns { identical, common }. */
function compareStreams(inboxes) {
  const maps = inboxes.map((inbox) => new Map(inbox.states.map((s) => [s.seq, s.state])));
  const common = [...maps[0].keys()].filter((seq) => maps.every((m) => m.has(seq)));
  const identical = common.every((seq) => maps.every((m) => m.get(seq) === maps[0].get(seq)));
  return { identical, common };
}
const strictlyIncreasing = (inbox) => inbox.states.every((s, i) => i === 0 || s.seq === inbox.states[i - 1].seq + 1);

// =====================================================================================================================================

async function testQueueAndFill() {
  console.log('\n=== 1. Queue, the fill wait and the bots ===');
  const sockets = [await connect('Q0'), await connect('Q1')];
  const inboxes = sockets.map(record);
  const found = sockets.map((s) => waitFor(s, 'bug_match_found'));
  found.forEach((p) => p.catch(() => {}));
  const first = await emitAck(sockets[0], 'bug_join_queue', { timeControl: TC3 });
  check(first.ok === true, 'a player queues for 3 min');
  await until('the first update arrived', () => inboxes[0].queueUpdates.length >= 1);
  check(inboxes[0].queueUpdates[0].queued === 1 && inboxes[0].queueUpdates[0].fillInMs === null, 'a lone player is told { queued: 1, fillInMs: null }');
  const again = await emitAck(sockets[0], 'bug_join_queue', { timeControl: TC3 });
  check(again.ok === false && BUG_REJECT_REASONS.includes(again.reason), 'queueing twice is refused with a reason from the closed list');
  const second = await emitAck(sockets[1], 'bug_join_queue', { timeControl: TC3 });
  check(second.ok === true, 'a second player queues');
  await until('both were told about the countdown', () => inboxes.every((b) => b.queueUpdates.some((u) => u.queued === 2 && Number.isFinite(u.fillInMs))));
  check(inboxes.every((b) => b.queueUpdates.some((u) => u.queued === 2 && u.fillInMs > 0 && u.fillInMs <= 30_000)), 'both queued players are told { queued: 2, fillInMs } with a countdown that is at most the production 30 s (the countdown starts when the lobby first holds two)');
  const matches = await Promise.all(found);
  check(matches[0].roomId === matches[1].roomId && matches[0].seat !== matches[1].seat, 'after the fill wait both are in ONE match, on different seats');
  const seats = matches[0].seats;
  check(seats.filter((s) => s.kind === 'human').length === 2 && seats.filter((s) => s.kind === 'bot' && s.botReason === 'fill').length === 2 && seats.every((s, i) => s.seat === i), 'two humans and two fill bots on seats 0..3');
  check(matches[0].playerToken !== matches[1].playerToken && matches[0].seq === 0 && matches[0].state === matches[1].state && matches[0].timeControl.initialMs === 180000, 'each human has its own token; both got the same seq-0 snapshot and the time control');
  check(matches[0].seats[matches[0].seat].kind === 'human' && Number.isFinite(matches[0].serverNowMs), 'the payload names the human\'s own seat and carries the match clock instant');
  const resign = await emitAck(sockets[0], 'bug_resign', { roomId: matches[0].roomId });
  check(resign.ok === true, 'the match is ended by a resignation (so no room is left to run on the server)');
  await until('the game over arrived', () => inboxes.every((b) => b.gameOvers.length === 1));
  disconnectAll(sockets);
}

async function testWholeMatchSync() {
  console.log('\n=== 2. Two humans and two bots play a whole match; every connection holds the same snapshot at every seq ===');
  const sockets = [await connect('M0'), await connect('M1'), await connect('MS')];
  const inboxes = sockets.map(record);
  const humans = [sockets[0], sockets[1]];
  const found = humans.map((s) => waitFor(s, 'bug_match_found'));
  found.forEach((p) => p.catch(() => {}));
  for (const s of humans) assert.ok((await emitAck(s, 'bug_join_queue', { timeControl: TC32 })).ok);
  const matches = await Promise.all(found);
  const roomId = matches[0].roomId;
  const spectate = await emitAck(sockets[2], 'bug_spectate_game', { roomId });
  check(spectate.ok === true && spectate.state.roomId === roomId && spectate.state.seats.length === 4, 'a spectator joins the running match and gets both boards in one snapshot');
  const seatOf = matches.map((m) => m.seat);
  let played = 0;
  let failures = 0;
  const target = 26;
  for (let guard = 0; guard < 4000 && played < target; guard++) {
    let acted = false;
    for (const [i, socket] of humans.entries()) {
      const text = latestText(inboxes[i]);
      if (!turnOf(text, seatOf[i])) continue;
      const action = pickAction(text, seatOf[i]);
      if (!action) continue;
      const ack = await emitAck(socket, action.event, { roomId, ...action.payload });
      if (ack.ok !== true) {
        failures++;
        console.log(`  ! a legal ${action.event} by seat ${seatOf[i]} was refused: ${JSON.stringify(ack)} for ${JSON.stringify(action.payload)}`);
      } else played++;
      acted = true;
    }
    // pacing, not an assertion: two humans on the same board would otherwise trade moves faster than the server's 10-calls-per-second limit allows a person to
    await sleep(acted ? 130 : 40);
    if (inboxes[0].gameOvers.length > 0) break;
  }
  checkConditional(played >= 10, `the humans played ${played} legal actions (moves and drops) while the bots played theirs`);
  check(failures === 0, 'every legal action a human sent was accepted by the server');
  if (inboxes[0].gameOvers.length === 0) {
    const resign = await emitAck(humans[0], 'bug_resign', { roomId });
    assert.ok(resign.ok === true);
  }
  await until('every connection saw the game over', () => inboxes.every((b) => b.gameOvers.length === 1));
  await sleep(150);
  const streams = compareStreams(inboxes);
  check(streams.identical, 'at every seq that two or more connections saw, their snapshots are byte-identical');
  checkConditional(streams.common.length >= 10, `${streams.common.length} seqs were seen by all three connections`);
  check(inboxes.every(strictlyIncreasing), 'on every connection `seq` grows by exactly one per bug_state');
  const last = inboxes[0].states[inboxes[0].states.length - 1];
  check(inboxes.every((b) => b.gameOvers[0].state === last.state) && inboxes.every((b) => b.states[b.states.length - 1].state === last.state), 'the final snapshot and the game over agree on every connection');
  const parsed = deserializeMatch(last.state);
  check(parsed.ok && parsed.match.result !== null && serializeMatch(parsed.match) === last.state, 'the final snapshot reads back through the engine and carries the result');
  check(inboxes[2].chats.length === 0 && inboxes[2].quicks.length === 0, 'the spectator received no chat line and no quick message');
  const moveAsSpectator = await emitAck(sockets[2], 'bug_move', { roomId, board: 'A', from: 'e2', to: 'e4' });
  check(moveAsSpectator.ok === false && moveAsSpectator.reason === 'noGame', 'a spectator cannot move (and the match is over anyway): noGame');
  disconnectAll(sockets);
}

async function testTakeoverAndRejoin() {
  console.log('\n=== 3. Disconnect, takeover by a bot, and the human takes the seat back ===');
  const a = await connect('T0');
  const b = await connect('T1');
  const inboxA = record(a);
  const inboxB = record(b);
  const found = [waitFor(a, 'bug_match_found'), waitFor(b, 'bug_match_found')];
  found.forEach((p) => p.catch(() => {}));
  await emitAck(a, 'bug_join_queue', { timeControl: TC3 });
  await emitAck(b, 'bug_join_queue', { timeControl: TC3 });
  const [foundA, foundB] = await Promise.all(found);
  const { roomId } = foundA;
  a.disconnect();
  await until('B saw A\'s seat disconnected', () => inboxB.seatUpdates.some((u) => u.seats[foundA.seat].connected === false));
  const away = inboxB.seatUpdates.find((u) => u.seats[foundA.seat].connected === false).seats[foundA.seat];
  if (away.graceMsLeft > 15_000) throw new Error(`the server's takeover grace is ${away.graceMsLeft} ms: start the dev server with FOUR_GRACE_MS=1500 (and FOUR_FILL_MS=8000) so this scenario does not wait 45 s (the override is ignored in production)`);
  check(away.kind === 'human' && typeof away.graceMsLeft === 'number', 'the other player is told the seat is disconnected, with the grace left');
  await until('the bot took the seat', () => inboxB.seatUpdates.some((u) => u.seats[foundA.seat].kind === 'bot' && u.seats[foundA.seat].botReason === 'takeover'));
  const taken = inboxB.seatUpdates.find((u) => u.seats[foundA.seat].kind === 'bot').seats[foundA.seat];
  check(taken.botReason === 'takeover' && taken.connected === true && taken.elo === 1200, 'after the grace a bot takes the seat (takeover, Amateur, shown as connected)');
  check(inboxB.gameOvers.length === 0, 'a disconnect never loses the match: it goes on');
  const a2 = await connect('T0b');
  const inboxA2 = record(a2);
  const ack = await emitAck(a2, 'bug_rejoin', { roomId, playerToken: foundA.playerToken });
  check(ack.ok === true && ack.state.seat === foundA.seat && ack.state.roomId === roomId, 'the human rejoins on a NEW socket with the stored room and token: the answer names the seat');
  const restored = deserializeMatch(ack.state.state);
  check(restored.ok && restored.match.seq === ack.state.seq && Number.isFinite(ack.state.serverNowMs) && ack.state.log.every((e) => ['A', 'B'].includes(e.board)), 'the snapshot restores both boards, the pockets and all four clocks (it reads back through the engine), with the match clock instant and the move log');
  await until('B saw the seat human again', () => {
    const latest = inboxB.seatUpdates[inboxB.seatUpdates.length - 1].seats[foundA.seat];
    return latest.kind === 'human' && latest.connected === true;
  });
  const handedBack = inboxB.seatUpdates[inboxB.seatUpdates.length - 1].seats[foundA.seat];
  check(handedBack.kind === 'human' && handedBack.botReason === undefined && handedBack.elo === undefined, 'everyone is told the seat is the human\'s again (hand-back): no bot reason, no bot strength');
  const wrong = await emitAck(await connect('T9'), 'bug_rejoin', { roomId, playerToken: 'not-a-token' });
  check(wrong.ok === false && wrong.reason === 'noGame', 'a wrong token gets nothing');
  const resign = await emitAck(a2, 'bug_resign', { roomId });
  check(resign.ok === true, 'the rejoined human can act: it resigns');
  await until('both saw the game over', () => inboxB.gameOvers.length === 1 && inboxA2.gameOvers.length === 1);
  check(inboxA2.gameOvers[0].result.reason === 'resign', 'the result is a resignation');
  const late = await connect('T0c');
  const finished = await emitAck(late, 'bug_rejoin', { roomId, playerToken: foundB.playerToken });
  check(finished.ok === true && finished.finished === true && finished.gameOver.state === inboxB.gameOvers[0].state, 'a rejoin after the end answers with the result of the finished match (kept for 5 minutes)');
  check(inboxA.gameOvers.length === 0, 'the replaced first connection of the human received nothing after it left');
  disconnectAll([a, a2, b, late]);
}

async function testTeamChatAndQuick() {
  console.log('\n=== 4. Team chat and quick messages: the partner receives, nobody else - every socket\'s events recorded ===');
  const room = await fourHumans('C');
  const spec = await connect('CS');
  const specInbox = record(spec);
  const stranger = await connect('CX');
  const strangerInbox = record(stranger);
  const spectate = await emitAck(spec, 'bug_spectate_game', { roomId: room.roomId });
  check(spectate.ok === true, 'a spectator watches the match');
  const PARTNER = { 0: 3, 1: 2, 2: 1, 3: 0 };
  const everyone = [...room.inboxes, specInbox, strangerInbox];
  const chatsOf = () => everyone.map((b) => b.chats.length);
  // one chat line from each seat, one at a time
  for (const seat of [0, 1, 2, 3]) {
    const sender = room.bySeat[seat];
    const before = chatsOf();
    const ack = await emitAck(room.sockets[sender], 'bug_chat', { roomId: room.roomId, text: `hello from ${seat}`, recipients: [0, 1, 2, 3], to: 'everyone' });
    check(ack.ok === true && ack.delivered === true, `seat ${seat} sends a team chat line (with a forged recipient list): ok, delivered`);
    await until(`seat ${seat}'s line arrived`, () => chatsOf().reduce((a, b) => a + b, 0) === before.reduce((a, b) => a + b, 0) + 2);
    await sleep(150);
    const received = chatsOf().map((n, i) => n - before[i]);
    const recipients = received.map((n, i) => (n > 0 ? i : -1)).filter((i) => i >= 0).sort();
    const expected = [sender, room.bySeat[PARTNER[seat]]].sort();
    check(JSON.stringify(recipients) === JSON.stringify(expected) && received.every((n) => n <= 1), `seat ${seat}: exactly the sender (echo) and its partner received it, once each; the two opponents, the spectator and the stranger received nothing`);
    check(room.inboxes[room.bySeat[PARTNER[seat]]].chats.at(-1).seat === seat && room.inboxes[room.bySeat[PARTNER[seat]]].chats.at(-1).text === `hello from ${seat}`, `...and the partner saw it as seat ${seat}'s line`);
    await sleep(1050); // the chat limit is one line per second per seat; this wait is not an assertion, it only keeps the next sender inside the limit
  }
  // quick messages: partner only
  for (const seat of [0, 1, 2, 3]) {
    const sender = room.bySeat[seat];
    const before = everyone.map((b) => b.quicks.length);
    const ack = await emitAck(room.sockets[sender], 'bug_quick', { roomId: room.roomId, code: 4 + (seat % 3), text: 'free text', recipients: [0, 1, 2, 3] });
    check(ack.ok === true && ack.delivered === true, `seat ${seat} sends a quick message: ok, delivered`);
    await until(`seat ${seat}'s quick message arrived`, () => everyone.map((b) => b.quicks.length).reduce((a, b) => a + b, 0) === before.reduce((a, b) => a + b, 0) + 1);
    await sleep(150);
    const received = everyone.map((b, i) => b.quicks.length - before[i]);
    check(received[room.bySeat[PARTNER[seat]]] === 1 && received.reduce((a, b) => a + b, 0) === 1, `seat ${seat}: only its partner received it - no echo to the sender, nothing for the opponents, the spectator or the stranger`);
    check(Object.keys(room.inboxes[room.bySeat[PARTNER[seat]]].quicks.at(-1)).sort().join() === 'code,seat', '...as { seat, code } and nothing else (never text)');
    await sleep(1550); // (the limit is one per 1.5 s; again only pacing)
  }
  // codes and text outside the closed set
  const badCodes = [-1, 10, 1.5, '3', null, undefined, {}];
  let refused = 0;
  for (const code of badCodes) {
    const ack = await emitAck(room.sockets[room.bySeat[0]], 'bug_quick', { roomId: room.roomId, code });
    if (ack.ok === false && ack.reason === 'invalidRequest') refused++;
  }
  check(refused === badCodes.length, 'quick-message codes outside 0-9 (negative, 10, fractional, text, nothing, an object) are refused with invalidRequest');
  const spectatorChat = await emitAck(spec, 'bug_chat', { roomId: room.roomId, text: 'let me in' });
  const strangerQuick = await emitAck(stranger, 'bug_quick', { roomId: room.roomId, code: 1 });
  check(spectatorChat.ok === false && spectatorChat.reason === 'noGame' && strangerQuick.ok === false && strangerQuick.reason === 'noGame', 'a spectator cannot chat and a stranger cannot send a quick message: noGame');
  // the limits over the wire: back to back (the interval is a second and a half; two requests in one tick cannot be that far apart)
  const sender = room.sockets[room.bySeat[1]];
  const burst = await Promise.all([emitAck(sender, 'bug_chat', { roomId: room.roomId, text: 'one' }), emitAck(sender, 'bug_chat', { roomId: room.roomId, text: 'two' })]);
  checkConditional(burst.filter((a) => a.ok).length === 1 && burst.some((a) => a.ok === false && a.reason === 'rateLimited'), 'two chat lines sent back to back: one is delivered, the other is refused (rateLimited)');
  const resign = await emitAck(room.sockets[room.bySeat[0]], 'bug_resign', { roomId: room.roomId });
  check(resign.ok === true, 'the match is ended by a resignation');
  await until('everyone saw the game over', () => room.inboxes.every((b) => b.gameOvers.length === 1) && specInbox.gameOvers.length === 1);
  check(strangerInbox.all.length === 0, 'the stranger socket received NOTHING at all during the whole scenario - not a state, not a seat update, not a game over');
  disconnectAll([...room.sockets, spec, stranger]);
}

async function testBoardBDecidedWhileAMidMove() {
  console.log('\n=== 5. A match decided on board B while board A is mid-game ===');
  const room = await fourHumans('B');
  const { sockets, inboxes, bySeat, roomId } = room;
  const play = async (seat, board, from, to) => {
    const ack = await emitAck(sockets[bySeat[seat]], 'bug_move', { roomId, board, from, to });
    assert.ok(ack.ok === true, `seat ${seat} ${from}${to}: ${JSON.stringify(ack)}`);
    return ack;
  };
  const a1 = await play(0, 'A', 'e2', 'e4');
  check(a1.seq === 1, 'board A: seat 0 plays 1.e4 (seq 1) - board A is now mid-game, Black to move');
  const scholar = [[2, 'e2', 'e4'], [3, 'e7', 'e5'], [2, 'f1', 'c4'], [3, 'b8', 'c6'], [2, 'd1', 'h5'], [3, 'g8', 'f6']];
  for (const [seat, from, to] of scholar) await play(seat, 'B', from, to);
  const wrongBoard = await emitAck(sockets[bySeat[1]], 'bug_move', { roomId, board: 'B', from: 'e7', to: 'e5' });
  check(wrongBoard.ok === false && wrongBoard.reason === 'wrongBoard', 'a player naming the other board is refused (wrongBoard): the board travels with every move');
  const notTurn = await emitAck(sockets[bySeat[1]], 'bug_move', { roomId, board: 'A', from: 'a7', to: 'a6' });
  check(notTurn.ok === true, 'while board B is being decided, seat 1 can still move on board A (the boards are independent until a result)');
  const dropNothing = await emitAck(sockets[bySeat[0]], 'bug_drop', { roomId, board: 'A', piece: 'q', square: 'd4' });
  check(dropNothing.ok === false && dropNothing.reason === 'dropNotInPocket', 'a drop of a piece that is not in the pocket is refused (dropNotInPocket)');
  const mate = await emitAck(sockets[bySeat[2]], 'bug_move', { roomId, board: 'B', from: 'h5', to: 'f7' });
  check(mate.ok === true, 'seat 2 plays Qxf7# on board B');
  await until('every player saw the game over', () => inboxes.every((b) => b.gameOvers.length === 1));
  const over = inboxes[0].gameOvers[0];
  check(over.result.reason === 'checkmate' && over.result.board === 'B' && over.result.winnerTeam === 2 && over.result.loserSeat === 3, 'the result: checkmate on board B, team 2 wins, seat 3 mated');
  const final = deserializeMatch(over.state);
  check(final.ok && final.match.boards.A.plies === 2 && final.match.boards.B.plies === 7 && final.match.clocks.every((c) => c.runningSince === null), 'board A stays mid-game (2 plies), board B has its 7, and all four clocks are stopped');
  const streams = compareStreams(inboxes);
  check(streams.identical && streams.common.length === 9 && inboxes.every(strictlyIncreasing), 'all four players hold byte-identical snapshots at seq 1..9 (e4 on A, six plies on B, a6 on A, the mate), each stream strictly increasing');
  const mateState = inboxes[0].states.find((s) => s.events.some((e) => e.kind === 'result'));
  check(mateState.events.map((e) => e.kind).join() === 'move,bank,result', 'the mating commit carries the move, the pawn banked for the capturer\'s partner and the result');
  const lateMove = await emitAck(sockets[bySeat[0]], 'bug_move', { roomId, board: 'A', from: 'g1', to: 'f3' });
  check(lateMove.ok === false && lateMove.reason === 'noGame', 'after the end the room is gone: a move is noGame');
  disconnectAll(sockets);
}

async function testResignByTeamMember() {
  console.log('\n=== 6. A resignation loses for the team; every connection is told ===');
  const room = await fourHumans('R');
  const loser = room.bySeat[1];
  const ack = await emitAck(room.sockets[loser], 'bug_resign', { roomId: room.roomId });
  check(ack.ok === true, 'seat 1 (team 2) resigns off turn');
  await until('all saw the game over', () => room.inboxes.every((b) => b.gameOvers.length === 1));
  const result = room.inboxes[0].gameOvers[0].result;
  check(result.reason === 'resign' && result.winnerTeam === 1 && result.loserSeat === 1 && result.board === 'A', 'team 1 wins by resignation; the deciding board is the resigner\'s (A)');
  const states = room.inboxes.map((b) => b.states.length);
  check(states.every((n) => n === 1), 'one bug_state (the resignation commit) then one bug_game_over on every connection');
  disconnectAll(room.sockets);
}

async function testHostilePayloads() {
  console.log('\n=== 7. Hostile payloads over the wire never crash the server or leak ===');
  const s = await connect('H0');
  const payloads = [undefined, null, 0, 'x', [], {}, { roomId: 5 }, { roomId: 'nope', board: 'A', from: 'e2', to: 'e4' }, { roomId: 'x'.repeat(100) }, { timeControl: { initialMs: 1, incrementMs: 1 } }];
  const events = ['bug_join_queue', 'bug_move', 'bug_drop', 'bug_resign', 'bug_rejoin', 'bug_chat', 'bug_quick', 'bug_spectate_game'];
  let answered = 0;
  let wellFormed = 0;
  for (const event of events) {
    for (const payload of payloads) {
      const ack = await emitAck(s, event, payload).catch(() => null);
      if (ack !== null) answered++;
      if (ack && ack.ok === false && BUG_REJECT_REASONS.includes(ack.reason) && typeof ack.error === 'string') wellFormed++;
    }
  }
  check(answered === events.length * payloads.length && wellFormed === answered, `${answered} hostile requests: every one is answered with a refusal that names a reason from the closed list`);
  const alive = await emitAck(s, 'bug_list_active_games', {});
  check(alive.ok === true && Array.isArray(alive.games), 'the server is alive and still lists games');
  const noAck = await new Promise((resolve) => {
    s.emit('bug_leave_queue');
    s.emit('bug_move', { roomId: 'x' });
    s.emit('bug_resign', undefined, 'not-a-function');
    setTimeout(() => resolve('survived'), 200);
  });
  check(noAck === 'survived' && s.connected, 'requests with no ack, or an ack that is not a function, do not drop the connection');
  const list = alive.games.map((g) => JSON.stringify(g)).join('');
  check(!/playerToken/.test(list), 'the active-games list carries no token');
  s.disconnect();
}

async function testLobbiesNeverMix() {
  console.log('\n=== 8. Bughouse and 4 Player queues never mix, at the same time control ===');
  const bug = [await connect('X0'), await connect('X1')];
  const four = [await connect('Y0'), await connect('Y1')];
  const bugInbox = bug.map(record);
  const fourEvents = four.map(() => []);
  four.forEach((s, i) => {
    for (const e of ['four_match_found', 'four_queue_update', 'four_state']) s.on(e, (p) => fourEvents[i].push([e, p]));
    s.onAny((name) => fourEvents[i].push([`any:${name}`]));
  });
  const bugFound = bug.map((s) => waitFor(s, 'bug_match_found'));
  bugFound.forEach((p) => p.catch(() => {}));
  const fourFound = four.map((s) => waitFor(s, 'four_match_found', 45_000));
  fourFound.forEach((p) => p.catch(() => {}));
  for (const s of bug) assert.ok((await emitAck(s, 'bug_join_queue', { timeControl: TC3 })).ok);
  for (const s of four) assert.ok((await emitAck(s, 'four_join_queue', { timeControl: { initialSeconds: 180, incrementSeconds: 0 } })).ok);
  const [bugMatch] = await Promise.all(bugFound);
  const fourMatch = await Promise.all(fourFound);
  check(bugMatch.roomId !== fourMatch[0].roomId && fourMatch[0].roomId === fourMatch[1].roomId, 'two Bughouse humans and two 4 Player humans at the same time control end up in two different matches, each with its own pair');
  check(bugMatch.seats.length === 4 && fourMatch[0].seats.length === 4 && fourMatch[0].variant === 'ffa', 'each match has four seats; the 4-seat one is 4 Player Chess');
  check(bugInbox.every((b) => b.all.every((e) => e.startsWith('bug_'))) && fourEvents.every((list) => list.every(([name]) => name.startsWith('four_') || name.startsWith('any:four_'))), 'every socket received only events of its own protocol');
  const resign = await emitAck(bug[0], 'bug_resign', { roomId: bugMatch.roomId });
  check(resign.ok === true, 'the Bughouse match is ended');
  const fourResign = await emitAck(four[0], 'four_resign', { roomId: fourMatch[0].roomId });
  check(fourResign.ok === true, '...and the 4 Player one');
  disconnectAll([...bug, ...four]);
}

async function main() {
  console.log(`Connecting to ${SERVER_URL} (move seed ${SEED}) ...`);
  await testQueueAndFill();
  await testWholeMatchSync();
  await testTakeoverAndRejoin();
  await testTeamChatAndQuick();
  await testBoardBDecidedWhileAMidMove();
  await testResignByTeamMember();
  await testHostilePayloads();
  await testLobbiesNeverMix();

  console.log(`\nAll good — ${passedChecks} checks passed (conditional: ${conditionalChecks}, counted apart: their number depends on the unseeded bots and seats).`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\nTEST FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
