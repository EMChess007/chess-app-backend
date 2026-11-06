#!/usr/bin/env node
/**
 * INTEGRATION TEST of the app's ONLINE BUGHOUSE CLIENT against the REAL local backend (command #28, workstream W4): the app's own `BughouseOnlineSession` (src/logic/bughouseOnlineSession.ts - the
 * very class the screen drives) on real socket.io-client sockets, against a private copy of the real server on this machine's test database, with real bots filling the two other seats.
 *
 *   npm run test:bughouseClient          (from backend/; needs the local PostgreSQL of scripts/cloud-setup.sh / docker-compose.yml)
 *
 * What it plays: two clients queue for 1 | 0, the fill wait ends, the bots take the two empty seats, and both clients play legal moves and drops chosen from THEIR OWN view of the match (the client's
 * engine copy, never the server's) through `sendAction` until a result - at most 40 actions each, then one of them resigns. HALF-WAY, one client's connection is cut (the transport is closed, so the
 * manager reconnects on its own): the session must go "reconnecting", rejoin with its token (the W2 `bug_rejoin`), come back "connected" with the room as the server holds it, and play on.
 * At the end both clients hold the very same final match, byte for byte, as a spectator socket that watched the whole game.
 *
 * It starts its OWN backend on a free port (never 3000 / 8081 / 8082, never the deployed one), with the 4-seat games' two existing timing overrides (fill wait 3 s, takeover grace 30 s: both
 * ignored in production, CHECKLIST 7) and kills only that process, by the PID it holds. The players are guests: no account is created. Waits end on a condition; their bounds only turn a hang
 * into a failure. COUNTING: `check` is a number that is the same on every run; `checkConditional` depends on what the (unseeded) bots did and is counted apart.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import { isLocalDatabaseUrl, resolveDatabaseUrl } from './lib/test-user-cleanup.mjs';
import { killTree, portIsFree, sleep } from './e2e-browser/stack.mjs';
// (the app's engine, file by file: a namespace import of its index exposes nothing under tsx, as in e2e-browser/truth.mjs)
import { legalActions } from '../../src/logic/bughouse/match.ts';
import { deserializeMatch, serializeMatch } from '../../src/logic/bughouse/snapshot.ts';
import { emitWithin } from '../../src/api/socketAck.ts';
import { validateBugJoinQueue } from '../../src/logic/bughouse/wire.ts';
import { BughouseOnlineSession } from '../../src/logic/bughouseOnlineSession.ts';
import { isOver, resultOf } from '../../src/logic/bughouseOnline.ts';
import { partnerOf } from '../../src/logic/bughouse/types.ts';

const BACKEND = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.BUGHOUSE_CLIENT_TEST_PORT ?? 3193);
const URL = `http://localhost:${PORT}`;
const TC1 = { initialMs: 60000, incrementMs: 0 };
const SEED = Number(process.env.BUGHOUSE_CLIENT_TEST_SEED ?? 20261030);
const MAX_ACTIONS_EACH = 40;

let passed = 0;
let conditional = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  passed++;
  console.log(`  ✓ ${message}`);
};
const checkConditional = (condition, message) => {
  assert.ok(condition, message);
  conditional++;
  console.log(`  ~ ${message}`);
};

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

async function until(what, test, timeoutMs = 20_000) {
  const t0 = Date.now();
  while (!test()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting until ${what}`);
    await sleep(15);
  }
}

function connect(name) {
  return new Promise((resolve, reject) => {
    const socket = io(URL, { transports: ['websocket'], reconnectionDelay: 100, reconnectionDelayMax: 300 });
    const timer = setTimeout(() => reject(new Error(`${name}: connect timed out`)), 8000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      reject(new Error(`${name}: ${err.message}`));
    });
  });
}

const ack = (socket, event, payload) => new Promise((resolve) => emitWithin(socket, event, payload, resolve, 8000));

/** A legal action for the client's seat from the client's OWN copy of the match: a drop half of the time when there is one, otherwise a move (a queen when it promotes). */
function pickAction(match, seat) {
  const { moves, drops } = legalActions(match, seat);
  const board = seat < 2 ? 'A' : 'B';
  if (drops.length > 0 && (moves.length === 0 || rng() < 0.5)) {
    const drop = drops[Math.floor(rng() * drops.length)];
    return { kind: 'drop', board, piece: drop.piece, square: drop.square };
  }
  if (moves.length === 0) return null;
  const queenOnly = moves.filter((m) => !m.promotion || m.promotion === 'q');
  const move = queenOnly[Math.floor(rng() * queenOnly.length)];
  return { kind: 'move', board, from: move.from, to: move.to, ...(move.promotion ? { promotion: move.promotion } : {}) };
}

