// GENERATED FILE - DO NOT EDIT BY HAND.
// Source: src/logic/fourPlayer/board.ts in the EM-Chess app repo. Regenerate with `npm run sync:fourplayer`; CI runs it with --check.
// The only difference from the source is that relative imports carry the '.js' suffix NodeNext requires.

/**
 * 4 Player Chess — board geometry. Pure TypeScript: no React, no React Native, no chess.js (so the whole `fourPlayer/` folder can
 * be mirrored verbatim into the backend when Online arrives, the way the 2-player variants' rules blocks are).
 *
 * A BOARD IS A `Geometry` OBJECT. Everything geometric - the size, which squares are playable, the ray / knight / king neighbour tables, the
 * forward coordinate, square names, the display rotation - is built by ONE function, `buildGeometry`, from a size and a "is this square playable"
 * predicate, and lives in a `Geometry`. The engine reads the geometry of the game it is playing from the state's rules (`geometryOf(state.rules)`,
 * see state.ts), so a second board (Chaturaji's 8 x 8, CHATURAJI_SPEC.md section 8) is one more `buildGeometry` call and not a rewrite. The 4 Player
 * Chess / Giveaway board, `CROSS14`, is the only geometry today, and the module-level exports below (`SIZE`, `VALID`, `RAYS`, `index`, ...) are simply
 * ITS members, kept so that every existing caller, and every test, reads exactly what it always read.
 *
 * THE CROSS BOARD. 14 x 14 with a 3 x 3 corner cut out of each corner = 160 playable squares. It is stored as a flat 196-cell "mailbox"
 * (index = rank * 14 + file, both 0-based: file 0 = "a" … 13 = "n", rank 0 = "1" … 13 = "14"); the 36 corner cells exist in the
 * array but are marked off-board (`valid[i] === 0`, and -1 in the cell array). Everything that walks the board uses the tables
 * below, which are built once at import time and already stop at the cut corners, so move generation never does a bounds check:
 * a slider's ray simply ends where the board does.
 *
 * SEATS. Four seats in CLOCKWISE turn order, matching their position on the screen: Red (bottom) → Blue (left) → Yellow (top) →
 * Green (right). A pawn's "forward" is the direction towards the opposite edge: Red +rank, Blue +file, Yellow -rank, Green -file.
 *
 * A seat is NOT a chess colour. Nothing here (or anywhere in `fourPlayer/`) assumes two sides: "enemy" always means "any other seat".
 */

/** Which board a game is played on (see `Geometry`): the 4 Player cross, and Chaturaji's plain 8 x 8 square. */
export type BoardId = 'cross14' | 'square8';

export type Seat = 0 | 1 | 2 | 3;
export const SEATS: readonly Seat[] = [0, 1, 2, 3];
export const SEAT_NAMES = ['Red', 'Blue', 'Yellow', 'Green'] as const;
/** Seat colours used by the UI (the logic never reads these). */
export const SEAT_COLORS = ['#d32f2f', '#1976d2', '#f9a825', '#2e7d32'] as const;

/** The next seat clockwise (Red → Blue → Yellow → Green → Red). */
export const nextSeat = (seat: Seat): Seat => ((seat + 1) & 3) as Seat;
/** The seat `steps` places BEFORE `seat` in turn order. */
export const seatBefore = (seat: Seat, steps = 1): Seat => ((seat - steps + 8) & 3) as Seat;

/** Each seat's "forward" step as [dFile, dRank]. */
export const FORWARD: readonly (readonly [number, number])[] = [
  [0, 1], // Red
  [1, 0], // Blue
  [0, -1], // Yellow
  [-1, 0], // Green
];

/** A pawn may double-step only from this forward coordinate (its starting line: Red's rank 2, Blue's file b, Yellow's rank 13, Green's file m). */
export const PAWN_START_COORD = 1;
/** FFA: a pawn promotes on reaching this forward coordinate — "its own 8th rank": Red rank 8, Yellow rank 7, Blue file h, Green file g. */
export const FFA_PROMOTION_COORD = 7;

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

const FILE_LETTERS = 'abcdefghijklmn';

// --- The geometry object ------------------------------------------------------------------------------------------------

