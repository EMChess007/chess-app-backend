# Testing & Quality Infrastructure — Backend

This repo (`chess-app-backend`) and its sibling frontend repo (`EM-Chess`) are tested together in
several places, because some of this backend's own test scripts import the frontend's chess logic
directly (see "Why some backend tests import frontend code" below). This document covers what
exists in **this repo**; see the frontend's own `TESTING.md` for its half of the picture.

## 1. What runs on every commit/PR (`.github/workflows/ci.yml`)

Triggers on every push/PR to `main`. One job:

1. Checks out **both** repos into the same relative layout as local development
   (`chess-app/` = frontend, `chess-app/backend/` = this repo) — required because several test
   scripts import `../../src/logic/ChessEngine.ts` directly.
2. `npm ci` in both.
3. Spins up a real Postgres via a GitHub Actions service container, runs `prisma generate` +
   `prisma migrate deploy`.
4. `tsc --noEmit`.
5. Starts the dev server, waits for `/health`.
6. Runs the full E2E suite:
   - `scripts/test-multiplayer.mjs` (111 checks) — matchmaking, move sync, disconnect/reconnect,
     clock timeout, Chess960, King of the Hill, Three-Check, Setup Chess, and Fog of War
     (redaction, king-safety bypass, king-capture win), all against the real socket protocol.
   - `scripts/test-tournament.mjs` (40 checks) — round-robin pairing, standings, variant flags
     threading through lobby → match.
   - The four Fog of War regression scripts (below).
   - `npm run test:giveaway` (`scripts/test-giveaway.mjs`, no server needed) — Giveaway's rules on the
     server's own implementation, the server-as-authority checks (`RoomManager.applyMove` rejecting any
     non-capturing move while a capture is mandatory, declaring the stuck-wins winner, refusing king
     promotion outside Giveaway), and a parity run replaying random Giveaway games through BOTH the
     mobile app's and the server's implementation (legal moves, SAN, FEN and winner must agree at every ply).
   - `npm run test:atomic` (`scripts/test-atomic.mjs`, no server needed) — Atomic's server side: a **no-drift
     check** that the rules block of `src/game/atomic.ts` is byte-identical to the mobile app's
     `src/logic/atomic.ts` (hand-mirrored, no shared module), `RoomManager.applyMove` as the authority
     (king captures and blasts reaching the mover's own king refused, king explosion = reason `atomic`, mate/
     stalemate/insufficient material/50-move/threefold from the room's FEN history, forged king promotion
     refused, castling next to the enemy king), and parity with the mobile app over 100 random capture-biased
     games. (The rules themselves are verified against chessops by the mobile suite.)

**This blocks merges only once branch protection is turned on in the GitHub repo settings** — that
one step needs a human with admin access to this repo (`Settings → Branches → Branch protection
rules → Require status checks to pass before merging`, selecting the `test` job from this
workflow). No file in this repo can configure that remotely.

## 2. Nightly extended fuzz (`.github/workflows/nightly.yml`)

Runs at 03:00 UTC daily (plus `workflow_dispatch` for a manual run from the Actions tab). Same
checkout/Postgres setup as CI, then:

- `scripts/nightly-fuzz-logic.mjs` — **3,000** randomized Fog of War games, up to 80 plies each,
  checking every pseudo-legal candidate at every ply against both `ChessEngine.ts` and
  `RoomChessEngine.ts`, plus the same number of Giveaway games run through both implementations in
  lockstep (parity of legal moves/SAN/FEN/winner), and the same for Atomic. (CI's own regression tests use far smaller counts — 6-80 games — to stay
  fast on every commit; this is the same methodology at a scale only a schedule can afford.)
