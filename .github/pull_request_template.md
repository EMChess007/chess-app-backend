## Definition of Done

Full explanations are in [CHECKLIST.md](https://github.com/EMChess007/chess-app-backend/blob/main/CHECKLIST.md). Tick every box, or write why an item
doesn't apply to this change.

### 1. Spec before code
- [ ] 3-5 sentences written: exactly what changes, and which existing code/infrastructure is reused vs. genuinely new
- [ ] Interactions with features it could combine or conflict with (other variants, bots, Online mode, analysis, puzzles) stated explicitly — no silent "it's independent" assumption

### 2. Correctness
- [ ] Explicit list of edge cases this change touches, with a test for each
- [ ] Chess-logic changes checked against: en passant, promotion, castling, undo/redo, FEN serialization/reload (including a missing/captured king — see Fog of War's skipValidation precedent)
- [ ] New or updated tests in the matching `__tests__` file; cases added to `gameModes.test.ts` if `getGameOutcome` changed

### 3. Performance
- [ ] Anything on a hot path (every render, move, keystroke, long list) tested at realistic scale (e.g. a 40+ move game), not just the happy-path demo
- [ ] Nothing recomputes from scratch on every render instead of incrementally (or it is flagged here)

### 4. Online/backend parity
- [ ] If this touches Online mode: client and server logic kept in sync, with their own side-by-side tests (the way `RoomChessEngine` mirrors the client for Fog of War) — not just a manual demo

### 5. CI / cross-feature impact
- [ ] `tsc` and tests are green
- [ ] If it affects bots: explicit decision on whether Stockfish is reused as-is or needs a custom heuristic
- [ ] Checked that this doesn't break bots, analysis mode, PGN export/import, game history, or puzzles

### 6. Documentation
- [ ] Doc-comment explaining why this exists and any non-obvious gotchas, in the style of the existing code

### Only if this is a new game variant/mode
- [ ] Explicit mutual-exclusivity declaration with every other variant
- [ ] Fits the existing pattern: `VariantSelector` entry, screen prop threading (`fogOfWar`/`chess960`/`setupChess`-style), `gameResult.ts` priority slot
