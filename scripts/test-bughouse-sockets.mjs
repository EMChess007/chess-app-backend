#!/usr/bin/env node
/**
 * BUGHOUSE WORKSTREAM W7 - the real-socket scenarios (BUGHOUSE_SPEC.md section 7, W7 row): plain socket.io-client players against an ALREADY RUNNING backend, the actual server, matchmaker and
 * room manager over actual sockets. W2's `test-bughouse-online.mjs` proved the basics (fill, two humans and two bots, one takeover, team chat and quick messages on every socket, board B
 * decides, hostile payloads, one lobby next to the 4 Player queue) and `nightly-fuzz-bughouse.mjs` plays 40 random matches. This file is the rest of the W7 list, each as a scripted,
 * deterministic scenario with a FIXED number of checks:
 *   1. a resignation from EACH of the four seats (the right team wins, the right loser and board, ONE bug_state and ONE bug_game_over on every connection)
 *   2. a capture and a drop across the boards: a drop BEFORE the capture is refused and changes nothing; after the capture the partner's pocket holds the piece (the conservation invariant on
 *      every snapshot); the drop is then accepted - and a capture and a drop SENT AT ONCE end in one of the two consistent orders, decided by the server's seq
 *   3. a FLAG on each board (a 1 minute match each, both at once): the clock of the board nobody moves on runs out, the earliest deadline loses, ONE game over everywhere, and a mating move
 *      sent after the flag is refused
 *   4. a takeover by a bot and the hand-back on EACH seat, the human coming back from a NEW OS PROCESS that knows only the saved server address, room and token (the app after a kill)
 *   5. a late spectator and the active-games list (no token in it, gone after the end), a spectator can do nothing
 *   6. Bughouse next to every other 4-seat game at the same time control, all four queues at once: nothing of one protocol reaches the other, four different rooms
 *   7. a whole natural game with four clients and a spectator: byte-identical snapshots at every seq, seq +1, the conservation invariant on every snapshot, ONE game over
 *
 * Usage (the shortened fill wait and takeover grace are the 4-seat games' two existing test overrides, which Bughouse reads too; both are ignored when NODE_ENV=production):
 *   FOUR_GRACE_MS=1500 FOUR_FILL_MS=8000 npm run dev      (in one terminal, from backend/)
 *   npm run test:bughouseSockets                            (in another)
 *
 * BACKEND_URL overrides http://localhost:3000. BUGHOUSE_E2E_SEED (a number) reseeds the move choice. Runs under tsx: legal moves come from the server's generated mirror of the engine.
 * Time is real, so nothing here asserts a duration: waits end on a condition and their bounds only turn a hang into a failure. The flag scenario needs about 65 seconds by nature (the shortest
 * control is 1 minute).
 *
 * COUNTING. `check` counts a check whose number is the same on every run (printed as the FIXED total). `checkConditional` is asserted like any other but counted apart, because its number
 * depends on what the unseeded server did (which order a simultaneous pair was decided in, whether a random game ended by itself).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import { conservationProblems, deserializeMatch, legalActions, seatPlace, serializeMatch } from '../src/game/bughouse/index.ts';

const SERVER_URL = process.env.BACKEND_URL ?? 'http://localhost:3000';
const SEED = Number(process.env.BUGHOUSE_E2E_SEED ?? 20261101);
const TC1 = { initialMs: 60000, incrementMs: 0 };
const TC3 = { initialMs: 180000, incrementMs: 0 };
const CHILD = fileURLToPath(new URL('./lib/bughouse-rejoin-child.mjs', import.meta.url));
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

function connect(name) {
  return new Promise((resolve, reject) => {
    const socket = io(SERVER_URL, { transports: ['websocket'], reconnection: false });
    const timer = setTimeout(() => reject(new Error(`${name}: connect timed out`)), 5000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(new Error(`${name}: connect_error - ${err.message}`));
    });
  });
}

function emitAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(5000).emit(event, payload, (err, response) => (err ? reject(new Error(`"${event}" ack never arrived (timeout)`)) : resolve(response)));
  });
}

function waitFor(socket, event, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function until(what, test, timeoutMs = 10_000) {
  const t0 = Date.now();
  while (!test()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting until ${what}`);
    await sleep(10);
  }
}

/** Records every bug_* event a socket receives (attach right after connect, BEFORE any emit). */
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

