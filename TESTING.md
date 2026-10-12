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
   - `npm run test:duck` (`scripts/test-duck.mjs`, no server needed) — Duck Chess's server side: a **no-drift
     check** of the shared rules block in `src/game/duckChess.ts` against the mobile `src/logic/duckChess.ts`,
     `RoomManager.applyMove` as the authority (a turn is a move AND the duck's square: a missing, occupied or
     unchanged duck square refuses the WHOLE turn, moves the duck blocks are refused, king capture = reason
     `duckChess` with no placement, blockade = draw, castling blocked across the duck but not by attacks), and
     parity with the mobile app over 100 random games (legal moves, legal duck squares, SAN, FEN, blockade).
   - `npm run test:unlimited` (`scripts/test-unlimited.mjs`, no server needed) — "No time limit" (live-only, no clock):
     time-control validation (finite numbers; an unlimited control may have no increment), an unlimited room's clock
     never ticks or gains an increment and schedules no timeout (move acks, `opponent_move` and rejoin payloads all
     carry the untouched sentinel, with a timed room as the control), exact-match pairing, and abandonment still
     applying (it is not Daily). Mutation-checked: breaking the clock guard, the timer guard or the validator each
     fails it.
   - `npm run test:rejoinFinished` (`scripts/test-rejoin-finished.mjs`, no server needed) — rejoin after the game ended (see
     "Rejoin after the game ended" below); the real-socket half lives in `scripts/test-multiplayer.mjs`.
   - `npm run sync:fourplayer -- --check` — the generated 4 Player engine + wire copy matches the app source (see §10); a stale,
     hand-edited, missing or stray generated file fails the build. Run right after the type-check.
   - `npm run test:fourplayerSync` (`scripts/test-fourplayer-sync.mjs`, no server needed) — the generator itself: transform, closure rule,
     drift detection, CRLF tolerance, CLI exit codes (§10).
   - `npm run test:fourplayer` (`scripts/test-fourplayer.mjs`, no server needed) — behavioural parity of the app's 4 Player engine and
     the generated server copy over seeded full games, bots included (§10).
   - `npm run test:fourplayerRooms` (`scripts/test-fourplayer-rooms.mjs`, no server needed) — the 4 Player room manager: the commit funnel,
     clocks (fake timers), rejoin and finished-result retention, disconnects, chat, spectating, rate limits, hostile input, and seeded random
     games checked move by move against an independent engine replay (§11).
   - `npm run test:fourplayerBots` (`scripts/test-fourplayer-bots.mjs`, no server needed) — the 4 Player bot driver, takeover and retake, the
     all-humans-gone rule, fast-forward, every pending timer counted, and seeded games with bots and random disconnects replayed on an
     independent engine (§12).
   - `npm run test:fourplayerMatchmaking` (`scripts/test-fourplayer-matchmaking.mjs`, no server needed) — the 4 Player queue: lobby rules to the
     millisecond, the fill timer, time controls, the shuffle, failed starts, no leaks (§13).
   - `npm run test:fourplayerHandlers` (`scripts/test-fourplayer-handlers.mjs`, no server needed) — the 4 Player socket handlers on fake
     sockets: the nine events, the join guards, real JWTs, a whole game in-process, and 1500 hostile event/payload/ack combinations (§13).
   - `npm run test:fourplayerOnline` (`scripts/test-fourplayer-online.mjs`, **needs the dev server, started with `FOUR_GRACE_MS=1500`**) — the first 4 Player test with FOUR real
     socket.io-client players per room (+ a spectator): identical snapshots at every seq, illegal moves, disconnect/takeover/retake, resign and game over, rejoin after the end,
     chat, spectating, the active-games list (§14).
   - `npm run duck-opponent` (`scripts/duck-opponent.mjs`) is NOT a test: a live guest opponent for manual Duck Chess
     checks on one device. `challenge` mode (default) prints a code to enter via Challenge a Friend → Join by Code;
     `queue` mode joins the Duck Chess quick-match queue; `join CODE` joins a challenge. It plays random legal Duck turns
     through the real server with the mobile app's own move generation. Two instances can play each other as a smoke test.

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
  lockstep (parity of legal moves/SAN/FEN/winner), and the same for Atomic and Duck Chess. (CI's own regression tests use far smaller counts — 6-80 games — to stay
  fast on every commit; this is the same methodology at a scale only a schedule can afford.)
