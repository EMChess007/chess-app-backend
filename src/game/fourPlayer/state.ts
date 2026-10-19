// GENERATED FILE - DO NOT EDIT BY HAND.
// Source: src/logic/fourPlayer/state.ts in the EM-Chess app repo. Regenerate with `npm run sync:fourplayer`; CI runs it with --check.
// The only difference from the source is that relative imports carry the '.js' suffix NodeNext requires.

/**
 * 4 Player Chess — game state, piece encoding, the start position and (de)serialisation. See board.ts for the geometry.
 *
 * STATE IS IMMUTABLE. Every function that "changes" a game returns a new FourPlayerState (the 196-byte cell array is copied per
 * ply — trivial next to the work of generating moves), which makes Undo a plain stack of states and keeps React happy.
 *
 * PIECES are single bytes: `seat * 16 + type`, 0 = empty, -1 = the cut corners. Types 1-6 are the ordinary pieces. Types 7-10 are
 * PROMOTED pieces (a pawn that reached its last line and became a queen / knight / bishop / rook): each MOVES like the ordinary piece
 * (`baseTypeOf`) but keeps its own code, because what it is worth when captured is decided by what it was promoted to (see
 * CAPTURE_POINTS) and because the UI marks promoted pieces.
 *
 * SEAT STATUS is the heart of the elimination rules (see elimination.ts):
 *   'active'    — a normal player.
 *   'dead-king' — eliminated (checkmated / stalemated / resigned / timed out). Every piece the seat owns is now DEAD: it blocks
 *                 squares and can be captured (for 0 points) but never moves, captures or gives check — EXCEPT the king, which keeps
 *                 walking (a random legal move to an empty square each time its turn comes round).
 *   'frozen'    — the walking king has itself been checkmated or has no move; the whole seat is inert and skipped.
 * A piece is dead exactly when its owner's status is not 'active': there is no per-piece "dead" flag to keep in sync.
 * GIVEAWAY uses only 'active' and 'frozen': an eliminated seat (resigned / flagged) is 'frozen' at once - no walking king - and its pieces are
 * inert WALLS (not capturable, never forcing, never removed; they block squares and slide-rays for good). See giveaway.ts.
 */

import { CROSS14, FFA_PROMOTION_COORD, GEOMETRIES, SIZE, index, type BoardId, type Geometry, type Seat } from './board.js';

export type SeatStatus = 'active' | 'dead-king' | 'frozen';

// Piece types.
export const PAWN = 1;
export const KNIGHT = 2;
export const BISHOP = 3;
export const ROOK = 4;
export const QUEEN = 5;
export const KING = 6;
/** A queen that began as a pawn: moves like a queen, captured for 1 point. */
export const PROMOTED_QUEEN = 7;
/** Under-promotions: they move like their ordinary piece and are captured for that piece's points. */
export const PROMOTED_KNIGHT = 8;
export const PROMOTED_BISHOP = 9;
export const PROMOTED_ROOK = 10;

export const OFF_BOARD = -1;
export const EMPTY = 0;

export const pieceCode = (seat: Seat, type: number): number => seat * 16 + type;
export const seatOf = (code: number): Seat => (code >> 4) as Seat;
/** The full piece type, promoted variants included (7-10). Use `baseTypeOf` to ask how the piece MOVES. */
export const typeOf = (code: number): number => code & 15;

/** How each piece type moves: the ordinary type itself, or for a promoted piece the piece it became. */
const BASE_TYPE: readonly number[] = [0, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, QUEEN, KNIGHT, BISHOP, ROOK];
export const baseTypeOf = (code: number): number => BASE_TYPE[code & 15];
export const isPromotedType = (type: number): boolean => type >= PROMOTED_QUEEN;

/** What a pawn may promote to, in picker order (queen first), and the promoted piece type each choice produces. */
export const PROMOTABLE_TYPES: readonly number[] = [QUEEN, ROOK, BISHOP, KNIGHT];
export const PROMOTED_TYPE_OF: Record<number, number> = { [QUEEN]: PROMOTED_QUEEN, [ROOK]: PROMOTED_ROOK, [BISHOP]: PROMOTED_BISHOP, [KNIGHT]: PROMOTED_KNIGHT };

