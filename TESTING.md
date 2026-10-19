# Testing & Quality Infrastructure — Backend

This repo (`chess-app-backend`) and its sibling frontend repo (`EM-Chess`) are tested together in
several places, because some of this backend's own test scripts import the frontend's chess logic
directly (see "Why some backend tests import frontend code" below). This document covers what
exists in **this repo**; see the frontend's own `TESTING.md` for its half of the picture.

## 4 Player Giveaway — roll-up (read this first for the whole feature)

**What it is.** 4-seat Antichess served by the SAME 4 Player machinery as Free-for-All: `FourRoomManager`, the matchmaker and the nine socket handlers. A room carries a `variant` (`'ffa'` | `'giveaway'`); the matchmaker's lobby key is `timeControl|variant`, so the two never mix; the engine mirror
(generated from the app, now including `giveaway.ts` and `giveawayBot.ts`) dispatches on the rules; the server bot is the heuristic Giveaway bot (`chooseBotMoveFor` is the room manager's default chooser; no Stockfish anywhere). On the wire `variant` is optional on every server payload (absent = Free-for-All, so older clients
and servers keep working), `four_game_over.scores` are **pieces left** in Giveaway, and a join with an unknown variant is refused (`Unknown game mode.`). Spec: the app repo's `FOUR_PLAYER_GIVEAWAY_SPEC.md`; the app's half is in the frontend's `TESTING.md` (same roll-up at its top).

**Where each workstream is documented**

| | What | Backend | Frontend |
|---|---|---|---|
| W1 | engine mirror + wire contract + parity script | §15 | §13 |
| W2 | the variant through rooms / lobbies / handlers, the server Giveaway bot, `test:fourplayerGiveaway` | §16 | §14 |
| W3 | what changed here for the screens | §17 | §15 |
| W4 | real-socket e2e scenarios 10–16, the Giveaway nightly fuzz, CI wiring | §18 | §16 |
| W5 | this roll-up, the last mutation re-run on the final code | §19 | §17 |

**What runs where.** In CI (`ci.yml`): the mirror drift check, then the in-process scripts (`test:fourplayerSync`, `test:fourplayer`, `Rooms`, `Bots`, `Matchmaking`, `Handlers`, `Giveaway`), then `test:fourplayerOnline` against the live dev server. Nightly (`nightly.yml`): `nightly-fuzz-online.mjs ... 40 40` (4 Player Chess and 4 Player Giveaway, four sockets per game).

**Final numbers (end of W5, all run green).** `sync:fourplayer --check` in sync (10 generated files); sync 114, engine parity 53 (159 random games incl. Giveaway, lockstep with the mirror), rooms 220, bots 160, matchmaking 74, handlers 61, **Giveaway 89**; real-socket e2e 287 (not re-run in W5: no server code changed since W4); `tsc --noEmit` clean.
**Mutation checks, every workstream's set re-run on the final code** (disposable copies; W4's mutants spawn a mutated server of their own on a private port, stopped by proven pid): **192 planted, 187 killed, 5 equivalent, 0 real survivors** (the table is in the frontend roll-up: W1 72/72, W2 45 + 2, W3 53 + 1, W4 17 + 2).

