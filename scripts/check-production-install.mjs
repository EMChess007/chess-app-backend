/**
 * Does the backend still INSTALL, GENERATE AND BUILD the way a production host does it? (Chaturaji W5, step 7.)
 *
 *   npm run check:productionInstall
 *
 * Why: with NODE_ENV=production in the environment, `npm ci` / `npm install` SKIP devDependencies. A host that sets NODE_ENV=production for the build as well as the run (Render
 * does so for a variable the owner adds in the dashboard; its own default is runtime-only) would then fail at `npm run build` if `tsc` or the type packages were dev dependencies -
 * they were, until this check was written: the build died with "Property 'body' does not exist" on every route. So this copies what the repo ships (src, prisma, the manifests,
 * the install hook) to a temporary folder, installs with NODE_ENV=production, generates the Prisma client, builds, and checks that `dist/index.js` exists and that a dev-only tool
 * (tsx) really is absent - i.e. that the install WAS a production install. It starts no server and touches no database: the placeholder database URL is never connected to.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const backend = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'chess-prod-install-'));
const env = { ...process.env, NODE_ENV: 'production', DATABASE_URL: 'postgresql://placeholder:placeholder@localhost:5432/placeholder', JWT_SECRET: 'placeholder-not-a-secret', CI: '1' };
let failed = null;

function run(label, command, args) {
  console.log(`  ${label} ...`);
  const result = spawnSync(command, args, { cwd: work, env, shell: true, encoding: 'utf8', timeout: 600_000 });
  if (result.status !== 0) {
    failed = `${label} failed (exit ${result.status}):\n${(result.stdout + result.stderr).split('\n').slice(-15).join('\n')}`;
    return false;
  }
  return true;
}

try {
  for (const item of ['src', 'prisma', 'package.json', 'package-lock.json', 'tsconfig.json']) cpSync(join(backend, item), join(work, item), { recursive: true });
  mkdirSync(join(work, 'scripts'));
  cpSync(join(backend, 'scripts', 'install-hooks.mjs'), join(work, 'scripts', 'install-hooks.mjs')); // the "prepare" script of npm install
  const ok =
    run('npm ci (NODE_ENV=production: devDependencies are skipped)', 'npm', ['ci']) &&
    run('prisma generate', 'npx', ['prisma', 'generate']) &&
    run('npm run build (tsc)', 'npm', ['run', 'build']);
  if (ok) {
    if (!existsSync(join(work, 'dist', 'index.js'))) failed = 'the build produced no dist/index.js';
    else if (existsSync(join(work, 'node_modules', 'tsx'))) failed = 'tsx (a devDependency) is installed: this was not a production install, so the check proves nothing';
    else if (existsSync(join(work, 'node_modules', 'playwright-core'))) failed = 'playwright-core (a devDependency) is installed: this was not a production install';
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failed) {
  console.error(`FAILED: ${failed}`);
  process.exit(1);
}
console.log('OK: a production-style install (devDependencies skipped) generates the Prisma client and builds dist/index.js');
