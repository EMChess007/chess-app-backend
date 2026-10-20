/**
 * The attempt limiter behind the 2-player `join_challenge` (src/lib/attemptLimiter.ts, src/game/joinChallengeLimiter.ts) and the client-address derivation it keys on
 * (src/lib/clientIp.ts). Pure: an injectable clock everywhere, no sockets, no wall-clock time. The same module is reused by the Bughouse friend rooms later.
 *
 *   npm run test:attemptLimiter
 *
 * Every limit is checked AT its boundary (the last allowed attempt and the first refused one; one millisecond before and exactly at the end of a window or a cooldown), a
 * successful attempt is shown to count for nothing and reset nothing, a blocked scope is shown not to extend itself, and the source is scanned for the two things that must
 * never happen: the check coming after the lookup of the code, and a code reaching a log line. The wiring over real sockets is test-join-challenge-limit.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AttemptLimiter } from '../src/lib/attemptLimiter.ts';
import { clientIpOf, isPrivateAddress, normalizeAddress, resolveTrustedHops } from '../src/lib/clientIp.ts';
import { JOIN_CHALLENGE_SCOPES, JOIN_LIMITER_SWEEP_MS, JOIN_REFUSED_MESSAGE, createJoinChallengeLimiter } from '../src/game/joinChallengeLimiter.ts';

let passed = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ok  ${message}`);
}

const MIN = 60_000;
const clock = (start = 1_000_000) => {
  const c = { t: start, now: () => c.t, advance: (ms) => (c.t += ms) };
  return c;
};
/** One attempt of a caller that records failures: refused when blocked, else a failure is recorded. Returns what `check` said. */
const failOnce = (limiter, keys) => {
  const verdict = limiter.check(keys);
  if (verdict.allowed) limiter.recordFailure(keys);
  return verdict;
};

// --- the pinned numbers and the message -----------------------------------------------------------------------------------------------
ok(
  JSON.stringify(JOIN_CHALLENGE_SCOPES) ===
    JSON.stringify([
      { name: 'socket', maxFailures: 5, windowMs: 300000, cooldownMs: 300000 },
      { name: 'user', maxFailures: 10, windowMs: 900000, cooldownMs: 0 },
      { name: 'ip', maxFailures: 30, windowMs: 900000, cooldownMs: 0 },
    ]),
  'pinned as literals: 5 failures / 5 min + a 5 min cooldown per socket, 10 / 15 min per user, 30 / 15 min per address'
);
ok(JOIN_REFUSED_MESSAGE === 'That challenge code was not found or has expired.' && JOIN_LIMITER_SWEEP_MS === 300000, 'pinned: the ONE refusal message and the 5 minute sweep');

// --- the socket scope: 5 failures, then a 5-minute cooldown ----------------------------------------------------------------------------
{
  const c = clock();
  const limiter = createJoinChallengeLimiter(c.now);
  const keys = { socket: 'S1', user: null, ip: null };
  ok(limiter.check(keys).allowed, 'a socket that never failed is allowed');
  for (let i = 1; i <= 4; i++) ok(failOnce(limiter, keys).allowed, `socket: failure ${i} is let through`);
  ok(limiter.check(keys).allowed, 'socket: after 4 failures the next attempt is still allowed');
  ok(failOnce(limiter, keys).allowed, 'socket: the 5th failure is let through (and recorded)');
  const sixth = limiter.check(keys);
  ok(!sixth.allowed && sixth.retryAfterMs === 5 * MIN, 'socket: the 6th attempt is REFUSED, with the full 5 minute cooldown ahead');
  c.advance(5 * MIN - 1);
  const edge = limiter.check(keys);
  ok(!edge.allowed && edge.retryAfterMs === 1, 'socket: one millisecond before the cooldown ends it is still refused (1 ms left)');
  c.advance(1);
  ok(limiter.check(keys).allowed, 'socket: exactly when the cooldown ends the attempt is allowed');
  for (let i = 1; i <= 4; i++) ok(failOnce(limiter, keys).allowed, `socket: after the cooldown the history is clear - failure ${i} of a new run is let through`);
  ok(failOnce(limiter, keys).allowed && !limiter.check(keys).allowed, 'socket: and the 5th failure of the new run blocks again');
}
{
  // the window of the socket scope: a failure stops counting exactly 5 minutes after it happened
  const c = clock();
  const limiter = createJoinChallengeLimiter(c.now);
  const keys = { socket: 'S2' };
  for (let i = 0; i < 4; i++) failOnce(limiter, keys);
  c.advance(5 * MIN - 1);
  failOnce(limiter, keys); // the 4 old ones are still inside the window: this is the 5th
  ok(!limiter.check(keys).allowed, 'socket: failures 299,999 ms apart still count together: 5 -> blocked');
  const c2 = clock();
  const l2 = createJoinChallengeLimiter(c2.now);
  for (let i = 0; i < 4; i++) failOnce(l2, keys);
  c2.advance(5 * MIN);
  failOnce(l2, keys);
  ok(l2.check(keys).allowed, 'socket: failures exactly 300,000 ms apart do NOT count together: the old four have left the window, so 1 failure -> allowed');
}

