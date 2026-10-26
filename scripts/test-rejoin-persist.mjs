#!/usr/bin/env node
/**
 * Rejoin after an app restart / page reload - end to end over real sockets, with a REAL new process as the restarted client.
 *
 * WHAT IT PROVES. The app now remembers the online game it is in (src/logic/activeGame.ts + src/api/activeGameStorage.ts: id, rejoin token, variant,
 * starting position). After a reload or a kill the server must still honour that token from a brand-new connection and give back the full game. Here the
 * "app" is this script (it plays, saves the exact record the app writes, then drops its socket = the kill) and the "restarted app" is a child OS process
 * (scripts/rejoin-client-process.mjs) that has nothing but the record file, reads it with the app's own parseActiveGame and rejoins.
 *
 *   - 2 players, Classic: the restarted player gets the live position and clocks; the opponent sees opponent_disconnected then opponent_reconnected and
 *     NO game_over; a move made by the restarted process is accepted and reaches the opponent; the token is not single-use (a second restart works);
 *     a tampered token is refused; a game that ended while the app was away is reported with its result (kept 5 minutes).
 *   - 2 players with extra state: Crazyhouse (the pockets), Duck Chess (the duck), Spell Chess (charges + the pending freeze), Fog of War (the REDACTED
 *     view: nothing the player is not allowed to see comes back).
 *   - 4 Player Chess, 4 Player Giveaway and Chaturaji: four_rejoin from a new process returns the seat with the room's current snapshot, and no bot ever took it.
 *   - SECRECY: across all of that, no event the opponent, a spectator or another seat received contains anybody's token.
 *
 * Needs a running backend (BACKEND_URL, default http://localhost:3000), started with FOUR_GRACE_MS=1500 like test-fourplayer-online.mjs.
 * Run: npm run test:rejoinPersist   (tsx: it reads the app's TypeScript record module and the generated 4 Player engine mirror)
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import { serializeActiveGame } from '../../src/logic/activeGame.ts';
import { CHATURAJI_RULES, GIVEAWAY_RULES, deserialize, geometryOf, legalMoves, promotionOf, BISHOP, KNIGHT, QUEEN, ROOK } from '../src/game/fourPlayer/index.ts';
import { deserializeMatch as deserializeBugMatch } from '../src/game/bughouse/index.ts';

const SERVER_URL = process.env.BACKEND_URL ?? 'http://localhost:3000';
let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ✓ ${message}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Polls until `test()` is truthy; a hang becomes a failure naming what it waited for (the bound is not an assertion about time). */
async function until(test, what, ms = 8000) {
  const t0 = Date.now();
  while (!test()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}
const tmp =mkdtempSync(join(tmpdir(), 'rejoin-persist-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));

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
    // everything this socket ever hears, for the secrecy check
    socket.heard = [];
    socket.onAny((event, ...args) => socket.heard.push({ event, args }));
  });
}
const ack = (socket, event, payload) =>
  new Promise((resolve, reject) => socket.timeout(5000).emit(event, payload, (err, res) => (err ? reject(new Error(`"${event}" no answer`)) : resolve(res))));
function waitFor(socket, event, ms = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), ms);
    socket.once(event, (p) => {
      clearTimeout(timer);
      resolve(p);
    });
  });
}
const everHeard = (socket, event) => socket.heard.filter((h) => h.event === event);

// --- the restarted app: a new process that has only the saved record ------------------------------------------------------------------
const TSX_CLI = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
const CHILD = fileURLToPath(new URL('./rejoin-client-process.mjs', import.meta.url));
/**
 * Starts the restarted app on `record` (an ActiveOnlineGame). `hold: true` makes the new process finish ALL its start-up first (node, tsx, the app's
 * record module, reading the record) and wait: `ready` resolves when it has, and nothing touches the network until `go()`. Without `hold` the process
 * connects at once and `ready` is already resolved. `go()` resolves with its stdout events when it exits. `during` runs once the seat is back.
 *
 * Why `hold` exists: a 4 Player seat is held for a disconnect grace (FOUR_GRACE_MS, 1500 ms in CI), after which a bot takes it. The point of the
 * scenarios below is that a restart WITHIN the grace gets the seat back - so what must be fast is the handshake. Starting node + tsx inside the grace
 * made the verdict depend on how quickly the machine boots a process (it takes 1.5-3 s on a busy Windows desktop and the test failed about one run in
 * three on a clean main). Warming the process first removes that race without weakening any check: the restarted app still has only the record file.
 */
