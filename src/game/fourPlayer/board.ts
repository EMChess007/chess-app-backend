// GENERATED FILE - DO NOT EDIT BY HAND.
// Source: src/logic/fourPlayer/board.ts in the EM-Chess app repo. Regenerate with `npm run sync:fourplayer`; CI runs it with --check.
// The only difference from the source is that relative imports carry the '.js' suffix NodeNext requires.

/**
 * 4 Player Chess — board geometry. Pure TypeScript: no React, no React Native, no chess.js (so the whole `fourPlayer/` folder can
 * be mirrored verbatim into the backend when Online arrives, the way the 2-player variants' rules blocks are).
 *
 * THE BOARD. 14 x 14 with a 3 x 3 corner cut out of each corner = 160 playable squares. It is stored as a flat 196-cell "mailbox"
 * (index = rank * 14 + file, both 0-based: file 0 = "a" … 13 = "n", rank 0 = "1" … 13 = "14"); the 36 corner cells exist in the
 * array but are marked off-board (`VALID[i] === 0`, and -1 in the cell array). Everything that walks the board uses the tables
 * below, which are built once at import time and already stop at the cut corners, so move generation never does a bounds check:
 * a slider's ray simply ends where the board does.
 *
 * SEATS. Four seats in CLOCKWISE turn order, matching their position on the screen: Red (bottom) → Blue (left) → Yellow (top) →
 * Green (right). A pawn's "forward" is the direction towards the opposite edge: Red +rank, Blue +file, Yellow -rank, Green -file.
 *
 * A seat is NOT a chess colour. Nothing here (or anywhere in `fourPlayer/`) assumes two sides: "enemy" always means "any other seat".
 */

export const SIZE = 14;
export const CELLS = SIZE * SIZE;

export type Seat = 0 | 1 | 2 | 3;
export const SEATS: readonly Seat[] = [0, 1, 2, 3];
export const SEAT_NAMES = ['Red', 'Blue', 'Yellow', 'Green'] as const;
/** Seat colours used by the UI (the logic never reads these). */
export const SEAT_COLORS = ['#d32f2f', '#1976d2', '#f9a825', '#2e7d32'] as const;

/** The next seat clockwise (Red → Blue → Yellow → Green → Red). */
export const nextSeat = (seat: Seat): Seat => ((seat + 1) & 3) as Seat;
/** The seat `steps` places BEFORE `seat` in turn order. */
export const seatBefore = (seat: Seat, steps = 1): Seat => ((seat - steps + 8) & 3) as Seat;

export const index = (file: number, rank: number): number => rank * SIZE + file;
export const fileOf = (square: number): number => square % SIZE;
export const rankOf = (square: number): number => (square / SIZE) | 0;

/** Whether (file, rank) is one of the 160 playable squares (in bounds and not in a cut corner). */
export function isPlayable(file: number, rank: number): boolean {
  if (file < 0 || file >= SIZE || rank < 0 || rank >= SIZE) return false;
  const inFileCorner = file < 3 || file > 10;
  const inRankCorner = rank < 3 || rank > 10;
  return !(inFileCorner && inRankCorner);
}

/** 1 for each playable square index, 0 for the cut corners. */
export const VALID: Uint8Array = (() => {
  const valid = new Uint8Array(CELLS);
  for (let rank = 0; rank < SIZE; rank++) for (let file = 0; file < SIZE; file++) valid[index(file, rank)] = isPlayable(file, rank) ? 1 : 0;
  return valid;
})();

/** Every playable square index, in rank-major order. */
export const PLAYABLE_SQUARES: readonly number[] = (() => {
  const squares: number[] = [];
  for (let i = 0; i < CELLS; i++) if (VALID[i]) squares.push(i);
  return squares;
})();

const FILE_LETTERS = 'abcdefghijklmn';

/** "a4", "n11", … */
export function squareName(square: number): string {
  return `${FILE_LETTERS[fileOf(square)]}${rankOf(square) + 1}`;
}

/** The inverse of squareName; -1 for anything that is not a playable square. */
export function parseSquare(name: string): number {
  const match = /^([a-n])(\d{1,2})$/.exec(name);
  if (!match) return -1;
  const file = FILE_LETTERS.indexOf(match[1]);
  const rank = Number(match[2]) - 1;
  return isPlayable(file, rank) ? index(file, rank) : -1;
}

/** Each seat's "forward" step as [dFile, dRank]. */
export const FORWARD: readonly (readonly [number, number])[] = [
  [0, 1], // Red
  [1, 0], // Blue
  [0, -1], // Yellow
  [-1, 0], // Green
];

