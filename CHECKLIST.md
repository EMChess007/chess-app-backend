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
- Explicit mutual-exclusivity declaration with every other variant.
- Fits the existing pattern: VariantSelector entry, screen prop threading (fogOfWar/chess960/
  setupChess-style), gameResult.ts priority slot.
