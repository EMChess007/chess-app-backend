/**
 * The shared helpers of the Bughouse browser suites (command #34, W8): the server's story of one room through a real spectator socket, the comparison of every board of every screen with
 * it, taps by test id, the seat a screen says it has, a seeded random stream. `bughouse-online.mjs` (W4's two-human game) keeps its own older copies; new scenarios use this kit
 * (folding the old file into it is a W9 clean-up, not a behaviour change).
 *
 * No assertion here depends on how long anything takes: every wait ends on a condition, its bound only turns a hang into a failure.
 */
import { io } from 'socket.io-client';
import { sleep } from './stack.mjs';
// (the app's engine, file by file: a namespace import of its index exposes nothing under tsx, as in truth.mjs)
import { deserializeMatch } from '../../../src/logic/bughouse/snapshot.ts';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PIECE_WORD = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
export const emitAck = (socket, event, payload) => new Promise((resolve, reject) => socket.timeout(8000).emit(event, payload, (err, res) => (err ? reject(new Error(`"${event}" ack never arrived`)) : resolve(res))));

export const squares = [];
for (const file of 'abcdefgh') for (let rank = 1; rank <= 8; rank++) squares.push(`${file}${rank}`);

/** A connected socket.io client (a spectator or an observer: it never joins a seat). */
export async function connectSocket(apiUrl) {
  const socket = io(apiUrl, { transports: ['websocket'], reconnection: false });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
}

/**
 * The server's story of one room, through a spectator socket: the newest snapshot, every board that ever saw a move or a drop, the events seen (`events`), and EVERY event name the
 * socket received (`received`, so a test can prove the spectator was never sent a team chat line or a quick message).
 */
export async function watchRoom(apiUrl, names) {
  const socket = await connectSocket(apiUrl);
  let room = null;
  for (let i = 0; i < 600 && !room; i++) {
    const { ok: listed, games } = await emitAck(socket, 'bug_list_active_games', {});
    if (listed) room = games.find((g) => names.every((n) => g.seats.some((s) => s.name === n))) ?? null;
    if (!room) await sleep(100);
  }
  if (!room) throw new Error(`the server never listed a room with ${names.join(', ')}`);
  const watched = { roomId: room.roomId, seq: -1, match: null, movedBoards: new Set(), over: null, seats: [], events: [], received: [], socket };
  const adopt = (seq, text) => {
    if (seq <= watched.seq) return;
    const parsed = deserializeMatch(text);
    if (!parsed.ok) throw new Error(`unreadable snapshot: ${parsed.error}`);
    watched.seq = seq;
    watched.match = parsed.match;
  };
  socket.onAny((event, payload) => watched.received.push({ event, payload }));
  socket.on('bug_state', (p) => {
    if (p.roomId !== room.roomId) return;
    for (const e of p.events ?? []) {
      watched.events.push(e);
      if (e.kind === 'move' || e.kind === 'drop') watched.movedBoards.add(e.board);
    }
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

/** What the FEN of a board puts on each square: { e4: 'White pawn' }. */
export function expectedCells(fen) {
  const out = {};
  fen.split(' ')[0].split('/').forEach((row, i) => {
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
export async function boardMismatches(user, board, fen) {
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
export async function converge(watched, users, what, timeoutMs = 30_000) {
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

/** A click or touch in the middle of the element with this test id. */
export async function tap(user, testId) {
  const target = user.page.locator(`[data-testid="${testId}"]`).first();
  // (a short window - a landscape phone - scrolls the game screen: bring the element into view first, a click outside the window goes nowhere)
  await target.scrollIntoViewIfNeeded().catch(() => {});
  const box = await target.boundingBox();
  if (!box) throw new Error(`${user.name}: ${testId} is not on screen`);
  if (user.touch) await user.page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  else await user.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(60);
}

/** Where a user sits, read from the screen itself ("You: Board A · White · Team 1 · Partner: ..."). */
export async function seatOnScreen(user) {
  const text = await user.page.locator('[data-testid="bughouse-online-intro"]').first().innerText();
  const m = /Board ([AB]) · (White|Black) · Team (\d)/.exec(text);
  if (!m) throw new Error(`${user.name}: cannot read the seat from "${text}"`);
  return { board: m[1], color: m[2] === 'White' ? 'w' : 'b', seat: (m[1] === 'A' ? 0 : 2) + (m[2] === 'White' ? 0 : 1), team: Number(m[3]), text };
}

/**
 * The Play menu > Bughouse > Online > a time control, for `user`. The Bughouse card's Online button carries the label "Bughouse online".
 */
export async function queueBughouse(user, timeControl = '1 min') {
  await user.tapText('Play');
  await user.press(user.page.getByLabel('Bughouse online'));
  await user.tapText(timeControl);
}

/** The first board square of `user`'s screen for a text read out of a board's cell labels: used by the orientation check ("a1" is lower on the screen than "a8" for White). */
export async function cellTop(user, board, square) {
  const box = await user.page.locator(`[data-testid="${board}-${square}"]`).first().boundingBox();
  if (!box) throw new Error(`${user.name}: ${board}-${square} is not on screen`);
  return box.y;
}

/** True when `board` is drawn with White at the bottom on this screen (a1 lower than a8). */
export async function whiteAtBottom(user, board) {
  return (await cellTop(user, board, 'a1')) > (await cellTop(user, board, 'a8'));
}

/**
 * One legal action for `seat` by taps, chosen from the server's position with the seeded stream: a drop when one is possible (and the dice say so, or no move is), otherwise a plain move.
 * Returns the action taken, or null when the seat cannot act now. `legalActions` is the app's own engine (src/logic/bughouse/match.ts), passed in by the caller.
 */
export async function actByTaps({ legalActions, watched, user, place, rng, dropShare = 0.4 }) {
  const { moves, drops } = legalActions(watched.match, place.seat);
  const plain = moves.filter((m) => !m.promotion);
  if (plain.length === 0 && drops.length === 0) return null;
  const board = place.board;
  if (drops.length > 0 && (plain.length === 0 || rng() < dropShare)) {
    const drop = drops[Math.floor(rng() * drops.length)];
    await tap(user, `pocket-${board}-${place.color === 'w' ? 'white' : 'black'}-${drop.piece}`);
    await tap(user, `${board}-${drop.square}`);
    return { kind: 'drop', ...drop };
  }
  const move = plain[Math.floor(rng() * plain.length)];
  await tap(user, `${board}-${move.from}`);
  await tap(user, `${board}-${move.to}`);
  return { kind: 'move', ...move };
}
