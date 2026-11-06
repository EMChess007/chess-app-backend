#!/usr/bin/env node
/**
 * A SCRIPTED 2-player opponent for the Android end-to-end run (command #35b): it makes the phone's premove illegal on purpose, twice, so the run can look at the notice
 * "Premove was no longer legal — cancelled." (it must vanish at the next move and within 5 s, CHECKLIST 21). Plain socket.io client, a guest, localhost only.
 *
 *   node scripts/premove-opponent.mjs <6-character challenge code> [--delay=9000]
 *
 * The phone creates a Classic challenge (Challenge a Friend > Create Challenge) and reads its code; this script joins it. The colours are a coin flip on the server, so both are scripted.
 * Every reply waits `--delay` ms after the phone's move (long enough for the phone to touch its premove first):
 *
 *   phone WHITE (script Black)   1. e2-e4  [phone premoves e4-e5]   ...e7-e5   -> blocked, notice 1
 *                                2. d2-d4  [phone premoves d4xe5]   ...e5xd4   -> the premoved pawn is gone, notice 2   (the phone then plays Qd1xd4)
 *   phone BLACK (script White)   opens d2-d4 at once
 *                                1...d7-d6 [phone premoves d6-d5]   d4-d5      -> blocked, notice 1
 *                                2...c7-c6 [phone premoves c6xd5]   d5xc6      -> the premoved pawn is gone, notice 2   (the phone then plays Nb8xc6)
 *
 * After the second reply it plays nothing more, stays connected until the game ends or `--hold` ms (default 240000) passed, and prints one line per event. It never reads a secret.
 */
import { io } from 'socket.io-client';

const SERVER_URL = process.env.BACKEND_URL ?? 'http://localhost:3000';
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found ? Number(found.slice(name.length + 3)) : fallback;
};
const CODE = (args.find((a) => !a.startsWith('--')) ?? '').trim().toUpperCase();
const DELAY_MS = opt('delay', 9000);
const HOLD_MS = opt('hold', 240000);

if (!/^[A-HJKMNP-Z2-9]{6}$/.test(CODE) || !Number.isFinite(DELAY_MS) || DELAY_MS < 0 || DELAY_MS > 60000 || !Number.isFinite(HOLD_MS) || HOLD_MS < 1000 || HOLD_MS > 900000) {
  console.error('usage: node scripts/premove-opponent.mjs <6-character challenge code> [--delay=9000] [--hold=240000]');
  process.exit(2);
}
const host = new globalThis.URL(SERVER_URL).hostname;
if (!['localhost', '127.0.0.1', '::1', '[::1]', '10.0.2.2'].includes(host)) {
  console.error('premove-opponent: BACKEND_URL must be a local backend (it will not talk to a deployed server)');
  process.exit(2);
}

// the script's replies, by the colour the SCRIPT plays: [from, to] after the phone's 1st and 2nd move; White also opens
const REPLIES = { w: { opening: ['d2', 'd4'], afterPhone: [['d4', 'd5'], ['d5', 'c6']] }, b: { opening: null, afterPhone: [['e7', 'e5'], ['e5', 'd4']] } };

const log = (...parts) => console.log(`[${new Date().toISOString().slice(11, 19)}] premove-opponent:`, ...parts);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const socket = io(SERVER_URL, { transports: ['websocket'], reconnection: false });
const ask = (event, payload) => new Promise((resolve) => socket.timeout(8000).emit(event, payload, (err, res) => resolve(err ? { ok: false, error: 'no answer' } : res)));

let game = null; // { roomId, color, phoneMoves }
const done = (code) => {
  socket.disconnect();
  process.exit(code);
};
setTimeout(() => {
  log('hold time over: leaving');
  done(0);
}, HOLD_MS).unref();

async function play(from, to) {
  const res = await ask('make_move', { roomId: game.roomId, from, to });
  if (res.ok) log(`played ${from}-${to}`);
  else log(`${from}-${to} was REFUSED by the server: ${res.error}`);
}

socket.on('match_found', async (m) => {
  game = { roomId: m.roomId, color: m.color, phoneMoves: 0 };
  log(`match found: I am ${m.color === 'w' ? 'White' : 'Black'} (room ${m.roomId})`);
  const opening = REPLIES[m.color].opening;
  if (opening) {
    await sleep(2500);
    await play(...opening);
  }
});
socket.on('opponent_move', async () => {
  if (!game) return;
  const index = game.phoneMoves++;
  log(`the phone played its move ${index + 1}`);
  const reply = REPLIES[game.color].afterPhone[index];
  if (!reply) return;
  await sleep(DELAY_MS); // the phone touches its premove during this wait
  await play(...reply);
});
socket.on('game_over', (o) => {
  log(`game over: ${o?.reason}`);
  done(0);
});
socket.on('disconnect', () => process.exit(0));
socket.on('connect', async () => {
  log(`connected to ${SERVER_URL} as a guest`);
  const res = await ask('join_challenge', { code: CODE });
  if (!res.ok) {
    log(`could not join ${CODE}: ${res.error}`);
    done(1);
  }
  log(`joined challenge ${CODE}`);
});