function startApp(record, { make, makeBug, listen = 2500, during, hold = false } = {}) {
  const file = join(tmp, `record-${Math.random().toString(36).slice(2)}.json`);
  // a Bughouse record is the plain `{ kind: 'bughouse', match: { roomId, playerToken } }` (the app's ActiveOnlineGame has no such kind until the client workstream, W4)
  writeFileSync(file, record.kind === 'bughouse' ? JSON.stringify(record) : serializeActiveGame(record));
  const args = [TSX_CLI, CHILD, '--record', file, '--url', SERVER_URL, '--listen', String(listen)];
  if (make) args.push('--make', JSON.stringify(make));
  if (makeBug) args.push('--make-bug', JSON.stringify(makeBug));
  if (hold) args.push('--hold');
  const child = spawn(process.execPath, args, { stdio: [hold ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  const events = [];
  let buffer = '';
  let stderr = '';
  let fired = false;
  let markReady = () => {};
  const ready = hold ? new Promise((resolve) => (markReady = resolve)) : Promise.resolve();
  child.stderr.on('data', (d) => (stderr += d));
  child.stdout.on('data', (d) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line.startsWith('{')) continue;
      const event = JSON.parse(line);
      if (event.event === 'ready') {
        markReady();
        continue;
      }
      events.push(event);
      if (event.event === 'rejoined' && !fired && during) {
        fired = true;
        void Promise.resolve(during(event, events)).catch((e) => events.push({ event: 'test-error', error: String(e) }));
      }
    }
  });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve({ code, events, stderr })));
  // A process that dies before it is ready (a bad record, a crash) must not leave `ready` pending forever.
  if (hold) void exited.then(() => markReady());
  return {
    ready,
    go() {
      if (hold) child.stdin.write('go\n');
      return exited;
    },
  };
}
/** Runs the restarted app on `record` at once; resolves with its stdout events. */
function restartApp(record, options) {
  return startApp(record, options).go();
}
const rejoinedOf = (run) => run.events.find((e) => e.event === 'rejoined');

// --- 2 players ---------------------------------------------------------------------------------------------------------------------
const TIME = { initialSeconds: 300, incrementSeconds: 0 };
async function startTwoPlayer(label, flags = {}) {
  const a = await connect(`${label}A`);
  const b = await connect(`${label}B`);
  const [ma, mb] = await Promise.all([
    (async () => {
      const found = waitFor(a, 'match_found');
      found.catch(() => {});
      await ack(a, 'join_queue', { timeControl: TIME, ...flags });
      return found;
    })(),
    (async () => {
      await sleep(120);
      const found = waitFor(b, 'match_found');
      found.catch(() => {});
      await ack(b, 'join_queue', { timeControl: TIME, ...flags });
      return found;
    })(),
  ]);
  const white = ma.color === 'w' ? { socket: a, match: ma } : { socket: b, match: mb };
  const black = ma.color === 'w' ? { socket: b, match: mb } : { socket: a, match: ma };
  return { white, black, roomId: ma.roomId, sockets: [a, b] };
}
const recordOf = (side) => ({ kind: 'twoPlayer', userId: 'e2e-user', match: side.match });
async function play(side, from, to, extra = {}) {
  const res = await ack(side.socket, 'make_move', { roomId: side.match.roomId, from, to, ...extra });
  assert.ok(res.ok, `${from}${to} refused: ${res.error}`);
  return res;
}
/** The app is killed: its socket just goes away. */
async function kill(side) {
  side.socket.disconnect();
  await sleep(300);
}
const noToken = (sockets, tokens) => {
  const text = JSON.stringify(sockets.flatMap((s) => s.heard));
  return tokens.every((t) => !text.includes(t));
};