/** Four humans queue for the same control; the 4th starts the match at once. `bySeat[seat]` = index into sockets. */
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
  for (const s of sockets) assert.ok((await emitAck(s, 'bug_join_queue', { timeControl })).ok === true, `${name}: join refused`);
  const matches = await Promise.all(found);
  const bySeat = [];
  matches.forEach((m, i) => (bySeat[m.seat] = i));
  return { sockets, inboxes, matches, bySeat, roomId: matches[0].roomId };
}

const latestText = (inbox) => (inbox.states.length > 0 ? inbox.states[inbox.states.length - 1].state : inbox.matchFound[0].state);
const latestSeq = (inbox) => (inbox.states.length > 0 ? inbox.states[inbox.states.length - 1].seq : 0);
const team = (seat) => seatPlace(seat).team;

/** The seat's move/drop acks, by seat. */
const act = (room, seat, event, payload) => emitAck(room.sockets[room.bySeat[seat]], event, { roomId: room.roomId, ...payload });
const pocketsOf = (text) => deserializeMatch(text).match.pockets;

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
  const place = seatPlace(seat);
  return parsed.ok && parsed.match.result === null && parsed.match.verdicts[place.board].turn === place.color;
};

/** Every seq that appears in all the given inboxes must carry the very same text. */
function compareStreams(inboxes) {
  const maps = inboxes.map((inbox) => new Map(inbox.states.map((s) => [s.seq, s.state])));
  const common = [...maps[0].keys()].filter((seq) => maps.every((m) => m.has(seq)));
  return { identical: common.every((seq) => maps.every((m) => m.get(seq) === maps[0].get(seq))), common };
}
const strictlyIncreasing = (inbox) => inbox.states.every((s, i) => i === 0 || s.seq === inbox.states[i - 1].seq + 1);
const conserved = (inbox) => inbox.states.every((s) => conservationProblems(deserializeMatch(s.state).match).length === 0);

// =====================================================================================================================================

async function testResignFromEachSeat() {
  console.log('\n=== 1. A resignation from EACH of the four seats ===');
  for (const seat of [0, 1, 2, 3]) {
    const room = await fourHumans(`R${seat}-`);
    const ack = await act(room, seat, 'bug_resign', {});
    await until('all saw the game over', () => room.inboxes.every((b) => b.gameOvers.length === 1));
    const result = room.inboxes[0].gameOvers[0].result;
    const place = seatPlace(seat);
    check(ack.ok === true && result.reason === 'resign' && result.loserSeat === seat && result.winnerTeam === (team(seat) === 1 ? 2 : 1) && result.board === place.board, `seat ${seat} (team ${team(seat)}, board ${place.board}) resigns: team ${result.winnerTeam} wins, loser seat ${result.loserSeat}, deciding board ${result.board}`);
    check(room.inboxes.every((b) => b.states.length === 1 && b.gameOvers.length === 1) && room.inboxes.every((b) => b.gameOvers[0].state === room.inboxes[0].gameOvers[0].state), `seat ${seat}: ONE bug_state and ONE bug_game_over on every connection, the same final snapshot everywhere`);
    disconnectAll(room.sockets);
  }
}

