@AGENTS.md

# EM-Chess — backend (`chess-app-backend`). Short on purpose; the long docs are linked, not copied.

## WHAT
Node >= 22 / TypeScript server for the EM-Chess app: Express REST (auth, games, puzzles, users) + socket.io rooms for every online mode,
Prisma + PostgreSQL. Production = Render (server) + Neon (DB) + Sentry; sessions NEVER touch them. The app repo is `EM-Chess`
(the frontend); in the cloud this repo lives at `<app>/backend`. Game rules exist in BOTH repos and must agree.

## SESSION START (always)
1. `git fetch origin` and branch from the fresh remote: `git checkout -B <branch> origin/main`. Never from an old local branch.
2. From the app repo: `bash scripts/cloud-setup.sh` (idempotent; starts local PostgreSQL, creates test-only `.env`, runs Prisma).
3. If `package-lock.json` changed or `tsc` errors appear in files you did not touch: `npm ci` first.
4. Read `CHECKLIST.md` before implementing or reviewing anything. Docs: `AGENTS.md`, `TESTING.md` (huge: `grep -n '^## '`, read one section).

## HARD RULES
- Never connect to Neon / Render. `.env` is test-only, git-ignored, never committed, never printed. Local database only.
- File edits ONLY with Edit / Write (no heredoc / sed / python / node -e writes).
- `src/game/fourPlayer/*` and `src/game/bughouse/*` are GENERATED from the app source (`npm run sync:fourplayer` / `sync:bughouse`): never edit them here.
- The build must work with `NODE_ENV=production` (`tsc`, `prisma`, `@types/*` stay in `dependencies`; `npm run check:productionInstall`).
- Test-only switches follow CHECKLIST.md section 7 (opt-in name, ignored in production, finite value, never in workflows or `.env.example`).
- Every task finishes in < 1 hour; if it won't, do what fits, push cleanly, report what remains.
- Grep before reading; never dump big logs into the conversation (save to a file, grep it).
- Run locally ONLY the scripts related to the change + `npx tsc --noEmit`; full suites run in CI.
  Examples: `npm run test:horde`, `npm run test:crazyhouse`, `npm run test:multiplayer`, `npm run test:fourplayerOnline`.
- Heavy gates (mutation, repeated 3/3 runs, nightly fuzz) only when the user asks.
- Push, then report at once. Never wait on or poll CI.
- One branch per task, PR to `main`, never merge, never force-push, never skip the pre-push hook on a final commit.
- The user merges only when CI is green (backend `test`, `security-audit`, plus the app's checks for a paired change).
- Tests never touch :3000 / :8081 / :8082 or a deployed backend; they delete the accounts they register.

## MAP (`src/`)
- `index.ts` server bootstrap; `routes/` REST (`auth`, `games`, `puzzles`, `users`); `middleware/auth.ts`; `lib/` JWT, Prisma client, rate limiters.
- `game/` everything real-time:
  - 2-player: `rooms.ts` (RoomManager, clocks, abandonment), `matchmaking.ts` (queue key `timeControl|variant`), `challenges.ts`,
    `socketHandlers.ts`, `tournaments.ts`, `RoomChessEngine.ts` (server twin of the client engine), `types.ts` (variant flags on the wire),
    `repetition.ts`, `pgn.ts`, `setupChess*.ts`; one file per variant (`atomic`, `crazyhouse`, `horde`, `duckChess`, `fogOfWar`, `giveaway`,
    `spellChess`, `chess960`). A new variant touches `types.ts`, `<variant>.ts`, `RoomChessEngine.ts`, `matchmaking.ts`, `challenges.ts`,
    `rooms.ts`, `socketHandlers.ts`, `tournaments.ts`; copy `scripts/test-horde.mjs` and add a case to `test-multiplayer.mjs` + nightly fuzz.
  - 4-seat engine (4 Player / Giveaway / Chaturaji): `fourPlayer/` (GENERATED), `fourPlayer{Rooms,Handlers,Matchmaking,RoomWire,Wire,Config}.ts`,
    friend rooms `friendRooms.ts`. Spec: app repo FOUR_PLAYER_*_SPEC.md, CHATURAJI_SPEC.md.
  - Crazy Bughouse: `bughouse/` (GENERATED), `bughouse{Rooms,Handlers,Matchmaking,FriendRooms,Config,RoomLimiter}.ts`. Spec: app repo BUGHOUSE_SPEC.md.
- Time controls: the shared list lives in the app (`src/logic/timeControls.ts`); the server validates ids (`isUnlimitedTimeControl` in `rooms.ts`).
- `prisma/` schema + migrations; `scripts/` = test scripts (`test-*.mjs`), sync scripts, `e2e-browser/` (own private stack on its own ports),
  nightly fuzz. CI: `.github/workflows/ci.yml`, `nightly.yml`, `security-audit.yml`.
- Test-only switches: `fourTestSwitches.ts`, `bughouseTestSwitches.ts`, `lib/authRateLimit.ts`.

## REPORT FORMAT (Greek, <= 10 lines)
What changed; tests run; branch + commit + PR link; anything not done; what to check on the phone. No logs, no file lists.

## ROADMAP
Server side of the app roadmap (details: app repo CLAUDE.md): Racing Kings, Torpedo, Knightmate (one per task); From Position; Capablanca 10x8
and 3/5/6-player and Diddy Chess (plan first); then bots/analysis for all variants, rating from online games only.
v2 backlog: Daily-online persistence (rooms are in-memory; see app TODO.md), chained premoves, large-perf process death (UNPROVEN).