console.log('\n=== 1. Classic: kill the app in the middle of the game, restart it as a new process ===');
{
  const g = await startTwoPlayer('Classic');
  const spectator = await connect('ClassicWatcher');
  check((await ack(spectator, 'spectate_game', { roomId: g.roomId })).ok === true, 'a spectator watches');
  await play(g.white, 'e2', 'e4');
  await play(g.black, 'e7', 'e5');
  const last = await play(g.white, 'g1', 'f3'); // Black to move
  const whiteToken = g.white.match.playerToken;
  const blackToken = g.black.match.playerToken;
  const sawDisconnect = waitFor(g.black.socket, 'opponent_disconnected');
  await kill(g.white); // the app is killed with the game on
  const away = await sawDisconnect;
  check(away.graceSeconds > 0, "Black is told White's connection dropped (the 45 s grace is running)");

  const sawBack = waitFor(g.black.socket, 'opponent_reconnected');
  const sawMove = waitFor(g.black.socket, 'opponent_move');
  const run = await restartApp(recordOf(g.white), {
    // once the seat is back, the opponent plays - the restarted app must hear it
    during: async () => {
      await play(g.black, 'b8', 'c6');
    },
  });
  const re = rejoinedOf(run);
  check(run.code === 0 && re?.ack?.ok === true, 'the new process rejoins with ONLY the saved record - the server accepts the token from a brand-new socket');
  check(re.ack.state.fen === last.fen || re.ack.state.fen.split(' ')[0] === last.fen.split(' ')[0], '...and gets the live position back');
  check(re.ack.state.turn === 'b' && Array.isArray(re.ack.state.moves) && re.ack.state.moves.length === 3, '...with the full move list (3 plies) and whose turn it is');
  check(re.ack.state.whiteMs > 0 && re.ack.state.blackMs > 0, '...and the clocks');
  await sawBack;
  check(true, 'Black is told White is back (opponent_reconnected)');
  check(everHeard(g.black.socket, 'game_over').length === 0, 'nobody was awarded a win by abandonment');
  check(run.events.some((e) => e.event === 'opponent_move' && e.payload.san === 'Nc6'), "the restarted process hears Black's next move (it holds the seat)");
  await sawMove.catch(() => {});

  // the token is not single-use: a SECOND restart works too
  const second = await restartApp(recordOf(g.white), { listen: 800 });
  check(rejoinedOf(second)?.ack?.ok === true && rejoinedOf(second).ack.state.moves.length === 4, 'a second restart with the same record works as well (4 plies by now)');

  // a tampered token is not a seat
  const forged = await restartApp({ ...recordOf(g.white), match: { ...g.white.match, playerToken: 'not-the-token' } }, { listen: 300 });
  check(rejoinedOf(forged)?.ack?.ok === false, 'a record with a wrong token is refused');

  check(noToken([g.black.socket, spectator], [whiteToken]), "nothing the opponent heard contains White's token");
  check(noToken([spectator], [whiteToken, blackToken]), 'the spectator never heard either token');
  g.sockets.forEach((s) => s.disconnect());
  spectator.disconnect();
}

console.log("\n=== 2. The restarted app makes the next move itself (it is the player's turn) ===");
{
  const g = await startTwoPlayer('Turn');
  await play(g.white, 'd2', 'd4'); // Black to move
  await kill(g.black);
  const sawMove = waitFor(g.white.socket, 'opponent_move');
  const run = await restartApp(recordOf(g.black), { make: { from: 'd7', to: 'd5' } });
  const made = run.events.find((e) => e.event === 'made');
  check(rejoinedOf(run)?.ack?.ok === true && made?.ack?.ok === true, "Black's restarted process rejoins and its move d7-d5 is accepted");
  const heard = await sawMove;
  check(heard.san === 'd5', "...and White hears it - the game goes on as if nothing happened");
  g.sockets.forEach((s) => s.disconnect());
}