// --- the user scope: 10 failures per 15 minutes (a sliding limit) ---------------------------------------------------------------------
{
  const c = clock();
  const limiter = createJoinChallengeLimiter(c.now);
  const start = c.t;
  for (let i = 0; i < 10; i++) {
    ok(failOnce(limiter, { socket: `S${i}`, user: 'U1', ip: null }).allowed, i === 0 ? 'user: failure 1 (each on a fresh socket) is let through' : `user: failure ${i + 1} is let through`);
    c.advance(1000);
  }
  const eleventh = limiter.check({ socket: 'S-new', user: 'U1', ip: null });
  ok(!eleventh.allowed, 'user: the 11th attempt of a user is REFUSED even on a brand-new socket');
  ok(eleventh.retryAfterMs === start + 15 * MIN - c.t, 'user: it may try again when the OLDEST failure leaves the window (a sliding limit)');
  c.t = start + 15 * MIN - 1;
  ok(!limiter.check({ socket: 'S-new', user: 'U1', ip: null }).allowed, 'user: one millisecond before the oldest failure leaves the window it is still refused');
  c.t = start + 15 * MIN;
  ok(limiter.check({ socket: 'S-new', user: 'U1', ip: null }).allowed, 'user: exactly 15 minutes after the oldest failure it is allowed again (9 failures remain)');
  ok(failOnce(limiter, { socket: 'S-new', user: 'U1', ip: null }).allowed && !limiter.check({ socket: 'S-new', user: 'U1', ip: null }).allowed, 'user: one more failure and it is blocked again (back to 10 in the window)');
  ok(limiter.check({ socket: 'S-other', user: 'U2', ip: null }).allowed, 'user: another user is not affected');
}

// --- the address scope: 30 failures per 15 minutes ------------------------------------------------------------------------------------
{
  const c = clock();
  const limiter = createJoinChallengeLimiter(c.now);
  const start = c.t;
  let allLetThrough = true;
  for (let i = 0; i < 30; i++) allLetThrough = failOnce(limiter, { socket: `S${i}`, user: `U${i}`, ip: '203.0.113.7' }).allowed && allLetThrough;
  ok(allLetThrough, 'address: 30 failures (a different socket and user each time) are all let through');
  ok(limiter.check({ socket: 'S-29b', user: 'U-29b', ip: '203.0.113.7' }).allowed === false, 'address: the very next attempt is already refused - the 30th failure was the last one allowed');
  ok(!limiter.check({ socket: 'S-x', user: 'U-x', ip: '203.0.113.7' }).allowed, 'address: the 31st attempt from the same address is REFUSED whatever the socket and the user');
  ok(limiter.check({ socket: 'S-x', user: 'U-x', ip: '203.0.113.8' }).allowed, 'address: another address is not affected');
  c.t = start + 15 * MIN - 1;
  ok(!limiter.check({ socket: 'S-x', user: 'U-x', ip: '203.0.113.7' }).allowed, 'address: 1 ms before the first failure leaves the window it is still refused');
  c.t = start + 15 * MIN;
  ok(limiter.check({ socket: 'S-x', user: 'U-x', ip: '203.0.113.7' }).allowed, 'address: exactly 15 minutes after the first failure it is allowed again');
}

