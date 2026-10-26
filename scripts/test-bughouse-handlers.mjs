/**
 * Bughouse ONLINE - the Socket.IO handlers (src/game/bughouseHandlers.ts, workstream W2) and the isolation of the queues.
 *
 *   npm run test:bughouseHandlers        (tsx; no server, no database; fake io + fake sockets + an injected clock for Bughouse and Node fake timers for the 4-seat stack)
 *
 * The REAL handlers, room manager and matchmaker are driven through fake sockets (`socket.call(event, payload)`), the way socket.io would call them; only the username lookup is stubbed.
 * Guarded: that every one of the eleven events is wired and nothing else is; the join-queue guards; identity from a real signed JWT; a complete match in-process (queue -> fill -> bots ->
 * moves -> chat -> resign -> rejoin -> spectate); the disconnect hook; the boundary with the network (any payload, any ack, nothing escapes as an exception); and the ISOLATION of
 * the Bughouse queue from the 4 Player Chess, 4 Player Giveaway and Chaturaji queues when all four are served by the same `io` at the same time control.
 */
import './fourplayer-test-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mock } from 'node:test';
import { signToken, verifyToken } from '../src/lib/jwt.ts';
import { registerBughouseHandlers } from '../src/game/bughouseHandlers.ts';
import { registerFourPlayerHandlers } from '../src/game/fourPlayerHandlers.ts';
import { BUG_CLIENT_EVENT_NAMES, BUG_REJECT_REASONS, BUG_SERVER_EVENT_NAMES } from '../src/game/bughouse/index.ts';
import { FOUR_CLIENT_EVENT_NAMES, FOUR_SERVER_EVENT_NAMES } from '../src/game/fourPlayerWire.ts';
import { mulberry32, startFakeTimers } from './fourplayer-test-kit.mjs';
import { manualTimers } from './bughouse-test-kit.mjs';

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ok  ${message}`);
}
startFakeTimers();

const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

const TC = { initialMs: 180000, incrementMs: 0 };
const FILL = 1000;
const settleTicks = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

function fakeIo() {
  const connectionListeners = [];
  const events = [];
  return {
    events,
    on: (event, cb) => {
      if (event === 'connection') connectionListeners.push(cb);
    },
    to: (id) => ({ emit: (event, payload) => events.push({ id, event, payload }) }),
    connect(socket) {
      for (const cb of connectionListeners) cb(socket);
      return socket;
    },
  };
}
function fakeSocket(id, { token } = {}) {
  const listeners = new Map();
  return {
    id,
    connected: true,
    handshake: { auth: token === undefined ? {} : { token } },
    listeners,
    on: (event, cb) => listeners.set(event, cb),
    fire: (event, ...args) => listeners.get(event)?.(...args),
    async call(event, payload) {
      const replies = [];
      listeners.get(event)(payload, (r) => replies.push(r));
      await settleTicks();
      return replies;
    },
    disconnect() {
      this.connected = false;
      listeners.get('disconnect')?.();
    },
  };
}
const eventsTo = (io, id, event) => io.events.filter((e) => e.id === id && (event === undefined || e.event === event));

function boot(extra = {}) {
  const io = fakeIo();
  const clock = manualTimers();
  const lookups = [];
  const resolveName = extra.resolveName ?? (async (userId) => (lookups.push(userId), `name-of-${userId}`));
  const registered = registerBughouseHandlers(io, {
    resolveName,
    matchmakerOptions: { fillWaitMs: FILL, ...(extra.randomInt ? { randomInt: extra.randomInt } : {}) },
    roomOptions: { timers: clock.timers, botRng: mulberry32(2), ...(extra.roomOptions ?? {}) },
    ...(extra.userIdOf ? { userIdOf: extra.userIdOf } : {}),
  });
  return { io, clock, lookups, ...registered, connect: (id, opts) => io.connect(fakeSocket(id, opts)) };
}

console.log('\n=== 1. Exactly the eleven events are wired ===');
{
  const { connect } = boot();
  const s = connect('A');
  check([...s.listeners.keys()].filter((k) => k !== 'disconnect').sort().join() === [...BUG_CLIENT_EVENT_NAMES].sort().join() && BUG_CLIENT_EVENT_NAMES.length === 11, 'a connected socket listens to exactly the eleven bug_* client events of the wire contract (and disconnect)');
  check([...s.listeners.keys()].every((k) => k === 'disconnect' || k.startsWith('bug_')), '...no event outside the bug_* namespace (the 2-player and four_* events cannot collide)');
  const names = new Set([...BUG_CLIENT_EVENT_NAMES, ...BUG_SERVER_EVENT_NAMES]);
  check([...FOUR_CLIENT_EVENT_NAMES, ...FOUR_SERVER_EVENT_NAMES].every((n) => !names.has(n)) && BUG_SERVER_EVENT_NAMES.length === 7, 'the two protocols share no event name');
}

console.log('\n=== 2. Joining the queue ===');
{
  const { connect, matchmaker, io, lookups } = boot();
  const a = connect('A');
  const res = await a.call('bug_join_queue', { timeControl: TC });
  check(res.length === 1 && res[0].ok === true && matchmaker.isQueued('A'), 'a guest joins: ack { ok: true } and it is queued');
  check(lookups.length === 0, '...and no username lookup was made for a guest');
  const update = eventsTo(io, 'A', 'bug_queue_update');
  check(update.length === 1 && update[0].payload.queued === 1 && update[0].payload.fillInMs === null, '...and it receives bug_queue_update { queued: 1, fillInMs: null }');
  const again = await a.call('bug_join_queue', { timeControl: TC });
  check(again.length === 1 && again[0].ok === false && /already in a queue/.test(again[0].error) && matchmaker.size() === 1, 'joining again is refused ("already in a queue") and changes nothing');
  const bad = [undefined, null, 5, 'x', [], {}, { timeControl: { initialMs: 0, incrementMs: 0 } }, { timeControl: { initialMs: 600000, incrementMs: 0 } }, { timeControl: { initialSeconds: 180, incrementSeconds: 0 } }, { timeControl: { initialMs: 180000, incrementMs: 1 } }];
  const b = connect('B');
  for (const payload of bad) {
    const r = await b.call('bug_join_queue', payload);
    assert.ok(r.length === 1 && r[0].ok === false && BUG_REJECT_REASONS.includes(r[0].reason) && !/went wrong/.test(r[0].error), `a bad join payload (${JSON.stringify(payload)}) is refused by the VALIDATOR with a reason (not by a crash: "${r[0]?.error}")`);
  }
  passed++;
  console.log(`  ok  ${bad.length} bad join payloads (no payload, junk, a 4-seat time control in seconds, off-list controls) are refused with a reason from the closed list...`);
  check(!matchmaker.isQueued('B') && matchmaker.size() === 1, '...and none of them queued the socket');
  const leave = await a.call('bug_leave_queue', undefined);
  check(leave.length === 1 && leave[0].ok === true && !matchmaker.isQueued('A'), 'bug_leave_queue leaves the queue (with no payload at all)');
}
{
  const { connect, io, lookups, clock } = boot();
  const token = signToken({ userId: 'user-7' });
  const a = connect('A', { token });
  const r = await a.call('bug_join_queue', { timeControl: TC });
  check(r[0].ok === true && lookups.join() === 'user-7', 'a valid JWT identifies a user: the username lookup is made, for that user id');
  const b = connect('B');
  await b.call('bug_join_queue', { timeControl: TC });
  clock.advance(FILL);
  const found = eventsTo(io, 'A', 'bug_match_found')[0].payload;
  check(found.seats.map((s) => s.name).includes('name-of-user-7') && found.seats.map((s) => s.name).includes('Guest'), '...and the match shows the looked-up name for the user and "Guest" for the guest');
}
{
  const bads = [undefined, '', 'not-a-jwt', 12345, {}, signToken({ userId: 'x' }) + 'tampered', [], null];
  for (const token of bads) {
    const { connect, matchmaker, lookups } = boot();
    const s = connect('A', { token });
    const r = await s.call('bug_join_queue', { timeControl: TC });
    assert.ok(r[0].ok === true && lookups.length === 0 && matchmaker.isQueued('A'), `token ${JSON.stringify(token)?.slice(0, 20)} is treated as a guest`);
  }
  passed++;
  console.log(`  ok  ${bads.length} kinds of missing / malformed / tampered token are guests: no lookup, no error, still able to queue`);
}
{
  const realError = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  const { connect, matchmaker, io, clock } = boot({ resolveName: async () => { throw new Error('db down'); } });
  const a = connect('A', { token: signToken({ userId: 'u1' }) });
  const r = await a.call('bug_join_queue', { timeControl: TC });
  const b = connect('B');
  await b.call('bug_join_queue', { timeControl: TC });
  clock.advance(FILL);
  console.error = realError;
  const seats = eventsTo(io, 'A', 'bug_match_found')[0].payload.seats;
  check(r[0].ok === true && matchmaker.size() === 0 && seats.map((s) => s.name).includes('Player') && logged.some((l) => /lookup failed/.test(l)), 'a username lookup that fails: the player still queues, plays as "Player", and the failure is logged');
}
{
  let release;
  const { connect, matchmaker } = boot({ resolveName: () => new Promise((resolve) => (release = resolve)) });
  const a = connect('A', { token: signToken({ userId: 'u1' }) });
  const replies = [];
  a.listeners.get('bug_join_queue')({ timeControl: TC }, (r) => replies.push(r));
  await settleTicks();
  a.disconnect();
  release('Name');
  await settleTicks();
  check(!matchmaker.isQueued('A') && matchmaker.size() === 0 && replies.length === 0, 'a socket that disconnects during its username lookup is never queued (and there is nobody to answer)');
}
{
  const resolvers = [];
  const { connect, matchmaker } = boot({ resolveName: () => new Promise((resolve) => resolvers.push(resolve)) });
  const a = connect('A', { token: signToken({ userId: 'u1' }) });
  const replies = [];
  a.listeners.get('bug_join_queue')({ timeControl: TC }, (r) => replies.push(r));
  a.listeners.get('bug_join_queue')({ timeControl: TC }, (r) => replies.push(r));
  await settleTicks();
  check(resolvers.length === 2, 'two joins racing: neither is queued yet, so both pass the early check and both lookups start');
  resolvers[0]('Name');
  resolvers[1]('Name');
  await settleTicks();
  check(matchmaker.size() === 1 && replies.length === 2 && replies.filter((r) => r.ok).length === 1 && replies.filter((r) => !r.ok && /already in a queue/.test(r.error)).length === 1, 'two joins racing: exactly one entry in the queue, one ok and one "already in a queue"');
}

console.log('\n=== 3. A whole match through the sockets ===');
{
  const { connect, io, clock, rooms, matchmaker } = boot({ randomInt: (n) => n - 1 });
  const a = connect('A');
  const b = connect('B');
  await a.call('bug_join_queue', { timeControl: TC });
  await b.call('bug_join_queue', { timeControl: TC });
  clock.advance(FILL);
  const foundA = eventsTo(io, 'A', 'bug_match_found')[0].payload;
  const foundB = eventsTo(io, 'B', 'bug_match_found')[0].payload;
  check(foundA.seat === 0 && foundB.seat === 1 && matchmaker.size() === 0 && rooms.isSeated('A') && rooms.isSeated('B'), 'two humans fill after the wait: seats 0 and 1 (the unshuffled order), the other two are bots');
  const roomId = foundA.roomId;
  check((await a.call('bug_join_queue', { timeControl: TC }))[0].ok === false, 'a seated socket cannot queue again');
  clock.jump(1000);
  const move = await a.call('bug_move', { roomId, board: 'A', from: 'e2', to: 'e4' });
  check(move[0].ok === true && move[0].seq === 1, 'bug_move: ack { ok: true, seq: 1 }');
  const bad = await b.call('bug_move', { roomId, board: 'B', from: 'e7', to: 'e5' });
  check(bad[0].ok === false && bad[0].reason === 'wrongBoard', 'a move on the other board is refused with wrongBoard');
  const reply = await b.call('bug_move', { roomId, board: 'A', from: 'e7', to: 'e5' });
  check(reply[0].ok === true && reply[0].seq === 2, '...seat 1 answers on its own board');
  const drop = await a.call('bug_drop', { roomId, board: 'A', piece: 'n', square: 'f3' });
  check(drop[0].ok === false && drop[0].reason === 'dropNotInPocket', 'bug_drop: nothing in the pocket is refused with dropNotInPocket');
  const chat = await a.call('bug_chat', { roomId, text: 'hi' });
  check(chat[0].ok === false && chat[0].reason === 'partnerIsBot', 'bug_chat to a bot partner (seat 3): refused, the sender is told');
  const quick = await b.call('bug_quick', { roomId, code: 2 });
  check(quick[0].ok === false && quick[0].reason === 'partnerIsBot', 'bug_quick to a bot partner (seat 2): refused, the sender is told');
  const w = connect('W');
  const list = await w.call('bug_list_active_games', undefined);
  check(list[0].ok === true && list[0].games.length === 1 && list[0].games[0].roomId === roomId, 'bug_list_active_games shows the match');
  const spectate = await w.call('bug_spectate_game', { roomId });
  check(spectate[0].ok === true && spectate[0].state.seq === 2, 'bug_spectate_game: the spectator gets both boards in one snapshot');
  const stop = await w.call('bug_stop_spectating', undefined);
  check(stop[0].ok === true, 'bug_stop_spectating');
  a.disconnect();
  const rejoinSocket = connect('A2');
  const rejoin = await rejoinSocket.call('bug_rejoin', { roomId, playerToken: foundA.playerToken });
  check(rejoin[0].ok === true && rejoin[0].state.seat === 0 && rejoin[0].state.seq === 2, 'bug_rejoin on a new socket restores the seat');
  const resign = await rejoinSocket.call('bug_resign', { roomId });
  check(resign[0].ok === true && eventsTo(io, 'B', 'bug_game_over').length === 1 && eventsTo(io, 'B', 'bug_game_over')[0].payload.result.reason === 'resign', 'bug_resign ends the match: every human gets bug_game_over');
  const late = await b.call('bug_rejoin', { roomId, playerToken: foundB.playerToken });
  check(late[0].ok === true && late[0].finished === true, 'a rejoin after the end returns the result');
}

console.log('\n=== 4. The disconnect hook ===');
{
  const { connect, matchmaker, rooms, io, clock } = boot();
  const a = connect('A');
  await a.call('bug_join_queue', { timeControl: TC });
  a.disconnect();
  check(!matchmaker.isQueued('A'), 'a queued socket that disconnects leaves the queue');
  const x = connect('X');
  const y = connect('Y');
  await x.call('bug_join_queue', { timeControl: TC });
  await y.call('bug_join_queue', { timeControl: TC });
  clock.advance(FILL);
  x.disconnect();
  const seats = eventsTo(io, 'Y', 'bug_seat_update').at(-1).payload.seats;
  check(seats.some((s) => s.kind === 'human' && s.connected === false && typeof s.graceMsLeft === 'number'), 'a seated socket that disconnects is reported to the room manager: the others see it disconnected with a grace');
  void rooms;
}
{
  // each half of the disconnect hook is guarded: a throwing leave() cannot skip the room manager
  const { connect, matchmaker, rooms, io, clock } = boot();
  const x = connect('X');
  const y = connect('Y');
  await x.call('bug_join_queue', { timeControl: TC });
  await y.call('bug_join_queue', { timeControl: TC });
  clock.advance(FILL);
  const original = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  matchmaker.leave = () => {
    throw new Error('leave failed');
  };
  x.disconnect();
  console.error = original;
  check(logged.some((l) => /leaving the queue on disconnect failed/.test(l)) && eventsTo(io, 'Y', 'bug_seat_update').at(-1).payload.seats.some((s) => s.connected === false), 'a leave that throws is logged and the room manager is still told');
  void rooms;
}

console.log('\n=== 5. The boundary with the network ===');
{
  const { connect } = boot();
  const a = connect('A');
  let threw = false;
  const originalError = console.error;
  const loggedAckErrors = [];
  console.error = (...args) => loggedAckErrors.push(args.join(' '));
  try {
    a.fire('bug_join_queue', { timeControl: TC }, 'not-a-function');
    a.fire('bug_move', { roomId: 'x' }, 42);
    a.fire('bug_leave_queue');
    a.fire('bug_list_active_games', {}, {});
    a.fire('bug_resign', undefined, () => {
      throw new Error('ack throws');
    });
    a.fire('bug_chat', null, () => {
      throw new Error('ack throws');
    });
  } catch {
    threw = true;
  }
  await settleTicks();
  console.error = originalError;
  check(!threw && unhandled.length === 0, 'an ack that is not a function, no ack, no payload, an ack that throws: nothing escapes and no promise is rejected');
  check(loggedAckErrors.length === 2 && loggedAckErrors.every((l) => l.includes('the ack of bug_') && l.includes('threw')), '...and each ack that threw was logged once, naming the event');
  const payloads = [undefined, null, 0, 'x', [], {}, { roomId: {} }, { roomId: 'x'.repeat(1000) }, { __proto__: { roomId: 'x' } }, JSON.parse('{"roomId":"a","board":"A","from":"e2","to":"e4","constructor":{"prototype":1}}')];
  for (const event of BUG_CLIENT_EVENT_NAMES.filter((e) => e !== 'bug_leave_queue')) {
    for (const payload of payloads) {
      const replies = await a.call(event, payload);
      assert.ok(replies.length === 1 && replies[0].ok === false || (replies[0].ok === true && ['bug_list_active_games', 'bug_stop_spectating'].includes(event)), `${event} ${JSON.stringify(payload)?.slice(0, 40)}`);
    }
  }
  passed++;
  console.log('  ok  every event with hostile payloads gets exactly one answer (a refusal, or the harmless list / stop)');
  check(unhandled.length === 0, '...and no unhandled rejection');
}
{
  // a manager that throws inside a handler: the client gets a generic error and the process lives
  const { connect, rooms } = boot();
  const original = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  rooms.makeMove = () => {
    throw new Error('boom');
  };
  const a = connect('A');
  const r = await a.call('bug_move', { roomId: 'x', board: 'A', from: 'e2', to: 'e4' });
  console.error = original;
  check(r.length === 1 && r[0].ok === false && r[0].error === 'Something went wrong.' && BUG_REJECT_REASONS.includes(r[0].reason) && logged.length === 1, 'a handler that throws is answered with a generic refusal and logged once');
}

console.log('\n=== 5b. More of the boundary: the ack in first place, an async handler that rejects, a queue update that cannot be sent ===');
{
  const { connect } = boot();
  const a = connect('A');
  // a client that sends no payload leaves the ack in FIRST place
  const replies = [];
  a.listeners.get('bug_list_active_games')((r) => replies.push(r));
  a.listeners.get('bug_leave_queue')((r) => replies.push(r));
  check(replies.length === 2 && replies[0].ok === true && Array.isArray(replies[0].games) && replies[1].ok === true, 'a client that sends no payload (the ack comes first) is answered normally');
  // an ack that is not a function where the ack belongs is no ack: the next argument is
  const second = [];
  a.listeners.get('bug_list_active_games')('payload-not-a-function', (r) => second.push(r));
  a.listeners.get('bug_list_active_games')({}, 'not-an-ack', (r) => second.push(r));
  check(second.length === 1 && second[0].ok === true, 'the ack is the second argument when it is a function, and a non-function there is no ack (nothing is called)');
}
{
  // a handler that REJECTS (the join is async): the client gets the generic refusal, the process keeps its promises
  const { connect, matchmaker } = boot();
  const original = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  matchmaker.join = () => {
    throw new Error('queue exploded');
  };
  const a = connect('A');
  const r = await a.call('bug_join_queue', { timeControl: TC });
  console.error = original;
  check(r.length === 1 && r[0].ok === false && r[0].error === 'Something went wrong.' && logged.length === 1 && logged[0].includes('bug_join_queue failed') && unhandled.length === 0, 'an async handler that throws is answered with the generic refusal, logged once, and is no unhandled rejection');
}
{
  // a queue update that cannot be sent does not stop the join
  const io = fakeIo();
  const clock = manualTimers();
  io.to = () => ({
    emit: () => {
      throw new Error('socket gone');
    },
  });
  const original = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  registerBughouseHandlers(io, { matchmakerOptions: { fillWaitMs: FILL }, roomOptions: { timers: clock.timers } });
  const s = io.connect(fakeSocket('A'));
  const r = await s.call('bug_join_queue', { timeControl: TC });
  console.error = original;
  check(r[0].ok === true && logged.some((l) => l.includes('failed to send bug_queue_update to A')), 'the join succeeds although the queue update cannot be sent; the failure is logged naming the event and the socket');
}

console.log('\n=== 5c. Survivors of the first mutation run, killed (or pinned as equivalent) ===');
{
  // equivalent: the handshake guard "a token must be a non-empty string" only saves a call - verifyToken itself throws on both
  let threwEmpty = false;
  let threwNumber = false;
  try {
    verifyToken('');
  } catch {
    threwEmpty = true;
  }
  try {
    verifyToken(12345);
  } catch {
    threwNumber = true;
  }
  check(threwEmpty && threwNumber, 'verifyToken throws for an empty and for a non-string token, so a guest is a guest even without the guard in front of it');
  // equivalent: a function in the payload place is refused exactly like no payload (every validator wants an object)
  const { connect } = boot();
  const s = connect('A');
  for (const event of BUG_CLIENT_EVENT_NAMES.filter((e) => !['bug_leave_queue', 'bug_list_active_games', 'bug_stop_spectating'].includes(e))) {
    const withFunction = [];
    const withUndefined = [];
    s.listeners.get(event)((r) => withFunction.push(r));
    s.listeners.get(event)(undefined, (r) => withUndefined.push(r));
    await settleTicks();
    assert.deepEqual(withFunction, withUndefined, `${event}: an ack in the payload place is the same as no payload`);
  }
  passed++;
  console.log('  ok  for every event that validates a payload, an ack passed first gets the very answer a missing payload gets (so reading the first argument as the payload would change nothing)');
  // a first argument that is a function and a second that is garbage: the first is the ack
  const replies = [];
  s.listeners.get('bug_list_active_games')((r) => replies.push(r), 'garbage');
  check(replies.length === 1 && replies[0].ok === true, 'an ack in first place is used even when a non-function follows it');
  const none = [];
  s.listeners.get('bug_list_active_games')({}, 'garbage');
  check(none.length === 0, '...and a non-function in second place is never called');
}
{
  // a queued guest asking again is refused BEFORE a username lookup is paid for
  const { connect, lookups } = boot();
  const a = connect('A', { token: signToken({ userId: 'user-1' }) });
  await a.call('bug_join_queue', { timeControl: TC });
  const again = await a.call('bug_join_queue', { timeControl: TC });
  check(again[0].ok === false && /already in a queue/.test(again[0].error) && lookups.length === 1, 'a second join of a queued socket is refused without a second username lookup');
}
{
  // a socket seated while its username is being looked up is NOT queued: the late refusal says so
  let release;
  const { connect, matchmaker, rooms } = boot({ resolveName: () => new Promise((resolve) => (release = resolve)) });
  const a = connect('A', { token: signToken({ userId: 'u1' }) });
  const replies = [];
  a.listeners.get('bug_join_queue')({ timeControl: TC }, (r) => replies.push(r));
  await settleTicks();
  rooms.createRoom({ seats: [{ kind: 'human', socketId: 'A', name: 'a' }, { kind: 'bot', socketId: null, name: 'b', elo: 1200 }, { kind: 'bot', socketId: null, name: 'b', elo: 1200 }, { kind: 'bot', socketId: null, name: 'b', elo: 1200 }], timeControl: TC });
  release('Name');
  await settleTicks();
  check(replies.length === 1 && replies[0].ok === false && replies[0].error === 'You are already in a game.' && !matchmaker.isQueued('A'), 'a socket that was seated while its name was looked up is told it is in a game and is not queued');
  const clockless = rooms;
  void clockless;
}
{
  // stopping a spectate really stops it
  const { connect, rooms, clock } = boot({ randomInt: (n) => n - 1 });
  const a = connect('A');
  const b = connect('B');
  const w = connect('W');
  await a.call('bug_join_queue', { timeControl: TC });
  await b.call('bug_join_queue', { timeControl: TC });
  clock.advance(FILL);
  const [game] = rooms.listActiveGames();
  await w.call('bug_spectate_game', { roomId: game.roomId });
  check(rooms.socketToSpectating.has('W'), 'a spectator is mapped to its room');
  const stop = await w.call('bug_stop_spectating', undefined);
  check(stop[0].ok === true && !rooms.socketToSpectating.has('W') && rooms.rooms.get(game.roomId).spectators.size === 0, 'bug_stop_spectating removes it from the room and from the map');
}
{
  // a room hook that throws on disconnect is logged and does not escape
  const { connect, rooms } = boot();
  const original = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  rooms.handleDisconnect = () => {
    throw new Error('rooms exploded');
  };
  const a = connect('A');
  let escaped = false;
  try {
    a.disconnect();
  } catch {
    escaped = true;
  }
  console.error = original;
  check(!escaped && logged.some((l) => l.includes('room disconnect handling failed')), 'a throwing room disconnect handler is logged and does not escape the disconnect event');
}

console.log('\n=== 6. Isolation: the Bughouse queue never mixes with 4 Player Chess, Giveaway or Chaturaji ===');
{
  const io = fakeIo();
  const clock = manualTimers();
  const bug = registerBughouseHandlers(io, { matchmakerOptions: { fillWaitMs: FILL }, roomOptions: { timers: clock.timers, botRng: mulberry32(3) } });
  const four = registerFourPlayerHandlers(io, { matchmakerOptions: { fillWaitMs: FILL }, roomOptions: { rng: mulberry32(1), botRng: mulberry32(2) } });
  const sockets = {};
  const connect = (id) => (sockets[id] = io.connect(fakeSocket(id)));
  // the same time control (3 minutes) for all four games; two humans each; plus one lone human of each, and a Bughouse human at 3 | 2
  const FOUR_TC = { initialSeconds: 180, incrementSeconds: 0 };
  const joins = [
    ['B1', 'bug_join_queue', { timeControl: TC }],
    ['B2', 'bug_join_queue', { timeControl: TC }],
    ['B3', 'bug_join_queue', { timeControl: { initialMs: 180000, incrementMs: 2000 } }],
    ['F1', 'four_join_queue', { timeControl: FOUR_TC }],
    ['F2', 'four_join_queue', { timeControl: FOUR_TC, variant: 'ffa' }],
    ['G1', 'four_join_queue', { timeControl: FOUR_TC, variant: 'giveaway' }],
    ['G2', 'four_join_queue', { timeControl: FOUR_TC, variant: 'giveaway' }],
    ['C1', 'four_join_queue', { timeControl: FOUR_TC, variant: 'chaturaji' }],
    ['C2', 'four_join_queue', { timeControl: FOUR_TC, variant: 'chaturaji' }],
  ];
  for (const [id, event, payload] of joins) {
    const r = await connect(id).call(event, payload);
    assert.ok(r[0].ok === true, `${id} joins`);
  }
  passed++;
  console.log('  ok  nine humans queue at the same time control: two for Bughouse, one more Bughouse human at 3 | 2, two each for 4 Player Chess (one with no variant, one with ffa), Giveaway and Chaturaji');
  check(bug.matchmaker.size() === 3 && four.matchmaker.size() === 6, 'the Bughouse matchmaker holds 3 and the 4-seat matchmaker 6: no one is in the wrong queue');
  clock.advance(FILL);
  mock.timers.tick(FILL);
  const bugFound = io.events.filter((e) => e.event === 'bug_match_found');
  const fourFound = io.events.filter((e) => e.event === 'four_match_found');
  check(bugFound.map((e) => e.id).sort().join() === 'B1,B2' && fourFound.map((e) => e.id).sort().join() === 'C1,C2,F1,F2,G1,G2', 'Bughouse started with B1 and B2; the 4-seat stack started three games with F1+F2, G1+G2 and C1+C2');
  const variants = new Map(fourFound.map((e) => [e.id, e.payload.variant]));
  check(variants.get('F1') === 'ffa' && variants.get('F2') === 'ffa' && variants.get('G1') === 'giveaway' && variants.get('G2') === 'giveaway' && variants.get('C1') === 'chaturaji' && variants.get('C2') === 'chaturaji', 'each 4-seat pair got its own variant, no mix');
  const roomOf = new Map(fourFound.map((e) => [e.id, e.payload.roomId]));
  check(roomOf.get('F1') === roomOf.get('F2') && roomOf.get('G1') === roomOf.get('G2') && roomOf.get('C1') === roomOf.get('C2') && new Set(roomOf.values()).size === 3 && !roomOf.has('B1'), 'the three 4-seat games are three different rooms');
  check(bug.rooms.listActiveGames().length === 1 && four.rooms.listActiveGames().length === 3, 'one Bughouse room and three 4-seat rooms');
  check(bug.matchmaker.isQueued('B3') && bug.matchmaker.size() === 1, 'the Bughouse human at 3 | 2 is still waiting alone: not pulled into the 3-minute match');
  const namesSeen = (id) => new Set(io.events.filter((e) => e.id === id).map((e) => e.event));
  check(['B1', 'B2', 'B3'].every((id) => [...namesSeen(id)].every((n) => n.startsWith('bug_'))) && ['F1', 'F2', 'G1', 'G2', 'C1', 'C2'].every((id) => [...namesSeen(id)].every((n) => n.startsWith('four_'))), 'every socket received only events of its own protocol');
  const crossBug = await connect('X1').call('bug_join_queue', { timeControl: FOUR_TC });
  const crossFour = await connect('X2').call('four_join_queue', { timeControl: TC });
  check(crossBug[0].ok === false && crossFour[0].ok === false && bug.matchmaker.size() === 1 && four.matchmaker.size() === 0, 'a 4-seat join payload sent to the Bughouse queue (and the reverse) is refused: neither queue took it');
  // the 4-seat room manager does not see a Bughouse socket, and vice versa
  check(!four.rooms.isSeated('B1') && !bug.rooms.isSeated('F1') && bug.rooms.isSeated('B1') && four.rooms.isSeated('F1'), 'each room manager knows only its own sockets');
}

console.log('\n=== 7. The wiring in index.ts ===');
{
  const index = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  check(/registerBughouseHandlers\(io, seededBughouseDeps\(resolveBughouseTestSeed\(\)\)\)/.test(index), 'index.ts registers the Bughouse handlers with the (guarded) seed switch and nothing else');
  check(/registerFourPlayerHandlers\(io, \{ \.\.\.seededFourDeps\(fourTestSeed\)/.test(index), '...and the 4-seat registration is the line it was');
}

console.log(`\nALL ${passed} CHECKS PASSED`);
