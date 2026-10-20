/**
 * The client address on the HTTP side (src/lib/httpClientKey.ts, wired in src/index.ts): behind the platform's proxy every user used to share ONE counter in the global (600 / 15 min)
 * and the login / register (20 / 15 min) limiters, because they counted `req.ip` with no `trust proxy`. Now `app.set('trust proxy', <hops>)` (a NUMBER) and a key generator built
 * on the sockets' own rule (`clientIpOf`) count per CLIENT.
 *
 *   npm run test:trustProxy        (boots three servers of its own on free ports - hops 0, 1 and 2, NODE_ENV=development; the login limits are the REAL ones, no override;
 *                                   needs DATABASE_URL to be a local database only because the server process inherits it, no account is created)
 *
 * Part 1, in process: the two derivations agree - Express's `req.ip` and `clientIpOf` give the same address for the same proxy chain wherever Express's number is safe - and the two
 * edges where Express is looser are pinned (a public peer's header; fewer entries than hops), together with the IPv6 /56 key.
 * Part 2, real servers: per-address counting of the global and the login limiter behind 1 and 2 hops, a spoofed leftmost entry, 0 hops ignoring the header, and the diagnostic.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { killTree, portIsFree, sleep } from './e2e-browser/stack.mjs';
import { isLocalDatabaseUrl, resolveDatabaseUrl } from './lib/test-user-cleanup.mjs';
import { clientIpOf } from '../src/lib/clientIp.ts';
import { derivedClientIp, describeClientIp, limiterKeyOf } from '../src/lib/httpClientKey.ts';

let passed = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ok  ${message}`);
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------------------------------------------------------------------
// Part 1 - in process. A tiny express app with the same `trust proxy` setting; the TCP peer is chosen per request (a test-only header read by THIS file's own middleware) so that a
// public peer, which a real loopback test client cannot be, can be simulated.
// ---------------------------------------------------------------------------------------------------------------------------------------
async function withMiniApp(hops, fn) {
  const app = express();
  app.set('trust proxy', hops);
  app.use((req, _res, next) => {
    const fake = req.headers['x-test-peer'];
    if (typeof fake === 'string') Object.defineProperty(req.socket, 'remoteAddress', { value: fake, configurable: true });
    next();
  });
  app.get('/who', (req, res) => res.json({ expressIp: req.ip, derived: derivedClientIp(req, hops), sockets: clientIpOf({ peer: req.socket.remoteAddress ?? '', forwardedFor: req.headers['x-forwarded-for'] }, hops) }));
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const who = async (peer, forwardedFor) => (await fetch(`${base}/who`, { headers: { 'x-test-peer': peer, ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}) } })).json();
  try {
    await fn(who);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// Express's number-of-hops rule and clientIpOf agree wherever the chain is well-formed: a private peer, at least `hops` entries.
const chains = [
  { hops: 1, peer: '10.0.0.5', xff: '203.0.113.9', client: '203.0.113.9', label: '1 hop, one entry' },
  { hops: 1, peer: '10.0.0.5', xff: '9.9.9.9, 203.0.113.9', client: '203.0.113.9', label: '1 hop, a client-written leftmost entry (spoof) in front of the proxy\'s' },
  { hops: 1, peer: '10.0.0.5', xff: '1.1.1.1, 2.2.2.2, 203.0.113.9', client: '203.0.113.9', label: '1 hop, two client-written entries' },
  { hops: 2, peer: '10.0.0.5', xff: '203.0.113.9, 10.1.1.1', client: '203.0.113.9', label: '2 hops (CDN then proxy)' },
  { hops: 2, peer: '10.0.0.5', xff: '9.9.9.9, 203.0.113.9, 10.1.1.1', client: '203.0.113.9', label: '2 hops, a spoofed leftmost entry' },
  { hops: 0, peer: '10.0.0.5', xff: '203.0.113.9', client: '10.0.0.5', label: '0 hops: the header is ignored' },
  { hops: 0, peer: '10.0.0.5', xff: '9.9.9.9, 203.0.113.9', client: '10.0.0.5', label: '0 hops, several entries: still ignored' },
  { hops: 1, peer: '::ffff:10.0.0.5', xff: '203.0.113.9', client: '203.0.113.9', label: '1 hop, an IPv4-mapped IPv6 peer' },
  { hops: 1, peer: '::1', xff: '2001:db8::7', client: '2001:db8::7', label: '1 hop, an IPv6 client behind a loopback proxy' },
];
for (const chain of chains) {
  await withMiniApp(chain.hops, async (who) => {
    const got = await who(chain.peer, chain.xff);
    ok(got.expressIp === chain.client && got.derived === chain.client && got.sockets === chain.client, `same address for HTTP and sockets - ${chain.label}: Express ${got.expressIp}, HTTP key ${got.derived}, sockets ${got.sockets}`);
  });
}

// The two edges where Express's number is looser than the sockets' rule. The limiters (and the diagnostic) use the sockets' rule, so neither edge can be used to pick an address.
await withMiniApp(1, async (who) => {
  const got = await who('198.51.100.20', '9.9.9.9');
  ok(got.expressIp === '9.9.9.9', 'edge 1 (documents Express): a PUBLIC peer\'s X-Forwarded-For is believed by req.ip - a client that reaches the server directly could choose its address');
  ok(got.derived === '198.51.100.20' && got.sockets === '198.51.100.20', 'edge 1: the key the limiters use ignores that header and counts the public peer itself');
});
await withMiniApp(2, async (who) => {
  const got = await who('10.0.0.5', '203.0.113.9');
  ok(got.expressIp === '203.0.113.9', 'edge 2 (documents Express): with fewer entries than hops req.ip returns the leftmost entry');
  ok(got.derived === '10.0.0.5' && got.sockets === '10.0.0.5', 'edge 2: the key the limiters use falls back to the TCP peer (the sockets\' rule)');
});

// The key: IPv4 untouched, IPv6 collapsed to its /56.
ok(limiterKeyOf('203.0.113.9') === '203.0.113.9' && limiterKeyOf('203.0.113.10') === '203.0.113.10', 'key: IPv4 addresses are their own key and differ');
ok(limiterKeyOf('2001:db8:aaaa:bb00::1') === limiterKeyOf('2001:db8:aaaa:bbff:ffff::9'), 'key: two IPv6 addresses inside one /56 share a key (rotating inside a prefix does not dodge a limit)');
ok(limiterKeyOf('2001:db8:aaaa:bb00::1') !== limiterKeyOf('2001:db8:aaaa:bc00::1'), 'key: IPv6 addresses in different /56 prefixes do not');

// The diagnostic's shape and counts (the fake request carries only what the function reads).
{
  const req = (peer, forwardedFor) => ({ socket: { remoteAddress: peer }, headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor } });
  const d = describeClientIp(req('10.0.0.5', '203.0.113.9, 10.1.1.1'), 2);
  ok(JSON.stringify(Object.keys(d)) === JSON.stringify(['clientIp', 'xffEntries', 'peerIsPrivate', 'hops', 'clientIsPrivate', 'chain']), 'diagnostic: exactly the six keys clientIp, xffEntries, peerIsPrivate, hops, clientIsPrivate, chain');
  ok(d.clientIp === '203.0.113.9' && d.xffEntries === 2 && d.peerIsPrivate === true && d.hops === 2 && d.clientIsPrivate === false, 'diagnostic: 2 hops, 2 entries, private peer -> the client entry');
  ok(JSON.stringify(d.chain) === JSON.stringify(['public', 'private']), 'diagnostic: the chain names the KIND of each entry, left to right (public, private)');
  ok(JSON.stringify(describeClientIp(req('10.0.0.5', 'unknown, 203.0.113.9, fe80::1, 2001:db8::1, 10.1.1.1:8080'), 1).chain) === JSON.stringify(['invalid', 'public', 'private', 'public', 'invalid']), 'diagnostic: a name or an address with a port is "invalid", an IPv6 link-local is "private", a documentation IPv6 is "public"');
  ok(describeClientIp(req('10.0.0.5', Array.from({ length: 30 }, (_, i) => `198.51.100.${i + 1}`).join(', ')), 1).chain.length === 8, 'diagnostic: at most the last 8 entries are classified (a hostile 30-entry header cannot grow the answer)');
  // 22 public entries then 8 private ones: only the LAST eight (the platform's side) are shown, never the first eight (the client's side)
  const hostile = [...Array.from({ length: 22 }, (_, i) => `198.51.100.${i + 1}`), ...Array.from({ length: 8 }, (_, i) => `10.0.0.${i + 1}`)].join(', ');
  ok(describeClientIp(req('10.0.0.5', hostile), 1).chain.join() === 'private,private,private,private,private,private,private,private', 'diagnostic: the cap keeps the LAST entries - the platform\'s side of the chain - not the first');
  ok(describeClientIp(req('10.0.0.5', ' , 203.0.113.9,, 10.1.1.1 ,'), 1).chain.join() === 'public,private', 'diagnostic: empty entries between commas are skipped, not reported as invalid');
  ok(describeClientIp(req('10.0.0.5', ['203.0.113.9', '10.1.1.1, 10.2.2.2']), 1).chain.join() === 'public,private,private', 'diagnostic: a header delivered as an array is classified as one list');
  ok(describeClientIp(req('198.51.100.20'), 1).peerIsPrivate === false && describeClientIp(req('198.51.100.20'), 1).xffEntries === 0, 'diagnostic: a public peer is reported as not private; no header counts 0 entries');
  ok(describeClientIp(req('10.0.0.5', ' , ,'), 1).xffEntries === 0 && describeClientIp(req('10.0.0.5', 'a, ,b'), 1).xffEntries === 2, 'diagnostic: empty entries are not counted');
  ok(describeClientIp(req('10.0.0.5', ['1.1.1.1', '2.2.2.2, 3.3.3.3']), 1).xffEntries === 3, 'diagnostic: a header delivered as an array is counted as one list');
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Part 2 - real server processes.
// ---------------------------------------------------------------------------------------------------------------------------------------
const databaseUrl = resolveDatabaseUrl();
if (!isLocalDatabaseUrl(databaseUrl ?? '')) throw new Error('DATABASE_URL is not a local database: this test only runs against this machine');

async function withServer(hops, fn) {
  let port = 3600 + Math.floor(Math.random() * 300);
  while (!(await portIsFree(port))) port++;
  const lines = [];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AUTH_RATE')));
  Object.assign(env, { PORT: String(port), NODE_ENV: 'development', TRUSTED_PROXY_HOPS: String(hops) });
  const child = spawn(process.execPath, [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/index.ts'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)));
  const url = `http://127.0.0.1:${port}`;
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
    await fn({ url, lines });
  } finally {
    killTree(child);
  }
}

const get = (url, forwardedFor, extra = {}) => fetch(url, { headers: { ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}), ...extra } });
const login = (url, forwardedFor) => fetch(`${url}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}) }, body: '{}' });
/** Sends `n` login attempts from one claimed address and returns the status of the last. */
async function loginTimes(url, forwardedFor, n) {
  let status = 0;
  for (let i = 0; i < n; i++) status = (await login(url, forwardedFor)).status;
  return status;
}

