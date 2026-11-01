/**
 * After a CLEAN `npm ci`, with no manual `prisma generate`, does the server work? (command #33, part B)
 *
 *   npm ci && npm run check:cleanInstall
 *
 * The owner's `npm ci` once left no Prisma client behind ("@prisma/client did not initialize yet. Please run prisma generate") and nothing noticed, because every CI job ran `npx prisma generate`
 * by hand right after `npm ci`. This check is run by CI (backend ci.yml, BEFORE the manual generate step) and by `security-audit` (right after its `npm ci`), so a bare install is proved:
 *   1. the client is constructible (`new PrismaClient()` is exactly what threw);
 *   2. the server starts from source (tsx, a devDependency every `npm ci` installs) on a free port with placeholder settings and answers GET /health with { ok: true };
 *   3. package.json still runs the generation itself (the "postinstall" script) - the thing that makes (1) true on every npm version and every allowScripts policy.
 * It connects to no database (the URL is a placeholder, Prisma connects lazily), reads no .env, prints no setting, and stops only the one process it started (by its PID).
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

// 3. the install runs the generation itself
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (pkg.scripts?.postinstall !== 'node scripts/prisma-generate.mjs') problems.push(`package.json "postinstall" is ${JSON.stringify(pkg.scripts?.postinstall)}, not "node scripts/prisma-generate.mjs": a bare npm ci would leave no Prisma client on an npm that skips dependency install scripts`);

// 1. the client exists
try {
  const { PrismaClient } = await import('@prisma/client');
  const client = new PrismaClient({ datasources: { db: { url: 'postgresql://placeholder:placeholder@127.0.0.1:1/placeholder' } } });
  await client.$disconnect();
  console.log('  ok  new PrismaClient() works after a bare npm ci');
} catch (error) {
  problems.push(`new PrismaClient() failed after a bare npm ci: ${String(error instanceof Error ? error.message : error).split('\n').find((line) => line.trim() !== '') ?? error}`);
}

// 2. the server starts and answers
const port = await new Promise((resolvePort, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port: free } = probe.address();
    probe.close(() => resolvePort(free));
  });
});
const env = { ...process.env, PORT: String(port), DATABASE_URL: 'postgresql://placeholder:placeholder@127.0.0.1:1/placeholder', JWT_SECRET: 'placeholder-not-a-secret-placeholder-not-a-secret', CI: '1' };
delete env.NODE_ENV;
const log = [];
const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', (chunk) => log.push(String(chunk)));
server.stderr.on('data', (chunk) => log.push(String(chunk)));
let exited = null;
server.once('exit', (code, signal) => (exited = `exit ${code ?? signal}`));
try {
  let answered = false;
  for (let i = 0; i < 120 && exited === null && !answered; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      const body = await res.json();
      answered = res.status === 200 && body?.ok === true;
    } catch {
      /* not listening yet */
    }
  }
  if (answered) console.log('  ok  the server starts from source and answers GET /health');
  else problems.push(`the server did not answer GET /health (${exited ?? 'still running after 60 s'}):\n${log.join('').split('\n').slice(-12).join('\n')}`);
} finally {
  if (exited === null) server.kill('SIGTERM');
}

if (problems.length > 0) {
  console.error(`FAILED:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('OK: a bare npm ci leaves a working Prisma client and a server that starts');
process.exit(0);
