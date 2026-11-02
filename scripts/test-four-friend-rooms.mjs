#!/usr/bin/env node
/**
 * FRIEND ROOMS FOR THE 4-SEAT GAMES (command #35, PART C): the generalised manager (friendRooms.ts) with FOUR members, and the real `four_room_*` events over real sockets.
 *
 *   1. THE MANAGER, no network, a fake clock (the kit's `manualTimers`): up to four members, the fifth is refused with the ONE sentence, every leaving case (host closes: every friend told;
 *      a friend leaves: everyone left told, the code stays valid), 'queue' is refused (no pair queue here), the start needs a friend and consumes the room, the life of 10 minutes, one room
 *      per user, the cap, the limiter (5 failures per socket in 5 minutes, then the cooldown message), a guest cannot open a room, nobody sees a socket id or a user id.
 *   2. REAL SOCKETS (its own server on a free port: the 4-seat handlers on socket.io): 4 Player Chess with two friends + two bots, 4 Player Giveaway with three friends + one bot, Chaturaji with two
 *      friends + two bots (the game is the 8 x 8 one: the match payload says `chaturaji` and the bots took exactly the empty seats); every control of the app's list can open a room; a join with a
 *      wrong code is the one sentence; a room's code is dead after the game started; every friend gets four_match_found with their OWN seat and token and no token travels to anybody else.
 * Nothing here waits on the wall clock: every wait ends on an event and its bound only turns a hang into a failure.   npm run test:fourFriendRooms
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { io as connectClient } from 'socket.io-client';
import { FriendRooms } from '../src/game/friendRooms.ts';
import { registerFourPlayerHandlers } from '../src/game/fourPlayerHandlers.ts';
import * as W from '../src/game/fourPlayerRoomWire.ts';
import { FOUR_ROOM_NOT_FOUND_MESSAGE, fourControlLabel, validateFourRoomCreate, validateFourRoomJoin } from '../src/game/fourPlayerRoomWire.ts';
import { manualTimers } from './bughouse-test-kit.mjs';

const FOUR_MESSAGES = {
  login: W.FOUR_ROOM_LOGIN_MESSAGE,
  haveRoom: W.FOUR_ROOM_HAVE_ROOM_MESSAGE,
  busy: W.FOUR_ROOM_BUSY_MESSAGE,
  cap: W.FOUR_ROOM_CAP_MESSAGE,
  own: W.FOUR_ROOM_OWN_MESSAGE,
  noFriend: W.FOUR_ROOM_NO_FRIEND_MESSAGE,
  notHost: W.FOUR_ROOM_NOT_HOST_MESSAGE,
  notInRoom: W.FOUR_ROOM_NOT_IN_ROOM_MESSAGE,
  notFound: W.FOUR_ROOM_NOT_FOUND_MESSAGE,
};

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ok  ${message}`);
}

console.log('\n=== 1. The manager with four members ===');
{
  const clock = manualTimers(1000);
  const told = [];
  const closed = [];
  const started = [];
  const rooms = new FriendRooms({
    maxMembers: 4,
    messages: FOUR_MESSAGES,
    timers: clock.timers,
    randomInt: (n) => 0, // a fixed code (AAAAAA...) so a test can guess it; a second room needs another source, see below
    labelOf: fourControlLabel,
    makeView: (room, youAre, expiresInMs) => ({ code: room.code, variant: room.extra, members: [room.host.name, ...room.friends.map((f) => f.name)], youAre, expiresInMs }),
    notifyRoom: (socketId, view) => told.push({ socketId, view }),
    notifyClosed: (socketId, reason) => closed.push({ socketId, reason }),
    startWithBots: (members, timeControl, label, variant) => started.push({ members, timeControl, label, variant }),
    isBusy: () => false,
  });
  const member = (n) => ({ socketId: `S${n}`, userId: `U${n}`, name: `P${n}` });
  const caller = (n) => ({ ...member(n), ip: '10.0.0.1' });
  const TC = { initialSeconds: 300, incrementSeconds: 2 };

  const created = rooms.create(member(1), TC, 'chaturaji');
  check(created.ok && created.room.code === 'AAAAAA' && created.room.members.join() === 'P1' && created.room.youAre === 'host', 'the host opens a room: a code, one member');
  check(rooms.join(caller(2), 'AAAAAA').ok && rooms.join(caller(3), 'AAAAAA').ok && rooms.join(caller(4), 'AAAAAA').ok, 'three friends join the same code (four members)');
  const fifth = rooms.join(caller(5), 'AAAAAA');
  check(fifth.ok === false && fifth.error === 'That code was not found or has expired.', 'a fifth is refused with the ONE sentence (a full room is not told apart from a wrong code)');
  check(told.filter((t) => t.socketId === 'S1').at(-1).view.members.join() === 'P1,P2,P3,P4', 'the host was told each time: the last view lists all four');
  check(told.filter((t) => t.socketId === 'S2').at(-1).view.members.join() === 'P1,P2,P3,P4' && told.filter((t) => t.socketId === 'S2').at(-1).view.youAre === 'friend', 'a friend already inside is told when the next one joins');
  check(JSON.stringify(told).indexOf('userId') < 0 && JSON.stringify(told).indexOf('"S1"') === JSON.stringify(told).indexOf('"socketId":"S1"') + 11, 'a view carries names and numbers only (the socket id appears only as the recipient, never inside a view)');
  check(rooms.viewFor('S3').members.length === 4 && rooms.viewFor('S9') === null, 'viewFor answers for a member and null for a stranger');

  check(rooms.leave('S3').ok && rooms.viewFor('S3') === null && rooms.viewFor('S1').members.join() === 'P1,P2,P4', 'a friend leaves: the slot is freed, the others are told');
  check(rooms.join(caller(6), 'AAAAAA').ok, '...and the code is still valid: the next friend takes the slot');
  check(rooms.start('S2', 'bots').ok === false && rooms.start('S2', 'bots').error === 'Only the host can start the game.', 'a friend cannot start the game');
  check(rooms.start('S1', 'queue').ok === false, "'queue' is refused: the 4-seat rooms have no pair queue");
  const go = rooms.start('S1', 'bots');
  check(go.ok && started.length === 1 && started[0].members.map((m) => m.socketId).join() === 'S1,S2,S4,S6' && started[0].variant === 'chaturaji' && started[0].label === '5 | 2', 'the host starts: the four friends (host first) with the variant and the label, bots fill the rest (the game code does that)');
  check(rooms.size() === 0 && rooms.viewFor('S1') === null && rooms.join(caller(7), 'AAAAAA').ok === false, 'the room is consumed by the start: its code is dead');
}
{
  const clock = manualTimers(1000);
  const closed = [];
  let n = 0;
  const rooms = new FriendRooms({
    maxMembers: 4,
    timers: clock.timers,
    randomInt: () => n++ % 31,
    labelOf: fourControlLabel,
    makeView: (room) => ({ code: room.code }),
    notifyRoom: () => {},
    notifyClosed: (socketId, reason) => closed.push(`${socketId}:${reason}`),
    startWithBots: () => {},
    isBusy: (socketId) => socketId === 'BUSY',
    capacity: 3,
    messages: FOUR_MESSAGES,
  });
  const member = (id, user = id) => ({ socketId: id, userId: user, name: id });
  const TC = { initialSeconds: 0, incrementSeconds: 0 };
  check(rooms.create({ socketId: 'G', userId: null, name: 'G' }, TC, 'ffa').ok === false, 'a guest cannot open a room (login is required)');
  check(rooms.create(member('BUSY'), TC, 'ffa').ok === false, 'a socket in a game or a queue cannot open one');
  const a = rooms.create(member('A'), TC, 'giveaway');
  check(a.ok && rooms.create(member('A2', 'A'), TC, 'giveaway').ok === false, 'one room per user (a second socket of the same user is refused)');
  const code = a.room.code;
  check(rooms.join({ ...member('B'), ip: '1.1.1.1' }, code).ok && rooms.join({ ...member('B2', 'B'), ip: '1.1.1.1' }, code).ok === false, 'a user already in a room cannot join another');
  check(rooms.join({ ...member('A3', 'A'), ip: '1.1.1.1' }, code).ok === false, 'the host cannot join their own room from another socket');
  rooms.leave('A');
  check(closed.join() === 'B:hostLeft', 'the host leaves: every friend is told "hostLeft"');
  check(rooms.size() === 0, '...and the room is gone');
  // the life: 10 minutes
  const b = rooms.create(member('C'), TC, 'ffa');
  rooms.join({ ...member('D'), ip: '1.1.1.2' }, b.room.code);
  clock.advance(10 * 60 * 1000 - 1);
  check(rooms.sweep() === 0 && rooms.size() === 1, 'a room lives 10 minutes: one millisecond short it is still there');
  clock.advance(1);
  check(rooms.sweep() === 1 && rooms.size() === 0 && closed.slice(-2).join() === 'C:expired,D:expired', '...and at 10 minutes the sweep deletes it and tells every member "expired"');
  // the cap
  rooms.create(member('E1'), TC, 'ffa');
  rooms.create(member('E2'), TC, 'ffa');
  rooms.create(member('E3'), TC, 'ffa');
  const over = rooms.create(member('E4'), TC, 'ffa');
  check(over.ok === false && over.reason === 'rateLimited', 'the cap of open rooms refuses the next one');
  // the limiter: five wrong codes from one socket, then the cooldown message
  for (let i = 0; i < 5; i++) assert.equal(rooms.join({ ...member('Z'), ip: '2.2.2.2' }, 'ZZZZZZ').ok, false);
  const blocked = rooms.join({ ...member('Z'), ip: '2.2.2.2' }, 'ZZZZZZ');
  check(blocked.ok === false && /Too many wrong codes\. Try again in 5 minutes\./.test(blocked.error), 'five failed guesses from one socket: the sixth gets the cooldown message (the Bughouse rooms\' limiter, one class)');
}

{
  // MUTATION SURVIVORS PINNED (friend-rooms-generic.config.cjs). (1) A room that is QUEUED refuses a join even with a free slot: with Bughouse's two members a queued room is always full, so the phase test is
  // only observable in a family with a pair queue and room to spare - here three members and a queue.
  const clock = manualTimers(1000);
  const rooms = new FriendRooms({
    maxMembers: 3,
    messages: FOUR_MESSAGES,
    timers: clock.timers,
    randomInt: (() => { let n = 0; return () => n++ % 31; })(), // (a fixed 0 would give every room the same code: `newCode` would never find a free one)
    labelOf: fourControlLabel,
    makeView: (room) => ({ code: room.code, phase: room.phase }),
    notifyRoom: () => {},
    notifyClosed: () => {},
    startWithBots: () => {},
    enqueue: () => ({ ok: true }),
    cancelQueue: () => {},
    isBusy: () => false,
  });
  const member = (n) => ({ socketId: `Q${n}`, userId: `V${n}`, name: `Q${n}` });
  const created = rooms.create(member(1), { initialSeconds: 300, incrementSeconds: 0 }, 'ffa');
  rooms.join({ ...member(2), ip: '3.3.3.3' }, created.room.code);
  check(rooms.start('Q1', 'queue').outcome === 'queued' && rooms.viewFor('Q1').phase === 'queued', 'a room with a pair queue: the host starts the queue, the room is queued');
  const late = rooms.join({ ...member(3), ip: '3.3.3.3' }, created.room.code);
  check(late.ok === false && late.error === W.FOUR_ROOM_NOT_FOUND_MESSAGE, 'a QUEUED room refuses a third member although it has a free slot (the phase, not only the size, closes a room)');
  // (2) EQUIVALENT: the "own room" guard is a second line of defence. A member's own socket and user are already mapped to the room, so the earlier "you already have an open room" answer is what a host
  // joining their own code really gets; no input reaches the `own` sentence. Pinned: both the same-socket and the same-user case answer the earlier sentence.
  const mine = rooms.create(member(9), { initialSeconds: 300, incrementSeconds: 0 }, 'ffa');
  check(rooms.join({ ...member(9), ip: '3.3.3.4' }, mine.room.code).error === W.FOUR_ROOM_HAVE_ROOM_MESSAGE, 'a host joining their own code from the same socket gets "you already have an open room"');
  check(rooms.join({ socketId: 'Q99', userId: 'V9', name: 'x', ip: '3.3.3.4' }, mine.room.code).error === W.FOUR_ROOM_HAVE_ROOM_MESSAGE, '...and from another socket of the same user too: the "own room" guard behind it is unreachable (an equivalent mutant)');
}

{
  // MUTATION SURVIVORS PINNED: a room holds 2 to 4 members, whole numbers only (a room of one is no friend room, five seats do not exist)
  const deps = (maxMembers) => ({ maxMembers, labelOf: fourControlLabel, makeView: () => ({}), notifyRoom: () => {}, notifyClosed: () => {}, startWithBots: () => {}, isBusy: () => false });
  for (const bad of [1, 0, 5, 2.5, NaN, '4', undefined]) assert.throws(() => new FriendRooms(deps(bad)), RangeError, `maxMembers ${String(bad)}`);
  for (const good of [2, 3, 4]) assert.doesNotThrow(() => new FriendRooms(deps(good)), `maxMembers ${good}`);
  check(true, 'a manager is built for 2, 3 or 4 members and refused for 0, 1, 5, 2.5, NaN and text');
}

console.log('\n=== 1b. The wire ===');
{
  check(validateFourRoomCreate({ variant: 'chaturaji', timeControl: { initialSeconds: 86400, incrementSeconds: 0 } }).ok && validateFourRoomCreate({ variant: 'ffa', timeControl: { initialSeconds: 0, incrementSeconds: 0 } }).ok, 'a create takes a variant and any control of the list (Daily and No time limit too)');
  check(!validateFourRoomCreate({ timeControl: { initialSeconds: 300, incrementSeconds: 0 } }).ok && !validateFourRoomCreate({ variant: 'bughouse', timeControl: { initialSeconds: 300, incrementSeconds: 0 } }).ok && !validateFourRoomCreate({ variant: 'ffa', timeControl: { initialSeconds: 7, incrementSeconds: 0 } }).ok && !validateFourRoomCreate(null).ok, 'no variant, an unknown one, a free-form control and no payload are refused');
  check(validateFourRoomJoin({ code: 'abc-234' }).value.code === 'ABC234' && validateFourRoomJoin({ code: 5 }).error === FOUR_ROOM_NOT_FOUND_MESSAGE && validateFourRoomJoin({ code: 'ABC' }).error === FOUR_ROOM_NOT_FOUND_MESSAGE, 'a join normalises the code; anything else is the one sentence');
  check(fourControlLabel({ initialSeconds: 0, incrementSeconds: 0 }) === 'No time limit' && fourControlLabel({ initialSeconds: 60, incrementSeconds: 0 }) === '1 min' && fourControlLabel({ initialSeconds: 900, incrementSeconds: 10 }) === '15 | 10' && fourControlLabel({ initialSeconds: 86400, incrementSeconds: 0 }) === '1 day' && fourControlLabel({ initialSeconds: 14 * 86400, incrementSeconds: 0 }) === '14 days', 'the labels');
}

console.log('\n=== 2. Over real sockets ===');
const httpServer = createServer();
const server = new SocketIOServer(httpServer, { cors: { origin: '*' } });
registerFourPlayerHandlers(server, {
  // a logged-in user is whoever the handshake says (no JWT here: the test supplies identities, the handler's shape is the same)
  userIdOf: (socket) => (typeof socket.handshake.auth.user === 'string' ? socket.handshake.auth.user : null),
  resolveName: async (userId) => userId,
  // a fixed random source: Fisher-Yates with "always index 0" turns [host, friend, bot, bot] into [friend, bot, bot, host] - so the host sits in seat 3 and the friend in seat 0, and a room that
  // forgot to shuffle (host first) is seen (mutation: friend-rooms-generic "the seats are not shuffled")
  matchmakerOptions: { randomInt: () => 0 },
});
await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
const URL = `http://127.0.0.1:${httpServer.address().port}`;
const FAIL_AFTER_MS = 15_000;
const sockets = [];
let counter = 0;

function connect(user) {
  return new Promise((resolve, reject) => {
    const socket = connectClient(URL, { transports: ['websocket'], reconnection: false, auth: user === null ? {} : { user: `${user}${counter++}` } });
    const inbox = [];
    socket.onAny((event, payload) => inbox.push({ event, payload }));
    socket.inbox = inbox;
    const timer = setTimeout(() => reject(new Error('connect timed out')), FAIL_AFTER_MS);
    socket.on('connect', () => {
      clearTimeout(timer);
      sockets.push(socket);
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
    const already = socket.inbox.find((e) => e.event === event);
    if (already) return resolve(already.payload);
    const timer = setTimeout(() => reject(new Error(`${event}: never arrived`)), FAIL_AFTER_MS);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
const TC = { initialSeconds: 300, incrementSeconds: 0 };

async function play(variant, friendCount, timeControl = TC) {
  const host = await connect('host');
  const friends = [];
  for (let i = 0; i < friendCount; i++) friends.push(await connect('friend'));
  const created = await ask(host, 'four_room_create', { variant, timeControl });
  assert.ok(created.ok, created.error);
  for (const friend of friends) {
    const joined = await ask(friend, 'four_room_join', { code: created.room.code });
    assert.ok(joined.ok, joined.error);
    assert.equal(joined.room.variant, variant);
  }
  const everyone = [host, ...friends];
  const found = everyone.map((s) => waitFor(s, 'four_match_found'));
  const started = await ask(host, 'four_room_start', {});
  const matches = await Promise.all(found);
  return { created, started, matches, everyone };
}

for (const [variant, friends, bots] of [['ffa', 1, 2], ['giveaway', 2, 1], ['chaturaji', 1, 2], ['chaturaji', 3, 0]]) {
  const { created, started, matches, everyone } = await play(variant, friends, TC);
  const humans = 1 + friends;
  check(created.room.variant === variant && created.room.members.length === 1 && created.room.maxMembers === 4 && created.room.timeControlLabel === '5 min', `${variant}: the host opens a room (code, variant, label, room for four)`);
  check(started.ok && started.outcome === 'started', `${variant}: the host starts`);
  const first = matches[0];
  check(matches.every((m) => m.roomId === first.roomId && m.variant === variant) && new Set(matches.map((m) => m.seat)).size === humans, `${variant}: ${humans} humans, one room, each with their OWN seat`);
  if (variant === 'ffa') check(matches[0].seat === 3 && matches[1].seat === 0, 'ffa: the seats are SHUFFLED (with the fixed source the host sits in seat 3 and the friend in seat 0)');
  check(first.seats.filter((s) => s.kind === 'human').length === humans && first.seats.filter((s) => s.kind === 'bot' && s.botReason === 'fill').length === bots, `${variant}: ${bots} bot${bots === 1 ? '' : 's'} fill the empty seat${bots === 1 ? '' : 's'}`);
  check(matches.every((m, i) => typeof m.playerToken === 'string' && matches.filter((o) => o.playerToken === m.playerToken).length === 1), `${variant}: every friend has their own token`);
  const leaked = everyone.some((s, i) => s.inbox.some((e) => e.event !== 'four_match_found' && JSON.stringify(e.payload ?? '').includes(matches[(i + 1) % humans].playerToken)));
  check(!leaked || humans === 1, `${variant}: nobody else's token reached a socket outside its own four_match_found`);
  const dead = await connect('late');
  const late = await ask(dead, 'four_room_join', { code: created.room.code });
  check(late.ok === false && late.error === FOUR_ROOM_NOT_FOUND_MESSAGE, `${variant}: the room's code is dead after the start (the one sentence)`);
  for (const s of [...everyone, dead]) s.disconnect();
}
{
  const host = await connect('host');
  const friend = await connect('friend');
  const stranger = await connect(null);
  const created = await ask(host, 'four_room_create', { variant: 'ffa', timeControl: { initialSeconds: 0, incrementSeconds: 0 } });
  check(created.ok && created.room.timeControlLabel === 'No time limit', 'a room can be opened for No time limit');
  const wrong = await ask(friend, 'four_room_join', { code: 'QQQQQQ' });
  check(wrong.ok === false && wrong.error === FOUR_ROOM_NOT_FOUND_MESSAGE, 'a wrong code: the one sentence');
  check((await ask(stranger, 'four_room_create', { variant: 'ffa', timeControl: TC })).ok === false, 'a guest cannot open a room');
  check((await ask(host, 'four_room_start', {})).ok === false, 'the host cannot start alone');
  const noVariant = await ask(friend, 'four_room_create', { timeControl: TC });
  check(noVariant.ok === false && /game mode/.test(noVariant.error), 'a create without a game is refused (never quietly 4 Player Chess)');
  const queueWhileRoom = await ask(host, 'four_join_queue', { timeControl: TC, variant: 'ffa' });
  check(queueWhileRoom.ok === false && /friend room/.test(queueWhileRoom.error), 'a member of a room cannot queue');
  const joined = await ask(friend, 'four_room_join', { code: created.room.code });
  const closedPromise = waitFor(friend, 'four_room_closed');
  host.disconnect();
  const closed = await closedPromise;
  check(joined.ok && closed.reason === 'hostLeft', 'the host disconnects: the friend is told "hostLeft"');
  for (const s of [friend, stranger]) s.disconnect();
}

console.log(`\nAll good - ${passed} checks passed.`);
server.close();
process.exit(0);