console.log('\n=== 3. The game ended while the app was away: the restart is told the result (kept for 5 minutes) ===');
{
  const g = await startTwoPlayer('Gone');
  await play(g.white, 'e2', 'e4');
  await kill(g.black);
  const over = waitFor(g.white.socket, 'game_over');
  g.white.socket.emit('resign', { roomId: g.roomId }, () => {});
  const result = await over;
  check(result.reason === 'resignation' && result.winner === 'b', "White resigned while Black's app was away: Black won");
  const run = await restartApp(recordOf(g.black), { listen: 300 });
  const re = rejoinedOf(run);
  check(re?.ack?.ok === false && re.ack.finished === true && re.ack.gameOver.reason === 'resignation' && re.ack.gameOver.winner === 'b', 'the restarted app is told the game is finished, by resignation, won by Black (the app shows the result card and forgets the token)');
  const stranger = await restartApp({ ...recordOf(g.black), match: { ...g.black.match, playerToken: 'not-the-token' } }, { listen: 300 });
  check(rejoinedOf(stranger)?.ack?.ok === false && rejoinedOf(stranger).ack.finished !== true, 'a forged token is told nothing about the finished game');
  g.sockets.forEach((s) => s.disconnect());
}

console.log('\n=== 3b. Threefold repetition survives an app restart: the count lives in the room ===');
for (const [label, flags] of [['Classic', {}], ['Fog of War', { isFogOfWar: true }], ['Crazyhouse', { isCrazyhouse: true }]]) {
  // Nf3 Nf6 Ng1 Ng8 twice = 8 plies is the third occurrence of the start position. Play 6 plies (the SECOND occurrence came at ply 4), kill White's app,
  // restart it as a new process, and let it play ply 7 itself; Black plays ply 8: the game must end by repetition although the process that played
  // ply 7 has never seen any of the earlier plies.
  const g = await startTwoPlayer(`Rep${label.replace(' ', '')}`, flags);
  const shuffle = [['g1', 'f3'], ['g8', 'f6'], ['f3', 'g1'], ['f6', 'g8']];
  for (let ply = 0; ply < 6; ply++) await play(ply % 2 === 0 ? g.white : g.black, ...shuffle[ply % 4]);
  const overBeforeKill = []; // nobody may have been told anything yet
  g.black.socket.on('game_over', (p) => overBeforeKill.push(p));
  await kill(g.white);
  const blackSeesOver = waitFor(g.black.socket, 'game_over', 6000);
  const run = await restartApp(recordOf(g.white), {
    make: { from: 'f3', to: 'g1' },
    listen: 1500,
    during: async (_event, events) => {
      for (let i = 0; i < 40 && !events.some((e) => e.event === 'made'); i++) await sleep(100);
      await play(g.black, 'f6', 'g8'); // ply 8: the third occurrence
    },
  });
  const re = rejoinedOf(run);
  check(re?.ack?.ok === true && re.ack.state.moves.length === 6, `${label}: the restarted app rejoins mid-repetition (6 plies, the position has occurred twice)`);
  check(run.events.find((e) => e.event === 'made')?.ack?.ok === true, `${label}: and plays ply 7 itself - no draw yet`);
  const over = await blackSeesOver;
  check(over.reason === 'repetition' && over.winner === null, `${label}: ply 8 ends the game: draw by 'repetition' - the count survived the restart`);
  check(run.events.some((e) => e.event === 'game_over' && e.payload.reason === 'repetition'), `${label}: the restarted process is told, too`);
  g.sockets.forEach((x) => x.disconnect());
}