// --- behind 1 hop -----------------------------------------------------------------------------------------------------------------------
await withServer(1, async ({ url, lines }) => {
  const mine = await (await get(`${url}/health/client-ip`, '203.0.113.50')).json();
  ok(mine.clientIp === '203.0.113.50' && mine.xffEntries === 1 && mine.peerIsPrivate === true && mine.hops === 1, `1 hop: the diagnostic reports the caller's own address (${JSON.stringify(mine)})`);
  const spoof = await (await get(`${url}/health/client-ip`, '9.9.9.9, 203.0.113.50')).json();
  ok(spoof.clientIp === '203.0.113.50' && spoof.xffEntries === 2, '1 hop: a spoofed leftmost entry is ignored by the diagnostic - the rightmost is the client');
  const none = await (await get(`${url}/health/client-ip`)).json();
  ok(none.xffEntries === 0 && none.clientIp === '127.0.0.1' && none.hops === 1, '1 hop: no header -> the TCP peer (loopback here) and 0 entries');

  // nothing is echoed: no other header, no log of the response
  const marker = 'zz-marker-header-value-zz';
  const res = await get(`${url}/health/client-ip`, '203.0.113.77', { 'x-marker': marker, authorization: `Bearer ${marker}`, cookie: `m=${marker}` });
  const text = await res.text();
  ok(!text.includes(marker) && Object.keys(JSON.parse(text)).length === 6, '1 hop: the diagnostic echoes no header (a marker sent in x-marker, authorization and cookie is not in the body) and has exactly six keys');
  await sleep(200);
  const log = lines.join('\n');
  ok(!log.includes(marker) && !log.includes('203.0.113.77') && !log.includes('"clientIp"'), '1 hop: the server log holds neither the response, nor the marker, nor the caller\'s address');

  // two addresses never share a counter - the global limiter (600 / 15 min), flooded through the diagnostic itself
  let last = 0;
  for (let i = 0; i < 600 - 6; i++) last = (await get(`${url}/health/client-ip`, '198.51.100.1')).status; // this address has made 0 so far
  ok(last === 200, 'global limiter: 594 requests from 198.51.100.1 are all answered');
  const stillOk = [];
  for (let i = 0; i < 6; i++) stillOk.push((await get(`${url}/health/client-ip`, '198.51.100.1')).status);
  ok(stillOk.every((s) => s === 200), 'global limiter: its 595th..600th requests are still answered (the limit is 600)');
  ok((await get(`${url}/health/client-ip`, '198.51.100.1')).status === 429, 'global limiter: the 601st request from ONE address is a 429 - the diagnostic is rate-limited by the global limiter');
  ok((await get(`${url}/health/client-ip`, '198.51.100.2')).status === 200, 'global limiter: a SECOND address is not blocked by the first one\'s requests (two addresses never share a counter)');
  ok((await get(`${url}/health/client-ip`, '9.9.9.9, 198.51.100.1')).status === 429, 'global limiter: a spoofed leftmost entry does not buy a fresh counter - the real (rightmost) address stays blocked');

  // the real login limit, 20 / 15 min, no override
  ok((await loginTimes(url, '203.0.113.60', 20)) !== 429, 'login limit: 20 attempts from ONE address are all answered (not 429)');
  ok((await login(url, '203.0.113.60')).status === 429, 'login limit: the 21st attempt from that address is a 429');
  ok((await login(url, '203.0.113.61')).status !== 429, 'login limit: a SECOND address is NOT blocked');
  ok((await login(url, '9.9.9.9, 203.0.113.60')).status === 429, 'login limit: a spoofed leftmost entry in front of the blocked address is still blocked');
  const body = await (await login(url, '203.0.113.60')).json();
  ok(body.error === 'Too many attempts. Please try again later.', 'login limit: the 429 carries the unchanged message');
});