- `scripts/nightly-fuzz-online.mjs` — **200** real Fog of War games plus **200** real Giveaway games
  plus **200** real Atomic games plus **200** real Duck Chess games played end-to-end through the actual running server/socket protocol (not a simulation), checking for
  genuine client/server desyncs (as opposed to the one *expected* class — see §5). In Giveaway every
  move comes from the mobile app's own legal-move set and must be accepted; ~30% of turns also first
  submit a deliberately illegal move (a non-capturing move while a capture is mandatory) which the
  server must refuse, and every `game_over` must match the mobile app's own winner detection. Atomic is
  fuzzed the same way (illegal probes are pseudo-legal moves Atomic forbids; `game_over` reasons `atomic`/
  `checkmate`/`stalemate`/`draw` must match the mobile app's own judgement). Duck Chess's probes are a move the
  duck blocks and a legal move with a bad duck (missing, occupied, or its own square) — each must be refused with the
  room left untouched — and every ack / `opponent_move` must carry the duck square the mobile app expects. A fifth section, **40** real 4 Player
  Chess games with FOUR sockets each, checks that all four hold the byte-identical snapshot at every `seq` (issue `snapshot-mismatch`), plus seq contiguity, refused illegal and
  out-of-turn moves, resignations, disconnects with a bot takeover and a retake by token, and a consistent `four_game_over` (§14).

**Visibility when something fails:**
- Both scripts write a markdown report (`nightly-fuzz-report.md`, `nightly-fuzz-online-report.md`)
  uploaded as a workflow artifact on every run (pass or fail), kept 90 days.
- On failure, the workflow opens (or updates) a single GitHub issue labeled `nightly-fuzz` with
  both reports embedded — and closes it automatically the next time the run passes.
- GitHub also emails the workflow file's last editor whenever a scheduled run fails, with no
  extra setup, as a second, zero-config signal.
- **Harness trap (the 2026-10-05 failure, `timed out waiting for "match_found"` in one Giveaway game of 800 pairings):**
  a test harness must attach its `match_found` listener *before* emitting `join_queue`. The second player's
  join gets its ack and `match_found` back to back; on a busy runner both frames are parsed in one pass, the ack only
  *queues* the awaiting code, and `match_found` fires with no listener — so `await emitAck(...); return waitFor(...)`
  loses it. It was a harness race, not a server or rules bug (the same run's logic fuzz had 0 mismatches). Fixed in
  every pairing site of the nightly online fuzz and `test-multiplayer.mjs`; `test-multiplayer.mjs` also has a
  per-commit section that stalls a client's event loop for 150 ms while it is paired, which the old pattern loses
  every time. Earlier nightly failures (2026-10-03/04) were unrelated infrastructure problems (tsx/ESM loading and the
  workflow's issue permission) — see the run history; issue #1 is the first one the workflow could open.

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

## 9. Duck Chess (server side) — design, decisions and known limits

The rules are in `src/game/duckChess.ts` (a verbatim mirror of the mobile app's rules block, guarded by
`test-duck.mjs`'s no-drift check) on top of `RoomChessEngine`'s opt-in `duckChess`/`duckSquare` options. The mobile
app's `TESTING.md` §8 describes the rules and the UI.

**How a turn is validated (`RoomManager.applyMove`).** The duck's square is not in the FEN, so the room keeps it
(`room.duckSquare`) and a turn arrives as `make_move { from, to, promotion?, duckTo? }`:
1. The move is tried on a SCRATCH engine built from `{ room FEN, room.duckSquare }`. Anything the duck blocks, or that is
   not pseudo-legal, is refused ("Invalid move.").
2. Unless that move captures a king, `duckTo` must be a legal placement on the post-move position: an empty square that is
   not the one the duck already stands on. Missing, occupied, unchanged or malformed values refuse the **whole turn**; the
   room (engine, duck, clocks, move list) is untouched, so the player can resubmit.
3. Only then does the scratch engine replace `room.engine`, the duck moves, and the move is recorded with `duck`.
4. A king capture ends the game (reason `duckChess`, winner = mover) and ignores any `duckTo`; if the side to move has no
   regular move at all, the game is a draw. Clocks/increment are applied once per turn, at the end.

**Decisions worth knowing**
- No check anywhere: moving into attack and ignoring a "check" are legal. Castling therefore has no attack restriction
  (`RoomChessEngine.generateRaw` adds back the castles chess.js withholds) but IS blocked when the duck sits on a square the
  king or rook crosses. This differs from Fog of War, which keeps chess.js's attack-based castling rule.
- Wire format: `opponent_move` / `spectator_move` carry `duck` (this turn's placement; absent after a king capture) and
  `duckSquare` (where it stands now); the ack carries `duckSquare`; `rejoin`/spectate state carries `isDuckChess`,
  `duckSquare` and a `duck` per move. Saved PGNs get `[Variant "Duck"]` and a `{@sq}` comment after each move.
- Duck Chess cannot combine with any other variant (rejected on `join_queue`/`create_challenge`); tournaments and Setup
  Chess never create Duck rooms.

**How it is tested:** see §1 (`test:duck`, the Duck Chess block of `test-multiplayer.mjs` — a real socket game ending in a
king capture) and §2 (nightly logic parity + online fuzz with blocked-move and bad-duck probes). Mutation-checked: seven
deliberate breakages (no duck required, the duck allowed to stay put, sliding over the duck, castling across it, the wrong
game-over reason, attack-restricted castling, blockade not a draw) each fail at least one check.

**Known limits**
- `scripts/test-duck.mjs` drives `RoomManager` with a stub socket server, and the socket test covers one full game; reconnect
  mid-turn is covered only by reasoning (a turn is atomic, so a rejoin never sees half of one), not by a dedicated test.
- SAN disambiguation comes from chess.js's own legal-move list (king safety, no duck), so a move can occasionally carry an
  unnecessary disambiguator — cosmetic only.


## Rejoin after the game ended — finished-room retention

**The bug.** A player whose connection dropped while the game *ended* (checkmate, a flag, resignation, or the abandonment their own
absence caused) reconnected to a room that no longer existed. `rejoin_game` answered "The game was not found or has already ended."
and the client sat on "Reconnecting…" for ever, never learning the result.

**The fix (`src/game/rooms.ts`).** `endGame` now records `{ gameOver, tokens: [whiteToken, blackToken], finishedAt }` in
`RoomManager.finishedRooms` before the room is deleted. `rejoin` on a room that is gone looks there: if the caller holds one of the
two tokens and the record is at most `FINISHED_RETENTION_MS` (5 minutes) old it answers
`{ ok: false, error: 'The game has already ended.', finished: true, gameOver }` (`RejoinFinishedAck` / `RejoinAck` in `types.ts`);
anything else is still the plain "not found". A periodic, `unref()`'d sweep (`sweepFinishedRooms`, every 60 s) drops expired records.
The socket is deliberately **not** seated or registered anywhere (it cannot move, resign or offer a draw; the opponent is not told
anyone "reconnected"), and nothing is emitted: the result travels in the ack. Tokens are required so a bare roomId never reveals a
result. A live game rejoins exactly as before (the answer has `state`, no `finished`).

**Why the finished answer is `ok: false` (backward compatibility).** App builds already in the wild only know `ok` / `error` / `state`
and do `if (ack.ok) { setFen(ack.state.fen) … }`. An `ok: true` answer with no `state` would make them throw inside the socket callback —
a crash in a release build — where today they merely stay on "Reconnecting…". As a refusal carrying the result they behave exactly as
they always did, and a client that knows the new field checks `finished` before `ok`. This was caught while verifying the first version
in a real browser against a running server, not by a test; section 5 of the script now pins it (a copy of the pre-fix client handler
must not throw), and the "ok: true" mutant is in the mutation set.

**Tests.** `scripts/test-rejoin-finished.mjs` (42 checks, Node mock timers so the 45 s grace and 5 min retention are deterministic):
the result for resignation, checkmate, a flag fall, an agreed draw and abandonment (the motivating case), identical to the live
`game_over`; a wrong/missing/other-room token and an unknown room get "not found" and no result; the late socket is registered
nowhere; retention is inclusive at exactly 5 minutes and gone one millisecond later; the periodic sweep (nobody calling it) empties
the store; 50 finished rooms do not accumulate; a live rejoin is the control; a pre-fix client handler survives a finished answer;
the record exists even when `endGame` throws part-way (an `emit` to a dying socket) because it is made right after the status flips,
before any emit; and — in a REAL child process, since a mock timer cannot show it — a `RoomManager` constructed on its own lets the
process exit by itself, i.e. the 60 s sweep interval is `unref()`d.
`scripts/test-multiplayer.mjs` adds the real-socket version (a player drops, the opponent resigns, the first reconnects on a new socket
and gets the result; bogus token refused; late socket cannot move) — 186 checks pass against a running server. Mutation-checked
(13 mutants: not recording, any token, no retention check, retention boundary, no periodic sweep, wrong payload, only one token
remembered, an extra `game_over` emit, an unknown room reporting a result, a late socket registered in `socketToRoom`, the answer
being `ok: true`, the `finished` flag dropped, the sweep boundary — all killed; the sweep-boundary mutant is *not* equivalent
because the interval can fire exactly at the boundary). Two more, added in a review pass: the record moved back below the emit loop
(killed by the "endGame threw part-way" check) and the interval no longer `unref()`d (killed: the child process times out instead of
exiting).

**Known limits.** Records live in memory like the rooms themselves, so a server restart forgets them (the client then correctly shows
"no longer available"). The client side is in the mobile app (`OnlineGameScreen`, `src/logic/onlineRejoin.ts`).
## 10. 4 Player Chess Online (server side) — the engine mirror and the wire contract (workstream W1)

Spec: `FOUR_PLAYER_ONLINE_SPEC.md` in the app repo. W1 is only the **foundation**: the server's copy of the 4-player rules engine and the
shared `four_*` protocol types. No socket handler, room or matchmaker exists yet (those are W2+), so nothing here changes how the server
behaves today; 2-player Online, tournaments and challenges are untouched.

**What is generated (never edit by hand).** `src/game/fourPlayer/{board,state,moves,elimination,bot,clock}.ts`, `src/game/fourPlayer/index.ts`
(a barrel) and `src/game/fourPlayerWire.ts` are produced by `scripts/sync-fourplayer.mjs` from the app's `src/logic/…` files, listed in the
app repo's `src/logic/fourPlayer/MIRRORED_TO_BACKEND.json`. Why generate rather than hand-mirror (the practice for the 2-player variants): this
backend is `module: NodeNext` (relative imports need `.js`), the app's engine uses extensionless imports, so a byte-identical copy is
impossible — and a hand copy is exactly how two implementations of one rule set drift. The generator applies **exactly one transform**
(every relative module specifier `'./x'` becomes `'./x.js'`) plus a 3-line banner; the test re-derives the originals from the copies with an
independent mechanism and compares byte for byte.

**Changing the engine or the protocol:** edit the app source, run `npm run sync:fourplayer` here, commit both repos. CI (`npm run
sync:fourplayer -- --check`, right after the type-check) fails if a generated file is different, missing or stray (a hand edit, a forgotten
regenerate, a file that left the list). It compares with CRLF normalised, because a Windows checkout with autocrlf rewrites the committed LF
files; output is always LF. Generated files are committed so the backend still builds and deploys on its own.

**The closure rule** keeps client-only code off the server: every import in a mirrored file must be relative, extensionless, and resolve to
another listed file. A package, `node:`, an unlisted file (e.g. `./setup`, which pulls in UI types), a specifier that already has an
extension, a directory import, `import()`, `require()`, `import x = require()` and `import('…').T` all make the generator **fail with exit
code 2** (a different code from "drift", 1) and report every problem with file and line. It uses the TypeScript compiler API, not a regex,
so multi-line imports, `export * from`, `export * as`, side-effect imports and specifier-looking text in comments/strings are handled
correctly. The app repo has its own test of the same rules (`fourPlayerMirrorSet.test.ts`), so the mistake fails where it is made.

**Tests (all run in CI):**
- `npm run test:fourplayerSync` (`scripts/test-fourplayer-sync.mjs`, plain node, ~3 s, **108 checks**) — the real mirror is exactly
  "source + banner + `.js`"; the transform on tricky syntax; every closure-rule failure; manifest validation; `check()`/`write()` on temporary
  trees (changed, missing, stale-in-the-owned-directory, **stale root-level** copies, hand edits, a trailing newline, CRLF working trees, idempotence,
  `--check` never writes, a hand-written top-level file is never touched); the CLI's exit codes (0 / 1 / 2) and messages.
- `npm run test:fourplayer` (`scripts/test-fourplayer.mjs`, tsx, **20-45 s depending on the machine**, 34 checks) — **behavioural parity**: the
  app's engine and the generated copy are driven in lockstep through 158 seeded games (about 41 000 plies): the same serialized position, legal
  moves, check/dead-position queries, events (as JSON), clocks, bot choice (1200 and 1700 at most plies, 1800 and 3000 on a sample) and
  `serialize`/`deserialize` round trips (including each engine reading the other's text) at **every** ply, with the server's own action
  pattern (charge elapsed time, then move, then increment; resign; flag fall). A coverage meter makes the script fail if a rare rule was
  never reached: castling (all 4 seats x both sides, scripted), en passant (by a perpendicular, an opposing and the other perpendicular
  seat, scripted), all four promotion pieces for all four seats (scripted), a tuned `maxPlies` cap and the 5000-ply hard ceiling, **a
  stalemate built by hand** (below), and a bounded random hunt for stalemate/checkmate/frozen/timeout/resign (it must find a stalemate
  ITSELF, so the scripted one cannot shorten it). The two engines' exports must also match (functions exist on both
  sides, 42 constants/tables deep-equal) and the app-only exports must be exactly the client-only modules'.

**Mutation checks (CHECKLIST §2).** Generator + CLI: 38 mutants (no `.js`, `.js` after the quote, edits applied in the wrong order, each closure
rule and each syntax form disabled, each manifest rule, every `check`/`write` branch, CRLF handling, exit codes, `--check` writing) —
**38/38 killed** after two tests were added for the first-pass survivors: a non-string module specifier (the parser accepts
`import x from foo;`, so the branch is reachable) and `write()` on a CRLF tree churning every file. Engine parity: 18 planted divergences in the
generated copy only (castling rights, dead-piece scores, en passant, ply counter, castle geometry, rule constants, serialize order, board shape,
clock increment/negative time, checkmate and stalemate points, the hard ply cap, four bot terms incl. the deep tier's worst-case reply, the
tier boundary) — **18/18 killed**; but two of those died only LATE, in the random games (the careful-tier castling bonus, the stalemate
scoring), i.e. by luck. That was closed by building both by hand:

**Constructed stalemate and castling-bonus tests (`scripts/test-fourplayer.mjs`, section 4b).**
- *The rule, scripted.* Blue's king on a4 has three squares: a5 and b5 (a Red rook on rank 5) and b4 (a Red bishop on d6); a4 itself is on
  neither line, so Blue is not in check. Red plays Re8-e5 and Blue is stalemated: the test asserts EXACTLY one elimination, Blue, reason
  `stalemate` (not checkmate), no credit, points `[10,20,10,10]` (stalemated seat +20, every other active seat +10), Blue's king dead and walking,
  the game still on, the turn with Yellow — and that both engines agree, then continues 40 random plies (the dead king's walk).
- *The bot's stalemate term (-6).* Same pattern, with Red's stalemating move also CAPTURING a Yellow bishop (+8.6 one-ply) while a second capture
  (Bishop takes a pawn, +1.9) competes, so the move nets about +2.6 and the scored choice takes it ~83% of the time: right on the decision
  threshold, so a change to the constant in EITHER direction flips choices. (A first version captured a knight: net -0.5, so the scored choice
  never took it, almost every 'hit' was the bot's random-move branch, and a STRONGER penalty went unnoticed — the survivor that exposed it.)
  4 500 seeded decisions at ELO 1000-1200, identical in both engines; the assertion is on the scored-choice rate (computed from
  `botStrength().bestChance` minus the random branch's expected share), not a bare percentage.
- *The bot's castling nudge (+0.3).* A castle among ~22 equal-value moves, at ELO 1000-1800: 7 500 seeded decisions, castle chosen ~13.5%.
  The nudge only matters when noisy scores are close, so it is a FREQUENCY shift - exactly what identical-seed comparison pins.
- **Mutation-checked: 19 planted divergences in these terms, 18 killed** (castling nudge 0.35 / 0.25 / 0.4 / removed / deep-tier-only; stalemate
  value +6 / 0 / -4 / -5 / -7 / -8 / -10; both stalemate rule constants; stalemated seat or others paid nothing; stalemate credited; stalemate and
  checkmate swapped). The one survivor is a NEIGHBOURING term, planted as a probe: the promotion nudge (+1 -> +1.1) — see limits.
  A developer switch, `PARITY_ONLY_CONSTRUCTED=1`, skips the random sections so a mutant cannot be pre-empted by an earlier random game; run that way
  16 scoring/stalemate/castling mutants were ALL killed by the hand-built sections (`stalemate by construction`, `bot castling nudge`,
  `bot vs stalemating capture`; two - the checkmate/stalemate swap and 'stalemated king not made dead' - died in the castling games' random
  continuation, also hand-built territory, before reaching 4b).

**Wire payload sizes** (measured, bounded by a frontend test): a typical `four_state` at ply 150 is **700 bytes** (434-character snapshot);
a 1000-entry move log, an extreme case, is 28 KB.

**Known limits.** (1) Parity is statistical beyond the constructed cases: 96 deep-tier bot comparisons, and bot terms that were not built by
hand are only reached by random games — the promotion nudge (+1) is the known example (a +1.1 variant survives; promotion's material gain
swamps it except against a near-equal capture, which has not been constructed). The stalemate constant is pinned to within +/-1 of -6 in
both directions, not to the exact digit. The *textual* identity check (`--check`) is what makes a behavioural gap unlikely in the
first place. (2) CI checks against the same-named EM-Chess branch (`ci.yml` header): push both repos' `fourPlayerOnline` branches together,
or `--check` runs against a frontend that has no wire file. (3) The generator needs the app checked out at `../` and `typescript` (already a
devDependency). (4) `index.ts` is the only generated file that is not a copy; it lists the `fourPlayer/` entries in manifest order.
(5) `parseSquare` in the engine accepts a leading zero (`e02` reads as `e2`); the wire validator therefore requires the canonical spelling
(`squareName(parseSquare(x)) === x`), which is what the server must use on client input.

## 11. 4 Player Chess Online (server side) — the room manager (workstream W2)

Spec: `FOUR_PLAYER_ONLINE_SPEC.md` §4. W2 is the server's authority over a 4-seat game: `src/game/fourPlayerRooms.ts` (`FourRoomManager`) and its
tunables `src/game/fourPlayerConfig.ts`. **When W2 and W3 were built nothing loaded them** (W4, §13, registers the handlers and is the first workstream the running server loads);
`socketHandlers.ts` is still untouched. Out of scope for W2 (bot moves, takeover after a disconnect, the all-humans-gone rule and fast-forward are W3, §12; the queue, seat
assignment and event registration are W4: a room is created with its four seats already decided).

**The design in five rules** (the doc comment at the top of the file has the long version):
1. **One funnel.** Every state change - a move, a resignation, a flag fall - ends in `commit()`, the ONLY place `room.state`, `room.clock`,
   `room.seq` and `room.turnStartedAt` are assigned after creation. It publishes exactly one `four_state` (seq + 1) to every seat and spectator,
   then ends the game or re-arms the timer. Time is charged by `charge()`, a PURE computation whose result is fed INTO a commit - nothing can mutate a
   room without publishing it. Pinned at source level by the tests.
2. **Clocks are charged lazily** from `turnStartedAt` with the engine's own `clockTick`: when the seat's move arrives, when someone else resigns, or
   when its timer fires. If charging flags the mover the engine eliminates it for time and THAT is published (actor `clock`); a move that arrives after
   the flag is refused ("Your time ran out."). The timer spends the seat's whole remaining time, so one that wakes a millisecond early still flags.
   An increment is added after a move, never after a flag. Dead kings' walks and eliminated seats cost nobody time.
3. **The seat is the socket's, never the payload's** (`socketToSeat`; a "seat" field smuggled into a move payload is ignored, and a socket
   seated in game B cannot act in game A even with A's room id). Tokens appear only in `four_match_found` to their own seat and in that seat's own rejoin.
4. **Every inbound call takes `unknown`** and validates with the shared validators from the generated wire file; a hostile payload cannot throw or
   reach the engine, and every refusal leaves the room untouched (no seq, no send).
5. **A failing send cannot abort a commit.** `emit()` is the only place anything leaves the manager and it catches (and logs, with the recipient):
   by then the state has changed, so one dying socket must not skip the others. `endGame` records the result BEFORE it sends anything (the 2-player
   lesson from W0), so a seat whose send failed can still learn the result by rejoining.

**Methods = the protocol** (W4 will only parse and delegate): `createRoom` (sends each human its own `four_match_found`), `makeMove`, `resign`,
`rejoin` (a newer connection silently replaces an older one; a finished game answers `{ ok, finished, gameOver }` for 5 minutes, to token holders only),
`handleDisconnect` (the seat shows as disconnected, its clock keeps running), `sendChat` (to the other seats and spectators, trimmed and cut like the
2-player chat, one message per seat per second), `spectate` / `stopSpectating` / `listActiveGames` (names and kinds only), `sweepFinishedRooms`
(an `unref()`'d interval). `four_make_move` is limited to 10 calls per seat per second, illegal attempts included.

**Tests** — `npm run test:fourplayerRooms` (`scripts/test-fourplayer-rooms.mjs`, tsx, no server or database, **215 checks** (205 at W2/W3; W4 added the spectator cap and list tests), ~5 s; its helpers now live in `scripts/fourplayer-test-kit.mjs`, shared with §12's script): stub sockets recording
every emit + Node fake timers and `Date`, so a flag fall, a 999 ms vs 1000 ms boundary and a 20 s off-turn resignation are exact. Sections: the configured
numbers as literals; timers counted (one per active room, none after a game); room creation and token privacy (no token appears anywhere but in its
owner's own `four_match_found`); the happy path and who is told what; every refusal (out of turn, illegal, another seat's piece, off-board and
non-canonical squares, bad promotion, wrong room, stranger, spectator, eliminated seat) leaving position, seq and sends untouched; promotions (all four
pieces and the queen default), castling and en passant through the manager; clocks (charging, increment, flag by timer, late move after the flag,
a timer waking early, a stale timer, an off-turn resignation that must CHARGE the seat on move, a resignation after the seat's own flag, dead-king
walks costing nothing, a boxed king freezing); resignation and the end of a game (order of messages, sockets released, the winner by points not
survival); a socket that throws on send; rejoin (a new socket replaces the old, tokens open only their own seat, another game's token opens nothing,
finished-result retention inclusive at exactly 300 s, sweep, `unref()` via a real child process, equality with the 2-player retention); disconnects;
chat (boundaries 999/1000 ms, per seat, spectators, eliminated seats may chat); spectating; rate limits; 114 hostile calls through six entry
points; the funnel pin; **10 seeded random games checked move by move against an independent replay on the engine** (2 380 actions: every
published position equals the replay's, `seq` is contiguous, all four seats and the spectator receive the identical payload, each result matches);
two games at once; cost.

**Found while building** (each now has a test): an early `resign` committed the UNCHARGED clock, silently refunding the seat on move its thinking
time (off-turn resignation) — caught by the clock test I wrote for it; a timer left behind after `endGame` was harmless to behaviour (the status
guard and the engine's own `clockTick` both make a late firing a no-op) but kept the finished room alive for up to an hour, so timers are now
COUNTED (spec test plan: "no timers remain after endGame"); and a cross-room test that passed by accident (the other socket's seat was not on move)
was rebuilt with a socket whose seat IS the mover in the other game.

**Mutation checks (CHECKLIST §2): 65 planted divergences in the manager and its config, 63 killed.** Covered: seq, timer base, game end, installing
state/clock, every broadcast target, the abort-on-send-failure, actor/move/events/log, the charging unit, the timer's whole-time spend, re-arming and
cancelling timers, late moves, increment, rejoin clocks, out-of-turn, eliminated seat, both rate-limit boundaries, promotion default, ack seq,
cross-room action, payload validation, the resign refund, resign after a flag, double resign, the finished record / socket release / room removal /
winners / scores, sweep and retention boundaries, token checks (live and finished), replaced-socket mapping, cross-game seating, spectator-takes-seat,
disconnect announcements, chat boundary / echo / spectators / recording, spectating rules, token uniqueness, name cut, duplicate sockets, time-control
validation, `unref()`, and the five config constants. First-pass survivors were test gaps and are closed (cross-room by accident, timers, and
config boundaries that the tests had computed FROM the constants). **Two survivors are equivalent by construction, not gaps:** (a) removing the
`room.status !== 'active'` guard in the timer callback alone (a finished room's timer is cancelled, so the guard is a second line of defence; removing
the cancel AND the guard is killed); (b) removing the `runtime.socketId !== socketId` guard in `handleDisconnect` (rejoin already drops the replaced
socket's mapping, so `handleDisconnect` returns earlier; the guard stays as a second line of defence).

**Cost** (measured, test section 14): 1 000 moves with four stub sockets: **0.14 ms mean, 2 ms worst** per move (legality check, engine, `serialize`,
four broadcasts). A `four_state` is about 700 bytes (see §10).

**Known limits.** In-memory like the 2-player rooms (a restart ends every game); single process. W4 added a cap of 50 spectators per room (§13). Clock accounting uses `Date.now()` and one `setTimeout` per room: an event-loop stall delays when a flag fall
is PUBLISHED but not the accounting, and a late move is refused regardless. A room needs at least one human (a human-less room is W3's all-gone rule).
(As built in W2 a bot seat never moved; W3 added the bot driver - §12.)

## 12. 4 Player Chess Online (server side) — bots, takeover, abandonment (workstream W3)

Spec: `FOUR_PLAYER_ONLINE_SPEC.md` §4.4 and §6. W3 extends the room manager of §11 (same file, `src/game/fourPlayerRooms.ts`; new constants in
`fourPlayerConfig.ts`). At the time of W3 nothing loaded it (the handlers arrive in W4, §13).

**What it adds** (the doc comment at the top of the file has the long version):
- **A bot driver.** After every commit - and when a room is created - `scheduleBot()` arms ONE bot timer if the seat on move is a bot's (450 ms,
  200 ms in a Bullet game - the app's own rule, "Bullet" being the 1 and 2 minute presets). The bot's move goes through the same funnel as anyone's
  (actor `bot`: time charged, move played, increment added). The callback re-checks the room, the `seq` it was armed for, the seat's controller and
  that it is still the seat's turn, so a callback that outlived a retake is a no-op. Bots run on their OWN random stream (`botRng`), so the engine's
  randomness (dead kings' walks) never depends on a bot's decision - which is what lets the tests replay a game with bots on an independent engine.
- **The ELO clamp.** A bot decision is synchronous on the event loop that serves every game. Every bot - fill, takeover, or a seat configured at
  3000 - decides at `min(elo, 1700)`, the top of the "careful" tier (measured ~20 ms worst case against ~200 ms for the deep tier, spec §6.3), which is the
  same safety as a worker thread with none of its plumbing. Tests pin the number, that it is below `DEEP_FROM_ELO`, and every elo/clamp pair.
- **A bot can never stall a room or take the process down.** The chosen move is checked against the engine's legal moves; a bot that returns nothing,
  an illegal move, a legal from/to with the wrong flags, or THROWS gets the first legal move played instead and the fault is logged. (An exception inside
  a timer callback would be an uncaught exception that kills EVERY game on the process - found while writing this and now caught and tested.)
- **Takeover.** A disconnected human's seat keeps its clock running; the room announces `graceMsLeft` (clients count down from it); after
  `FOUR_TAKEOVER_GRACE_MS` (45 s) a bot takes the seat - named as the human, ELO 1200, `botReason: 'takeover'` - but ONLY if the seat is still active, still
  disconnected, and some original human is still connected: a bot is never handed an empty room. An eliminated human's disconnect starts no countdown.
- **Retake.** `four_rejoin` with the token at ANY time until the game ends: the seat is the human's again, its grace countdown, a pending bot move and
  the all-gone countdown are cancelled, everyone is told. (A bot move that was armed for the seat but has not fired is cancelled; one that somehow fires
  is a no-op because the controller changed.)
- **Everybody leaves.** When no ORIGINAL human has a live socket an all-gone countdown starts (45 s; a bot-held seat does not keep a game alive; a
  spectator does not count; any rejoin cancels it); at expiry the game ends with reason `abandoned`, NO winners, nothing persisted, and the late-rejoin
  record is kept like any other. At a seat's grace expiry with nobody connected there is no takeover - the all-gone countdown decides.
- **Fast-forward.** When no human-controlled seat is still ACTIVE but a human is still connected (eliminated seats place by score, so the game is not over
  for them) the bots play with no think delay, one ply per timer, so one such game cannot starve the others. An ACTIVE human who is merely away still counts as
  playing (it may come back) until its seat is taken over. If the last watcher leaves, the bots go back to the normal pace and the all-gone rule ends it.
- **`finish()`** is now the single way a game ends (engine result or abandonment); it records the result BEFORE sending, clears EVERY timer the room owns
  (clock, bot, all-gone, each seat's grace) and `four_game_over` is sent from nowhere else (pinned at source level).

**Tests** — `npm run test:fourplayerBots` (`scripts/test-fourplayer-bots.mjs`, tsx, no server or database, **124 checks**, ~8 s), sharing helpers with the W2
script through `scripts/fourplayer-test-kit.mjs` (stub sockets, fake timers with a COUNT of pending timers and a record of every delay a timer was armed
with, the game factory). Sections: the configured numbers as literals; the bot driver (450/200 ms to the millisecond, Red as a bot, increment, stale
callbacks, the four kinds of faulty bot, the clamp for 8 elo values, the bots' own random stream, one timer per bot move); takeover (the exact moment, the
announced fields, a seat on move at the takeover, an eliminated seat, a second absence, `graceMsLeft` later in the grace); retake at every stage (during
the grace, after the takeover, while the bot's move is pending, after the bot has played); all-gone (ordering against the takeover, cancellation, bot-held
seats, spectators); fast-forward (including WHICH delays were used, takeover into fast-forward, watchers leaving and returning); a count of every
pending timer; **12 seeded games with bots, random disconnects, rejoins and resignations (2 866 published states), every one replayed on an independent
engine**; the cost of a bot decision; source pins. Two things about Node's fake timers shaped the tests: they are GLOBAL (a game left running by one
scenario is driven by the next one's `tick()`, so every scenario disposes the previous game), and a timer armed INSIDE a tick is timed from the END of that
tick (so the takeover and bot-move tests use two ticks, and fast-forward plies are stepped by hand - a real `setTimeout(0)` is a separate event-loop turn).

**Mutation checks (CHECKLIST §2): 68 planted divergences in the new logic and constants, 62 killed, 6 equivalent by construction.** Covered: scheduling after
a commit and at creation, re-arming, the controller check, the think delay, fast-forward always / never / ignoring watchers / ignoring an away human, stale and
retaken callbacks, the bot's increment and actor, the clamp (removed, a floor, wrong default), illegal / fallback / throwing bots, the bots' random stream, every
takeover guard, the takeover's elo / reason / announcement / scheduling, grace start and the eliminated seat, the all-gone start / cancel / count / reason /
winners, retake (controller, reason, elo, pending bot move, all-gone), `finish()` clearing each kind of timer, `graceMsLeft` (both directions), and every
config number with its boundaries. The first run left ONE real gap, closed: `graceMsLeft` counting the wrong way survived because it was only read at t = 0.
**The six equivalents:** the no-legal-move guard (the engine never hands out such a turn); the `onGraceExpired` guards for "connected again" and "room
finished" and the `endAbandoned` guard for "somebody came back" (each is a second line of defence behind a cancellation - removing the cancellation AND the guard
is killed); `connected` vs `socketId !== null` in the human count (the same fact held twice for a human seat); and `originalHuman &&` (a bot seat never has a
socket).

**Cost** (measured, test section 8): **1 299 bot decisions across 12 games, mean 0.45 ms, p99 3.1 ms, max 4.6 ms** - including 400 by a seat configured at ELO 3000
and held at 1700. A whole fast-forwarded game (~700 plies) is played in about a second of CPU, in separate timer turns.

**Known limits.** The takeover bot is always ELO 1200 (decision A3); a taken-over seat is not "remembered" as stronger or weaker. A game with no original human
connected ends after 45 s even if the bots could have finished it - by decision B3 (no result, nothing persisted). Random games exercise retakes only rarely (1 of 12);
the constructed tests cover every stage. (W4, §13, added the spectator cap, the queue and fill timer, and the event registration.)

## 13. 4 Player Chess Online (server side) — matchmaking and the socket handlers (workstream W4)

Spec: `FOUR_PLAYER_ONLINE_SPEC.md` §7, §3, §4.6. W4 is the **first workstream the running server loads**: `src/index.ts` gains one import and one call,
`registerFourPlayerHandlers(io)`, right after `registerSocketHandlers(io)`. The 2-player handlers are untouched (`socketHandlers.ts` is unmodified and
does not mention the 4-player code; a test pins that), and every event here is `four_*`, so nothing can collide. New files: `fourPlayerMatchmaking.ts`
(`FourPlayerMatchmaker`), `fourPlayerHandlers.ts`, and the W4 constants in `fourPlayerConfig.ts`.

**The matchmaker** (a pure, dependency-injected class: `startGame` and `notify` are injected, so every rule is tested with fake timers and no network):
- One lobby per time control (`initialSeconds|incrementSeconds`); lobbies never mix; a socket is in at most ONE lobby.
- The 4th human starts the game at once (four humans, no bots). With >= 2 queued, a fill timer of 30 s starts - from the moment the lobby FIRST holds two,
  not from each player's own join, and a third human does not restart it; at expiry all queued humans (2 or 3) plus bots make four (A1/A2).
  Dropping below two cancels the timer; reaching two again restarts it from zero. A lone human waits indefinitely.
- Every change is pushed to the lobby as `four_queue_update { queued, fillInMs }` (`fillInMs` null while there is no timer).
- Seats are a uniform Fisher-Yates shuffle over `crypto.randomInt`; the random source is injectable, so a test drives it through EVERY sequence of choices
  and proves all 24 permutations are reachable (and all 12 arrangements of 2 humans + 2 bots), plus a statistical check of the default (crypto) source.
- "No time limit", Daily and anything outside 60-3600 s / 0-30 s are refused by the shared validator. If starting a game throws, the humans are put back in the
  queue (and the timer re-armed) instead of vanishing from it.
- `FOUR_FILL_MS=<ms>` shortens the wait for tests and the dev server, **only when NODE_ENV is not "production"** and only for a plain decimal 1..600000
  (the first version accepted `" 3000"`, `"3e3"` and `"0x10"` through `Number()`; the test caught it and the check is now `/^\d+$/`).

**The handlers** do nothing but parse, delegate and reply; every rule lives in the manager and the matchmaker. What `listen()` guarantees at the network
boundary: socket.io's argument shapes are normalised (a client that sends no payload leaves the ack in FIRST place; the 2-player `ack?.()` would throw on a
non-function ack), replies go through a safe `reply`, and BOTH a synchronous throw and a rejected promise are caught, logged and answered with a generic error -
nothing a client does can become an uncaught exception, which would kill every game on the process. Identity is the optional JWT (same rule as the 2-player
server: a valid token is a user, anything else a guest); the username is looked up when a player QUEUES (one query per join; a failed lookup falls back to
"Player"; guests are "Guest") - a deliberate deviation from the spec's "at room creation", which keeps room creation synchronous and race-free. A seated
socket cannot queue, a queued one cannot queue twice (refused BEFORE any lookup), a socket that left during its lookup is never queued, and a LATE check after
the lookup stops a socket that was seated in the meantime from being queued. `disconnect` leaves the queue and tells the room manager, each guarded so one
cannot skip the other. A queue update that cannot be sent is logged and does not turn a successful join into an error.

**Manager additions** (W2 file): `isSeated()`, a **spectator cap** of 50 per room (a spectator already watching it is never refused; a refused request leaves the
socket watching what it was watching), and the active-games list is now genuinely **newest first and capped at 100** (W2's comment said "newest first" but
`Map` order is oldest first - found while testing).

**Tests** (all in CI, none needs a server or a database):
- `npm run test:fourplayerMatchmaking` (`scripts/test-fourplayer-matchmaking.mjs`, **74 checks**): the lobby rules to the millisecond (29.999 s vs 30 s, a countdown
  that starts when the lobby reaches two, one that restarts from zero), time controls never mixing, validation, one entry per socket, a failed start, the shuffle,
  the override's accepted and refused spellings, every timer accounted for, and that no lobby or socket mapping is left behind (an emptied lobby that was kept
  would be a slow leak for every time control ever used).
- `npm run test:fourplayerHandlers` (`scripts/test-fourplayer-handlers.mjs`, **61 checks**): fake `io`/sockets driving the REAL handlers, manager and matchmaker with only
  the username lookup stubbed: exactly the nine events are wired; the join guards and races; real signed JWTs (8 kinds of bad token are guests); a WHOLE game
  in-process (queue, fill, 2 bots, 12 human + 12 bot moves, spectate, chat, disconnect, rejoin, resign); faults inside the server contained; the disconnect hook
  guarded; **1500 random event/payload/ack combinations - junk payloads, non-function and throwing acks - across all nine events: nothing throws out of a handler, no
  unhandled rejection, and the game is exactly as it was**; source pins on the wiring.
- `test-fourplayer-rooms.mjs` (now **215**) gained the spectator cap (50 accepted, the 51st refused, the idempotent case, the "refused request keeps the old room"
  case) and the list (105 games: 100 listed, newest first, the 5 oldest left out).

**Verified over a real network** (a throwaway server on :3101 with `FOUR_FILL_MS=1500`, real `socket.io-client` sockets; the script was not kept - the full
real-server e2e is W6): two guests queued, the fill wait elapsed, a game started with two fill bots; 8 human moves interleaved with 8 bot moves, `seq`
contiguous 1..16; one human disconnected (the other was told, `graceMsLeft: 45000`) and rejoined on a new socket; chat was delivered; both humans resigned and the
bots **fast-forwarded to a natural end in ~3.7 s**; the spectator received the same result; a late rejoin got the finished result; the active-games list was empty
again; the server log had no error. The existing 2-player suites (`test:multiplayer` 186, `test-tournament` 40) pass against the live server with the 4-player
handlers registered next to them.

**Mutation checks (CHECKLIST §2): 83 planted divergences, 79 killed, 4 equivalent by construction.** Covered: validation, one-entry-per-socket, the lobby key, the
4th-human / 3-human thresholds, the fill timer (lone human, three needed, re-arming on every join, not cancelled below two, a wrong default, never starting a game),
`fillInMs` (wrong sign, reported without a timer), notification (dropped, off by one), the number taken / bots / bot elo / bot reason / no shuffle / a biased shuffle
(`randomInt(i)`) / no swap, the queue maps and lobby cleanup after a start and a leave, the label, a failed start (not restored, not re-queued, not re-armed, not
told, not logged), the ack-in-first-place handling, a throwing ack, a synchronous throw, a swallowed rejection, the dropped failure reply, every handler guard,
the late seated check, the lookup fallbacks, each of the nine handlers' wiring, the disconnect hook (each half, and the guard), the queue-update event name, a
tampered token, and every constant with its boundaries (including the override's production rule, regex, floor and ceiling). The first run left THREE real gaps,
now closed: the join test accepted "a message" without checking it was the validator's (a crash into "Something went wrong" also produced one); a failing
queue-update send had no test; the label reaching the game was unchecked. **The four equivalents:** the fill-timer callback's two guards (the timer is cancelled
whenever either condition would hold); an ack in first place also being taken as the payload (every validator rejects a function and the payload-less events ignore
it); and a failed start restoring the humans to the FRONT rather than the back (the restore is synchronous, so nobody can be in the lobby meanwhile).

**Known limits.** No per-socket cap on `four_*` events in general (the move, chat and queue rules each limit themselves; a flood of valid-shaped junk costs one
validation each). The default username lookup (`prisma.user.findUnique`) is not exercised by the scripts (they stub it; guests need no database) - the real-server
e2e with a logged-in user is W6. Fill timers are per process (single instance, like everything else here). A client that never answers is not "queued" any longer
than its socket lives: disconnect removes it.

## 14. 4 Player Chess Online (server side) — real sockets: the e2e test and the nightly fuzz (workstream W6)

Spec: `FOUR_PLAYER_ONLINE_SPEC.md` §9 (W6) and §10. Everything before W6 tested the 4 Player server logic **in-process** — stub `io`, fake timers, a frozen `Date` — or
tested the app's client against a fake socket. W6 adds the first tests that hold **four independent real `socket.io-client` connections to one room** on a running
server, plus a fifth seat-less one for the spectator. That is the only way to prove the invariant the feature rests on: after every state change all four players
hold the byte-identical snapshot and `seq`.

### `scripts/test-fourplayer-online.mjs` (`npm run test:fourplayerOnline`, **198 checks**, 9 scenarios)
Same shape as `test-multiplayer.mjs` (header, `BACKEND_URL`, `connect` / `emitAck` / `waitFor` with the same race note, `check`, one `async function test…()` per
scenario, `main()` exiting 1 with the stack). Needs a running server **started with `FOUR_GRACE_MS=1500`** (scenario 4 fails loudly, with that instruction, if the
grace is still 45 s). Runs under **tsx** rather than plain node because legal moves come from the generated TypeScript mirror (`src/game/fourPlayer/index.ts`).
Each inbox records everything a socket is sent from before it joins (`record()`), so a scenario can compare all four afterwards; a pseudo-random but seeded
(`FOUR_E2E_SEED`) legal move is chosen from the mover's **own** copy of the position, as a real client does.
1. **Queue and match found** — "No time limit" and Daily refused; a queued socket cannot queue twice; `four_queue_update` counts and the fill countdown (3 waiting,
   `fillInMs` ≤ 30 s; 1 waiting, `null`); nothing starts with 3 humans; the 4th starts the game at once; one room, seq 0, four distinct seats, four own tokens, four
   byte-identical starting payloads (clocks included), no token / socket id / user id in the shared seats list; queues never mix; `four_leave_queue`.
2. **Move sync is identical** — 18 real plies; after **every** `four_state` the four sockets hold the byte-identical snapshot, `actor` and `seq`, and the message
   names the mover and the move; per socket seq 1..N with no gap or duplicate; identical clocks; the ack's `seq` is the `seq` of the broadcast it caused.
3. **Illegal and out-of-turn moves** — each refused **for its own reason** ("Not your turn.", "Illegal move.", "Invalid move.", "Invalid promotion piece.") with nothing
   sent to anyone, then a burst of 14 calls shows the rate limit ("Too many moves - slow down."; refused calls count, so the probes are paced under it), then the room
   still takes a legal move as seq 1.
4. **Disconnect → grace → takeover → retake** — `four_seat_update` (connected: false, `graceMsLeft`), then (`kind: 'bot'`, `botReason: 'takeover'`, still the player's name, ELO
   1200), the bot plays seat 3's turn by itself, the original token rejoins on a NEW socket mid-game and gets the live snapshot, the others see the human back, a bogus
   token is refused, and the player's next move from the new socket is accepted and broadcast as a human move.
5. **Resign and game over** — an off-turn resignation (`actor: 'resign'`, game continues), nine more moves, two more resignations; `four_game_over` reaches all four
   seats (eliminated ones stay attached) and the spectator **identically**, its scores equal the scores in its own final snapshot, its winners are exactly the highest
   score, and it carries the same snapshot as the last `four_state`.
6. **Rejoin after the game ended** — pinned as **`{ ok: true, finished: true, gameOver }` with no live state**, not the 2-player `{ ok: false, finished: true, … }`: the
   4 Player protocol is new, so a finished room is a plain success (FourRejoinFinished). Bogus token / unknown room refused; the late socket is not seated.
7. **Spectator** — joins mid-game, gets the live room (same seq and text as the players, the move log, no token), keeps receiving identical `four_state`s, cannot move /
   chat / resign, a seated socket cannot also spectate, can leave and then receives nothing.
8. **Chat** — reaches the other three seats and the spectator, exactly `fromSeat,name,sentAt,text`, trimmed; the sender does not get it back; the 1 s rate limit; blank
   refused; 900 characters cut to 500.
9. **Active games list** — the live room with its label and four names (guests are "Guest"), only names and kinds, gone once the game ends.

### `scripts/nightly-fuzz-online.mjs` — a "4 Player Chess" section (extended in place)
Own stats object, loop, console line, markdown line and issue list, counted into the exit code, exactly like the other variants. New CLI argument after `duckGames`
(`[fourPlayerGames]`, default = `fogGames`). Per game, **four real sockets**, each with **its own** position built only from the snapshots it was sent and read by the
**mobile app's** 4-seat engine (not the server's mirror — the clients are independent of the server, like the other sections), and its moves chosen from that:
- **headline:** at every seq all connected clients hold the byte-identical `{roomId, seq, actor, move, events, state, clocksMs}` — a mismatch is issue kind `snapshot-mismatch`;
- seq contiguous per client; the ack's seq is the previous seq + 1; the broadcast describes the move that was sent; clocks plausible;
- a fraction of turns first submit an illegal move (and sometimes an out-of-turn one): the server must refuse and the room must be untouched;
- resignations part-way; in ~40% of games a random seat is disconnected and later brought back by token — with `FOUR_GRACE_MS` set on the server the bot takeover is
  waited for and observed first; otherwise the player is brought back inside the 45 s grace — and the rejoin snapshot must equal the others' copy at that seq;
- a game that has not ended is finished by resignations, and the `four_game_over` each client got must agree between seats, with the app engine's own reading of the final
  position (scores, winners, reason), and with the last `four_state`; a late `four_rejoin` of the finished game must return the same result.
The fuzz **paces itself under the server's move rate limit** (8 calls per seat per second): it plays far faster than a human and its first run tripped "Too many moves" on
legal moves — a fuzz flaw, not a server bug. Pace: about 5.5 s a game (80 plies). **Nightly count: 40 games** (≈ 4 minutes; each game has four sockets), run with
`FOUR_GRACE_MS=1500` set on the server-start step. Local run at 20 games: 1600 plies, 695 illegal/out-of-turn moves correctly refused, 7 disconnect/rejoin cycles
(10 bot takeovers), 59 resignations, 20 games ended, **0 issues**. Limit: no game in 80 plies ends by the engine itself (cap / dead position), so those three
`reason`s are covered by the unit suites, not by this fuzz.

### `FOUR_GRACE_MS` (`src/game/fourPlayerConfig.ts`, `FourRoomManager`'s `graceMs`)
`resolveFourGraceMs()` shortens the 45 s takeover grace for the real-socket tests, under **exactly** the guard of `FOUR_FILL_MS` (now one shared helper, `envMsOverride`):
ignored when `NODE_ENV=production`; only a plain decimal whole number of ms in 1..600000 (not `" 3000"`, `"3e3"`, `"0x10"`, `"1.5"`, `"0"`, `"-5"`, …). Read once when the room
manager is built and passed as the `graceMs` option, so a unit test can inject its own. **`FOUR_ALL_GONE_MS` was deliberately left alone**: no end-to-end scenario waits for "every
human is gone" (that rule is covered with fake timers in `test-fourplayer-bots.mjs`), so a second knob would widen the production configuration surface for no benefit.
**Production unchanged, verified on live servers** (a guest disconnects, the others are told `graceMsLeft`): unset → 44999 (one millisecond had passed); `FOUR_GRACE_MS=1500`
with `NODE_ENV=production` → 45000; `FOUR_GRACE_MS=1.5s` → 45000; `FOUR_GRACE_MS=1500` → 1500. In `test-fourplayer-bots.mjs` section 10 (+36 checks, now **160**): the
constants untouched; 6 accepted and 15 refused spellings; production; independence from `FOUR_FILL_MS`; the manager's timer and `graceMsLeft` honour the option and the
environment; source pins that nothing reads the 45 s constant directly and neither the entry point nor the handlers pass a grace.

### What real sockets found that the stub tests structurally could not
1. **The starting snapshot was not one snapshot.** `createRoom` read the clocks inside its per-recipient loop, so on a real clock the seat on move showed `299999`,
   `299998`, `300000`, `299999` ms to the four players of the same `four_match_found` (seq 0). Every in-process test freezes `Date`, so none could see it. Fixed (one reading
   for every recipient), pinned deterministically by `test-fourplayer-rooms.mjs` section 9 (a `Date.now` that moves on every read: 220 checks, was 215), and by e2e scenario 1.
   `four_state` broadcasts were already correct (one payload per commit).
2. **Flaws in the new tests themselves, found by running them many times** (none was a server bug): a "clocks are exactly 300 s" assertion that failed whenever a
   millisecond had passed; scenario 4 and the fuzz reading a stale copy of the position after back-to-back moves (the ack and the `four_state` it caused travel on different
   sockets — `playOne` now waits for the mover's own copy to catch up); the fuzz outrunning the rate limit; a namespace import of the app's engine that exposed nothing under tsx
   (imported file by file now, like the other variants). The e2e was run 12 times in a row after the last fix: 0 failures (it had failed in 3 of 13 runs before).

### Mutation checks (copy-based: a mutated COPY of `backend/src`, never the real files)
**17 unit mutants** of the override and the fix (judged by the bots and rooms suites): 16 killed, 1 equivalent (the starting *seats* read per recipient: nothing in them depends on
time at creation). **9 real-server mutants** (the mutated copy is started as a real server on its own port with `FOUR_GRACE_MS=1500`): the e2e kills **all 9** — clocks per recipient;
`seq` skipping a number; one seat never receiving broadcasts; one recipient's clock 1 ms off; out-of-turn moves accepted; takeover never happening; the grace override ignored by
the live server; a retake that leaves the bot in charge; a spectator able to chat (as seat 0) — each by the check that names it. The **fuzz alone also kills the 7 it can reach**
(its issue kinds: `snapshot-mismatch` for the 1 ms clock, `seq-gap-or-duplicate`/`ack-seq-not-contiguous`, `missing-four-state`, `server-ACCEPTED-out-of-turn-fourplayer-move`,
`stalled-waiting-for-takeover`, `rejoin-did-not-restore-the-seat`, `match-found-snapshots-differ`). The first e2e kills of two mutants came from the over-strict clock assertion
above rather than from their own check, which is how that flaw was spotted; they were re-run after the fix.

### CI and nightly
`ci.yml`: one new step after the socket-handler tests, `npm run test:fourplayerOnline`, against the dev server started earlier — **whose start step now sets
`FOUR_GRACE_MS: '1500'`** (the one change to an existing step; nothing else in the job depends on the grace). `nightly.yml`: the same env on its server-start step, and the online-fuzz
step's command is `… nightly-fuzz-online.mjs 200 80 200 200 200 40` (the previous defaults, spelled out, plus 40 four-player games). **Nightly dependency:** the nightly checks out
the frontend repo's DEFAULT branch, and the 4 Player section imports the app's engine from it, so the frontend's 4 Player work must be merged before (or with) this change —
otherwise every nightly online fuzz would fail at import (the same pairing rule `ci.yml` already documents for `sync:fourplayer --check`).
