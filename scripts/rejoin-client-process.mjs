#!/usr/bin/env node
/**
 * A "restarted app", as a real separate OS process - used by test-rejoin-persist.mjs. It knows NOTHING in memory: all it is given is the file the
 * previous "app" saved (the same record the app's activeGameStorage writes, read with the app's own parseActiveGame), the server URL and what to do.
 *
 *   tsx scripts/rejoin-client-process.mjs --record <file> --url <http://...> [--make '<make_move payload without roomId>'] [--make-bug '{"event":..,"payload":..}'] [--listen <ms>]
 *
 * It connects a brand-new socket, rejoins the seat with the token from the file (rejoin_game for 2 players, four_rejoin for 4 Player, bug_rejoin for Bughouse), prints one JSON
 * line per thing that happens ({"event": ...}), optionally makes one move, listens for `--listen` ms (default 2500) and exits. Output is JSON lines on
 * stdout so the test can parse it; the token is never printed.
 */
import { readFileSync } from 'node:fs';
import { io } from 'socket.io-client';
import { parseActiveGame } from '../../src/logic/activeGame.ts';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const out = (obj) => console.log(JSON.stringify(obj));

// A Bughouse record is `{"kind":"bughouse","match":{"roomId":...,"playerToken":...}}`: the app has no `ActiveOnlineGame` kind for it yet (that is the client workstream, W4), so this process reads
// that one shape itself - exactly the two values the server needs - and keeps the app's own parseActiveGame for every other kind.
const recordText = readFileSync(arg('record'), 'utf8');
const bughouseRecord = (() => {
  try {
    const raw = JSON.parse(recordText);
    return raw && raw.kind === 'bughouse' && typeof raw.match?.roomId === 'string' && typeof raw.match?.playerToken === 'string' ? raw : null;
  } catch {
    return null;
  }
})();
const game = bughouseRecord ?? parseActiveGame(recordText);
if (!game) {
  out({ event: 'error', error: 'the record could not be read' });
  process.exit(2);
}
const url = arg('url') ?? 'http://localhost:3000';
const listenMs = Number(arg('listen') ?? 2500);
const make = arg('make') ? JSON.parse(arg('make')) : null;
// --make-bug '{"event":"bug_move","payload":{...without roomId}}': one Bughouse action made right after the rejoin
const makeBug = arg('make-bug') ? JSON.parse(arg('make-bug')) : null;

// --hold: everything that takes time (starting node + tsx, compiling the app's record module, reading the record) is done; say so and wait for "go" on
// stdin before touching the network. The caller (test-rejoin-persist.mjs) uses it so that the restart it measures against a server's disconnect grace is
// the handshake itself, not this process's start-up - which on a slow machine outlasts a 1.5 s grace and made the test depend on how fast the machine boots node.
if (process.argv.includes('--hold')) {
  out({ event: 'ready' });
  await new Promise((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', resolve);
  });
}

const socket = io(url, { transports: ['websocket'], reconnection: false });
const ack = (event, payload) =>
  new Promise((resolve, reject) => socket.timeout(5000).emit(event, payload, (err, res) => (err ? reject(new Error(`${event}: no answer`)) : resolve(res))));

for (const event of ['opponent_move', 'opponent_disconnected', 'opponent_reconnected', 'game_over', 'four_state', 'four_seat_update', 'four_game_over', 'bug_state', 'bug_seat_update', 'bug_game_over']) {
  socket.on(event, (payload) => out({ event, payload }));
}

socket.on('connect_error', (err) => {
  out({ event: 'error', error: `connect_error: ${err.message}` });
  process.exit(3);
});
socket.on('connect', async () => {
  try {
    if (game.kind === 'twoPlayer') {
      const res = await ack('rejoin_game', { roomId: game.match.roomId, playerToken: game.match.playerToken });
      out({ event: 'rejoined', kind: 'twoPlayer', ack: res });
      if (make && res.ok) out({ event: 'made', ack: await ack('make_move', { roomId: game.match.roomId, ...make }) });
    } else if (game.kind === 'bughouse') {
      const res = await ack('bug_rejoin', { roomId: game.match.roomId, playerToken: game.match.playerToken });
      out({ event: 'rejoined', kind: 'bughouse', ack: res });
      if (makeBug && res.ok && !res.finished) out({ event: 'made', ack: await ack(makeBug.event, { roomId: game.match.roomId, ...makeBug.payload }) });
    } else {
      const res = await ack('four_rejoin', { roomId: game.match.roomId, playerToken: game.match.playerToken });
      out({ event: 'rejoined', kind: 'fourPlayer', ack: res });
    }
  } catch (err) {
    out({ event: 'error', error: err instanceof Error ? err.message : String(err) });
  }
  setTimeout(() => {
    socket.disconnect();
    process.exit(0);
  }, listenMs);
});