/** Progress of a square along a seat's own forward axis: 0 on its own back edge … 13 on the far edge. */
export function forwardCoord(seat: Seat, square: number): number {
  const file = fileOf(square);
  const rank = rankOf(square);
  return seat === 0 ? rank : seat === 1 ? file : seat === 2 ? SIZE - 1 - rank : SIZE - 1 - file;
}

/** A pawn may double-step only from this forward coordinate (its starting line: Red's rank 2, Blue's file b, Yellow's rank 13, Green's file m). */
export const PAWN_START_COORD = 1;
/** FFA: a pawn promotes on reaching this forward coordinate — "its own 8th rank": Red rank 8, Yellow rank 7, Blue file h, Green file g. */
export const FFA_PROMOTION_COORD = 7;

// --- Neighbour tables --------------------------------------------------------------------------------------------------

/** Ray directions: the first four are orthogonal (rook), the last four diagonal (bishop). [dFile, dRank]. */
export const DIRECTIONS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
export const ORTHOGONAL_COUNT = 4;

/** RAYS[square * 8 + direction] = the playable squares from `square` outwards in that direction, ending where the board ends. */
export const RAYS: readonly Int16Array[] = (() => {
  const rays: Int16Array[] = [];
  for (let square = 0; square < CELLS; square++) {
    for (const [df, dr] of DIRECTIONS) {
      const list: number[] = [];
      if (VALID[square]) {
        let file = fileOf(square) + df;
        let rank = rankOf(square) + dr;
        while (isPlayable(file, rank)) {
          list.push(index(file, rank));
          file += df;
          rank += dr;
        }
      }
      rays.push(Int16Array.from(list));
    }
  }
  return rays;
})();

const KNIGHT_STEPS: readonly (readonly [number, number])[] = [
  [1, 2],
  [2, 1],
  [2, -1],
  [1, -2],
  [-1, -2],
  [-2, -1],
  [-2, 1],
  [-1, 2],
];

function neighbourTable(steps: readonly (readonly [number, number])[]): readonly Int16Array[] {
  const table: Int16Array[] = [];
  for (let square = 0; square < CELLS; square++) {
    const list: number[] = [];
    if (VALID[square]) {
      for (const [df, dr] of steps) {
        const file = fileOf(square) + df;
        const rank = rankOf(square) + dr;
        if (isPlayable(file, rank)) list.push(index(file, rank));
      }
    }
    table.push(Int16Array.from(list));
  }
  return table;
}

export const KNIGHT_TARGETS: readonly Int16Array[] = neighbourTable(KNIGHT_STEPS);
export const KING_TARGETS: readonly Int16Array[] = neighbourTable(DIRECTIONS);

/** The square one step "forward" for `seat` from `square`, or -1 when that is off the board. */
export function stepForward(seat: Seat, square: number, steps = 1): number {
  const [df, dr] = FORWARD[seat];
  const file = fileOf(square) + df * steps;
  const rank = rankOf(square) + dr * steps;
  return isPlayable(file, rank) ? index(file, rank) : -1;
}

/** The two squares a pawn of `seat` on `square` attacks / may capture on (forward-left and forward-right), -1 when off the board. */
export function pawnCaptureSquares(seat: Seat, square: number): [number, number] {
  const [df, dr] = FORWARD[seat];
  // The two sideways directions perpendicular to forward.
  const sideF = -dr;
  const sideR = df;
  const file = fileOf(square);
  const rank = rankOf(square);
  const a = isPlayable(file + df + sideF, rank + dr + sideR) ? index(file + df + sideF, rank + dr + sideR) : -1;
  const b = isPlayable(file + df - sideF, rank + dr - sideR) ? index(file + df - sideF, rank + dr - sideR) : -1;
  return [a, b];
}

// --- Rotation (rendering only) -----------------------------------------------------------------------------------------

/**
 * Where board square (file x, rank y) is DRAWN when the board is turned so that seat `view` sits at the bottom: returns display
 * coordinates (dx right, dy up, both 0..13). The logic never rotates anything — only the UI calls this, and `fromDisplay` is its inverse.
 * view 0 = Red at the bottom (identity), 1 = Blue, 2 = Yellow, 3 = Green; each step is a quarter turn that brings the next seat down.
 */
export function toDisplay(x: number, y: number, view: Seat): [number, number] {
  switch (view) {
    case 0:
      return [x, y];
    case 1:
      return [SIZE - 1 - y, x];
    case 2:
      return [SIZE - 1 - x, SIZE - 1 - y];
    default:
      return [y, SIZE - 1 - x];
  }
}

export function fromDisplay(dx: number, dy: number, view: Seat): [number, number] {
  switch (view) {
    case 0:
      return [dx, dy];
    case 1:
      return [dy, SIZE - 1 - dx];
    case 2:
      return [SIZE - 1 - dx, SIZE - 1 - dy];
    default:
      return [SIZE - 1 - dy, dx];
  }
}
