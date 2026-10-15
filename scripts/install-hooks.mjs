/** Points this clone's git at `.githooks/` (the versioned hooks). Runs from `npm install` (the "prepare" script); silently does nothing outside a git checkout. */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(join(root, '.git')) && existsSync(join(root, '.githooks'))) {
  try {
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'ignore' });
  } catch {
    // no git on PATH: the hook is a convenience, never a reason to fail an install
  }
}