/**
 * What a captured piece scores for the capturer (a dead piece is worth 0, a king is never captured). A promoted piece is worth what
 * it was promoted to — EXCEPT the promoted queen, which stays at 1 point (chess.com's FFA table: it stops a pawn being "farmed" into
 * nine points). Under-promotions are not in that table; they take their ordinary piece values.
 */
export const CAPTURE_POINTS: Record<number, number> = {
  [PAWN]: 1,
  [KNIGHT]: 3,
  [BISHOP]: 5,
  [ROOK]: 5,
  [QUEEN]: 9,
  [PROMOTED_QUEEN]: 1,
  [PROMOTED_KNIGHT]: 3,
  [PROMOTED_BISHOP]: 5,
  [PROMOTED_ROOK]: 5,
  [KING]: 0,
};

/**
 * The rule knobs that differ between the four-player modes, as a union discriminated on `mode`. The engine reads the mode at a handful of
 * defined touch points (listed in giveaway.ts); everything else is mode-blind, and nothing hard-codes the numbers below, so a future mode
 * supplies its own rules object (Teams promotes on the 11th rank, for instance).
 */
interface RulesCommon {
  /** Forward coordinate (0..13 along the seat's own axis) on which a pawn promotes. */
  promotionCoord: number;
  /** The game is scored and ended when this many plies have been played (guards against endless bot games). */
  maxPlies: number;
  /**
   * The rule OPTIONS (below). OMITTED on the two shipped presets - their options are the defaults of their mode (`FFA_OPTIONS`, `GIVEAWAY_OPTIONS`),
   * which keeps `FFA_RULES` / `GIVEAWAY_RULES` value-for-value what they have always been. Read them only through `optionsOf`.
   */
  options?: RuleOptions;
}

/**
 * The rule OPTIONS: what a game's rules say about the board and about the pieces' behaviour that the engine used to hard-code. Chess.com builds its
 * 4-player variants the same way (a base mode plus options on a start position), and Chaturaji (CHATURAJI_SPEC.md) will be one more option set;
 * the engine reads every one of these at ONE defined place, so a new option set is data, not a rewrite.
 */
export interface RuleOptions {
  /** Which board: the key of `GEOMETRIES` (board.ts). */
  board: BoardId;
  /** Whether a pawn may advance two squares from its starting line (which is also what creates en passant). */
  pawnDoubleStep: boolean;
  /** Whether castling exists (rights, the move, the rights bookkeeping). */
  castling: boolean;
  /** The piece types a pawn may promote to, in the order the moves are generated (queen first). Must be a subset of `PROMOTABLE_TYPES`. */
  promotionTypes: readonly number[];
}

/** 4 Player Chess (free for all): checkmate, points, kings never captured. */
export interface FfaRules extends RulesCommon {
  mode: 'ffa';
  /** Points for checkmating a player. */
  checkmatePoints: number;
  /** Points the stalemated player receives. */
  stalematedPoints: number;
  /** Points each OTHER still-active player receives when someone is stalemated. */
  stalemateOthersPoints: number;
}

/** 4 Player Giveaway (4-seat Antichess): captures are mandatory, kings are ordinary pieces, no points. See giveaway.ts. */
export interface GiveawayRules extends RulesCommon {
  mode: 'giveaway';
}

export type FourPlayerRules = FfaRules | GiveawayRules;

/**
 * An absolute ceiling on game length that no rules object can raise (`maxPlies` may be lowered or tuned, never removed). It is the last
 * stop for a game whatever the checkmate / dead-position logic does: even a bug there cannot make a game, a bot-vs-bot run or a test
 * loop go on forever.
 */
export const HARD_MAX_PLIES = 5000;

export const FFA_RULES: FfaRules = {
  mode: 'ffa',
  promotionCoord: FFA_PROMOTION_COORD,
  checkmatePoints: 20,
  stalematedPoints: 20,
  stalemateOthersPoints: 10,
  maxPlies: 1000,
};

/** The Giveaway rules: the same promotion line and ply cap as FFA (at the cap the FEWEST PIECES win there, not the highest score). */
export const GIVEAWAY_RULES: GiveawayRules = {
  mode: 'giveaway',
  promotionCoord: FFA_PROMOTION_COORD,
  maxPlies: 1000,
};