console.log('\n=== 4. Variants with extra state come back whole ===');
{
  // Crazyhouse: a captured pawn sits in White's pocket.
  const g = await startTwoPlayer('Crazy', { isCrazyhouse: true });
  await play(g.white, 'e2', 'e4');
  await play(g.black, 'd7', 'd5');
  await play(g.white, 'e4', 'd5'); // White captures: pocket p = 1
  await kill(g.white);
  const run = await restartApp(recordOf(g.white), { listen: 500 });
  const re = rejoinedOf(run);
  check(re?.ack?.ok === true && re.ack.state.crazyhouse?.reserve?.w?.p === 1, "Crazyhouse: White's pocket (one pawn) is back after the restart");
  check(re.ack.state.moves.length === 3, '...with the whole move list');
  g.sockets.forEach((s) => s.disconnect());
}
{
  // Duck Chess: the duck stands on a3.
  const g = await startTwoPlayer('Duck', { isDuckChess: true });
  await play(g.white, 'e2', 'e4', { duckTo: 'a3' });
  await kill(g.black);
  const run = await restartApp(recordOf(g.black), { make: { from: 'e7', to: 'e5', duckTo: 'a6' }, listen: 500 });
  const re = rejoinedOf(run);
  check(re?.ack?.ok === true && re.ack.state.duckSquare === 'a3', 'Duck Chess: the duck is still on a3 after the restart');
  check(run.events.find((e) => e.event === 'made')?.ack?.ok === true, '...and the restarted player\'s turn (move + new duck square) is accepted');
  g.sockets.forEach((s) => s.disconnect());
}
{
  // Spell Chess: White cast Freeze (one charge spent, a freeze pending against Black).
  const g = await startTwoPlayer('Spell', { isSpellChess: true });
  await play(g.white, 'g1', 'f3', { spell: { type: 'freeze', center: 'e5' } });
  await kill(g.black);
  const run = await restartApp(recordOf(g.black), { listen: 500 });
  const re = rejoinedOf(run);
  check(re?.ack?.ok === true && re.ack.state.spellState?.w?.charges?.freeze === 4, 'Spell Chess: White has 4 of 5 Freeze charges left after the restart');
  check(re.ack.state.spellState.pendingFreeze !== null, '...and the pending freeze against Black is still there');
  g.sockets.forEach((s) => s.disconnect());
}
{
  // Fog of War: the restarted player gets THEIR redacted view - the same one they had before the kill - and no hidden piece.
  const g = await startTwoPlayer('Fog', { isFogOfWar: true });
  const mine = await play(g.white, 'e2', 'e4');
  await play(g.black, 'e7', 'e5');
  const heardBlack = await new Promise((resolve) => setTimeout(() => resolve(everHeard(g.white.socket, 'opponent_move').at(-1)?.args[0]), 300));
  await kill(g.white);
  const run = await restartApp(recordOf(g.white), { listen: 500 });
  const re = rejoinedOf(run);
  check(re?.ack?.ok === true, 'Fog of War: the restarted player rejoins');
  const lastKnown = heardBlack?.fen ?? mine.fen;
  check(re.ack.state.fen === lastKnown, "...and gets exactly the redacted position they had before the kill");
  const rows = re.ack.state.fen.split(' ')[0].split('/');
  check(!rows.slice(0, 2).join('').match(/[a-z]/) || rows.slice(0, 2).join('').match(/[a-z]/g).length <= 1, "...with Black's back ranks still in the fog");
  check(re.ack.state.visibleSquares.length > 0, '...and the visible squares');
  g.sockets.forEach((s) => s.disconnect());
}

