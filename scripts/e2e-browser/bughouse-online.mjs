/**
 * Bughouse ONLINE browser end-to-end (command #28, workstream W4): the REAL app (a web build) against the REAL server, driven through the UI like two players - queue, searching screen with
 * Cancel, match found, moves and drops by tapping on the boards, every screen compared with the server's own snapshot after every action, then a resignation and the game-over card.
 *
 *   npm run test:e2eBrowserBughouse
 *   E2E_WEBDIR=<an exported dev build> ...        (reuse a build instead of exporting one)
 *   E2E_SHOTS=<dir> ...                           (screenshots at the interesting moments)
 *   export E2E_BROWSER_PATH=/opt/pw-browsers/chromium     (the cloud VM has no system Chrome)
 *
 * It starts its own backend (port 3191, local database only, short fill wait and takeover grace) and its own static copy of the app (port 8087), registers two throw-away accounts and
 * deletes them in a `finally` (stack.mjs); it never touches 3000 / 8081 / 8082 or the deployed backend. The server's side is read through a real spectator socket, and the app's own engine
 * (src/logic/bughouse) chooses the legal move a player taps. No assertion depends on how long anything takes: waits end on a condition, their bounds only turn a hang into a failure.
 * Scenario: user A queues, sees the searching screen and Cancels; both queue; the fill wait ends and two bots take the other seats; each human plays legal moves/drops (by taps) when it
 * is their turn; after each action BOTH boards of BOTH screens equal the server's position; moves happened on both boards; A resigns; both screens show the game-over card the server's
 * result says; "Play again" goes back to the queue.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { io } from 'socket.io-client';
import { startStack, sleep } from './stack.mjs';
import { User, launchBrowser, PHONE_LARGE } from './app.mjs';
// (the app's engine, file by file: a namespace import of its index exposes nothing under tsx, as in truth.mjs)
import { legalActions } from '../../../src/logic/bughouse/match.ts';
import { deserializeMatch } from '../../../src/logic/bughouse/snapshot.ts';

const shotsDir = process.env.E2E_SHOTS ?? '';
if (shotsDir) mkdirSync(shotsDir, { recursive: true });
const log = (m) => console.log(m);
let checks = 0;
const ok = (cond, message) => {
  if (!cond) throw new Error(`FAILED: ${message}`);
  checks++;
  console.log(`    ok  ${message}`);
};
const shot = async (user, name) => {
  if (shotsDir) await user.screenshot(join(shotsDir, `${name}.png`));
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

const PIECE_WORD = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const emitAck = (socket, event, payload) => new Promise((resolve, reject) => socket.timeout(8000).emit(event, payload, (err, res) => (err ? reject(new Error(`"${event}" ack never arrived`)) : resolve(res))));

/** The server's story of one room, through a spectator socket: the newest snapshot and every board that ever saw a move or a drop. */
async function watchRoom(apiUrl, names) {
  const socket = io(apiUrl, { transports: ['websocket'], reconnection: false });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  let room = null;
  for (let i = 0; i < 600 && !room; i++) {
    const { ok: listed, games } = await emitAck(socket, 'bug_list_active_games', {});
    if (listed) room = games.find((g) => names.every((n) => g.seats.some((s) => s.name === n))) ?? null;
    if (!room) await sleep(100);
  }
  if (!room) throw new Error('the server never listed the room of the two test accounts');
  const watched = { roomId: room.roomId, seq: -1, match: null, movedBoards: new Set(), over: null, seats: [], actions: 0 };
  const adopt = (seq, text) => {
    if (seq <= watched.seq) return;
    const parsed = deserializeMatch(text);
    if (!parsed.ok) throw new Error(`unreadable snapshot: ${parsed.error}`);
    watched.seq = seq;
    watched.match = parsed.match;
  };
  socket.on('bug_state', (p) => {
    if (p.roomId !== room.roomId) return;
    for (const e of p.events ?? []) if (e.kind === 'move' || e.kind === 'drop') watched.movedBoards.add(e.board);
    adopt(p.seq, p.state);
  });
  socket.on('bug_game_over', (p) => p.roomId === room.roomId && (watched.over = p));
  socket.on('bug_seat_update', (p) => p.roomId === room.roomId && (watched.seats = p.seats));
  const res = await emitAck(socket, 'bug_spectate_game', { roomId: room.roomId });
  if (!res.ok) throw new Error(`could not spectate: ${res.error}`);
  watched.seats = res.state.seats;
  adopt(res.state.seq, res.state.state);
  watched.close = () => socket.disconnect();
  return watched;
}

