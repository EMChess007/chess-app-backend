/**
 * 4 Player Chess ONLINE - the Socket.IO handlers (src/game/fourPlayerHandlers.ts, workstream W4).
 *
 *   npm run test:fourplayerHandlers        (tsx; no server, no database; fake io + fake sockets + Node fake timers)
 *
 * The REAL handlers, room manager and matchmaker are driven through fake sockets (`socket.fire(event, payload, ack)`), the way socket.io
 * would call them; only the username lookup is stubbed. What is guarded: that every one of the nine events is wired and nothing else is;
 * the join-queue guards (validation, already queued, already seated, a socket that left during the username lookup, two joins racing);
 * identity from a real signed JWT (a bad token is a guest); a complete game in-process (queue -> fill -> bots -> moves -> resign ->
 * rejoin -> chat -> spectate); the disconnect hook; and the boundary with the network - a client can send ANY payload and ANY ack (or
 * none, or an ack that throws) and nothing escapes as an exception or an unhandled rejection, which on a real server would kill every game.
 */
import './fourplayer-test-env.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mock } from 'node:test';
import { signToken } from '../src/lib/jwt.ts';
import { registerFourPlayerHandlers } from '../src/game/fourPlayerHandlers.ts';
import { FOUR_CLIENT_EVENT_NAMES } from '../src/game/fourPlayerWire.ts';
import * as E from '../src/game/fourPlayer/index.ts';
import { mulberry32, startFakeTimers } from './fourplayer-test-kit.mjs';

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ok  ${message}`);
}
const { liveTimeouts } = startFakeTimers();

const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

const TC = { initialSeconds: 600, incrementSeconds: 0 };
const FILL = 1000;
const settle = async () => {
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
    /** Fires an event with a collecting ack; resolves with every reply received once the handler has settled. */
    async call(event, payload) {
      const replies = [];
      listeners.get(event)(payload, (r) => replies.push(r));
      await settle();
      return replies;
    },
    disconnect() {
      this.connected = false;
      listeners.get('disconnect')?.();
    },
  };
}
const eventsTo = (io, id, event) => io.events.filter((e) => e.id === id && e.event === event);

/** The handlers on a fake io, with a stubbed username lookup that records its calls. */
function boot(extra = {}) {
  const io = fakeIo();
  const lookups = [];
  const resolveName = extra.resolveName ?? (async (userId) => (lookups.push(userId), `name-of-${userId}`));
  const registered = registerFourPlayerHandlers(io, {
    resolveName,
    matchmakerOptions: { fillWaitMs: FILL, ...(extra.randomInt ? { randomInt: extra.randomInt } : {}) },
    roomOptions: { rng: mulberry32(1), botRng: mulberry32(2), ...(extra.roomOptions ?? {}) },
    ...(extra.userIdOf ? { userIdOf: extra.userIdOf } : {}),
  });
  return { io, lookups, ...registered, connect: (id, opts) => io.connect(fakeSocket(id, opts)) };
}

console.log('\n=== 1. Exactly the nine events are wired ===');
{
  const { connect } = boot();
  const s = connect('A');
  check([...s.listeners.keys()].filter((k) => k !== 'disconnect').sort().join() === [...FOUR_CLIENT_EVENT_NAMES].sort().join(), 'a connected socket listens to exactly the nine four_* client events of the wire contract (and disconnect)');
  check([...s.listeners.keys()].every((k) => k === 'disconnect' || k.startsWith('four_')), '...no event outside the four_* namespace (the 2-player events cannot collide)');
}

console.log('\n=== 2. Joining the queue ===');
{
  const { connect, matchmaker, io, lookups } = boot();
  const a = connect('A');
  const res = await a.call('four_join_queue', { timeControl: TC });
  check(res.length === 1 && res[0].ok === true && matchmaker.isQueued('A'), 'a guest joins: ack { ok: true } and it is queued');
  check(lookups.length === 0, '...and no username lookup was made for a guest');
  const update = eventsTo(io, 'A', 'four_queue_update');
  check(update.length === 1 && update[0].payload.queued === 1 && update[0].payload.fillInMs === null, '...and it receives four_queue_update { queued: 1, fillInMs: null }');
  const again = await a.call('four_join_queue', { timeControl: TC });
  check(again.length === 1 && again[0].ok === false && /already in a queue/.test(again[0].error) && matchmaker.size() === 1, 'joining again is refused ("already in a queue") and changes nothing');
  const bad = [undefined, null, 5, 'x', [], {}, { timeControl: { initialSeconds: 0, incrementSeconds: 0 } }, { timeControl: { initialSeconds: 86_400, incrementSeconds: 0 } }, { timeControl: { initialSeconds: 59, incrementSeconds: 0 } }, { timeControl: TC, timeControlLabel: 'x'.repeat(41) }];
  const b = connect('B');
  for (const payload of bad) {
    const r = await b.call('four_join_queue', payload);
    assert.ok(r.length === 1 && r[0].ok === false && typeof r[0].error === 'string' && !/went wrong/.test(r[0].error), `a bad join payload (${JSON.stringify(payload)}) is refused by the VALIDATOR with its own message (not by a crash: "${r[0]?.error}")`);
  }
  passed++;
  console.log(`  ok  ${bad.length} bad join payloads (no payload, junk, "No time limit", Daily, out of range, long label) are refused with a message...`);
  check(!matchmaker.isQueued('B') && matchmaker.size() === 1, '...and none of them queued the socket');
  const noLimit = await b.call('four_join_queue', { timeControl: { initialSeconds: 0, incrementSeconds: 0 } });
  check(/time limit/.test(noLimit[0].error), '"No time limit" gets the specific explanation ("Online 4 Player needs a time limit...")');
}
{
  const { connect, lookups, io } = boot();
  const token = signToken({ userId: 'user-7' });
  const a = connect('A', { token });
  const r = await a.call('four_join_queue', { timeControl: TC });
  check(r[0].ok === true && lookups.join() === 'user-7', 'a valid JWT identifies a user: the username lookup is made, for that user id');
  const b = connect('B');
  await b.call('four_join_queue', { timeControl: TC });
  mock.timers.tick(FILL);
  const found = eventsTo(io, 'A', 'four_match_found')[0].payload;
  check(found.seats.map((s) => s.name).includes('name-of-user-7') && found.seats.map((s) => s.name).includes('Guest'), '...and the game shows the looked-up name for the user and "Guest" for the guest');
}
{
  // Anything that is not a valid token is a guest - without a lookup and without an error.
  const bads = [undefined, '', 'not-a-jwt', 12345, {}, signToken({ userId: 'x' }) + 'tampered', [], null];
  for (const token of bads) {
    const { connect, matchmaker, lookups } = boot();
    const s = connect('A', { token });
    const r = await s.call('four_join_queue', { timeControl: TC });
    assert.ok(r[0].ok === true && lookups.length === 0 && matchmaker.isQueued('A'), `token ${JSON.stringify(token)?.slice(0, 20)} is treated as a guest`);
  }
  passed++;
  console.log(`  ok  ${bads.length} kinds of missing / malformed / tampered token are guests: no lookup, no error, still able to queue`);
}
{
  // A failed username lookup falls back to "Player" instead of blocking the queue.
  const realError = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  const { connect, matchmaker, io } = boot({ resolveName: async () => { throw new Error('db down'); } });
  const a = connect('A', { token: signToken({ userId: 'u1' }) });
  const r = await a.call('four_join_queue', { timeControl: TC });
  const b = connect('B');
  await b.call('four_join_queue', { timeControl: TC });
  mock.timers.tick(FILL);
  console.error = realError;
  const seats = eventsTo(io, 'A', 'four_match_found')[0].payload.seats;
  check(r[0].ok === true && matchmaker.size() === 0 && seats.map((s) => s.name).includes('Player') && logged.some((l) => /lookup failed/.test(l)), 'a username lookup that fails: the player still queues, plays as "Player", and the failure is logged');
}
{
  // The socket leaves while the lookup is in flight: it must never be queued.
  let release;
  const { connect, matchmaker } = boot({ resolveName: () => new Promise((resolve) => (release = resolve)) });
  const a = connect('A', { token: signToken({ userId: 'u1' }) });
  const replies = [];
  a.listeners.get('four_join_queue')({ timeControl: TC }, (r) => replies.push(r));
  await settle();
  a.disconnect();
  release('Name');
  await settle();
  check(!matchmaker.isQueued('A') && matchmaker.size() === 0 && replies.length === 0, 'a socket that disconnects during its username lookup is never queued (and there is nobody to answer)');
}
{
  // Two joins racing before either lookup returns: exactly one queue entry.
  const resolvers = [];
  const { connect, matchmaker } = boot({ resolveName: () => new Promise((resolve) => resolvers.push(resolve)) });
  const a = connect('A', { token: signToken({ userId: 'u1' }) });
  const replies = [];
  a.listeners.get('four_join_queue')({ timeControl: TC }, (r) => replies.push(r));
  a.listeners.get('four_join_queue')({ timeControl: TC }, (r) => replies.push(r));
  await settle();
  check(resolvers.length === 2, 'two joins racing: neither is queued yet, so both pass the early check and both lookups start');
  resolvers[0]('Name');
  resolvers[1]('Name');
  await settle();
  check(matchmaker.size() === 1 && replies.length === 2 && replies.filter((r) => r.ok).length === 1 && replies.filter((r) => !r.ok && /already in a queue/.test(r.error)).length === 1, 'two joins racing: exactly one entry in the queue, one ok and one "already in a queue"');
}
{
  // Replies must be safe whatever the client passes where the ack belongs.
  const { connect, matchmaker } = boot();
  const a = connect('A');
  let threw = false;
  try {
    a.fire('four_join_queue', { timeControl: TC }, 'not-a-function');
    a.fire('four_make_move', { roomId: 'x' }, 42);
    a.fire('four_leave_queue');
    a.fire('four_list_active_games', {}, {});
    await settle();
  } catch {
    threw = true;
  }
  check(!threw && matchmaker.isQueued('A') === false, 'a non-function ack, a number, an object or no arguments at all never throws (the join with a junk ack was queued, then left by the bare leave)');
  const c = connect('C');
  const noPayload = [];
  c.listeners.get('four_list_active_games')((r) => noPayload.push(r)); // the ack in FIRST place: the client sent no payload
  await settle();
  check(noPayload.length === 1 && noPayload[0].ok === true && Array.isArray(noPayload[0].games), 'a client that sends no payload and only an ack (socket.io puts it first) still gets its answer');
  const realError = console.error;
  const logged = [];
  console.error = (...x) => logged.push(x.join(' '));
  c.listeners.get('four_leave_queue')({}, () => {
    throw new Error('ack blew up');
  });
  await settle();
  console.error = realError;
  check(logged.length === 1 && /ack of four_leave_queue threw/.test(logged[0]), 'an ack callback that throws is caught and logged, not propagated');
}

console.log('\n=== 2b. Faults inside the server are contained, and the late guards matter ===');
{
  // An exception or rejection INSIDE a handler (not the client's doing) must become an error reply, never an uncaught exception.
  const realError = console.error;
  const logged = [];
  console.error = (...x) => logged.push(x.join(' '));
  const sync = boot();
  sync.rooms.makeMove = () => {
    throw new Error('manager exploded');
  };
  const a = sync.connect('A');
  const r1 = await a.call('four_make_move', { roomId: 'x', from: 'e2', to: 'e4' });
  check(r1.length === 1 && r1[0].ok === false && /went wrong/.test(r1[0].error) && logged.some((l) => /four_make_move failed/.test(l)), 'a handler that THROWS synchronously: the client gets { ok: false, "Something went wrong." } and the failure is logged');
  const asyncCase = boot();
  asyncCase.matchmaker.join = () => {
    throw new Error('matchmaker exploded');
  };
  const b = asyncCase.connect('B');
  const r2 = await b.call('four_join_queue', { timeControl: TC });
  check(r2.length === 1 && r2[0].ok === false && /went wrong/.test(r2[0].error) && logged.some((l) => /four_join_queue failed/.test(l)), 'an ASYNC handler that fails after an await (the join): the rejection is caught, answered and logged - it is never an unhandled rejection');
  console.error = realError;
  check(unhandled.length === 0, '...and no unhandled rejection was raised');
}
{
  // The username lookup is the only await in the join, and the world can change during it.
  const resolvers = [];
  const { connect, matchmaker, rooms, io } = boot({ resolveName: () => new Promise((resolve) => resolvers.push(resolve)) });
  const a = connect('A', { token: signToken({ userId: 'ua' }) });
  const replies = [];
  a.listeners.get('four_join_queue')({ timeControl: TC }, (r) => replies.push({ n: 1, r })); // J1
  a.listeners.get('four_join_queue')({ timeControl: TC }, (r) => replies.push({ n: 2, r })); // J2: both pass the early check
  await settle();
  check(resolvers.length === 2, 'two joins from one socket are both waiting for their username lookup');
  resolvers[0]('A-name'); // J1 completes: A is queued
  await settle();
  const b = connect('B');
  b.listeners.get('four_join_queue')({ timeControl: TC }, () => {});
  await settle();
  mock.timers.tick(FILL); // the lobby of two starts: A is now SEATED in a game
  check(rooms.isSeated('A') && !matchmaker.isQueued('A') && eventsTo(io, 'A', 'four_match_found').length === 1, 'meanwhile A\'s first join got it into a game: it is seated');
  resolvers[1]('A-name'); // J2 completes AFTER A was seated
  await settle();
  const second = replies.find((x) => x.n === 2);
  check(second && second.r.ok === false && /already in a game/.test(second.r.error) && !matchmaker.isQueued('A') && matchmaker.size() === 0, 'the second join, finishing its lookup after A was seated, is refused ("already in a game"): a seated socket is never queued');
}
{
  // A socket that is queued and asks again must not trigger a second database lookup.
  const { connect, lookups } = boot();
  const a = connect('A', { token: signToken({ userId: 'ua' }) });
  await a.call('four_join_queue', { timeControl: TC });
  const before = lookups.length;
  const again = await a.call('four_join_queue', { timeControl: TC });
  check(again[0].ok === false && lookups.length === before, 'a socket that is already queued and joins again is refused BEFORE any username lookup (no database query for a refused request)');
}

{
  // A send that throws (a socket going away) must not make a SUCCESSFUL join report an error: the player IS queued.
  const realError = console.error;
  const logged = [];
  console.error = (...x) => logged.push(x.join(' '));
  const { connect, matchmaker, io } = boot();
  io.to = () => ({ emit: () => { throw new Error('send failed'); } });
  const a = connect('A');
  const r = await a.call('four_join_queue', { timeControl: TC });
  console.error = realError;
  check(r.length === 1 && r[0].ok === true && matchmaker.isQueued('A') && logged.some((l) => /failed to send four_queue_update/.test(l)), 'a queue update that cannot be sent is logged but the join still succeeds (the player is queued, so the ack must say so)');
}

console.log('\n=== 3. Leaving the queue, and disconnecting ===');
{
  const baseTimers = liveTimeouts.size; // earlier scenarios leave their own games running
  const { connect, matchmaker, io } = boot();
  const a = connect('A');
  const b = connect('B');
  const c = connect('C');
  await a.call('four_join_queue', { timeControl: TC });
  await b.call('four_join_queue', { timeControl: TC });
  await c.call('four_join_queue', { timeControl: TC });
  io.events.length = 0;
  const left = await b.call('four_leave_queue', {});
  check(left[0].ok === true && !matchmaker.isQueued('B') && eventsTo(io, 'A', 'four_queue_update')[0].payload.queued === 2, 'four_leave_queue removes the socket and the rest are told');
  check((await b.call('four_leave_queue', {}))[0].ok === true, 'leaving when not queued is still ok');
  io.events.length = 0;
  a.disconnect();
  check(!matchmaker.isQueued('A') && eventsTo(io, 'C', 'four_queue_update')[0].payload.queued === 1 && liveTimeouts.size === baseTimers, 'a queued socket that disconnects leaves the queue, the others are told, and the fill timer is cancelled (one human left)');
}

console.log('\n=== 4. A whole game, in-process ===');
{
  // randomInt always 0: a deterministic seat order, whatever it is the tests read it from match_found.
  const { connect, io, rooms, matchmaker } = boot({ randomInt: () => 0 });
  const h1 = connect('H1');
  const h2 = connect('H2');
  await h1.call('four_join_queue', { timeControl: TC, timeControlLabel: 'Friday blitz' });
  await h2.call('four_join_queue', { timeControl: TC });
  check(['H1', 'H2'].every((id) => { const u = eventsTo(io, id, 'four_queue_update').at(-1).payload; return u.queued === 2 && u.fillInMs === FILL; }), "the second human's join starts the countdown: BOTH are told { queued: 2, fillInMs: 1000 }");
  mock.timers.tick(FILL - 1);
  check(eventsTo(io, 'H1', 'four_match_found').length === 0, 'nothing at 999 ms');
  mock.timers.tick(1);
  const f1 = eventsTo(io, 'H1', 'four_match_found');
  const f2 = eventsTo(io, 'H2', 'four_match_found');
  check(f1.length === 1 && f2.length === 1, 'at 1000 ms each human receives four_match_found');
  const m1 = f1[0].payload;
  const m2 = f2[0].payload;
  check(m1.seat !== m2.seat && m1.playerToken !== m2.playerToken && m1.roomId === m2.roomId, 'two different seats and tokens in one room');
  check(m1.timeControlLabel === 'Friday blitz' && m2.timeControlLabel === 'Friday blitz', 'the label the first human queued with reaches the game (not the default "10 min")');
  check(m1.seats.filter((s) => s.kind === 'bot').length === 2 && m1.seats.every((s) => s.kind === 'human' || (s.botReason === 'fill' && s.elo === 1200)), 'the other two seats are fill bots (Amateur, 1200)');
  check(matchmaker.size() === 0 && rooms.isSeated('H1') && rooms.isSeated('H2'), 'both sockets are out of the queue and seated in the room');
  const queuedAgain = await h1.call('four_join_queue', { timeControl: TC });
  check(queuedAgain[0].ok === false && /already in a game/.test(queuedAgain[0].error), 'a seated socket cannot queue for another game');

  // play: humans move on their turns (first legal move), bots on the clock
  const sockets = { [m1.seat]: h1, [m2.seat]: h2 };
  const roomId = m1.roomId;
  let moves = 0;
  let botMoves = 0;
  for (let i = 0; i < 40 && moves < 12; i++) {
    const turn = rooms.rooms.get(roomId).state.turn;
    if (sockets[turn]) {
      const m = E.legalMoves(rooms.rooms.get(roomId).state, turn)[0];
      const ack = await sockets[turn].call('four_make_move', { roomId, from: E.squareName(m.from), to: E.squareName(m.to) });
      assert.ok(ack[0].ok === true && typeof ack[0].seq === 'number', `a human's legal move is acked with its seq: ${JSON.stringify(ack)}`);
      moves++;
    } else {
      mock.timers.tick(450);
      botMoves++;
    }
  }
  const states = eventsTo(io, 'H1', 'four_state');
  check(moves >= 6 && botMoves >= 6 && states.length >= 12, `${moves} human moves and ${botMoves} bot turns were played through the sockets (${states.length} four_state received)`);
  check(states.every((e, i) => e.payload.seq === i + 1) && states.some((e) => e.payload.actor === 'bot') && states.some((e) => e.payload.actor === 'human'), 'seq is contiguous 1..N and both human and bot moves were published');

  // the other events, through the handlers
  const stranger = connect('X');
  const strangerMove = await stranger.call('four_make_move', { roomId, from: 'e2', to: 'e4' });
  check(strangerMove[0].ok === false && /No active game/.test(strangerMove[0].error), 'a socket that is not seated cannot move');
  const list = await stranger.call('four_list_active_games', {});
  check(list[0].ok === true && list[0].games.length === 1 && list[0].games[0].roomId === roomId && JSON.stringify(list[0]).indexOf(m1.playerToken) < 0, 'four_list_active_games lists the game (no tokens)');
  const spec = await stranger.call('four_spectate_game', { roomId });
  check(spec[0].ok === true && spec[0].state.roomId === roomId && spec[0].state.log.length >= 12, 'four_spectate_game returns the room state with the move list');
  check((await stranger.call('four_send_chat', { roomId, text: 'hi' }))[0].ok === false, 'a spectator cannot chat');
  const chat = await h1.call('four_send_chat', { roomId, text: 'hello' });
  check(chat[0].ok === true && eventsTo(io, 'H2', 'four_chat_message').length === 1 && eventsTo(io, 'X', 'four_chat_message').length === 1 && eventsTo(io, 'H1', 'four_chat_message').length === 0, 'chat reaches the other human and the spectator, not the sender');
  check((await stranger.call('four_stop_spectating', {}))[0].ok === true && !rooms.rooms.get(roomId).spectators.has('X'), 'four_stop_spectating leaves the room');

  // disconnect -> the seat is shown as away; rejoin on a new socket with the token
  io.events.length = 0;
  h2.disconnect();
  const away = eventsTo(io, 'H1', 'four_seat_update')[0].payload.seats[m2.seat];
  check(away.connected === false && away.graceMsLeft === 45_000, 'a seated socket that disconnects: the room is told (seat away, 45 s of grace)');
  const h2b = connect('H2b');
  const rejoin = await h2b.call('four_rejoin', { roomId, playerToken: m2.playerToken });
  check(rejoin[0].ok === true && rejoin[0].state.seat === m2.seat && rejoin[0].state.seats[m2.seat].connected === true, 'four_rejoin with the token on a new socket returns the live state and the seat is connected again');
  const wrong = await h2b.call('four_rejoin', { roomId, playerToken: 'nope' });
  check(wrong[0].ok === false, 'a wrong token is refused');
  // resign to the end of the game for the humans; the bots may play on
  const resigned = await h1.call('four_resign', { roomId });
  check(resigned[0].ok === true && rooms.rooms.get(roomId).state.status[m1.seat] === 'dead-king', 'four_resign eliminates the seat');
  const resignedTwice = await h1.call('four_resign', { roomId });
  check(resignedTwice[0].ok === false, '...and cannot be done twice');
}

