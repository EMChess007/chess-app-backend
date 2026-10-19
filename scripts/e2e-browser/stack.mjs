/**
 * The PRIVATE online stack of the browser end-to-end tests (Chaturaji W4): our own backend on a free port, our own static build of the app pointed at it, and test
 * accounts that are deleted again. Nothing here ever touches the developer's backend (port 3000), their Expo (8081 / 8082) or the deployed backend.
 *
 * Safety, in the order it is enforced:
 *   - the ports 3000, 8081, 8082 are refused outright, and every port must be free before anything is started;
 *   - the database must be on this machine (the tracker below refuses to delete anywhere else; the stack refuses to start against another one);
 *   - only processes this module spawned are ever killed, by the PID it holds (and their children), and the web build's backend URL is passed through
 *     EXPO_PUBLIC_API_URL, never edited into the source;
 *   - no password, token or connection string is printed or written anywhere: accounts get random passwords that live in memory.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUserTracker, isLocalDatabaseUrl, resolveDatabaseUrl } from '../lib/test-user-cleanup.mjs';

const BACKEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FRONTEND = join(BACKEND, '..');
const FORBIDDEN_PORTS = new Set([3000, 8081, 8082]);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolves when `port` can be listened on (and frees it again). */
export function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '0.0.0.0', () => probe.close(() => resolve(true)));
  });
}

async function assertPort(name, port) {
  if (FORBIDDEN_PORTS.has(port)) throw new Error(`${name} port ${port} is reserved (the developer's own servers); pick another`);
  if (!(await portIsFree(port))) throw new Error(`${name} port ${port} is already in use; pick a free one`);
}

/** Kills a process this module started, with its children: `taskkill /T` on Windows, the process group elsewhere. */
export function killTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
}

async function waitFor(what, test, timeoutMs, stepMs = 250) {
  const t0 = Date.now();
  for (;;) {
    if (await test()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(stepMs);
  }
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.ico': 'image/x-icon', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.wav': 'audio/wav', '.map': 'application/json' };

/** A minimal static server for an exported web build, with the single-page-app fallback to index.html. */
function serveStatic(rootDir, port) {
  const root = resolvePath(rootDir);
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let file = normalize(join(root, path));
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/**
 * @param {{ apiPort?: number, webPort?: number, fillMs?: number, graceMs?: number, webDir?: string, log?: (m: string) => void }} [options]
 *   `webDir`: an already exported build to serve instead of exporting one (a rerun while iterating).
 */
export async function startStack({ apiPort = 3191, webPort = 8087, fillMs = 8000, graceMs = Number(process.env.E2E_GRACE_MS) || 2500, webDir, log = console.log } = {}) {
  await assertPort('backend', apiPort);
  await assertPort('web', webPort);
  const databaseUrl = resolveDatabaseUrl();
  if (!isLocalDatabaseUrl(databaseUrl ?? '')) throw new Error('DATABASE_URL is not a local database: the browser tests only run against this machine');

  const children = [];
  let server = null;
  let tempDir = null;
  const stop = async () => {
    try {
      await new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
    } catch {
      /* ignore */
    }
    for (const child of children) killTree(child);
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  };

  try {
    const apiUrl = `http://localhost:${apiPort}`;
    log(`stack: backend on ${apiUrl} (fill wait ${fillMs} ms, takeover grace ${graceMs} ms)`);
    const tsxCli = join(BACKEND, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const backend = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
      cwd: BACKEND,
      env: { ...process.env, PORT: String(apiPort), FOUR_FILL_MS: String(fillMs), FOUR_GRACE_MS: String(graceMs), AUTH_RATE_LIMIT_TEST_OVERRIDE: '1000', NODE_ENV: 'development' },
      stdio: 'ignore',
      detached: process.platform !== 'win32',
    });
    children.push(backend);
    await waitFor('the backend to answer /health', async () => {
      try {
        return (await fetch(`${apiUrl}/health`)).ok;
      } catch {
        return false;
      }
    }, 60_000);

    let dir = webDir;
    if (!dir) {
      tempDir = mkdtempSync(join(tmpdir(), 'chaturaji-web-'));
      dir = tempDir;
      log(`stack: exporting the web app (dev build, API ${apiUrl}) ...`);
      const exportRun = spawnSync('npx', ['expo', 'export', '--platform', 'web', '--dev', '--output-dir', dir], {
        cwd: FRONTEND,
        env: { ...process.env, EXPO_PUBLIC_API_URL: apiUrl, EXPO_PUBLIC_USE_ONLINE_BACKEND: 'false', CI: '1' },
        stdio: 'ignore',
        shell: true,
        timeout: 600_000,
      });
      if (exportRun.status !== 0) throw new Error(`the web export failed (exit ${exportRun.status})`);
    }
    server = await serveStatic(dir, webPort);
    const webUrl = `http://localhost:${webPort}`;
    log(`stack: app on ${webUrl}`);

    const tracker = createUserTracker({
      databaseUrl,
      getPrisma: async () => new (await import('@prisma/client')).PrismaClient({ datasources: { db: { url: databaseUrl } } }),
      log,
    });

    /** Registers a test account through the real REST endpoint. The password is random and stays in memory. */
    async function createAccount(label) {
      const tag = randomBytes(4).toString('hex');
      const user = { username: `e2e${label}${tag}`, email: `e2e-${label}-${tag}@test.local`, password: randomBytes(12).toString('base64url') };
      const res = await fetch(`${apiUrl}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(user) });
      if (res.status !== 201) throw new Error(`could not register a test account (${res.status})`);
      const body = await res.json();
      tracker.track({ userId: body.user.id });
      return { ...user, userId: body.user.id, token: body.token };
    }

    return { apiUrl, webUrl, createAccount, tracker, stop, apiPort, webPort, graceMs };
  } catch (err) {
    await stop();
    throw err;
  }
}
