#!/usr/bin/env node
/**
 * End-to-end test for 4 Player Chess ONLINE (workstream W6): connects to an ALREADY RUNNING backend as FOUR plain socket.io-client "players"
 * per room (plus a fifth, seat-less socket as a spectator where a scenario needs one) and exercises the real `four_*` protocol, exactly as the
 * app would. No mocking: this is the actual server, the actual matchmaker and room manager, over actual sockets.
 *
 * WHY IT EXISTS. Every other 4 Player script (test-fourplayer-handlers.mjs, -rooms, -bots, -matchmaking, and the app's own tests) runs the
 * server logic in-process on stub sockets, or runs a client against a fake socket. None of them holds FOUR INDEPENDENT REAL CONNECTIONS to
 * the same room, so none can prove the invariant the whole feature rests on: after every state change, all four players (and a spectator)
 * hold byte-identical snapshots with the same `seq`. Scenario 2 is that proof; the others check the rest of the protocol the same way.
 *
 * Usage:
 *   FOUR_GRACE_MS=1500 npm run dev       (in one terminal, from backend/ - the shortened takeover grace is what scenario 4 needs;
 *                                         the override is ignored when NODE_ENV=production)
 *   npm run test:fourplayerOnline        (in another)
 *
 * Runs under tsx (not plain node, unlike test-multiplayer.mjs) because legal moves come from the GENERATED TypeScript mirror of the 4 Player
 * engine (src/game/fourPlayer/index.ts) - the same code the server runs, which is the point here: transport and synchronisation, not rules
 * (rules parity with the app's own engine is test-fourplayer.mjs's job; the nightly fuzz uses the app's engine as an independent client).
 *
 * BACKEND_URL env var overrides the default http://localhost:3000. FOUR_E2E_SEED (a number) reseeds the pseudo-random move choice.
 *
 * NOTE ON ONE SHAPE. The 2-player server answers a rejoin of a finished game with a REFUSAL carrying `finished: true` (an older client had to be
 * kept working). The 4 Player protocol is new, so a finished room is a plain SUCCESS: `{ ok: true, finished: true, gameOver }` (see
 * FourRejoinFinished in fourPlayerWire.ts and FOUR_PLAYER_ONLINE_SPEC.md section 3). Scenario 6 pins THAT.
 */
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
import { PLAYABLE_SQUARES, BISHOP, KNIGHT, QUEEN, ROOK, deserialize, legalMoves, promotionOf, squareName } from '../src/game/fourPlayer/index.ts';

const SERVER_URL = process.env.BACKEND_URL ?? 'http://localhost:3000';
const SEED = Number(process.env.FOUR_E2E_SEED ?? 20260101);
let passedChecks = 0;

function check(condition, message) {
  assert.ok(condition, message);
  passedChecks++;
  console.log(`  ✓ ${message}`);
}

