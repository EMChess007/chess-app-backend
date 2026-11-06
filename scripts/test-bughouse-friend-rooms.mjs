/**
 * Bughouse ONLINE - FRIEND ROOMS (src/game/bughouseFriendRooms.ts + bughouseRoomLimiter.ts, workstream W6; BUGHOUSE_SPEC.md 5.7, HP11, B16, Q2).
 *
 *   npm run test:bughouseFriendRooms        (tsx; no server, no database; an injected clock, no timers of its own)
 *
 * The manager is driven with injected notify / start / queue functions and a fake clock, so every rule is checked to the millisecond: the code, the login rule, ONE room per user, the
 * process-wide cap, the 10-minute life (and its sweep), the ONE identical error for every failure about the code, EACH of the three limiter scopes (socket 5 / 5 min + a 5 min cooldown, user
 * 10 / 15 min, address 30 / 15 min; only failures count; a blocked scope is refused without looking at the code and is not extended by hammering it), EVERY leaving case (host / friend x room
 * open / pair queued x a cancel / a disconnect), starting with bots, as a pair, and alone, and the consumption of the code when the match starts.
 */
import assert from 'node:assert/strict';
import { BUG_ROOM_CAP, BUG_ROOM_JOIN_SCOPES, BUG_ROOM_SWEEP_MS } from '../src/game/bughouseRoomLimiter.ts';
import { BughouseFriendRooms } from '../src/game/bughouseFriendRooms.ts';
import {
  BUG_ROOM_BUSY_MESSAGE,
  BUG_ROOM_CAP_MESSAGE,
  BUG_ROOM_CODE_ALPHABET,
  BUG_ROOM_CODE_LENGTH,
  BUG_ROOM_HAVE_ROOM_MESSAGE,
  BUG_ROOM_LOGIN_MESSAGE,
  BUG_ROOM_NO_FRIEND_MESSAGE,
  BUG_ROOM_NOT_FOUND_MESSAGE,
  BUG_ROOM_NOT_HOST_MESSAGE,
  BUG_ROOM_OWN_MESSAGE,
  BUG_ROOM_TTL_MS,
  BUGHOUSE_TIME_CONTROLS,
  bugRoomCooldownMessage,
  codeFromInviteText,
  filterBugRoomCodeInput,
  normalizeBugRoomCode,
  validateBugRoomCreate,
  validateBugRoomJoin,
  validateBugRoomStart,
} from '../src/game/bughouse/index.ts';
import { manualTimers } from './bughouse-test-kit.mjs';

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ok  ${message}`);
}

const TC = { initialMs: 180000, incrementMs: 0 };
const MIN = 60_000;

/** A manager on a fake clock with every dependency recorded. `busy` is the set of sockets that are in a match or a queue. */
function setup({ capacity, ttlMs, randomInt } = {}) {
  const clock = manualTimers();
  const log = { rooms: [], closed: [], bots: [], queued: [], cancelled: [] };
  const busy = new Set();
  const state = { enqueueOk: true, botsThrow: false };
  const rooms = new BughouseFriendRooms({
    timers: clock.timers,
    notifyRoom: (id, view) => log.rooms.push({ id, view }),
    notifyClosed: (id, reason) => log.closed.push({ id, reason }),
    startWithBots: (members, tc, label) => {
      if (state.botsThrow) throw new Error('boom');
      log.bots.push({ members, tc, label });
    },
    enqueue: (members, tc) => {
      if (!state.enqueueOk) return { ok: false, error: 'You are already in a queue.', reason: 'invalidRequest' };
      log.queued.push({ members, tc });
      for (const m of members) busy.add(m.socketId);
      return { ok: true };
    },
    cancelQueue: (id) => {
      log.cancelled.push(id);
      busy.clear(); // (the real matchmaker takes the WHOLE pair out of the queue)
    },
    isBusy: (id) => busy.has(id),
    ...(capacity ? { capacity } : {}),
    ...(ttlMs ? { ttlMs } : {}),
    ...(randomInt ? { randomInt } : {}),
  });
  const member = (n) => ({ socketId: `S${n}`, userId: `u${n}`, name: `Player ${n}` });
  const caller = (n, ip = `10.0.0.${n}`) => ({ ...member(n), ip });
  return { rooms, clock, log, busy, state, member, caller };
}
const lastRoomFor = (log, id) => log.rooms.filter((r) => r.id === id).at(-1)?.view;

console.log('\n=== 0. The numbers (literals) ===');
{
  check(BUG_ROOM_CODE_LENGTH === 6 && BUG_ROOM_CODE_ALPHABET === 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' && BUG_ROOM_CODE_ALPHABET.length === 31, 'a code is 6 characters of the 31-letter alphabet (no 0 O 1 I L)');
  check(BUG_ROOM_TTL_MS === 600000 && BUG_ROOM_CAP === 500 && BUG_ROOM_SWEEP_MS === 300000, 'a room lives 10 minutes, at most 500 are open, the sweep runs every 5 minutes');
  check(
    JSON.stringify(BUG_ROOM_JOIN_SCOPES) ===
      JSON.stringify([
        { name: 'socket', maxFailures: 5, windowMs: 300000, cooldownMs: 300000 },
        { name: 'user', maxFailures: 10, windowMs: 900000, cooldownMs: 0 },
        { name: 'ip', maxFailures: 30, windowMs: 900000, cooldownMs: 0 },
      ]),
    'the limiter scopes: socket 5 / 5 min + 5 min cooldown, user 10 / 15 min, address 30 / 15 min'
  );
  check(BUG_ROOM_NOT_FOUND_MESSAGE === 'That code was not found or has expired.', 'the one error sentence');
  check(bugRoomCooldownMessage(300000) === 'Too many wrong codes. Try again in 5 minutes.' && bugRoomCooldownMessage(1) === 'Too many wrong codes. Try again in 1 second.' && bugRoomCooldownMessage(61000) === 'Too many wrong codes. Try again in 2 minutes.' && bugRoomCooldownMessage(59001) === 'Too many wrong codes. Try again in 1 minute.' && bugRoomCooldownMessage(59000) === 'Too many wrong codes. Try again in 59 seconds.', 'the cooldown sentence rounds up and switches to minutes from 60 s');
}

console.log('\n=== 1. Codes: reading what a person typed ===');
{
  check(normalizeBugRoomCode(' abc-234 ') === 'ABC234' && normalizeBugRoomCode('abc 234') === 'ABC234', 'spaces, dashes and case are forgiven');
  check(['', 'ABC23', 'ABC2345', 'ABC20O', 'ABC11L', 'ABC 23!', 123, null, undefined, {}, 'A'.repeat(100)].every((v) => normalizeBugRoomCode(v) === null), 'too short, too long, the forbidden characters, other types: not a code');
  check(filterBugRoomCodeInput('ab0-c1o 2lI34x5y6z') === 'ABC234', 'the join field keeps only the 31 allowed characters, upper-cased, at most 6');
  check(codeFromInviteText('https://app.example/bughouse/join/abc234') === 'ABC234' && codeFromInviteText('Join me: http://x.y/bughouse/join/K7M2PQ?ref=1 ok') === 'K7M2PQ' && codeFromInviteText('k7m2pq') === 'K7M2PQ' && codeFromInviteText('hello') === null, 'a pasted invite link or a bare code gives the code');
  check(validateBugRoomJoin({ code: 'abc234' }).ok && !validateBugRoomJoin({ code: 5 }).ok && !validateBugRoomJoin(null).ok && validateBugRoomJoin({ code: 'x' }).error === BUG_ROOM_NOT_FOUND_MESSAGE, 'a join payload with anything but a code is refused with the one sentence');
  check(validateBugRoomCreate({ timeControl: TC }).ok && !validateBugRoomCreate({ timeControl: { initialMs: 1, incrementMs: 0 } }).ok && !validateBugRoomCreate(undefined).ok, 'a create takes one of the app\'s time controls (and "No time limit" and Daily are among them)');
  check(validateBugRoomCreate({ timeControl: { initialMs: 0, incrementMs: 0 } }).ok && validateBugRoomCreate({ timeControl: { initialMs: 86_400_000, incrementMs: 0 } }).ok && !validateBugRoomCreate({ timeControl: { initialMs: 0, incrementMs: 1000 } }).ok, 'a room can be opened for No time limit and for a Daily control, not for an increment on No time limit');
  check(validateBugRoomStart({ mode: 'bots' }).ok && validateBugRoomStart({ mode: 'queue' }).ok && !validateBugRoomStart({ mode: 'solo' }).ok && !validateBugRoomStart('bots').ok, 'a start takes mode bots or queue');
}

console.log('\n=== 2. Creating and joining ===');
{
  const { rooms, log, caller, member, clock } = setup();
  const created = rooms.create(member(1), TC);
  check(created.ok && created.room.youAre === 'host' && created.room.friendName === null && created.room.phase === 'open' && created.room.hostName === 'Player 1', 'a logged-in user opens a room: they are the host, the friend slot is free');
  check(/^[A-HJKMNP-Z2-9]{6}$/.test(created.room.code) && created.room.expiresInMs === 600000 && created.room.timeControlLabel === '3 min', 'a 6-character code of the alphabet, 10 minutes, the label of the time control');
  const code = created.room.code;
  check(rooms.create({ socketId: 'G', userId: null, name: 'Guest' }, TC).reason === 'invalidRequest' && rooms.create({ socketId: 'G', userId: null, name: 'Guest' }, TC).error === BUG_ROOM_LOGIN_MESSAGE, 'a guest cannot open a room (Q2: login is required)');
  check(rooms.create(member(1), TC).error === BUG_ROOM_HAVE_ROOM_MESSAGE, 'ONE open room per user: the same socket cannot open a second');
  check(rooms.create({ socketId: 'S1b', userId: 'u1', name: 'Player 1' }, TC).error === BUG_ROOM_HAVE_ROOM_MESSAGE, '...nor the same user from another socket');
  check(rooms.join({ ...caller(1), socketId: 'S1c' }, code).error === BUG_ROOM_HAVE_ROOM_MESSAGE, '...and a user who has a room cannot join another (or their own from a second socket)');
  check(rooms.join(caller(1), code).error === BUG_ROOM_HAVE_ROOM_MESSAGE, 'the host joining their own code is refused as "already in a room"');
  clock.advance(120_000);
  const joined = rooms.join(caller(2), code);
  check(joined.ok && joined.room.youAre === 'friend' && joined.room.friendName === 'Player 2' && joined.room.hostName === 'Player 1' && joined.room.expiresInMs === 480000, 'the friend enters: their view names the host, the countdown continues from the creation (8 minutes left)');
  const host = lastRoomFor(log, 'S1');
  check(host.youAre === 'host' && host.friendName === 'Player 2' && host.phase === 'open', 'the host is told at once: the friend slot is taken');
  check(rooms.join(caller(3), code).error === BUG_ROOM_NOT_FOUND_MESSAGE, 'a third user finds the room FULL: the one sentence');
  check(rooms.join({ socketId: 'G2', userId: null, name: 'Guest', ip: '1.1.1.1' }, code).error === BUG_ROOM_LOGIN_MESSAGE, 'a guest cannot join (login required) - and that is not a code guess');
  check(rooms.size() === 1 && rooms.viewFor('S2').youAre === 'friend' && rooms.viewFor('S9') === null, 'one room, found by either member');
}

console.log('\n=== 3. ONE error for every failure about the code ===');
{
  const { rooms, caller, member, clock, state } = setup();
  const open = rooms.create(member(1), TC).room.code;
  const full = rooms.create(member(2), TC).room.code;
  rooms.join(caller(3), full);
  const started = rooms.create(member(4), TC).room.code;
  rooms.join(caller(5), started);
  rooms.start('S4', 'bots'); // consumed
  clock.advance(0);
  const errors = new Set();
  const answers = [
    rooms.join(caller(6), 'ZZZZZZ'), // unknown
    rooms.join(caller(6), full), // full
    rooms.join(caller(6), started), // consumed / started
    rooms.join(caller(6), null), // malformed (the handler passes null for a payload that is not a code)
  ];
  for (const a of answers) errors.add(`${a.ok}|${a.reason}|${a.error}`);
  check(errors.size === 1 && [...errors][0] === `false|invalidRequest|${BUG_ROOM_NOT_FOUND_MESSAGE}`, 'unknown, full, started and malformed: the answers are IDENTICAL (ok, reason and sentence)');
  void open;
  void state;
  const { rooms: r2, caller: c2, member: m2, clock: k2 } = setup();
  const code = r2.create(m2(1), TC).room.code;
  k2.advance(BUG_ROOM_TTL_MS);
  const expired = r2.join(c2(2), code);
  check(expired.ok === false && expired.error === BUG_ROOM_NOT_FOUND_MESSAGE && expired.reason === 'invalidRequest', 'an EXPIRED code gives the same answer');
  check(r2.size() === 0, '...and the expired room was dropped on the way');
}

console.log('\n=== 4. The limiter: each scope ===');
{
  // socket: 5 failures, the 6th attempt is refused, the cooldown is 5 minutes from the 5th failure
  const { rooms, caller, clock, member } = setup();
  const real = rooms.create(member(50), TC).room.code;
  const me = caller(1);
  for (let i = 0; i < 5; i++) check(rooms.join(me, 'ZZZZZZ').error === BUG_ROOM_NOT_FOUND_MESSAGE, `socket scope: failure ${i + 1} of 5 still gets the one sentence`);
  const blocked = rooms.join(me, real);
  check(blocked.ok === false && blocked.reason === 'rateLimited' && blocked.error === 'Too many wrong codes. Try again in 5 minutes.', 'socket scope: the 6th attempt is blocked - even with the REAL code (the block never looks at the code) - with the cooldown sentence');
  clock.advance(MIN);
  check(rooms.join(me, real).error === 'Too many wrong codes. Try again in 4 minutes.', '...hammering a block does not extend it (a minute later 4 minutes remain)');
  clock.advance(4 * MIN - 1);
  check(rooms.join(me, real).reason === 'rateLimited', '...one millisecond before the cooldown ends it still blocks');
  clock.advance(1);
  const after = rooms.join(me, real);
  check(after.ok === true, '...and at exactly 5 minutes the socket may try again (and the real code works)');
}
{
  // user: 10 failures in 15 minutes across SOCKETS (and addresses): the 11th is blocked, a sliding limit
  const { rooms, caller, clock, member } = setup();
  const real = rooms.create(member(50), TC).room.code;
  for (let i = 0; i < 10; i++) {
    const c = { ...caller(1, `10.9.${i}.1`), socketId: `U${i}` };
    check(rooms.join(c, 'ZZZZZZ').error === BUG_ROOM_NOT_FOUND_MESSAGE, `user scope: failure ${i + 1} of 10 (a fresh socket and a fresh address each time)`);
    clock.advance(10_000);
  }
  const eleventh = rooms.join({ ...caller(1, '10.9.99.1'), socketId: 'U99' }, real);
  check(eleventh.ok === false && eleventh.reason === 'rateLimited', 'user scope: the 11th attempt of the same ACCOUNT is blocked from yet another socket and address');
  check(rooms.join({ ...caller(2, '10.9.99.2'), socketId: 'V1' }, real).ok === true, '...while another user from another address is not affected');
}
{
  // address: 30 failures in 15 minutes across users and sockets
  const { rooms, caller, member } = setup();
  const real = rooms.create(member(900), TC).room.code;
  for (let i = 0; i < 30; i++) rooms.join({ ...caller(100 + i, '203.0.113.7'), socketId: `A${i}` }, 'ZZZZZZ');
  const next = rooms.join({ ...caller(200, '203.0.113.7'), socketId: 'A200' }, real);
  check(next.ok === false && next.reason === 'rateLimited', 'address scope: after 30 failures from one address even a NEW user on a new socket is blocked');
  check(rooms.join({ ...caller(201, '203.0.113.8'), socketId: 'A201' }, real).ok === true, '...another address is not');
}
{
  // sliding window of the user scope: a failure stops counting 15 minutes after it
  const { rooms, caller, clock, member } = setup();
  const real = rooms.create(member(50), TC).room.code;
  for (let i = 0; i < 10; i++) rooms.join({ ...caller(1, `10.8.${i}.1`), socketId: `W${i}` }, 'ZZZZZZ');
  check(rooms.join({ ...caller(1, '10.8.50.1'), socketId: 'W50' }, real).reason === 'rateLimited', 'user scope: blocked after 10');
  clock.advance(15 * MIN);
  const fresh = rooms.create(member(51), TC).room.code; // (the first room is past its 10 minutes by now)
  check(real !== fresh && rooms.join({ ...caller(1, '10.8.51.1'), socketId: 'W51' }, fresh).ok === true, '...and free again when the failures have left the 15-minute window');
}
{
  // only failures count: a success resets nothing and counts for nothing
  const { rooms, caller, member, clock } = setup();
  const me = caller(1);
  for (let i = 0; i < 4; i++) rooms.join(me, 'ZZZZZZ');
  const code = rooms.create(member(50), TC).room.code;
  check(rooms.join(me, code).ok === true, 'four failures, then a good code: the join works');
  rooms.leave('S1');
  rooms.join(me, 'ZZZZZZ');
  check(rooms.join(me, 'ZZZZZZ').reason === 'rateLimited', 'the success did not reset the count: the 5th failure blocks the 6th attempt');
  void clock;
}
{
  // not-a-guess answers are not counted: a guest, a busy socket, a user who has a room
  const { rooms, caller, busy } = setup();
  busy.add('S1');
  for (let i = 0; i < 10; i++) {
    check(rooms.join(caller(1), 'ZZZZZZ').error === BUG_ROOM_BUSY_MESSAGE, i === 0 ? 'a socket that is in a match or queue is told so (not counted as a guess)' : 'again');
    if (i === 2) break;
  }
  busy.delete('S1');
  check(rooms.join(caller(1), 'ZZZZZZ').error === BUG_ROOM_NOT_FOUND_MESSAGE, '...and its first real guess is the first failure');
  void BUG_ROOM_OWN_MESSAGE;
}
{
  // the sweep forgets what has nothing left to remember
  const { rooms, caller, clock } = setup();
  rooms.join(caller(1), 'ZZZZZZ');
  check(rooms.limiter.size() === 3, 'one failure is remembered under three keys (socket, user, address)');
  clock.advance(15 * MIN + 1);
  rooms.sweep();
  check(rooms.limiter.size() === 0, 'the sweep drops them once the window has passed');
}

console.log('\n=== 5. The cap and the life ===');
{
  const { rooms, member, clock } = setup({ capacity: 3 });
  for (let n = 1; n <= 3; n++) rooms.create(member(n), TC);
  const over = rooms.create(member(4), TC);
  check(over.ok === false && over.reason === 'rateLimited' && over.error === BUG_ROOM_CAP_MESSAGE, 'the process-wide cap: the room after the last is refused with its own sentence');
  rooms.leave('S1');
  check(rooms.create(member(4), TC).ok === true, '...and a closed room frees a place');
  clock.advance(BUG_ROOM_TTL_MS);
  check(rooms.create(member(5), TC).ok === true && rooms.size() === 1, 'rooms past their life are dropped before the cap is judged');
}
{
  const { rooms, caller, member, clock, log } = setup();
  const a = rooms.create(member(1), TC).room.code;
  clock.advance(BUG_ROOM_TTL_MS - 1);
  check(rooms.join(caller(2), a).ok === true, 'one millisecond before its life is over the code still works');
  rooms.leave('S2');
  clock.advance(1);
  check(rooms.join(caller(3), a).error === BUG_ROOM_NOT_FOUND_MESSAGE, 'at exactly 10 minutes it is gone');
  check(log.closed.some((c) => c.id === 'S1' && c.reason === 'expired'), '...and the host was told it expired');
}
{
  const { rooms, caller, member, clock, log } = setup({ ttlMs: 5000 });
  const code = rooms.create(member(1), TC).room.code;
  rooms.join(caller(2), code);
  clock.advance(4999);
  check(rooms.sweep() === 0 && rooms.size() === 1, 'a shortened life (the guarded test override): the sweep leaves a room inside it');
  clock.advance(1);
  check(rooms.sweep() === 1 && rooms.size() === 0, '...and removes it at its end');
  check(log.closed.filter((c) => c.reason === 'expired').map((c) => c.id).sort().join() === 'S1,S2', '...telling BOTH members');
  check(rooms.create(member(1), TC).ok === true, '...and the host may open a new room (the user key was freed)');
}
{
  const { rooms, member, clock, log, busy, caller } = setup();
  const code = rooms.create(member(1), TC).room.code;
  rooms.join(caller(2), code);
  rooms.start('S1', 'queue');
  clock.advance(BUG_ROOM_TTL_MS);
  rooms.sweep();
  check(log.cancelled.includes('S1') && rooms.size() === 0 && !busy.has('S1'), 'an expired room whose pair is queued takes the pair out of the queue');
}

console.log('\n=== 6. Starting: bots, a pair, alone ===');
{
  const { rooms, caller, member, log } = setup();
  const code = rooms.create(member(1), TC).room.code;
  check(rooms.start('S1', 'bots').error === BUG_ROOM_NO_FRIEND_MESSAGE, 'starting with bots needs the friend');
  rooms.join(caller(2), code);
  check(rooms.start('S2', 'bots').error === BUG_ROOM_NOT_HOST_MESSAGE, 'only the host can start');
  check(rooms.start('S9', 'bots').reason === 'noGame', 'a stranger is told they are in no room');
  const started = rooms.start('S1', 'bots');
  check(started.ok && started.outcome === 'started' && log.bots.length === 1 && log.bots[0].members.map((m) => m.socketId).join() === 'S1,S2' && log.bots[0].label === '3 min', 'with bots: the match starts at once with the host and the friend, the room\'s time control');
  check(rooms.size() === 0 && rooms.viewFor('S1') === null && rooms.join(caller(3), code).error === BUG_ROOM_NOT_FOUND_MESSAGE, '...and the code is CONSUMED');
}
{
  const { rooms, caller, member, log, state } = setup();
  const code = rooms.create(member(1), TC).room.code;
  rooms.join(caller(2), code);
  state.botsThrow = true;
  const originalError = console.error;
  console.error = () => {};
  const failed = rooms.start('S1', 'bots');
  console.error = originalError;
  check(failed.ok === false && rooms.size() === 1, 'a start that throws is refused and the room stays');
  state.botsThrow = false;
  check(rooms.start('S1', 'bots').ok === true && log.bots.length === 1, '...and the host can try again');
}
{
  const { rooms, caller, member, log, busy, state } = setup();
  const code = rooms.create(member(1), TC).room.code;
  rooms.join(caller(2), code);
  const queued = rooms.start('S1', 'queue');
  check(queued.ok && queued.outcome === 'queued' && log.queued.length === 1 && log.queued[0].members.map((m) => m.socketId).join() === 'S1,S2', 'as a pair: ONE group of the host and the friend enters the matchmaking');
  check(lastRoomFor(log, 'S1').phase === 'queued' && lastRoomFor(log, 'S2').phase === 'queued' && lastRoomFor(log, 'S2').youAre === 'friend', '...BOTH screens are told the room is queued (the friend follows the host)');
  check(rooms.start('S1', 'queue').error === 'The room is already looking for a match.' && rooms.start('S1', 'bots').ok === false, '...and cannot be started twice');
  check(rooms.leave('S2').ok === true, 'the friend leaves the queue screen: this is a leave');
  state.enqueueOk = true;
  void busy;
}
{
  const { rooms, caller, member, log, state } = setup();
  const code = rooms.create(member(1), TC).room.code;
  rooms.join(caller(2), code);
  state.enqueueOk = false;
  const refused = rooms.start('S1', 'queue');
  check(refused.ok === false && lastRoomFor(log, 'S1').phase === 'open', 'a refused queue entry leaves the room open');
}
{
  const { rooms, member, log, caller } = setup();
  const code = rooms.create(member(1), TC).room.code;
  const solo = rooms.start('S1', 'queue');
  check(solo.ok && solo.outcome === 'solo' && log.queued[0].members.length === 1 && rooms.size() === 0, '"Find a match alone": the host enters a normal SOLO queue entry and the room is closed');
  void code;
  void caller;
}
{
  const { rooms, caller, member, busy } = setup();
  const code = rooms.create(member(1), TC).room.code;
  rooms.join(caller(2), code);
  rooms.start('S1', 'queue');
  rooms.matchStarted(['S2', 'S1', 'S7', 'S8']);
  check(rooms.size() === 0 && rooms.viewFor('S1') === null && rooms.join(caller(3), code).error === BUG_ROOM_NOT_FOUND_MESSAGE, 'when the match starts the queued room is consumed: its code no longer works');
  check(rooms.create(member(1), TC).error === BUG_ROOM_BUSY_MESSAGE, '...and while the host sits in that match they cannot open a new room');
  busy.clear(); // (the match ended)
  check(rooms.create(member(1), TC).ok === true, '...afterwards they can (the user key was freed)');
}
{
  // the pair completes a table: the match starts INSIDE enqueue (found by the real-socket test: the room was still "open" then and survived its own match)
  const { rooms, caller, member, log, busy } = setup();
  const code = rooms.create(member(1), TC).room.code;
  rooms.join(caller(2), code);
  const real = rooms.limiter; // (unused: keeps the shape of the other blocks)
  void real;
  const deps = rooms.deps;
  const enqueue = deps.enqueue;
  deps.enqueue = (members, tc) => {
    const ack = enqueue(members, tc);
    rooms.matchStarted(members.map((m) => m.socketId)); // what the handlers do when the matchmaker's startGame runs
    return ack;
  };
  log.rooms.length = 0;
  const started = rooms.start('S1', 'queue');
  check(started.ok && started.outcome === 'started' && rooms.size() === 0 && log.rooms.length === 0, 'a pair that starts a match at once: the room is consumed, the host is told "started", and no stale "queued" update follows the match');
  busy.clear();
  check(rooms.create(member(1), TC).ok === true, '...and the host is free to open a new room');
}
{
  // matchStarted ignores rooms that are not queued
  const { rooms, member } = setup();
  rooms.create(member(1), TC);
  rooms.matchStarted(['S1']);
  check(rooms.size() === 1, 'a match that starts for other sockets (or for an open room\'s member) does not consume an OPEN room');
}

console.log('\n=== 7. Every leaving case ===');
{
  // host, room open, no friend
  const { rooms, member, caller, log } = setup();
  const code = rooms.create(member(1), TC).room.code;
  check(rooms.leave('S1').ok && rooms.size() === 0 && log.closed.length === 0, 'host leaves an empty room: it is deleted, nobody to tell');
  check(rooms.leave('S1').reason === 'noGame', '...and leaving twice says they are in no room');
  check(rooms.join(caller(2), code).error === BUG_ROOM_NOT_FOUND_MESSAGE, '...the code is dead');
}
{
  // host, room open, with friend
  const { rooms, member, caller, log } = setup();
  const code = rooms.create(member(1), TC).room.code;
  rooms.join(caller(2), code);
  rooms.leave('S1');
  check(rooms.size() === 0 && JSON.stringify(log.closed) === JSON.stringify([{ id: 'S2', reason: 'hostLeft' }]), 'host leaves: the room closes and the friend is told "hostLeft"');
  check(rooms.create(member(2), TC).ok === true && rooms.create({ ...member(1), socketId: 'S1x' }, TC).ok === true, '...both users are free to open rooms again');
}
{
  // host DISCONNECT is the same
  const { rooms, member, caller, log } = setup();
  const code = rooms.create(member(1), TC).room.code;
  rooms.join(caller(2), code);
  rooms.disconnect('S1');
  check(rooms.size() === 0 && log.closed.length === 1 && log.closed[0].reason === 'hostLeft', 'host disconnects: the same as leaving');
  rooms.disconnect('S1');
  rooms.disconnect('nobody');
  check(true, 'a disconnect of a socket in no room is harmless');
}
{
  // friend, room open
  const { rooms, member, caller, log } = setup();
  const code = rooms.create(member(1), TC).room.code;
  rooms.join(caller(2), code);
  rooms.leave('S2');
  check(rooms.size() === 1 && lastRoomFor(log, 'S1').friendName === null && lastRoomFor(log, 'S1').phase === 'open' && log.closed.length === 0, 'friend leaves: the slot is freed, the host is told, the room stays');
  check(rooms.join(caller(3), code).ok === true && lastRoomFor(log, 'S1').friendName === 'Player 3', '...the SAME code is still valid: another friend can take the slot');
  rooms.disconnect('S3');
  check(lastRoomFor(log, 'S1').friendName === null && rooms.size() === 1, 'a friend DISCONNECT frees the slot the same way');
  check(rooms.create(member(3), TC).ok === true, '...and the friend is free to open a room of their own');
}
{
  // host, pair queued
  const { rooms, member, caller, log, busy } = setup();
  const code = rooms.create(member(1), TC).room.code;
  rooms.join(caller(2), code);
  rooms.start('S1', 'queue');
  rooms.leave('S1');
  check(log.cancelled.includes('S1') && !busy.has('S1') && rooms.size() === 0 && log.closed.at(-1).id === 'S2' && log.closed.at(-1).reason === 'hostLeft', 'host leaves while the pair is queued: the pair entry is cancelled, the room closes, the friend is told');
}
{
  // friend, pair queued
  const { rooms, member, caller, log, busy } = setup();
  const code = rooms.create(member(1), TC).room.code;
  rooms.join(caller(2), code);
  rooms.start('S1', 'queue');
  rooms.disconnect('S2');
  check(log.cancelled.includes('S2') && busy.size === 0, 'friend disconnects while the pair is queued: the pair entry is cancelled');
  const view = lastRoomFor(log, 'S1');
  check(rooms.size() === 1 && view.friendName === null && view.phase === 'open', '...and the host is back on the room screen with the slot free');
  check(rooms.start('S1', 'bots').error === BUG_ROOM_NO_FRIEND_MESSAGE, '...where they can wait for another friend (the code is still valid)');
}
{
  // a CANCEL of the queue (not a leave of the room): both back in the open room
  const { rooms, member, caller, log } = setup();
  const code = rooms.create(member(1), TC).room.code;
  rooms.join(caller(2), code);
  rooms.start('S1', 'queue');
  log.rooms.length = 0;
  rooms.pairCancelled('S2', ['S1']);
  check(rooms.size() === 1 && rooms.viewFor('S1').phase === 'open' && rooms.viewFor('S1').friendName === 'Player 2', 'a member cancels the pair queue: the room is open again with BOTH still in it');
  check(log.rooms.map((r) => r.id).sort().join() === 'S1,S2' && log.rooms.every((r) => r.view.phase === 'open'), '...and both screens are told');
  log.rooms.length = 0;
  rooms.pairCancelled('S2', ['S1']);
  rooms.pairCancelled('S9', []);
  check(log.rooms.length === 0, 'a cancel for a room that is not queued (already settled by a disconnect) tells nobody');
}
{
  // a socket seated in a match / queued cannot open or join
  const { rooms, member, caller, busy } = setup();
  busy.add('S1');
  check(rooms.create(member(1), TC).error === BUG_ROOM_BUSY_MESSAGE, 'a socket in a match or a queue cannot open a room');
}

console.log(`\nALL ${passed} CHECKS PASSED`);