async function testCaptureAndDrop() {
  console.log('\n=== 2. A capture on board A and a drop on board B, in both orders ===');
  const room = await fourHumans('D');
  const [s0, s1, s2, s3] = [0, 1, 2, 3];
  // board B: White (seat 2) opens, so Black (seat 3), whose pocket the capture on A will fill, is on the move there
  assert.ok((await act(room, s2, 'bug_move', { board: 'B', from: 'e2', to: 'e4' })).ok);
  const before = await act(room, s3, 'bug_drop', { board: 'B', piece: 'p', square: 'e5' });
  const seqBefore = latestSeq(room.inboxes[0]);
  check(before.ok === false && before.reason === 'dropNotInPocket', 'a drop BEFORE the capture is refused: dropNotInPocket (the pocket is empty on arrival)');
  await sleep(150);
  check(room.inboxes.every((b) => latestSeq(b) === seqBefore), 'the refusal changed nothing: no connection received a new snapshot');
  assert.ok((await act(room, s0, 'bug_move', { board: 'A', from: 'e2', to: 'e4' })).ok);
  assert.ok((await act(room, s1, 'bug_move', { board: 'A', from: 'd7', to: 'd5' })).ok);
  const capture = await act(room, s0, 'bug_move', { board: 'A', from: 'e4', to: 'd5' });
  await until('the capture reached everyone', () => room.inboxes.every((b) => latestSeq(b) === latestSeq(room.inboxes[0]) && b.states.length >= 4));
  const afterCapture = pocketsOf(latestText(room.inboxes[0]));
  check(capture.ok === true && afterCapture[s3].p === 1 && afterCapture[s0].p === 0, 'the capture on A (White takes a pawn) puts ONE pawn into the pocket of the capturer\'s PARTNER (seat 3, Board B Black), none into the capturer\'s own');
  check(room.inboxes.every(conserved), 'the conservation invariant holds on every snapshot every connection received (64 pieces on the boards and in the four pockets, no negative pocket)');
  const drop = await act(room, s3, 'bug_drop', { board: 'B', piece: 'p', square: 'e5' });
  await until('the drop reached everyone', () => room.inboxes.every((b) => pocketsOf(latestText(b))[s3].p === 0));
  check(drop.ok === true && pocketsOf(latestText(room.inboxes[0]))[s3].p === 0 && room.inboxes.every((b) => latestText(b) === latestText(room.inboxes[0])), 'the drop right after the capture is accepted; the pocket is empty again and every connection agrees');
  check(room.inboxes.every(conserved) && room.inboxes.every(strictlyIncreasing), 'still conserved on every snapshot, and seq grows by exactly one per commit on every connection');
  // SENT AT ONCE: another capture on A (seat 1 takes on e4's square) while seat 3 tries to drop the new piece: whichever the server received first decides, and the two outcomes are both consistent
  const seqNow = latestSeq(room.inboxes[0]);
  assert.ok((await act(room, s2, 'bug_move', { board: 'B', from: 'g1', to: 'f3' })).ok); // B: it is Black's (seat 3) turn again after this
  const queenTakes = act(room, s1, 'bug_move', { board: 'A', from: 'd8', to: 'd5' }); // Black takes the pawn on d5 (a capture for Black's partner, seat 2)
  const dropAtOnce = act(room, s3, 'bug_drop', { board: 'B', piece: 'p', square: 'd5' }); // sent in the same tick: the pocket of seat 3 is empty, so this must be REFUSED in either order
  const [takes, dropped] = await Promise.all([queenTakes, dropAtOnce]);
  await sleep(150);
  check(takes.ok === true && dropped.ok === false && dropped.reason === 'dropNotInPocket', 'a capture and a drop of a piece the pocket does not hold, sent in the same tick: the capture lands, the drop is refused (a capture credits the capturer\'s PARTNER, never a drop that was already in flight)');
  const texts = room.inboxes.map(latestText);
  check(texts.every((t) => t === texts[0]) && latestSeq(room.inboxes[0]) > seqNow && room.inboxes.every(conserved), 'afterwards every connection holds the same snapshot and the invariant holds on all of them');
  checkConditional(pocketsOf(texts[0])[s2].p === 1, 'the capture by Black on A credited the pawn to seat 2 (Black\'s partner, Board B White)');
  const resign = await act(room, s0, 'bug_resign', {});
  assert.ok(resign.ok);
  disconnectAll(room.sockets);
}