// --- successes count for nothing and reset nothing; a block does not extend itself -----------------------------------------------------
{
  const c = clock();
  const limiter = createJoinChallengeLimiter(c.now);
  const keys = { socket: 'S9', user: 'U9', ip: '198.51.100.1' };
  for (let i = 0; i < 4; i++) failOnce(limiter, keys);
  for (let i = 0; i < 1000; i++) assert.ok(limiter.check(keys).allowed); // a thousand SUCCESSFUL attempts: checked, nothing recorded
  passed++;
  console.log('  ok  successes: a thousand successful attempts (checked, never recorded) do not block anybody');
  ok(failOnce(limiter, keys).allowed && !limiter.check(keys).allowed, 'successes reset nothing: 4 failures, any number of successes, 1 more failure = 5 failures = blocked (an attacker cannot wipe his count with a valid code of his own)');
}
{
  const c = clock();
  const limiter = createJoinChallengeLimiter(c.now);
  const keys = { socket: 'S10' };
  for (let i = 0; i < 5; i++) failOnce(limiter, keys);
  const first = limiter.check(keys);
  c.advance(2 * MIN);
  for (let i = 0; i < 50; i++) {
    limiter.check(keys);
    limiter.recordFailure(keys); // even a caller that records while blocked must not extend the block
  }
  const later = limiter.check(keys);
  ok(first.retryAfterMs === 5 * MIN && later.retryAfterMs === 3 * MIN, 'a blocked scope does not extend itself: 2 minutes in, 3 minutes are left however often it is hammered');
}

// --- the module as a module (it is shared): configs other than the shipped ones, and an independent reference model ---------------------
{
  // a failure spread over time: the cooldown of the 5-failure scope starts at the FIFTH failure, not at the first
  const c = clock();
  const limiter = createJoinChallengeLimiter(c.now);
  const keys = { socket: 'spread' };
  for (let i = 0; i < 5; i++) {
    failOnce(limiter, keys);
    if (i < 4) c.advance(MIN);
  }
  const blocked = limiter.check(keys);
  ok(!blocked.allowed && blocked.retryAfterMs === 5 * MIN, 'cooldown: five failures a minute apart: the cooldown runs from the FIFTH failure (a full 5 minutes ahead), not from the first');
}
{
  // a cooldown SHORTER than the window (the shipped scopes have them equal): the history must be cleared when the cooldown ends, or the next failure would block again at once
  const c = clock();
  const limiter = new AttemptLimiter([{ name: 'k', maxFailures: 2, windowMs: 10_000, cooldownMs: 1_000 }], c.now);
  failOnce(limiter, { k: 'a' });
  c.advance(10);
  failOnce(limiter, { k: 'a' });
  const t2 = c.t;
  ok(!limiter.check({ k: 'a' }).allowed, 'cooldown shorter than the window: two failures block');
  c.t = t2 + 1_000 - 1;
  ok(!limiter.check({ k: 'a' }).allowed, 'cooldown shorter than the window: 1 ms before the cooldown ends it is refused');
  c.t = t2 + 1_000;
  ok(limiter.check({ k: 'a' }).allowed, 'cooldown shorter than the window: exactly when it ends the attempt is allowed');
  ok(failOnce(limiter, { k: 'a' }).allowed && limiter.check({ k: 'a' }).allowed, 'cooldown shorter than the window: the history was CLEARED - ONE new failure does not block (the two old failures are still inside the 10 s window)');
  ok(failOnce(limiter, { k: 'a' }).allowed && !limiter.check({ k: 'a' }).allowed, 'cooldown shorter than the window: the second new failure blocks again');
}
{
  // an independent, naive reference model (it keeps every failure time and recomputes) against the module, over seeded random sequences of attempts and time
  class Model {
    constructor(scopes, now) {
      this.scopes = scopes;
      this.now = now;
      this.s = Object.fromEntries(scopes.map((sc) => [sc.name, new Map()]));
    }
    live(scope, state, t) {
      return state.times.filter((x) => x > t - scope.windowMs);
    }
    check(keys) {
      const t = this.now();
      let wait = 0;
      for (const scope of this.scopes) {
        const key = keys[scope.name];
        if (key == null) continue;
        const state = this.s[scope.name].get(key);
        if (!state) continue;
        let w = 0;
        if (scope.cooldownMs > 0) w = state.blockedUntil > t ? state.blockedUntil - t : 0;
        else {
          const live = this.live(scope, state, t);
          if (live.length >= scope.maxFailures) w = live[live.length - scope.maxFailures] + scope.windowMs - t;
        }
        wait = Math.max(wait, w);
      }
      return wait > 0 ? { allowed: false, retryAfterMs: wait } : { allowed: true };
    }
    fail(keys) {
      const t = this.now();
      for (const scope of this.scopes) {
        const key = keys[scope.name];
        if (key == null) continue;
        let state = this.s[scope.name].get(key);
        if (!state) this.s[scope.name].set(key, (state = { times: [], blockedUntil: 0 }));
        if (scope.cooldownMs > 0 && state.blockedUntil > 0 && t >= state.blockedUntil) {
          state.times = [];
          state.blockedUntil = 0;
        }
        const live = this.live(scope, state, t);
        const blocked = scope.cooldownMs > 0 ? state.blockedUntil > t : live.length >= scope.maxFailures;
        if (blocked) continue;
        state.times = [...live, t];
        if (scope.cooldownMs > 0 && state.times.length >= scope.maxFailures) state.blockedUntil = t + scope.cooldownMs;
      }
    }
  }
  let seed = 12345;
  const rnd = (n) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % n;
  };
  let steps = 0;
  let blockedSeen = 0;
  let mismatches = 0;
  for (let run = 0; run < 400; run++) {
    const scopes = [
      { name: 'a', maxFailures: 1 + rnd(4), windowMs: 50 + rnd(150), cooldownMs: rnd(2) === 0 ? 0 : 20 + rnd(300) },
      { name: 'b', maxFailures: 1 + rnd(5), windowMs: 50 + rnd(250), cooldownMs: rnd(3) === 0 ? 0 : 20 + rnd(100) },
    ];
    const c = clock(1000);
    const limiter = new AttemptLimiter(scopes, c.now);
    const model = new Model(scopes, c.now);
    for (let op = 0; op < 80; op++) {
      c.advance(rnd(4) === 0 ? 0 : rnd(70));
      const keys = { a: ['x', 'y', null][rnd(3)], b: ['p', 'q'][rnd(2)] };
      const got = limiter.check(keys);
      const want = model.check(keys);
      steps++;
      if (!got.allowed) blockedSeen++;
      if (got.allowed !== want.allowed || (!got.allowed && got.retryAfterMs !== want.retryAfterMs)) mismatches++;
      if (got.allowed && rnd(3) !== 0) {
        limiter.recordFailure(keys);
        model.fail(keys);
      } else if (!got.allowed && rnd(5) === 0) {
        limiter.recordFailure(keys); // a caller that records while blocked
        model.fail(keys);
      }
    }
  }
  ok(mismatches === 0 && steps === 400 * 80 && blockedSeen > 2000, `reference model: ${steps} seeded random checks over 400 random two-scope configs (cooldowns shorter and longer than the window, sliding scopes, null keys, recording while blocked) - the module and the naive model agree on every verdict and every wait (${blockedSeen} of them refusals)`);
}