/** 4 Player Chess's options: the cross board, double steps and castling, promotion to any of queen / rook / bishop / knight. */
export const FFA_OPTIONS: RuleOptions = { board: 'cross14', pawnDoubleStep: true, castling: true, promotionTypes: PROMOTABLE_TYPES };

/** Giveaway's options: the same board and pawns, but no castling (the rights start, and stay, empty). */
export const GIVEAWAY_OPTIONS: RuleOptions = { board: 'cross14', pawnDoubleStep: true, castling: false, promotionTypes: PROMOTABLE_TYPES };

/** The options a rules object plays by: its own, or the defaults of its mode. */
export const optionsOf = (rules: FourPlayerRules): RuleOptions => rules.options ?? (rules.mode === 'giveaway' ? GIVEAWAY_OPTIONS : FFA_OPTIONS);

/** The board a rules object plays on. The engine calls this once per function and reads the tables from the result. */
export const geometryOf = (rules: FourPlayerRules): Geometry => GEOMETRIES[optionsOf(rules).board];

/**
 * The rules objects an untrusted source (a wire message, a saved game) may name. `validateRules` accepts a value only when it is, field for field,
 * one of these presets - never an arbitrary mix of options - so an option can never leak into a game it was not tested with.
 */
export const KNOWN_RULES: readonly FourPlayerRules[] = [FFA_RULES, GIVEAWAY_RULES];

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : v));

export function validateRules(value: unknown): { ok: true; rules: FourPlayerRules } | { ok: false; error: string } {
  const text = canonical(value);
  const preset = KNOWN_RULES.find((known) => canonical(known) === text);
  return preset ? { ok: true, rules: preset } : { ok: false, error: 'unknown rules: only the shipped presets are accepted' };
}

/**
 * Which four-player game a room / queue / screen is about. `'ffa'` is 4 Player Chess (what the protocol did before Giveaway existed, so an OMITTED variant
 * always means `'ffa'`); `'giveaway'` is 4 Player Giveaway. Defined here, next to the rules it selects, so local screens can use it without touching the wire.
 */
export type FourVariant = 'ffa' | 'giveaway';

/** The rules object of a variant: `'ffa'` = 4 Player Chess, `'giveaway'` = 4 Player Giveaway. */
export const rulesFor = (variant: FourVariant): FourPlayerRules => (variant === 'giveaway' ? GIVEAWAY_RULES : FFA_RULES);

/** En passant opportunity created by a double step: the square that was skipped, the pawn's landing square, and who stepped. */
export interface EnPassant {
  passed: number;
  pawn: number;
  by: Seat;
}

export interface FourPlayerResult {
  /** FFA: the seats with the highest score when the game ended (more than one on a tie). Giveaway: the seat that won, or the seats tied for the fewest pieces at the cap. */
  winners: Seat[];
  /**
   * FFA: `elimination` (at most one seat left), `cap`, `deadPosition` (every still-active seat is down to a bare king, so no checkmate can ever
   * happen again - see `isDeadPosition`). Giveaway: `outOfPieces` (a move captured a seat's last piece - that seat wins), `stuck` (the seat to
   * move has no legal move - it wins), `lastStanding` (resignations / flag falls left one active seat) and `cap` (the fewest pieces win).
   */
  reason: 'elimination' | 'cap' | 'deadPosition' | 'outOfPieces' | 'stuck' | 'lastStanding';
}

export interface FourPlayerState {
  readonly cells: Int8Array;
  readonly turn: Seat;
  readonly status: readonly SeatStatus[];
  readonly score: readonly number[];
  /** Castling rights as 8 bits: bit (seat * 2 + side). Side 0 = the rook on the LOWER file/rank end, side 1 = the other. */
  readonly castling: number;
  readonly ep: EnPassant | null;
  /** King squares by seat (-1 never happens in a legal game; the helper keeps it for hand-built test positions). */
  readonly kings: readonly number[];
  readonly ply: number;
  readonly result: FourPlayerResult | null;
  readonly rules: FourPlayerRules;
}

export const isActive = (state: Pick<FourPlayerState, 'status'>, seat: Seat): boolean => state.status[seat] === 'active';
export const activeSeats = (state: Pick<FourPlayerState, 'status'>): Seat[] => ([0, 1, 2, 3] as Seat[]).filter((seat) => state.status[seat] === 'active');

// --- Castling geometry -------------------------------------------------------------------------------------------------