/** Everything about one board. Built once by `buildGeometry`; never mutated. The members are plain closures over the board's size, not methods (no `this`). */
export interface Geometry {
  readonly id: BoardId;
  /** Files and ranks per side. */
  readonly size: number;
  /** `size * size`: the length of a cell array. */
  readonly cells: number;
  /** 1 for each playable square index, 0 for the cut corners. */
  readonly valid: Uint8Array;
  /** Every playable square index, in rank-major order. */
  readonly playableSquares: readonly number[];
  /** `rays[square * 8 + direction]` = the playable squares from `square` outwards in that direction, ending where the board ends. */
  readonly rays: readonly Int16Array[];
  readonly knightTargets: readonly Int16Array[];
  readonly kingTargets: readonly Int16Array[];
  /** Whether (file, rank) is a playable square (in bounds and not cut). */
  isPlayable(file: number, rank: number): boolean;
  index(file: number, rank: number): number;
  fileOf(square: number): number;
  rankOf(square: number): number;
  /** Progress of a square along a seat's own forward axis: 0 on its own back edge … size - 1 on the far edge. */
  forwardCoord(seat: Seat, square: number): number;
  /** The square `steps` steps "forward" for `seat` from `square`, or -1 when that is off the board. */
  stepForward(seat: Seat, square: number, steps?: number): number;
  /** The two squares a pawn of `seat` on `square` attacks / may capture on (forward-left and forward-right), -1 when off the board. */
  pawnCaptureSquares(seat: Seat, square: number): [number, number];
  /** "a4", "n11", … */
  squareName(square: number): string;
  /** The inverse of squareName; -1 for anything that is not a playable square. */
  parseSquare(name: string): number;
  /**
   * Where board square (file x, rank y) is DRAWN when the board is turned so that seat `view` sits at the bottom: display coordinates (dx right, dy up,
   * both 0..size-1). The logic never rotates anything — only the UI calls this, and `fromDisplay` is its inverse. view 0 = Red at the bottom (identity),
   * 1 = Blue, 2 = Yellow, 3 = Green; each step is a quarter turn that brings the next seat down.
   */
  toDisplay(x: number, y: number, view: Seat): [number, number];
  fromDisplay(dx: number, dy: number, view: Seat): [number, number];
}

export interface GeometrySpec {
  id: BoardId;
  size: number;
  /** Whether an IN-BOUNDS (file, rank) is playable; the builder adds the bounds check. */
  isPlayable(file: number, rank: number): boolean;
}