// --- when several scopes are blocked the caller is told the LONGEST wait, and every scope counts every failure ------------------------------
{
  const c = clock();
  const limiter = createJoinChallengeLimiter(c.now);
  for (let i = 0; i < 10; i++) failOnce(limiter, { socket: `Q${i}`, user: 'long', ip: null }); // the user scope is full (sliding, 15 minutes)
  for (let i = 0; i < 5; i++) failOnce(limiter, { socket: 'short', user: null, ip: null }); // a socket in its 5 minute cooldown
  const both = limiter.check({ socket: 'short', user: 'long', ip: null });
  ok(!both.allowed && both.retryAfterMs === 15 * MIN, 'several blocked scopes: the answer carries the LONGEST wait (the user scope, 15 minutes), not the shortest (the socket cooldown, 5 minutes)');
  const l2 = createJoinChallengeLimiter(clock().now);
  l2.recordFailure({ socket: 'X', user: 'Y', ip: 'Z' });
  ok(l2.size() === 3, 'one failure is remembered in EVERY scope whose key is given (socket, user and address: 3 keys)');
}

// --- independence, null keys, the sweep ---------------------------------------------------------------------------------------------
{
  const c = clock();
  const limiter = createJoinChallengeLimiter(c.now);
  for (let i = 0; i < 6; i++) failOnce(limiter, { socket: 'A', user: null, ip: null });
  ok(!limiter.check({ socket: 'A', user: null, ip: null }).allowed && limiter.check({ socket: 'B', user: null, ip: null }).allowed, 'scopes are independent: socket A blocked, socket B (no shared user or address) allowed');
  ok(limiter.check({ socket: 'B', user: null, ip: null }).allowed && limiter.size() === 1, 'a null key skips its scope: only the socket scope remembers anything (1 key)');
  ok(limiter.check({}).allowed, 'no keys at all: always allowed');
}
{
  const c = clock();
  const limiter = createJoinChallengeLimiter(c.now);
  for (let i = 0; i < 5; i++) failOnce(limiter, { socket: 'blocked', user: 'u', ip: 'a' });
  failOnce(limiter, { socket: 'one', user: null, ip: null });
  c.advance(5 * MIN - 1);
  ok(limiter.sweep() === 0 && limiter.size() === 4, 'sweep: 1 ms before the 5 minute window / cooldown ends nothing is dropped (4 keys: the blocked socket, the user, the address and the lone socket)');
  c.advance(1);
  ok(limiter.sweep() === 2 && limiter.size() === 2, 'sweep: exactly 5 minutes on, the lone socket (its failure left the window) and the blocked socket (its cooldown ended) are dropped; the user and the address (15 minute windows) are kept');
  c.advance(10 * MIN);
  ok(limiter.sweep() === 2 && limiter.size() === 0, 'sweep: at 15 minutes everything has left its window, and nothing is remembered');
}

