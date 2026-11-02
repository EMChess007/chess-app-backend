#!/usr/bin/env node
/**
 * A FRIEND for one phone, 4-seat edition (command #35): the 4 Player Variations friend rooms (4 Player Chess, 4 Player Giveaway, Chaturaji) need other logged-in people. Run this next to your LOCAL
 * backend, open a room on the phone (Play > Online > Challenge Friend > Create Challenge > a game > a time control), read the 6-character code off the phone and start the buddy with it: it
 * registers a throw-away account on YOUR LOCAL backend, joins the room as a friend (the phone's room shows its name in the next seat) and, when the phone starts the game, takes its seat and
 * stays connected (it does not play: its clock is the only thing that moves it, and the bots fill the rest). It leaves when the game is over or the room closes.
 *
 *   npm run fourFriendBuddy -- K7M2PQ        (from backend/; BACKEND_URL=http://localhost:3000 by default)
 *
 * It is a plain socket.io client plus one POST /auth/register on the backend you name; it refuses a BACKEND_URL that is not localhost / 127.0.0.1 / 10.0.2.2 (the emulator's host) so it can never create
 * accounts on a deployed server. Several buddies can join the same room (start one per friend).
 */
import { randomBytes } from 'node:crypto';
import { io } from 'socket.io-client';

const URL_ARG = process.env.BACKEND_URL ?? 'http://localhost:3000';
const CODE = (process.argv[2] ?? process.env.ROOM_CODE ?? '').trim().toUpperCase();
const ask = (socket, event, payload) => new Promise((resolve) => socket.timeout(8000).emit(event, payload, (err, res) => resolve(err ? { ok: false, error: 'no answer' } : res)));

if (!/^[A-HJKMNP-Z2-9]{6}$/.test(CODE)) {
  console.error('usage: npm run fourFriendBuddy -- <6-character room code>');
  process.exit(2);
}
const host = new globalThis.URL(URL_ARG).hostname;
if (!['localhost', '127.0.0.1', '::1', '[::1]', '10.0.2.2'].includes(host)) {
  console.error(`refusing to register an account on ${host}: the friend buddy is for a LOCAL backend only`);
  process.exit(2);
}

const tag = randomBytes(4).toString('hex');
const account = { username: `friend${tag}`, email: `e2e-friend-${tag}@example.test`, password: `Pw${randomBytes(8).toString('hex')}` };
const registered = await fetch(`${URL_ARG}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(account) });
if (registered.status !== 201) {
  console.error(`four friend buddy: could not register an account (HTTP ${registered.status})`);
  process.exit(1);
}
const { token } = await registered.json();

const socket = io(URL_ARG, { transports: ['websocket'], auth: { token } });
await new Promise((resolve, reject) => {
  socket.once('connect', resolve);
  socket.once('connect_error', (err) => reject(new Error(`cannot reach ${URL_ARG}: ${err.message}`)));
});
const joined = await ask(socket, 'four_room_join', { code: CODE });
if (!joined.ok) {
  console.error(`four friend buddy: could not join the room: ${joined.error}`);
  process.exit(1);
}
console.log(`four friend buddy: joined the ${joined.room.variant} room of ${joined.room.hostName} as ${account.username}; start the game on the phone`);
socket.on('four_room_closed', () => {
  console.log('four friend buddy: the room closed');
  process.exit(0);
});
socket.once('four_match_found', (match) => console.log(`four friend buddy: the game began (seat ${match.seat}); staying connected`));
socket.on('four_game_over', () => {
  console.log('four friend buddy: the game is over');
  process.exit(0);
});
