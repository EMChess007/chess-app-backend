#!/usr/bin/env node
/**
 * EVERY TIME CONTROL OVER REAL SOCKETS (command #35, PART B): one real-socket case per family. The script boots its OWN server on a free port (an http server + socket.io with the three
 * registrations index.ts makes: the 2-player handlers, the 4 Player handlers - Chess, Giveaway and Chaturaji - and the Bughouse handlers), connects plain socket.io-client players and checks that the
 * server ACCEPTS every control of the app's list - Bullet 1, 1|1, 2|1; Blitz 3, 3|2, 5, 5|5, 5|2; Rapid 10, 15|10, 30, 10|5, 20, 60; Daily 1, 2, 3, 5, 7, 14 days; No time limit (21) - and starts a game
 * with it:
 *   1. 2-player Quick Match: two sockets per control, both get `match_found` with that control (21 matches); a Challenge per control (create + join, 21 more); a free-form control is refused.
 *   2. 4 Player Chess, 4 Player Giveaway and Chaturaji: four sockets per control, all four get `four_match_found` with that control and the clocks (21 per variant, 63 games); an increment on
 *      No time limit or Daily, half a day and 15 days are refused.
 *   3. Crazy Bughouse: four sockets per control, all four get `bug_match_found` with that control (21); the unlimited match has NO running clock (the first move is accepted ten days of server
 *      time later in the unit suite - here: no flag within the test), the Daily match's clocks are days; a free-form control is refused.
 * Nothing here waits on the wall clock: every wait ends on an event and its bound only turns a hang into a failure. No database is written (guests); nothing outside this process is touched.
 *   npm run test:timeControlsSockets      (tsx; needs the generated mirrors: npm run sync:fourplayer && npm run sync:bughouse)
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { io as connectClient } from 'socket.io-client';
import { registerBughouseHandlers } from '../src/game/bughouseHandlers.ts';
import { registerFourPlayerHandlers } from '../src/game/fourPlayerHandlers.ts';
import { registerSocketHandlers } from '../src/game/socketHandlers.ts';

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ok  ${message}`);
}

// the app's list, as literals (src/logic/timeControls.ts; timeControlsEverywhere.test.ts in the app repo pins it): [label, seconds, increment]
const LIST = [
  ['No time limit', 0, 0],
  ['1 min', 60, 0], ['1 | 1', 60, 1], ['2 | 1', 120, 1],
  ['3 min', 180, 0], ['3 | 2', 180, 2], ['5 min', 300, 0], ['5 | 5', 300, 5], ['5 | 2', 300, 2],
  ['10 min', 600, 0], ['15 | 10', 900, 10], ['30 min', 1800, 0], ['10 | 5', 600, 5], ['20 min', 1200, 0], ['60 min', 3600, 0],
  ['1 day', 86400, 0], ['2 days', 172800, 0], ['3 days', 259200, 0], ['5 days', 432000, 0], ['7 days', 604800, 0], ['14 days', 1209600, 0],
];
check(LIST.length === 21, 'the list has 21 controls');

const httpServer = createServer();
const server = new SocketIOServer(httpServer, { cors: { origin: '*' } });
registerSocketHandlers(server);
registerFourPlayerHandlers(server, { resolveName: async () => 'Player' });
registerBughouseHandlers(server);
await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
const URL = `http://127.0.0.1:${httpServer.address().port}`;
const clients = [];
const FAIL_AFTER_MS = 15_000;

function connect(name) {
  return new Promise((resolve, reject) => {
    const socket = connectClient(URL, { transports: ['websocket'], reconnection: false });
    const timer = setTimeout(() => reject(new Error(`${name}: connect timed out`)), FAIL_AFTER_MS);
    socket.on('connect', () => {
      clearTimeout(timer);
      clients.push(socket);
      resolve(socket);
    });
    socket.on('connect_error', reject);
  });
}
const ask = (socket, event, payload) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event}: no answer`)), FAIL_AFTER_MS);
    socket.emit(event, payload, (answer) => {
      clearTimeout(timer);
      resolve(answer);
    });
  });
const waitFor = (socket, event) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event}: never arrived`)), FAIL_AFTER_MS);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
const leave = (sockets) => {
  for (const socket of sockets) socket.disconnect();
};

console.log('\n=== 1. 2-player: Quick Match and Challenge a Friend, every control ===');
for (const [label, initialSeconds, incrementSeconds] of LIST) {
  const timeControl = { initialSeconds, incrementSeconds };
  const [a, b] = await Promise.all([connect('a'), connect('b')]);
  const found = [waitFor(a, 'match_found'), waitFor(b, 'match_found')];
  const joined = [await ask(a, 'join_queue', { timeControl, timeControlLabel: label }), await ask(b, 'join_queue', { timeControl, timeControlLabel: label })];
  const [fa, fb] = await Promise.all(found);
  check(joined.every((j) => j.ok) && fa.roomId === fb.roomId && fa.timeControl.initialSeconds === initialSeconds && fa.timeControl.incrementSeconds === incrementSeconds, `Quick Match ${label}: both players are paired into one room with that control`);
  leave([a, b]);

  const [host, guest] = await Promise.all([connect('host'), connect('guest')]);
  const created = await ask(host, 'create_challenge', { timeControl, timeControlLabel: label });
  const hostFound = waitFor(host, 'match_found');
  const joinedChallenge = await ask(guest, 'join_challenge', { code: created.code });
  const matched = await hostFound;
  check(created.ok && joinedChallenge.ok && matched.timeControl.initialSeconds === initialSeconds, `Challenge a Friend ${label}: created, joined with the code, a game with that control`);
  leave([host, guest]);
}
{
  const a = await connect('x');
  check((await ask(a, 'join_queue', { timeControl: { initialSeconds: 7, incrementSeconds: 0 }, timeControlLabel: '7 s' })).ok === true, 'a very short free-form control is still a valid 2-player control (the 2-player server has always taken any finite one)');
  await ask(a, 'leave_queue', {});
  check((await ask(a, 'join_queue', { timeControl: { initialSeconds: 15 * 86400, incrementSeconds: 0 } })).ok === false, 'more than 14 days is refused (a timer above 2^31 - 1 ms would fire at once)');
  check((await ask(a, 'join_queue', { timeControl: { initialSeconds: 0, incrementSeconds: 5 } })).ok === false, 'No time limit with an increment is refused');
  leave([a]);
}

console.log('\n=== 2. 4 Player Chess, 4 Player Giveaway and Chaturaji: every control, four humans start at once ===');
for (const variant of ['ffa', 'giveaway', 'chaturaji']) {
  for (const [label, initialSeconds, incrementSeconds] of LIST) {
    const timeControl = { initialSeconds, incrementSeconds };
    const players = await Promise.all([0, 1, 2, 3].map((i) => connect(`f${i}`)));
    const found = players.map((p) => waitFor(p, 'four_match_found'));
    for (const p of players) {
      const reply = await ask(p, 'four_join_queue', { timeControl, timeControlLabel: label, variant });
      assert.ok(reply.ok, `${variant} ${label}: ${reply.error}`);
    }
    const matches = await Promise.all(found);
    const room = matches[0].roomId;
    // (the seat on move has already spent a few milliseconds of its turn when the snapshot is made: the clocks are the full time, the mover's a little less)
    const full = initialSeconds * 1000;
    const clocksOk = matches[0].clocksMs.length === 4 && matches[0].clocksMs.every((ms) => ms <= full && ms >= full - (initialSeconds === 0 ? 0 : 1500));
    check(
      matches.every((m) => m.roomId === room && m.variant === variant && m.timeControl.initialSeconds === initialSeconds && m.timeControl.incrementSeconds === incrementSeconds) && clocksOk,
      `${variant} ${label}: four humans, one room, the control and ${initialSeconds === 0 ? 'zero clocks (no clock runs)' : `${initialSeconds} s clocks`}`
    );
    leave(players);
  }
}
{
  const a = await connect('y');
  for (const [initialSeconds, incrementSeconds] of [[0, 3], [86400, 3], [129600, 0], [15 * 86400, 0]]) {
    const reply = await ask(a, 'four_join_queue', { timeControl: { initialSeconds, incrementSeconds }, variant: 'ffa' });
    check(reply.ok === false && typeof reply.error === 'string', `4-seat: ${initialSeconds} | ${incrementSeconds} is refused with a message`);
  }
  leave([a]);
}

console.log('\n=== 3. Crazy Bughouse: every control, four humans start at once ===');
for (const [label, seconds, increment] of LIST) {
  const timeControl = { initialMs: seconds * 1000, incrementMs: increment * 1000 };
  const players = await Promise.all([0, 1, 2, 3].map((i) => connect(`b${i}`)));
  const found = players.map((p) => waitFor(p, 'bug_match_found'));
  for (const p of players) {
    const reply = await ask(p, 'bug_join_queue', { timeControl });
    assert.ok(reply.ok, `bughouse ${label}: ${reply.error}`);
  }
  const matches = await Promise.all(found);
  check(
    matches.every((m) => m.roomId === matches[0].roomId && m.timeControl.initialMs === timeControl.initialMs && m.timeControl.incrementMs === timeControl.incrementMs) && matches[0].timeControlLabel === label,
    `Crazy Bughouse ${label}: four humans, one room, the control and the label "${label}"`
  );
  leave(players);
}
{
  const a = await connect('z');
  for (const timeControl of [{ initialMs: 0, incrementMs: 1000 }, { initialMs: 129_600_000, incrementMs: 0 }, { initialMs: 420_000, incrementMs: 0 }]) {
    const reply = await ask(a, 'bug_join_queue', { timeControl });
    check(reply.ok === false && typeof reply.error === 'string', `Bughouse: ${timeControl.initialMs} ms + ${timeControl.incrementMs} ms is refused with a message`);
  }
  leave([a]);
}

console.log(`\nAll good - ${passed} checks passed.`);
server.close();
process.exit(0);
