/**
 * Tests for scripts/sync-fourplayer.mjs - the generator that derives the backend's 4 Player engine + wire contract from the app source.
 *
 *   npm run test:fourplayerSync        (plain node, no server, no database; the real mirror needs the app checked out at ../)
 *
 * What is guarded: the single transform (relative specifiers gain `.js`, NOTHING else changes), the closure rule that keeps client-only
 * code off the server, `--check` catching every kind of drift (a changed, missing or stale file; a stale file would otherwise hide a
 * hand edit), tolerance of CRLF checkouts, and the real committed mirror being exactly what the generator produces. Behavioural
 * equivalence of the two engines is test-fourplayer.mjs - this file is the mechanical net, that one is the behavioural net.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BACKEND_DIR, DEFAULT_OUT_ROOT, DEFAULT_SOURCE_ROOT, INDEX_PATH, MANIFEST_PATH, SyncError, bannerFor, check, generate, generateIndex, readManifest, rewriteModule, run, toLf, write } from './sync-fourplayer.mjs';

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
  const root = tmp('fp-src');
  fs.mkdirSync(path.join(root, 'fourPlayer'), { recursive: true });
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
const SET = (...names) => new Set(names);

console.log('\n=== 1. The REAL mirror is exactly "source + banner + .js" (re-derived without the generator) ===');
{
  const manifest = readManifest(DEFAULT_SOURCE_ROOT);
  ok(manifest.length === 10 && manifest.includes('fourPlayer/giveaway.ts') && manifest.includes('fourPlayer/giveawayBot.ts') && manifest.includes('fourPlayer/chaturajiBot.ts') && manifest.includes('fourPlayerWire.ts') && manifest.includes('fourPlayer/bot.ts'), 'the manifest lists the nine engine modules (giveaway.ts and giveawayBot.ts joined for 4 Player Giveaway, chaturajiBot.ts for Chaturaji) and the wire file');
  ok(!manifest.some((f) => /setup|presentation|premove|annotations/.test(f)), 'client-only modules (setup, presentation, premove, annotations) are NOT mirrored');
  let relativeSpecifiers = 0;
  for (const rel of manifest) {
    const source = toLf(fs.readFileSync(path.join(DEFAULT_SOURCE_ROOT, ...rel.split('/')), 'utf8'));
    const generated = toLf(fs.readFileSync(path.join(DEFAULT_OUT_ROOT, ...rel.split('/')), 'utf8'));
    const banner = bannerFor(rel);
    ok(generated.startsWith(banner), `${rel}: starts with the generated-file banner`);
    const body = generated.slice(banner.length);
    // Independent re-derivation: undo the one transform with a different mechanism (a regex over `from '...'`) and compare byte for byte.
    const undone = body.replace(/(from\s+'\.{1,2}\/[^']*)\.js'/g, (_, head) => {
      relativeSpecifiers++;
      return `${head}'`;
    });
    ok(undone === source, `${rel}: generated body minus the ".js" suffixes is byte-identical to the app source`);
    ok(!/\.js'/.test(undone), `${rel}: no ".js" specifier is left that the reverse step did not account for`);
  }
  ok(relativeSpecifiers >= 10, `the real files contain relative imports that the transform handled (${relativeSpecifiers} of them)`);
  ok(check().length === 0, 'check() on the real tree: the committed mirror is in sync');
  const index = toLf(fs.readFileSync(path.join(DEFAULT_OUT_ROOT, 'fourPlayer', 'index.ts'), 'utf8'));
  ok(index === generateIndex(manifest), 'the committed barrel is exactly what generateIndex produces');
  ok(!/setup|presentation|premove|annotations|Wire/.test(index), 'the barrel exports only mirrored engine modules');
}

console.log('\n=== 2. The transform: ".js" inside every relative specifier, and nothing else ===');
{
  const m = SET('fourPlayer/a.ts', 'fourPlayer/b.ts', 'c.ts');
  const t = (src) => rewriteModule('fourPlayer/a.ts', src, m);
  ok(t("import { x } from './b';") === "import { x } from './b.js';", 'single-line import');
  ok(t('import { x } from "./b";') === 'import { x } from "./b.js";', 'double-quoted import keeps its quotes');
  ok(t("import { x,\n  y,\n  type Z,\n} from './b';\n") === "import { x,\n  y,\n  type Z,\n} from './b.js';\n", 'multi-line import (the shape moves.ts uses)');
  ok(t("import type { T } from './b';") === "import type { T } from './b.js';", 'import type');
  ok(t("export * from './b';") === "export * from './b.js';", 'export * from');
  ok(t("export { x, type T } from './b';") === "export { x, type T } from './b.js';", 'export { } from');
  ok(t("export * as ns from './b';") === "export * as ns from './b.js';", 'export * as ns from');
  ok(t("import './b';") === "import './b.js';", 'side-effect import');
  ok(t("import { x } from '../c';") === "import { x } from '../c.js';", 'a parent-directory specifier resolves against the importing file');
  ok(rewriteModule('c.ts', "import { x } from './fourPlayer/b';", m) === "import { x } from './fourPlayer/b.js';", 'a subdirectory specifier from the root file');
  ok(t("import { a } from './b'; import { c } from './b';") === "import { a } from './b.js'; import { c } from './b.js';", 'two imports on one line, both rewritten');
  const tricky = "// import { x } from './b';\n/* export * from './b'; */\nconst s = \"from './b'\";\nconst t = `import './b'`;\nconst n = 5; // trailing\n";
  ok(t(tricky) === tricky, "specifier-looking text inside comments and string/template literals is NOT touched");
  ok(t('export const a = 1;\n') === 'export const a = 1;\n', 'a file with no imports is unchanged');
  const crlfFree = t("import { x } from './b';\nexport const y = x;\n");
  ok(!crlfFree.includes('\r'), 'no carriage returns are introduced');
}

