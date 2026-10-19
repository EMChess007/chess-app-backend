/**
 * The login / register rate limit (src/lib/authRateLimit.ts) and its TEST-ONLY override AUTH_RATE_LIMIT_TEST_OVERRIDE, over a real HTTP server: a tiny express app with the real
 * limiter on /auth, hit with real requests.
 *
 *   npm run test:authRateLimit        (plain tsx, no database, no game server)
 *
 * (a) default config: attempts 1-20 pass, the 21st is a 429 with the old message, and the whole answer sequence equals a limiter built from the ORIGINAL literal options;
 * (b) NODE_ENV=production + the override set: still the 21st attempt that gets the 429, and exactly one startup warning that does not print the value;
 * (c) NODE_ENV=test (and development) + the override set: the raised limit applies, and it is finite;
 * (d) the module reads only NODE_ENV and the override variable and logs no secret and no value; the wiring in index.ts and the places the variable may NOT appear.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import {
  AUTH_RATE_LIMIT_DEFAULT,
  AUTH_RATE_LIMIT_MESSAGE,
  AUTH_RATE_LIMIT_OVERRIDE_VAR,
  AUTH_RATE_LIMIT_TEST_CEILING,
  AUTH_RATE_LIMIT_WINDOW_MS,
  createAuthLimiter,
  resolveAuthRateLimit,
} from '../src/lib/authRateLimit.ts';

let passed = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ok  ${message}`);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

/** Serves `limiter` on /auth of a fresh express app (the way index.ts mounts it); returns the url and a stop function. */
async function serve(limiter) {
  const app = express();
  app.use('/auth', limiter, (_req, res) => res.json({ ok: true }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { url: `http://127.0.0.1:${server.address().port}/auth/login`, stop: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** `count` attempts in a row; what each one answered: status, body, the standard policy header. */
async function hit(url, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const res = await fetch(url, { method: 'POST' });
    // every header NAME the limiter adds (the legacy X-RateLimit-* ones included) and the values that do not depend on the clock
    const names = [...res.headers.keys()].filter((n) => !['date', 'ratelimit-reset', 'ratelimit', 'retry-after', 'etag', 'content-length'].includes(n)).sort();
    out.push({ status: res.status, body: await res.json(), policy: res.headers.get('ratelimit-policy'), limit: res.headers.get('ratelimit-limit'), names });
  }
  return out;
}

/** Everything logged while `fn` runs (console.warn / log / error / info), as one string. */
async function captureLogs(fn) {
  const lines = [];
  const saved = { warn: console.warn, log: console.log, error: console.error, info: console.info };
  for (const key of Object.keys(saved)) console[key] = (...args) => lines.push(args.map(String).join(' '));
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return lines;
}

// --- the pinned numbers ---------------------------------------------------------------------------------------------------------------
ok(AUTH_RATE_LIMIT_DEFAULT === 20 && AUTH_RATE_LIMIT_WINDOW_MS === 900000 && AUTH_RATE_LIMIT_TEST_CEILING === 1000, 'pinned: 20 attempts per 900000 ms, and a test ceiling of 1000');
ok(AUTH_RATE_LIMIT_MESSAGE === 'Too many attempts. Please try again later.' && AUTH_RATE_LIMIT_OVERRIDE_VAR === 'AUTH_RATE_LIMIT_TEST_OVERRIDE', 'pinned: the 429 message and the variable\'s name');

// --- (a) default config ---------------------------------------------------------------------------------------------------------------
{
  const mine = await serve(createAuthLimiter({}, () => assert.fail('no warning without the variable')));
  // the limiter exactly as src/index.ts built it before the override existed (verbatim literals)
  const original = await serve(rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Please try again later.' } }));
  const a = await hit(mine.url, 22);
  const b = await hit(original.url, 22);
  await mine.stop();
  await original.stop();
  ok(a.slice(0, 20).every((r) => r.status === 200), '(a) default config: attempts 1-20 are let through');
  ok(a[20].status === 429 && a[20].body.error === 'Too many attempts. Please try again later.', '(a) default config: the 21st attempt in the window gets 429 with the old message');
  ok(a[21].status === 429, '(a) and the 22nd too');
  ok(a[0].policy === '20;w=900' && a[0].limit === '20', '(a) the standard headers announce 20 per 900 s');
  ok(JSON.stringify(a) === JSON.stringify(b), '(a) all 22 answers (status, body, headers) equal those of a limiter built from the ORIGINAL literal options: same limit, window, keying and 429');
}

// --- (b) production: the override is ignored, one warning without the value -----------------------------------------------------------
{
  let limiter;
  const logs = await captureLogs(async () => {
    limiter = createAuthLimiter({ NODE_ENV: 'production', AUTH_RATE_LIMIT_TEST_OVERRIDE: '777' });
  });
  const s = await serve(limiter);
  const r = await hit(s.url, 22);
  await s.stop();
  ok(r.slice(0, 20).every((x) => x.status === 200) && r[20].status === 429 && r[21].status === 429, '(b) NODE_ENV=production + the override set: still exactly 20 let through, the 21st gets 429');
  ok(logs.length === 1 && logs[0].includes('AUTH_RATE_LIMIT_TEST_OVERRIDE') && logs[0].includes('production'), `(b) exactly one startup warning, naming the variable and production: ${logs[0]}`);
  ok(!logs.join('\n').includes('777'), '(b) the warning does not print the value');
  const warnings = [];
  ok(resolveAuthRateLimit({ NODE_ENV: 'production', AUTH_RATE_LIMIT_TEST_OVERRIDE: '1' }, (m) => warnings.push(m)) === 20 && warnings.length === 1, '(b) production + any value (even 1): 20, one warning');
  const none = [];
  ok(resolveAuthRateLimit({ NODE_ENV: 'production' }, (m) => none.push(m)) === 20 && none.length === 0, '(b) production without the variable: 20, no warning');
}

// --- (c) not production + the override: raised, finite ---------------------------------------------------------------------------------
for (const nodeEnv of ['test', 'development', undefined]) {
  const warnings = [];
  const limiter = createAuthLimiter({ NODE_ENV: nodeEnv, AUTH_RATE_LIMIT_TEST_OVERRIDE: '30' }, (m) => warnings.push(m));
  const s = await serve(limiter);
  const r = await hit(s.url, 32);
  await s.stop();
  ok(r.slice(0, 30).every((x) => x.status === 200) && r[30].status === 429 && r[31].status === 429, `(c) NODE_ENV=${nodeEnv}: the override raises the limit to 30 - attempt 21 passes, the 31st gets 429`);
  ok(warnings.length === 0 && r[0].limit === '30', `(c) NODE_ENV=${nodeEnv}: no warning, the headers say 30`);
}
ok(resolveAuthRateLimit({ NODE_ENV: 'test', AUTH_RATE_LIMIT_TEST_OVERRIDE: '1000' }) === 1000, '(c) the ceiling 1000 itself is honoured: the limit is a finite number');
const reference = [];
resolveAuthRateLimit({ NODE_ENV: 'test', AUTH_RATE_LIMIT_TEST_OVERRIDE: 'reference-value' }, (m) => reference.push(m));
for (const bad of ['', ' 500', '5e2', '0x10', '-5', '0', '1.5', '1001', '99999999', 'Infinity', 'off', 'false']) {
  const warnings = [];
  // the warning is one fixed sentence whatever the value was (so it cannot contain it)
  ok(resolveAuthRateLimit({ NODE_ENV: 'test', AUTH_RATE_LIMIT_TEST_OVERRIDE: bad }, (m) => warnings.push(m)) === 20 && warnings.length === 1 && warnings[0] === reference[0], `(c) "${bad}" cannot switch the limiter off or raise it past the ceiling: 20, one fixed warning that does not print the value`);
}
ok(resolveAuthRateLimit({ NODE_ENV: 'test', AUTH_RATE_LIMIT_MAX: '500' }) === 20, '(c) the earlier draft\'s variable name does nothing');

// --- (d) no secrets, and where the variable may and may not appear -----------------------------------------------------------------------
{
  const source = read('src/lib/authRateLimit.ts');
  const code = source.split('\n').filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('/**') && !line.trim().startsWith('//')).join('\n');
  const envReads = [...code.matchAll(/\benv\.([A-Za-z_]+)|\benv\[/g)].map((m) => m[1] ?? '[computed]');
  ok(JSON.stringify([...new Set(envReads)].sort()) === JSON.stringify(['AUTH_RATE_LIMIT_TEST_OVERRIDE', 'NODE_ENV']), `(d) the module reads exactly two variables: ${[...new Set(envReads)].join(', ')}`);
  ok((code.match(/process\.env/g) ?? []).length === 2 && !/JWT|SECRET|DATABASE|PASSWORD|TOKEN|KEY/i.test(code.replace(/AUTH_RATE_LIMIT_TEST_OVERRIDE/g, '')), '(d) process.env appears only as the two default parameters, and no secret-like name is mentioned');
  const secretLogs = await captureLogs(async () => {
    const env = { NODE_ENV: 'production', AUTH_RATE_LIMIT_TEST_OVERRIDE: '555', JWT_SECRET: 'jwt-secret-sentinel', DATABASE_URL: 'postgresql://u:db-password-sentinel@h/db', DATABASE_PASSWORD: 'pw-sentinel' };
    resolveAuthRateLimit(env);
    createAuthLimiter(env);
    createAuthLimiter({ ...env, NODE_ENV: 'test', AUTH_RATE_LIMIT_TEST_OVERRIDE: 'bad-555' });
  });
  const everything = secretLogs.join('\n');
  ok(secretLogs.length === 3 && !/sentinel|555|postgresql/.test(everything), '(d) with secrets in the environment the module logs three short warnings and none of them contains a secret or the override value');
}
{
  const index = read('src/index.ts');
  ok(/const authLimiter = createAuthLimiter\(\);/.test(index) && !/authLimiter = rateLimit/.test(index) && index.includes("app.use('/auth', authLimiter, authRouter);"), 'the wiring: index.ts mounts createAuthLimiter() on /auth and builds no limiter of its own');
  ok(!/AUTH_RATE_LIMIT/.test(index), 'index.ts itself mentions no override variable');
}
{
  // The variable is set by the browser end-to-end stack ONLY. Not in any config file, not in a workflow, not in the env example, not in anything Render could read.
  const allowed = new Set(['src/lib/authRateLimit.ts', 'scripts/test-auth-rate-limit.mjs', 'scripts/e2e-browser/stack.mjs', 'TESTING.md', 'CHECKLIST.md']);
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(ts|mjs|js|cjs|json|ya?ml|md|env|example|toml|sh|txt)$/.test(entry.name) || entry.name.startsWith('.env') || entry.name === 'Dockerfile') {
        if (fs.readFileSync(path.join(root, rel), 'utf8').includes('AUTH_RATE_LIMIT')) hits.push(rel);
      }
    }
  };
  walk('');
  const stray = hits.filter((rel) => !allowed.has(rel) && !rel.startsWith('.github/workflows/nightly.yml'));
  ok(stray.length === 0, `the variable appears nowhere but the module, its tests, the e2e stack and the docs (stray: ${stray.join(', ') || 'none'})`);
  ok(!fs.existsSync(path.join(root, 'render.yaml')) && !fs.existsSync(path.join(root, '..', 'render.yaml')), 'there is no render.yaml in either repo (Render\'s own environment cannot be read from here)');
  const stack = read('scripts/e2e-browser/stack.mjs');
  ok(/AUTH_RATE_LIMIT_TEST_OVERRIDE: '1000', NODE_ENV: 'development'/.test(stack), 'the e2e stack sets it to the finite 1000, together with NODE_ENV=development, for its own private backend only');
  const env = read('.env.example');
  ok(!/AUTH_RATE_LIMIT/.test(env), '.env.example does not mention it');
  for (const wf of ['ci.yml', 'nightly.yml']) ok(!/AUTH_RATE_LIMIT/.test(read(`.github/workflows/${wf}`)), `.github/workflows/${wf} does not set it (the e2e stack sets it for its own child process)`);
}

console.log(`\n${passed} checks passed`);