// --- 4 Player --------------------------------------------------------------------------------------------------------------------------
const PROMOTION_LETTER = { [QUEEN]: 'q', [ROOK]: 'r', [BISHOP]: 'b', [KNIGHT]: 'n' };
async function startFour(label, variant = 'ffa') {
  const sockets = [];
  for (let i = 0; i < 4; i++) sockets.push(await connect(`${label}${i}`));
  const found = sockets.map((s) => waitFor(s, 'four_match_found'));
  found.forEach((p) => p.catch(() => {}));
  for (const s of sockets) {
    const res = await ack(s, 'four_join_queue', { timeControl: TIME, timeControlLabel: '5 min', ...(variant !== 'ffa' ? { variant } : {}) });
    assert.ok(res.ok, 'four_join_queue');
  }
  const matches = await Promise.all(found);
  const players = [];
  matches.forEach((match, i) => (players[match.seat] = { socket: sockets[i], match }));
  return { players, sockets, roomId: matches[0].roomId, rules: variant === 'giveaway' ? GIVEAWAY_RULES : variant === 'chaturaji' ? CHATURAJI_RULES : undefined };
}
async function fourMove(room, seat, snapshot) {
  const state = deserialize(snapshot, room.rules);
  const moves = legalMoves(state, seat);
  const move = moves[0];
  const promotion = PROMOTION_LETTER[promotionOf(move)];
  const name = geometryOf(state.rules).squareName; // squares are named on the room's own board (Chaturaji's is 8 x 8)
  const res = await ack(room.players[seat].socket, 'four_make_move', { roomId: room.roomId, from: name(move.from), to: name(move.to), ...(promotion ? { promotion } : {}) });
  assert.ok(res.ok, `four_make_move refused: ${res.error}`);
  return res;
}
for (const [label, variant, prefix] of [['4 Player Chess', 'ffa', 'F'], ['4 Player Giveaway', 'giveaway', 'G'], ['Chaturaji', 'chaturaji', 'C']]) {
  console.log(`\n=== 5. ${label}: restart as a new process, within the grace ===`);
  const room = await startFour(prefix, variant);
  const states = [];
  room.players.forEach((p) => p.socket.on('four_state', (s) => states.push(s)));
  const first = room.players.find((p) => deserialize(p.match.state, room.rules).turn === p.match.seat);
  const m1 = await fourMove(room, first.match.seat, first.match.state);
  const victim = room.players[(first.match.seat + 2) % 4]; // not on move
  const tokens = room.players.map((p) => p.match.playerToken);
  const others = room.players.filter((p) => p !== victim);
  const recordFor = (match) => ({ kind: 'fourPlayer', userId: 'e2e-user', match, timeControl: { id: 'x', label: '5 min', initialSeconds: 300, incrementSeconds: 0, category: 'blitz' } });
  // Both restarted apps (the real record and one with a forged token) are started and fully warmed BEFORE the kill: only their handshakes happen inside the grace.
  const restarted = startApp(recordFor(victim.match), { listen: 800, hold: true });
  const forgedApp = startApp(recordFor({ ...victim.match, playerToken: 'not-the-token' }), { listen: 300, hold: true });
  await Promise.all([restarted.ready, forgedApp.ready]);
  victim.socket.disconnect(); // the app is killed
  await sleep(300);
  const run = await restarted.go();
  const re = rejoinedOf(run);
  check(re?.ack?.ok === true && !re.ack.finished && re.ack.state.seat === victim.match.seat, 'the new process rejoins its seat with only the saved record');
  check(re.ack.state.seq >= m1.seq && re.ack.state.state === states.filter((s) => s.seq === re.ack.state.seq)[0]?.state, "...with the room's current snapshot");
  check(re.ack.state.seats[victim.match.seat].kind === 'human' && re.ack.state.seats[victim.match.seat].connected === true, '...and the seat is the human\'s (no bot took it)');
  const forged = await forgedApp.go(); // the first restarted app has exited, so the seat is unattended again and a fresh grace is running: this handshake is immediate
  check(rejoinedOf(forged)?.ack?.ok === false, 'a record with a forged token is refused');
  await sleep(300);
  const sawBot = others.some((p) => JSON.stringify(everHeardFour(p.socket)).includes('"kind":"bot"'));
  check(!sawBot, 'the other seats never saw a bot take over');
  // each seat legitimately holds its OWN token (it came in its own four_match_found) - nobody may have heard anyone else's
  check(others.every((p) => tokens.filter((t) => t !== p.match.playerToken).every((t) => !JSON.stringify(p.socket.heard).includes(t))), "no seat's token appears in anything another seat heard (the restart, the seat updates, the snapshots)");
  room.sockets.forEach((s) => s.disconnect());
}
function everHeardFour(socket) {
  return socket.heard.filter((h) => h.event === 'four_seat_update').map((h) => h.args[0].seats);
}