// --- behind 2 hops ----------------------------------------------------------------------------------------------------------------------
await withServer(2, async ({ url }) => {
  const mine = await (await get(`${url}/health/client-ip`, '203.0.113.50, 10.9.9.9')).json();
  ok(mine.clientIp === '203.0.113.50' && mine.xffEntries === 2 && mine.hops === 2, `2 hops: the diagnostic reports the entry two places from the right (${JSON.stringify(mine)})`);
  const spoof = await (await get(`${url}/health/client-ip`, '9.9.9.9, 203.0.113.50, 10.9.9.9')).json();
  ok(spoof.clientIp === '203.0.113.50' && spoof.xffEntries === 3, '2 hops: a client-written leftmost entry is ignored');
  const short = await (await get(`${url}/health/client-ip`, '203.0.113.50')).json();
  ok(short.clientIp === '127.0.0.1' && short.xffEntries === 1, '2 hops: ONE entry is fewer than the hops -> the TCP peer (this is what a hop count that is too high looks like)');
  ok((await loginTimes(url, '203.0.113.60, 10.9.9.9', 20)) !== 429 && (await login(url, '203.0.113.60, 10.9.9.9')).status === 429, '2 hops: the 21st login attempt from one address is a 429');
  ok((await login(url, '203.0.113.61, 10.9.9.9')).status !== 429, '2 hops: a second address behind the same proxy is NOT blocked');
  ok((await login(url, '9.9.9.9, 203.0.113.60, 10.9.9.9')).status === 429, '2 hops: a spoofed leftmost entry is still counted as the real address');

  // Express's own req.ip would return the LEFTMOST entry when there are fewer entries than hops (edge 2 above), so a key built on it would let a client pick a fresh counter with
  // every request. The key the limiters use falls back to the TCP peer there: one counter for all of them, whatever address each request claims.
  let loginBlockedAt = -1;
  for (let i = 0; i < 40 && loginBlockedAt < 0; i++) if ((await login(url, `198.51.100.${i + 1}`)).status === 429) loginBlockedAt = i;
  ok(loginBlockedAt >= 1 && loginBlockedAt <= 20, `2 hops: login attempts that each claim a DIFFERENT single-entry address (fewer entries than hops) share the peer's counter and hit the 429 (at the ${loginBlockedAt + 1}th)`);
  let globalBlockedAt = -1;
  for (let i = 0; i < 700 && globalBlockedAt < 0; i++) if ((await get(`${url}/health/client-ip`, `192.0.2.${(i % 250) + 1}`)).status === 429) globalBlockedAt = i;
  ok(globalBlockedAt >= 300 && globalBlockedAt <= 600, `2 hops: the same for the global limiter - requests that each claim a different single-entry address share the peer's counter (429 at request ${globalBlockedAt + 1})`);
});