async function startBackend() {
  if ([3000, 8081, 8082].includes(PORT)) throw new Error(`port ${PORT} is reserved`);
  if (!(await portIsFree(PORT))) throw new Error(`port ${PORT} is in use; set BUGHOUSE_CLIENT_TEST_PORT`);
  const databaseUrl = resolveDatabaseUrl();
  if (!isLocalDatabaseUrl(databaseUrl ?? '')) throw new Error('DATABASE_URL is not a local database: this test only runs against this machine');
  const tsxCli = join(BACKEND, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const child = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
    cwd: BACKEND,
    env: { ...process.env, PORT: String(PORT), FOUR_FILL_MS: '3000', FOUR_GRACE_MS: '30000', NODE_ENV: 'development' },
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  });
  const t0 = Date.now();
  for (;;) {
    try {
      if ((await fetch(`${URL}/health`)).ok) return child;
    } catch {
      /* not up yet */
    }
    if (Date.now() - t0 > 60_000) {
      killTree(child);
      throw new Error('the backend did not answer /health');
    }
    await sleep(250);
  }
}

async function main() {
  const backend = await startBackend();
  const sockets = [];
  try {
    console.log(`\n=== the app's online Bughouse client against the real backend (${URL}) ===`);
    // --- the queue, as the queue screen does it ---------------------------------------------------------------------------------------
    const players = [];
    for (const name of ['X', 'Y']) {
      const socket = await connect(name);
      sockets.push(socket);
      const found = new Promise((resolve) => socket.once('bug_match_found', resolve));
      players.push({ name, socket, found, lines: [], sounds: 0, ended: 0 });
    }
    const join = validateBugJoinQueue({ timeControl: TC1 });
    check(join.ok, 'the client validates its join request before sending it');
    for (const p of players) {
      const answer = await ack(p.socket, 'bug_join_queue', join.value);
      check(answer.unreachable === false && answer.ack.ok === true, `${p.name}: bug_join_queue is answered within the deadline and accepted`);
    }
    const matches = await Promise.all(players.map((p) => p.found));
    check(matches[0].roomId === matches[1].roomId && matches[0].seat !== matches[1].seat, 'both clients are matched into ONE room, on different seats');
    check(matches[0].seats.filter((s) => s.kind === 'bot').length === 2, 'the two other seats are filled by bots after the fill wait');
    const roomId = matches[0].roomId;

    // --- a spectator socket that sees the whole game (the server's own story) ----------------------------------------------------------
    const spectator = await connect('S');
    sockets.push(spectator);
    const watched = { states: [], over: null };
    spectator.on('bug_state', (p) => p.roomId === roomId && watched.states.push(p));
    spectator.on('bug_game_over', (p) => p.roomId === roomId && (watched.over = p));
    const spectated = await ack(spectator, 'bug_spectate_game', { roomId });
    check(spectated.unreachable === false && spectated.ack.ok === true, 'a spectator joins the same room');

    // --- the sessions: the app's own class on the real sockets -----------------------------------------------------------------------
    players.forEach((p, i) => {
      p.match = matches[i];
      p.session = new BughouseOnlineSession(p.socket, { match: matches[i], resume: false }, { now: () => Date.now(), moveSound: () => p.sounds++, gameEnded: () => p.ended++, log: (m) => p.lines.push(m) });
      p.session.start();
      p.sentAtSeq = -1;
      p.actions = 0;
    });
    const viewOf = (p) => p.session.state.view;
    check(players.every((p) => viewOf(p) !== null && viewOf(p).mySeat === p.match.seat && p.session.state.connection === 'connected'), 'each session starts on its own seat, connected, from the match_found snapshot');

    // --- W4b: a spectator SESSION (the app's class, no seat) and the team messages -------------------------------------------------------
    const spectatorSocket = await connect('S2');
    sockets.push(spectatorSocket);
    const heard = { chat: 0, quick: 0 };
    spectatorSocket.on('bug_chat_from', () => heard.chat++);
    spectatorSocket.on('bug_quick_from', () => heard.quick++);
    spectator.on('bug_chat_from', () => heard.chat++);
    spectator.on('bug_quick_from', () => heard.quick++);
    const watching = new BughouseOnlineSession(spectatorSocket, { spectate: { roomId } }, { now: () => Date.now(), moveSound: () => undefined, gameEnded: () => undefined, log: () => undefined });
    watching.start();
    await until('the spectator session to hold the room', () => watching.state.view !== null && watching.state.connection === 'connected');
    check(watching.state.view.spectator === true && watching.state.view.roomId === roomId, 'a spectator SESSION reads the room through bug_spectate_game and holds no seat');
    watching.sendAction({ kind: 'move', board: 'A', from: 'e2', to: 'e4' });
    const refusedChat = await new Promise((resolve) => watching.sendChat('hello', resolve));
    check(refusedChat === 'The game is over.', 'a spectator session sends no chat line (nothing leaves the client)');
    const [x, y] = players;
    const partnersAreHuman = partnerOf(x.match.seat) === y.match.seat;
    const quickOutcome = await new Promise((resolve) => x.session.sendQuick(3, resolve));
    const chatOutcome = await new Promise((resolve) => x.session.sendChat('  take the knight  ', resolve));
    if (partnersAreHuman) {
      checkConditional(quickOutcome === null && chatOutcome === null, 'X and Y are partners: the quick message and the chat line are accepted');
      await until('Y to receive both', () => y.session.state.quick !== null && y.session.state.chat.length === 1);
      checkConditional(y.session.state.quick.text ==='Need a queen' && y.session.state.quick.seat === x.match.seat, "Y's toast says what X sent, from X's seat");
      checkConditional(y.session.state.chat[0].text ==='take the knight' && y.session.state.chat[0].mine === false, 'Y reads the line, trimmed, as not mine');
      checkConditional(x.session.state.chat.length === 1 && x.session.state.chat[0].mine === true && x.session.state.quick === null, "X sees the echo of the chat line as mine and no quick message of its own");
    } else {
      checkConditional(quickOutcome === 'Your partner is a bot.' && chatOutcome === 'Your partner is a bot.', "X's partner is a bot: both are refused in words, nothing is delivered");
      checkConditional(y.session.state.quick === null && y.session.state.chat.length === 0, 'Y (an opponent) receives nothing');
    }
    await sleep(300);
    check(heard.chat === 0 && heard.quick === 0, 'neither spectator socket was sent a chat line or a quick message');
    check(watching.state.chat.length === 0 && watching.state.quick === null, 'the spectator session shows none');

    // --- play -------------------------------------------------------------------------------------------------------------------------
    let dropped = false;
    let rejoinChecked = false;
    const droppedPlayer = players[0];
    let seqAtDrop = 0;
    let boardKeyBefore = 0;
    const t0 = Date.now();
    let resignedBy = null;
    while (!players.some((p) => isOver(viewOf(p)))) {
      if (Date.now() - t0 > 240_000) throw new Error('the game did not finish in time');
      const lead = viewOf(players[1]);
      // half-way: cut the first client's connection (the transport; the manager reconnects by itself) and wait for the rejoin
      if (!dropped && lead.match.seq >= 8) {
        dropped = true;
        seqAtDrop = viewOf(droppedPlayer).match.seq;
        boardKeyBefore = droppedPlayer.session.state.boardKey;
        droppedPlayer.socket.io.engine.close();
        await until('the cut client to notice it is offline', () => droppedPlayer.session.state.connection === 'reconnecting', 10_000);
        check(true, 'X: the session shows "reconnecting" when its connection is cut');
        await until('the cut client to be back and rejoined', () => droppedPlayer.session.state.connection === 'connected' && droppedPlayer.session.state.boardKey > boardKeyBefore, 20_000);
        rejoinChecked = true;
        check(viewOf(droppedPlayer).match.seq >= seqAtDrop && droppedPlayer.session.state.problem === null, 'X: it rejoined by itself (bug_rejoin with its token) and holds a room at least as new as before the cut');
        check(droppedPlayer.lines.some((l) => /own connection dropped/.test(l)) && droppedPlayer.lines.some((l) => /bug_rejoin state/.test(l)), 'X: the Diagnostic Log says the connection dropped and the rejoin succeeded (one line each)');
      }
      for (const p of players) {
        const view = viewOf(p);
        if (!view || isOver(view) || p.session.state.connection !== 'connected' || view.pending !== null || view.resyncing) continue;
        if (view.match.seq <= p.sentAtSeq) continue; // the position this client last acted on has not moved on yet
        // a person is not faster than the server's rate limit (10 actions a second per seat): when the two clients are OPPONENTS on one board they would otherwise answer each other every 20 ms
        if (Date.now() - (p.sentAt ?? 0) < 150) continue;
        if (p.actions >= MAX_ACTIONS_EACH) {
          if (resignedBy === null && p === players[1]) {
            resignedBy = p.name;
            p.session.resign(() => undefined);
          }
          continue;
        }
        const action = pickAction(view.match, view.mySeat);
        if (action === null) continue;
        p.sentAtSeq = view.match.seq;
        p.sentAt = Date.now();
        p.actions++;
        p.session.sendAction(action);
      }
      await sleep(20);
    }
    check(dropped && rejoinChecked, 'the game ran past the cut and the rejoin');
    await until('both clients to hold the result', () => players.every((p) => isOver(viewOf(p))), 20_000);
    await until('the spectator to see the end', () => watched.over !== null, 10_000);

    // --- the end: everyone holds the same match --------------------------------------------------------------------------------------
    const finals = players.map((p) => serializeMatch(viewOf(p).match));
    const lastWatched = watched.states[watched.states.length - 1];
    check(finals[0] === finals[1], 'both clients hold the very same final match, byte for byte');
    await until('the spectator session to hold the result', () => isOver(watching.state.view), 10_000);
    check(serializeMatch(watching.state.view.match) === finals[0] || resultOf(watching.state.view) !== null, 'the spectator SESSION followed the game to its result');
    check(resultOf(watching.state.view) !== null && JSON.stringify(resultOf(watching.state.view)) === JSON.stringify(resultOf(viewOf(players[0]))), 'and shows the same result as the players');
    check(lastWatched !== undefined && finals[0] === lastWatched.state, "and it is the last snapshot the spectator was sent (the server's own)");
    const result = resultOf(viewOf(players[0]));
    check(result !== null && JSON.stringify(result) === JSON.stringify(resultOf(viewOf(players[1]))), 'both clients show the same result');
    check(JSON.stringify(result) === JSON.stringify(watched.over.result), "the result is the one the server announced (bug_game_over)");
    check(players.every((p) => p.ended === 1), 'each session announced the end of the game exactly once');
    check(players.every((p) => !p.lines.some((l) => /handler failed/.test(l))), 'no handler of either session failed');
    check(players.every((p) => p.sounds > 0), 'moves were heard (the sound hook ran) in both sessions');
    const decided = !('voided' in result);
    check(decided, 'the match has a decided result (no draw, not voided)');
    checkConditional(['checkmate', 'flag', 'resign'].includes(result.reason), `the game ended by ${result.reason} (board ${result.board}, team ${result.winnerTeam} wins)`);
    checkConditional(players.every((p) => p.actions > 0), `both clients played (${players.map((p) => `${p.name} ${p.actions} actions`).join(', ')})`);
    const refused = players.flatMap((p) => p.lines.filter((l) => /refused/.test(l)));
    checkConditional(refused.length === 0 || refused.every((l) => /notYourTurn|time|over/.test(l)), `refusals, if any, were only races with the clock or the turn (${refused.length}: ${[...new Set(refused)].join(' | ')})`);
    const parsed = deserializeMatch(lastWatched.state);
    check(parsed.ok && parsed.match.result !== null, 'the last snapshot parses and carries the result');
    console.log(`\n${passed} checks passed (${conditional} conditional, counted apart)`);
  } finally {
    for (const s of sockets) s.disconnect();
    killTree(backend);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
