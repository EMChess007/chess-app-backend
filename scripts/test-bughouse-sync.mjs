/**
 * Tests for scripts/sync-bughouse.mjs - the generator that derives the backend's Bughouse engine from the app source (the second user of the mechanism of sync-fourplayer.mjs).
 *
 *   npm run test:bughouseSync        (plain node, no server, no database; the real mirror needs the app checked out at ../)
 *
 * What is guarded: the single transform (relative specifiers gain `.js`, NOTHING else changes), the closure rule (a package, a client-only module, an extension, a dynamic import
 * are refused - and `../crazyhouse` is allowed), `--check` catching every kind of drift, tolerance of CRLF checkouts, the two generators not disturbing each other, and the real
 * committed mirror being exactly what the generator produces.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ALLOWED_PACKAGES, BACKEND_DIR, DEFAULT_OUT_ROOT, DEFAULT_SOURCE_ROOT, EXTERNAL_MIRRORED, INDEX_PATH, MANIFEST_PATH, OWNED_DIR, SyncError, bannerFor, check, generate, generateIndex, readManifest, run, toLf, write } from './sync-bughouse.mjs';
import { check as checkFourPlayer } from './sync-fourplayer.mjs';

let passed = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ok  ${message}`);
}
function throwsSync(fn, pattern, message) {
  let error = null;
  try {
    fn();
  } catch (err) {
    error = err;
  }
  assert.ok(error instanceof SyncError, `${message} - expected a SyncError, got ${error ? `${error.constructor.name}: ${error.message}` : 'no error'}`);
  assert.match(error.message, pattern, `${message} - wrong message: ${error.message}`);
  passed++;
  console.log(`  ok  ${message}`);
}

const tmpDirs = [];
function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}
/** A synthetic app source tree: `sources` maps manifest path -> content; `files` is the manifest's list (default: every key). */
function makeSource(sources, files = Object.keys(sources)) {
  const root = tmp('bh-src');
  fs.mkdirSync(path.join(root, OWNED_DIR), { recursive: true });
  fs.writeFileSync(path.join(root, MANIFEST_PATH), JSON.stringify({ files }));
  for (const [rel, content] of Object.entries(sources)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}
const capture = () => {
  const out = { log: [], error: [] };
  return { out, log: (m) => out.log.push(m), error: (m) => out.error.push(m) };
};

try {
  console.log('\n=== 1. The REAL mirror is exactly "source + banner + .js" (re-derived without the generator) ===');
  {
    const manifest = readManifest(DEFAULT_SOURCE_ROOT);
    ok(manifest.length >= 1 && manifest.every((f) => f.startsWith('bughouse/')), `the manifest lists only files under bughouse/ (${manifest.join(', ')})`);
    const onDisk = fs.readdirSync(path.join(DEFAULT_SOURCE_ROOT, 'bughouse')).filter((f) => f.endsWith('.ts') && f !== 'index.ts').map((f) => `bughouse/${f}`).sort();
    ok(JSON.stringify([...manifest].sort()) === JSON.stringify(onDisk), 'every module of src/logic/bughouse (except the barrel) is listed in the manifest - a new module cannot be forgotten');
    let specifiers = 0;
    for (const rel of manifest) {
      const source = toLf(fs.readFileSync(path.join(DEFAULT_SOURCE_ROOT, ...rel.split('/')), 'utf8'));
      const generated = toLf(fs.readFileSync(path.join(DEFAULT_OUT_ROOT, ...rel.split('/')), 'utf8'));
      const banner = bannerFor(rel);
      ok(generated.startsWith(banner), `${rel}: starts with the generated-file banner (it names \`npm run sync:bughouse\`)`);
      const body = generated.slice(banner.length);
      const undone = body.replace(/(from\s+'\.{1,2}\/[^']*)\.js'/g, (_, head) => {
        specifiers++;
        return `${head}'`;
      });
      ok(undone === source, `${rel}: generated body minus the ".js" suffixes is byte-identical to the app source`);
    }
    const index = toLf(fs.readFileSync(path.join(DEFAULT_OUT_ROOT, INDEX_PATH), 'utf8'));
    ok(index === generateIndex(manifest) && index.includes("export * from './types.js';"), 'the generated barrel re-exports the mirrored modules with ".js"');
    ok(bannerFor(INDEX_PATH).includes('sync:bughouse') && !bannerFor(INDEX_PATH).includes('sync:fourplayer'), 'the banner names sync:bughouse, not the other generator');
    ok(check().length === 0, `check() against the real tree: in sync (${specifiers} relative specifier(s) handled)`);
  }

  console.log('\n=== 2. The two generators own different directories and never disturb each other ===');
  {
    ok(OWNED_DIR === 'bughouse' && fs.existsSync(path.join(DEFAULT_OUT_ROOT, 'bughouse')) && fs.existsSync(path.join(DEFAULT_OUT_ROOT, 'fourPlayer')), 'src/game/bughouse and src/game/fourPlayer both exist');
    ok(checkFourPlayer().length === 0, 'sync:fourplayer --check is still in sync with the bughouse files present');
    const outRoot = tmp('bh-out');
    fs.mkdirSync(path.join(outRoot, 'fourPlayer'), { recursive: true });
    fs.writeFileSync(path.join(outRoot, 'fourPlayer', 'board.ts'), 'keep me');
    fs.writeFileSync(path.join(outRoot, 'crazyhouse.ts'), 'keep me too');
    fs.writeFileSync(path.join(outRoot, 'rooms.ts'), 'hand-written');
    write({ outRoot });
    ok(fs.readFileSync(path.join(outRoot, 'fourPlayer', 'board.ts'), 'utf8') === 'keep me' && fs.readFileSync(path.join(outRoot, 'crazyhouse.ts'), 'utf8') === 'keep me too' && fs.readFileSync(path.join(outRoot, 'rooms.ts'), 'utf8') === 'hand-written', 'write() touches nothing outside src/game/bughouse');
    ok(check({ outRoot }).length === 0, '...and the result is in sync');
  }

  console.log('\n=== 3. The closure rule ===');
  {
    const good = makeSource({ 'bughouse/a.ts': "import { b } from './b';\nexport const a = b;\n", 'bughouse/b.ts': 'export const b = 1;\n' });
    const out = generate({ sourceRoot: good });
    ok(out.get('bughouse/a.ts').includes("from './b.js'") && out.get('bughouse/b.ts').endsWith('export const b = 1;\n') && out.has(INDEX_PATH), 'a relative import of a listed file gains ".js"; the rest is unchanged');
    ok(JSON.stringify(EXTERNAL_MIRRORED) === JSON.stringify(['crazyhouse.ts']), 'the one allowed non-generated module is crazyhouse.ts (a literal)');
    const withCz = makeSource({ 'bughouse/a.ts': "import type { CrazyhouseState } from '../crazyhouse';\nexport type S = CrazyhouseState;\n" });
    ok(generate({ sourceRoot: withCz }).get('bughouse/a.ts').includes("from '../crazyhouse.js'"), "'../crazyhouse' is allowed and becomes '../crazyhouse.js'");
    throwsSync(() => generate({ sourceRoot: makeSource({ 'bughouse/a.ts': "import fs from 'node:fs';\n" }) }), /imports "node:fs" - only relative imports/, 'a node: import is refused');
    throwsSync(() => generate({ sourceRoot: makeSource({ 'bughouse/a.ts': "import lodash from 'lodash';\n" }) }), /imports "lodash"/, 'a package import is refused');
    throwsSync(() => generate({ sourceRoot: makeSource({ 'bughouse/a.ts': "import { Chess } from 'chess.js/dist/esm/chess.js';\n" }) }), /imports "chess.js\/dist\/esm\/chess.js"/, 'a deep import into chess.js is refused: only the package name itself is allowed');
    throwsSync(() => generate({ sourceRoot: makeSource({ 'bughouse/a.ts': "import { Chess } from 'chess.js ';\n" }) }), /imports "chess.js "/, '...and so is a near miss of the name');
    ok(JSON.stringify(ALLOWED_PACKAGES) === JSON.stringify(['chess.js']), 'the one allowed package is chess.js (a literal)');
    const withChess = generate({ sourceRoot: makeSource({ 'bughouse/a.ts': "import { Chess, type Square } from 'chess.js';\nimport { b } from './b';\nexport const a = [Chess, b];\nexport type S = Square;\n", 'bughouse/b.ts': 'export const b = 1;\n' }) });
    ok(withChess.get('bughouse/a.ts').includes("from 'chess.js';") && !withChess.get('bughouse/a.ts').includes("chess.js.js") && withChess.get('bughouse/a.ts').includes("from './b.js'"), "chess.js is left exactly as written ('chess.js', never 'chess.js.js'); the relative import beside it still gains '.js'");
    throwsSync(() => generate({ sourceRoot: makeSource({ 'bughouse/a.ts': "import { x } from '../ChessEngine';\n" }) }), /not in bughouse\/MIRRORED_TO_BACKEND\.json/, 'a client module outside the list is refused - and the message names THIS manifest');
    throwsSync(() => generate({ sourceRoot: makeSource({ 'bughouse/a.ts': "import { x } from '../fourPlayer/board';\n" }) }), /not in bughouse\/MIRRORED_TO_BACKEND\.json/, 'the 4 Player modules are not importable either');
    throwsSync(() => generate({ sourceRoot: makeSource({ 'bughouse/a.ts': "import { x } from './b.js';\n", 'bughouse/b.ts': 'export const x = 1;\n' }) }), /already has an extension/, 'a specifier that already has an extension is refused');
    throwsSync(() => generate({ sourceRoot: makeSource({ 'bughouse/a.ts': "export const f = () => import('./b');\n", 'bughouse/b.ts': '' }) }), /dynamic import/, 'a dynamic import is refused');
    throwsSync(() => generate({ sourceRoot: makeSource({ 'bughouse/a.ts': "export * from './missing';\n" }) }), /missing/, 'a re-export of an unlisted file is refused');
  }

  console.log('\n=== 4. The manifest ===');
  {
    const withManifest = (manifest) => {
      const root = tmp('bh-man');
      fs.mkdirSync(path.join(root, OWNED_DIR), { recursive: true });
      fs.writeFileSync(path.join(root, MANIFEST_PATH), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
      return root;
    };
    throwsSync(() => readManifest(withManifest('not json')), /cannot read the mirror list/, 'unreadable JSON is refused');
    throwsSync(() => readManifest(withManifest({ files: [] })), /non-empty array/, 'an empty list is refused');
    throwsSync(() => readManifest(withManifest({ files: ['fourPlayer/board.ts'] })), /is not under bughouse\//, 'a file outside bughouse/ is refused (this generator owns only that directory)');
    throwsSync(() => readManifest(withManifest({ files: ['bughouse/index.ts'] })), /is generated, do not list it/, 'the barrel cannot be listed');
    throwsSync(() => readManifest(withManifest({ files: ['bughouse/a.ts', 'bughouse/a.ts'] })), /listed twice/, 'a duplicate is refused');
    throwsSync(() => readManifest(withManifest({ files: ['bughouse/a.js'] })), /not a \.ts file path/, 'a non-.ts entry is refused');
    throwsSync(() => readManifest(withManifest({ files: ['bughouse/../x.ts'] })), /plain relative/, 'a ".." entry is refused');
    throwsSync(() => generate({ sourceRoot: withManifest({ files: ['bughouse/ghost.ts'] }) }), /does not exist/, 'a listed file that does not exist is refused');
  }

  console.log('\n=== 5. --check catches every kind of drift; write() repairs it ===');
  {
    const source = makeSource({ 'bughouse/a.ts': "import { b } from './b';\nexport const a = b;\n", 'bughouse/b.ts': 'export const b = 1;\n' });
    const outRoot = tmp('bh-out');
    ok(check({ sourceRoot: source, outRoot }).map((p) => p.kind).join() === 'missing,missing,missing', 'nothing generated yet: every file (and the barrel) is missing');
    ok(write({ sourceRoot: source, outRoot }).length === 3 && write({ sourceRoot: source, outRoot }).length === 0, 'write() creates the three files, and a second write changes nothing');
    ok(check({ sourceRoot: source, outRoot }).length === 0, 'in sync after write()');
    fs.appendFileSync(path.join(outRoot, 'bughouse', 'b.ts'), '// hand edit\n');
    const drift = check({ sourceRoot: source, outRoot });
    ok(drift.length === 1 && drift[0].kind === 'different' && drift[0].file === 'bughouse/b.ts' && /line \d+/.test(drift[0].detail), 'a hand edit is "different" and names the first differing line');
    fs.writeFileSync(path.join(outRoot, 'bughouse', 'stale.ts'), 'x');
    ok(check({ sourceRoot: source, outRoot }).some((p) => p.kind === 'stale' && p.file === 'bughouse/stale.ts'), 'an extra file in the owned directory is "stale"');
    ok(write({ sourceRoot: source, outRoot }).includes('bughouse/stale.ts (removed)') && check({ sourceRoot: source, outRoot }).length === 0, 'write() removes the stale file and repairs the edit');
    // CRLF checkout
    for (const rel of ['bughouse/a.ts', 'bughouse/b.ts', INDEX_PATH]) {
      const file = path.join(outRoot, rel);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('\n').join('\r\n'));
    }
    ok(check({ sourceRoot: source, outRoot }).length === 0, 'a CRLF checkout of the generated files is still "in sync"');
    fs.writeFileSync(path.join(source, 'bughouse', 'b.ts'), 'export const b = 1;\r\n');
    ok(check({ sourceRoot: source, outRoot }).length === 0, '...and so is a CRLF source');
    // an external module a mirrored file imports must exist on the server side
    const cz = makeSource({ 'bughouse/a.ts': "import type { CrazyhouseState } from '../crazyhouse';\nexport type S = CrazyhouseState;\n" });
    const czOut = tmp('bh-out');
    write({ sourceRoot: cz, outRoot: czOut });
    ok(check({ sourceRoot: cz, outRoot: czOut }).some((p) => p.file === 'crazyhouse.ts' && p.kind === 'missing'), 'a mirrored file that imports ../crazyhouse needs src/game/crazyhouse.ts on the server: its absence is reported');
    fs.writeFileSync(path.join(czOut, 'crazyhouse.ts'), '// the hand mirror');
    ok(check({ sourceRoot: cz, outRoot: czOut }).length === 0, '...and with the file present it is in sync');
  }

  console.log('\n=== 6. The CLI and its exit codes ===');
  {
    const source = makeSource({ 'bughouse/a.ts': 'export const a = 1;\n' });
    const outRoot = tmp('bh-out');
    const c1 = capture();
    ok(run({ argv: ['--check'], sourceRoot: source, outRoot, ...c1 }) === 1 && c1.out.error.some((l) => l.includes('OUT OF SYNC')) && c1.out.error.some((l) => l.includes('npm run sync:bughouse')), '--check on a missing mirror: exit 1, says OUT OF SYNC and which command repairs it');
    const c2 = capture();
    ok(run({ argv: [], sourceRoot: source, outRoot, ...c2 }) === 0 && c2.out.log[0].startsWith('Updated 2 file(s)'), 'no flag: writes (exit 0)');
    const c3 = capture();
    ok(run({ argv: ['--check'], sourceRoot: source, outRoot, ...c3 }) === 0 && c3.out.log[0] === 'Bughouse mirror is in sync (2 generated files).', '--check when in sync: exit 0');
    const c4 = capture();
    ok(run({ argv: ['--check'], sourceRoot: makeSource({ 'bughouse/a.ts': "import x from 'pkg';\n" }), outRoot, ...c4 }) === 2 && c4.out.error[0].startsWith('sync-bughouse: cannot generate'), 'a broken closure rule: exit 2');
    const real = spawnSync(process.execPath, [path.join(BACKEND_DIR, 'scripts', 'sync-bughouse.mjs'), '--check'], { encoding: 'utf8' });
    ok(real.status === 0 && /Bughouse mirror is in sync/.test(real.stdout), 'the real CLI: `node scripts/sync-bughouse.mjs --check` exits 0');
  }

  console.log('\n=== 7. Wired into the package and into CI ===');
  {
    const pkg = JSON.parse(fs.readFileSync(path.join(BACKEND_DIR, 'package.json'), 'utf8'));
    ok(pkg.scripts['sync:bughouse'] === 'node scripts/sync-bughouse.mjs' && pkg.scripts['test:bughouseSync'] === 'node scripts/test-bughouse-sync.mjs', 'package.json: sync:bughouse and test:bughouseSync');
    const ci = fs.readFileSync(path.join(BACKEND_DIR, '.github', 'workflows', 'ci.yml'), 'utf8');
    ok(ci.includes('npm run sync:bughouse -- --check') && ci.includes('npm run test:bughouseSync'), 'ci.yml runs `sync:bughouse -- --check` and `test:bughouseSync`');
  }
} finally {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} checks passed`);