/** Builds a board's tables and helpers from its size and playable predicate. This is the only place that knows how the tables are made. */
export function buildGeometry(spec: GeometrySpec): Geometry {
  const { id, size } = spec;
  const cells = size * size;
  const index = (file: number, rank: number): number => rank * size + file;
  const fileOf = (square: number): number => square % size;
  const rankOf = (square: number): number => (square / size) | 0;

  // The predicate is consulted ONCE per square, here; afterwards `isPlayable` is a bounds check and a table lookup (it sits in the pawn-attack
  // test of every attack query, so it must not call back into the spec).
  const valid = new Uint8Array(cells);
  for (let rank = 0; rank < size; rank++) for (let file = 0; file < size; file++) valid[index(file, rank)] = spec.isPlayable(file, rank) ? 1 : 0;
  const isPlayable = (file: number, rank: number): boolean => file >= 0 && file < size && rank >= 0 && rank < size && valid[rank * size + file] === 1;

  const playableSquares: number[] = [];
  for (let i = 0; i < cells; i++) if (valid[i]) playableSquares.push(i);

  const rays: Int16Array[] = [];
  for (let square = 0; square < cells; square++) {
    for (const [df, dr] of DIRECTIONS) {
      const list: number[] = [];
      if (valid[square]) {
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

  const neighbourTable = (steps: readonly (readonly [number, number])[]): readonly Int16Array[] => {
    const table: Int16Array[] = [];
    for (let square = 0; square < cells; square++) {
      const list: number[] = [];
      if (valid[square]) {
        for (const [df, dr] of steps) {
          const file = fileOf(square) + df;
          const rank = rankOf(square) + dr;
          if (isPlayable(file, rank)) list.push(index(file, rank));
        }
      }
      table.push(Int16Array.from(list));
    }
    return table;
  };

  const forwardCoord = (seat: Seat, square: number): number => {
    const file = fileOf(square);
    const rank = rankOf(square);
    return seat === 0 ? rank : seat === 1 ? file : seat === 2 ? size - 1 - rank : size - 1 - file;
  };

  const stepForward = (seat: Seat, square: number, steps = 1): number => {
    const [df, dr] = FORWARD[seat];
    const file = fileOf(square) + df * steps;
    const rank = rankOf(square) + dr * steps;
    return isPlayable(file, rank) ? index(file, rank) : -1;
  };

  const pawnCaptureSquares = (seat: Seat, square: number): [number, number] => {
    const [df, dr] = FORWARD[seat];
    // The two sideways directions perpendicular to forward.
    const sideF = -dr;
    const sideR = df;
    const file = fileOf(square);
    const rank = rankOf(square);
    const a = isPlayable(file + df + sideF, rank + dr + sideR) ? index(file + df + sideF, rank + dr + sideR) : -1;
    const b = isPlayable(file + df - sideF, rank + dr - sideR) ? index(file + df - sideF, rank + dr - sideR) : -1;
    return [a, b];
  };

  const squareName = (square: number): string => `${FILE_LETTERS[fileOf(square)]}${rankOf(square) + 1}`;

  const parseSquare = (name: string): number => {
    const match = /^([a-n])(\d{1,2})$/.exec(name);
    if (!match) return -1;
    const file = FILE_LETTERS.indexOf(match[1]);
    const rank = Number(match[2]) - 1;
    return isPlayable(file, rank) ? index(file, rank) : -1;
  };

  const toDisplay = (x: number, y: number, view: Seat): [number, number] => {
    switch (view) {
      case 0:
        return [x, y];
      case 1:
        return [size - 1 - y, x];
      case 2:
        return [size - 1 - x, size - 1 - y];
      default:
        return [y, size - 1 - x];
    }
  };

  const fromDisplay = (dx: number, dy: number, view: Seat): [number, number] => {
    switch (view) {
      case 0:
        return [dx, dy];
      case 1:
        return [dy, size - 1 - dx];
      case 2:
        return [size - 1 - dx, size - 1 - dy];
      default:
        return [size - 1 - dy, dx];
    }
  };

  return {
    id,
    size,
    cells,
    valid,
    playableSquares,
    rays,
    knightTargets: neighbourTable(KNIGHT_STEPS),
    kingTargets: neighbourTable(DIRECTIONS),
    isPlayable,
    index,
    fileOf,
    rankOf,
    forwardCoord,
    stepForward,
    pawnCaptureSquares,
    squareName,
    parseSquare,
    toDisplay,
    fromDisplay,
  };
}

/** The 4 Player board: 14 x 14 with a 3 x 3 corner cut out of each corner = 160 playable squares. */
export const CROSS14: Geometry = buildGeometry({
  id: 'cross14',
  size: 14,
  isPlayable: (file, rank) => {
    const inFileCorner = file < 3 || file > 10;
    const inRankCorner = rank < 3 || rank > 10;
    return !(inFileCorner && inRankCorner);
  },
});

/** Chaturaji's board: a plain 8 x 8 square, all 64 squares playable (files a-h, ranks 1-8). */
export const SQUARE8: Geometry = buildGeometry({ id: 'square8', size: 8, isPlayable: () => true });

/** Every board a game can be played on, by id. The rules name theirs (state.ts `optionsOf`); the engine looks it up once per call. */
export const GEOMETRIES: Record<BoardId, Geometry> = { cross14: CROSS14, square8: SQUARE8 };

// --- The cross board's members, as the module-level names every existing caller uses ---------------------------------------

export const SIZE = CROSS14.size;
export const CELLS = CROSS14.cells;
/** 1 for each playable square index, 0 for the cut corners. */
export const VALID: Uint8Array = CROSS14.valid;
/** Every playable square index, in rank-major order. */
export const PLAYABLE_SQUARES: readonly number[] = CROSS14.playableSquares;
/** RAYS[square * 8 + direction] = the playable squares from `square` outwards in that direction, ending where the board ends. */
export const RAYS: readonly Int16Array[] = CROSS14.rays;
export const KNIGHT_TARGETS: readonly Int16Array[] = CROSS14.knightTargets;
export const KING_TARGETS: readonly Int16Array[] = CROSS14.kingTargets;

export const index = CROSS14.index;
export const fileOf = CROSS14.fileOf;
export const rankOf = CROSS14.rankOf;
/** Whether (file, rank) is one of the 160 playable squares (in bounds and not in a cut corner). */
export const isPlayable = CROSS14.isPlayable;
/** "a4", "n11", … */
export const squareName = CROSS14.squareName;
/** The inverse of squareName; -1 for anything that is not a playable square. */
export const parseSquare = CROSS14.parseSquare;
/** Progress of a square along a seat's own forward axis: 0 on its own back edge … 13 on the far edge. */
export const forwardCoord = CROSS14.forwardCoord;
/** The square one step "forward" for `seat` from `square`, or -1 when that is off the board. */
export const stepForward = CROSS14.stepForward;
/** The two squares a pawn of `seat` on `square` attacks / may capture on (forward-left and forward-right), -1 when off the board. */
export const pawnCaptureSquares = CROSS14.pawnCaptureSquares;

// --- Rotation (rendering only) -----------------------------------------------------------------------------------------

export const toDisplay = CROSS14.toDisplay;
export const fromDisplay = CROSS14.fromDisplay;