console.log('\n=== 3. The closure rule: anything that could drag client code (or an unbuildable import) into the server FAILS ===');
{
  const m = SET('fourPlayer/a.ts', 'fourPlayer/b.ts');
  const t = (src) => rewriteModule('fourPlayer/a.ts', src, m);
  throwsSync(() => t("import { x } from './setup';"), /fourPlayer\/a\.ts:1: imports "\.\/setup" \(fourPlayer\/setup\.ts\) which is not in .*MIRRORED_TO_BACKEND\.json/, 'a relative import of a file that is not mirrored (e.g. client-only ./setup)');
  throwsSync(() => t("import type { T } from './setup';"), /not in/, '...even as a type-only import (the generated file would not compile)');
  throwsSync(() => t("export * from './premove';"), /not in/, '...or an export-from');
  throwsSync(() => t("import { x } from 'react-native';"), /only relative imports of mirrored files are allowed/, 'a package import');
  throwsSync(() => t("import fs from 'node:fs';"), /only relative imports/, 'a node: import');
  throwsSync(() => t("import { x } from '../../types/multiplayer';"), /not in|only relative/, 'a path that climbs out of the mirrored tree');
  throwsSync(() => t("import { x } from './b.js';"), /already has an extension/, 'a specifier that already has .js (would become .js.js)');
  throwsSync(() => t("import { x } from './b.ts';"), /already has an extension/, 'a .ts extension');
  throwsSync(() => t("import { x } from './fourPlayer';"), /not in/, 'a directory import (index resolution does not exist under NodeNext)');
  throwsSync(() => t("const m = await import('./b');"), /dynamic import\(\) \/ require\(\)/, 'a dynamic import()');
  throwsSync(() => t("const m = require('./b');"), /dynamic import\(\) \/ require\(\)/, 'require()');
  throwsSync(() => t("import b = require('./b');"), /import x = require/, 'import x = require()');
  throwsSync(() => t("type T = import('./b').T;"), /import\('\.\.\.'\)\.T/, "an import('./b').T type");
  // The TypeScript parser accepts these (no syntax error), so the generator must not skip them silently.
  throwsSync(() => t('import x from foo;'), /a module specifier that is not a string literal/, 'an identifier where the specifier should be a string');
  throwsSync(() => t('export * from bar;'), /not a string literal/, '...in an export-from too');
  throwsSync(() => t('import x from 5;'), /not a string literal/, 'a number');
  throwsSync(() => t('export { a } from `./b`;'), /not a string literal/, 'a template literal');
  throwsSync(() => t("import { x } from './b';\n\nimport { y } from './nope';\nimport z from 'zod';"), /a\.ts:3:.*\n.*a\.ts:4:/, 'EVERY problem is reported with its own line number, not just the first');
}

