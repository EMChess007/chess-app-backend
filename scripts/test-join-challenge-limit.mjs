/**
 * The attempt limit of the 2-player `join_challenge` over REAL sockets against a real server process of its own (a free port, the local database for the one test account,
 * NODE_ENV=development): the wiring that test-attempt-limiter.mjs can only scan for - the limits really bite per socket, per user and per address, a blocked attempt is refused
 * even with a VALID code, every refusal is the same sentence, a normal invite still works, and no code is ever written to the server's log.
 *
 *   npm run test:joinChallengeLimit        (needs DATABASE_URL on this machine; registers one throw-away account and deletes it)
 *
 * The real-time boundaries (5 minutes, 15 minutes, the exact millisecond) are pinned with an injected clock in test-attempt-limiter.mjs; nothing here waits for a window.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import { createUserTracker, isLocalDatabaseUrl, resolveDatabaseUrl } from './lib/test-user-cleanup.mjs';
import { killTree, portIsFree, sleep } from './e2e-browser/stack.mjs';
import { JOIN_REFUSED_MESSAGE } from '../src/game/joinChallengeLimiter.ts';

let passed = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ok  ${message}`);
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const databaseUrl = resolveDatabaseUrl();
if (!isLocalDatabaseUrl(databaseUrl ?? '')) throw new Error('DATABASE_URL is not a local database: this test only runs against this machine');

let port = 3500 + Math.floor(Math.random() * 300);
while (!(await portIsFree(port))) port++;
const lines = [];
const env = { ...process.env, PORT: String(port), NODE_ENV: 'development', AUTH_RATE_LIMIT_TEST_OVERRIDE: '1000' };
env.TRUSTED_PROXY_HOPS = '1'; // this server sits "behind one proxy" (the test client is on loopback, a private peer): X-Forwarded-For is honoured from the RIGHT, one entry in
const child = spawn(process.execPath, [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/index.ts'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
for (const stream of [child.stdout, child.stderr]) stream.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)));
const url = `http://127.0.0.1:${port}`;
const tracker = createUserTracker({ databaseUrl, getPrisma: async () => new (await import('@prisma/client')).PrismaClient({ datasources: { db: { url: databaseUrl } } }), log: () => {} });
const sockets = [];
try {
  let lastProblem = 'no answer';
  for (let i = 0; i < 240; i++) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) break;
      lastProblem = `HTTP ${res.status}`;
    } catch (err) {
      lastProblem = String(err?.cause?.code ?? err?.message ?? err);
    }
    await sleep(250);
    if (i === 239) throw new Error(`the server did not come up (${lastProblem}): ${lines.slice(-4).join(' | ')}`);
  }

  const connect = async (token, forwardedFor) => {
    const s = io(url, { transports: ['websocket'], reconnection: false, ...(token ? { auth: { token } } : {}), ...(forwardedFor ? { extraHeaders: { 'x-forwarded-for': forwardedFor } } : {}) });
    sockets.push(s);
    await new Promise((resolve, reject) => (s.once('connect', resolve), s.once('connect_error', reject)));
    return s;
  };
  const ask = (s, event, payload) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${event}: no ack`)), 8000);
      s.emit(event, payload, (res) => (clearTimeout(timer), resolve(res)));
    });
  const TC = { initialSeconds: 300, incrementSeconds: 0 };
  const everyRefusal = new Set();
  const allCodes = new Set();
  const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let counter = 0;
  /** A well-formed code that no challenge holds (distinct each time, and recorded so the log can be searched for it). */
  const wrongCode = () => {
    const n = counter++;
    const code = `${letters[n % 31]}${letters[Math.floor(n / 31) % 31]}${letters[(n * 7) % 31]}QXZ`;
    allCodes.add(code);
    return code;
  };
  const guess = async (s) => {
    const res = await ask(s, 'join_challenge', { code: wrongCode() });
    everyRefusal.add(res.error);
    return res;
  };
  const makeChallenge = async () => {
    const host = await connect();
    const res = await ask(host, 'create_challenge', { timeControl: TC });
    assert.ok(res.ok && /^[A-Z2-9]{6}$/.test(res.code));
    allCodes.add(res.code);
    return { host, code: res.code };
  };

  // --- a normal invite flow is unaffected ---------------------------------------------------------------------------------------------------
  {
    const { host, code } = await makeChallenge();
    const guest = await connect();
    const matched = Promise.all([host, guest].map((s) => new Promise((resolve) => s.once('match_found', resolve))));
    const res = await ask(guest, 'join_challenge', { code });
    const [a, b] = await Promise.all([matched, sleep(0)]).then(([m]) => m);
    ok(res.ok === true && a && b, 'a normal invite: create a code, a friend joins it, both get match_found');
    const own = await makeChallenge();
    const selfJoin = await ask(own.host, 'join_challenge', { code: own.code });
    ok(selfJoin.ok === false && /own challenge/.test(selfJoin.error), 'joining your OWN code still says so (it is not a wrong guess and is not counted)');
  }

  // --- per socket: 5 failures, then even a valid code is refused ------------------------------------------------------------------------
  {
    const s = await connect();
    const results = [];
    for (let i = 0; i < 5; i++) results.push((await guess(s)).error);
    ok(results.every((e) => e === JOIN_REFUSED_MESSAGE), 'socket: five wrong guesses each get the one message');
    const { code } = await makeChallenge();
    const blocked = await ask(s, 'join_challenge', { code });
    everyRefusal.add(blocked.error);
    ok(blocked.ok === false && blocked.error === JOIN_REFUSED_MESSAGE, 'socket: the 6th attempt is refused EVEN WITH A VALID CODE, with the same message');
    const fresh = await connect();
    const worked = await ask(fresh, 'join_challenge', { code });
    ok(worked.ok === true, 'socket: a different socket (same address, no account) joins the same valid code: the block is per socket');
  }

  // --- per user: 10 failures across sockets, then a new socket of the same account is refused ---------------------------------------------
  {
    const tag = randomBytes(4).toString('hex');
    const reg = await fetch(`${url}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: `jc${tag}`, email: `jc-${tag}@test.local`, password: randomBytes(12).toString('base64url') }) });
    assert.equal(reg.status, 201);
    const body = await reg.json();
    tracker.track({ userId: body.user.id });
    const s1 = await connect(body.token);
    const s2 = await connect(body.token);
    for (let i = 0; i < 5; i++) await guess(s1);
    for (let i = 0; i < 5; i++) await guess(s2);
    const { code } = await makeChallenge();
    const s3 = await connect(body.token);
    const refused = await ask(s3, 'join_challenge', { code });
    everyRefusal.add(refused.error);
    ok(refused.ok === false && refused.error === JOIN_REFUSED_MESSAGE, 'user: ten failures spread over two sockets (5 + 5, each inside its own socket limit) block a THIRD socket of the same account, even with a valid code');
    const guest = await connect();
    ok((await ask(guest, 'join_challenge', { code })).ok === true, 'user: an account-less socket is not affected by that account\'s block');
  }

  // --- per address: 30 failures from one address, then a new socket with a valid code is refused -----------------------------------------
  {
    // so far the loopback address has failed 5 (socket test) + 10 (user test) = 15 times: 3 more sockets of 5 reach 30 without any socket limit being hit
    for (let k = 0; k < 3; k++) {
      const s = await connect();
      for (let i = 0; i < 5; i++) await guess(s);
    }
    const { code } = await makeChallenge();
    const late = await connect();
    const refused = await ask(late, 'join_challenge', { code });
    everyRefusal.add(refused.error);
    ok(refused.ok === false && refused.error === JOIN_REFUSED_MESSAGE, 'address: 30 failures from one address block a brand-new, account-less socket with a VALID code');
  }

  // --- the address is the CLIENT's, behind a proxy: X-Forwarded-For from the right, never from the left -------------------------------------
  {
    // six sockets that all arrive through the "proxy" (loopback) and claim to be client 203.0.113.50: 30 failures from THAT address
    for (let k = 0; k < 6; k++) {
      const s = await connect(null, '203.0.113.50');
      for (let i = 0; i < 5; i++) await guess(s);
    }
    const { code } = await makeChallenge();
    const sameClient = await connect(null, '203.0.113.50');
    const refused = await ask(sameClient, 'join_challenge', { code });
    everyRefusal.add(refused.error);
    ok(refused.ok === false && refused.error === JOIN_REFUSED_MESSAGE, 'proxy: thirty failures from client 203.0.113.50 block a new socket of that client, even with a valid code');
    const spoofed = await connect(null, '203.0.113.99, 203.0.113.50'); // the client prepends a fake address; the proxy appended the real one
    const spoofRefused = await ask(spoofed, 'join_challenge', { code });
    everyRefusal.add(spoofRefused.error);
    ok(spoofRefused.ok === false, 'proxy: a client that writes its own X-Forwarded-For ("fake, real") is still counted as the REAL address - the rightmost entry - and stays blocked');
    const other = await connect(null, '203.0.113.51');
    const worked = await ask(other, 'join_challenge', { code });
    ok(worked.ok === true, 'proxy: a DIFFERENT client address (203.0.113.51) is not blocked by that client\'s failures and joins the valid code (the limit is per address, not global)');
  }

  // --- one message for every reason; no code in any log line -------------------------------------------------------------------------------
  ok(everyRefusal.size === 1 && [...everyRefusal][0] === JOIN_REFUSED_MESSAGE, `one message for every refusal (${everyRefusal.size} distinct text over ${counter + 3} refusals: a wrong code, a blocked socket, a blocked user, a blocked address)`);
  const malformed = await connect();
  const bad = await ask(malformed, 'join_challenge', undefined);
  ok(bad.ok === false && bad.error === JOIN_REFUSED_MESSAGE, 'a malformed payload gets the same message');
  const logText = lines.join('\n');
  const leaked = [...allCodes].filter((code) => logText.includes(code));
  ok(allCodes.size >= 30 && leaked.length === 0, `the server's log (${lines.length} lines) contains none of the ${allCodes.size} codes used - the wrong guesses and the valid ones`);
} finally {
  for (const s of sockets) s.disconnect();
  killTree(child);
  const cleanup = await tracker.cleanup();
  console.log(`  cleanup: ${cleanup.deleted} test account(s) deleted (${cleanup.remaining} left)`);
}

console.log(`\n${passed} checks passed`);
