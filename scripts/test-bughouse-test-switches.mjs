/**
 * The TEST-ONLY switch of the Bughouse server (src/game/bughouseTestSwitches.ts, W2), held to the rule of the login rate-limit override and of the 4-seat switches (CHECKLIST.md section 7):
 * BUGHOUSE_TEST_SEED seeds the bots and the seat shuffle. (Bughouse adds no other variable: its two timing overrides are the 4-seat games' FOUR_FILL_MS and FOUR_GRACE_MS, pinned in
 * test-bughouse-rooms.mjs section 0.)
 *
 *   npm run test:bughouseTestSwitches        (plain tsx; the last section boots the real server three times, on a free port each)
 *
 * (a) with the variable unset nothing is injected; (b) NODE_ENV=production + the variable set: ignored, ONE warning, no value - checked on a real production-mode process too; (c) outside
 * production the switch works, with a validated value, and a seeded server places the seats the same way twice; (d) the module reads only this variable and NODE_ENV and logs no secret
 * or value; the variable appears nowhere but the module, its test and the docs (in particular in no workflow, no .env.example and no deployment config).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import { BUGHOUSE_TEST_SEED_MAX, mulberry32, resolveBughouseTestSeed, seededBughouseDeps } from '../src/game/bughouseTestSwitches.ts';
import { killTree, portIsFree, sleep } from './e2e-browser/stack.mjs';

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
ok(BUGHOUSE_TEST_SEED_MAX === 2147483647, 'pinned: the seed ceiling is 2147483647');
{
  const w = warnings();
  ok(resolveBughouseTestSeed({}, w.warn) === null && w.list.length === 0, '(a) no variable: no seed, no warning');
  ok(JSON.stringify(seededBughouseDeps(null)) === '{}', '(a) no seed: nothing is injected (the deps are exactly {}) - real Math.random and the crypto shuffle, as in production');
}
{
  const w = warnings();
  ok(resolveBughouseTestSeed({ NODE_ENV: 'production', BUGHOUSE_TEST_SEED: '424242' }, w.warn) === null, '(b) NODE_ENV=production + the seed set: ignored');
  ok(w.list.length === 1 && w.list[0].includes('BUGHOUSE_TEST_SEED') && w.list[0].includes('production') && !w.list[0].includes('424242'), `(b) exactly one warning, naming the variable and production, not the value: ${w.list[0]}`);
}
for (const nodeEnv of ['test', 'development', undefined]) {
  const w = warnings();
  ok(resolveBughouseTestSeed({ NODE_ENV: nodeEnv, BUGHOUSE_TEST_SEED: '20261021' }, w.warn) === 20261021 && w.list.length === 0, `(c) NODE_ENV=${nodeEnv}: the seed is honoured, no warning`);
}
ok(resolveBughouseTestSeed({ NODE_ENV: 'test', BUGHOUSE_TEST_SEED: '1' }) === 1 && resolveBughouseTestSeed({ NODE_ENV: 'test', BUGHOUSE_TEST_SEED: '2147483647' }) === 2147483647, '(c) the bounds 1 and 2147483647 are honoured');
{
  const reference = warnings();
  resolveBughouseTestSeed({ NODE_ENV: 'test', BUGHOUSE_TEST_SEED: 'reference-value' }, reference.warn);
  ok(reference.list.length === 1 && reference.list[0].includes('BUGHOUSE_TEST_SEED') && !reference.list[0].includes('reference-value'), '(c) a bad value gets one warning that names the variable and not the value');
  for (const bad of ['', ' 5', '5e2', '0x10', '-5', '0', '1.5', '2147483648', '99999999999', 'abc', 'Infinity']) {
    const w = warnings();
    ok(resolveBughouseTestSeed({ NODE_ENV: 'test', BUGHOUSE_TEST_SEED: bad }, w.warn) === null && w.list.length === 1 && w.list[0] === reference.list[0], `(c) "${bad}" is no seed: ignored with one fixed warning that does not print it`);
  }
}
{
  // the seeded randomness: reproducible, and two separate streams
  const a = seededBughouseDeps(777);
  const b = seededBughouseDeps(777);
  const c = seededBughouseDeps(778);
  const draw = (deps) => [deps.roomOptions.botRng(), deps.roomOptions.botRng(), deps.matchmakerOptions.randomInt(4), deps.matchmakerOptions.randomInt(4), deps.matchmakerOptions.randomInt(3)];
  ok(JSON.stringify(draw(a)) === JSON.stringify(draw(b)), '(c) the same seed gives the same bot and shuffle draws');
  ok(JSON.stringify(draw(seededBughouseDeps(777))) !== JSON.stringify(draw(c)), '(c) another seed gives other draws');
  ok(Object.keys(a).sort().join() === 'matchmakerOptions,roomOptions' && Object.keys(a.roomOptions).join() === 'botRng' && Object.keys(a.matchmakerOptions).join() === 'randomInt', '(c) the seed injects exactly the bots\' stream and the shuffle source, nothing else');
  const shuffleDeps = seededBughouseDeps(9);
  const values = Array.from({ length: 200 }, () => shuffleDeps.matchmakerOptions.randomInt(4));
  ok(new Set(values).size === 4, '(c) over 200 draws the shuffle source reaches every value 0..3 (so a rounding-up mutant would show a 4)');
  ok(values.every((v) => Number.isInteger(v) && v >= 0 && v < 4), '(c) the shuffle source returns integers in [0, n)');
  const rng = mulberry32(1);
  ok(rng() === mulberry32(1)() && rng() !== rng(), 'mulberry32 is deterministic for a seed');
  const pinned = mulberry32(1);
  ok(pinned() === 0.6270739405881613 && pinned() === 0.002735721180215478 && pinned() === 0.5274470399599522 && mulberry32(20261020)() === 0.264247833751142, 'mulberry32 gives the reference values for seeds 1 and 20261020 (pinned as literals)');
  const s = seededBughouseDeps(31);
  const t = seededBughouseDeps(31);
  const shuffleDraw = s.matchmakerOptions.randomInt(1_000_000_000);
  const botDraw = Math.floor(t.roomOptions.botRng() * 1_000_000_000);
  ok(shuffleDraw !== botDraw, '(c) the bot and shuffle streams of one seed start differently (seed + 1, seed + 2)');
}

// --- (d) the module and where the variable may appear ------------------------------------------------------------------------------------
{
  const source = read('src/game/bughouseTestSwitches.ts');
  const code = source.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('/**') && !l.trim().startsWith('//')).join('\n');
  const reads = [...new Set([...code.matchAll(/\benv\.([A-Za-z_]+)/g)].map((m) => m[1]))].sort();
  ok(JSON.stringify(reads) === JSON.stringify(['BUGHOUSE_TEST_SEED', 'NODE_ENV']), `(d) the module reads exactly two variables: ${reads.join(', ')}`);
  ok(!/process\.env\b(?!\))/.test(code.replace(/env: Env = process\.env/g, '')) && !/JWT|SECRET|DATABASE|PASSWORD|TOKEN/i.test(code), '(d) process.env only as default parameters; no secret-like name');
  const index = read('src/index.ts');
  ok(/registerBughouseHandlers\(io, seededBughouseDeps\(resolveBughouseTestSeed\(\)\)\);/.test(index), 'the wiring: index.ts takes the deps from seededBughouseDeps(resolveBughouseTestSeed()) and adds nothing else');
  const config = read('src/game/bughouseConfig.ts');
  const configReads = [...new Set([...config.matchAll(/envMsOverride\(env, '([A-Z_]+)'/g)].map((m) => m[1]))].sort();
  ok(JSON.stringify(configReads) === JSON.stringify(['FOUR_FILL_MS', 'FOUR_GRACE_MS']) && !/BUGHOUSE_(FILL|GRACE)_MS/.test(config.replace(/\/\*[\s\S]*?\*\//g, '')), '(d) bughouseConfig.ts reads only the 4-seat games\' two existing overrides: Bughouse adds no timing variable');
  const allowed = new Set(['src/game/bughouseTestSwitches.ts', 'scripts/test-bughouse-test-switches.mjs', 'TESTING.md', 'CHECKLIST.md', 'AGENTS.md']);
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(ts|mjs|js|cjs|json|ya?ml|md|env|example|toml|sh|txt)$/.test(entry.name) || entry.name.startsWith('.env')) {
        if (fs.readFileSync(path.join(root, rel), 'utf8').includes('BUGHOUSE_TEST_SEED')) hits.push(rel);
      }
    }
  };
  walk('');
  const stray = hits.filter((rel) => !allowed.has(rel));
  ok(stray.length === 0, `(d) BUGHOUSE_TEST_SEED appears nowhere but the module, its test and the docs (stray: ${stray.join(', ') || 'none'})`);
  for (const wf of ['ci.yml', 'nightly.yml']) ok(!/BUGHOUSE_TEST_|BUGHOUSE_FILL|BUGHOUSE_GRACE/.test(read(`.github/workflows/${wf}`)), `.github/workflows/${wf} sets no Bughouse variable`);
  ok(!/BUGHOUSE_/.test(read('.env.example')), '.env.example does not mention them');
}

// --- (b) for real: a server process in production mode, and one in development mode --------------------------------------------------------
async function boot(extraEnv) {
  let port = 3300 + Math.floor(Math.random() * 400);
  while (!(await portIsFree(port))) port++;
  const lines = [];
  const env = { ...process.env, PORT: String(port), ...extraEnv };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  for (const key of ['BUGHOUSE_TEST_SEED', 'FOUR_TEST_SEED', 'FOUR_TEST_SETUP_ENDPOINT', 'AUTH_RATE_LIMIT_TEST_OVERRIDE', 'FOUR_FILL_MS', 'FOUR_GRACE_MS']) if (!(key in extraEnv)) delete env[key];
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

/** Two guests queue for Bughouse on `port` in a fixed order; resolves with the seats they were dealt. */
async function pairSeats(port) {
  const sockets = [io(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false }), io(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false })];
  await Promise.all(sockets.map((s) => new Promise((resolve, reject) => (s.once('connect', resolve), s.once('connect_error', reject)))));
  const found = sockets.map((s) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no bug_match_found')), 30_000);
    s.once('bug_match_found', (p) => (clearTimeout(timer), resolve(p)));
  }));
  for (const s of sockets) {
    const ack = await new Promise((resolve) => s.emit('bug_join_queue', { timeControl: { initialMs: 180000, incrementMs: 0 } }, resolve));
    assert.ok(ack.ok === true, `join refused: ${JSON.stringify(ack)}`);
  }
  const matches = await Promise.all(found);
  // end the match at once, so no room is left running on the server
  await new Promise((resolve) => sockets[0].emit('bug_resign', { roomId: matches[0].roomId }, resolve));
  sockets.forEach((s) => s.disconnect());
  return matches.map((m) => m.seat);
}

