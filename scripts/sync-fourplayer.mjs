#!/usr/bin/env node
/**
 * Generates the backend's copy of the 4 Player Chess engine and wire contract from the mobile app's source, so the two can never drift.
 *
 *   npm run sync:fourplayer              rewrite the generated files
 *   npm run sync:fourplayer -- --check   change nothing; exit 1 if any generated file is missing, different or stale (CI runs this)
 *
 * WHY GENERATED, NOT HAND-MIRRORED. The backend is `module: NodeNext`, which requires explicit `.js` suffixes on relative imports; the
 * app's engine uses extensionless imports (Metro / vitest). A byte-identical hand copy is therefore impossible, and hand-copying is
 * exactly how two implementations of one rule set drift. Instead the app's files are the ONLY source of truth and this script derives
 * the backend files from them with EXACTLY ONE transform: every relative module specifier `'./x'` becomes `'./x.js'`. A generated-file
 * banner is prepended; nothing else changes (not a line, not a comment).
 *
 * WHAT IS COPIED is listed in the app repo's `src/logic/fourPlayer/MIRRORED_TO_BACKEND.json` (the owner of the source owns the list; the
 * app's own tests read the same file). Source root = `../src/logic` (the layout CI recreates: EM-Chess checked out with this repo
 * nested at `backend/`), output root = `src/game`; the same relative path is kept, so `src/logic/fourPlayer/board.ts` becomes
 * `src/game/fourPlayer/board.ts`. A barrel `src/game/fourPlayer/index.ts` is generated for the `fourPlayer/` modules.
 *
 * THE CLOSURE RULE (what keeps client-only code off the server): every import in a mirrored file must be a relative specifier with NO
 * extension that resolves to another mirrored file. Anything else — a package, a file outside the list (e.g. `./setup`, which pulls in
 * UI types), a specifier that already has an extension, a directory import, a dynamic `import()`, `require`, `import x = require()`, an
 * `import('…').T` type — makes the script fail loudly (exit 2) instead of producing a file that would not build or would drag
 * client code into the server.
 *
 * Generated files are COMMITTED (the backend builds and deploys on its own and never needs the app repo at runtime); the `--check`
 * run is what makes committing them safe. Line endings: output is always LF, and `--check` compares with CRLF normalised on both
 * sides, because a Windows checkout with autocrlf rewrites the committed files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_DIR = path.resolve(HERE, '..');
export const DEFAULT_SOURCE_ROOT = path.resolve(BACKEND_DIR, '..', 'src', 'logic');
export const DEFAULT_OUT_ROOT = path.resolve(BACKEND_DIR, 'src', 'game');
export const MANIFEST_PATH = 'fourPlayer/MIRRORED_TO_BACKEND.json';
/** The generated directory is owned entirely by this script: any other file in it is stale or hand-written, and --check says so. */
export const OWNED_DIR = 'fourPlayer';
export const INDEX_PATH = `${OWNED_DIR}/index.ts`;

export class SyncError extends Error {}

export const toLf = (text) => text.split('\r\n').join('\n');

/** Reads and validates the manifest of mirrored files (paths relative to the source root, '/'-separated). */
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
    if (entry === INDEX_PATH) throw new SyncError(`${MANIFEST_PATH}: "${INDEX_PATH}" is generated, do not list it`);
    if (seen.has(entry)) throw new SyncError(`${MANIFEST_PATH}: "${entry}" is listed twice`);
    seen.add(entry);
  }
  return files;
}

export function bannerFor(relPath) {
  return [
    BANNER_FIRST_LINE,
    `// Source: src/logic/${relPath} in the EM-Chess app repo. Regenerate with \`npm run sync:fourplayer\`; CI runs it with --check.`,
    "// The only difference from the source is that relative imports carry the '.js' suffix NodeNext requires.",
    '',
    '',
  ].join('\n');
}

/**
 * Returns `text` (a mirrored file's source, LF) with `.js` appended inside every relative module specifier, after checking the closure
 * rule. `mirrored` is the set of manifest paths; `relPath` is this file's own manifest path (specifiers resolve against its directory).
 */