export interface CastleSide {
  /** Rook start square. */
  rook: number;
  /** Where the king lands (two squares towards the rook) and where the rook lands (the square the king crossed). */
  kingTo: number;
  rookTo: number;
  /** Squares that must be empty (strictly between king and rook). */
  between: readonly number[];
  /** Squares the king stands on / crosses / lands on: none may be attacked. */
  kingPath: readonly [number, number, number];
}

/** Each seat's king start and rook starts: (file, rank) per the standard layout. */
const KING_START: readonly (readonly [number, number])[] = [
  [7, 0], // Red h1
  [0, 7], // Blue a8
  [6, 13], // Yellow g14
  [13, 6], // Green n7
];
const ROOK_STARTS: readonly (readonly [readonly [number, number], readonly [number, number]])[] = [
  [[3, 0], [10, 0]], // Red d1, k1
  [[0, 3], [0, 10]], // Blue a4, a11
  [[3, 13], [10, 13]], // Yellow d14, k14
  [[13, 3], [13, 10]], // Green n4, n11
];

export const KING_START_SQUARE: readonly number[] = KING_START.map(([f, r]) => index(f, r));

export const CASTLES: readonly (readonly [CastleSide, CastleSide])[] = (() => {
  const sides = (seat: number): [CastleSide, CastleSide] => {
    const king = KING_START_SQUARE[seat];
    const unit = seat === 0 || seat === 2 ? 1 : SIZE; // the back rank runs along the file axis for Red/Yellow, the rank axis for Blue/Green
    const build = ([rf, rr]: readonly [number, number]): CastleSide => {
      const rook = index(rf, rr);
      const step = rook > king ? unit : -unit;
      const between: number[] = [];
      for (let s = king + step; s !== rook; s += step) between.push(s);
      return { rook, kingTo: king + 2 * step, rookTo: king + step, between, kingPath: [king, king + step, king + 2 * step] };
    };
    const [a, b] = ROOK_STARTS[seat];
    return [build(a), build(b)];
  };
  return [sides(0), sides(1), sides(2), sides(3)];
})();

/** Rook start square → castling-rights bit, for clearing rights when a rook moves or is captured. */
export const ROOK_START_BIT: ReadonlyMap<number, number> = (() => {
  const map = new Map<number, number>();
  for (let seat = 0; seat < 4; seat++) {
    map.set(CASTLES[seat][0].rook, seat * 2);
    map.set(CASTLES[seat][1].rook, seat * 2 + 1);
  }
  return map;
})();

// --- The start position ------------------------------------------------------------------------------------------------

const BACK_RANK_RKN = [ROOK, KNIGHT, BISHOP];
/** Back rank, read in increasing file (Red/Yellow) or rank (Blue/Green) order. Blue and Green have king and queen swapped relative to a pure rotation of Red's. */
const BACK_RANK: readonly (readonly number[])[] = [
  [...BACK_RANK_RKN, QUEEN, KING, BISHOP, KNIGHT, ROOK], // Red: d1 R … g1 Q, h1 K … k1 R
  [...BACK_RANK_RKN, QUEEN, KING, BISHOP, KNIGHT, ROOK], // Blue: a4 R … a7 Q, a8 K … a11 R
  [...BACK_RANK_RKN, KING, QUEEN, BISHOP, KNIGHT, ROOK], // Yellow: d14 R … g14 K, h14 Q … k14 R
  [...BACK_RANK_RKN, KING, QUEEN, BISHOP, KNIGHT, ROOK], // Green: n4 R … n7 K, n8 Q … n11 R
];

function blankCells(geo: Geometry): Int8Array {
  const cells = new Int8Array(geo.cells);
  for (let i = 0; i < geo.cells; i++) cells[i] = geo.valid[i] ? EMPTY : OFF_BOARD;
  return cells;
}

function kingSquares(cells: Int8Array, geo: Geometry): number[] {
  const kings = [-1, -1, -1, -1];
  for (let i = 0; i < geo.cells; i++) {
    const code = cells[i];
    if (code > 0 && typeOf(code) === KING) kings[seatOf(code)] = i;
  }
  return kings;
}

