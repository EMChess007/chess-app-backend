// GENERATED FILE - DO NOT EDIT BY HAND.
// Source: src/logic/bughouse/invariants.ts in the EM-Chess app repo. Regenerate with `npm run sync:bughouse`; CI runs it with --check.
// The only difference from the source is that relative imports carry the '.js' suffix NodeNext requires.

/**
 * Bughouse W1: the conservation invariant (BUGHOUSE_SPEC.md HP1). MIRRORED to the backend.
 *
 * With two boards and four pockets nothing is ever created or destroyed: a capture moves a piece from a board to a pocket (a captured PROMOTED piece arrives as a pawn), a drop moves it
 * back, a promotion changes a pawn into another piece, and a king is never captured. So, counting a piece that carries a promoted mark as the PAWN it started as:
 *   - each COLOUR owns exactly 16 pawns, 4 knights, 4 bishops, 4 rooks, 2 queens and 2 kings (two armies of 16) wherever they are - on either board or in the pockets of that colour's
 *     two seats (a White piece captured by Black on one board is dropped by the White player of the other board, so colour is conserved across boards);
 *   - hence 64 pieces in all;
 *   - no pocket count is negative or fractional, every promoted mark sits on a piece that is neither a pawn nor a king, and each board is a position chess.js accepts (which already means one king per colour and no pawn on rank 1 or 8).
 * `conservationProblems` returns what is wrong, as text; an empty list means the match is sound.
 */
import { RESERVE_PIECE_TYPES } from '../crazyhouse.js';
import { openBoard } from './board.js';
import type { BughouseMatch } from './match.js';
import { BOARD_IDS, BUGHOUSE_SEATS, seatPlace, type BughouseColor } from './types.js';

/** What each colour owns in total, by the type it started as. */
const ARMY: Record<string, number> = { p: 16, n: 4, b: 4, r: 4, q: 2, k: 2 };

export function conservationProblems(match: BughouseMatch): string[] {
  const problems: string[] = [];
  const counts: Record<BughouseColor, Record<string, number>> = { w: {}, b: {} };
  for (const color of ['w', 'b'] as const) for (const type of Object.keys(ARMY)) counts[color][type] = 0;

  for (const board of BOARD_IDS) {
    const state = match.boards[board];
    const chess = openBoard(state.fen);
    if (chess === null) {
      problems.push(`board ${board}: the position is not a valid FEN`);
      continue;
    }
    const marked = new Set(state.promoted);
    const seen = new Set<string>();
    for (const row of chess.board()) {
      for (const cell of row) {
        if (!cell) continue;
        const promoted = marked.has(cell.square);
        if (promoted) seen.add(cell.square);
        if (promoted && (cell.type === 'p' || cell.type === 'k')) problems.push(`board ${board}: ${cell.square} is marked promoted but holds a ${cell.type}`);
        counts[cell.color][promoted ? 'p' : cell.type]++;
      }
    }
    for (const square of marked) if (!seen.has(square)) problems.push(`board ${board}: ${square} is marked promoted but is empty`);
    if (marked.size !== state.promoted.length) problems.push(`board ${board}: a promoted square is listed twice`);
  }

  for (const seat of BUGHOUSE_SEATS) {
    const color = seatPlace(seat).color;
    for (const type of RESERVE_PIECE_TYPES) {
      const count = match.pockets[seat][type];
      if (!Number.isInteger(count) || count < 0) problems.push(`seat ${seat}: the pocket holds ${count} of ${type}`);
      else counts[color][type] += count;
    }
  }

  let total = 0;
  for (const color of ['w', 'b'] as const) {
    for (const [type, expected] of Object.entries(ARMY)) {
      total += counts[color][type];
      if (counts[color][type] !== expected) problems.push(`${color === 'w' ? 'White' : 'Black'} owns ${counts[color][type]} of ${type}, expected ${expected}`);
    }
  }
  if (total !== 64) problems.push(`${total} pieces in all, expected 64`);
  return problems;
}
