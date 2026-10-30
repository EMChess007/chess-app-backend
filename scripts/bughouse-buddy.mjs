#!/usr/bin/env node
/**
 * A SECOND HUMAN for one phone (command #28): the Bughouse queue starts a match only when TWO humans are waiting (BUGHOUSE_SPEC.md: a lone player waits for ever; then bots fill the rest).
 * Run this next to your local backend and it queues as a guest, plays random legal moves and drops until the game is over, then queues again - so the phone can play online Bughouse
 * against bots and this buddy without a second device.
 *
 *   npm run bughouseBuddy                         (from backend/; BACKEND_URL=http://localhost:3000 by default, TIME_CONTROL=1 for 1 min, 3 for 3 min, 5 for 5 min)
 *
 * It is a plain socket.io client: no account, no database, no secret. It plays quickly and badly on purpose. Ctrl+C stops it.
 */
import { io } from 'socket.io-client';
import { deserializeMatch, legalActions, seatPlace } from '../src/game/bughouse/index.ts';

const URL = process.env.BACKEND_URL ?? 'http://localhost:3000';
const MINUTES = Number(process.env.TIME_CONTROL ?? 1);
const TIME_CONTROL = { initialMs: MINUTES * 60000, incrementMs: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ask = (socket, event, payload) => new Promise((resolve) => socket.timeout(8000).emit(event, payload, (err, res) => resolve(err ? { ok: false, error: 'no answer' } : res)));

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

async function oneGame(socket) {
  const found = new Promise((resolve) => socket.once('bug_match_found', resolve));
  const joined = await ask(socket, 'bug_join_queue', { timeControl: TIME_CONTROL });
  if (!joined.ok) throw new Error(`could not queue: ${joined.error}`);
  console.log(`buddy: queued for ${MINUTES} min - start the game on the phone now`);
  const match = await found;
  console.log(`buddy: match found (seat ${match.seat}); playing`);
  let text = match.state;
  let over = false;
  const onState = (p) => p.roomId === match.roomId && p.seq > 0 && (text = p.state);
  socket.on('bug_state', onState);
  socket.once('bug_game_over', () => (over = true));
  while (!over) {
    const parsed = deserializeMatch(text);
    if (parsed.ok && parsed.match.result === null) {
      const action = pick(parsed.match, match.seat);
      if (action) await ask(socket, action.event, { roomId: match.roomId, ...action.payload });
    } else if (parsed.ok) break;
    await sleep(600 + Math.random() * 900);
  }
  socket.off('bug_state', onState);
  console.log('buddy: game over');
}

const socket = io(URL, { transports: ['websocket'] });
await new Promise((resolve, reject) => {
  socket.once('connect', resolve);
  socket.once('connect_error', (err) => reject(new Error(`cannot reach ${URL}: ${err.message}`)));
});
console.log(`buddy: connected to ${URL}`);
for (;;) {
  await oneGame(socket);
  await sleep(2000);
}