console.log('\n=== 4. The manifest and generate() on synthetic trees ===');
{
  const source = (rel) => `export const ${rel.replace(/\W/g, '_')} = 1;\n`;
  throwsSync(() => readManifest(tmp('fp-none')), /cannot read the mirror list/, 'no manifest -> a clear error');
  const bad = (files) => {
    const root = tmp('fp-bad');
    fs.mkdirSync(path.join(root, 'fourPlayer'), { recursive: true });
    fs.writeFileSync(path.join(root, MANIFEST_PATH), JSON.stringify({ files }));
    return root;
  };
  throwsSync(() => readManifest(bad([])), /non-empty array/, 'an empty list');
  throwsSync(() => readManifest(bad(['fourPlayer/a.js'])), /not a \.ts file path/, 'a non-.ts entry');
  throwsSync(() => readManifest(bad(['fourPlayer/a.d.ts'])), /not a \.ts file path/, 'a .d.ts entry');
  throwsSync(() => readManifest(bad(['../x.ts'])), /plain relative/, 'a parent-directory entry');
  throwsSync(() => readManifest(bad(['fourPlayer\\a.ts'])), /plain relative/, 'a backslash entry');
  throwsSync(() => readManifest(bad(['/abs/a.ts'])), /plain relative/, 'an absolute entry');
  throwsSync(() => readManifest(bad(['fourPlayer/a.ts', 'fourPlayer/a.ts'])), /listed twice/, 'a duplicate entry');
  throwsSync(() => readManifest(bad([INDEX_PATH])), /is generated, do not list it/, 'listing the generated barrel');
  const listedButMissing = makeSource({ 'fourPlayer/a.ts': source('a') }, ['fourPlayer/a.ts', 'fourPlayer/ghost.ts']);
  throwsSync(() => generate({ sourceRoot: listedButMissing }), /ghost\.ts: listed in .* but .* does not exist/, 'a listed file that does not exist');

  const root = makeSource({ 'fourPlayer/a.ts': "import { b } from './b';\nexport const a = b;\n", 'fourPlayer/b.ts': 'export const b = 1;\n', 'wire.ts': "import { a } from './fourPlayer/a';\nexport const w = a;\n" });
  const out = generate({ sourceRoot: root });
  ok([...out.keys()].join(',') === 'fourPlayer/a.ts,fourPlayer/b.ts,wire.ts,fourPlayer/index.ts', 'generates exactly the listed files plus the barrel');
  ok(out.get('fourPlayer/a.ts') === `${bannerFor('fourPlayer/a.ts')}import { b } from './b.js';\nexport const a = b;\n`, 'banner + rewritten body');
  ok(out.get('wire.ts').includes("from './fourPlayer/a.js'"), 'a root-level file importing into fourPlayer/ is rewritten');
  const barrel = out.get(INDEX_PATH);
  ok(barrel.includes("export * from './a.js';") && barrel.includes("export * from './b.js';") && !barrel.includes('wire'), 'the barrel re-exports the fourPlayer/ modules only, in manifest order');
  ok(barrel.indexOf("'./a.js'") < barrel.indexOf("'./b.js'"), '...in manifest order');
  const inOrder = makeSource({ 'fourPlayer/z.ts': 'export const z = 1;\n', 'fourPlayer/a.ts': 'export const a = 1;\n' });
  ok(generate({ sourceRoot: inOrder }).get(INDEX_PATH).indexOf("'./z.js'") < generate({ sourceRoot: inOrder }).get(INDEX_PATH).indexOf("'./a.js'"), 'barrel order follows the manifest, not the alphabet');
  const crlf = makeSource({ 'fourPlayer/a.ts': "import { b } from './b';\r\nexport const a = b;\r\n", 'fourPlayer/b.ts': 'export const b = 1;\r\n' });
  const fromCrlf = generate({ sourceRoot: crlf }).get('fourPlayer/a.ts');
  ok(!fromCrlf.includes('\r') && fromCrlf.endsWith("from './b.js';\nexport const a = b;\n"), 'a CRLF source (Windows checkout) generates the same LF output');
  const oneBad = makeSource({ 'fourPlayer/a.ts': "import x from './client';\n", 'fourPlayer/b.ts': "import y from 'react';\n" });
  throwsSync(() => generate({ sourceRoot: oneBad }), /a\.ts:1:[^]*b\.ts:1:/, 'problems from several files are all reported together');
}

