/**
 * Test-account cleanup for the end-to-end scripts that register REAL accounts through POST /auth/register (today only test-tournament.mjs;
 * every other script uses guests or in-process rooms and creates no rows).
 *
 * Why: each run of test-tournament.mjs created ~10 users + their games / tournaments and never removed them, so a developer's local Postgres
 * collected ~570 `@test.local` accounts (and their cascaded rows) until someone deleted them by hand. Now the script records the id of every
 * account it registers and, in a `finally`, deletes exactly those - on success AND on failure (cascades remove their games, tournaments they
 * created, participations and puzzle progress: see prisma/schema.prisma `onDelete: Cascade`).
 *
 * Safety: it deletes by the recorded ids only (never by an email pattern), and only when DATABASE_URL points at this machine (localhost /
 * 127.0.0.1 / ::1 - the dev database and the CI service container). Against any other database, or with BACKEND_URL pointing at a remote
 * server whose database this process cannot see, it leaves the rows alone and says so. A failing cleanup never hides the test's own error.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const defaultEnvFile = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');

/** @returns {boolean} true only for a URL whose host is this machine. */
export function isLocalDatabaseUrl(url) {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * The database URL this process would use: `DATABASE_URL` from the environment, else the one in backend/.env (what Prisma itself falls back to -
 * `node scripts/test-tournament.mjs` from a plain terminal has nothing exported, and without this the cleanup would silently never run for the
 * very developers it is for). Never logged: it contains the password.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [envFile] path of the .env to fall back to
 */
export function resolveDatabaseUrl(env = process.env, envFile = defaultEnvFile) {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  try {
    const match = /^\s*DATABASE_URL\s*=\s*(.*)$/m.exec(readFileSync(envFile, 'utf8'));
    return match ? match[1].trim().replace(/^(['"])(.*)\1$/, '$2') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {{ databaseUrl?: string, getPrisma: () => Promise<{ user: { deleteMany: Function, count: Function }, $disconnect: Function }>, log?: (m: string) => void }} options
 *   `getPrisma` is called lazily, only when there is something to delete (so a run that registered nobody never opens the database).
 */
export function createUserTracker({ databaseUrl, getPrisma, log = console.log }) {
  /** @type {string[]} */
  const ids = [];
  return {
    /** Records an account the test just registered; returns it unchanged so `const u = tracker.track(await registerUser(...))` reads naturally. */
    track(user) {
      if (user?.userId) ids.push(user.userId);
      return user;
    },
    get trackedIds() {
      return [...ids];
    },
    /** @returns {Promise<{ skipped?: string, deleted: number, remaining: number }>} never throws. */
    async cleanup() {
      if (ids.length === 0) return { deleted: 0, remaining: 0 };
      if (!isLocalDatabaseUrl(databaseUrl ?? '')) {
        const why = 'DATABASE_URL is not a local database - leaving the test accounts alone';
        log(`  (cleanup skipped: ${why}; ${ids.length} account(s) created)`);
        return { skipped: why, deleted: 0, remaining: ids.length };
      }
      let prisma;
      try {
        prisma = await getPrisma();
        const result = await prisma.user.deleteMany({ where: { id: { in: ids } } });
        const remaining = await prisma.user.count({ where: { id: { in: ids } } });
        log(`  cleanup: deleted ${result.count} test account(s) this run created (${remaining} left)`);
        return { deleted: result.count, remaining };
      } catch (err) {
        log(`  cleanup FAILED (test accounts left behind): ${err instanceof Error ? err.message : String(err)}`);
        return { skipped: 'error', deleted: 0, remaining: ids.length };
      } finally {
        try {
          await prisma?.$disconnect();
        } catch {
          /* nothing useful to do */
        }
      }
    },
  };
}