console.log('\n=== 5. The disconnect hook is guarded ===');
{
  // A throw in one half must not skip the other.
  const realError = console.error;
  const logged = [];
  console.error = (...x) => logged.push(x.join(' '));
  const boot1 = boot();
  boot1.matchmaker.leave = () => {
    throw new Error('queue broke');
  };
  const a = boot1.connect('A');
  let handled = false;
  const original = boot1.rooms.handleDisconnect.bind(boot1.rooms);
  boot1.rooms.handleDisconnect = (id) => {
    handled = id === 'A';
    original(id);
  };
  a.disconnect();
  check(handled && logged.some((l) => /leaving the queue on disconnect failed/.test(l)), 'matchmaker.leave throws: the room manager is still told, and the failure is logged');
  const boot2 = boot();
  boot2.rooms.handleDisconnect = () => {
    throw new Error('rooms broke');
  };
  let left = false;
  const origLeave = boot2.matchmaker.leave.bind(boot2.matchmaker);
  boot2.matchmaker.leave = (id) => {
    left = id === 'B';
    return origLeave(id);
  };
  boot2.connect('B').disconnect();
  console.error = realError;
  check(left && logged.some((l) => /room disconnect handling failed/.test(l)), 'the room manager throws: the queue was still left, and the failure is logged');
}