// --- the chain OBSERVED on Render (Command #22, 20/10/2026) ---------------------------------------------------------------------------------
// A request with no header of its own reached the server with THREE entries - the client, Cloudflare's edge (response headers `server: cloudflare`, `cf-ray`), and one of Render's own
// proxies (a 10.x address, different from request to request) - and a request that sent a header of its own had it kept on the LEFT, with the same three appended after it.
// With TRUSTED_PROXY_HOPS=1 the entry taken is therefore the last of the three: Render's own proxy, shared by every user (the failure this branch exists for). Three hops reach the client.
// (Entries 2 and 3 from the right are an inference from Cloudflare's and Render's documentation and from the count; the diagnostic's `chain` shows their KIND on the deployed server.)
{
  const chain = '198.51.100.20, 172.70.1.1, 10.25.239.2'; // client, Cloudflare edge, Render proxy
  const req = (forwardedFor) => ({ socket: { remoteAddress: '10.24.0.9' }, headers: { 'x-forwarded-for': forwardedFor } });
  const spoofs = ['', '203.0.113.7, ', '203.0.113.7, 198.51.100.9, ', '203.0.113.7, 10.9.9.9, 172.70.9.9, '];
  for (const spoof of spoofs) {
    const header = spoof + chain;
    const one = describeClientIp(req(header), 1);
    const three = describeClientIp(req(header), 3);
    ok(one.clientIp === '10.25.239.2' && one.clientIsPrivate === true, `Render chain, ${spoof ? `${spoof.split(',').length - 1} spoofed entr${spoof.split(',').length - 1 === 1 ? 'y' : 'ies'} in front` : 'no spoof'}, 1 hop: the answer is Render's own proxy - private, the same for every user (clientIsPrivate says so)`);
    ok(three.clientIp === '198.51.100.20' && three.clientIsPrivate === false && three.xffEntries === 3 + (spoof ? spoof.split(',').length - 1 : 0), `Render chain, ${spoof ? 'spoofed' : 'no spoof'}, 3 hops: the answer is the client, whatever the client wrote in front`);
    ok(derivedClientIp(req(header), 3) === '198.51.100.20' && !['203.0.113.7', '198.51.100.9', '10.9.9.9', '172.70.9.9'].includes(derivedClientIp(req(header), 3)), `Render chain, ${spoof ? 'spoofed' : 'no spoof'}, 3 hops: the key the limiters use is the client, never one of the entries the client wrote`);
  }
  const shown = describeClientIp(req(`203.0.113.7, ${chain}`), 3);
  ok(shown.chain.join() === 'public,public,public,private' && shown.hops === 3, 'Render chain: the diagnostic reads [public, public, public, private] for a spoofed request and [public, public, private] without (the last three are the platform\'s)');
  ok(describeClientIp(req(chain), 3).chain.join() === 'public,public,private', 'Render chain: with no spoof the chain is [public, public, private]');
  // too many hops: fewer entries than hops falls back to the TCP peer (private) - clientIsPrivate shows it
  const tooMany = describeClientIp(req('198.51.100.20, 10.25.239.2'), 3);
  ok(tooMany.clientIp === '10.24.0.9' && tooMany.clientIsPrivate === true, 'a hop count that is too HIGH falls back to the TCP peer, which is private: clientIsPrivate is true there too');
}
await withServer(3, async ({ url }) => {
  const client = '198.51.100.20';
  const chain = (extra = '') => `${extra}${client}, 172.70.1.1, 10.25.239.2`;
  const mine = await (await get(`${url}/health/client-ip`, chain())).json();
  ok(mine.clientIp === client && mine.xffEntries === 3 && mine.hops === 3 && mine.clientIsPrivate === false && mine.chain.join() === 'public,public,private', `3 hops, a real server: the client is entry 3 from the right (${JSON.stringify(mine)})`);
  const spoof = await (await get(`${url}/health/client-ip`, chain('203.0.113.7, 198.51.100.9, '))).json();
  ok(spoof.clientIp === client && spoof.xffEntries === 5, '3 hops: two spoofed entries in front change the count but not the client');
  ok((await loginTimes(url, chain(), 20)) !== 429 && (await login(url, chain())).status === 429, '3 hops: the 21st login attempt of ONE client is a 429');
  ok((await login(url, `198.51.100.21, 172.70.1.1, 10.25.239.2`)).status !== 429, '3 hops: a second client behind the same Cloudflare edge and the same Render proxy is NOT blocked');
  ok((await login(url, chain('9.9.9.9, 8.8.8.8, '))).status === 429, '3 hops: spoofed entries in front of a blocked client do not buy a fresh counter');
});