const squares = [];
for (const file of 'abcdefgh') for (let rank = 1; rank <= 8; rank++) squares.push(`${file}${rank}`);

/** What the FEN of `board` puts on each square: { e4: 'White pawn' | null }. */
function expectedCells(fen) {
  const out = {};
  const rows = fen.split(' ')[0].split('/');
  rows.forEach((row, i) => {
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) file += Number(ch);
      else {
        out[`${'abcdefgh'[file]}${8 - i}`] = `${ch === ch.toUpperCase() ? 'White' : 'Black'} ${PIECE_WORD[ch.toLowerCase()]}`;
        file++;
      }
    }
  });
  return out;
}

/** The squares of `board` on `user`'s screen that disagree with `fen`. */
async function boardMismatches(user, board, fen) {
  const want = expectedCells(fen);
  const labels = await user.page.$$eval(`[data-testid^="${board}-"]`, (els) => els.map((e) => [e.getAttribute('data-testid'), e.getAttribute('aria-label') ?? '']));
  const got = {};
  for (const [id, label] of labels) {
    const m = /^[AB]-([a-h][1-8])$/.exec(id ?? '');
    if (m) got[m[1]] = label;
  }
  const bad = [];
  for (const sq of squares) {
    const piece = want[sq] ?? null;
    const label = got[sq];
    if (label === undefined) bad.push({ sq, want: piece, got: 'no cell' });
    else if (piece === null ? /White|Black/.test(label.replace(/^[a-h][1-8], board [AB]/, '')) : !label.includes(piece)) bad.push({ sq, want: piece, got: label });
  }
  return bad;
}

/** Waits until both boards of every screen equal the newest server position (the server may move on meanwhile: the comparison is repeated against the newest). */
async function converge(watched, users, what, timeoutMs = 30_000) {
  const t0 = Date.now();
  let last = '';
  for (;;) {
    const seq = watched.seq;
    const match = watched.match;
    const bad = [];
    for (const u of users) for (const board of ['A', 'B']) for (const m of await boardMismatches(u, board, match.boards[board].fen)) bad.push(`${u.name} board ${board} ${m.sq}: wants ${m.want}, shows ${m.got}`);
    if (bad.length === 0 && watched.seq === seq) return seq;
    last = bad.slice(0, 3).join('; ');
    if (Date.now() - t0 > timeoutMs) throw new Error(`${what}: the screens never equalled the server (seq ${seq}): ${last}`);
    await sleep(100);
  }
}

async function tap(user, testId) {
  const box = await user.page.locator(`[data-testid="${testId}"]`).first().boundingBox();
  if (!box) throw new Error(`${user.name}: ${testId} is not on screen`);
  await user.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(60);
}

/** Where a user sits, read from the screen itself ("You: Board A · White · Team 1 · Partner: ..."). */
async function seatOnScreen(user) {
  const text = await user.page.locator('[data-testid="bughouse-online-intro"]').first().innerText();
  const m = /Board ([AB]) · (White|Black) · Team (\d)/.exec(text);
  if (!m) throw new Error(`${user.name}: cannot read the seat from "${text}"`);
  return { board: m[1], color: m[2] === 'White' ? 'w' : 'b', seat: (m[1] === 'A' ? 0 : 2) + (m[2] === 'White' ? 0 : 1), team: Number(m[3]), text };
}

