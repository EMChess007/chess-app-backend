#!/usr/bin/env node
/**
 * A FRIEND for one phone (command #32, W6): friend rooms need TWO logged-in people. Run this next to your local backend, create a room on the phone ("Play with a friend"), read the 6-character
 * code off the phone and start the buddy with it: it registers a throw-away account on YOUR LOCAL backend, joins the room as the friend (the phone shows "Friend: <name>") and, once the phone
 * starts the match (Start with bots, or Find opponents), plays random legal moves and drops as the phone's teammate until the game is over. Then it leaves.
 *
 *   npm run bughouseFriendBuddy -- K7M2PQ        (from backend/; BACKEND_URL=http://localhost:3000 by default)
 *   ROOM_CODE=K7M2PQ npm run bughouseFriendBuddy
 *
 * It is a plain socket.io client plus one POST /auth/register on the backend you name: the account is a local test account (e2e-friend-xxxx@example.test). It refuses a BACKEND_URL that is
 * not localhost / 127.0.0.1 / 10.0.2.2 (the emulator's host) so it can never create accounts on a deployed server. It plays quickly and badly on purpose. Ctrl+C stops it.
 */
import { randomBytes } from 'node:crypto';
import { io } from 'socket.io-client';
import { deserializeMatch, legalActions, seatPlace } from '../src/game/bughouse/index.ts';

const URL_ARG = process.env.BACKEND_URL ?? 'http://localhost:3000';
const CODE = (process.argv[2] ?? process.env.ROOM_CODE ?? '').trim().toUpperCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ask = (socket, event, payload) => new Promise((resolve) => socket.timeout(8000).emit(event, payload, (err, res) => resolve(err ? { ok: false, error: 'no answer' } : res)));

if (!/^[A-HJKMNP-Z2-9]{6}$/.test(CODE)) {
  console.error('usage: npm run bughouseFriendBuddy -- <6-character room code>');
  process.exit(2);
}
const host = new globalThis.URL(URL_ARG).hostname;
if (!['localhost', '127.0.0.1', '::1', '[::1]', '10.0.2.2'].includes(host)) {
  console.error(`refusing to register an account on ${host}: the friend buddy is for a LOCAL backend only`);
  process.exit(2);
}

function pick(match, seat) {
  const { moves, drops } = legalActions(match, seat);
  const board = seatPlace(seat).board;
  if (drops.length > 0 && (moves.length === 0 || Math.random() < 0.5)) {
    const drop = drops[Math.floor(Math.random() * drops.length)];
    return { event: 'bug_drop', payload: { board, piece: drop.piece, square: drop.square } };
  }
  const plain = moves.filter((m) => !m.promotion || m.promotion === 'q');
  if (plain.length === 0) return null;
  const move = plain[Math.floor(Math.random() * plain.length)];
  return { event: 'bug_move', payload: { board, from: move.from, to: move.to, ...(move.promotion ? { promotion: move.promotion } : {}) } };
}

const tag = randomBytes(4).toString('hex');
const account = { username: `friend${tag}`, email: `e2e-friend-${tag}@example.test`, password: `Pw${randomBytes(8).toString('hex')}` };
const registered = await fetch(`${URL_ARG}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(account) });
if (registered.status !== 201) {
  console.error(`friend buddy: could not register an account (HTTP ${registered.status})`);
  process.exit(1);
}
const { token } = await registered.json();

const socket = io(URL_ARG, { transports: ['websocket'], auth: { token } });
await new Promise((resolve, reject) => {
  socket.once('connect', resolve);
  socket.once('connect_error', (err) => reject(new Error(`cannot reach ${URL_ARG}: ${err.message}`)));
});
const found = new Promise((resolve) => socket.once('bug_match_found', resolve));
const joined = await ask(socket, 'bug_room_join', { code: CODE });
if (!joined.ok) {
  console.error(`friend buddy: could not join the room: ${joined.error}`);
  process.exit(1);
}
console.log(`friend buddy: joined the room of ${joined.room.hostName} as ${account.username}; start the match on the phone`);
socket.on('bug_room_closed', () => {
  console.log('friend buddy: the room closed');
  process.exit(0);
});

const match = await found;
console.log(`friend buddy: match found (seat ${match.seat}); playing`);
let text = match.state;
let over = false;
socket.on('bug_state', (p) => p.roomId === match.roomId && p.seq > 0 && (text = p.state));
socket.once('bug_game_over', () => (over = true));
while (!over) {
  const parsed = deserializeMatch(text);
  if (parsed.ok && parsed.match.result === null) {
    const action = pick(parsed.match, match.seat);
    if (action) await ask(socket, action.event, { roomId: match.roomId, ...action.payload });
  } else if (parsed.ok) break;
  await sleep(600 + Math.random() * 900);
}
console.log('friend buddy: game over');
socket.disconnect();
process.exit(0);
