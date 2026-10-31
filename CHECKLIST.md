# EM-Chess — Definition of Done

Applies to every change in this repo or chess-app-backend — a new game variant, a UI tweak, a
backend endpoint, a refactor, anything. Not done until it clears every section below. This
exists because Fog of War cost real hours on problems that should have been caught before it
was called "done" — don't repeat that on anything else.

## 1. Spec before code
- Write 3-5 sentences: exactly what changes, and which existing code/infrastructure is reused
  vs. genuinely new.
- State explicitly how this interacts with existing features it could plausibly combine or
  conflict with (other variants, bots, Online mode, analysis, puzzles) — never a silent
  assumption that it's independent. (Fog of War + Chess960 are explicitly non-combinable today —
  that's the kind of thing that needs to be said out loud, not discovered later.)

## 2. Correctness
- Explicit list of edge cases this change touches, with a test for each.
- For anything chess-logic-related specifically: en passant, promotion, castling, undo/redo, FEN
  serialization/reload (especially if a king can be missing/captured — see Fog of War's
  skipValidation precedent).
- New or updated tests in the matching __tests__ file; add cases to gameModes.test.ts if this
  changes getGameOutcome.

## 3. Performance
- Anything on a hot path (every render, every move, every keystroke, a long list) tested against
  realistic scale (e.g. a 40+ move game), not just the happy-path demo. If something recomputes
  from scratch on every render instead of incrementally, flag it before merge — don't wait for a
  lag report to find out.

## 4. Online/backend parity
- If it touches Online mode: client and server logic kept in sync, with their own side-by-side
  tests (the way RoomChessEngine mirrors the client for Fog of War) — not "seems to work in a
  manual demo".

## 5. CI / cross-feature impact
- tsc and vitest stay green.
- If it affects bots: explicit decision on whether Stockfish can be reused as-is or needs a
  custom heuristic — never a silent assumption that "it'll probably work".
- Explicit check: does this break bots, analysis mode, PGN export/import, game history, or
  puzzles? All of those already exist and a new change can break them without anyone noticing.

## 6. Documentation
- A doc-comment explaining why this exists and any non-obvious gotchas, same style as the
  existing code — so the next session (you, future Claude Code) doesn't rediscover the same
  traps from zero.

### Extra, specifically when the change is a new game variant/mode
- Explicit mutual-exclusivity declaration with every other variant. Every variant-wide statement or list
  names ALL of them, the 4-seat games included (4 Player Chess, 4 Player Giveaway, Chaturaji): menu card,
  setup, queue (the queue key is `timeControl|variant`), Spectate list section, rejoin, resume link, result.
- Fits the existing pattern: VariantSelector entry, screen prop threading (fogOfWar/chess960/
  setupChess-style), gameResult.ts priority slot.

## 7. Test-only switches (a knob that exists for tests must not exist in production)
- A test-only environment variable is read in ONE small module, has an opt-in name that says what it does, is
  ignored when `NODE_ENV=production` (one warning at startup that does not print the value), only accepts a
  finite value inside a bound (it can raise a limit, never switch it off), is set only by the test stack's own
  child process (never in a workflow `env`, `.env.example`, `render.yaml` or any deployment config), and has
  tests for: the default unchanged, ignored in production, honoured outside it, no secret read or logged.
- **Auth rate-limit override absent/ignored in production**: `AUTH_RATE_LIMIT_TEST_OVERRIDE`
  (`src/lib/authRateLimit.ts`); `npm run test:authRateLimit` pins all of the above (CI runs it).

## 8. Zero known vulnerabilities in the dependencies (command #31): "done" means `security-audit` is green
- **No report may say "done", "ready" or "green" unless the `security-audit` check (`.github/workflows/security-audit.yml`, here and in the app repo) is green on the FINAL commit** of the branch, with the
  run's link in the report. It runs `npm ci` and a bare `npm audit`: every severity (low included), production AND development dependencies, no `--omit`, no `--audit-level`, no `continue-on-error`. It also
  runs every Monday, because a new advisory against a package we already ship needs no commit of ours.
- "Accepted risk" does not exist. A red run is fixed, in this order: (a) upgrade the direct dependency to a fixed version; (b) an npm `overrides` pin of the transitive package, after the suites pass with
  it; (c) remove the dependency, or replace it with a maintained one that does the same job; (d) a minimal reviewed patch (`patch-package`) or a vendored copy, with a test that proves the vulnerable
  path is closed. If none of them works without breaking the server, STOP and report that one item with the concrete options. Never `npm audit fix --force` (a test scans for it).
- `npm run test:securityAudit` pins the guard's shape (the job, its bare audit, the weekly schedule, the grouped Dependabot config, the fixed versions in the lock; CI runs it), so it cannot be weakened
  quietly. Dependabot SECURITY updates are grouped into one pull request (`.github/dependabot.yml`); version updates stay off.
- Install scripts are decided, not ignored: npm 11 skips a dependency's install script unless `allowScripts` in `package.json` says so, and warns about every package it has no entry for. A new package
  with an install script gets a reviewed entry (`npm install-scripts approve <pkg>` or `deny`), and `npm ci` must print no "install scripts not yet covered" warning.
- A secret that ever reached git is rotated by the owner, not "removed": the history is scanned (gitleaks) and a finding is reported by file and rule, never by value.