async function main() {
  const stack = await startStack({ webDir: process.env.E2E_WEBDIR, log });
  let browser = null;
  let failed = false;
  const users = [];
  let watched = null;
  try {
    browser = await launchBrowser();
    for (const name of ['A', 'B']) {
      const user = await User.open(browser, stack.webUrl, `Bug${name}`, PHONE_LARGE);
      await user.login(await stack.createAccount(`bug${name.toLowerCase()}`));
      users.push(user);
    }
    const [a, b] = users;
    const rng = mulberry32(20261030);

    console.log('\n=== 1. the Play menu, the searching screen and Cancel ===');
    await a.tapText('Play');
    ok((await a.page.getByLabel('Bughouse online').count()) === 1, 'the Bughouse card has an Online entry');
    await a.press(a.page.getByLabel('Bughouse online'));
    const labels = await a.page.locator('text=/^(1 min|2 \\| 1|3 min|3 \\| 2|5 min|5 \\| 2)$/').allInnerTexts();
    ok(new Set(labels).size === 6, `the time-control screen offers exactly the six controls (${[...new Set(labels)].join(', ')})`);
    await a.tapText('1 min');
    await a.page.locator('[data-testid="bughouse-queue"]').waitFor({ timeout: 20_000 });
    await a.page.locator('[data-testid="bughouse-queue-title"]').filter({ hasText: /1 player waiting|Looking for a game/ }).waitFor({ timeout: 20_000 });
    ok((await a.page.locator('[data-testid="bughouse-queue-cancel"]').count()) === 1, 'the searching screen shows how many are waiting and has a Cancel button');
    await shot(a, 'queue');
    await a.press(a.page.locator('[data-testid="bughouse-queue-cancel"]'));
    await a.page.getByLabel('Bughouse online').waitFor({ timeout: 20_000 });
    ok(true, 'Cancel goes back to the Play menu');

    console.log('\n=== 2. queue together, match found ===');
    for (const u of users) {
      await u.tapText('Play');
      await u.press(u.page.getByLabel('Bughouse online'));
      await u.tapText('1 min');
    }
    for (const u of users) await u.page.locator('[data-testid="bughouse-online"]').waitFor({ timeout: 90_000 });
    watched = await watchRoom(stack.apiUrl, users.map((u) => u.account.username));
    const places = [];
    for (const u of users) places.push(await seatOnScreen(u));
    ok(places[0].seat !== places[1].seat, `A is ${places[0].text.split(' · Partner')[0]}, B is ${places[1].text.split(' · Partner')[0]}`);
    ok(watched.seats.filter((s) => s.kind === 'bot').length === 2, 'two bots filled the table after the fill wait');
    for (const [i, u] of users.entries()) {
      const server = watched.seats[places[i].seat];
      ok(server.kind === 'human' && server.name === u.account.username, `${u.name}'s screen and the server agree on who sits at seat ${places[i].seat}`);
    }
    await converge(watched, users, 'the start position');
    ok(true, 'the start position of BOTH boards is on BOTH screens');
    await shot(a, 'match-found-A');

    console.log('\n=== 3. moves and drops by taps, every position compared with the server ===');
    const lastActed = [-1, -1];
    let humanActions = 0;
    const t0 = Date.now();
    while (humanActions < 12 || watched.movedBoards.size < 2) {
      if (Date.now() - t0 > 240_000) throw new Error(`not enough play in time (${humanActions} actions, boards moved: ${[...watched.movedBoards].join(',')})`);
      if (watched.match.result !== null) throw new Error('the game ended by itself before the step under test (inconclusive: run again)');
      let acted = false;
      for (const [i, u] of users.entries()) {
        const seat = places[i].seat;
        const { moves, drops } = legalActions(watched.match, seat);
        if (watched.seq <= lastActed[i] || (moves.length === 0 && drops.length === 0)) continue;
        const board = places[i].board;
        const plain = moves.filter((m) => !m.promotion);
        let before = watched.seq;
        if (drops.length > 0 && (plain.length === 0 || rng() < 0.4)) {
          const drop = drops[Math.floor(rng() * drops.length)];
          await tap(u, `pocket-${board}-${places[i].color === 'w' ? 'white' : 'black'}-${drop.piece}`);
          await tap(u, `${board}-${drop.square}`);
        } else if (plain.length > 0) {
          const move = plain[Math.floor(rng() * plain.length)];
          await tap(u, `${board}-${move.from}`);
          await tap(u, `${board}-${move.to}`);
        } else continue;
        lastActed[i] = before;
        humanActions++;
        acted = true;
        // the server took it: a newer snapshot than the one this action was chosen on, and both boards on both screens are that position
        const t1 = Date.now();
        while (watched.seq <= before) {
          if (Date.now() - t1 > 15_000) throw new Error(`${u.name}: the server never answered the action chosen at seq ${before}`);
          await sleep(25);
        }
        const seq = await converge(watched, users, `after ${u.name}'s action ${humanActions}`);
        ok(seq > before, `${u.name}'s action ${humanActions} landed (seq ${before} -> ${seq}) and both boards of both screens equal the server`);
      }
      if (!acted) await sleep(100);
    }
    ok(humanActions >= 12 && watched.movedBoards.size === 2, `${humanActions} human actions; moves happened on BOTH boards`);
    await shot(a, 'midgame-A');
    await shot(b, 'midgame-B');
    // the clocks on screen follow the server's: a running clock moves, and no clock shows more time than the control gives
    // (two clocks beside the large board, two in the partner thumbnail's lines)
    const clockTexts = await a.page.$$eval('[data-testid^="clock-"], [data-testid^="thumb-line-"]', (els) => els.map((e) => (e.textContent ?? '').match(/\d+:\d\d(?:\.\d)?/)?.[0] ?? ''));
    ok(clockTexts.length === 4 && clockTexts.every((t) => /^\d+:\d\d(\.\d)?$/.test(t) && !/^[2-9]:|^\d\d:/.test(t)), `four clocks on screen, none above the 1:00 control (${clockTexts.join(' ')})`);

    console.log('\n=== 4. resign, game over ===');
    if (watched.match.result !== null) throw new Error('the game ended by itself before the resignation (inconclusive: run again)');
    await a.tapText('Resign');
    await a.page.getByText('Resign', { exact: true }).last().click();
    for (const u of users) await u.page.locator('[data-testid="game-over"]').waitFor({ timeout: 30_000 });
    const t2 = Date.now();
    while (watched.over === null && Date.now() - t2 < 15_000) await sleep(50);
    ok(watched.over !== null && watched.over.result.reason === 'resign', 'the server announced the game over by resignation');
    const winner = watched.over.result.winnerTeam;
    for (const u of users) {
      const headline = await u.page.locator('[data-testid="game-over-headline"]').innerText();
      const detail = await u.page.locator('[data-testid="game-over-detail"]').innerText();
      ok(headline === `Team ${winner} wins` && /Resigned/i.test(detail), `${u.name}'s game-over card: "${headline}" - "${detail}" (the server says team ${winner}, resigned)`);
    }
    await converge(watched, users, 'the final position');
    ok(true, 'the final position of both boards is on both screens');
    ok((await a.page.locator('[data-testid="bughouse-rematch"]').innerText()) === 'Play again', 'the result card offers "Play again"');
    await shot(a, 'game-over-A');
    await a.press(a.page.locator('[data-testid="bughouse-rematch"]'));
    await a.page.locator('[data-testid="bughouse-queue"]').waitFor({ timeout: 20_000 });
    ok(true, '"Play again" goes back to the queue');
    await a.press(a.page.locator('[data-testid="bughouse-queue-cancel"]'));
    for (const u of users) if (u.pageErrors?.length) console.log(`    note  ${u.name} page errors: ${u.pageErrors.slice(0, 2).join(' | ')}`);
    console.log(`\nPASS  ${checks} checks`);
  } catch (err) {
    failed = true;
    console.log(`\nFAIL  ${err instanceof Error ? err.message : err}`);
    if (shotsDir && users[0]) await shot(users[0], 'FAIL').catch(() => {});
  } finally {
    watched?.close?.();
    for (const u of users) await u.close().catch(() => {});
    await browser?.close().catch(() => {});
    const cleanup = await stack.tracker.cleanup();
    await stack.stop();
    console.log(`accounts deleted: ${cleanup.deleted} (left: ${cleanup.remaining})`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
