/**
 * Bughouse FRIEND ROOMS over REAL sockets against real server processes of their own (W6; BUGHOUSE_SPEC.md 5.7, HP11): the wiring that test-bughouse-friend-rooms.mjs (the manager on a fake
 * clock) and test-bughouse-matchmaking.mjs (the placements) can only prove in pieces.
 *
 *   npm run test:bughouseFriendOnline        (needs DATABASE_URL on this machine: registers throw-away accounts and deletes them)
 *
 * Servers (free ports, NODE_ENV=development, the local database): the first with a 4 s fill wait (FOUR_FILL_MS, the 4-seat games' override that Bughouse reads) and the guarded room-life
 * override left UNSET (the production 10 minutes); the second with BUGHOUSE_ROOM_TTL_TEST_MS=2500 to watch a code expire. Both overrides are set on these child processes only (CHECKLIST 7).
 * What it proves: pair + bots (at once), pair + two solos (at once, the friends are seats 0 + 3), pair + pair (the earlier pair is 0 + 3), pair + bots by the fill wait, a pair broken in the
 * queue by a disconnect (the host is back in the room, the slot free) and by a cancel (both back in the open room), a host that leaves, guests refused, the three limiter scopes bite over
 * the wire, a valid code is refused while a scope is blocked, one sentence for every failure, an expired code, and that NO code is ever written to a server log.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import { BUG_ROOM_NOT_FOUND_MESSAGE } from '../src/game/bughouse/index.ts';
import { killTree, portIsFree, sleep } from './e2e-browser/stack.mjs';
import { createUserTracker, isLocalDatabaseUrl, resolveDatabaseUrl } from './lib/test-user-cleanup.mjs';

let passed = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ok  ${message}`);
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const databaseUrl = resolveDatabaseUrl();
if (!isLocalDatabaseUrl(databaseUrl ?? '')) throw new Error('DATABASE_URL is not a local database: this test only runs against this machine');
const TC = { initialMs: 180000, incrementMs: 0 };

const servers = [];
async function boot(extraEnv) {
  let port = 3700 + Math.floor(Math.random() * 200);
  while (!(await portIsFree(port))) port++;
  const lines = [];
  const env = { ...process.env, PORT: String(port), NODE_ENV: 'development', AUTH_RATE_LIMIT_TEST_OVERRIDE: '1000', TRUSTED_PROXY_HOPS: '1', ...extraEnv };
  const child = spawn(process.execPath, [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/index.ts'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)));
  const server = { url: `http://127.0.0.1:${port}`, lines, stop: () => killTree(child) };
  servers.push(server);
  for (let i = 0; i < 240; i++) {
    try {
      if ((await fetch(`${server.url}/health`)).ok) return server;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error(`the server did not come up: ${lines.slice(-4).join(' | ')}`);
}

const tracker = createUserTracker({ databaseUrl, getPrisma: async () => new (await import('@prisma/client')).PrismaClient({ datasources: { db: { url: databaseUrl } } }), log: () => {} });
const sockets = [];
const allCodes = new Set();

async function register(server, n) {
  const tag = randomBytes(4).toString('hex');
  const res = await fetch(`${server.url}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: `fr${n}${tag}`, email: `fr${n}-${tag}@test.local`, password: randomBytes(12).toString('hex') }) });
  assert.equal(res.status, 201);
  const body = await res.json();
  tracker.track({ userId: body.user.id });
  return { token: body.token, name: `fr${n}${tag}` };
}

/** A connected client that records every room / queue / match event it receives. */
async function client(server, account, forwardedFor) {
  const socket = io(server.url, { transports: ['websocket'], reconnection: false, ...(account ? { auth: { token: account.token } } : {}), ...(forwardedFor ? { extraHeaders: { 'x-forwarded-for': forwardedFor } } : {}) });
  sockets.push(socket);
  const inbox = { updates: [], closed: [], found: [], queue: [] };
  socket.on('bug_room_update', (p) => inbox.updates.push(p));
  socket.on('bug_room_closed', (p) => inbox.closed.push(p));
  socket.on('bug_match_found', (p) => inbox.found.push(p));
  socket.on('bug_queue_update', (p) => inbox.queue.push(p));
  await new Promise((resolve, reject) => (socket.once('connect', resolve), socket.once('connect_error', reject)));
  const ask = (event, payload) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${event}: no ack`)), 8000);
      const done = (res) => (clearTimeout(timer), resolve(res));
      if (payload === undefined) socket.emit(event, done);
      else socket.emit(event, payload, done);
    });
  return { socket, inbox, ask, name: account?.name ?? 'Guest' };
}
async function until(what, test, ms = 15_000) {
  const t0 = Date.now();
  while (!test()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting until ${what}`);
    await sleep(15);
  }
}
const seatsOf = (found) => found.seats.map((s) => `${s.kind === 'human' ? 'H' : 'B'}`).join('');