/** Castling bits for a position built from scratch: a right exists when the king and that rook still stand on their start squares. */
function inferredCastling(cells: Int8Array): number {
  let bits = 0;
  for (let seat = 0; seat < 4; seat++) {
    if (cells[KING_START_SQUARE[seat]] !== pieceCode(seat as Seat, KING)) continue;
    for (let side = 0; side < 2; side++) if (cells[CASTLES[seat][side].rook] === pieceCode(seat as Seat, ROOK)) bits |= 1 << (seat * 2 + side);
  }
  return bits;
}

/** The standard FFA start position, Red to move. */
export function initialState(rules: FourPlayerRules = FFA_RULES): FourPlayerState {
  const geo = geometryOf(rules);
  if (geo.id !== 'cross14') throw new Error(`no start position for board ${geo.id}`); // the layout below is the cross board's; a new board brings its own
  const cells = blankCells(geo);
  for (let seat = 0; seat < 4; seat++) {
    for (let k = 0; k < 8; k++) {
      const along = 3 + k; // the back rank occupies indices 3..10 on its axis
      const piece = pieceCode(seat as Seat, BACK_RANK[seat][k]);
      const pawn = pieceCode(seat as Seat, PAWN);
      if (seat === 0) {
        cells[index(along, 0)] = piece;
        cells[index(along, 1)] = pawn;
      } else if (seat === 1) {
        cells[index(0, along)] = piece;
        cells[index(1, along)] = pawn;
      } else if (seat === 2) {
        cells[index(along, 13)] = piece;
        cells[index(along, 12)] = pawn;
      } else {
        cells[index(13, along)] = piece;
        cells[index(12, along)] = pawn;
      }
    }
  }
  return {
    cells,
    turn: 0,
    status: ['active', 'active', 'active', 'active'],
    score: [0, 0, 0, 0],
    castling: optionsOf(rules).castling ? inferredCastling(cells) : 0, // Giveaway has no castling: the rights start (and stay) empty
    ep: null,
    kings: kingSquares(cells, geo),
    ply: 0,
    result: null,
    rules,
  };
}

// --- Hand-built positions (tests, board editor later) ------------------------------------------------------------------

// Promoted pieces: Z = queen, H = knight ("horse"), D = bishop ("diagonal"), T = rook ("tower").
const TYPE_LETTERS: Record<string, number> = { P: PAWN, N: KNIGHT, B: BISHOP, R: ROOK, Q: QUEEN, K: KING, Z: PROMOTED_QUEEN, H: PROMOTED_KNIGHT, D: PROMOTED_BISHOP, T: PROMOTED_ROOK };
const LETTER_OF_TYPE = 'xPNBRQKZHDT';
const SEAT_LETTERS = 'rbyg';

export interface PositionOptions {
  turn?: Seat;
  status?: SeatStatus[];
  score?: number[];
  /** Castling rights; omitted = inferred from king/rook placement (so start-like set-ups just work). */
  castling?: number;
  ep?: EnPassant | null;
  ply?: number;
  rules?: FourPlayerRules;
}

/**
 * Builds a position from a list like `['rK@h1', 'rR@d1', 'yK@g14', 'bP@b5']` (seat letter r/b/y/g + type letter P/N/B/R/Q/K + "@" +
 * square; Z/H/D/T are a promoted queen/knight/bishop/rook). Used by the tests to set up exact scenarios, and by anything that needs a custom position.
 */
export function stateFromPieces(pieces: readonly string[], options: PositionOptions = {}): FourPlayerState {
  const rules = options.rules ?? FFA_RULES;
  const geo = geometryOf(rules);
  const cells = blankCells(geo);
  for (const spec of pieces) {
    const match = /^([rbyg])([PNBRQKZHDT])@([a-n]\d{1,2})$/.exec(spec);
    if (!match) throw new Error(`bad piece spec: ${spec}`);
    const square = geo.parseSquare(match[3]);
    if (square < 0) throw new Error(`not a playable square: ${spec}`);
    if (cells[square] !== EMPTY) throw new Error(`square already taken: ${spec}`);
    cells[square] = pieceCode(SEAT_LETTERS.indexOf(match[1]) as Seat, TYPE_LETTERS[match[2]]);
  }
  return {
    cells,
    turn: options.turn ?? 0,
    status: options.status ?? ['active', 'active', 'active', 'active'],
    score: options.score ?? [0, 0, 0, 0],
    castling: options.castling ?? (optionsOf(rules).castling ? inferredCastling(cells) : 0),
    ep: options.ep ?? null,
    kings: kingSquares(cells, geo),
    ply: options.ply ?? 0,
    result: null,
    rules,
  };
}

