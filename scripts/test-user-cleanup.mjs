/**
 * Tests for scripts/lib/test-user-cleanup.mjs - the cleanup that keeps the end-to-end scripts from littering a developer's database with the
 * accounts they register (test-tournament.mjs used to leave ~10 per run, ~570 piled up locally).
 *
 *   npm run test:userCleanup        (plain node, no server, no database: Prisma is a fake that records what it was asked to delete)
 *
 * Guarded: only the recorded ids are deleted (never a pattern), only against a local database URL (localhost / 127.0.0.1 / ::1; Neon, Render
 * or anything else is left alone and the skip is announced), nothing is opened when nobody was registered, a failing cleanup never throws,
 * and test-tournament.mjs runs it in a `finally` so it happens on failure too. The real-database behaviour (rows really gone, cascades) is
 * checked end to end by test-tournament.mjs itself in CI, which fails when any account it registered is still there.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { createUserTracker, isLocalDatabaseUrl, resolveDatabaseUrl } from './lib/test-user-cleanup.mjs';

let passed = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ok  ${message}`);
}

function fakePrisma({ failDelete = false, stubborn = [] } = {}) {
  const calls = { deleteMany: [], count: [], disconnects: 0 };
  const rows = new Set();
  return {
    calls,
    rows,
    client: {
      user: {
        async deleteMany(args) {
          calls.deleteMany.push(args);
          if (failDelete) throw new Error('connection refused');
          let count = 0;
          for (const id of args.where.id.in) if (!stubborn.includes(id) && rows.delete(id)) count++;
          return { count };
        },
        async count(args) {
          calls.count.push(args);
          return args.where.id.in.filter((id) => rows.has(id)).length;
        },
      },
      async $disconnect() {
        calls.disconnects++;
      },
    },
  };
}
const logs = () => {
  const lines = [];
  return { lines, log: (m) => lines.push(m) };
};
const LOCAL = 'postgresql://chess:chess@localhost:5432/chess_app';
const mask = (url) => String(url || '(empty)').replace(/:\/\/.*@/, '://***@');

console.log('which databases count as local');
for (const url of [LOCAL, 'postgresql://u:p@127.0.0.1:5432/db', 'postgresql://u:p@[::1]:5432/db']) ok(isLocalDatabaseUrl(url), `local: ${mask(url)}`);
for (const url of [
  'postgresql://u:p@ep-cool-123.eu-central-1.aws.neon.tech/neondb',
  'postgresql://u:p@dpg-abc.frankfurt-postgres.render.com/db',
  'postgresql://u:p@localhost.evil.example/db',
  'postgresql://u:p@db.internal:5432/db',
  '',
  undefined,
  'not a url',
]) ok(!isLocalDatabaseUrl(url), `NOT local: ${mask(url)}`);

console.log('where the database URL comes from (a plain terminal has nothing exported - the .env is what Prisma would use)');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-env-'));
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, 'JWT_SECRET="x"\r\nDATABASE_URL="postgresql://chess:pw@localhost:5432/chess_app"\r\nPORT=3000\r\n');
  ok(resolveDatabaseUrl({ DATABASE_URL: 'postgresql://e:e@127.0.0.1/e' }, envFile) === 'postgresql://e:e@127.0.0.1/e', 'the environment wins');
  ok(resolveDatabaseUrl({}, envFile) === 'postgresql://chess:pw@localhost:5432/chess_app', 'no env var: read DATABASE_URL from the .env (quotes and CRLF handled)');
  fs.writeFileSync(envFile, "DATABASE_URL='postgresql://u:p@ep-x.neon.tech/db'\nPORT=3000\n");
  ok(resolveDatabaseUrl({}, envFile) === 'postgresql://u:p@ep-x.neon.tech/db' && !isLocalDatabaseUrl(resolveDatabaseUrl({}, envFile)), 'a remote URL in the .env is read as remote (and so never cleaned)');
  fs.writeFileSync(envFile, 'PORT=3000\n');
  ok(resolveDatabaseUrl({}, envFile) === undefined, 'no DATABASE_URL anywhere: undefined');
  ok(resolveDatabaseUrl({}, path.join(dir, 'missing.env')) === undefined, 'no .env file: undefined, no throw');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('deleting exactly what was registered');
{
  const db = fakePrisma();
  ['a', 'b', 'c', 'bystander'].forEach((id) => db.rows.add(id));
  const { lines, log } = logs();
  const t = createUserTracker({ databaseUrl: LOCAL, getPrisma: async () => db.client, log });
  const u = { userId: 'a', username: 'alice' };
  ok(t.track(u) === u, 'track() returns the account unchanged');
  t.track({ userId: 'b' });
  t.track({ userId: 'c' });
  t.track(undefined);
  t.track({ username: 'no id' });
  ok(JSON.stringify(t.trackedIds) === '["a","b","c"]', 'only accounts with an id are recorded');
  const result = await t.cleanup();
  ok(result.deleted === 3 && result.remaining === 0 && !result.skipped, 'all three are deleted and verified gone');
  ok(JSON.stringify(db.calls.deleteMany) === JSON.stringify([{ where: { id: { in: ['a', 'b', 'c'] } } }]), 'the delete is by recorded id - no email / username pattern');
  ok(db.rows.has('bystander') && db.rows.size === 1, 'an account the run did not register is untouched');
  ok(db.calls.disconnects === 1, 'the connection is closed');
  ok(lines.length === 1 && /deleted 3 test account/.test(lines[0]), 'one summary line');
}

console.log('a row that survives is counted, so the test can fail on it');
{
  const db = fakePrisma({ stubborn: ['b'] });
  ['a', 'b'].forEach((id) => db.rows.add(id));
  const t = createUserTracker({ databaseUrl: LOCAL, getPrisma: async () => db.client, log: () => {} });
  t.track({ userId: 'a' });
  t.track({ userId: 'b' });
  const result = await t.cleanup();
  ok(result.deleted === 1 && result.remaining === 1 && !result.skipped, 'one deleted, one reported as left behind');
}

console.log('nothing registered: the database is never opened');
{
  let opened = 0;
  const t = createUserTracker({
    databaseUrl: LOCAL,
    getPrisma: async () => {
      opened++;
      return fakePrisma().client;
    },
    log: () => {},
  });
  const result = await t.cleanup();
  ok(result.deleted === 0 && result.remaining === 0 && opened === 0, 'no accounts -> no connection');
}

console.log('a non-local database is left alone');
for (const databaseUrl of ['postgresql://u:p@ep-x.neon.tech/neondb', undefined]) {
  const db = fakePrisma();
  db.rows.add('a');
  const { lines, log } = logs();
  const t = createUserTracker({ databaseUrl, getPrisma: async () => db.client, log });
  t.track({ userId: 'a' });
  const result = await t.cleanup();
  ok(result.skipped && result.deleted === 0 && db.calls.deleteMany.length === 0 && db.rows.has('a'), `${databaseUrl ? 'remote' : 'unset'} DATABASE_URL: nothing deleted, nothing opened`);
  ok(lines.some((l) => /cleanup skipped/.test(l)), '...and the skip is announced');
}

console.log('a failing cleanup never throws and says so');
{
  const db = fakePrisma({ failDelete: true });
  const { lines, log } = logs();
  const t = createUserTracker({ databaseUrl: LOCAL, getPrisma: async () => db.client, log });
  t.track({ userId: 'a' });
  const result = await t.cleanup();
  ok(result.skipped === 'error' && result.remaining === 1, 'the failure is reported, not thrown');
  ok(lines.some((l) => /cleanup FAILED.*connection refused/.test(l)), '...with the reason');
  ok(db.calls.disconnects === 1, '...and the connection is still closed');
  const broken = createUserTracker({ databaseUrl: LOCAL, getPrisma: async () => Promise.reject(new Error('cannot connect')), log: () => {} });
  broken.track({ userId: 'a' });
  ok((await broken.cleanup()).skipped === 'error', 'even failing to open the database is swallowed');
}

console.log('test-tournament.mjs: wired so it runs on failure too');
{
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-tournament.mjs'), 'utf8').split('\r\n').join('\n');
  ok(src.includes('return users.track({ userId: data.user.id'), 'every registered account is recorded');
  ok(src.includes('const databaseUrl = resolveDatabaseUrl();') && src.includes('PrismaClient({ datasources: { db: { url: databaseUrl } } })'), 'the checked URL is the one connected to (env or .env)');
  ok(/try \{\n {4}await run\(\);\n {2}\} catch \(err\) \{\n {4}failure = err;\n {2}\} finally \{\n[^]*await users\.cleanup\(\);/.test(src), 'cleanup is in the finally of the run, after a catch that keeps the failure');
  ok(src.includes('if (!failure && !cleaned.skipped && cleaned.remaining > 0) failure = new Error(`cleanup left ${cleaned.remaining} test account(s) behind`);'), 'an account that survives the cleanup fails the test');
  ok(!/process\.exit\(0\)[^]*await users\.cleanup/.test(src), 'no process.exit(0) before the cleanup');
  ok(!/deleteMany|endsWith/.test(src), 'the script itself deletes nothing by pattern');
}

console.log(`\nAll ${passed} checks passed.`);
