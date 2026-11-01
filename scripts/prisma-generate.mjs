/**
 * Leaves a WORKING Prisma client behind every `npm ci` / `npm install` (the "postinstall" script of package.json; command #33, part B).
 *
 * Why. After a clean `npm ci` on the owner's laptop the server died with "@prisma/client did not initialize yet. Please run prisma generate", and `npx prisma generate` fixed it by hand. The
 * client is generated code (node_modules/.prisma/client); it exists only if somebody generates it. @prisma/client's own postinstall is meant to do that, but since command #31 npm 11 does not
 * run a DEPENDENCY's install script unless `allowScripts` approves it by name and version, and a script that is skipped, approved for another version or swallowed leaves no client and no
 * error. CI never saw it because its workflow runs `npx prisma generate` by hand right after `npm ci`. A project's OWN postinstall is not a dependency's script: npm runs it whatever
 * `allowScripts` says, so the client is generated here, by the project, every time - and the CI job `check:cleanInstall` installs WITHOUT any manual generate and starts the server.
 *
 * It uses the locally installed CLI (no npx, no network lookup of a package) and the schema in this repo; with no schema (a stripped copy) or no CLI there is nothing to do and it says so.
 * A failed generation fails the install: a missing client is worse than a loud error at install time.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schema = join(root, 'prisma', 'schema.prisma');
const cli = join(root, 'node_modules', 'prisma', 'build', 'index.js');

if (!existsSync(schema)) {
  console.log('[postinstall] no prisma/schema.prisma here: nothing to generate');
  process.exit(0);
}
if (!existsSync(cli)) {
  console.log('[postinstall] the prisma CLI is not installed (node_modules/prisma): nothing to generate with');
  process.exit(0);
}
console.log('[postinstall] generating the Prisma client ...');
const result = spawnSync(process.execPath, [cli, 'generate', '--schema', schema], { cwd: root, stdio: 'inherit', env: process.env });
if (result.status !== 0) {
  console.error(`[postinstall] prisma generate failed (exit ${result.status ?? result.signal}): the server cannot start without the client. Fix the cause above and run "npm run prisma:generate".`);
  process.exit(result.status ?? 1);
}