function connect(name) {
  return new Promise((resolve, reject) => {
    const socket = io(SERVER_URL, { transports: ['websocket'], reconnection: false });
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

/**
 * Resolves with the next `event` on `socket` — and, because `socket.once` only sees events that arrive AFTER it is
 * called, THE LISTENER MUST BE ATTACHED BEFORE the emit that provokes the event.
 *
 * THE TRAP (it failed the nightly once in ~800 pairings, as 'timed out waiting for "match_found"'): the second
 * player's join_queue makes the server send the ack and match_found back to back. If both frames arrive in one network
 * read (a busy CI runner), the socket parses them in a single synchronous pass: the ack callback only QUEUES the
 * awaiting code, and match_found fires before it runs — with nobody listening yet. Writing
 * `await emitAck(join_queue); return waitFor(match_found)` is therefore a race; register the listener first.
 * (Not a server bug: the real app keeps a permanent match_found listener.)
 */
function waitFor(socket, event, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

// --- Helpers specific to a four-socket room --------------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls until `test()` is truthy (the events of FOUR sockets arrive independently, so "the next event on one socket" is not enough). */
async function until(what, test, timeoutMs = 6000) {
  const t0 = Date.now();
  while (!test()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting until ${what}`);
    await sleep(10);
  }
}

/**
 * Records every four_* event a socket receives from the moment it is attached (attach it right after connect(), BEFORE any emit - the same
 * rule as waitFor), so a scenario can ask afterwards "what did THIS player see, in what order" for all four sockets at once.
 */
function record(socket) {
  const inbox = { matchFound: [], queueUpdates: [], states: [], seatUpdates: [], gameOvers: [], chats: [] };
  socket.on('four_match_found', (p) => inbox.matchFound.push(p));
  socket.on('four_queue_update', (p) => inbox.queueUpdates.push(p));
  socket.on('four_state', (p) => inbox.states.push(p));
  socket.on('four_seat_update', (p) => inbox.seatUpdates.push(p));
  socket.on('four_game_over', (p) => inbox.gameOvers.push(p));
  socket.on('four_chat_message', (p) => inbox.chats.push(p));
  return inbox;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);

const TIME_CONTROL = { initialSeconds: 300, incrementSeconds: 0 };
const TIME_CONTROL_LABEL = '5 min';
const PROMOTION_LETTER = { [QUEEN]: 'q', [ROOK]: 'r', [BISHOP]: 'b', [KNIGHT]: 'n' };

/**
 * Four guests join the queue for the same time control; the 4th starts the game at once. Resolves with a room handle:
 * `players[seat]` = { socket, inbox, match, name } indexed by the SEAT the server assigned (seats are shuffled), `roomId`.
 */
async function startRoom(label) {
  const names = [0, 1, 2, 3].map((i) => `${label}${i}`);
  const sockets = [];
  for (const name of names) sockets.push(await connect(name));
  const inboxes = sockets.map(record);
  const found = sockets.map((s) => waitFor(s, 'four_match_found')); // BEFORE the emits - see waitFor's doc comment
  found.forEach((p) => p.catch(() => {})); // no unhandled rejection if a join fails first; the caller still sees it
  for (let i = 0; i < 4; i++) {
    const ack = await emitAck(sockets[i], 'four_join_queue', { timeControl: TIME_CONTROL, timeControlLabel: TIME_CONTROL_LABEL });
    check(ack.ok === true, `${names[i]} four_join_queue ack is ok`);
  }
  const matches = await Promise.all(found);
  const players = [];
  matches.forEach((match, i) => {
    players[match.seat] = { socket: sockets[i], inbox: inboxes[i], match, name: names[i] };
  });
  return { roomId: matches[0].roomId, players, sockets, names };
}

/** The room's current position as the server last sent it to seat `seat`'s player (state, seq), or the match-found snapshot before any move. */
function latestOf(player) {
  const last = player.inbox.states.at(-1);
  return last ? { seq: last.seq, text: last.state, payload: last } : { seq: 0, text: player.match.state, payload: null };
}

/** Picks one legal move for `seat` from `text` (a serialized snapshot), pseudo-randomly; returns the four_make_move payload parts. */
function pickMove(text, seat) {
  const state = deserialize(text);
  assert.equal(state.turn, seat, 'pickMove: it must be that seat\'s turn');
  const moves = legalMoves(state, seat);
  assert.ok(moves.length > 0, 'pickMove: the seat on move has a legal move');
  const move = moves[Math.floor(rng() * moves.length)];
  const promotion = PROMOTION_LETTER[promotionOf(move)];
  return { from: squareName(move.from), to: squareName(move.to), ...(promotion ? { promotion } : {}) };
}

/** Whose turn it is according to the position the server last sent (every player holds the same one - scenario 2 proves it). */
const turnOf = (room) => deserialize(latestOf(room.players[0]).text).turn;

/** Plays one legal move for the seat on move, from THAT player's own socket; resolves with the move sent and the server's ack. */
async function playOne(room) {
  const seat = turnOf(room);
  const player = room.players[seat];
  // The mover chooses from ITS OWN copy of the position (as a real client does), so that copy must have caught up with the one turnOf() read.
  await until(`seat ${seat} has caught up with seat 0`, () => latestOf(player).seq >= latestOf(room.players[0]).seq);
  const move = pickMove(latestOf(player).text, seat);
  const ack = await emitAck(player.socket, 'four_make_move', { roomId: room.roomId, ...move });
  // The ack and the four_state it caused travel on different sockets, so the NEXT call to turnOf() (which reads seat 0's inbox) must not run before
  // seat 0 has actually received that state - otherwise two back-to-back moves read a stale turn (an earlier version of scenario 4 flaked on exactly this).
  if (ack.ok) await until(`seat 0 has four_state seq ${ack.seq}`, () => latestOf(room.players[0]).seq >= ack.seq);
  return { seat, move, ack };
}

/** Waits until every listed player has received the four_state with `seq`. */
const waitForSeq = (players, seq, timeoutMs) => until(`every player has four_state seq ${seq}`, () => players.every((p) => p.inbox.states.some((s) => s.seq === seq)), timeoutMs);

const disconnectAll = (...sockets) => sockets.flat().forEach((s) => s.connected && s.disconnect());

// --- Scenarios -------------------------------------------------------------------------------------------------------------------------

async function testQueueAndMatchFound() {
  console.log('\n=== 1. Queue and match found: four sockets, one room, four distinct seats ===');
  const names = ['Q0', 'Q1', 'Q2', 'Q3'];
  const sockets = [];
  for (const name of names) sockets.push(await connect(name));
  const inboxes = sockets.map(record);

  // Unlimited and Daily are refused over the wire (the live-play range is the only idle guard there is).
  const unlimited = await emitAck(sockets[0], 'four_join_queue', { timeControl: { initialSeconds: 0, incrementSeconds: 0 } });
  check(unlimited.ok === false && typeof unlimited.error === 'string', 'four_join_queue with "No time limit" (0 s) is refused');
  const daily = await emitAck(sockets[0], 'four_join_queue', { timeControl: { initialSeconds: 86400, incrementSeconds: 0 } });
  check(daily.ok === false, 'four_join_queue with a Daily time control is refused');

  const found = sockets.map((s) => waitFor(s, 'four_match_found')); // BEFORE the emits - see waitFor's doc comment
  found.forEach((p) => p.catch(() => {}));
  for (let i = 0; i < 3; i++) {
    const ack = await emitAck(sockets[i], 'four_join_queue', { timeControl: TIME_CONTROL, timeControlLabel: TIME_CONTROL_LABEL });
    check(ack.ok === true, `${names[i]} joined the queue`);
    if (i === 0) {
      const again = await emitAck(sockets[0], 'four_join_queue', { timeControl: TIME_CONTROL });
      check(again.ok === false, 'a socket that is already queued cannot queue again');
    }
  }
  // Three are waiting: every queued socket was told, and with >= 2 the fill countdown is running.
  await until('all three queued sockets saw 3 waiting', () => inboxes.slice(0, 3).every((b) => b.queueUpdates.some((u) => u.queued === 3)));
  const three = inboxes[0].queueUpdates.find((u) => u.queued === 3);
  check(Number.isFinite(three.fillInMs) && three.fillInMs > 0 && three.fillInMs <= 30_000, `four_queue_update with 3 waiting carries a fill countdown (${three.fillInMs} ms, never more than the 30 s default)`);
  const one = inboxes[0].queueUpdates.find((u) => u.queued === 1);
  check(one && one.fillInMs === null, '...and with 1 waiting there is no countdown (a lone player waits)');
  check(inboxes.every((b) => b.matchFound.length === 0), 'no game started with only three humans (the fill timer, not an early start, decides that)');

  // The 4th human starts it at once.
  const t0 = Date.now();
  const ack4 = await emitAck(sockets[3], 'four_join_queue', { timeControl: TIME_CONTROL, timeControlLabel: TIME_CONTROL_LABEL });
  check(ack4.ok === true, 'the 4th player joined the queue');
  const matches = await Promise.all(found);
  check(Date.now() - t0 < 3000, `the 4th human started the game immediately (${Date.now() - t0} ms, not the fill wait)`);

  check(new Set(matches.map((m) => m.roomId)).size === 1, 'all four players were placed in the same room');
  check(matches.every((m) => m.seq === 0), 'every four_match_found carries seq 0');
  check(new Set(matches.map((m) => m.seat)).size === 4 && matches.every((m) => [0, 1, 2, 3].includes(m.seat)), `four distinct seats 0-3 were assigned (${matches.map((m) => m.seat).join(',')})`);
  check(new Set(matches.map((m) => m.state)).size === 1, 'all four starting snapshots are byte-identical');
  check(new Set(matches.map((m) => m.playerToken)).size === 4 && matches.every((m) => typeof m.playerToken === 'string' && m.playerToken.length >= 32), 'each player got their OWN token');
  check(matches.every((m) => m.seats.length === 4 && m.seats.every((s, i) => s.seat === i && s.kind === 'human' && s.connected === true)), 'every player sees four connected human seats (no bots: four humans fill the table)');
  check(matches.every((m) => JSON.stringify(m.timeControl) === JSON.stringify(TIME_CONTROL) && m.timeControlLabel === TIME_CONTROL_LABEL), 'the time control and its label arrive as queued');
  // The snapshot is a live reading: the seat on move (Red) has already spent whatever few milliseconds passed between the room being created and the
  // clocks being read, so its figure is 300000 minus a hair - never more, never a full second less. The other three are untouched. (An earlier version
  // of this check demanded exactly 300000 for all four and failed whenever a millisecond had passed: a flaw in the test, not the server.)
  check(
    matches.every((m) => m.clocksMs.length === 4 && m.clocksMs[0] <= 300_000 && m.clocksMs[0] >= 299_000 && m.clocksMs.slice(1).every((c) => c === 300_000)),
    `the clocks start at 300 s: the three seats waiting are untouched and the seat on move has spent only a moment (${JSON.stringify(matches[0].clocksMs)})`
  );
  // The whole starting snapshot is ONE snapshot: apart from the per-player seat number and token, the four payloads are identical. (The clocks
  // used to differ by a millisecond or two between players - the seat on move had already spent a moment of its turn by the time the later
  // recipients' copies were built; found by this very check, fixed in createRoom, pinned by test-fourplayer-rooms.mjs section 9.)
  const strip = (m) => JSON.stringify({ ...m, seat: undefined, playerToken: undefined });
  check(new Set(matches.map(strip)).size === 1, 'apart from their own seat number and token, the four four_match_found payloads are identical (clocks included)');
  const start = deserialize(matches[0].state);
  check(start.turn === 0 && start.ply === 0 && start.result === null, 'Red (seat 0) is to move in the starting position');
  // Nothing private travels with the shared fields: the seats list carries no token / socket id / user id.
  const leaked = JSON.stringify(matches[0].seats);
  check(!matches.some((m) => leaked.includes(m.playerToken)) && !/socketId|userId|playerToken/.test(leaked), 'the seats list leaks no token, socket id or user id');

  // A queued socket can leave: a 5th socket joins, then leaves, and is no longer queued.
  const fifth = await connect('Q4');
  check((await emitAck(fifth, 'four_join_queue', { timeControl: { initialSeconds: 180, incrementSeconds: 2 } })).ok === true, 'a 5th socket queues for a DIFFERENT time control (queues never mix)');
  check((await emitAck(fifth, 'four_leave_queue', {})).ok === true, '...and can leave the queue');
  disconnectAll(sockets, fifth);
}

async function testMoveSyncIsIdentical() {
  console.log('\n=== 2. Move sync: after every four_state all four players hold the IDENTICAL snapshot and seq ===');
  const room = await startRoom('M');
  const PLIES = 18;
  let seq = 0;
  for (let ply = 1; ply <= PLIES; ply++) {
    const { seat, move, ack } = await playOne(room);
    if (!ack.ok) throw new Error(`ply ${ply}: seat ${seat} move ${move.from}-${move.to} was refused: ${ack.error}`);
    seq = ack.seq;
    await waitForSeq(room.players, seq);
    const copies = room.players.map((p) => p.inbox.states.find((s) => s.seq === seq));
    const same = copies.every((c) => c.state === copies[0].state && c.seq === copies[0].seq && c.actor === copies[0].actor);
    check(same && seq === ply, `ply ${ply} (seat ${seat}, ${move.from}-${move.to}): all four sockets hold the byte-identical snapshot at seq ${seq}`);
    check(copies[0].actor === 'human' && copies[0].move && copies[0].move.seat === seat && copies[0].move.from === move.from && copies[0].move.to === move.to, `...and four_state names the mover and the move correctly`);
    if (deserialize(copies[0].state).result) break;
  }
  // Contiguity and ordering, per socket, over the whole game so far.
  for (const p of room.players) {
    const seqs = p.inbox.states.map((s) => s.seq);
    check(seqs.every((s, i) => s === i + 1) && seqs.length === seq, `seat ${p.match.seat} received seq 1..${seq} in order, with no gap and no duplicate`);
  }
  // Clocks are part of the same snapshot message and are identical too (the mover paid, increments are 0).
  const lastClocks = room.players.map((p) => JSON.stringify(p.inbox.states.at(-1).clocksMs));
  check(new Set(lastClocks).size === 1, 'the clocks in the last four_state are identical for all four players');
  // The ack's seq is the seq of the broadcast it caused.
  const ackedAgain = await playOne(room);
  check(ackedAgain.ack.ok === true && ackedAgain.ack.seq === seq + 1, 'a move\'s ack carries the seq of the four_state it produced');
  disconnectAll(room.sockets);
}

async function testIllegalAndOutOfTurnMovesRefused() {
  console.log('\n=== 3. Illegal and out-of-turn moves are refused - and change nothing for anyone ===');
  const room = await startRoom('I');
  const { players, roomId } = room;
  const start = latestOf(players[0]).text;
  const state = deserialize(start);
  const redMoves = legalMoves(state, 0);
  const own = redMoves[0];
  const blueMove = legalMoves(state, 1)[0];
  const send = (seat, payload) => emitAck(players[seat].socket, 'four_make_move', payload);
  const legal = { roomId, from: squareName(own.from), to: squareName(own.to) };
  // The server allows 10 four_make_move calls per second per seat and counts REFUSED ones too, so the probes are paced in batches of fewer
  // than 10 per seat per second: otherwise a probe could be "refused" for the rate limit instead of the reason it is testing.
  const batchPause = () => sleep(1100);

  // Batch A (seat 0: 8 calls, seat 1: 1 call)
  const outOfTurn = await send(1, { roomId, from: squareName(blueMove.from), to: squareName(blueMove.to) });
  check(outOfTurn.ok === false && outOfTurn.error === 'Not your turn.', 'a legal move out of turn is refused: "Not your turn."');
  const otherSeatPiece = await send(0, { roomId, from: squareName(blueMove.from), to: squareName(blueMove.to) });
  check(otherSeatPiece.ok === false && otherSeatPiece.error === 'Illegal move.', 'moving another seat\'s piece is refused (the seat comes from the socket, never from the payload)');
  const legalTos = new Set(redMoves.filter((m) => m.from === own.from).map((m) => m.to));
  const unreachable = PLAYABLE_SQUARES.find((s) => s !== own.from && !legalTos.has(s));
  const illegal = await send(0, { roomId, from: squareName(own.from), to: squareName(unreachable) });
  check(illegal.ok === false && illegal.error === 'Illegal move.', `an illegal destination (${squareName(own.from)}-${squareName(unreachable)}) is refused: "Illegal move."`);
  for (const bad of ['e02', 'z9', 'A1', 'e2e4', 'a1']) {
    const ack = await send(0, { roomId, from: bad, to: legal.to });
    check(ack.ok === false && ack.error === 'Invalid move.', `a malformed or off-board square ${JSON.stringify(bad)} is refused: "Invalid move."`);
  }
  await batchPause();

  // Batch B (seat 0: 9 calls)
  for (const promotion of ['x', 'k', 'Q', 'queen', '', 5]) {
    const ack = await send(0, { ...legal, promotion });
    check(ack.ok === false && ack.error === 'Invalid promotion piece.', `a bad promotion piece ${JSON.stringify(promotion)} is refused, even on a legal move: "Invalid promotion piece."`);
  }
  const wrongRoom = await send(0, { ...legal, roomId: 'not-a-room' });
  check(wrongRoom.ok === false, 'a move for a room that does not exist is refused');
  check((await send(0, 'e2e4')).ok === false && (await send(0, null)).ok === false, 'a payload that is not an object is refused');
  await batchPause();

  // The rate limit itself: a burst of illegal calls is cut off, and the cut-off is announced as such.
  const burst = [];
  for (let i = 0; i < 14; i++) burst.push(await send(0, { roomId, from: squareName(own.from), to: squareName(unreachable) }));
  const judged = burst.filter((a) => a.error === 'Illegal move.').length;
  const limited = burst.filter((a) => a.error === 'Too many moves - slow down.').length;
  check(burst.every((a) => a.ok === false) && burst.slice(0, 10).every((a) => a.error === 'Illegal move.') && limited >= 1 && judged + limited === 14, `a burst of 14 calls in about a second: the first 10 are judged, the rest are cut off with "Too many moves - slow down." (${judged} judged, ${limited} cut off)`);
  await batchPause();

  // NOTHING reached anybody: no four_state, no seat update, no game over - the room is exactly as it was.
  check(players.every((p) => p.inbox.states.length === 0 && p.inbox.seatUpdates.length === 0 && p.inbox.gameOvers.length === 0), 'no four_state, four_seat_update or four_game_over reached any of the four players');
  // ...and the room still works: the legal move is accepted as seq 1 and reaches all four.
  const good = await send(0, legal);
  check(good.ok === true && good.seq === 1, 'the legal move is then accepted as seq 1 (the refusals did not disturb the room)');
  await waitForSeq(players, 1);
  check(new Set(players.map((p) => p.inbox.states[0].state)).size === 1 && players.every((p) => p.inbox.states.length === 1), 'it reached all four players exactly once, identically');
  disconnectAll(room.sockets);
}

async function testDisconnectGraceTakeoverRetake() {
  console.log('\n=== 4. Disconnect -> grace -> bot takeover -> the original player retakes the seat ===');
  const room = await startRoom('D');
  const { players, roomId } = room;
  // Two moves in, so this is a game in progress and not a fresh room.
  for (let i = 0; i < 2; i++) {
    const { ack } = await playOne(room);
    check(ack.ok === true, `opening move ${i + 1} accepted`);
  }
  await waitForSeq(players, 2);
  check(turnOf(room) === 2, 'seat 2 is to move');

  // Seat 3 (not on move) drops off the network.
  const victim = 3;
  const victimName = players[victim].match.seats[victim].name;
  const others = [0, 1, 2].map((s) => players[s]);
  const seatUpdatesBefore = others.map((p) => p.inbox.seatUpdates.length);
  players[victim].socket.disconnect();
  await until('the other three were told seat 3 is away', () => others.every((p, i) => p.inbox.seatUpdates.length > seatUpdatesBefore[i]));
  const away = others[0].inbox.seatUpdates.at(-1).seats[victim];
  check(others.every((p) => p.inbox.seatUpdates.at(-1).seats[victim].connected === false), 'the other three got a four_seat_update with seat 3 connected: false');
  check(away.kind === 'human' && Number.isFinite(away.graceMsLeft) && away.graceMsLeft > 0, `...still a human, with graceMsLeft counting down (${away.graceMsLeft} ms)`);
  if (away.graceMsLeft > 15_000) {
    throw new Error(`the server's takeover grace is ${away.graceMsLeft} ms: start the dev server with FOUR_GRACE_MS=1500 so this scenario does not wait 45 s (the override is ignored in production)`);
  }
  const expectedGrace = away.graceMsLeft;
  check(!JSON.stringify(away).includes(players[victim].match.playerToken), '...and the announcement carries no token');

  // Seat 2 moves; now it is seat 3's turn, and it is away: the game waits for the grace to run out.
  const two = await playOne(room);
  check(two.ack.ok === true && two.seat === 2, 'seat 2 moved while seat 3 is away');
  const t0 = Date.now();
  await until('the takeover is announced', () => others.every((p) => p.inbox.seatUpdates.some((u) => u.seats[victim].kind === 'bot')), expectedGrace + 5000);
  const taken = others[0].inbox.seatUpdates.find((u) => u.seats[victim].kind === 'bot').seats[victim];
  check(taken.botReason === 'takeover' && taken.name === victimName && taken.connected === true && taken.graceMsLeft === undefined, `after ~${Date.now() - t0} ms of waiting the seat became a bot (reason takeover) that keeps the player's name "${victimName}" and has no countdown`);
  check(taken.elo === 1200, '...an Amateur (ELO 1200) bot');
  // The bot plays seat 3's turn by itself.
  await until('the takeover bot has moved', () => others.every((p) => p.inbox.states.some((s) => s.actor === 'bot')), 6000);
  const botState = others[0].inbox.states.find((s) => s.actor === 'bot');
  check(botState.move && botState.move.seat === victim, 'the bot moved for seat 3 (four_state actor "bot")');
  const afterBot = botState.seq;
  await waitForSeq(others, afterBot);
  check(new Set(others.map((p) => p.inbox.states.find((s) => s.seq === afterBot).state)).size === 1, '...and the three remaining players hold the identical snapshot after it');

  // The original player comes back on a NEW connection with the token from four_match_found, mid-game.
  const back = await connect('D3-back');
  const backInbox = record(back);
  const rejoin = await emitAck(back, 'four_rejoin', { roomId, playerToken: players[victim].match.playerToken });
  check(rejoin.ok === true && !rejoin.finished && rejoin.state.seat === victim, 'four_rejoin with the original token succeeds and returns seat 3');
  const seatsAfter = rejoin.state.seats;
  check(seatsAfter[victim].kind === 'human' && seatsAfter[victim].connected === true, '...and the seat is the human\'s again (the bot let go)');
  const liveSeq = others[0].inbox.states.at(-1).seq;
  check(rejoin.state.seq === liveSeq && rejoin.state.state === others[0].inbox.states.at(-1).state, `...with exactly the room's current snapshot (seq ${liveSeq})`);
  await until('the others were told seat 3 is back', () => others.every((p) => p.inbox.seatUpdates.at(-1).seats[victim].kind === 'human' && p.inbox.seatUpdates.at(-1).seats[victim].connected === true));
  check(true, 'the other three got a four_seat_update showing seat 3 human and connected again');
  // A different seat's token does not give this socket seat 3's powers: a bogus token is refused.
  const stranger = await connect('D-stranger');
  const bogus = await emitAck(stranger, 'four_rejoin', { roomId, playerToken: 'not-a-real-token' });
  check(bogus.ok === false, 'a rejoin with a token that belongs to nobody is refused');
  stranger.disconnect();

  // The retaken seat really plays: run the table round to seat 3's turn, then move FROM THE NEW SOCKET.
  // The rejoined socket's inbox only records what arrives AFTER it attached, so it starts from the snapshot the rejoin answered with (marked as such).
  backInbox.states.push({ roomId, seq: rejoin.state.seq, actor: 'rejoin', move: null, events: [], state: rejoin.state.state, clocksMs: rejoin.state.clocksMs });
  players[victim] = { ...players[victim], socket: back, inbox: backInbox };
  let guard = 0;
  while (turnOf({ players: [{ inbox: others[0].inbox, match: players[0].match }] }) !== victim && guard++ < 6) {
    const res = await playOne(room);
    check(res.ack.ok === true, `seat ${res.seat} moved to bring the turn round to seat 3`);
    await waitForSeq([...others, players[victim]], res.ack.seq);
  }
  const mine = await playOne(room);
  check(mine.seat === victim && mine.ack.ok === true, 'seat 3\'s turn: the move from the NEW socket is accepted (the player has the seat back)');
  await waitForSeq([...others, players[victim]], mine.ack.seq);
  const reply = others[0].inbox.states.find((s) => s.seq === mine.ack.seq);
  check(reply.actor === 'human' && reply.move.seat === victim, '...and it is broadcast as a HUMAN move by seat 3 (not by the bot)');
  disconnectAll(room.sockets, back);
}

async function testResignAndGameOver() {
  console.log('\n=== 5. Resign -> the game continues -> four_game_over reaches every seat AND the spectator, consistently ===');
  const room = await startRoom('R');
  const { players, roomId } = room;
  const spectator = await connect('R-spectator');
  const specInbox = record(spectator);
  const specAck = await emitAck(spectator, 'four_spectate_game', { roomId });
  check(specAck.ok === true && specAck.state.seq === 0, 'a spectator joined at seq 0');

  // Seat 3 resigns while it is not its turn; the game goes on without it.
  const r3 = await emitAck(players[3].socket, 'four_resign', { roomId });
  check(r3.ok === true, 'seat 3 resigned (off its turn)');
  await until('the resignation state reached everyone', () => players.every((p) => p.inbox.states.length >= 1) && specInbox.states.length >= 1);
  const resignState = specInbox.states[0];
  check(resignState.actor === 'resign' && resignState.move === null, 'the resignation is a four_state with actor "resign" and no move');
  const afterResign = deserialize(resignState.state);
  check(afterResign.status[3] !== 'active' && afterResign.result === null, 'seat 3 is out and the game is NOT over');
  check(players.every((p) => p.inbox.states[0].state === resignState.state), 'all four players and the spectator hold the identical snapshot');

  // Some more moves by the remaining seats prove the game really continues (turns skip seat 3; its king may be walked by the engine) - and give
  // the pieces a chance to capture, so the final scores are not all zero.
  for (let i = 0; i < 9; i++) {
    const res = await playOne(room);
    check(res.ack.ok === true && res.seat !== 3, `the game continues: seat ${res.seat} moved (move ${i + 1} of 9 since the resignation)`);
    await waitForSeq(players, res.ack.seq);
  }

  // Two more resign: three seats out ends the game.
  const live = [0, 1, 2];
  const resignSeat = live[Math.floor(rng() * 3)];
  const second = (await emitAck(players[resignSeat].socket, 'four_resign', { roomId })).ok;
  const resignSeat2 = live.find((s) => s !== resignSeat);
  const third = (await emitAck(players[resignSeat2].socket, 'four_resign', { roomId })).ok;
  check(second === true && third === true, `seats ${resignSeat} and ${resignSeat2} resigned too`);
  await until('four_game_over reached all four seats and the spectator', () => players.every((p) => p.inbox.gameOvers.length === 1) && specInbox.gameOvers.length === 1);
  const over = specInbox.gameOvers[0];
  check(players.every((p) => JSON.stringify(p.inbox.gameOvers[0]) === JSON.stringify(over)), 'the four_game_over each seat received (eliminated ones included) is identical to the spectator\'s');
  check(over.roomId === roomId && over.reason === 'elimination' && Array.isArray(over.winners) && over.winners.length >= 1, `reason "elimination" with ${over.winners.length} winner(s): seat(s) ${over.winners.join(',')}`);
  const finalState = deserialize(over.state);
  check(finalState.result !== null && JSON.stringify(finalState.score) === JSON.stringify(over.scores), 'the scores in four_game_over equal the scores inside its final snapshot');
  const best = Math.max(...over.scores);
  check(over.winners.every((w) => over.scores[w] === best) && over.scores.every((s, i) => s !== best || over.winners.includes(i)), 'the winners are exactly the seats with the highest score');
  const lastState = specInbox.states.at(-1);
  check(lastState.state === over.state, 'the last four_state and four_game_over carry the same final snapshot');
  check(specInbox.states.every((s, i) => s.seq === i + 1), 'the spectator\'s four_state seqs are 1..N with no gap');
  // The room is gone for moves.
  const late = await emitAck(players[resignSeat].socket, 'four_make_move', { roomId, from: 'e2', to: 'e4' });
  check(late.ok === false, 'a move in a finished room is refused');
  disconnectAll(room.sockets, spectator);
  return { roomId, tokens: players.map((p) => p.match.playerToken), over };
}

async function testRejoinAfterGameEnded(finished) {
  console.log('\n=== 6. Rejoin after the game ended: the result, not "game not found" ===');
  const { roomId, tokens, over } = finished;
  const back = await connect('R-late');
  // The 4 Player answer is a plain SUCCESS carrying finished: true (see the note in this file's header) - no live state to resume.
  const late = await emitAck(back, 'four_rejoin', { roomId, playerToken: tokens[1] });
  check(late.ok === true && late.finished === true, 'four_rejoin after the game ended answers { ok: true, finished: true }');
  check(late.state === undefined && late.gameOver && late.gameOver.reason === over.reason, '...with the result and NO live state to resume');
  check(JSON.stringify(late.gameOver) === JSON.stringify(over), '...the very same result every seat was sent live');
  check(JSON.stringify(late).indexOf(tokens[1]) === -1, '...and it leaks no token');
  const other = await emitAck(back, 'four_rejoin', { roomId, playerToken: tokens[2] });
  check(other.ok === true && other.finished === true, 'another seat\'s own token gets the result too');
  const bogus = await emitAck(back, 'four_rejoin', { roomId, playerToken: 'not-a-real-token' });
  check(bogus.ok === false && bogus.finished === undefined, 'a bogus token is refused for a finished room and learns nothing');
  const wrongRoom = await emitAck(back, 'four_rejoin', { roomId: 'no-such-room', playerToken: tokens[1] });
  check(wrongRoom.ok === false && wrongRoom.finished === undefined, 'a token for a room that never existed is refused');
  // The late socket is not seated.
  const move = await emitAck(back, 'four_make_move', { roomId, from: 'e2', to: 'e4' });
  check(move.ok === false, 'the late-rejoined socket is not seated: four_make_move is refused');
  const chat = await emitAck(back, 'four_send_chat', { roomId, text: 'hello?' });
  check(chat.ok === false, '...and so is four_send_chat');
  back.disconnect();
}

async function testSpectator() {
  console.log('\n=== 7. A spectator joins mid-game, follows it, cannot move or chat, and can leave ===');
  const room = await startRoom('S');
  const { players, roomId } = room;
  for (let i = 0; i < 4; i++) {
    const res = await playOne(room);
    check(res.ack.ok === true, `ply ${i + 1} accepted`);
    await waitForSeq(players, res.ack.seq);
  }
  const spectator = await connect('S-watcher');
  const specInbox = record(spectator);
  const joined = await emitAck(spectator, 'four_spectate_game', { roomId });
  const live = latestOf(players[0]);
  check(joined.ok === true && joined.state.roomId === roomId, 'four_spectate_game mid-game succeeds');
  check(joined.state.seq === live.seq && joined.state.state === live.text, `...and returns the live room at the players\' seq ${live.seq}, identical to theirs`);
  check(joined.state.seats.length === 4 && !JSON.stringify(joined.state).includes(players[0].match.playerToken), '...with the four seats and no token');
  check(Array.isArray(joined.state.log) && joined.state.log.length === 4, '...and the move log so far (4 moves)');

  // It keeps receiving what the players receive.
  const res = await playOne(room);
  await waitForSeq(players, res.ack.seq);
  await until('the spectator got the next four_state', () => specInbox.states.some((s) => s.seq === res.ack.seq));
  check(specInbox.states[0].seq === joined.state.seq + 1 && specInbox.states[0].state === players[0].inbox.states.find((s) => s.seq === res.ack.seq).state, 'the next four_state reaches the spectator, identical to the players\' copy and contiguous with the joined snapshot');

  // It owns no seat: it cannot move, chat or resign.
  const specMove = await emitAck(spectator, 'four_make_move', { roomId, from: 'e2', to: 'e4' });
  const specChat = await emitAck(spectator, 'four_send_chat', { roomId, text: 'I am watching' });
  const specResign = await emitAck(spectator, 'four_resign', { roomId });
  check(specMove.ok === false && specChat.ok === false && specResign.ok === false, 'the spectator\'s four_make_move, four_send_chat and four_resign are all refused');
  await sleep(400);
  check(players.every((p) => p.inbox.chats.length === 0), 'its chat attempt reached nobody');
  // A seated player cannot also watch.
  const playerWatch = await emitAck(players[0].socket, 'four_spectate_game', { roomId });
  check(playerWatch.ok === false, 'a socket that is playing cannot also spectate');
  // Unknown room.
  const nobody = await emitAck(spectator, 'four_spectate_game', { roomId: 'no-such-room' });
  check(nobody.ok === false, 'spectating a room that does not exist is refused');

  // Leaving: no more events.
  check((await emitAck(spectator, 'four_stop_spectating', {})).ok === true, 'four_stop_spectating is accepted');
  const countAfterLeaving = specInbox.states.length;
  const next = await playOne(room);
  await waitForSeq(players, next.ack.seq);
  await sleep(300);
  check(specInbox.states.length === countAfterLeaving, 'after leaving, the spectator receives nothing more');
  disconnectAll(room.sockets, spectator);
}

async function testChatFanOut() {
  console.log('\n=== 8. Chat: one seat writes, the other three seats and the spectator read ===');
  const room = await startRoom('C');
  const { players, roomId } = room;
  const spectator = await connect('C-watcher');
  const specInbox = record(spectator);
  check((await emitAck(spectator, 'four_spectate_game', { roomId })).ok === true, 'a spectator is watching');

  const writer = 1;
  const text = '  hello table  ';
  const ack = await emitAck(players[writer].socket, 'four_send_chat', { roomId, text });
  check(ack.ok === true, 'seat 1\'s four_send_chat is accepted');
  const readers = [0, 2, 3].map((s) => players[s]);
  await until('the three seats and the spectator received the chat', () => readers.every((p) => p.inbox.chats.length === 1) && specInbox.chats.length === 1);
  const msg = specInbox.chats[0];
  check(msg.fromSeat === writer && msg.text === 'hello table' && typeof msg.sentAt === 'number' && typeof msg.name === 'string', 'the message arrives with fromSeat 1, the trimmed text, a name and a timestamp');
  check(Object.keys(msg).sort().join() === 'fromSeat,name,sentAt,text', '...and exactly those four fields (no token, socket id or user id)');
  check(readers.every((p) => JSON.stringify(p.inbox.chats[0]) === JSON.stringify(msg)), 'all three seats got the same message as the spectator');
  check(players[writer].inbox.chats.length === 0, 'the sender does not get its own message back (the client already shows it)');

  // The rate limit: a second message straight away is refused, one a moment later is not.
  const tooFast = await emitAck(players[writer].socket, 'four_send_chat', { roomId, text: 'again' });
  check(tooFast.ok === false && tooFast.error === 'You are sending messages too fast.', 'a second message within the same second is refused: "You are sending messages too fast."');
  await sleep(1100);
  const later = await emitAck(players[writer].socket, 'four_send_chat', { roomId, text: 'again' });
  check(later.ok === true, '...and one a moment later is accepted');
  // Limits on content.
  await sleep(1100);
  check((await emitAck(players[writer].socket, 'four_send_chat', { roomId, text: '   ' })).ok === false, 'a blank message is refused');
  await sleep(1100);
  const long = await emitAck(players[writer].socket, 'four_send_chat', { roomId, text: 'x'.repeat(900) });
  await until('the long message arrived', () => specInbox.chats.length >= 3);
  check(long.ok === true && specInbox.chats.at(-1).text.length === 500, 'an over-long message is cut to 500 characters, not refused');
  disconnectAll(room.sockets, spectator);
}

async function testActiveGamesListing() {
  console.log('\n=== 9. Active games listing ===');
  const room = await startRoom('L');
  const { players, roomId } = room;
  const browser = await connect('L-browser'); // a socket with no seat, like the app's Spectate list
  const listed = await emitAck(browser, 'four_list_active_games', {});
  check(listed.ok === true && Array.isArray(listed.games), 'four_list_active_games answers a list');
  const game = listed.games.find((g) => g.roomId === roomId);
  check(!!game, 'the live room is in the list');
  check(game.timeControlLabel === TIME_CONTROL_LABEL, `...with its time control label "${game.timeControlLabel}"`);
  check(game.seats.length === 4 && game.seats.every((s) => s.kind === 'human' && s.name === 'Guest'), '...and its four seats (guests are listed as "Guest")');
  check(Object.keys(game).sort().join() === 'roomId,seats,timeControlLabel' && game.seats.every((s) => Object.keys(s).sort().join() === 'kind,name'), '...carrying names and kinds only - no token, socket id or user id');
  const idx = listed.games.findIndex((g) => g.roomId === roomId);
  check(idx >= 0 && listed.games.length <= 100, `the list is capped (${listed.games.length} <= 100) and this room is in it`);
  // It leaves the list when it ends.
  for (const seat of [0, 1, 2]) await emitAck(players[seat].socket, 'four_resign', { roomId });
  await until('the room ended', () => players.every((p) => p.inbox.gameOvers.length === 1));
  const after = await emitAck(browser, 'four_list_active_games', {});
  check(after.ok === true && !after.games.some((g) => g.roomId === roomId), 'once the game is over it is no longer listed');
  disconnectAll(room.sockets, browser);
}

async function main() {
  console.log(`Connecting to ${SERVER_URL} (move seed ${SEED}) ...`);
  await testQueueAndMatchFound();
  await testMoveSyncIsIdentical();
  await testIllegalAndOutOfTurnMovesRefused();
  await testDisconnectGraceTakeoverRetake();
  const finished = await testResignAndGameOver();
  await testRejoinAfterGameEnded(finished);
  await testSpectator();
  await testChatFanOut();
  await testActiveGamesListing();

  console.log(`\nAll good — ${passedChecks} checks passed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\nTEST FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