/** Lists the pieces of a state in stateFromPieces' notation (sorted by square), mainly for assertions. */
export function listPieces(state: Pick<FourPlayerState, 'cells'> & { rules?: FourPlayerRules }): string[] {
  const geo = state.rules ? geometryOf(state.rules) : CROSS14;
  const out: string[] = [];
  for (let i = 0; i < state.cells.length; i++) {
    const code = state.cells[i];
    if (code > 0) out.push(`${SEAT_LETTERS[seatOf(code)]}${LETTER_OF_TYPE[typeOf(code)]}@${geo.squareName(i)}`);
  }
  return out;
}

// --- Serialisation -----------------------------------------------------------------------------------------------------

const STATUS_LETTER: Record<SeatStatus, string> = { active: 'a', 'dead-king': 'd', frozen: 'f' };
const LETTER_STATUS: Record<string, SeatStatus> = { a: 'active', d: 'dead-king', f: 'frozen' };

/**
 * A single-line text form (the 4-player counterpart of a FEN): 14 rows from rank 14 down to rank 1 joined by "/", each cell two
 * characters (seat letter + type letter, ".." empty, "--" off board), then turn, statuses, scores, castling bits, en passant
 * ("passedSquare:pawnSquare:seat" or "-"), ply, result ("-" or "winnerSeats,comma,separated:reason"). Round-trips exactly.
 */
export function serialize(state: FourPlayerState): string {
  const geo = geometryOf(state.rules);
  const size = geo.size;
  const rows: string[] = [];
  for (let rank = size - 1; rank >= 0; rank--) {
    let row = '';
    for (let file = 0; file < size; file++) {
      const code = state.cells[geo.index(file, rank)];
      row += code === OFF_BOARD ? '--' : code === EMPTY ? '..' : `${SEAT_LETTERS[seatOf(code)]}${LETTER_OF_TYPE[typeOf(code)]}`;
    }
    rows.push(row);
  }
  const ep = state.ep ? `${geo.squareName(state.ep.passed)}:${geo.squareName(state.ep.pawn)}:${state.ep.by}` : '-';
  const result = state.result ? `${state.result.winners.join(',')}:${state.result.reason}` : '-';
  return [rows.join('/'), state.turn, state.status.map((s) => STATUS_LETTER[s]).join(''), state.score.join(','), state.castling, ep, state.ply, result].join(' ');
}

export function deserialize(text: string, rules: FourPlayerRules = FFA_RULES): FourPlayerState {
  const [board, turn, statuses, scores, castling, ep, ply, resultText] = text.trim().split(' ');
  const geo = geometryOf(rules);
  const size = geo.size;
  const rows = board.split('/');
  if (rows.length !== size) throw new Error('bad board');
  const cells = new Int8Array(geo.cells);
  rows.forEach((row, i) => {
    const rank = size - 1 - i;
    for (let file = 0; file < size; file++) {
      const cell = row.slice(file * 2, file * 2 + 2);
      cells[geo.index(file, rank)] = cell === '--' ? OFF_BOARD : cell === '..' ? EMPTY : pieceCode(SEAT_LETTERS.indexOf(cell[0]) as Seat, LETTER_OF_TYPE.indexOf(cell[1]));
    }
  });
  let enPassant: EnPassant | null = null;
  if (ep !== '-') {
    const [passed, pawn, by] = ep.split(':');
    enPassant = { passed: geo.parseSquare(passed), pawn: geo.parseSquare(pawn), by: Number(by) as Seat };
  }
  const status = statuses.split('').map((letter) => LETTER_STATUS[letter]);
  let result: FourPlayerResult | null = null;
  if (resultText && resultText !== '-') {
    const [winners, reason] = resultText.split(':');
    result = { winners: winners ? (winners.split(',').map(Number) as Seat[]) : [], reason: reason as FourPlayerResult['reason'] };
  }
  return {
    cells,
    turn: Number(turn) as Seat,
    status,
    score: scores.split(',').map(Number),
    castling: Number(castling),
    ep: enPassant,
    kings: kingSquares(cells, geo),
    ply: Number(ply),
    result,
    rules,
  };
}
