/**
 * The two TEST-ONLY switches of the 4-seat server (src/game/fourTestSwitches.ts, Chaturaji W5), held to the rule of the login rate-limit override (CHECKLIST.md section 7):
 * a seed for the bots (FOUR_TEST_SEED) and an endpoint that arms a start position (FOUR_TEST_SETUP_ENDPOINT=enabled).
 *
 *   npm run test:fourTestSwitches        (plain tsx; the last section boots the real server twice, on a free port each, against the local database)
 *
 * (a) with neither variable set nothing is injected and no route exists; (b) NODE_ENV=production + the variable set: ignored, ONE warning, no value - checked on a real production-mode
 * process too; (c) outside production the switch works, with a validated value; (d) the module reads only these two variables and NODE_ENV and logs no secret or value; the room really
 * starts from an armed snapshot and from nothing else; the variables appear nowhere but the module, its tests, the e2e stack and the docs.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { io } from 'socket.io-client';
import {
  FOUR_TEST_SEED_MAX,
  FourStartSnapshots,
  createFourTestSetupRouter,
  mulberry32,
  resolveFourTestSeed,
  resolveFourTestSetup,
  seededFourDeps,
} from '../src/game/fourTestSwitches.ts';
import { FourRoomManager } from '../src/game/fourPlayerRooms.ts';
import { CHATURAJI_RULES, FFA_RULES, initialState, serialize, stateFromPieces } from '../src/game/fourPlayer/index.ts';
import { killTree, portIsFree, sleep } from './e2e-browser/stack.mjs';
import { stubIo } from './fourplayer-test-kit.mjs';

let passed = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ok  ${message}`);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const warnings = () => {
  const list = [];
  return { list, warn: (m) => list.push(m) };
};

// --- (a)/(b)/(c) the seed ----------------------------------------------------------------------------------------------------------------
ok(FOUR_TEST_SEED_MAX === 2147483647, 'pinned: the seed ceiling is 2147483647');
{
  const w = warnings();
  ok(resolveFourTestSeed({}, w.warn) === null && w.list.length === 0, '(a) no variable: no seed, no warning');
  ok(JSON.stringify(seededFourDeps(null)) === '{}', '(a) no seed: nothing is injected (the deps are exactly {}) - real Math.random and the crypto shuffle, as in production');
}
{
  const w = warnings();
  ok(resolveFourTestSeed({ NODE_ENV: 'production', FOUR_TEST_SEED: '424242' }, w.warn) === null, '(b) NODE_ENV=production + the seed set: ignored');
  ok(w.list.length === 1 && w.list[0].includes('FOUR_TEST_SEED') && w.list[0].includes('production') && !w.list[0].includes('424242'), `(b) exactly one warning, naming the variable and production, not the value: ${w.list[0]}`);
}
for (const nodeEnv of ['test', 'development', undefined]) {
  const w = warnings();
  ok(resolveFourTestSeed({ NODE_ENV: nodeEnv, FOUR_TEST_SEED: '20261020' }, w.warn) === 20261020 && w.list.length === 0, `(c) NODE_ENV=${nodeEnv}: the seed is honoured, no warning`);
}
ok(resolveFourTestSeed({ NODE_ENV: 'test', FOUR_TEST_SEED: '1' }) === 1 && resolveFourTestSeed({ NODE_ENV: 'test', FOUR_TEST_SEED: '2147483647' }) === 2147483647, '(c) the bounds 1 and 2147483647 are honoured');
{
  const reference = warnings();
  resolveFourTestSeed({ NODE_ENV: 'test', FOUR_TEST_SEED: 'reference-value' }, reference.warn);
  for (const bad of ['', ' 5', '5e2', '0x10', '-5', '0', '1.5', '2147483648', '99999999999', 'abc', 'Infinity']) {
    const w = warnings();
    ok(resolveFourTestSeed({ NODE_ENV: 'test', FOUR_TEST_SEED: bad }, w.warn) === null && w.list.length === 1 && w.list[0] === reference.list[0], `(c) "${bad}" is no seed: ignored with one fixed warning that does not print it`);
  }
}
{
  // the seeded randomness: reproducible, and three separate streams
  const a = seededFourDeps(777);
  const b = seededFourDeps(777);
  const c = seededFourDeps(778);
  const draw = (deps) => [deps.roomOptions.rng(), deps.roomOptions.rng(), deps.roomOptions.botRng(), deps.roomOptions.botRng(), deps.matchmakerOptions.randomInt(4), deps.matchmakerOptions.randomInt(4), deps.matchmakerOptions.randomInt(3)];
  ok(JSON.stringify(draw(a)) === JSON.stringify(draw(b)), '(c) the same seed gives the same engine, bot and shuffle draws');
  ok(JSON.stringify(draw(seededFourDeps(777))) !== JSON.stringify(draw(c)), '(c) another seed gives other draws');
  const deps = seededFourDeps(5);
  ok(deps.roomOptions.rng() !== deps.roomOptions.botRng() || deps.roomOptions.rng() !== deps.roomOptions.botRng(), '(c) the engine and the bots draw from separate streams (a bot\'s decision never shifts the engine\'s)');
  const shuffleDeps = seededFourDeps(9);
  const values = Array.from({ length: 200 }, () => shuffleDeps.matchmakerOptions.randomInt(4));
  ok(new Set(values).size === 4, '(c) over 200 draws the shuffle source reaches every value 0..3 (so a rounding-up mutant would show a 4)');
  ok(values.every((v) => Number.isInteger(v) && v >= 0 && v < 4), '(c) the shuffle source returns integers in [0, n)');
  const rng = mulberry32(1);
  ok(rng() === mulberry32(1)() && rng() !== rng(), 'mulberry32 is deterministic for a seed');
  // pinned values (computed once from the reference mulberry32): a changed constant would still be "deterministic", so the values themselves are the test
  const pinned = mulberry32(1);
  ok(pinned() === 0.6270739405881613 && pinned() === 0.002735721180215478 && pinned() === 0.5274470399599522 && mulberry32(20261020)() === 0.264247833751142, 'mulberry32 gives the reference values for seeds 1 and 20261020 (pinned as literals)');
  // the three streams are really three: the shuffle's first draws differ from the bots' and the engine's for the same seed
  const s = seededFourDeps(31);
  const t = seededFourDeps(31);
  const shuffleDraw = s.matchmakerOptions.randomInt(1_000_000_000);
  const botDraw = Math.floor(t.roomOptions.botRng() * 1_000_000_000);
  const engineDraw = Math.floor(seededFourDeps(31).roomOptions.rng() * 1_000_000_000);
  ok(shuffleDraw !== botDraw && shuffleDraw !== engineDraw && botDraw !== engineDraw, '(c) the engine, bot and shuffle streams of one seed start differently (seed, seed + 1, seed + 2)');
}

// --- (a)/(b)/(c) the setup endpoint's switch --------------------------------------------------------------------------------------------
{
  const w = warnings();
  ok(resolveFourTestSetup({}, w.warn) === false && w.list.length === 0, '(a) no variable: the endpoint is not mounted, no warning');
  const p = warnings();
  ok(resolveFourTestSetup({ NODE_ENV: 'production', FOUR_TEST_SETUP_ENDPOINT: 'enabled' }, p.warn) === false, '(b) NODE_ENV=production + the variable set: not mounted');
  ok(p.list.length === 1 && p.list[0].includes('FOUR_TEST_SETUP_ENDPOINT') && p.list[0].includes('production'), `(b) exactly one warning naming the variable and production: ${p.list[0]}`);
  const q = warnings();
  ok(resolveFourTestSetup({ NODE_ENV: 'production', FOUR_TEST_SETUP_ENDPOINT: 'secret-sentinel' }, q.warn) === false && q.list.length === 1 && !q.list[0].includes('secret-sentinel'), '(b) production + a different value: not mounted, the warning does not print the value');
  for (const nodeEnv of ['test', 'development', undefined]) {
    const c = warnings();
    ok(resolveFourTestSetup({ NODE_ENV: nodeEnv, FOUR_TEST_SETUP_ENDPOINT: 'enabled' }, c.warn) === true && c.list.length === 0, `(c) NODE_ENV=${nodeEnv}: "enabled" mounts it, no warning`);
  }
  const reference = warnings();
  resolveFourTestSetup({ NODE_ENV: 'test', FOUR_TEST_SETUP_ENDPOINT: 'reference-value' }, reference.warn);
  for (const bad of ['', '1', 'true', 'ENABLED', ' enabled', 'yes']) {
    const c = warnings();
    ok(resolveFourTestSetup({ NODE_ENV: 'test', FOUR_TEST_SETUP_ENDPOINT: bad }, c.warn) === false && c.list.length === 1 && c.list[0] === reference.list[0], `(c) "${bad}" is not the opt-in: not mounted, one fixed warning that does not print it`);
  }
}

// --- the router over real HTTP ----------------------------------------------------------------------------------------------------------
const START = serialize(initialState(CHATURAJI_RULES));
const FFA_START = serialize(initialState(FFA_RULES));
const PROMO = serialize(stateFromPieces(['rK@a1', 'bK@a8', 'yK@h8', 'gK@h1', 'rP@c7'], { rules: CHATURAJI_RULES }));
async function withRouter(fn, { remote } = {}) {
  const snapshots = new FourStartSnapshots();
  const app = express();
  app.use(express.json());
  if (remote) app.use((req, _res, next) => (Object.defineProperty(req.socket, 'remoteAddress', { value: remote, configurable: true }), next()));
  app.use('/test-setup', createFourTestSetupRouter(snapshots));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}/test-setup/four-start`;
  try {
    await fn(url, snapshots);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
}
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
await withRouter(async (url, snapshots) => {
  const res = await post(url, { variant: 'chaturaji', snapshot: PROMO });
  ok(res.status === 200 && snapshots.has('chaturaji') && !snapshots.has('ffa'), '(c) a live Chaturaji snapshot is armed for Chaturaji only');
  ok(snapshots.take('chaturaji') === PROMO && snapshots.take('chaturaji') === undefined, '(c) it is consumed by ONE room: the next one gets nothing');
  for (const [name, body] of [
    ['a garbage snapshot', { variant: 'chaturaji', snapshot: 'not a position' }],
    ['a snapshot of another variant\'s board', { variant: 'chaturaji', snapshot: serialize(initialState(CHATURAJI_RULES)).slice(0, 40) }],
    ['an unknown variant (with a snapshot that is valid for the default rules)', { variant: 'bughouse', snapshot: FFA_START }],
    ['a position that is already over', { variant: 'chaturaji', snapshot: `${PROMO.slice(0, PROMO.lastIndexOf(' '))} 0:elimination` }],
    ['a snapshot that parses but is not written canonically (a trailing space)', { variant: 'chaturaji', snapshot: `${PROMO} ` }],
    ['no snapshot', { variant: 'chaturaji' }],
    ['a non-string snapshot', { variant: 'chaturaji', snapshot: 5 }],
  ]) {
    const bad = await post(url, body);
    ok(bad.status === 400 && !snapshots.has('chaturaji'), `(c) ${name}: 400, nothing armed`);
  }
});
await withRouter(async (url, snapshots) => {
  const res = await post(url, { variant: 'chaturaji', snapshot: PROMO });
  ok(res.status === 403 && !snapshots.has('chaturaji'), '(c) a caller that is not on loopback is refused (403) and nothing is armed');
}, { remote: '10.0.0.5' });

// --- the room starts from an armed snapshot, and from nothing else ----------------------------------------------------------------------
{
  const io = stubIo(); // real timers: every timer a room arms is cleared below, so nothing is left running
  const mgr = new FourRoomManager(io);
  const seats = [0, 1, 2, 3].map((i) => ({ kind: 'human', socketId: `S${i}`, name: `P${i}` }));
  const tc = { initialSeconds: 600, incrementSeconds: 0 };
  const armed = mgr.createRoom({ seats, timeControl: tc, variant: 'chaturaji', startSnapshot: PROMO });
  ok(serialize(mgr.rooms.get(armed.roomId).state) === PROMO, 'a room created with a start snapshot holds exactly that position');
  const seats2 = [0, 1, 2, 3].map((i) => ({ kind: 'human', socketId: `T${i}`, name: `Q${i}` }));
  const plain = mgr.createRoom({ seats: seats2, timeControl: tc, variant: 'chaturaji' });
  ok(serialize(mgr.rooms.get(plain.roomId).state) === START, 'a room created without one holds the standard position (the default is untouched)');
  for (const id of [armed.roomId, plain.roomId]) {
    const room = mgr.rooms.get(id);
    for (const t of [room.clockTimer, room.botTimer, room.allGoneTimer]) if (t) clearTimeout(t);
    room.status = 'finished';
    mgr.rooms.delete(id);
  }
  const throws = (() => {
    try {
      mgr.createRoom({ seats: [0, 1, 2, 3].map((i) => ({ kind: 'human', socketId: `U${i}`, name: `R${i}` })), timeControl: tc, variant: 'chaturaji', startSnapshot: 'garbage' });
      return false;
    } catch {
      return true;
    }
  })();
  ok(throws, 'a snapshot that does not parse is refused by the room manager too (the endpoint validates first; this is the second line of defence)');
}

// --- (d) the module and where the variables may appear -----------------------------------------------------------------------------------
{
  const source = read('src/game/fourTestSwitches.ts');
  const code = source.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('/**') && !l.trim().startsWith('//')).join('\n');
  const reads = [...new Set([...code.matchAll(/\benv\.([A-Za-z_]+)/g)].map((m) => m[1]))].sort();
  ok(JSON.stringify(reads) === JSON.stringify(['FOUR_TEST_SEED', 'FOUR_TEST_SETUP_ENDPOINT', 'NODE_ENV']), `(d) the module reads exactly three variables: ${reads.join(', ')}`);
  ok(!/process\.env\b(?!\))/.test(code.replace(/env: Env = process\.env/g, '')) && !/JWT|SECRET|DATABASE|PASSWORD|TOKEN/i.test(code), '(d) process.env only as default parameters; no secret-like name');
  const index = read('src/index.ts');
  ok(/if \(fourTestSetup\) app\.use\('\/test-setup', createFourTestSetupRouter\(fourStartSnapshots\)\);/.test(index), 'the wiring: the router is mounted only inside `if (fourTestSetup)`');
  ok(index.includes('...(fourTestSetup ? { startSnapshotFor:') && index.includes('...seededFourDeps(fourTestSeed)'), 'the wiring: the snapshot hook exists only when the endpoint is enabled; the seed deps come from seededFourDeps');
  const allowed = new Set(['src/game/fourTestSwitches.ts', 'scripts/test-four-test-switches.mjs', 'scripts/e2e-browser/stack.mjs', 'TESTING.md', 'CHECKLIST.md', 'AGENTS.md']);
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(ts|mjs|js|cjs|json|ya?ml|md|env|example|toml|sh|txt)$/.test(entry.name) || entry.name.startsWith('.env')) {
        const text = fs.readFileSync(path.join(root, rel), 'utf8');
        if (text.includes('FOUR_TEST_SEED') || text.includes('FOUR_TEST_SETUP_ENDPOINT')) hits.push(rel);
      }
    }
  };
  walk('');
  const stray = hits.filter((rel) => !allowed.has(rel));
  ok(stray.length === 0, `(d) the variables appear nowhere but the module, its test, the e2e stack and the docs (stray: ${stray.join(', ') || 'none'})`);
  const stack = read('scripts/e2e-browser/stack.mjs');
  ok(/FOUR_TEST_SEED: String\(/.test(stack) && /FOUR_TEST_SETUP_ENDPOINT: 'enabled'/.test(stack) && /NODE_ENV: 'development'/.test(stack), 'the e2e stack sets them, with NODE_ENV=development, for its own private backend only');
  for (const wf of ['ci.yml', 'nightly.yml']) ok(!/FOUR_TEST_/.test(read(`.github/workflows/${wf}`)), `.github/workflows/${wf} does not set them`);
  ok(!/FOUR_TEST_/.test(read('.env.example')), '.env.example does not mention them');
}

// --- (b) for real: a server process in production mode, and one in development mode --------------------------------------------------------
async function boot(extraEnv) {
  let port = 3300 + Math.floor(Math.random() * 400);
  while (!(await portIsFree(port))) port++;
  const lines = [];
  const env = { ...process.env, PORT: String(port), ...extraEnv };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  for (const key of ['FOUR_TEST_SEED', 'FOUR_TEST_SETUP_ENDPOINT', 'AUTH_RATE_LIMIT_TEST_OVERRIDE']) if (!(key in extraEnv)) delete env[key];
  const child = spawn(process.execPath, [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/index.ts'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)));
  for (let i = 0; i < 240; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return { port, lines, stop: () => killTree(child) };
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  killTree(child);
  throw new Error(`the server did not come up: ${lines.slice(-5).join(' | ')}`);
}
{
  const secretLike = 'prod-sentinel-123456';
  const prod = await boot({ NODE_ENV: 'production', FOUR_TEST_SEED: '31337', FOUR_TEST_SETUP_ENDPOINT: 'enabled', AUTH_RATE_LIMIT_TEST_OVERRIDE: '900' });
  try {
    const res = await post(`http://127.0.0.1:${prod.port}/test-setup/four-start`, { variant: 'chaturaji', snapshot: PROMO });
    ok(res.status === 404, '(b) a REAL server started with NODE_ENV=production and both variables set: POST /test-setup/four-start is a 404 (the route does not exist)');
    const mine = prod.lines.filter((l) => l.includes('FOUR_TEST_SEED') || l.includes('FOUR_TEST_SETUP_ENDPOINT'));
    ok(mine.length === 2 && mine.every((l) => l.includes('production')), `(b) ...and it logged exactly one warning per variable at startup: ${mine.map((l) => l.slice(0, 40)).join(' / ')}`);
    ok(prod.lines.filter((l) => l.includes('AUTH_RATE_LIMIT_TEST_OVERRIDE')).length === 1, '(b) ...and the login rate-limit override\'s own single warning still fires (16a)');
    ok(!prod.lines.some((l) => l.includes('31337') || l.includes('900 ') || l.includes(secretLike)), '(b) ...and no warning prints a value');
    const flood = [];
    for (let i = 0; i < 22; i++) flood.push((await fetch(`http://127.0.0.1:${prod.port}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'nobody@test.local', password: 'x' }) })).status);
    ok(flood[20] === 429 && flood[21] === 429 && flood.slice(0, 20).every((s) => s !== 429), '(b) ...and the REAL production-mode server answers the 21st login attempt with 429 despite the override variable');
  } finally {
    prod.stop();
  }
  const dev = await boot({ NODE_ENV: 'development', FOUR_TEST_SEED: '31337', FOUR_TEST_SETUP_ENDPOINT: 'enabled', FOUR_FILL_MS: '1500' });
  try {
    const res = await post(`http://127.0.0.1:${dev.port}/test-setup/four-start`, { variant: 'chaturaji', snapshot: PROMO });
    ok(res.status === 200, '(c) a REAL server started with NODE_ENV=development and the variable: the endpoint exists and arms a position');
    ok(!dev.lines.some((l) => l.includes('FOUR_TEST_')), '(c) ...with no warning');
    // the armed position reaches a real room through the real queue, once: two players queue, the bots fill, and four_match_found carries the constructed snapshot; the next pair gets the standard one
    const pairStart = async (label) => {
      const sockets = [io(`http://127.0.0.1:${dev.port}`, { transports: ['websocket'], reconnection: false }), io(`http://127.0.0.1:${dev.port}`, { transports: ['websocket'], reconnection: false })];
      const found = sockets.map((s) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label}: no four_match_found`)), 60_000);
        s.once('four_match_found', (p) => (clearTimeout(timer), resolve(p)));
      }));
      await Promise.all(sockets.map((s) => new Promise((resolve, reject) => (s.once('connect', resolve), s.once('connect_error', reject)))));
      for (const s of sockets) s.emit('four_join_queue', { timeControl: { initialSeconds: 600, incrementSeconds: 0 }, timeControlLabel: '10 min', variant: 'chaturaji' });
      const matches = await Promise.all(found);
      sockets.forEach((s) => s.disconnect());
      return matches[0];
    };
    const first = await pairStart('first pair');
    ok(first.variant === 'chaturaji' && first.state === PROMO, '(c) the first Chaturaji room made after arming starts from exactly the armed snapshot (through the real queue and the real handler hook)');
    const second = await pairStart('second pair');
    ok(second.state === START, '(c) ...and the next one starts from the standard position: the snapshot was consumed by one room');
  } finally {
    dev.stop();
  }
}
{
  const bare = await boot({ NODE_ENV: 'development' });
  try {
    const res = await post(`http://127.0.0.1:${bare.port}/test-setup/four-start`, { variant: 'chaturaji', snapshot: PROMO });
    ok(res.status === 404 && !bare.lines.some((l) => l.includes('FOUR_TEST_')), '(a) a REAL server with neither variable: no route (404), no warning');
  } finally {
    bare.stop();
  }
}

console.log(`\n${passed} checks passed`);