**The equivalent mutants that live in THIS repo, each justified and marked `EQUIVALENT-MUTANT NOTE` in the source** (the frontend's two are listed in its roll-up):
- W2 — `queue entries forget their variant`: the lobby, keyed by variant, is what `start` / `restore` read; the entry's own copy is informational.
- W4 e2e — `the variant is not validated` in the matchmaker: over a socket the handler's shared validator refuses an unknown variant first; the matchmaker's own check is killed in-process by §16's direct join.
- W4 fuzz — `cap winners are the MOST pieces`: a game never reaches the 1000-ply cap through random play (the cap rule is pinned by the engine tests and the parity script instead).
Two honest details of the final fuzz run: "last standing at two seats" is only killed at the CI setting of 80 plies, and "the rejoin room state has no variant" was killed by the harness failing without a summary line (the earlier run killed it with 3 named issues).

**What was NOT verified.** The player screens were looked at in a real browser for the first time in W5 (the owner's logged-in tab + a scripted guest socket; frontend §17), except: the D15 refusal screen (needs a server that does not echo the variant), a bot takeover seen in the browser, and the 4 Player Chess online screens. Also open by design: the cap (1000 plies) is not reachable by
random play, so over sockets it is only pinned by hand-built positions in-process.

**Merge order.** `ci.yml` checked out the same-named branch of the frontend repo (since §20 only a `paired/<x>` branch does): push / merge the frontend's `fourPlayerGiveaway` first (or together with this one).

## 4 Player Chess Online — roll-up (read this first for the whole feature)

**What it is.** Online Free-for-All 4 Player Chess. Players queue per time control (live Bullet/Blitz/Rapid only); four humans start a game at once, and with at least two the matchmaker fills the empty seats with Amateur bots after 30 s.
This server is the only authority: `FourRoomManager` runs every game through one funnel (`commit()`) that validates the move with the engine, charges the clocks, increments `seq` and broadcasts the `four_state` snapshot to every seat and
spectator, so all of them hold the identical position. A human who stays away for 45 s is replaced by a bot (and may retake the seat until the game ends); if every human leaves, the game ends with no result. The server's copy of the
engine is GENERATED from the app's and guarded against drift in CI. Nothing is persisted (v1). The 2-player server is untouched apart from one fix (W0). Spec: `FOUR_PLAYER_ONLINE_SPEC.md`; the app's half is in the frontend's `TESTING.md`
(same roll-up at its top).

**Where each workstream is documented** (the per-workstream sections stay as they are)

| | What | Section |
|---|---|---|
| W0 | 2-player "rejoin after the game ended" fix (finished-room retention) | "Rejoin after the game ended"; frontend §10 |
| W1 | generated engine mirror, wire contract, CI drift check | §10; frontend §11 |
| W2 | the room manager (commit funnel, clocks, rejoin, chat, spectating) | §11 |
| W3 | bots, takeover, retake, all-humans-gone, fast-forward | §12 |
| W4 | matchmaker and the nine socket handlers | §13 |
| W5 | the client | frontend §12 |
| W6 | real-socket end-to-end test (four sockets per room), the 4 Player nightly fuzz section, `FOUR_GRACE_MS`, CI/nightly wiring | §14 |
| W7 | this roll-up, the last mutation re-run on the final code | here and the frontend roll-up |

**What runs where.** In CI (`ci.yml`): the mirror drift check, then `test:fourplayerSync`, `test:fourplayer` (engine parity), `test:fourplayerRooms`, `test:fourplayerBots`, `test:fourplayerMatchmaking`, `test:fourplayerHandlers` (all in-process), then
`test:fourplayerOnline` against the live dev server (started with `FOUR_GRACE_MS=1500`). Nightly (`nightly.yml`): the 4 Player section of `nightly-fuzz-online.mjs` (40 games, four sockets each).

**Final numbers, both repos.** Automated checks written for the feature: **1,085** — **897 script checks in this repo** (W0 `test:rejoinFinished` 42, W1 sync 108 + parity 34, W2 rooms 220, W3 bots 160, W4 matchmaking 74 + handlers 61, W6 online 198) and
**188 vitest tests in the frontend** (W0 14, W1 46, W5 128), plus the nightly fuzz section (random, not counted). (Each count is the script's current total, so later workstreams' additions are in the earlier script's figure.)
**Mutation checks, every workstream's set re-run on the final code** (always on a disposable copy, never the real files; W6's mutants run a mutated copy as a REAL server): **565 planted, 543 killed, 22 equivalent, 0 survivors.**

| | Planted | Killed | Equivalent | Survivors |
|---|---|---|---|---|
| W0 (backend 13, client 15) | 28 | 27 | 1 | 0 |
| W1 (generator 38, wire 41, mirror-set guard 10, engine parity 18) | 107 | 107 | 0 | 0 |
| W2 | 65 | 63 | 2 | 0 |
| W3 | 68 | 62 | 6 | 0 |
| W4 | 83 | 79 | 4 | 0 |
| W5 | 188 | 180 | 8 | 0 |
| W6 (17 unit + 9 against a real server) | 26 | 25 | 1 | 0 |
| **Total** | **565** | **543** | **22** | **0** |

**The 13 equivalent mutants in THIS repo, each justified against the final code** (each also has an `EQUIVALENT-MUTANT NOTE` in the source, added in W7; the frontend's 9 are listed in its roll-up):
- W2 — the `status !== 'active'` guard in `onClockTimer`: `finish()` clears the clock timer, so a finished room's callback can never run.
- W2 — the `runtime.socketId !== socketId` check in `handleDisconnect`: `rejoin()` already removed the replaced socket from `socketToSeat`, so its late disconnect returns at the `located` check first.
- W3 — the `legal.length === 0` branch in `playBotTurn`: the engine hands the turn only to an active seat that has a legal move (one without is eliminated on the spot), so the branch is unreachable.
- W3 — `onGraceExpired`'s `status` guard and its `connected` / `controller` guard (two mutants): `finish()` clears every grace timer and `rejoin()` cancels the seat's own, so the callback only runs for a disconnected, still-human seat of a live room.
- W3 — `connectedHumans` counted from `connected` instead of `socketId !== null`, and without `originalHuman &&` (two mutants): `socketId` and `connected` are always set and cleared together (a taken-over seat has both cleared) and a bot seat has no socket.
- W3 — `endAbandoned`'s `connectedHumans() > 0` guard: `rejoin()` cancels the all-gone countdown as soon as anyone returns.
- W4 — the fill timer callback ignoring a replaced lobby, and ignoring a lobby below two (two mutants): `rearmTimer` clears the timer whenever the lobby changes or drops below two, so the callback only sees its own qualifying lobby.
- W4 — `restore` putting humans at the back of the queue (`push` vs `unshift`): a start takes every entry it will take and `restore` runs synchronously right after it, so the lobby is empty and the order is moot (`unshift` is kept as the right behaviour once a start can be asynchronous).
- W4 — `listen` taking an ack passed first as the payload: every event validates its payload as `unknown`, and a function and `undefined` are both "not an object", so the refusal is the same.
- W6 — reading the starting SEATS per recipient in `createRoom` (the starting CLOCKS were the real defect, killed): at creation no seat has a grace countdown, so the seats list cannot differ between recipients.

**What the W7 re-run changed.** Nothing is taken on trust from an earlier pass: every set was re-run on the final code. Six mutants of the older harnesses (W3 ×2 grace, W4 ×4 override) had gone stale when W6 moved the `FOUR_*_MS` override rules into one shared
helper (`envMsOverride`); they were retargeted and now die. The W6 real-server mutants that had first been "killed" by an over-strict clock assertion were re-run on the final code: 9/9 killed, each by the check that names it. The W5 first-pass
kills were re-classified (see the frontend roll-up). The older harnesses edited files in place; W7 ran them unchanged on a disposable copy of both repos (`w7-run`: a patched copy of each harness whose root is a work tree, with the real tree hashed before and after).

**What was NOT verified.** The browser pass of the player screens (two tabs, bot fill with `FOUR_FILL_MS=3000`) was **not performed** — declined by the project owner for W7; see the frontend roll-up. Note for anyone doing it later: a lone human never gets bots
(the matchmaker needs at least two humans), so the check needs a second human (a second account, or a scripted guest socket), and the backend must be started with `FOUR_FILL_MS=3000 FOUR_GRACE_MS=3000`. Also open by design: the 4 Player nightly games never end by the
engine itself within 80 plies, and `FOUR_ALL_GONE_MS` has no override.

**Merge order.** `ci.yml` checked out the same-named branch of the frontend repo (since §20 only a `paired/<x>` branch does), and the nightly checks out its default branch: merge the frontend's `fourPlayerOnline` first (or together with this one).

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
   - `npm run test:spell` (`scripts/test-spell.mjs`, no server needed) — Spell Chess's server side: a **no-drift check** of the
     shared rules block in `src/game/spellChess.ts` against the mobile `src/logic/spellChess.ts`, `RoomManager.applyMove` as
     the authority for a spell turn (cast, then move), and parity with the mobile engine over random games. Regression
     cases: a Freeze lasts exactly the victim's next move; a FROZEN player who casts their own Freeze is still frozen that
     turn (the server used to read the frozen squares after the cast overwrote them); freezing every checking piece waives
     check (the server used to pass the wrong zone); castling is refused when the rook it moves is frozen. Mutation-checked
     against each of those three server defects.
   - `npm run test:horde` (`scripts/test-horde.mjs`, no server needed) — Horde's server side: a **no-drift check** of the shared
     rules block in `src/game/horde.ts` against the mobile `src/logic/horde.ts`, `RoomManager.applyMove` as the authority
     (the 36-pawn start; the positional double step — rank 1 AND rank 2 may double-step, blocked squares refuse it, rank 3
     never may, a pawn that stepped 1->2 may still double-step later; White wins by checkmate; Black wins by capturing
     every White piece with reason `horde` rather than the "stalemate" chess.js reports for it; a stalemate is a draw;
     "Black king vs a lone bishop" is not an insufficient-material draw; the saved PGN is tagged `[Variant "Horde"]`), and
     parity with the mobile engine over 10 random games (every offered move accepted with the same FEN, 43k sampled
     moves refused, same game-over verdicts). Mutation-checked against six server defects.
   - `npm run test:crazyhouse` (`scripts/test-crazyhouse.mjs`, no server needed) — Crazyhouse's server side: a **no-drift check** of the
     shared rules block in `src/game/crazyhouse.ts` against the mobile `src/logic/crazyhouse.ts`, `RoomManager.applyMove` as the
     authority (a capture banks the piece for the CAPTURER, a captured promoted piece banks a pawn; a drop is refused for a missing
     reserve piece, an occupied square, a pawn on rank 1/8, the wrong turn, a non-reserve piece type, a check it does not answer, a
     knight or double check, or outside a Crazyhouse room — each leaving the room untouched; a drop can mate (`Q@f8#`) and a "mate" a
     drop can answer is only check; stalemate with a droppable piece is not stalemate; king versus king is not a draw; a captured rook
     re-dropped on h1 does not restore castling; a dropped pawn gives no en passant; rejoin and spectate carry the reserves; the
     saved PGN is tagged `[Variant "Crazyhouse"]` with `P@e5` drops), and parity with the mobile engine over 12 random games
     biased to drops and captures (every offered move AND drop accepted with the same SAN, FEN and reserve/promoted state, ~75k
     sampled turns refused, same verdicts). Mutation-checked against server defects (see §11).
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
  lockstep (parity of legal moves/SAN/FEN/winner), and the same for Atomic, Duck Chess, Horde and Crazyhouse (the last two capped at 400 / 100 games, since their games are long and each ply builds an engine per candidate turn). (CI's own regression tests use far smaller counts — 6-80 games — to stay
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
- **Update (nightly #18):** one real source of a hidden-information refusal was found and fixed in §24 — castling was refused whenever a hidden piece attacked the king, which told the player about that piece. That is a plausible cause of the original report.
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
  king or rook crosses. Fog of War follows the same rule since §24 (it used to keep chess.js's attack-based castling rule, which was a bug).
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
first place. (2) CI checked against the same-named EM-Chess branch (`ci.yml` header; since §20 only for `paired/<x>` branches): push both repos' `fourPlayerOnline` branches together,
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

## 15. 4 Player Giveaway (server side) — the engine mirror and the wire contract (workstream W1)

Spec: the app repo's `FOUR_PLAYER_GIVEAWAY_SPEC.md`; rules, design and the FFA regression gate are in the app's `TESTING.md` §13. **W1 changes no server behaviour**:
no room manager, matchmaker, handler or bot file was touched, the server still builds every room with `initialState()` (Chess), and a `four_join_queue` is still handled
exactly as before (the room-manager plumbing for `variant` is W2). What changed here is only the GENERATED mirror and the tests that guard it.

**Mirror.** `giveaway.ts` joined the manifest (`MIRRORED_TO_BACKEND.json`, now the seven engine modules + the wire file); `npm run sync:fourplayer` regenerated
`src/game/fourPlayer/{giveaway,moves,elimination,state,index}.ts` and `src/game/fourPlayerWire.ts` (generated, never hand-edited); `sync:fourplayer --check` is green (9 generated files).
The only hand edits in this repo are tests: `test-fourplayer-sync.mjs` (its pinned manifest assertion: 7 → 8 files, `giveaway.ts` named) and `test-fourplayer.mjs` (below).

**Parity (`npm run test:fourplayer`, 34 → 47 checks).** The script keeps every Chess section unchanged (Chess coverage numbers are
identical to before: 159 games, 41 395 plies) and gains **section 5b**, with its own coverage tally so it cannot shift the Chess thresholds or shorten the Chess hunt:
- 30 random full Giveaway games from the start position (human-style moves with every promotion piece, resignations, flag falls through `clockTick`; 2 712 plies) in lockstep app engine vs
  mirror — position, legal moves, events, clocks, snapshot round trips and cross-engine deserialize at every ply;
- hand-built scenes asserted exactly on both engines, then a random continuation: the forced capture that hands Green the win, a stuck seat winning, last standing through a flag fall and
  off-turn resignations, the cap tie, en passant as the forced capture, **en passant against a resigned seat's pawn** (not offered), all four **capture-promotions**, a king capture and walls,
  no castling with every right set, **outOfPieces on the cap ply** (one `gameOver`), **the mover left stuck by a resignation**, **the cap with an eliminated seat holding the fewest pieces**,
  and a hand-built position's default of no castling rights;
- the **wire validators compared behaviourally** (`validateFourVariant`, `validateFourJoinQueue`, `validateFourTimeControl`, `validateFourMovePayload` over 24 inputs each = 96, plus
  `fourVariantOf` and `FOUR_REASONS`) between the app source and the generated copy — before this, section 1 only checked that the wire's exports exist;
- a coverage report that fails if a Giveaway rule was never reached (captures, king captured, en passant, all four promotions, resign, flag fall, endings by outOfPieces / stuck / lastStanding /
  cap, and **no points, no checkmate, no stalemate, no walking king** ever).
The Giveaway bot is not compared yet (W2).

**Regression gate (this repo, after the engine change):** `test:fourplayerSync` 111, `test:fourplayerRooms` 220, `test:fourplayerBots` 160, `test:fourplayerMatchmaking` 74,
`test:fourplayerHandlers` 61 checks — all pass unchanged (apart from the one pinned manifest line above); `tsc --noEmit` clean. The socket e2e (`test:fourplayerOnline`) is W4's territory and
was not re-run for W1: nothing on its path changed (no room / handler / wire behaviour differs for Chess).

**Mutation checks (copy-based, `mutate-gw1-parity.cjs`: a mutated copy of the generated mirror next to the real app engine; the parity script alone is what is measured).** 20 mutants — 18 in the
Giveaway touch points of the mirror (capture filter, walls capturable, kings not capturable, castling, en passant against a wall, `kings` bookkeeping, points, stuck, outOfPieces winner,
cap-before-outOfPieces, dead-king instead of frozen, last standing at two, the mover's post-resignation stuck check, cap winners most/eliminated, inverted filter, `GIVEAWAY_RULES`, castling defaults ×2)
and 2 in the wire copy. First pass **14 killed, 6 survived** — every survivor was a real blind spot of the parity script (the app and the mirror disagreed and nothing noticed): en passant against a wall,
cap-vs-outOfPieces ordering, the mover re-check after a resignation, eliminated seats at the cap, the hand-built castling default, and the wire validators (never compared behaviourally).
Each was closed with a named scene / the validator battery above: **20/20 killed**. No equivalents. (`sync:fourplayer --check` would also reject every one of these textually; that is a separate net.)

**Performance, payload size, cross-feature.** See the app's `TESTING.md` §13 (engine cost is shared code: Giveaway `legalMoves` 5.8 µs vs Chess 16.1 µs on the same positions; the snapshot is 428 characters,
Chess 430, so `four_state` size is unchanged). Nothing in the 2-player server (`socketHandlers`, `rooms`, `engine`) or in the Chess 4-player server path was modified.

## 16. 4 Player Giveaway (server side) — the variant through rooms, lobbies and handlers (workstream W2)

Spec: the app repo's `FOUR_PLAYER_GIVEAWAY_SPEC.md` §3.4 and §7; the bot and the rules are in the app's `TESTING.md` §13–§14. W2 changes the **server**:

- **Room manager** (`fourPlayerRooms.ts`): `createRoom({ variant })` (default and omitted = 4 Player Chess; an unknown value **throws**, including `null` and `""` — it never falls back to Chess quietly). The room keeps
  its variant for life and uses it for: the start state (`initialState(rulesFor(variant))`), `variant` in `four_match_found`, in the room state of a **spectate** and a **rejoin** answer, and in every row of the
  **active-games list**; and for `four_game_over.scores` — the final **points** for Chess, the **pieces left** (`piecesLeft`) for Giveaway, on every path including `abandoned`. The default **bot chooser** is now
  `chooseBotMoveFor` (dispatches on the position's rules), still injectable through the same `chooseBotMove` option. Nothing else in the manager knows a rule: the commit funnel, clocks, grace/takeover/retake,
  all-gone, fast-forward, chat and retention are unchanged and are exercised on Giveaway rooms by the new script.
- **Matchmaker** (`fourPlayerMatchmaking.ts`): lobbies are keyed by **time control and variant** (`300|0|giveaway` vs `300|0|ffa`), so a Chess player and a Giveaway player can never be matched; `join` validates
  the variant (error ack `Unknown game mode.`); `startGame(seats, timeControl, label, variant)`; `lobbySize(tc, variant = 'ffa')`.
- **Handlers** (`fourPlayerHandlers.ts`): `four_join_queue` accepts an optional `variant` (validated by the shared wire validator, so an unknown value never reaches the matchmaker) and passes it on; the other eight
  events are untouched. An old client's payload (no `variant`) is a Chess join.

**`npm run test:fourplayerGiveaway`** (new, wired into `ci.yml` after the handlers step; **89 checks**, no server, stub io / fake sockets / Node fake timers):
1. a room has one variant and says so everywhere (match found ×4, spectate, rejoin, the list), Chess traffic unchanged, `createRoom` refuses five bad variants and creates nothing;
2. **the server enforces the mandatory capture itself**: a quiet move while a capture exists → `Illegal move.`, nothing published, seq unchanged; the same position in a Chess room accepts it;
3. every ending reaches `four_game_over` with the right reason, winners and `scores`: `outOfPieces`, `stuck`, `lastStanding` (by resignations, one off-turn, frozen seat's walls), the ply cap (ties shared),
   a **flag fall** (`actor: clock`, eliminates the mover, 16 walls stay), `abandoned` (scores `[16,16,16,16]`); exactly one `four_game_over` per player, the room gone, **no timer left behind**, a late rejoin gets the same result;
4. **the bots**: the default chooser is the dispatching one; **12 whole Giveaway games with three bots at mixed ELOs** (1 172 published states) with `console.error` spied — **no bot ever returned a fault or an
   illegal move**; every snapshot has no points and no castling rights; endings `outOfPieces` 11, `stuck` 1; a **takeover bot** on a position where its seat must capture plays the capture, and the retaking human's
   answer still says `giveaway`; a Chess room with the same default chooser plays a whole game (398 states) under Chess rules with no fault and `scores` still points;
5. the matchmaker: a Chess and a Giveaway player at the same time control sit in different lobbies, are told "1 queued, no timer", nothing starts however long they wait; each lobby's fill timer starts its own
   variant (passed to `startGame`); four Giveaway players start at once; unknown variants refused;
6. the real handlers on fake sockets: two Giveaway clients and two **old clients** (no `variant`) queue at the same time control and are matched into two different rooms announcing `giveaway` and `ffa`; the Giveaway
   room starts without castling rights and the Chess room with all of them; an unknown variant is refused by the validator with its own message and the socket is not queued; a seated socket can't queue again.

**Parity (`npm run test:fourplayer`, 47 → 53 checks).** The Giveaway section now also plays **bot games in lockstep** (8 games, 618 decisions at ELO 600 / 1200 / 3000, plus the dispatching chooser) and three
**constructed sweeps** where the heuristic's constants sit mid-decision (the last-piece capture over 4 900 decisions, the victim term over 6 000 — 71 % take the richer victim: not never, not always — the exposure term
over 3 200, and the "do not leave the next seat stuck" jump over 3 000): app engine and generated mirror choose **identically** every time. The Chess coverage numbers are unchanged (159 games, 41 395 plies).

**Mutation checks (copy-based, `mutate-gw2.cjs backend`).** 17 planted bugs in rooms / matchmaker / handlers against the new script: first pass **15 killed, 2 survived** — `lobbySize` defaulting to the wrong
variant (the first test had one player in each lobby, so it could not tell; now asymmetric → killed) and "queue entries forget their variant", which is **equivalent and documented inline** (the lobby, keyed by the variant,
is what `start`/`restore` read; the entry's copy is informational). **16/16 killable killed + 1 equivalent.** Mirrored bot: 8 mutants, **8/8 killed** (one needed a new constructed sweep — see above).

**Regression gate.** `test:fourplayerSync` 114, `test:fourplayer` 53, `test:fourplayerRooms` 220, `test:fourplayerBots` 160, `test:fourplayerMatchmaking` 74, `test:fourplayerHandlers` 61 — all unchanged and passing; `tsc`
clean; `sync:fourplayer --check` green (10 generated files). **The real-socket e2e (`test:fourplayerOnline`), run against a throwaway server on :3101 (stopped afterwards by PID), caught one assertion that is
now different: 198 checks pass, with the active-games listing check changed from `roomId,seats,timeControlLabel` to also allow `variant` (`"ffa"`) — an additive field, still no token / socket id / user id.** That is the only
change a Chess client can see on the wire: a `variant: "ffa"` key on `four_match_found`, the rejoin/spectate room state and the list rows.

**Existing tests edited in W2:** `test-fourplayer-sync.mjs` (manifest 8 → 9 files), `test-fourplayer-online.mjs` (the listing key set above). Nothing was relaxed beyond the new field. `fourplayer-test-kit.mjs`
gained an optional `variant` option for `newGame`.

**Known limits / next.** No Giveaway real-socket scenarios yet (W4: forced capture refused over a socket, last-piece win, stuck win, lobbies never mixing, the nightly fuzz section). The "new client Giveaway + old
server" row of the compatibility matrix is a client behaviour (W3). Deploy order stays: backend first, then the app.

## 17. 4 Player Giveaway (server side) — what W3 changed here (workstream W3)

W3 is the app's screens (frontend `TESTING.md` §15); **no server behaviour changed**. The one thing that touched this repo: `FourVariant` (`'ffa' | 'giveaway'`) moved from the wire file into the engine's
`state.ts` (next to `rulesFor`, which uses it) and `fourPlayerWire.ts` now re-exports it (`export type { FourVariant }`), so the app's local screens can use the type without importing the wire. Both files are GENERATED
mirrors: `npm run sync:fourplayer` regenerated them (`--check` green, 10 generated files) and nothing else in `src/` changed. The type-only move is invisible at runtime; the parity script's wire-validator battery and
every other four-player script pass unchanged: `test:fourplayerSync` 114, `test:fourplayer` 53, `test:fourplayerRooms` 220, `test:fourplayerBots` 160, `test:fourplayerMatchmaking` 74, `test:fourplayerHandlers` 61,
`test:fourplayerGiveaway` 89; `tsc` clean. No Giveaway real-socket scenarios yet (W4).

## 18. 4 Player Giveaway (server side) — real sockets: the e2e scenarios and the nightly fuzz (workstream W4)

Spec: the app repo's `FOUR_PLAYER_GIVEAWAY_SPEC.md` §9–§10. W4 adds no server behaviour: it proves, over REAL socket.io connections, what the in-process tests (§16) proved on stubs. Changes: `scripts/test-fourplayer-online.mjs` (7 new
scenarios), `scripts/nightly-fuzz-online.mjs` (a 4 Player Giveaway section), `ci.yml` (the e2e step label/comment) and `nightly.yml` (the new argument). One comment-only edit in `fourPlayerMatchmaking.ts` (an equivalent-mutant note).

**`npm run test:fourplayerOnline` — 198 → 287 checks.** The Chess scenarios 1–9 are untouched (apart from the listing key set, W2); scenarios 10–16 are new and use FOUR real clients per room, each reading its snapshots with the Giveaway rules:
10. four sockets queue with `variant: "giveaway"` → one room, every `four_match_found` names `giveaway`, the four starting snapshots are byte-identical and equal the Giveaway start (castling `0`, scores `0,0,0,0`); the listing row and a spectator's state say `giveaway`;
11. **a quiet move while a capture is mandatory is refused** (`Illegal move.`, nothing published to anyone, seq unchanged), then a capture is accepted and exactly one piece leaves the board — reached by playing random legal moves through the sockets until the seat on move must capture;
12. **a whole natural game** with a spectator: identical `four_game_over` to all four seats and the spectator, the result equal to the one inside its final snapshot, `scores` = pieces left, the Giveaway rule it names checked against the final position (outOfPieces: the winner has none left; stuck: the seat on move has pieces and no legal move; lastStanding; cap = the fewest pieces), `four_state` seqs 1..N with no gap, **all four players holding the byte-identical snapshot at every one of the 127 seqs** (in the first run), and a late rejoin answering the same result;
13. resignations: a seat resigning off-turn is **frozen** (never a walking king), its 16 pieces stay as walls, it can no longer move, and the third resignation ends the game `lastStanding` with scores `[16,16,16,16]`;
14. **takeover over real sockets on a forced capture**: the seat on move (which must capture) drops, the grace passes, the bot takes the seat (keeping the name), and its very next move is a **capture** that the app engine lists as legal; the human then retakes the seat by token and the answer names the variant;
15. a Giveaway and a Chess room live at once: the listing tags them `giveaway` / `ffa`, spectating each returns its own start position, and each ends with its own kind of `scores` (pieces vs points);
16. **lobbies never mix**: three Chess players (one with an explicit `"ffa"`, two as an older client would) and one Giveaway player at the same time control — four humans waiting, **no game starts**, each side is told its own count; a fourth Chess player starts the Chess room without the Giveaway player; five malformed variants (`"bughouse"`, `"Giveaway"`, `""`, `null`, `3`) are refused over the wire with `Unknown game mode.`.
Run 3 times with different `FOUR_E2E_SEED`s: 287 checks each, no flake (scenario 12's moves are paced under the server's 10-moves-per-second limit).
**What a socket cannot force:** the positions that end a game by `outOfPieces` or `stuck` (and the cap) need hand-built positions, which the real server has no hook for (and must not). Those are pinned in-process (§16: the scripted games, `test-fourplayer-giveaway.mjs`) and in the engine's property test; over sockets they are exercised only when a random game happens to end that way (scenario 12 and the fuzz check whichever it is).

**Nightly fuzz (`nightly-fuzz-online.mjs`, new 7th argument `[fourPlayerGiveawayGames]`, defaults to the 4 Player Chess count; `nightly.yml` now runs `200 80 200 200 200 40 40`).** `playFourPlayerGame(game, variant)` is the Chess driver parametrised: the clients read snapshots with the Giveaway rules from the
**app's own engine** (independent of the server's mirror), join with `variant: "giveaway"` as the app does, and check, per game: byte-identical snapshots at every seq, contiguous seqs, every client-computed legal move accepted, illegal / out-of-turn moves refused with the room untouched, **plus a quiet move while a capture is mandatory refused**,
`four_match_found` and the rejoin answer naming the variant, resignations, random disconnects with a bot takeover and a retake, and at the end the `four_game_over` agreeing across seats, with the app engine's reading of the final position (reason, winners, `scores` = pieces left) and with the Giveaway rule it names (outOfPieces / stuck / lastStanding / cap), and a late rejoin returning the result.
First runs against a throwaway server: 8 games at 80 plies (624 plies, 426 illegal / out-of-turn / quiet-while-capture-mandatory moves refused, 3 rejoin cycles, 5 takeovers, 17 resignations, 3 natural ends) and 8 games at 400 plies (901 plies, all 8 ended by the engine itself): **0 issues**. The 4 Player Chess section is unchanged in behaviour (6 games, 0 issues).
**A bug the fuzz found — in the harness, not the server:** the first long Giveaway run reported 59 `implausible-clocks`: the check capped a clock at 300 s + 60 s, but with the 2 s increment a seat that has moved ~34 times legitimately holds 368 s (Chess games were capped at 80 plies and never got there). The ceiling is now initial + increment × states so far; the fix is in the fuzz, the server was right.

**Mutation checks (copy-based; each mutant runs a SPAWNED server from a mutated copy of `backend/` on its own port — the script owns the process and stops it by pid — against the real-socket e2e).** 12 planted server bugs: the start position ignoring the variant, `four_match_found` / the listing / the spectate-and-rejoin room state carrying no variant, game-over `scores` as points, the lobby key ignoring the variant, the variant not validated, the handler dropping the variant, the capture not mandatory, a resigned seat walking as a dead king,
the last-piece win missing, last-standing at two seats. **11 killed, 1 survived — and the survivor is equivalent at socket level and documented inline** (`matchmaker: the variant is not validated`: over a socket the handler's shared validator refuses an unknown variant before the matchmaker is reached; it is killed in-process by §16's direct join). One caveat on "the capture is not mandatory": the e2e's own clients use the server's mirror, so that mutant is killed by the scenario not being able to reach a must-capture position
at all; the nightly fuzz (independent app-engine clients) kills it by `server-ACCEPTED-quiet-move-while-capture-mandatory` — see next. **Fuzz mutation checks** (a mutated server, the fuzz's Giveaway section against it): 7 bugs; the capture filter (18 issues), points-as-scores (12), the missing variant on match-found (6) and on rejoin (3), the missing last-piece win (6) are killed; **last standing at two seats** survived at 400 plies (those games all end naturally) and is killed at the CI setting of 80 plies, where games end by resignation (`giveaway-lastStanding-with-several-seats-left`); the cap-winner mutant cannot be reached (a game never lasts 1000 plies) and is covered by the engine's tests and the parity script.

**CI / nightly.** `ci.yml`: the existing e2e step (the same script, now holding the Giveaway scenarios; it already starts the dev server with `FOUR_GRACE_MS`); `nightly.yml`: the fuzz invocation gains `40` Giveaway games (about 4 more minutes). The in-process `test:fourplayerGiveaway` step was added in W2.
The throwaway servers used for these runs (ports 3101-3103) were started by this session and stopped by pid after their process chains were checked; nothing on the usual ports was touched.

## 19. 4 Player Giveaway (server side) — close-out (workstream W5)

No server behaviour or script changed in W5. What was done here: every workstream's mutation set re-run on the final code (results in the roll-up at the top; the raw per-mutant lists are the harness outputs of the session, the equivalent ones are named in the source), the full set of four-player scripts and `sync:fourplayer --check`
re-run green, and the online browser pass in the app repo (frontend §17) was driven against the owner's own dev backend with a scripted unauthenticated guest socket as the second human. That pass found one app-side wording gap (the online Resign dialog) and nothing on the server.
The throwaway servers used by the mutation harnesses (ports 3101-3103) were started by the harnesses, owned by pid, and none is left running.

## 20. CI frontend pairing is explicit (`paired/<x>`), never by coincidence of names

**What it does now.** The first step of `ci.yml` ("Pick the frontend ref") decides which EM-Chess ref the backend CI checks out (the backend's tests import the app's engine and the mirror check compares against it). The rule:

| Backend branch (`github.head_ref` / `github.ref_name`) | EM-Chess has the same name? | Frontend ref used |
|---|---|---|
| `paired/<x>` | yes | `paired/<x>` |
| `paired/<x>` | no | the default branch |
| anything else (`main`, `fourPlayerGiveaway`, `workflow-yaml-precheck`, ...) | yes or no | the default branch (a same-named frontend branch is ignored on purpose) |

The nightly always uses the default branch (unchanged). The frontend CI never checks out the backend.

**Why.** It used to pair on ANY same-named branch. Two unrelated tooling branches that both happened to be called `workflow-yaml-precheck` made PR #6 test against a frontend branch that predated the Giveaway engine, and the mirror check failed for a reason that had nothing to do with the change. Opting in by a name prefix is visible in both repos, behaves the same on `push` and `pull_request` runs (a commit-message or PR-body tag would not: the PR body exists only on one of them), and cannot happen by accident.

**How to use it.** A feature that needs unmerged code in BOTH repos: name the branch `paired/<x>` in both, push the frontend first, then the backend. Merge the frontend PR first and delete its `paired/<x>` branch afterwards: a stale paired branch that predates the code now on the default branch would keep being used for as long as it exists. The step prints its decision and writes it as a notice annotation ("Frontend ref" / "Frontend checkout", visible on the run page and through the API without a login).

**How it was checked.** The step's script, extracted from the workflow, was run locally against a fake `git ls-remote` for eight cases (paired with a twin, paired without one, an unprefixed same-named branch, `main`, a bare `paired/`, a name with a space, `xpaired/x`, and a name containing `$(touch pwned)` to show the name is never executed): all as expected. Then a throwaway pair of branches in both repos ran the real CI (see the commit message of this change for the run ids); the throwaway branches were deleted afterwards.

## 21. Spell Chess (server side) — design, decisions and known limits

Branch pair `paired/spell-chess`; the app's half is the frontend `TESTING.md` §18 (rules, UI, browser checks). The server is the only authority: the cast and the move arrive together in `make_move { from, to, promotion?, spell? }`.

**How a turn is validated (`RoomManager.applyMove`).** (1) The cast, if any, is checked against the room's own `SpellChessState` first: an unknown `type` is "Invalid spell cast.", Freeze needs a center and a charge off cooldown, Jump needs an occupied square and a charge off cooldown ("Freeze/Jump is not available right now.") —
a bad cast refuses the WHOLE turn before the room is touched. The client sends only `{ type, center | square }`; the server recomputes the 3x3 zone itself and never trusts the client's `squares`. (2) `spellTurnContext(room.spellState, mover, cast)` gives the frozen squares (read from the state BEFORE the cast), the jump square (AFTER it) and the zone cast
this turn, and the check waiver is derived from that zone. (3) The move is tried on a SCRATCH `RoomChessEngine` built with those options; a refusal is "Invalid move." and nothing changed. (4) On success the room adopts the scratch engine and `afterSpellChessMove(stateAfterCast, mover)`. A king capture via a Jump is checked
BEFORE `isGameOver()` (the kingless position would otherwise be read as a stalemate draw) and ends the game with reason `spellChess`. Every payload that shows a position carries the whole `spellState` (the move ack, `opponent_move` with the `spell`, rejoin, spectate, `match_found`); the PGN gets `{F@e4}` / `{J@d5}` comments and a `Spell` variant tag.
Mutually exclusive with every other variant: `conflictingVariantError` refuses it combined with another flag, and the matchmaker's exact-match predicate never pairs a Spell seeker with another kind of seeker.

**Tests.** `scripts/test-spell.mjs` (27 checks, in-process with a stub socket server, wired into CI as `npm run test:spell`): the NO-DRIFT layer (the shared rules block is byte-identical to the app's), THE AUTHORITY (frozen pieces, castling with a frozen rook, the check waiver, the turn-context trap) and PARITY (the server and the app engine agree ply by ply over seeded random games).
`scripts/test-multiplayer.mjs` (real sockets; the Spell scenario is 38 checks, the whole script 224): queue isolation and the "cannot be combined" refusals, a challenge carrying the variant, bad casts refused for the whole turn, Freeze with its zone (frozen pieces refused, one-reply lifetime, cooldown), Jump (charge spent, cooldown), the move
ack / opponent move / rejoin / spectate answers carrying the spell state and the casts, and the Spell-only ending: `1.e4 a6 2.Qh5 a5 3.Qxe8` with a Jump over f7 captures the king (reason `spellChess`). **`npm run spell-opponent`** (`scripts/spell-opponent.mjs`, same modes as `duck-opponent`) is a dev-only guest that plays random LEGAL Spell turns with the app's own engine
(`chooseSpellChessBotCast` plus random extra casts, `spellTurnContext`, `getSpellChessLegalMoves`); two of them played a full game against each other on a throwaway server (checkmate, no refusal, casts all along). Not in CI.

**Mutation check (CHECKLIST §2), on a copy; each mutant runs the in-process script and then the real-socket e2e against a server SPAWNED from the mutated copy.** 22 planted server bugs: a Freeze / Jump cast accepted without a charge or cooldown, a Jump on an empty square, an unknown cast type ignored, the frozen squares read after the cast, the check waiver never active,
the spell state not advanced, the cast / spell state missing from the opponent's move, the ack, the rejoin answer and the spectate answer, a king capture that does not end the game, a wrong starting spell state, Spell combinable with another variant, a challenge forgetting the variant (creator side), Spell seekers paired with classic seekers, and four engine bugs
(a frozen piece moves, castling with a frozen rook, no Jump captures, the waiver ignored). **21 killed (7 by the in-process script, 14 by the e2e), 1 equivalent, documented inline** (`socketHandlers.ts`: the challenge JOINER's `isSpellChess` is never read, because `pairAndCreateRoom` takes every flag from the first entry). The first pass left four more survivors,
all real gaps, closed before this count: Jump availability (no test cast Jump twice), the rejoin answer's and the spectate answer's spell state (no test read them), and the king capture (it had no real-socket ending). Two of the 22 first had patterns that matched nothing (they were rewritten, not counted as kills).

**Known limits.** The nightly fuzz has no Spell section (the in-process parity over seeded random games and the e2e scenario cover the rules and the protocol; a Spell fuzz would need cast generation in the fuzz's clients - the dev opponent has it); Spell Chess is excluded from Tournaments and its games are not rated.
## 22. Horde (server side) — design, decisions and known limits

The rules are in `src/game/horde.ts` (a verbatim mirror of the mobile app's rules block, guarded by `test-horde.mjs`'s no-drift
check) on top of `RoomChessEngine`'s opt-in `horde` option. The mobile app's `src/logic/horde.ts` header has the full rules
(chess.com: 36 White pawns, no White king; White wins by checkmate, Black by capturing everything; stalemate is a draw).

**Much less custom than Giveaway/Atomic/Duck Chess.** chess.js (loaded with skipValidation, which `horde` implies) already
tolerates a missing White king and plays Black's legal moves, checkmate and stalemate correctly. The server adds exactly:
- the **rank-1 double step** (rank 1 -> 3), the one move chess.js cannot generate (it already does rank 2 -> 4), applied through
  chess.js's unvalidated `_makeMove` with its BIG_PAWN flag;
- overrides of the two things chess.js gets wrong: `isInsufficientMaterial` (it calls "Black king + a lone White bishop" a
  draw), and a White side with no pieces left ("stalemate" to chess.js, but Black's WIN) — `RoomManager.applyMove` checks
  `getHordeWinnerFromFen` BEFORE asking the engine whether the game is over, and the game ends with reason `horde`.

**Decisions worth knowing**
- **En passant after a rank-1 double step is allowed** (`HORDE_FIRST_RANK_DOUBLE_STEP_ALLOWS_EN_PASSANT`, shared block). chess.com
  says only "en passant captures are allowed"; Lichess (and the chessops library the mobile tests use as an oracle) forbids
  it for this one case. Flip the constant in BOTH copies to follow Lichess.
- Black keeps its castling rights (the start FEN is `... w kq - 0 1`); White has none to lose.
- No threefold repetition (same as every non-Atomic mode); the fifty-move rule is read from the FEN's halfmove clock.
- Wire format: `isHorde` on `join_queue`/`create_challenge`/`match_found`/rejoin/spectate state, `horde` as a `game_over`
  reason. Horde cannot combine with any other variant (rejected on `join_queue`/`create_challenge`); tournaments and Setup Chess
  never create Horde rooms. Saved PGNs get `[Variant "Horde"]` plus the SetUp/FEN headers (the start is not standard).

**How it is tested:** see §1 (`test:horde`, the Horde block of `test-multiplayer.mjs` — a real socket game from the 36-pawn
start to a resignation) and §2 (nightly logic parity — at most 400 games, since Horde games are long — and online fuzz with
illegal-move probes, checking every `game_over` against the mobile verdict).

**Known limits**
- The socket test plays only a short game; the endings (mate, capture-everything, stalemate) are covered through
  `RoomManager` with a stub socket server in `test-horde.mjs` and by the nightly online fuzz, not by a scripted socket game.

**Mutation check on the merged code (CHECKLIST §2; on a copy; each mutant runs `test-horde.mjs` and then the real-socket e2e against a server SPAWNED from the mutated copy).** 12 server bugs: a Horde room starting from the standard position, Black not winning when White has no pieces, the `isHorde` flag missing from the rejoin and from the spectate answer,
Horde combinable with another variant, Horde seekers paired with classic seekers, the first-rank double step not applied, an empty horde not game over, insufficient material drawing a Horde game, the fifty-move rule dropped, and the double step working for any piece or for Black. **First pass 6 killed, 6 survived — all real gaps** (no engine-level test of the empty horde with Black to move,
of the fifty-move rule or of the pawn-only / White-only double step, and nothing read `isHorde` in the rejoin and spectate answers). Closed by section 2b of `test-horde.mjs` and the Horde e2e scenario: **12/12 killed (8 by the in-process script, 4 by the e2e), 0 equivalents.**

## 23. Crazyhouse (server side) — design, decisions and known limits

The rules are in `src/game/crazyhouse.ts` (a verbatim mirror of the mobile app's rules block, guarded by `test-crazyhouse.mjs`'s no-drift
check) on top of `RoomChessEngine`'s opt-in `crazyhouse` option. The mobile app's `src/logic/crazyhouse.ts` header has the full rules and the
promoted-piece tracking (chess.com: captured pieces change colour into the capturer's reserve; a turn is one move OR one drop; a captured
promoted piece is banked as a pawn; drops may give mate; notation `N@f3`).

**What the server adds on top of chess.js** (which stays authoritative for every ordinary move, castling, en passant and promotion):
- `drop(piece, square)`: legality from the shared geometry (`legalDropSquares`: reserve has the piece, empty square, no pawn on rank 1/8,
  and — in check — only a block of a single sliding check), then the FEN is edited (piece placed, turn flipped, en passant cleared,
  halfmove clock reset, fullmove advanced) and chess.js reloaded. Castling rights are flags chess.js keeps, so a re-dropped rook does
  not restore them.
- The **reserve + promoted-squares state lives INSIDE `room.engine`** and is updated by every `move()`/`drop()` (so the server needs no
  second copy to keep in sync, unlike Duck Chess's `room.duckSquare`); `getCrazyhouseState()` exposes it for the wire.
- `getStatus()`/`isGameOver()` overrides: checkmate/stalemate only when the side also has no legal drop; chess.js's insufficient-material
  draw is never used; the fifty-move rule stays. Because of this, **`RoomManager.applyMove` needs no Crazyhouse-specific end-of-game
  branch**: the generic `isGameOver()`/`getStatus()` path is already right (and no new `GameOverReason` exists).

**Wire format.** `make_move` carries `drop` (a reserve piece type; `from` and `to` are both the target square). The server validates it at
the door (must be one of the five reserve types, in a Crazyhouse room, with a target square) and then by the engine. `opponent_move` /
`spectator_move` carry `drop` and the full `crazyhouse` state; the mover's ack carries the state too; `rejoin_game` and `spectate_game`
carry the state plus `drop` on each move-list entry. `isCrazyhouse` is on `join_queue`/`create_challenge`/`match_found`/rejoin. It cannot be
combined with any other variant (`conflictingVariantError`), and tournaments and Setup Chess never create Crazyhouse rooms.

**How it is tested:** `test:crazyhouse` (§1), the Crazyhouse block of `test-multiplayer.mjs` (a real socket game: pairing is separate from classic,
combining flags is rejected, a capture's state reaches the opponent, an illegal drop is refused, a legal drop is acked and pushed with the
state, resignation), and the nightly logic parity (≤100 games) and online fuzz (illegal move AND illegal drop probes, every ack and
`opponent_move` compared with the mobile engine's position and state, every `game_over` with its verdict).

**Mutation testing (46 mutants over the shared block, the server engine and `RoomManager`)**: 35 were killed on the first run; the rest
exposed genuine gaps in the authority tests, all closed (a flipped pawn-check direction, a queen not checking along a diagonal, one
wrong knight step, a stale promoted mark, any captured piece banked as a pawn, castling not carrying a promoted rook, shared clone
arrays, the fifty-move rule, the move ack omitting the state, the PGN variant tag). Seven survivors are equivalent: a double check is
excluded twice (`crazyhouseCheckInfo` and `legalDropSquares`), a king can never be banked, an en passant victim is a pawn and never
marked, chess.js's `put()` already clears the en passant square, and `RoomManager`'s door check on `drop` duplicates what
`legalDropSquares` and `put()` refuse anyway (kept as defence in depth). Shared-block mutants are applied to BOTH copies so the
no-drift check cannot be what kills them.

**Known limits**
- The socket test plays a short game; the endings (mate by drop, answerable mate, stalemate with a droppable piece) are covered through
  `RoomManager` with a stub socket server in `test-crazyhouse.mjs` and by the nightly online fuzz, not by a scripted socket game.
- No threefold repetition (as in every non-Atomic mode); the fifty-move rule is read from the FEN's halfmove clock.

**Mutation check on the merged code (CHECKLIST §2; on a copy; each mutant runs `test-crazyhouse.mjs` and then the real-socket e2e against a server SPAWNED from the mutated copy).** 17 server bugs: a drop accepted outside Crazyhouse or with a junk piece type, a drop played as an ordinary move, the opponent not told about the drop and the reserves, the rejoin answer without the reserves, Crazyhouse combinable with another variant, Crazyhouse seekers
paired with classic seekers, seven engine bugs (a drop with an empty reserve, a drop that does not hand the turn over / keeps the halfmove clock / is not spent from the reserve, a mate declared although a drop could answer it, no fifty-move rule, no check marker in the drop notation) and three in the server's twin of the shared rules block (killed by the no-drift check, which is its job).
**First pass 15 killed, 2 survived: 1 real gap, 1 equivalent.** The gap: nothing refused a `drop` in the payload of a classic room when from->to happened to be a legal ordinary move (the move would have been played and the drop ignored); closed in section 2 of `test-crazyhouse.mjs` (78 checks now). The equivalent is documented inline in `rooms.ts`: the `RESERVE_PIECE_TYPES` test is defence in depth, since `legalDropSquares`
already answers [] for a piece type the reserve has no slot for. **16 killed (14 in-process, 3 of them by the no-drift check; 2 by the e2e), 1 equivalent.**

## 24. Fog of War castling has no check conditions (nightly #18 / backend issue #12)

Full spec, the audit table, the bot and the information-leak audit live in the frontend repo's TESTING.md §22; this is the server's half.

- **The rule** (chess.com): in Fog of War the king "can castle while in check, and can castle through, or into check". A castle needs only the castling right on that side, king on e1/e8, rook on its corner, the squares between empty. Nothing about attacks. Chess960 + Fog of War is not combinable (`conflictingVariantError`), so there is nothing to specify for it.
- **What was wrong.** `RoomChessEngine.movePseudoLegal` is chess.js's `_moves({ legal: false })`, which keeps its castling check conditions. The server sees the TRUE board, the client only its fog, so a castle the client offered (nothing attacks the king in its view) was answered "Invalid move." whenever a piece the player could not see attacked the king or a square it crosses — nightly #18, game 171, ply 42 (hidden bishop b4 against e1). The refusal itself leaked "a hidden piece attacks your king".
- **The fix.** `addUnrestrictedCastles` in `RoomChessEngine.ts` (byte-identical to `ChessEngine.ts` in the app, `// BEGIN/END unrestricted-castles`), used by `generateRaw` for Duck Chess (plus the duck's obstruction) and for the plain pseudo-legal path = Fog of War. Spell Chess keeps chess.js's castling (its freeze-escape move uses the same API); Giveaway has none. `rooms.ts` is unchanged: it delegates to `movePseudoLegal`.
- **Tests.** `npm run test:fogOfWarCastling` (61 checks, in CI's Fog of War step): no-drift, out of / through / into check on both engines and both colours, everything that still forbids a castle, the variants that must not change, game 171 through `RoomManager.applyMove`, parity over ~4000 random castling-rich positions, and a strict property — for ~6000 random true positions every move the player's own redacted view offers is accepted except a quiet pawn push (0 other refusals in ~236k moves; ~3800 of them castles the ordinary rule forbids). `test-multiplayer.mjs` §13b: two real-socket games (O-O through a check from a hidden bishop on a6; O-O-O out of a check from a hidden bishop on b4).
- **The nightly stays strict.** `nightly-fuzz-online.mjs` still accepts exactly one refusal in Fog of War, the blind quiet pawn push (§5), and now picks a castle half the time one is available; a refused castle is its own failing kind, `server-refused-legal-fow-castle`. Do not whitelist it: it is the §24 bug.
- **Mutation** (copy-based): 15 server mutants (check condition back, Spell Chess let in, one wing, rights/rook/between/b-file/king ignored, wrong rank, duplicate, wrong flag, duck obstruction dropped, drift, `rooms.ts` using the ordinary `move()`) — all killed; the headline ones (check condition back, ordinary `move()`) are killed by the real-socket e2e alone as well.
- **Found next to it and fixed in §25:** the SAN returned for a Fog of War move carried chess.js's `+`/`#` computed on the true board (a discovered check by a hidden piece notified the victim).

## 25. Fog of War never announces a check (the "Nc3+" leak)

Full spec, the audit table and the sound/haptic finding live in the frontend repo's TESTING.md §23; this is the server's half.

- **What was wrong.** `RoomChessEngine.movePseudoLegal` returned chess.js's SAN, whose `+`/`#` is computed on the TRUE board. The mover's ack, the opponent's `opponent_move` and a rejoining player's history all carried it, so a discovered check by a piece the victim cannot see arrived as `Nc3+` (found while auditing the castling fix: initial FEN `4k3/6b1/8/8/4N3/8/8/4R1K1`, Ne4-c3).
- **The fix.** `fogOfWarNotation.ts` (byte-identical to the app's `src/logic/fogOfWarNotation.ts`): `movePseudoLegal` on the plain pseudo-legal path (= Fog of War; Spell Chess keeps its real notation, Duck/Giveaway already strip) returns `san` without the marker and the real text as `trueSan`. `room.moves` keeps `trueSan`; `rooms.ts` hands the real notation ONLY to spectators (`spectator_move`, the `spectate_game` state — through `withTrueNotation`, which also removes the field from the wire) and to the finished game's saved PGN. Everything addressed to a player (ack, `opponent_move`, `rejoin_game` history) reads `san`.
- **Tests.** `npm run test:fogOfWarNotation` (35 checks, in CI's Fog of War step): no-drift, engine parity over 150 random games, the exact repro through `RoomManager.applyMove` (ack / Black / spectator / late spectator / both rejoins / PGN call site), a property over 250 random games with a spectator and mid-game rejoins (no payload addressed to a player ever carries a marker or a `trueSan`; spectators received thousands, so it is not vacuous), and the pawn-capture probe (point (a): same refusal text and shape as any malformed move, and the app's generator never offers it). `test-multiplayer.mjs` §13c: real sockets, `1.e4 d6 2.Bb5+`.
- **The nightly stays strict.** In the Fog of War loop any `+`/`#` in an ack or `opponent_move` (or a `trueSan` field) is the failing kind `fow-check-notation-leak`. Against a server with the old behaviour, 40 games gave 580 such issues and exit code 1. Never whitelist it.
- **Mutation** (copies): 12 server mutants (suffix back, Spell Chess stripped, `+`-only helper, drift, opponent / ack sent the real notation, spectators sent the stripped one, spectate state / PGN not restored, `trueSan` left on the wire, rejoin history real) — all killed; four of them by the real-socket e2e alone.

## 26. Threefold repetition — one rule for every two-player mode

Full spec (the per-mode definition of a position, the Fog of War decision, Undo, ratings) is the frontend repo's TESTING.md §24; this is the server's half.

- **What changed.** Before, only Atomic (an FEN list) and the classic family (chess.js on the live engine, reason `'draw'`) ended on a repetition; Spell, Duck, Horde, Crazyhouse and Fog of War never did. Now `rooms.ts` keeps `room.repetitionKeys` for EVERY mode — the key of the starting position and of the position after every move, built with `repetition.ts` (byte-identical to the app's) plus the variant state (`repetitionExtraOf`: Three-Check counters, Crazyhouse pockets + promoted squares, the duck, the Spell state; Fog of War keys the TRUE position). After a move that did not already end the game decisively, `isThreefoldRepetition` ends it with reason `'repetition'` (a draw, no winner) — checked *before* chess.js's `isGameOver()` in each branch, so the reason is not the generic `'draw'`. The list lives in the room, so a player's rejoin changes nothing.
- **Tests.** `npm run test:repetition` (86 checks, in CI): no-drift, every mode through `RoomManager.applyMove` (third occurrence at ply 8 — ply 9 for Duck Chess — and not before), look-alikes (lost castling rights, a moving duck, a cast spell), rejoin mid-repetition, and ply-by-ply parity with the app's `historyRepetitionKeys` including ~240 random repetition-prone games. `test-multiplayer.mjs` §13d: real sockets (Classic with reconnects between the second and third occurrence, Fog of War, Crazyhouse). Nightly online fuzz: a section plays the shuffle over real sockets in 9 modes (`repetition-not-declared` / `repetition-too-early` fail the run; against a server without Fog of War's repetition it reported 2 issues and exit 1), and the Atomic section's expectation now uses the shared key.
- **Mutation** (copy-based): 20 server mutants (a branch that never checks, the position not recorded, the start position not recorded, each variant's state left out of the key, reported as `'draw'`, won by the mover, Fog of War keyed on the redacted view, drift, castling / en passant / threshold changes) — all killed; three headline ones by the e2e alone.
- **Compatibility.** `GameOverReason` gains `'repetition'`; an older client has no text for it (the app's `describeEndReason` handles it from this release on).

## 27. Rejoin after an app restart — what the server guarantees (no server change)

The app now remembers the online game it is in (frontend TESTING.md §25) and rejoins it after a reload / kill. The server needed **no change**: `rejoin_game` (2 players) and `four_rejoin` (4 Player) are keyed by room id + token, never by socket, so a brand-new connection holding the token takes the seat back; the token is not single-use; the grace stays 45 s (`ABANDONMENT_GRACE_MS` / `FOUR_TAKEOVER_GRACE_MS`) and a finished game's result is kept 5 minutes (`FINISHED_RETENTION_MS`) — which is why the app's window is 6 minutes.

`npm run test:rejoinPersist` (`scripts/test-rejoin-persist.mjs`, in CI after the 4 Player e2e; needs the `FOUR_GRACE_MS` dev server) pins it with real sockets and a **real new OS process** as the restarted app (`scripts/rejoin-client-process.mjs`: it has only the saved record, read with the app's own `parseActiveGame`):
- Classic: live position, 3-ply move list and clocks come back; the opponent gets `opponent_disconnected` then `opponent_reconnected`, never a `game_over`; the process hears the opponent's next move and can make its own; a second restart works; a forged token is refused (and told nothing about a finished game); a result that arrived while the app was away is returned as `finished` (resignation, won by the right side).
- Variant state: Crazyhouse pocket, Duck square, Spell charges + pending freeze, Fog of War exactly the redacted view (back ranks in fog).
- 4 Player Chess and 4 Player Giveaway: `four_rejoin` returns the seat with the room's current snapshot, the seat is human again, no bot ever took it; a forged token is refused.
- Secrecy: nothing the opponent, a spectator or another seat heard contains anybody's token.

Mutation (copy-based, e2e): 15 server mutants (forged token accepted, the new socket not registered, the opponent not told / told the token on drop or return, Fog of War rejoin returning the true board, Crazyhouse / Duck / Spell state or the move list dropped from the answer, the finished answer for any token / never, the 4 Player seat for any token) — all killed.

**Together with threefold repetition (§26).** The position list lives in the room, not in a socket, so it survives a restart: `test:rejoinPersist` scenario 3b plays 6 plies of the Nf3 Nf6 Ng1 Ng8 shuffle (the start position has occurred twice), kills White's app, restarts it as a new process that plays ply 7 itself, and Black's ply 8 ends the game by `'repetition'` - in Classic, Fog of War and Crazyhouse; both the opponent and the restarted process are told. Mutation: a rejoin that forgets the earlier positions, and a server that never declares the repetition, are both killed.

## 28. Test accounts clean up after themselves

**The problem.** `scripts/test-tournament.mjs` registers real accounts through `POST /auth/register` (about 10 per run, `<name>.<uuid8>@test.local`) and never removed them, so a developer's local Postgres collected ~570 of them plus their cascaded games, tournaments and participations (578 users / 208 tournaments before a manual cleanup, 7 users / 1 tournament after). It is the only script in the repo that registers accounts: every other script uses guests or in-process rooms (checked by grepping for `auth/register` and `prisma.user`).

**The fix.** `scripts/lib/test-user-cleanup.mjs`: the script records the id of every account it registers (`users.track`) and `main()` deletes exactly those ids in a `finally` - on success and on failure (cascades remove their games, the tournaments they created, participations and puzzle progress). Guards: **by recorded id only** (never an email pattern, so a developer's own `@test.local` account is safe); **only when the database is local** (localhost / 127.0.0.1 / ::1 - the dev DB and the CI service container; Neon / Render / anything else is left alone and the skip is announced); the URL is `DATABASE_URL` from the environment **or, when nothing is exported, the one in `backend/.env`** (a plain `node scripts/test-tournament.mjs` exports nothing - the first version read only the environment and silently skipped the cleanup for exactly that case; found when a stray run left an account), and that same URL is the one connected to; nothing is opened when nobody registered; a failing cleanup logs and never hides the test's own error; and an account that survives its own cleanup fails the test (so CI proves the cleanup against a real database on every run).

**Tests.** `npm run test:userCleanup` (38 checks, no server / database: a fake Prisma) - local vs remote URLs, env vs `.env` resolution, exact ids, the bystander untouched, no connection when nothing was registered, remote / unset URL skipped and announced, failures swallowed, a row that survives the cleanup is counted, and a scan that `test-tournament.mjs` cleans up in a `finally` with no early `process.exit`. **Mutation** (copy of `scripts/`): 20 mutants (the local-host guard, id-vs-pattern delete, `.env` fallback, finally, survivor check, connection URL, early exit) - all killed after two tests were added for the first survivors. Verified by hand on the real local database: a normal run (nothing exported) created 11 accounts and left 0 (users 7 -> 7, tournaments and games unchanged); a copy of the script forced to throw mid-run created 8 and left 0 and still exited 1 with its own error. Note the server's register limiter (20 per 15 minutes per IP) allows about one full run per window against a long-running dev server.

## 29. Chaturaji W0 - the regenerated 4-seat mirror (a refactor: no behaviour change)

The mobile app's 4-seat engine now reads its board and four rule options from the state's rules (frontend TESTING.md §28, CHATURAJI_SPEC.md §8 option G). The backend copy is **generated, never edited**: `npm run sync:fourplayer` rewrote the five mirrored files that changed (`board.ts`, `state.ts`, `moves.ts`, `elimination.ts`, `bot.ts`; `premove.ts` is client-only) and `--check` is in sync (10 generated files). Branch `paired/chaturaji` in both repos.

**One test script changed by hand: `scripts/test-fourplayer.mjs`** (the app-vs-mirror parity script). Its "public surface is the same" section deep-compared every exported constant, which cannot work for the new `Geometry` objects (tables *and* closures: two copies of the same source never have identical function objects). It now compares a geometry's tables deep-equal and each closure by what it **returns** over the whole board (every square: file, rank, name, parse, forward coordinate, one / two steps forward, pawn capture squares for all four seats; `isPlayable` over the board and its margin; `toDisplay` / `fromDisplay` for all four views), for `CROSS14` and every entry of `GEOMETRIES`.

**Results (all green, on the regenerated mirror):** `tsc` clean; `sync:fourplayer --check` in sync; `test:fourplayerSync` 114; `test:fourplayer` (parity: seeded FFA and Giveaway games in lockstep, app engine vs mirror, incl. bots) 53 checks over 159 games / 41,395 plies + 54 Giveaway games / 3,714 plies; `test:fourplayerRooms` 220; `test:fourplayerBots` 160; `test:fourplayerMatchmaking` 74; `test:fourplayerHandlers` 61; `test:fourplayerGiveaway` 89; `test:fourplayerOnline` (real sockets, own server) 287; `test:rejoinPersist` 52 (needs a grace longer than CI's 1500 ms on a slow Windows machine - the child process start-up outlasts it; with `FOUR_GRACE_MS=5000` it passes, with 1500 it does not, and that is not a W0 effect).

## 30. Chaturaji W1 - rules, 8 x 8 snapshot and wire on the server (branch `paired/chaturaji`)

The mirrored engine and wire files were regenerated (`board`, `state`, `moves`, `elimination`, `fourPlayerWire`; `sync:fourplayer --check` in sync, 10 generated files). The room manager is hand-written and changed (frontend TESTING.md §29, deviation 1): squares and move labels are named on the board of the room, the payload check takes the room's board (the cross board for an unknown room id, so a 4 Player Chess / Giveaway payload is refused or accepted exactly as before), and a promotion with no piece named is the one allowed piece.

**Results (all green):** `tsc` clean; `test:fourplayerSync` 114; `test:fourplayer` (parity, app engine vs mirror in lockstep) **70** (was 53): section 5c adds 40 random Chaturaji games and 11 scripted scenes (king capture, forks of 3 and fork-then-capture, promotion by capture, no-move elimination, resigned walking king, capture of a walking king, the two end rules, the cap, bare kings) = 51 games / 3,414 plies / 3,119 moves compared at every ply (positions, legal moves, events, clocks, snapshot round trips, the Chess bots on the 8 x 8 board too) plus the preset / validator / start snapshot on both sides - the 4 Player Chess and Giveaway coverage numbers are unchanged (159 games / 41,395 plies; 54 Giveaway games / 3,714 plies); `test:fourplayerRooms` **237** (was 220): section 10 plays a Chaturaji room in-process (the variant echo, the 8-row start snapshot, squares on the 8 x 8 board, the double-step and off-board refusals, a promotion with no piece named = the boat and a queen refused, a king capture announced to all four with the credit, and the end of the game with the points as scores); `test:fourplayerBots` 160; `test:fourplayerMatchmaking` 74; `test:fourplayerHandlers` 61; `test:fourplayerGiveaway` 89; `test:fourplayerOnline` (real sockets, own server) **361** (was 287): scenario 17 - four sockets queue for `chaturaji`, get the echo and the 8-row snapshot, play a2-a3 (a cut corner on the cross board), see the double step refused and an off-board square refused, then 60 plies of natural play with identical snapshots on all four. `test-fourplayer.mjs` now also passes each position's own rules to `deserialize` (the 8-row text needs the 8 x 8 board), and its promotion pick draws from the rules' promotion types (one draw, as before, for the older games).

## 31. Chaturaji W2 - the bot and the server game loop (branch `paired/chaturaji`)

The mirror gained `chaturajiBot.ts` (10 -> 11 generated files; `sync:fourplayer --check` in sync, manifest and `test-fourplayer-sync.mjs` pin it). **No hand-written server file changed**: the room manager, matchmaker and handlers already carried the variant (W1); what W2 adds is the proof that the whole loop works for Chaturaji, in these scripts:
- `test-fourplayer-chaturaji.mjs` (new, `npm run test:fourplayerChaturaji`, a CI step, **116 checks**, in-process on stub sockets and fake timers): (1) the variant is announced in match found / spectate / rejoin / the active list and Chess traffic is unchanged; (2) Capture the King on the server: an attacked king ignored is accepted, a king capture eliminates and scores, a king may step into an attack, a resignation leaves a walking dead king that really steps; (3) every ending reaches `four_game_over` with **points**: the last king (3 + 3 per king left on the board = 9, checked against the engine's own result), the cap with a shared tie, a flag fall (dead king, play goes on), a seat with no legal move ("stalemate", no points), three resignations, abandoned; (4) the default chooser is the dispatcher and plays the Chaturaji bot's move at every ply of a seeded game (and the Chess and Giveaway bots' on theirs: each differs from the Chaturaji bot somewhere, so the check is not vacuous), twelve whole games with three bots + a dead king (mixed ELOs, 1,313 published states, no fault, 24 king captures, every game ends by elimination), a takeover bot that takes a king (`e5xe1`), the hand-back (human seat without `botReason` / `elo`, in the reply and in the broadcast), a fill-bot table; (5) the matchmaker: Chaturaji, Giveaway and Chess players at one time control sit in three lobbies and none sees another, the fill timer starts a Chaturaji game with two bots, mis-spelt variants refused; (6) the real handlers: `variant: "chaturaji"` queued and echoed, an old client and a Giveaway client not pulled in, the room's bots move on their own on the 8 x 8 board.
- `test-fourplayer.mjs` (parity) 70: `compareBots` now dispatches Chaturaji positions to `chooseChaturajiBotMove` - 202 bot decisions compared between the app engine and the mirror in the 51 Chaturaji games (3,535 plies, 94 king captures, 73 king-capture eliminations, 12 forks, 20 resignations, 34 timeouts).
- `test-fourplayer-online.mjs` (real sockets) **427** (was 361): scenarios 18-21 - a whole natural game with a spectator (143 seqs byte-identical on four sockets and the spectator, `four_game_over` equal to the final snapshot, scores = points, winners = the highest score), resignations (the dead king walks; the third ends the game: Red 0 + 3 x 3 dead kings = 9), a takeover bot playing a legal move on the 8 x 8 board and the human's retake, and **two players whose queue is filled by bots after the real 30 s fill wait** (the bots play legal moves; when both humans resign the bots finish the game and both are told). The step takes ~35 s longer in CI for that wait. `pickMove` names squares on the room's board.
- `test-rejoin-persist.mjs` 58 (was 52): a Chaturaji section in the loop (a new process rejoins with only the saved record, a forged token is refused, no bot took the seat, no token leaks).
- `nightly-fuzz-online.mjs`: a Chaturaji section (the same four-socket game, `variant: 'chaturaji'`, squares probed on the 8 x 8 board, a pawn double step must be refused, the game-over checked against the app engine and strict: only `elimination` / `cap` / `abandoned`, three seats out, ply >= 1000 for a cap). The nightly workflow passes 40 games (the new last argument). A run of 40 games against a clean server: 2,826 plies, 1,939 refused probes, 9 rejoin cycles (11 takeovers), 48 resignations, 40 ended (17 naturally), **0 issues**.
**Mutation** (copies of the backend, `test-fourplayer-chaturaji.mjs` alone, one chunk of 13, 68 s): the dispatcher (4), the room manager's default chooser, the scores of a Chaturaji game, the fast-forward delay, the takeover reason, the retake (a retaken seat kept its `botReason` - a real gap, closed by the new seat-list assertions), the handler dropping the variant or creating the room as Chess, one lobby for all variants, a game started as Chess: **13 killed, 0 survived** (first pass 10 killed, 3 survived: two dispatcher mutants that only changed Chess / Giveaway behaviour and the retake; closed as described).
**Results (all green):** `tsc` clean; `sync:fourplayer --check` in sync (11 files); `test:fourplayerSync` 117; `test:fourplayer` 70; `test:fourplayerRooms` 237; `test:fourplayerBots` 160; `test:fourplayerMatchmaking` 74; `test:fourplayerHandlers` 61; `test:fourplayerGiveaway` 89; `test:fourplayerChaturaji` 116; `test:fourplayerOnline` 427 (own server on a spare port, `FOUR_GRACE_MS=1500` only, as CI); `test:rejoinPersist` 58.

## 32. Chaturaji W3 step 0 - the fill wait in CI, three variants in three rooms (branch `paired/chaturaji`)

**No server code changed in W3** (the screens are client-only; the frontend's TESTING.md section 31). Three test-side changes:
- **The fill wait is injectable in CI, and the production 30 s is still guarded.** `FOUR_FILL_MS` (already honoured outside production, 1..600,000 ms) is now set to 8000 on CI's main dev server, so e2e scenario 21 (two players queue for Chaturaji, the fill timer runs out, bots take the other seats and play) waits 8 s instead of 30. A SECOND server without the override runs on port 3002 and scenario 22 (`testRealFillWait`, enabled by `FOUR_E2E_REAL_FILL_URL`) runs **concurrently with every other scenario**: two players queue for Chaturaji there, the countdown they are told is the production 30 s (28-30 s), the bots arrive after it (not before) and two fill bots take the seats. Without the URL (a local run on one server) the guard is skipped and says so. **CI time, the e2e step: 64 s (W2, the 30 s wait run in sequence) -> 43 s; the whole job 5 min 38 s -> 5 min 22 s.** Locally against two private servers: 432 checks in 52 s.
- **Three variants queued at one time control make three rooms** (`test-fourplayer-chaturaji.mjs` section 6, +5 checks, 121 in all): twelve players join in round-robin (Chess, Giveaway, Chaturaji, ...), each lobby fills with four of its own game and starts at once (no fill timer), exactly three rooms exist, each `four_match_found` names the game its players asked for, each room holds four players of one game, and the Chaturaji room is on the 8 x 8 board while the Chess room is on the cross board. The queue key is `timeControl|variant` (section 5 of the same script and `test-fourplayer-giveaway.mjs` section 5 check it on the matchmaker directly; the frontend's `fourPlayerChaturajiWire.test.ts` and `chaturajiClient.test.ts` pin the D15-style echo refusal for Chaturaji both ways).
- **W1's second mutant** (a no-move seat "checkmated" when its king is attacked) is a position that CAN be built: Red `rK@a1 rN@f2`, Blue `bK@h1 bP@g1 bP@g2 bP@h2` (boxed in by its own pawns and attacked by the knight), Yellow `yK@h8`, Green `gK@a8`, all four seats active, Red to move (snapshot `gK............yK/................/................/................/................/................/..........rNbPbP/rK..........bPbK 0 aaaa 0,0,0,0 0 - 0 -`). After Red's quiet `a1-a2` Blue's turn finds no move and the engine eliminates it as `stalemate` with no credit and no points (`Blue` becomes a walking dead king; the turn passes to Yellow). That was already what the spec says (C8), so **no rule changed**; the W1 claim that the position cannot exist was wrong and is withdrawn (frontend TESTING.md section 29); the mutant is killed by `fourPlayerChaturajiNoMove.test.ts`.

## 33. Chaturaji W4 - the browser end-to-end (the real app against the real server) and the rate-limit override (branch `paired/chaturaji`)

**What it is.** `npm run test:e2eBrowser` (`scripts/e2e-browser/`) drives the REAL app, a web build, in Chrome through the UI (Playwright over the system Chrome: `playwright-core`, a new dev dependency, downloads no browser; one browser context = one user with their own storage and login) against the REAL server, and compares every screen with the server's own state. It uses no socket as a player: the only socket it opens is a read-only SPECTATOR (`truth.mjs`) that keeps the room's state, seat list, clocks and score changes, read with the app's own engine. Files: `stack.mjs` (the private stack), `app.mjs` (what a user does and what a screen shows), `match.mjs` (a live game: `converge` and `humanMove`), `truth.mjs`, `run.mjs` (the scenarios).

**The private stack (never :3000, :8081/:8082 or Render).** It starts its OWN backend on port 3191 (`tsx src/index.ts`, `FOUR_FILL_MS=8000`, `FOUR_GRACE_MS=2500`, `NODE_ENV=development`, the local database only: it refuses to start unless `DATABASE_URL` is on this machine) and its OWN static copy of the app on port 8087, exported from the frontend with `expo export --platform web --dev` and `EXPO_PUBLIC_API_URL=http://localhost:3191` (frontend TESTING.md section 32). It refuses ports 3000, 8081, 8082 and any port in use, kills only the processes it spawned (by PID, with their children) and registers test accounts through the real `/auth/register` with random passwords that live in memory only (never printed or written); every account is deleted again in a `finally` (the existing `createUserTracker`, local database only), the run prints `accounts deleted: N (left: 0)`. To start the same stack by hand for a gate: `PORT=3191 FOUR_GRACE_MS=1500 FOUR_FILL_MS=8000 node node_modules/tsx/dist/cli.mjs src/index.ts` (and a second one on 3192 without the fill override for scenario 22's `FOUR_E2E_REAL_FILL_URL`).

**Run it.** `npm run test:e2eBrowser` (all of A-G, about 5.5 minutes including the ~1 minute web export); `E2E_ONLY=B,C` (some; `G` runs both layouts); `E2E_WEBDIR=<an exported dev build>` (reuse a build; it must have been exported for the backend port above, a Windows-style path such as `C:/...`); `E2E_SHOTS=<dir>` (screenshots); `E2E_GRACE_MS=45000` (the REAL takeover grace instead of 2.5 s); `E2E_HEADED=1`. Fixed seeds for the human players' moves, no assertion depends on how long anything takes (waits end on a condition; their bounds only turn a hang into a failure), no 5 s timeouts. The bots' own play is not seeded: when a human's king is captured early in a game that a step needs it for (a takeover, a resignation), the step throws `Inconclusive` and the scenario plays again with a fresh game, up to three tries (printed as `retry`); it happened once in 8 full runs.

**Scenarios.** **A** two humans and two bots (the bots fill the table after the fill wait): at least 10 full rounds (40 plies) of real taps; after EVERY position all 64 squares, the four seats' points, statuses ("out", "king walking", "king attacked"), the clocks of the seats that are not moving and the king-attacked pill equal the server's (the seat that is moving has a running clock, so its figure is not compared); every "+N" the server's score changes imply appears on both screens (captures, forks of +1 / +5); the pill and an automatic promotion are reported when they happen and compared against the server either way (a promotion is not reachable in a game of this length; the constructed online case is `chaturajiOnline.dom.test.tsx`). **B** takeover and hand-back: one human leaves through the menu, the server's seat becomes a bot with reason `takeover` after the grace, the other screen shows "bot playing" at that seat, the Play menu offers "Return to your game", and returning hands the seat back with every screen equal to the server; then the same with the tab CLOSED and a new tab of the same login, which restores the game by itself (the persisted rejoin). Run once with the real 45 s grace (`E2E_GRACE_MS=45000`): passed. **C** a hard reload of one user, the other, then both: the screen is back on the game and equals the server. **D** a third account finds the game under Spectate > Chaturaji, sees it equal to the server, cannot move (tapping a piece offers nothing), sees every "+N" since joining, and sees a resignation's "king walking" like the players. **E** endings: a resignation shows "king walking" on every screen; a second game with 1 min clocks where both humans are idle runs to a flag (`dead-king`, on every screen) and to its end; for every game that ends the result card of every screen shows the server's final scores in the right ranking, and the +3-per-surviving-enemy-king line is checked against the rule read off the server's final position (only for the last seat standing, only when another king is still on the board: it appeared as "9 points - 3 from play + 6 for 2 kings left" in one run, and was correctly absent in the runs where the other kings had been captured). **F** three pairs of accounts queue for Chaturaji, 4 Player Chess and 4 Player Giveaway at the same time control at once (a lone player waits for a second human, so each variant needs two): the server holds three rooms, each with exactly its own two humans and two bots, nobody is in another variant's room, no one on another variant sees a Chaturaji board, and the Chaturaji pair plays correctly next to the others (the D15 refusal screen itself - a server that does not echo the variant - is still not driven in a browser). **G** layout at 360 x 640 and 412 x 915 at the start and mid-game: no sideways scroll, the board inside the screen (288 px / 392 px wide: 36 / 49 px cells), the four seat cards inside it, no clipped points / clocks / statuses (a long player name is shortened with an ellipsis, by design; the test lists them).

**Timing, stability.** A full run is 5 min 18 s - 5 min 47 s (about 1 minute of it the web export; scenario E, with a real 1-minute clock, is the longest), so it is **in the NIGHTLY workflow, not the per-push CI** (the budget was 3 minutes). Final code: 3 / 3 consecutive green (5:47, 5:26, 5:22; the first of the three needed one `Inconclusive` retry of scenario B); one run with a busy loop on every core (8 threads) green in 5:43. Counted honestly: the very first full run failed twice for HARNESS reasons (below), so the earlier 3 / 3 was runs 2-4 after those fixes, and the code was changed once more afterwards (the rate-limit variable became an opt-in), so the 3 / 3 was repeated on the final commit.

**Harness changes found by the runs (not app bugs).** (1) The recorder of transient indicators ("+N", the pill, the promotion marker) only saw elements being ADDED; the app keeps a seat's "+1" on screen while the next position brings the same seat a "+5" and rewrites the same element's text, so the recorder missed it (`A1 never showed gain-0=+5`); it now also records text changes. (2) The server's login / register rate limit (20 per 15 minutes per address) blocked the registration of the suite's 21 accounts (HTTP 429); see the override below. (3) Human players choose a random legal move and lost their king within a few rounds (Capture the King has no check rule), so scenarios ended on a dead seat; the chooser now prefers moves that leave its king unattacked (seeded).

**The login rate-limit override (`src/lib/authRateLimit.ts`), a security-relevant test switch.** Default and production: exactly as before, 20 per 15 minutes, same keying, same 429 `{"error":"Too many attempts. Please try again later."}`. `AUTH_RATE_LIMIT_TEST_OVERRIDE=<n>` (the number IS the new limit) has an effect ONLY when NODE_ENV is not "production" AND the variable is a whole number in 1..1000, so it can raise the limit, never switch it off; under NODE_ENV=production it is ignored and ONE startup warning (without the value) is logged; any other value is ignored with one warning. The module reads exactly two variables (NODE_ENV and this one), logs no secret and no value. Only `scripts/e2e-browser/stack.mjs` sets it (to 1000, with NODE_ENV=development, for its own child process): it is in no workflow, no `.env.example`, no Render configuration (there is no `render.yaml` in either repo; **Render's own environment cannot be checked from the repo and was not touched, so "Render's NODE_ENV is production" is NOT verified here** - it is the one thing to confirm in the Render dashboard; if it were unset, the override would still need its own variable to be set there, which nothing in the repo does). `npm run test:authRateLimit` (43 checks, runs in CI) over a real HTTP server with the real limiter: **(a)** default: attempts 1-20 pass, the 21st is a 429 with the old message, and all 22 answers (status, body, header names, limit and policy headers) equal those of a limiter built from the original literal options; **(b)** NODE_ENV=production + the variable set: still exactly 20 let through, the 21st gets 429, exactly one warning naming the variable and "production" and not the value; **(c)** NODE_ENV=test, development and unset + the variable set to 30: attempt 21 passes, the 31st gets 429 (finite), 1000 is the ceiling, twelve bad values ("", " 500", "5e2", "0x10", "-5", "0", "1.5", "1001", "99999999", "Infinity", "off", "false") give 20 and one fixed warning, and the earlier draft's variable name does nothing; **(d)** the module's code reads exactly NODE_ENV and the override variable, mentions no secret-like name, and with `JWT_SECRET` / `DATABASE_URL` / a password in the environment logs only its three short warnings, none containing a secret or the value; `index.ts` mounts `createAuthLimiter()` and builds no limiter of its own; the variable appears in no file but the module, its test, the e2e stack and the docs. **Mutation** (copy, 22 mutants of the module: the pinned numbers, the message, the name, the production branch and its warning, the value in the warnings, the digit check, zero, the ceiling, the headers, the window, the wiring of the limit): 22 killed, 0 survived.

**Gates (backend, in order, one at a time, nothing else running).** `sync:fourplayer --check` in sync (11 files); suites: sync 117, parity 70, rooms 237, bots 160, matchmaking 74, handlers 61, giveaway 89, Chaturaji 121 - all unchanged and green; real-socket e2e (two private servers on 3191 with `FOUR_FILL_MS=8000` and 3192 with the real fill wait for `FOUR_E2E_REAL_FILL_URL`) **434 checks** passed (the W3 report said 432; the difference was not investigated and is in checks that depend on what the random games did); rejoin-after-restart 58; Chaturaji nightly fuzz rerun now, **40 / 40 games, 2767 plies, 1901 illegal moves correctly refused, 22 disconnect/rejoin cycles (32 takeovers), 49 resignations, 0 unexpected issues**. The local database ends with the same accounts it started with (7).

**The nightly workflow** (`.github/workflows/nightly.yml`) runs `npm run test:e2eBrowser` after the online fuzz (`continue-on-error` + the job fails with the fuzz; Chrome ships with `ubuntu-latest`). It checks the frontend out from its default branch, so the new step is only meaningful once the frontend branch is merged (`paired/chaturaji` is not what the nightly checks out).