// --- Bughouse (W2) ----------------------------------------------------------------------------------------------------------------------
const BUG_TIME = { initialMs: 300000, incrementMs: 0 };
async function startBug(label) {
  const sockets = [];
  for (let i = 0; i < 4; i++) sockets.push(await connect(`${label}${i}`));
  const found = sockets.map((s) => waitFor(s, 'bug_match_found'));
  found.forEach((p) => p.catch(() => {}));
  for (const s of sockets) assert.ok((await ack(s, 'bug_join_queue', { timeControl: BUG_TIME })).ok, 'bug_join_queue');
  const matches = await Promise.all(found);
  const players = [];
  matches.forEach((match, i) => (players[match.seat] = { socket: sockets[i], match }));
  return { players, sockets, roomId: matches[0].roomId };
}
const bugRecord = (match) => ({ kind: 'bughouse', match: { roomId: match.roomId, playerToken: match.playerToken } });
const bugHeardSeats = (socket) => socket.heard.filter((h) => h.event === 'bug_seat_update').map((h) => h.args[0].seats);

{
  console.log('\n=== 6. Bughouse: restart as a new process, within the grace ===');
  const room = await startBug('B');
  const states = [];
  room.players.forEach((p) => p.socket.on('bug_state', (s) => states.push(s)));
  const e4 = await ack(room.players[0].socket, 'bug_move', { roomId: room.roomId, board: 'A', from: 'e2', to: 'e4' });
  assert.ok(e4.ok, 'bug_move');
  const d4 = await ack(room.players[2].socket, 'bug_move', { roomId: room.roomId, board: 'B', from: 'd2', to: 'd4' });
  assert.ok(d4.ok, 'bug_move');
  const victim = room.players[1]; // seat 1 (Board A, Black): it is on move on board A
  const tokens = room.players.map((p) => p.match.playerToken);
  const others = room.players.filter((p) => p !== victim);
  // Both restarted apps (the real record and one with a forged token) are started and fully warmed BEFORE the kill: only their handshakes happen inside the grace.
  const restarted = startApp(bugRecord(victim.match), { listen: 800, hold: true });
  const forgedApp = startApp(bugRecord({ ...victim.match, playerToken: 'not-the-token' }), { listen: 300, hold: true });
  await Promise.all([restarted.ready, forgedApp.ready]);
  victim.socket.disconnect(); // the app is killed
  await sleep(300);
  const run = await restarted.go();
  const re = rejoinedOf(run);
  check(re?.ack?.ok === true && !re.ack.finished && re.ack.state.seat === 1 && re.ack.state.roomId === room.roomId, 'the new process rejoins its seat with only the saved record (room id and token)');
  check(re.ack.state.seq >= 2 && re.ack.state.state === states.filter((s) => s.seq === re.ack.state.seq)[0]?.state, "...with the match's snapshot at that seq, byte for byte");
  const restored = deserializeBugMatch(re.ack.state.state);
  check(restored.ok && restored.match.boards.A.plies === 1 && restored.match.boards.B.plies === 1 && restored.match.clocks.every((c, i) => (c.runningSince !== null) === (i === 1 || i === 3)), '...both boards, all four clocks (seat 1 and seat 3 are on move) and the pockets come back whole');
  check(Number.isFinite(re.ack.state.serverNowMs) && re.ack.state.log.length === 2 && re.ack.state.log[0].san === 'e4' && re.ack.state.log[1].san === 'd4', '...with the match clock instant and the move log');
  check(re.ack.state.seats[1].kind === 'human' && re.ack.state.seats[1].connected === true, "...and the seat is the human's (no bot took it)");
  const forged = await forgedApp.go();
  check(rejoinedOf(forged)?.ack?.ok === false && rejoinedOf(forged).ack.reason === 'noGame', 'a record with a forged token is refused (noGame)');
  await sleep(300);
  check(!others.some((p) => JSON.stringify(bugHeardSeats(p.socket)).includes('"kind":"bot"')), 'the other seats never saw a bot take over');
  check(others.every((p) => tokens.filter((t) => t !== p.match.playerToken).every((t) => !JSON.stringify(p.socket.heard).includes(t))), "no seat's token appears in anything another seat heard (the restart, the seat updates, the snapshots)");
  room.sockets.forEach((s) => s.disconnect());
}