console.log('\n=== 6. Hostile input: nothing escapes ===');
{
  const { io, connect, rooms } = boot({ randomInt: () => 0 });
  const h1 = connect('H1');
  const h2 = connect('H2');
  await h1.call('four_join_queue', { timeControl: TC });
  await h2.call('four_join_queue', { timeControl: TC });
  mock.timers.tick(FILL);
  const roomId = eventsTo(io, 'H1', 'four_match_found')[0].payload.roomId;
  const stranger = connect('X');
  const room = rooms.rooms.get(roomId);
  const before = { fp: E.serialize(room.state), seq: room.seq };
  const script = mulberry32(99);
  // Payloads that carry a room id. `four_resign` and `four_spectate_game` read ONLY the room id, so a junk payload naming the REAL room is a
  // valid resign - those events get a FAKE room id; the real one is only used for events that cannot succeed on this junk (move, chat, rejoin).
  const base = [undefined, null, 0, -1, NaN, Infinity, '', 'x', '__proto__', true, [], [[]], {}, { timeControl: [] }, { timeControl: { initialSeconds: '600', incrementSeconds: 0 } }, JSON.parse('{"__proto__":{"roomId":"x"}}'), () => 1];
  const withRoom = (id) => [{ roomId: {} }, { roomId: id, from: 1, to: [] }, { roomId: id, from: 'e2', to: 'e4', promotion: {} }, { roomId: id, text: Symbol('s') }, { roomId: id, playerToken: [] }, { roomId: id, from: 'a1', to: 'e4' }, { roomId: id, text: 7 }];
  const junkFake = [...base, ...withRoom('no-such-room')];
  const junkReal = [...base, ...withRoom(roomId)];
  const SAFE_WITH_REAL_ROOM = new Set(['four_make_move', 'four_send_chat', 'four_rejoin']);
  const acks = [undefined, 'str', 7, {}, [], () => {}, () => { throw new Error('ack'); }];
  const realError = console.error;
  console.error = () => {};
  let calls = 0;
  let escaped = 0;
  for (let i = 0; i < 1500; i++) {
    const socket = [h1, stranger][i % 2];
    const event = FOUR_CLIENT_EVENT_NAMES[Math.floor(script() * FOUR_CLIENT_EVENT_NAMES.length)];
    const pool = SAFE_WITH_REAL_ROOM.has(event) ? junkReal : junkFake;
    const payload = pool[Math.floor(script() * pool.length)];
    const ack = acks[Math.floor(script() * acks.length)];
    try {
      socket.fire(event, payload, ack);
    } catch {
      escaped++;
    }
    calls++;
    if (i % 100 === 0) await settle();
  }
  await settle();
  console.error = realError;
  check(calls === 1500 && escaped === 0, `${calls} random event/payload/ack combinations (junk payloads, non-function and throwing acks) across all nine events: nothing threw out of a handler`);
  check(unhandled.length === 0, '...and no unhandled promise rejection was raised (on a real server either one would kill every game)');
  // Every hostile move/resign/chat/join leaves valid state: the position and seq are exactly what the real moves made them
  const after = rooms.rooms.get(roomId);
  check(Boolean(after) && E.serialize(after.state) === before.fp && after.seq === before.seq && rooms.isSeated('H1') && rooms.isSeated('H2') && !rooms.isSeated('X'), '...and the game is EXACTLY as it was: same position, same seq, the same two seated sockets, the stranger still not seated');
}