console.log('\n=== 5. check() / write(): drift in every direction is caught, and fixed ===');
{
  const sourceRoot = makeSource({ 'fourPlayer/a.ts': "import { b } from './b';\nexport const a = b;\n", 'fourPlayer/b.ts': 'export const b = 1;\n', 'wire.ts': "import { a } from './fourPlayer/a';\nexport const w = a;\n" });
  const outRoot = tmp('fp-out');
  ok(check({ sourceRoot, outRoot }).length === 4 && check({ sourceRoot, outRoot }).every((p) => p.kind === 'missing'), 'nothing generated yet: every file is "missing"');
  const first = write({ sourceRoot, outRoot });
  ok(first.length === 4, 'write() creates all four files');
  ok(check({ sourceRoot, outRoot }).length === 0, 'in sync after write()');
  ok(write({ sourceRoot, outRoot }).length === 0, 'write() is idempotent: a second run changes nothing');
  ok(!fs.readFileSync(path.join(outRoot, 'fourPlayer', 'a.ts'), 'utf8').includes('\r'), 'output is LF');

  // Windows with autocrlf: the committed LF files appear as CRLF in the working tree - that is NOT drift.
  for (const rel of ['fourPlayer/a.ts', 'fourPlayer/b.ts', 'wire.ts', 'fourPlayer/index.ts']) {
    const file = path.join(outRoot, ...rel.split('/'));
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('\n').join('\r\n'));
  }
  ok(check({ sourceRoot, outRoot }).length === 0, 'a CRLF working tree (autocrlf) is not reported as drift');
  ok(write({ sourceRoot, outRoot }).length === 0, 'write() on a CRLF working tree reports nothing changed...');
  ok(fs.readFileSync(path.join(outRoot, 'fourPlayer', 'a.ts'), 'utf8').includes('\r\n'), '...and does not churn the files (line endings are git\'s business, not the generator\'s)');
  write({ sourceRoot, outRoot });

  // 1. the source changes -> generated copy is stale
  const aSource = path.join(sourceRoot, 'fourPlayer', 'b.ts');
  fs.writeFileSync(aSource, 'export const b = 2;\n');
  const drift = check({ sourceRoot, outRoot });
  ok(drift.length === 1 && drift[0].kind === 'different' && drift[0].file === 'fourPlayer/b.ts', 'a changed SOURCE value is reported as "different" for that one file');
  ok(/line \d+: expected .*b = 2.*found .*b = 1/.test(drift[0].detail), '...and names the first differing line with both versions');
  write({ sourceRoot, outRoot });
  ok(check({ sourceRoot, outRoot }).length === 0, 'write() repairs it');

  // 2. a hand edit of a generated file (the failure the whole scheme exists to prevent)
  const generatedB = path.join(outRoot, 'fourPlayer', 'b.ts');
  fs.writeFileSync(generatedB, fs.readFileSync(generatedB, 'utf8').replace('b = 2', 'b = 3'));
  ok(check({ sourceRoot, outRoot }).some((p) => p.kind === 'different' && p.file === 'fourPlayer/b.ts'), 'a hand edit of a generated file is caught');
  // a one-character edit at the very end of the file
  fs.writeFileSync(generatedB, `${fs.readFileSync(generatedB, 'utf8')}\n`);
  ok(check({ sourceRoot, outRoot }).some((p) => p.file === 'fourPlayer/b.ts'), 'even an extra trailing newline is caught');
  write({ sourceRoot, outRoot });

  // 3. missing
  fs.rmSync(path.join(outRoot, 'wire.ts'));
  ok(check({ sourceRoot, outRoot }).some((p) => p.kind === 'missing' && p.file === 'wire.ts'), 'a deleted generated file is caught as "missing"');
  write({ sourceRoot, outRoot });

  // 4. stale: a hand-written file dropped into the owned directory
  fs.writeFileSync(path.join(outRoot, 'fourPlayer', 'sneaky.ts'), 'export const evil = 1;\n');
  const stale = check({ sourceRoot, outRoot });
  ok(stale.length === 1 && stale[0].kind === 'stale' && stale[0].file === 'fourPlayer/sneaky.ts', 'a file in the owned directory that the generator did not produce is caught as "stale"');
  const removed = write({ sourceRoot, outRoot });
  ok(removed.some((c) => c.includes('sneaky.ts (removed)')) && !fs.existsSync(path.join(outRoot, 'fourPlayer', 'sneaky.ts')), 'write() removes it');

  // 5. a file leaves the manifest -> its generated copy becomes stale, even a ROOT-level one (found while writing this test: the first
  //    version of the generator only looked inside the owned directory, so a de-listed wire file would have lingered for ever)
  fs.writeFileSync(path.join(outRoot, 'handwritten.ts'), 'export const mine = 1; // backend code, no banner\n');
  fs.writeFileSync(path.join(sourceRoot, MANIFEST_PATH), JSON.stringify({ files: ['fourPlayer/a.ts', 'fourPlayer/b.ts'] }));
  const delisted = check({ sourceRoot, outRoot });
  ok(delisted.length === 1 && delisted[0].kind === 'stale' && delisted[0].file === 'wire.ts', 'de-listing a ROOT-level mirrored file makes its old copy "stale"');
  ok(!delisted.some((p) => p.file === 'handwritten.ts'), 'a hand-written top-level file (no banner) is never reported');
  const removedRoot = write({ sourceRoot, outRoot });
  ok(removedRoot.length === 1 && removedRoot[0] === 'wire.ts (removed)' && !fs.existsSync(path.join(outRoot, 'wire.ts')), 'write() removes the stale root-level copy');
  ok(fs.readFileSync(path.join(outRoot, 'handwritten.ts'), 'utf8').includes('backend code'), '...and never touches the hand-written file');
  ok(check({ sourceRoot, outRoot }).length === 0, 'in sync again after de-listing');
}

