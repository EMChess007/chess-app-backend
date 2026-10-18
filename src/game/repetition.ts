// Threefold repetition for every two-player mode. THIS FILE IS BYTE-IDENTICAL in the backend (backend/src/game/repetition.ts) -
// backend/scripts/test-repetition.mjs fails if the two drift. Edit BOTH.
//
// The rule (chess.com ends a game automatically as a draw): the same POSITION occurring three times, not necessarily in a row,
// with the same side to move. A position is the placement, the side to move, the castling rights and the en passant square - the
// latter only when an en passant capture is actually available (a pawn of the side to move stands beside the pawn that just
// double-stepped) - plus whatever hidden state the variant adds (`repetitionExtra`: Three-Check's check counters, Crazyhouse's
// pockets and promoted pieces, the duck's square, Spell Chess's charges / cooldowns / frozen squares / pending jump).
//
// Everything here is derived from a plain list of keys - one per position, the initial position first - so it is right after Undo
// (the list is rebuilt from the history), after a FEN rebuild (the screens build a fresh engine from the FEN every render, so
// chess.js can never count repetitions itself) and after a rejoin (the server's list lives in the room).
//
// Known approximation: the en passant square counts as "available" when a pawn stands beside the double-stepped pawn, without
// the legality test (a pinned capturing pawn would make FIDE treat the squares as equal). It can only DELAY a draw by one cycle in
// that corner; chess.js's own detector (still consulted by the server for its other draws) never fires earlier in practice.

const FILE_LETTERS = 'abcdefgh';

/** Whether a pawn of the side to move can capture en passant onto `ep` (pseudo-legally: a pawn beside the double-stepped pawn). */
function epCapturePossible(placement: string, turn: string, ep: string): boolean {
  if (ep.length !== 2) return false;
  const file = FILE_LETTERS.indexOf(ep[0]);
  // Black to move captures onto rank 3 (White just pushed), White onto rank 6; the capturing pawn stands on rank 4 / 5.
  const capturingRank = turn === 'b' && ep[1] === '3' ? 4 : turn === 'w' && ep[1] === '6' ? 5 : 0;
  if (file < 0 || capturingRank === 0) return false;
  const row = placement.split('/')[8 - capturingRank];
  if (row === undefined) return false;
  const expanded: string[] = [];
  for (const ch of row) {
    if (ch >= '1' && ch <= '8') for (let i = 0; i < Number(ch); i++) expanded.push('.');
    else expanded.push(ch);
  }
  const pawn = turn === 'w' ? 'P' : 'p';
  return expanded[file - 1] === pawn || expanded[file + 1] === pawn;
}

/** JSON with sorted object keys and sorted string arrays (every array in the variant states is a set of squares), so equal states
 * always give the same text whatever order they were built in. */
export function canonicalExtra(value: unknown): string {
  const normalise = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      const items = v.map(normalise);
      return items.every((i) => typeof i === 'string') ? (items as string[]).slice().sort() : items;
    }
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, normalise((v as Record<string, unknown>)[k])])
      );
    }
    return v;
  };
  return JSON.stringify(normalise(value));
}

/** The variant-specific part of a position. Every field is optional: a mode passes only its own. */
export interface RepetitionExtra {
  /** Three-Check: the checks delivered so far by each side. */
  checks?: { w: number; b: number };
  /** Crazyhouse: both reserves and the promoted-piece squares (CrazyhouseState). */
  crazyhouse?: unknown;
  /** Duck Chess: where the duck stands (null before the first move). */
  duck?: string | null;
  /** Spell Chess: charges, cooldowns, the pending freeze (frozen squares) and the pending jump (SpellChessState). */
  spell?: unknown;
}

/** The text appended to a position key for the variant state - empty for the plain modes. */
export function repetitionExtra(extra: RepetitionExtra | undefined): string {
  if (!extra) return '';
  const parts: Record<string, unknown> = {};
  if (extra.checks) parts.checks = extra.checks;
  if (extra.crazyhouse !== undefined) parts.crazyhouse = extra.crazyhouse;
  if (extra.duck !== undefined) parts.duck = extra.duck;
  if (extra.spell !== undefined) parts.spell = extra.spell;
  return Object.keys(parts).length === 0 ? '' : canonicalExtra(parts);
}

/** The key of one position: placement, side to move, castling rights, en passant square (only when capturable) and the variant state. */
export function repetitionKey(fen: string, extra?: RepetitionExtra): string {
  const [placement, turn, castling, ep] = fen.split(' ');
  const epPart = ep && ep !== '-' && epCapturePossible(placement, turn, ep) ? ep : '-';
  const variant = repetitionExtra(extra);
  return `${placement} ${turn} ${castling ?? '-'} ${epPart}${variant ? ` ${variant}` : ''}`;
}

/** How many times the LAST position in `keys` (initial position first, then each ply's) has now occurred, itself included. Only every
 * second entry can match (the side to move alternates), so that is all that is compared. */
export function repetitionCount(keys: readonly string[]): number {
  if (keys.length === 0) return 0;
  const last = keys[keys.length - 1];
  let seen = 0;
  for (let i = keys.length - 1; i >= 0; i -= 2) if (keys[i] === last) seen += 1;
  return seen;
}

/** Whether the last position in `keys` has now occurred three times. */
export function isThreefoldRepetition(keys: readonly string[]): boolean {
  return repetitionCount(keys) >= 3;
}