async function testFlagsOnBothBoards() {
  console.log('\n=== 3. A flag on each board (two 1 minute matches at once), and a mating move sent after it ===');
  // Board B's White (seat 2) and Board A's White (seat 0) both start running at once. Match 1: only board A is played (f3 / e5 / g4): seat 2's clock is the earliest deadline and runs out.
  // Match 2: only board B is played: seat 0's clock runs out. Fool's mate is one move away on the board that was played; it is sent AFTER the flag.
  // (one group after the other: eight players queueing for the same control at once would be dealt into the two matches in any order)
  const one = await fourHumans('F1-', TC1);
  const two = await fourHumans('F2-', TC1);
  const playFoolsMate = async (room, board, white, black) => {
    assert.ok((await act(room, white, 'bug_move', { board, from: 'f2', to: 'f3' })).ok);
    assert.ok((await act(room, black, 'bug_move', { board, from: 'e7', to: 'e5' })).ok);
    assert.ok((await act(room, white, 'bug_move', { board, from: 'g2', to: 'g4' })).ok);
  };
  await Promise.all([playFoolsMate(one, 'A', 0, 1), playFoolsMate(two, 'B', 2, 3)]);
  await Promise.all([until('match 1 saw its game over', () => one.inboxes.every((b) => b.gameOvers.length === 1), 90_000), until('match 2 saw its game over', () => two.inboxes.every((b) => b.gameOvers.length === 1), 90_000)]);
  const r1 = one.inboxes[0].gameOvers[0].result;
  const r2 = two.inboxes[0].gameOvers[0].result;
  check(r1.reason === 'flag' && r1.board === 'B' && r1.loserSeat === 2 && r1.winnerTeam === 1, 'only board A played: the clock of Board B White (seat 2) runs out; team 2 loses by flag on board B');
  check(r2.reason === 'flag' && r2.board === 'A' && r2.loserSeat === 0 && r2.winnerTeam === 2, 'only board B played: the clock of Board A White (seat 0) runs out; team 1 loses by flag on board A');
  const lateMate1 = await act(one, 1, 'bug_move', { board: 'A', from: 'd8', to: 'h4' });
  const lateMate2 = await act(two, 3, 'bug_move', { board: 'B', from: 'd8', to: 'h4' });
  check([lateMate1, lateMate2].every((a) => a.ok === false && ['noGame', 'over', 'time', 'flagDue'].includes(a.reason)), 'the mating move Qh4# sent AFTER the flag is refused on both boards: a due flag is committed before any later move');
  check(one.inboxes.every((b) => b.gameOvers.length === 1 && b.gameOvers[0].state === one.inboxes[0].gameOvers[0].state) && two.inboxes.every((b) => b.gameOvers.length === 1 && b.gameOvers[0].state === two.inboxes[0].gameOvers[0].state), 'every connection of both matches received exactly ONE game over, identical within its match');
  const reread = (room) => deserializeMatch(room.inboxes[0].gameOvers[0].state);
  check(reread(one).ok && reread(one).match.result.reason === 'flag' && reread(two).ok && reread(two).match.result.reason === 'flag' && serializeMatch(reread(one).match) === one.inboxes[0].gameOvers[0].state, 'the final snapshots read back through the engine and carry the flag result');
  disconnectAll([...one.sockets, ...two.sockets]);
}