// --- the client address: nothing a client can write is trusted -----------------------------------------------------------------------
ok(clientIpOf({ peer: '10.0.0.5', forwardedFor: '203.0.113.9' }, 1) === '203.0.113.9', 'address: behind a private proxy with 1 trusted hop, the entry the proxy appended is the client');
ok(clientIpOf({ peer: '10.0.0.5', forwardedFor: '9.9.9.9, 203.0.113.9' }, 1) === '203.0.113.9', 'address: a client that sends its own X-Forwarded-For cannot choose its address - the RIGHTMOST entry is taken, never the leftmost');
ok(clientIpOf({ peer: '10.0.0.5', forwardedFor: '203.0.113.9, 10.1.1.1' }, 2) === '203.0.113.9', 'address: with 2 trusted proxies the entry two places from the right');
ok(clientIpOf({ peer: '10.0.0.5', forwardedFor: '203.0.113.9' }, 2) === '10.0.0.5', 'address: fewer entries than trusted hops -> the TCP peer');
ok(clientIpOf({ peer: '10.0.0.5', forwardedFor: '203.0.113.9' }, 0) === '10.0.0.5', 'address: 0 trusted hops -> the TCP peer, the header is never read');
ok(clientIpOf({ peer: '198.51.100.20', forwardedFor: '9.9.9.9' }, 1) === '198.51.100.20', 'address: a PUBLIC peer is not behind our proxy: its X-Forwarded-For is ignored (a direct client cannot choose its address)');
ok(clientIpOf({ peer: '10.0.0.5' }, 1) === '10.0.0.5' && clientIpOf({ peer: '10.0.0.5', forwardedFor: '' }, 1) === '10.0.0.5', 'address: no header -> the TCP peer');
ok(clientIpOf({ peer: '10.0.0.5', forwardedFor: 'unknown, not-an-ip' }, 1) === '10.0.0.5', 'address: a header with no valid address -> the TCP peer');
ok(clientIpOf({ peer: '10.0.0.5', forwardedFor: ['9.9.9.9', '203.0.113.9'] }, 1) === '203.0.113.9', 'address: a header delivered as an array is joined first');
ok(clientIpOf({ peer: '::ffff:10.0.0.5', forwardedFor: '203.0.113.9' }, 1) === '203.0.113.9' && clientIpOf({ peer: '::ffff:198.51.100.20', forwardedFor: '9.9.9.9' }, 1) === '198.51.100.20', 'address: an IPv4-mapped IPv6 peer is normalised before it is judged private or public');
ok(clientIpOf({ peer: '::1', forwardedFor: '2001:db8::7' }, 1) === '2001:db8::7', 'address: an IPv6 client behind a loopback proxy');
ok(normalizeAddress(' ::FFFF:1.2.3.4 ') === '1.2.3.4' && normalizeAddress('2001:DB8::1') === '2001:db8::1', 'address: normalisation lower-cases and unmaps');
const privates = ['10.0.0.1', '10.255.255.255', '127.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1', '100.64.0.1', '100.127.255.255', '::1', 'fd00::1', 'fc00::1', 'fe80::1', 'fe90::1', 'fea0::1', 'febf::1'];
const publics = ['8.8.8.8', '172.15.255.255', '172.32.0.1', '192.169.0.1', '11.0.0.1', '100.63.255.255', '100.128.0.1', '169.253.0.1', '2001:db8::1', '2606:4700::1', 'fe7f::1', 'fec0::1', 'fb00::1', 'fe::1', '', 'garbage'];
ok(privates.every((a) => isPrivateAddress(a)), `address: private ranges recognised (${privates.length} samples, both edges of 172.16/12 and 100.64/10)`);
ok(publics.every((a) => !isPrivateAddress(a)), `address: public and malformed addresses are not private (${publics.length} samples, one step outside each range)`);
ok(resolveTrustedHops({ NODE_ENV: 'production' }) === 1 && resolveTrustedHops({ NODE_ENV: 'development' }) === 0 && resolveTrustedHops({}) === 0, 'hops: default 1 in production, 0 elsewhere');
ok(resolveTrustedHops({ NODE_ENV: 'production', TRUSTED_PROXY_HOPS: '2' }) === 2 && resolveTrustedHops({ NODE_ENV: 'production', TRUSTED_PROXY_HOPS: '0' }) === 0 && resolveTrustedHops({ TRUSTED_PROXY_HOPS: '5' }) === 5, 'hops: TRUSTED_PROXY_HOPS 0..5 overrides');
ok(['6', '-1', '1.5', ' 1', '', 'x', '10'].every((bad) => resolveTrustedHops({ NODE_ENV: 'production', TRUSTED_PROXY_HOPS: bad }) === 1), 'hops: anything else is ignored (production falls back to 1)');