console.log('\n=== 6. The CLI: exit codes and messages ===');
{
  const sourceRoot = makeSource({ 'fourPlayer/a.ts': 'export const a = 1;\n' });
  const outRoot = tmp('fp-cli-out');
  let c = capture();
  ok(run({ argv: ['--check'], sourceRoot, outRoot, ...c }) === 1 && /OUT OF SYNC/.test(c.out.error.join('\n')) && /missing/.test(c.out.error.join('\n')), '--check on an ungenerated tree: exit 1, says OUT OF SYNC and what is missing');
  ok(/sync:fourplayer/.test(c.out.error.join('\n')), '...and tells the developer how to fix it');
  c = capture();
  ok(run({ argv: [], sourceRoot, outRoot, ...c }) === 0 && /Updated 2 file/.test(c.out.log.join('\n')), 'no flag: writes, exit 0');
  c = capture();
  ok(run({ argv: [], sourceRoot, outRoot, ...c }) === 0 && /Already up to date/.test(c.out.log.join('\n')), 'again: "Already up to date"');
  c = capture();
  ok(run({ argv: ['--check'], sourceRoot, outRoot, ...c }) === 0 && /in sync/.test(c.out.log.join('\n')), '--check when in sync: exit 0');
  const noWrite = makeSource({ 'fourPlayer/a.ts': 'export const a = 1;\n' });
  const untouched = tmp('fp-cli-untouched');
  run({ argv: ['--check'], sourceRoot: noWrite, outRoot: untouched, ...capture() });
  ok(fs.readdirSync(untouched).length === 0, '--check never writes anything');
  const broken = makeSource({ 'fourPlayer/a.ts': "import x from './client';\n" });
  c = capture();
  ok(run({ argv: ['--check'], sourceRoot: broken, outRoot, ...c }) === 2 && /cannot generate/.test(c.out.error.join('\n')), 'a closure violation: exit 2 (not 1), even with --check');
  c = capture();
  ok(run({ argv: [], sourceRoot: broken, outRoot, ...c }) === 2, '...and without --check; nothing is written for a broken source');
  ok(fs.existsSync(path.join(outRoot, 'fourPlayer', 'a.ts')) && fs.readFileSync(path.join(outRoot, 'fourPlayer', 'a.ts'), 'utf8').includes('a = 1'), 'a failed run leaves the previously generated files as they were');

  const real = spawnSync(process.execPath, [path.join(BACKEND_DIR, 'scripts', 'sync-fourplayer.mjs'), '--check'], { encoding: 'utf8' });
  ok(real.status === 0 && /in sync/.test(real.stdout), 'the real CLI (spawned) on the real tree: exit 0, "in sync"');
}

for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nAll ${passed} checks passed.`);