/** A new OS process as the restarted app: it is given only the saved record, rejoins, and stays connected until its stdin closes. */
function startChild(record) {
  const child = spawn(process.execPath, [CHILD, JSON.stringify({ url: SERVER_URL, roomId: record.roomId, playerToken: record.playerToken })], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = [];
  createInterface({ input: child.stdout }).on('line', (line) => lines.push(JSON.parse(line)));
  const next = async (what, test) => {
    const t0 = Date.now();
    for (;;) {
      const found = lines.find(test);
      if (found) return found;
      if (Date.now() - t0 > 15_000) throw new Error(`the child process never printed: ${what}`);
      await sleep(20);
    }
  };
  return { child, lines, rejoined: () => next('the rejoin answer', (l) => 'ok' in l && !('resign' in l)), resigned: () => next('the resign answer', (l) => 'resign' in l), send: (text) => child.stdin.write(`${text}\n`), stop: () => child.stdin.end() };
}

async function testTakeoverAndRetakeOnEachSeat() {
  console.log('\n=== 4. A takeover by a bot and the hand-back on EACH seat, the human back from a NEW PROCESS ===');
  const room = await fourHumans('K');
  // a spectator that stays: every seat of the original four is disconnected in turn, and spectators are told about seat changes
  const observer = await connect('KO');
  const watcher = record(observer);
  assert.ok((await emitAck(observer, 'bug_spectate_game', { roomId: room.roomId })).ok);
  const children = [];
  for (const seat of [0, 1, 2, 3]) {
    const token = room.matches[room.bySeat[seat]].playerToken;
    const seatsSeen = watcher.seatUpdates.length;
    room.sockets[room.bySeat[seat]].disconnect();
    await until(`a bot takes seat ${seat}`, () => watcher.seatUpdates.slice(seatsSeen).some((u) => u.seats[seat].kind === 'bot' && u.seats[seat].botReason === 'takeover'), 20_000);
    const taken = watcher.seatUpdates.slice(seatsSeen).find((u) => u.seats[seat].kind === 'bot').seats[seat];
    check(taken.botReason === 'takeover' && taken.connected === true, `seat ${seat}: after the grace a bot plays the seat (takeover, shown as connected) and the match goes on`);
    const proc = startChild({ roomId: room.roomId, playerToken: token });
    children.push(proc);
    const answer = await proc.rejoined();
    check(answer.ok === true && answer.finished === false && answer.seat === seat, `seat ${seat}: a NEW process with only the saved room and token rejoins and is told its seat`);
    const back = deserializeMatch(answer.text);
    check(back.ok && conservationProblems(back.match).length === 0 && answer.seq >= latestSeq(watcher) - 3, `seat ${seat}: the snapshot it was given reads back through the engine (both boards, four pockets, four clocks) and is current`);
    await until(`seat ${seat} is the human's again`, () => {
      const latest = watcher.seatUpdates[watcher.seatUpdates.length - 1].seats[seat];
      return latest.kind === 'human' && latest.connected === true;
    });
    const handed = watcher.seatUpdates[watcher.seatUpdates.length - 1].seats[seat];
    check(handed.botReason === undefined && handed.elo === undefined, `seat ${seat}: everyone is told the seat is the human's again (no bot reason, no bot strength)`);
    const wrong = startChild({ roomId: room.roomId, playerToken: 'not-a-token' });
    const refused = await wrong.rejoined();
    wrong.stop();
    checkConditional(refused.ok === false && refused.reason === 'noGame', `seat ${seat}: a wrong token from another process gets nothing`);
  }
  // the last rejoined process acts for its seat: a resignation ends the match for everybody
  children[3].send('resign');
  const resignAck = await children[3].resigned();
  check(resignAck.resign.ok === true, 'the human who came back from a new process can act: seat 3 resigns');
  // a rejoin of the FINISHED match from yet another process answers with the result
  const late = startChild({ roomId: room.roomId, playerToken: room.matches[room.bySeat[3]].playerToken });
  const finished = await late.rejoined();
  check(finished.ok === true && finished.finished === true && typeof finished.gameOver === 'string' && deserializeMatch(finished.gameOver).ok, 'a rejoin of the FINISHED match from a new process answers with its result (kept for five minutes)');
  late.stop();
  children.forEach((c) => c.stop());
  disconnectAll([...room.sockets, observer]);
}

async function testSpectatorAndList() {
  console.log('\n=== 5. A late spectator and the list of active games ===');
  const room = await fourHumans('L');
  const spectator = await connect('LS');
  const watching = record(spectator);
  for (const seat of [0, 1]) assert.ok((await act(room, seat === 0 ? 0 : 1, 'bug_move', { board: 'A', from: seat === 0 ? 'e2' : 'e7', to: seat === 0 ? 'e4' : 'e5' })).ok);
  const list = await emitAck(spectator, 'bug_list_active_games', {});
  const entry = list.games.find((g) => g.roomId === room.roomId);
  check(list.ok === true && entry !== undefined && !/playerToken/.test(JSON.stringify(list.games)), 'the active-games list names the running match and carries no token');
  const joined = await emitAck(spectator, 'bug_spectate_game', { roomId: room.roomId });
  const players = room.inboxes.map(latestText);
  check(joined.ok === true && joined.state.seq === latestSeq(room.inboxes[0]) && joined.state.state === players[0], 'a spectator who comes in mid-game gets both boards at the CURRENT seq, byte-identical to the players\'');
  assert.ok((await act(room, 2, 'bug_move', { board: 'B', from: 'e2', to: 'e4' })).ok);
  await until('the spectator saw the next state', () => watching.states.length >= 1);
  await until('the players saw it too', () => room.inboxes.every((b) => latestSeq(b) === watching.states[watching.states.length - 1].seq));
  check(watching.states[0].state === latestText(room.inboxes[0]) && strictlyIncreasing(watching), 'the spectator then receives every following commit, identical to the players\'');
  const tries = [await emitAck(spectator, 'bug_move', { roomId: room.roomId, board: 'A', from: 'g1', to: 'f3' }), await emitAck(spectator, 'bug_resign', { roomId: room.roomId }), await emitAck(spectator, 'bug_chat', { roomId: room.roomId, text: 'hello' }), await emitAck(spectator, 'bug_quick', { roomId: room.roomId, code: 1 })];
  check(tries.every((a) => a.ok === false && BUG_REASONS.includes(a.reason)), 'a spectator cannot move, resign, chat or send a quick message: each is refused with a reason from the closed list');
  assert.ok((await act(room, 0, 'bug_chat', { text: 'only my partner' })).ok);
  await sleep(250);
  check(watching.chats.length === 0 && watching.quicks.length === 0 && room.inboxes[room.bySeat[3]].chats.length === 1 && room.inboxes[room.bySeat[1]].chats.length === 0 && room.inboxes[room.bySeat[2]].chats.length === 0, 'a team-chat line reaches the sender and the partner only: the spectator and both opponents received nothing');
  assert.ok((await act(room, 1, 'bug_resign', {})).ok);
  await until('the spectator saw the end', () => watching.gameOvers.length === 1);
  const after = await emitAck(spectator, 'bug_list_active_games', {});
  check(watching.gameOvers[0].state === room.inboxes[0].gameOvers[0].state && after.games.every((g) => g.roomId !== room.roomId), 'the spectator is told the result, and the match is no longer in the list');
  disconnectAll([...room.sockets, spectator]);
}

const BUG_REASONS = ['over', 'time', 'flagDue', 'malformed', 'wrongBoard', 'notYourTurn', 'illegalMove', 'dropNotInPocket', 'illegalDrop', 'invalidRequest', 'noGame', 'rateLimited', 'duplicate', 'partnerIsBot'];

async function testNoMixWithEveryOtherVariant() {
  console.log('\n=== 6. Bughouse next to every other 4-seat game, all four queues at once at the same time control ===');
  const bug = [await connect('MB0'), await connect('MB1')];
  const bugInbox = bug.map(record);
  const games = [];
  for (const variant of ['ffa', 'giveaway', 'chaturaji']) {
    const sockets = [await connect(`M${variant}0`), await connect(`M${variant}1`)];
    const events = sockets.map(() => []);
    sockets.forEach((s, i) => s.onAny((name) => events[i].push(name)));
    games.push({ variant, sockets, events, found: sockets.map((s) => waitFor(s, 'four_match_found', 60_000)) });
    games[games.length - 1].found.forEach((p) => p.catch(() => {}));
  }
  const bugFound = bug.map((s) => waitFor(s, 'bug_match_found', 60_000));
  bugFound.forEach((p) => p.catch(() => {}));
  for (const s of bug) assert.ok((await emitAck(s, 'bug_join_queue', { timeControl: TC3 })).ok);
  for (const g of games) for (const s of g.sockets) assert.ok((await emitAck(s, 'four_join_queue', { timeControl: { initialSeconds: 180, incrementSeconds: 0 }, ...(g.variant !== 'ffa' ? { variant: g.variant } : {}) })).ok);
  const [bugMatch] = await Promise.all(bugFound);
  const fourMatches = await Promise.all(games.map((g) => Promise.all(g.found)));
  const roomIds = [bugMatch.roomId, ...fourMatches.map((pair) => pair[0].roomId)];
  check(new Set(roomIds).size === 4 && fourMatches.every((pair) => pair[0].roomId === pair[1].roomId), 'four queues at the same time control (Bughouse, 4 Player Chess, 4 Player Giveaway, Chaturaji) end up in FOUR different rooms, each with its own pair');
  check(fourMatches.every((pair, i) => (pair[0].variant ?? 'ffa') === games[i].variant) && bugMatch.seats.length === 4, 'each 4-seat room is the variant that was queued for');
  check(bugInbox.every((b) => b.all.every((e) => e.startsWith('bug_'))), 'the Bughouse sockets received only bug_ events');
  check(games.every((g) => g.events.every((list) => list.every((name) => name.startsWith('four_')))), 'every 4-seat socket received only four_ events (no bug_ event reached any of them)');
  assert.ok((await emitAck(bug[0], 'bug_resign', { roomId: bugMatch.roomId })).ok);
  for (const [i, g] of games.entries()) assert.ok((await emitAck(g.sockets[0], 'four_resign', { roomId: fourMatches[i][0].roomId })).ok);
  disconnectAll([...bug, ...games.flatMap((g) => g.sockets)]);
}

async function testNaturalGame() {
  console.log('\n=== 7. A whole natural game: four clients and a spectator ===');
  const room = await fourHumans('N');
  const spectator = await connect('NS');
  const watching = record(spectator);
  const spec = await emitAck(spectator, 'bug_spectate_game', { roomId: room.roomId });
  check(spec.ok === true, 'a spectator watches from the first commit');
  let played = 0;
  let refused = 0;
  for (let guard = 0; guard < 1500 && played < 260 && room.inboxes[0].gameOvers.length === 0; guard++) {
    for (let seat = 0; seat < 4; seat++) {
      const text = latestText(room.inboxes[room.bySeat[seat]]);
      if (!turnOf(text, seat)) continue;
      const action = pickAction(text, seat);
      if (!action) continue;
      const ack = await act(room, seat, action.event, action.payload);
      if (ack.ok === true) played++;
      else refused++;
      await sleep(40);
    }
    await sleep(20);
  }
  const ended = room.inboxes[0].gameOvers.length > 0;
  if (!ended) assert.ok((await act(room, 0, 'bug_resign', {})).ok);
  await until('every connection saw the game over', () => [...room.inboxes, watching].every((b) => b.gameOvers.length === 1), 20_000);
  await sleep(150);
  const all = [...room.inboxes, watching];
  checkConditional(played >= 20, `${played} legal actions were played by the four humans (${ended ? 'the engine ended the game itself' : 'then a resignation'})`);
  check(refused === 0, 'every legal action a human sent was accepted by the server');
  const streams = compareStreams(all);
  check(streams.identical, 'at every seq that two or more of the five connections saw, their snapshots are byte-identical');
  checkConditional(streams.common.length >= 10, `${streams.common.length} seqs were seen by all five connections`);
  check(all.every(strictlyIncreasing) && all.every(conserved), 'on every connection `seq` grows by exactly one per bug_state, and every snapshot satisfies the conservation invariant');
  const last = room.inboxes[0].states[room.inboxes[0].states.length - 1];
  check(all.every((b) => b.gameOvers[0].state === last.state), 'the game over of all five connections carries the final snapshot');
  const parsed = deserializeMatch(last.state);
  check(parsed.ok && parsed.match.result !== null && serializeMatch(parsed.match) === last.state && JSON.stringify(parsed.match.result) === JSON.stringify(room.inboxes[0].gameOvers[0].result), 'the final snapshot reads back through the engine and its result is the one every connection was told');
  disconnectAll([...room.sockets, spectator]);
}

async function main() {
  console.log(`Connecting to ${SERVER_URL} (move seed ${SEED}) ...`);
  await testResignFromEachSeat();
  await testCaptureAndDrop();
  await testSpectatorAndList();
  await testNoMixWithEveryOtherVariant();
  await testTakeoverAndRetakeOnEachSeat();
  await testNaturalGame();
  await testFlagsOnBothBoards(); // last: about a minute of real time
  console.log(`\nAll good - ${passedChecks} checks passed (FIXED total; conditional: ${conditionalChecks}, counted apart: their number depends on the unseeded server).`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\nTEST FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