console.log('\n=== 7. The server wiring (source pins) ===');
{
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').split('\r\n').join('\n');
  const handlers = read('../src/game/fourPlayerHandlers.ts');
  const index = read('../src/index.ts');
  const twoPlayer = read('../src/game/socketHandlers.ts');
  const listens = handlers.match(/listen\(socket, '(four_[a-z_]+)'/g) ?? [];
  check(listens.length === 9 && new Set(listens).size === 9, 'handlers: exactly nine listen() registrations, all distinct');
  check((handlers.match(/socket\.on\(/g) ?? []).length === 2, 'handlers: socket.on appears only in listen() and for disconnect (nothing bypasses the safe wrapper)');
  const handlerCode = handlers.split('\n').filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line)).join('\n'); // code only: the header comment names ack?.() in prose
  check(!/ack\?\.\(/.test(handlerCode), 'handlers: no `ack?.()` (that throws on a non-function ack) anywhere in the code');
  // (since Chaturaji W5 the call passes the test-only switches' dependencies - `seededFourDeps(...)` and the snapshot hook, both empty unless an opt-in variable is set outside production; test-four-test-switches.mjs pins that part)
  check(/registerSocketHandlers\(io\);\n(\/\/[^\n]*\n)*registerFourPlayerHandlers\(io(, \{ \.\.\.seededFourDeps\(fourTestSeed\), [^\n]*\})?\);/.test(index) && (index.match(/registerFourPlayerHandlers/g) ?? []).length === 2, 'index.ts: registerFourPlayerHandlers is imported once and called once, right after registerSocketHandlers(io)');
  check(!/four_|fourPlayer/i.test(twoPlayer), 'the 2-player socketHandlers.ts does not mention the 4-player code at all (no shared path)');
}

mock.timers.reset();
console.log(`\nAll ${passed} checks passed.`);
process.exit(0);