/** A host and a friend inside a room (the friend joined). */
async function pairRoom(server, accounts, hostIndex) {
  const host = await client(server, accounts[hostIndex]);
  const friend = await client(server, accounts[hostIndex + 1]);
  const created = await host.ask('bug_room_create', { timeControl: TC });
  assert.ok(created.ok, JSON.stringify(created));
  allCodes.add(created.room.code);
  const joined = await friend.ask('bug_room_join', { code: created.room.code });
  assert.ok(joined.ok, JSON.stringify(joined));
  await until('the host hears the friend came', () => host.inbox.updates.some((u) => u.friendName !== null));
  return { host, friend, code: created.room.code };
}

try {
  const main = await boot({ FOUR_FILL_MS: '4000' });
  const accounts = [];
  for (let i = 0; i < 12; i++) accounts.push(await register(main, i));

  console.log('\n=== 1. A room, a code, a friend ===');
  {
    const host = await client(main, accounts[0]);
    const guest = await client(main, null);
    const refused = await guest.ask('bug_room_create', { timeControl: TC });
    ok(refused.ok === false && /Sign in/.test(refused.error), 'a guest cannot open a room (login is required)');
    ok((await host.ask('bug_room_create', { timeControl: { initialMs: 7, incrementMs: 0 } })).ok === false, 'a time control outside the six is refused');
    const created = await host.ask('bug_room_create', { timeControl: TC });
    allCodes.add(created.room.code);
    ok(created.ok && /^[A-HJKMNP-Z2-9]{6}$/.test(created.room.code) && created.room.youAre === 'host' && created.room.friendName === null && created.room.expiresInMs > 590000, 'a logged-in host opens a room: a 6-character code, the friend slot free, about 10 minutes');
    ok((await host.ask('bug_room_create', { timeControl: TC })).ok === false, 'a second room for the same user is refused');
    ok((await guest.ask('bug_room_join', { code: created.room.code })).error === 'Sign in to play Bughouse with a friend.', 'a guest cannot join either');
    const friend = await client(main, accounts[1]);
    const joined = await friend.ask('bug_room_join', { code: created.room.code.toLowerCase() });
    ok(joined.ok && joined.room.youAre === 'friend' && joined.room.hostName === accounts[0].name, 'the friend joins (the code in lower case works): they see the host');
    await until('the host is told', () => host.inbox.updates.at(-1)?.friendName === accounts[1].name);
    ok(true, 'the host is told at once who joined');
    const third = await client(main, accounts[2]);
    ok((await third.ask('bug_room_join', { code: created.room.code })).error === BUG_ROOM_NOT_FOUND_MESSAGE, 'a third user finds the room full: the one sentence');
    const left = await friend.ask('bug_room_leave');
    await until('the host sees the free slot', () => host.inbox.updates.at(-1)?.friendName === null);
    ok(left.ok, 'the friend leaves: the slot is freed, the host is told, the code stays valid');
    ok((await third.ask('bug_room_join', { code: created.room.code })).ok === true, '...and another friend takes it with the same code');
    host.socket.disconnect();
    await until('the friend is told the room closed', () => third.inbox.closed.length === 1);
    ok(third.inbox.closed[0].reason === 'hostLeft', 'the host disconnects: the friend is told "hostLeft"');
  }

  console.log('\n=== 2. Start with bots: the friends are teammates 0 + 3 ===');
  {
    const { host, friend, code } = await pairRoom(main, accounts, 3);
    const started = await host.ask('bug_room_start', { mode: 'bots' });
    await until('both friends get a match', () => host.inbox.found.length === 1 && friend.inbox.found.length === 1);
    const [a, b] = [host.inbox.found[0], friend.inbox.found[0]];
    ok(started.ok && started.outcome === 'started' && a.seat + b.seat === 3 && [a.seat, b.seat].every((s) => s === 0 || s === 3), `the match starts at once: the friends are seats ${a.seat} and ${b.seat} (0 + 3)`);
    ok(a.seats.filter((s) => s.kind === 'bot').length === 2 && [1, 2].every((i) => a.seats[i].kind === 'bot'), '...and the two bots are the OTHER team (seats 1 + 2)');
    ok(a.roomId === b.roomId && a.timeControl.initialMs === 180000, '...the same room, the room\'s time control');
    const late = await client(main, accounts[5]);
    ok((await late.ask('bug_room_join', { code })).error === BUG_ROOM_NOT_FOUND_MESSAGE, 'the code is consumed: it no longer works');
    host.socket.emit('bug_resign', { roomId: a.roomId }, () => {});
  }

  console.log('\n=== 3. A pair in the queue with two solos ===');
  {
    const { host, friend } = await pairRoom(main, accounts, 3 + 0 === 3 ? 6 : 6);
    const started = await host.ask('bug_room_start', { mode: 'queue' });
    ok(started.ok && started.outcome === 'queued', 'the host sends the pair to the matchmaking');
    await until('both screens are queued', () => host.inbox.updates.at(-1)?.phase === 'queued' && friend.inbox.updates.at(-1)?.phase === 'queued');
    ok(friend.inbox.updates.at(-1).youAre === 'friend', 'the friend\'s screen follows the host: the same queue');
    await until('the queue update reaches both (a pair counts as two at once)', () => host.inbox.queue.at(-1)?.queued === 2 && friend.inbox.queue.at(-1)?.queued === 2);
    ok(host.inbox.queue.at(-1).fillInMs !== null, '...with the fill clock already running');
    const solo1 = await client(main, null);
    const solo2 = await client(main, null);
    ok((await solo1.ask('bug_join_queue', { timeControl: TC })).ok && (await solo2.ask('bug_join_queue', { timeControl: TC })).ok, 'two solo players queue');
    await until('a four-human match starts at once', () => [host, friend, solo1, solo2].every((c) => c.inbox.found.length === 1));
    const [h, f, s1, s2] = [host, friend, solo1, solo2].map((c) => c.inbox.found[0]);
    ok(seatsOf(h) === 'HHHH' && h.seat + f.seat === 3 && s1.seat + s2.seat === 3 && [s1.seat, s2.seat].every((s) => s === 1 || s === 2), `pair + 2 solos: friends ${h.seat} + ${f.seat}, solos ${s1.seat} + ${s2.seat}`);
    h.roomId && host.socket.emit('bug_resign', { roomId: h.roomId }, () => {});
  }

  console.log('\n=== 4. Pair + pair: the pair that waited longer is 0 + 3 ===');
  {
    const first = await pairRoom(main, accounts, 6 + 2);
    await first.host.ask('bug_room_start', { mode: 'queue' });
    await until('the first pair is queued', () => first.host.inbox.queue.length > 0);
    const second = await pairRoom(main, accounts, 6 + 4);
    await second.host.ask('bug_room_start', { mode: 'queue' });
    const all = [first.host, first.friend, second.host, second.friend];
    await until('four humans start at once', () => all.every((c) => c.inbox.found.length === 1));
    const seats = all.map((c) => c.inbox.found[0].seat);
    ok(seats[0] + seats[1] === 3 && [seats[0], seats[1]].every((s) => s === 0 || s === 3) && seats[2] + seats[3] === 3, `the earlier pair is seats ${seats[0]} + ${seats[1]} (0 + 3), the other ${seats[2]} + ${seats[3]} (1 + 2)`);
    first.host.socket.emit('bug_resign', { roomId: first.host.inbox.found[0].roomId }, () => {});
  }

  console.log('\n=== 5. A pair alone: the fill wait, then bots on the other team ===');
  {
    const { host, friend } = await pairRoom(main, accounts, 0 + 10);
    await host.ask('bug_room_start', { mode: 'queue' });
    await until('the fill wait ends and the match starts', () => host.inbox.found.length === 1 && friend.inbox.found.length === 1, 30_000);
    const found = host.inbox.found[0];
    ok(seatsOf(found).split('').filter((c) => c === 'B').length === 2 && host.inbox.found[0].seat + friend.inbox.found[0].seat === 3, 'after the fill wait the two friends are 0 + 3 and bots fill the other team');
    host.socket.emit('bug_resign', { roomId: found.roomId }, () => {});
  }

  console.log('\n=== 6. A pair broken in the queue ===');
  {
    // (a) the friend disconnects
    const a = await pairRoom(main, accounts, 3);
    await a.host.ask('bug_room_start', { mode: 'queue' });
    await until('queued', () => a.host.inbox.updates.at(-1)?.phase === 'queued');
    a.friend.socket.disconnect();
    await until('the host is back in an open room with the slot free', () => a.host.inbox.updates.at(-1)?.phase === 'open' && a.host.inbox.updates.at(-1)?.friendName === null);
    ok(true, 'the friend disconnects in the queue: the pair entry is cancelled and the host is back on the room screen, the slot free');
    const probe = await client(main, null);
    ok((await probe.ask('bug_join_queue', { timeControl: TC })).ok === true, '...nobody of the pair is left in the queue (a lone solo waits alone)');
    await probe.ask('bug_leave_queue');
    const second = await client(main, accounts[5]);
    ok((await second.ask('bug_room_join', { code: a.code })).ok === true, '...and the code still works for another friend');
    // (b) the friend CANCELS the queue
    await until('the host sees the new friend', () => a.host.inbox.updates.at(-1)?.friendName === accounts[5].name);
    await a.host.ask('bug_room_start', { mode: 'queue' });
    await until('queued again', () => second.inbox.updates.at(-1)?.phase === 'queued');
    await second.ask('bug_leave_queue');
    await until('both are back in the open room', () => a.host.inbox.updates.at(-1)?.phase === 'open' && second.inbox.updates.at(-1)?.phase === 'open');
    ok(a.host.inbox.updates.at(-1).friendName === accounts[5].name, 'a friend cancels the queue: the pair entry is cancelled and BOTH are back in the open room, still together');
    // (c) the host leaves while the pair is queued
    await a.host.ask('bug_room_start', { mode: 'queue' });
    await until('queued a third time', () => a.host.inbox.updates.at(-1)?.phase === 'queued');
    a.host.socket.disconnect();
    await until('the friend is told', () => second.inbox.closed.length === 1);
    ok(second.inbox.closed[0].reason === 'hostLeft', 'the host leaves while the pair is queued: the pair is cancelled and the friend is told the room closed');
    // (d) no friend: "Find a match alone" is a normal solo queue entry
    const lone = await client(main, accounts[4]);
    await lone.ask('bug_room_create', { timeControl: TC });
    const solo = await lone.ask('bug_room_start', { mode: 'queue' });
    await until('a solo queue update', () => lone.inbox.queue.length > 0);
    ok(solo.ok && solo.outcome === 'solo' && lone.inbox.queue.at(-1).queued === 1, 'a host without a friend who presses "Find a match" becomes a plain solo queue entry');
    await lone.ask('bug_leave_queue');
  }

  console.log('\n=== 7. The limiter over the wire ===');
  {
    const host = await client(main, accounts[0]);
    const room = await host.ask('bug_room_create', { timeControl: TC });
    allCodes.add(room.room.code);
    const wrong = (n) => `Q${'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[n % 31]}${'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[(n * 7) % 31]}XZ2`;
    const errors = new Set();
    // socket scope
    const s = await client(main, accounts[7]);
    for (let i = 0; i < 5; i++) {
      const code = wrong(i);
      allCodes.add(code);
      errors.add((await s.ask('bug_room_join', { code })).error);
    }
    const blocked = await s.ask('bug_room_join', { code: room.room.code });
    ok(errors.size === 1 && [...errors][0] === BUG_ROOM_NOT_FOUND_MESSAGE, 'five wrong guesses each get the one sentence');
    ok(blocked.ok === false && blocked.reason === 'rateLimited' && /Too many wrong codes\. Try again in \d+ minutes?\./.test(blocked.error), 'the 6th attempt is refused EVEN WITH THE VALID CODE, with the cooldown sentence');
    ok((await (await client(main, accounts[8])).ask('bug_room_join', { code: room.room.code })).ok === true, 'a different socket (another account) joins the same valid code: the socket block is local');
    // user scope: one account, 10 failures from fresh sockets
    for (let i = 0; i < 10; i++) {
      const c = await client(main, accounts[9], `203.0.113.${i + 1}`);
      allCodes.add(wrong(40 + i));
      await c.ask('bug_room_join', { code: wrong(40 + i) });
      c.socket.disconnect();
    }
    const userBlocked = await (await client(main, accounts[9], '203.0.113.99')).ask('bug_room_join', { code: room.room.code });
    ok(userBlocked.ok === false && userBlocked.reason === 'rateLimited', 'user scope: ten failures from ten sockets and addresses block the 11th attempt of the account');
    // address scope: 30 failures from one address across accounts
    // (four accounts x 8 failures each, every attempt from a fresh socket: below the socket and user limits, so only the address is counting)
    for (let i = 0; i < 30; i++) {
      const c = await client(main, accounts[1 + (i % 4)], '198.51.100.7');
      allCodes.add(wrong(100 + i));
      await c.ask('bug_room_join', { code: wrong(100 + i) });
      c.socket.disconnect();
    }
    const ipBlocked = await (await client(main, accounts[2], '198.51.100.7')).ask('bug_room_join', { code: room.room.code });
    ok(ipBlocked.ok === false && ipBlocked.reason === 'rateLimited', 'address scope: thirty failures from one address block a fresh account on a fresh socket there');
    const otherIp = await (await client(main, accounts[2], '198.51.100.8')).ask('bug_room_join', { code: room.room.code });
    ok(otherIp.reason !== 'rateLimited', '...another address is not blocked');
    const malformed = await (await client(main, accounts[11], '192.0.2.1')).ask('bug_room_join', undefined);
    ok(malformed.ok === false && malformed.error === BUG_ROOM_NOT_FOUND_MESSAGE, 'a malformed payload gets the same sentence');
  }

  console.log('\n=== 8. A code expires ===');
  {
    const short = await boot({ BUGHOUSE_ROOM_TTL_TEST_MS: '2500' });
    const acc = [await register(short, 20), await register(short, 21)];
    const host = await client(short, acc[0]);
    const friend = await client(short, acc[1]);
    const room = await host.ask('bug_room_create', { timeControl: TC });
    allCodes.add(room.room.code);
    ok(room.ok && room.room.expiresInMs <= 2500, 'a server with the guarded override gives a room a 2.5 s life (production: 10 minutes)');
    await sleep(2700);
    const late = await friend.ask('bug_room_join', { code: room.room.code });
    ok(late.ok === false && late.error === BUG_ROOM_NOT_FOUND_MESSAGE, 'after its life the code answers with the one sentence');
    ok((await host.ask('bug_room_create', { timeControl: TC })).ok === true, '...and its host may open a new room');
    ok(!short.lines.some((l) => l.includes('BUGHOUSE_ROOM_TTL_TEST_MS')), 'a development server honours the override without a warning');
  }

  console.log('\n=== 9. No code is ever logged ===');
  {
    const text = servers.flatMap((s) => s.lines).join('\n');
    const leaked = [...allCodes].filter((code) => text.includes(code));
    ok(allCodes.size >= 30 && leaked.length === 0, `the servers' logs (${text.split('\n').length} lines) contain none of the ${allCodes.size} codes used - valid and wrong`);
  }
} finally {
  for (const s of sockets) s.disconnect();
  for (const s of servers) s.stop();
  const cleanup = await tracker.cleanup();
  console.log(`  cleanup: ${cleanup.deleted} test account(s) deleted (${cleanup.remaining} left)`);
}

console.log(`\n${passed} checks passed`);