// --- the wiring and the logs: scanned in the source ---------------------------------------------------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, '..', rel), 'utf8').replace(/\r\n/g, '\n');
{
  const handlers = read('src/game/socketHandlers.ts');
  const start = handlers.indexOf("socket.on('join_challenge'");
  const end = handlers.indexOf("socket.on('list_active_games'");
  const region = handlers.slice(start, end);
  ok(start > 0 && end > start, 'wiring: the join_challenge handler was found');
  const checkAt = region.indexOf('joinLimiter.check(attemptKeys)');
  const findAt = region.indexOf('challenges.find(code)');
  ok(checkAt > 0 && findAt > checkAt, 'wiring: the limiter is consulted BEFORE the code is looked up');
  ok(/if \(!challenge\) \{\s*joinLimiter\.recordFailure\(attemptKeys\);[^}]*JOIN_REFUSED_MESSAGE/.test(region), 'wiring: a code that is not found records a failure and answers the one message');
  ok(handlers.includes('setInterval(() => joinLimiter.sweep(), JOIN_LIMITER_SWEEP_MS).unref();'), 'wiring: the limiter is swept on an interval that is unref\'d (memory stays bounded; the interval never keeps the process alive)');
  ok(handlers.includes('const trustedProxyHops = resolveTrustedHops();') && region.includes("trustedProxyHops)"), 'wiring: the hop count comes from resolveTrustedHops() and is passed to clientIpOf');
  ok((region.match(/joinLimiter\.recordFailure/g) ?? []).length === 1, 'wiring: a failure is recorded in exactly one place, and a successful join records nothing');
  ok(/if \(!joinLimiter\.check\(attemptKeys\)\.allowed\) \{\s*ack\?\.\(\{ ok: false, error: JOIN_REFUSED_MESSAGE \}\);\s*return;/.test(region), 'wiring: a blocked attempt answers the same message as a wrong code');
  ok(!/not found or has expired/.test(handlers) && !/not found or has expired/.test(read('src/game/challenges.ts')), 'the refusal sentence exists once, in joinChallengeLimiter.ts, and nowhere else');
  const files = ['src/lib/attemptLimiter.ts', 'src/lib/clientIp.ts', 'src/game/joinChallengeLimiter.ts'];
  ok(files.every((f) => !/console\./.test(read(f))), 'logs: the limiter, the address derivation and the limits file contain no console call at all');
  const logLines = region.split('\n').filter((line) => /console\./.test(line));
  ok(logLines.length === 0, 'logs: the join_challenge handler writes no log line (so a code can never reach one)');
  ok(!/\bcode\b/.test(read('src/lib/attemptLimiter.ts').split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/**')).join('\n')), 'the limiter never handles a code: the word does not occur in its code');
}

console.log(`\n${passed} checks passed`);