{
  const prod = await boot({ NODE_ENV: 'production', BUGHOUSE_TEST_SEED: '31337' });
  try {
    const mine = prod.lines.filter((l) => l.includes('BUGHOUSE_TEST_SEED'));
    ok(mine.length === 1 && mine[0].includes('production'), `(b) a REAL server started with NODE_ENV=production and the variable set logged exactly one warning at startup: ${mine[0]?.slice(0, 60)}`);
    ok(!prod.lines.some((l) => l.includes('31337')), '(b) ...and no line printed the value');
  } finally {
    prod.stop();
  }
  const plain = await boot({ NODE_ENV: 'development' });
  const seeded = [await boot({ NODE_ENV: 'development', BUGHOUSE_TEST_SEED: '31337', FOUR_FILL_MS: '1500' }), await boot({ NODE_ENV: 'development', BUGHOUSE_TEST_SEED: '31337', FOUR_FILL_MS: '1500' })];
  try {
    ok(!plain.lines.some((l) => l.includes('BUGHOUSE_')) && !seeded[0].lines.some((l) => l.includes('BUGHOUSE_TEST_SEED')), '(a)/(c) a development server with the variable (or without it) logs no warning about it');
    const first = await pairSeats(seeded[0].port);
    const second = await pairSeats(seeded[1].port);
    ok(first.length === 2 && first[0] !== first[1] && JSON.stringify(first) === JSON.stringify(second), `(c) two REAL servers with the same seed deal the same two players the same seats for the same join order (${first.join(' and ')}), through the real queue and the real handler`);
  } finally {
    plain.stop();
    seeded.forEach((s) => s.stop());
  }
}

console.log(`\n${passed} checks passed`);