{
  console.log('\n=== 6b. Bughouse: restart AFTER a bot took the seat (hand-back) ===');
  const room = await startBug('BT');
  const states = [];
  const seatEvents = [];
  room.players.forEach((p) => {
    p.socket.on('bug_state', (s) => states.push(s));
    p.socket.on('bug_seat_update', (u) => seatEvents.push(u));
  });
  const victim = room.players[0]; // seat 0 (Board A, White) is on move at the start
  const away = room.players[3];
  victim.socket.disconnect();
  await until(() => seatEvents.some((u) => u.seats[0].kind === 'bot' && u.seats[0].botReason === 'takeover'), 'a bot to take seat 0', 10_000);
  const takeover = seatEvents.find((u) => u.seats[0].kind === 'bot');
  check(takeover.seats[0].connected === true && takeover.seats[0].elo === 1200, 'a bot took the seat after the grace');
  await until(() => states.some((s) => s.events.some((e) => e.kind === 'move' && e.seat === 0)), "the takeover bot's first move", 10_000);
  const run = await restartApp(bugRecord(victim.match), { listen: 600 });
  const re = rejoinedOf(run);
  check(re?.ack?.ok === true && re.ack.state.seat === 0 && re.ack.state.seats[0].kind === 'human' && re.ack.state.seats[0].botReason === undefined, 'the restarted app takes the seat back: it is the human\'s again, with no bot reason left');
  check(re.ack.state.log.some((e) => e.seat === 0), "...and the bot's move is in the log it receives");
  await until(() => seatEvents.some((u, i) => i > seatEvents.indexOf(takeover) && u.seats[0].kind === 'human'), 'everyone to hear the hand-back', 5000);
  // the FIRST update after the takeover that shows a human on the seat (a later one may legitimately say "not connected": the restarted app's socket ends after its listening window)
  const handedBack = seatEvents.find((u, i) => i > seatEvents.indexOf(takeover) && u.seats[0].kind === 'human').seats[0];
  check(handedBack.kind === 'human' && handedBack.connected === true && handedBack.botReason === undefined, "the other seats were told the seat is the human's again (the first seat update they heard after the takeover)");
  void away;
  room.sockets.forEach((s) => s.disconnect());
}

{
  console.log('\n=== 6c. Bughouse: the match ended while the app was away - the restart is told the result (kept for 5 minutes) ===');
  const room = await startBug('BE');
  const overs = [];
  room.players.forEach((p) => p.socket.on('bug_game_over', (o) => overs.push(o)));
  const victim = room.players[2];
  const resigner = room.players[1];
  victim.socket.disconnect();
  await sleep(100);
  assert.ok((await ack(resigner.socket, 'bug_resign', { roomId: room.roomId })).ok, 'bug_resign');
  await until(() => overs.length >= 3, 'the game over to reach the three connected players', 5000);
  const run = await restartApp(bugRecord(victim.match), { listen: 300 });
  const re = rejoinedOf(run);
  check(re?.ack?.ok === true && re.ack.finished === true && JSON.stringify(re.ack.gameOver) === JSON.stringify(overs[0]), 'the restart gets the result of the finished match: the very game over the others received');
  check(re.ack.gameOver.result.reason === 'resign' && re.ack.gameOver.result.loserSeat === 1, '...a resignation by seat 1');
  const wrong = await restartApp(bugRecord({ ...victim.match, playerToken: 'not-the-token' }), { listen: 300 });
  check(rejoinedOf(wrong)?.ack?.ok === false, 'a forged token gets no result');
  room.sockets.forEach((s) => s.disconnect());
}

console.log(`\nAll good - ${passed} checks passed.`);
process.exit(0);