export function rewriteModule(relPath, text, mirrored, { allowedPackages = [] } = {}) {
  const sf = ts.createSourceFile(relPath, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const edits = []; // string positions where '.js' is inserted (just before the closing quote)
  const problems = [];
  const where = (node) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return `${relPath}:${line + 1}`;
  };

  const handleSpecifier = (literal) => {
    const spec = literal.text;
    if (allowedPackages.includes(spec)) return; // a package the caller has named (the 4 Player mirror names none; the Bughouse mirror names chess.js): left exactly as written
    if (!spec.startsWith('./') && !spec.startsWith('../')) {
      problems.push(`${where(literal)}: imports "${spec}" - only relative imports of mirrored files are allowed (no packages, no node: modules)`);
      return;
    }
    if (path.posix.extname(spec) !== '') {
      problems.push(`${where(literal)}: "${spec}" already has an extension - mirrored sources use extensionless relative imports`);
      return;
    }
    const resolved = `${path.posix.normalize(path.posix.join(path.posix.dirname(relPath), spec))}.ts`;
    if (!mirrored.has(resolved)) {
      problems.push(`${where(literal)}: imports "${spec}" (${resolved}) which is not in ${MANIFEST_PATH} - client-only code must not reach the server (or list it, if it is meant to be mirrored)`);
      return;
    }
    edits.push(literal.end - 1);
  };

  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) handleSpecifier(node.moduleSpecifier);
      else problems.push(`${where(node)}: a module specifier that is not a string literal`);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      problems.push(`${where(node)}: "import x = require(...)" is not supported in mirrored files`);
    } else if (ts.isImportTypeNode(node)) {
      problems.push(`${where(node)}: "import('...').T" types are not supported in mirrored files - use a normal import type`);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      problems.push(`${where(node)}: dynamic import() / require() is not supported in mirrored files`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  if (problems.length > 0) throw new SyncError(problems.join('\n'));

  let out = text;
  for (const position of edits.sort((a, b) => b - a)) out = `${out.slice(0, position)}.js${out.slice(position)}`;
  return out;
}

/** The barrel for the mirrored `fourPlayer/` modules, in manifest order (the app's own index also exports its client-only modules; those are not here). */
export function generateIndex(files) {
  const lines = files.filter((f) => f.startsWith(`${OWNED_DIR}/`)).map((f) => `export * from './${path.posix.basename(f, '.ts')}.js';`);
  return `${bannerFor(INDEX_PATH)}/** 4 Player Chess engine (server copy) - public surface. Only the modules listed in MIRRORED_TO_BACKEND.json. */\n${lines.join('\n')}\n`;
}

/** Everything that should exist: a Map of output path (relative to the output root, '/'-separated) -> file content. Writes nothing. */
export function generate({ sourceRoot = DEFAULT_SOURCE_ROOT } = {}) {
  const files = readManifest(sourceRoot);
  const mirrored = new Set(files);
  const problems = [];
  const out = new Map();
  for (const relPath of files) {
    const file = path.join(sourceRoot, ...relPath.split('/'));
    if (!fs.existsSync(file)) {
      problems.push(`${relPath}: listed in ${MANIFEST_PATH} but ${file} does not exist`);
      continue;
    }
    try {
      out.set(relPath, bannerFor(relPath) + rewriteModule(relPath, toLf(fs.readFileSync(file, 'utf8')), mirrored));
    } catch (err) {
      if (!(err instanceof SyncError)) throw err;
      problems.push(err.message);
    }
  }
  if (problems.length > 0) throw new SyncError(problems.join('\n'));
  out.set(INDEX_PATH, generateIndex(files));
  return out;
}

/** First line of every generated file; also how a generated file OUTSIDE the owned directory (the wire file) is recognised as ours. */
export const BANNER_FIRST_LINE = '// GENERATED FILE - DO NOT EDIT BY HAND.';

/**
 * Every file the generator is responsible for on disk: all of the owned directory, plus any top-level `.ts` in the output root that
 * carries our banner (so de-listing a root-level mirrored file, like the wire file, makes its old copy "stale" instead of lingering
 * for ever). A top-level file WITHOUT the banner is hand-written backend code and is never touched.
 */
const ownedFilesOnDisk = (outRoot) => {
  const owned = [];
  const dir = path.join(outRoot, OWNED_DIR);
  if (fs.existsSync(dir)) owned.push(...fs.readdirSync(dir).map((name) => `${OWNED_DIR}/${name}`));
  if (fs.existsSync(outRoot)) {
    for (const entry of fs.readdirSync(outRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const firstLine = toLf(fs.readFileSync(path.join(outRoot, entry.name), 'utf8')).split('\n', 1)[0];
      if (firstLine === BANNER_FIRST_LINE) owned.push(entry.name);
    }
  }
  return owned;
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

/** The CLI, with its inputs and outputs injectable so the tests can drive every exit path. Returns the exit code: 0 ok / written,
 * 1 `--check` found drift, 2 the generator could not run (closure rule broken, unreadable source). */
export function run({ argv = [], sourceRoot = DEFAULT_SOURCE_ROOT, outRoot = DEFAULT_OUT_ROOT, log = console.log, error = console.error } = {}) {
  try {
    if (argv.includes('--check')) {
      const problems = check({ sourceRoot, outRoot });
      if (problems.length === 0) {
        log(`4 Player mirror is in sync (${generate({ sourceRoot }).size} generated files).`);
        return 0;
      }
      error('4 Player mirror is OUT OF SYNC with the app source:');
      for (const p of problems) error(`  ${p.kind.padEnd(9)} src/game/${p.file}  -  ${p.detail}`);
      error('Run `npm run sync:fourplayer` in the backend and commit the result (never edit the generated files by hand).');
      return 1;
    }
    const changed = write({ sourceRoot, outRoot });
    log(changed.length === 0 ? 'Already up to date.' : `Updated ${changed.length} file(s):\n${changed.map((c) => `  src/game/${c}`).join('\n')}`);
    return 0;
  } catch (err) {
    if (!(err instanceof SyncError)) throw err;
    error(`sync-fourplayer: cannot generate -\n${err.message}`);
    return 2;
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) process.exitCode = run({ argv: process.argv.slice(2) });
