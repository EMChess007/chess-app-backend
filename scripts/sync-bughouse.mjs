#!/usr/bin/env node
/**
 * Generates the backend's copy of the Bughouse engine from the mobile app's source, so the two can never drift. The SECOND user of the mechanism of sync-fourplayer.mjs
 * (BUGHOUSE_SPEC.md section 7, W0): the same single transform (every relative module specifier `'./x'` becomes `'./x.js'`, a generated-file banner is prepended, nothing else
 * changes) and the same closure rule, with its own manifest and its own output directory.
 *
 *   npm run sync:bughouse              rewrite the generated files
 *   npm run sync:bughouse -- --check   change nothing; exit 1 if any generated file is missing, different or stale (CI runs this)
 *
 * WHAT IS COPIED is listed in the app repo's `src/logic/bughouse/MIRRORED_TO_BACKEND.json` (paths relative to `../src/logic`, all under `bughouse/`); the output is
 * `src/game/bughouse/` (the same relative path under `src/game`), plus a generated barrel `src/game/bughouse/index.ts`. The directory is OWNED by this script: any other file in
 * it is stale or hand-written, and --check says so. Nothing outside it is ever touched, so this script and sync-fourplayer.mjs (which owns `src/game/fourPlayer/`) cannot
 * disturb each other.
 *
 * THE CLOSURE RULE is sync-fourplayer.mjs's `rewriteModule`: a mirrored file may import only another listed file, with an extensionless relative specifier. The one addition:
 * `../crazyhouse` is allowed, because the Crazyhouse rules block is NOT generated - it is a verbatim hand mirror (backend/src/game/crazyhouse.ts, guarded by test-crazyhouse.mjs) -
 * and the two trees have the same layout, so `bughouse/x.ts` importing `../crazyhouse` is `src/game/bughouse/x.ts` importing `../crazyhouse.js`. --check also demands that the
 * backend copy of such a file exists.
 *
 * Generated files are COMMITTED. Line endings: output is always LF, and --check compares with CRLF normalised on both sides.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BANNER_FIRST_LINE, SyncError, rewriteModule, toLf } from './sync-fourplayer.mjs';

export { SyncError, toLf };

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_DIR = path.resolve(HERE, '..');
export const DEFAULT_SOURCE_ROOT = path.resolve(BACKEND_DIR, '..', 'src', 'logic');
export const DEFAULT_OUT_ROOT = path.resolve(BACKEND_DIR, 'src', 'game');
export const MANIFEST_PATH = 'bughouse/MIRRORED_TO_BACKEND.json';
/** The generated directory is owned entirely by this script. */
export const OWNED_DIR = 'bughouse';
export const INDEX_PATH = `${OWNED_DIR}/index.ts`;
/** Modules a mirrored file may import although they are not generated here: mirrored verbatim by hand, guarded elsewhere. They must exist in the output root. */
export const EXTERNAL_MIRRORED = ['crazyhouse.ts'];

const FOURPLAYER_MANIFEST = 'fourPlayer/MIRRORED_TO_BACKEND.json';

/** Reads and validates the manifest of mirrored files (paths relative to the source root, '/'-separated, all under bughouse/). */
export function readManifest(sourceRoot) {
  const file = path.join(sourceRoot, MANIFEST_PATH);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new SyncError(`cannot read the mirror list ${file}: ${err.message}`);
  }
  const files = parsed?.files;
  if (!Array.isArray(files) || files.length === 0) throw new SyncError(`${MANIFEST_PATH}: "files" must be a non-empty array`);
  const seen = new Set();
  for (const entry of files) {
    if (typeof entry !== 'string' || !entry.endsWith('.ts') || entry.endsWith('.d.ts')) throw new SyncError(`${MANIFEST_PATH}: "${entry}" is not a .ts file path`);
    if (entry.includes('\\') || entry.startsWith('/') || entry.split('/').includes('..') || entry.includes('//')) throw new SyncError(`${MANIFEST_PATH}: "${entry}" must be a plain relative '/'-separated path`);
    if (!entry.startsWith(`${OWNED_DIR}/`)) throw new SyncError(`${MANIFEST_PATH}: "${entry}" is not under ${OWNED_DIR}/ - this generator owns only src/game/${OWNED_DIR}/`);
    if (entry === INDEX_PATH) throw new SyncError(`${MANIFEST_PATH}: "${INDEX_PATH}" is generated, do not list it`);
    if (seen.has(entry)) throw new SyncError(`${MANIFEST_PATH}: "${entry}" is listed twice`);
    seen.add(entry);
  }
  return files;
}

export function bannerFor(relPath) {
  return [
    BANNER_FIRST_LINE,
    `// Source: src/logic/${relPath} in the EM-Chess app repo. Regenerate with \`npm run sync:bughouse\`; CI runs it with --check.`,
    "// The only difference from the source is that relative imports carry the '.js' suffix NodeNext requires.",
    '',
    '',
  ].join('\n');
}

/** The barrel for the mirrored modules, in manifest order. */
export function generateIndex(files) {
  const lines = files.map((f) => `export * from './${path.posix.basename(f, '.ts')}.js';`);
  return `${bannerFor(INDEX_PATH)}/** Bughouse engine (server copy) - public surface. Only the modules listed in MIRRORED_TO_BACKEND.json. */\n${lines.join('\n')}\n`;
}