- `scripts/nightly-fuzz-online.mjs` — **200** real Fog of War games plus **200** real Giveaway games
  plus **200** real Atomic games played end-to-end through the actual running server/socket protocol (not a simulation), checking for
  genuine client/server desyncs (as opposed to the one *expected* class — see §5). In Giveaway every
  move comes from the mobile app's own legal-move set and must be accepted; ~30% of turns also first
  submit a deliberately illegal move (a non-capturing move while a capture is mandatory) which the
  server must refuse, and every `game_over` must match the mobile app's own winner detection. Atomic is
  fuzzed the same way (illegal probes are pseudo-legal moves Atomic forbids; `game_over` reasons `atomic`/
  `checkmate`/`stalemate`/`draw` must match the mobile app's own judgement).

**Visibility when something fails:**
- Both scripts write a markdown report (`nightly-fuzz-report.md`, `nightly-fuzz-online-report.md`)
  uploaded as a workflow artifact on every run (pass or fail), kept 90 days.
- On failure, the workflow opens (or updates) a single GitHub issue labeled `nightly-fuzz` with
  both reports embedded — and closes it automatically the next time the run passes.
- GitHub also emails the workflow file's last editor whenever a scheduled run fails, with no
  extra setup, as a second, zero-config signal.

## 3. The permanent regression test suite (`scripts/test-fogOfWar*.mjs`)

All found-and-fixed during this project's own debugging history — kept permanently so none of
these can silently regress. Each is also an `npm run test:<name>` script.

| Script | Catches |
|---|---|
| `test-fogOfWarEnPassant.mjs` | chess.js's `.fen()` silently dropping the en-passant square whenever the capture would expose the king — the exact "shown as a legal dot, rejected when played" bug this variant is most at risk of, for en passant specifically. Fixed via `.fen({ forceEnpassantSquare: true })`. |
| `test-fogOfWarPerformance.mjs` | `getPseudoLegalMoves`/`movePseudoLegal` wrapping every scanned candidate in a full chess.js `Move` (which eagerly computes SAN via a complete legal-move regeneration) instead of only the one that matched — measured ~10x per-call cost before the fix. Asserts `movePseudoLegal`'s median cost stays within 3x of `move()`'s. |
| `test-fogOfWarRedactionHistory.mjs` | A historical move-list entry, correctly recorded as hidden when played, ever being retroactively revealed once the viewer later gains reach over that square. Investigated directly (not just comparing the incremental and full-replay implementations against each other, which can't catch a bug shared by both) — not confirmed, kept as a permanent guard. |
| `test-fogOfWarVisibilityGroundTruth.mjs` | Checks `getPseudoLegalMoves`/`getVisibleSquares` against hand-verified chess positions — pawn reach (diagonal-only, blocked-push exclusion, en passant), sliding-piece blocking (inclusive of the blocker, own vs. enemy), pinned pieces still showing full reach (visibility ≠ legality), and a king being in check NOT restricting any other piece's reach (confirms pseudo-legal filtering is used consistently, never silently falling back to legal-move filtering). |

## 4. Known, discovered, still-open: Fog of War Online's "information leak" report

A player reported (without an exact reproducible move sequence) once seeing an opponent's move
with its real SAN in the move list when it should have shown "?". Investigated at length:

- The redaction algorithm's "revealed" decision was verified against ground truth, not just
  cross-implementation agreement (§3's last two rows) — no bug found.
- The leading hypothesis that still fits: Fog of War's own visibility rule is "every square a
  piece could move to or capture on, even while currently empty, counts as visible" — so a knight
  (say) already reaching a square makes that square's *eventual* occupant visible the moment it
  lands, which is surprising if you expect visibility to mean "a piece is physically there right
  now," but is the rule as designed.
- **Debug capture added for next time**: Local/Bot/Online games now log one line per ply to the
  app's existing diagnostic log (`More → Diagnostics` in the mobile app) — mover, real SAN/
  destination, and each relevant perspective's `revealed` flag + full visibility set at that
  moment. If this recurs, that log (copyable from the device) replaces relying on memory.
- **Status: open, unconfirmed.** Not a known bug with a known fix — a reported symptom without
  a reproduction, investigated as far as it can be without one.

## 5. A real bug *found* by the new nightly online fuzz, already understood (not a regression to fix)

While building `nightly-fuzz-online.mjs`, it immediately found: a quiet (non-capturing) pawn push
whose target square is fogged (not occupied by the mover's own pieces or their reach) can be
offered by the client's own local pseudo-legal generation — built from the server's redacted FEN,
which renders a fogged square the same blank way as a genuinely empty one — and then rejected by
the server, which knows the square is actually occupied. This is Fog of War's own "blind move that
turns out blocked" mechanic working as intended (real fog-of-war chess variants have exactly this
property — you don't know a square is occupied until you try), not a desync; the script now
classifies it separately (`expected-blind-pawn-push-blocked-by-fog`, ~1-2% of plies) so the
nightly run doesn't fail over normal gameplay. Whether the client's error messaging for this case
(currently a generic "Invalid move" + revert) deserves clearer UX is a product question, not
something fixed here.

## 6. Diagnostic logging (`src/game/fogOfWar.ts`'s mobile-app twin, `src/logic/diagnosticLog.ts`)

Extended on the mobile app side this round — see the frontend's own TESTING.md §4. This backend
repo doesn't have its own equivalent user-facing log (it's a server; its own `console.log`/stdout,
visible in `server.log` in CI or wherever it's hosted, already serves that role).

## 7. Crash/error reporting (Sentry)

Lives entirely in the frontend repo — see its own TESTING.md. This backend has no client-facing
crash path of its own to instrument the same way; a server crash shows up as a dead process/502s
to clients, caught by ordinary hosting-platform monitoring rather than Sentry.

## 8. Subsystem coverage audit — what's covered, what's a known gap

| Subsystem | Coverage | Notes |
|---|---|---|
| Chess engine / move generation | Strong | Ground-truth (§3), large-scale fuzz (§2), pinned down against real chess rules, not just internal consistency. |
| Fog of War — Local/Bot | Strong (client-side) | See frontend TESTING.md — these use the same `ChessEngine.ts` tested here. |
| Fog of War — Online | Strong | `test-multiplayer.mjs`'s dedicated Fog of War test (redaction, king-safety bypass, win condition) + the nightly online fuzz (real server, hundreds of games). |
| Multiplayer sync / reconnect | Good | `test-multiplayer.mjs` covers disconnect → grace period → reconnect → rejoin with the correct seat/fen/turn restored, plus a bogus-token rejection. Does **not** cover every possible timing of a disconnect mid-move or a double-reconnect race — a known, narrower gap. |
| Matchmaking (all variants) | Good | Isolated-queue tests per variant (classical/Chess960/King of the Hill/Three-Check/Setup Chess/Fog of War) confirm cross-variant players never get matched together. |
| Tournaments | Good | Full 3-player round robin, pairing progression, standings, variant-flag threading (`test-tournament.mjs`). Does not cover larger brackets (4+ players) or a player disconnecting mid-tournament. |
| Clocks / timeout | Basic | One scripted timeout scenario confirmed end-to-end; no systematic fuzz of clock arithmetic edge cases (e.g. increment timing right at 0ms remaining). |
| Puzzle mode, Analysis mode, Engine-vs-Engine, Spectator, Premoves, Undo | None in this repo | These are mobile-app UI/orchestration concerns with little-to-no server involvement — see frontend TESTING.md for their (also partial) coverage. |

Nothing above claims equal depth everywhere — chess engine correctness and Fog of War got the
deepest investment this round because that's where every bug this project has actually found so
far has lived; the rest is covered to the extent a focused pass could reach, with gaps named
rather than hidden.