// --- 0 hops: the header is never read ----------------------------------------------------------------------------------------------------
await withServer(0, async ({ url }) => {
  const mine = await (await get(`${url}/health/client-ip`, '203.0.113.50')).json();
  ok(mine.clientIp === '127.0.0.1' && mine.xffEntries === 1 && mine.hops === 0, `0 hops: the diagnostic ignores the header and reports the TCP peer (${JSON.stringify(mine)})`);
  ok((await loginTimes(url, '203.0.113.60', 20)) !== 429, '0 hops: 20 attempts claiming one address are answered');
  ok((await login(url, '203.0.113.61')).status === 429, '0 hops: the 21st attempt is a 429 even though it CLAIMS a different address - the header does not choose a counter');
});

// --- the wiring, by source -----------------------------------------------------------------------------------------------------------------
{
  const index = fs.readFileSync(path.join(root, 'src', 'index.ts'), 'utf8');
  ok(index.includes('const trustedProxyHops = resolveTrustedHops();') && index.includes("app.set('trust proxy', trustedProxyHops);"), 'wiring: trust proxy is set from the same resolveTrustedHops() the sockets use');
  ok(!/trust proxy['"],\s*true/.test(index) && !/trust proxy['"],\s*['"]/.test(index), 'wiring: trust proxy is never `true` and never a string list');
  ok(/const globalLimiter = rateLimit\(\{[^}]*keyGenerator: httpKey,[^}]*\}\);/s.test(index) && index.includes('createAuthLimiter(process.env, console.warn, httpKey)'), 'wiring: both HTTP limiters are keyed by the shared key generator');
  ok(/app\.use\(globalLimiter\);[\s\S]*app\.get\('\/health\/client-ip'/.test(index), 'wiring: the diagnostic is registered after (behind) the global limiter');
  const key = fs.readFileSync(path.join(root, 'src', 'lib', 'httpClientKey.ts'), 'utf8');
  ok(key.includes('clientIpOf(') && !/req\.ip\b/.test(key.replace(/\/\*[\s\S]*?\*\//g, '')), 'wiring: the key is clientIpOf over the socket and the header - never req.ip');
  ok(!/console\./.test(key) && !/res\.|logger|log\(/.test(key), 'wiring: the diagnostic module logs nothing');
}

console.log(`\n${passed} checks passed`);