/** Everything that should exist: a Map of output path (relative to the output root, '/'-separated) -> file content. Writes nothing. */
export function generate({ sourceRoot = DEFAULT_SOURCE_ROOT } = {}) {
  const files = readManifest(sourceRoot);
  const mirrored = new Set([...files, ...EXTERNAL_MIRRORED]);
  const problems = [];
  const out = new Map();
  for (const relPath of files) {
    const file = path.join(sourceRoot, ...relPath.split('/'));
    if (!fs.existsSync(file)) {
      problems.push(`${relPath}: listed in ${MANIFEST_PATH} but ${file} does not exist`);
      continue;
    }
    try {
      // rewriteModule's messages name the 4 Player manifest; this generator's is another file
      out.set(relPath, bannerFor(relPath) + rewriteModule(relPath, toLf(fs.readFileSync(file, 'utf8')), mirrored));
    } catch (err) {
      if (!(err instanceof SyncError)) throw err;
      problems.push(err.message.split(FOURPLAYER_MANIFEST).join(MANIFEST_PATH));
    }
  }
  if (problems.length > 0) throw new SyncError(problems.join('\n'));
  out.set(INDEX_PATH, generateIndex(files));
  return out;
}

/** Every file the generator is responsible for on disk: all of the owned directory. */
const ownedFilesOnDisk = (outRoot) => {
  const dir = path.join(outRoot, OWNED_DIR);
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((name) => `${OWNED_DIR}/${name}`) : [];
};

const firstDifference = (expected, actual) => {
  const a = expected.split('\n');
  const b = actual.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return `line ${i + 1}: expected ${JSON.stringify(a[i] ?? '(end of file)')}, found ${JSON.stringify(b[i] ?? '(end of file)')}`;
  }
  return 'contents differ';
};

/** Compares the generated set with what is on disk. Returns a list of problems (empty = in sync). Changes nothing. */
export function check({ sourceRoot = DEFAULT_SOURCE_ROOT, outRoot = DEFAULT_OUT_ROOT } = {}) {
  const expected = generate({ sourceRoot });
  const problems = [];
  for (const [rel, content] of expected) {
    const file = path.join(outRoot, ...rel.split('/'));
    if (!fs.existsSync(file)) {
      problems.push({ file: rel, kind: 'missing', detail: 'not generated yet' });
      continue;
    }
    const actual = toLf(fs.readFileSync(file, 'utf8'));
    if (actual !== content) problems.push({ file: rel, kind: 'different', detail: firstDifference(content, actual) });
  }
  for (const rel of ownedFilesOnDisk(outRoot)) {
    if (!expected.has(rel)) problems.push({ file: rel, kind: 'stale', detail: `not produced by the generator (hand-written, or no longer listed in ${MANIFEST_PATH})` });
  }
  // a module a mirrored file may import without listing it must exist on the server side too, or the generated file would not build there
  const importsExternal = (text, name) => text.includes(`'../${name.slice(0, -'.ts'.length)}.js'`);
  for (const name of EXTERNAL_MIRRORED) {
    const used = [...expected.values()].some((text) => importsExternal(text, name));
    if (used && !fs.existsSync(path.join(outRoot, name))) problems.push({ file: name, kind: 'missing', detail: 'imported by a mirrored file, but the server copy does not exist' });
  }
  return problems;
}

/** Writes the generated set (LF) and deletes stale files in the owned directory. Returns the files whose content changed. */
export function write({ sourceRoot = DEFAULT_SOURCE_ROOT, outRoot = DEFAULT_OUT_ROOT } = {}) {
  const expected = generate({ sourceRoot });
  const changed = [];
  for (const [rel, content] of expected) {
    const file = path.join(outRoot, ...rel.split('/'));
    const before = fs.existsSync(file) ? toLf(fs.readFileSync(file, 'utf8')) : null;
    if (before === content) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    changed.push(rel);
  }
  for (const rel of ownedFilesOnDisk(outRoot)) {
    if (expected.has(rel)) continue;
    fs.rmSync(path.join(outRoot, ...rel.split('/')));
    changed.push(`${rel} (removed)`);
  }
  return changed;
}

/** The CLI, with its inputs and outputs injectable so the tests can drive every exit path. Returns the exit code: 0 ok / written, 1 `--check` found drift, 2 the generator could not run. */
export function run({ argv = [], sourceRoot = DEFAULT_SOURCE_ROOT, outRoot = DEFAULT_OUT_ROOT, log = console.log, error = console.error } = {}) {
  try {
    if (argv.includes('--check')) {
      const problems = check({ sourceRoot, outRoot });
      if (problems.length === 0) {
        log(`Bughouse mirror is in sync (${generate({ sourceRoot }).size} generated files).`);
        return 0;
      }
      error('Bughouse mirror is OUT OF SYNC with the app source:');
      for (const p of problems) error(`  ${p.kind.padEnd(9)} src/game/${p.file}  -  ${p.detail}`);
      error('Run `npm run sync:bughouse` in the backend and commit the result (never edit the generated files by hand).');
      return 1;
    }
    const changed = write({ sourceRoot, outRoot });
    log(changed.length === 0 ? 'Already up to date.' : `Updated ${changed.length} file(s):\n${changed.map((c) => `  src/game/${c}`).join('\n')}`);
    return 0;
  } catch (err) {
    if (!(err instanceof SyncError)) throw err;
    error(`sync-bughouse: cannot generate -\n${err.message}`);
    return 2;
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) process.exitCode = run({ argv: process.argv.slice(2) });
