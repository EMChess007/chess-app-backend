// GENERATED FILE - DO NOT EDIT BY HAND.
// Source: src/logic/fourPlayer/moves.ts in the EM-Chess app repo. Regenerate with `npm run sync:fourplayer`; CI runs it with --check.
// The only difference from the source is that relative imports carry the '.js' suffix NodeNext requires.

/**
 * 4 Player Chess — attack detection, move generation and applying a move to the board. See state.ts for the encoding and
 * elimination.ts for what happens AFTER a move (turn passing, checkmate/stalemate, scoring).
 *
 * MOVEMENT is exactly standard chess on the 160-square board: sliders' rays end at the cut corners, pawns move/capture in their
 * own seat's forward direction (any of the four axes), a pawn double-steps from its starting line and promotes (to a queen, always)
 * on its seat's promotion line.
 *
 * WHO ATTACKS WHOM. Every seat is the enemy of every other seat, but only ACTIVE seats attack: a dead (eliminated) seat's pieces
 * never give check and never capture; they only block lines. Kings are never captured — a king that is attacked is simply in check.
 *
 * LEGALITY generalises standard chess: a move is legal iff, after it, the mover's king is attacked by NO live enemy seat (so a
 * player in check from two opponents at once must answer both). A DEAD king (an eliminated seat's king, which keeps walking) obeys
 * the same rule but may only move to EMPTY squares and never castles.
 *
 * EN PASSANT is generic: a double step records the square it skipped; on the very next applied move any enemy pawn — of ANY seat,
 * i.e. in any direction — that can capture onto that square may do so (e.g. a Blue pawn can take a Red pawn en passant).
 */

import {
  DIRECTIONS,
  FORWARD,
  KING_TARGETS,
  KNIGHT_TARGETS,
  ORTHOGONAL_COUNT,
  PAWN_START_COORD,
  RAYS,
  fileOf,
  forwardCoord,
  index,
  isPlayable,
  pawnCaptureSquares,
  rankOf,
  stepForward,
  type Seat,
} from './board.js';
import {
  BISHOP,
  CAPTURE_POINTS,
  CASTLES,
  EMPTY,
  KING,
  KING_START_SQUARE,
  KNIGHT,
  PAWN,
  PROMOTABLE_TYPES,
  PROMOTED_TYPE_OF,
  QUEEN,
  ROOK,
  ROOK_START_BIT,
  baseTypeOf,
  pieceCode,
  seatOf,
  typeOf,
  type FourPlayerState,
  type SeatStatus,
} from './state.js';

export interface Move {
  from: number;
  to: number;
  /** The piece code captured (0 for none). For en passant this is the captured pawn, which is NOT on `to`. */
  captured: number;
  flags: number;
}

export const FLAG_DOUBLE_STEP = 1;
export const FLAG_EN_PASSANT = 2;
export const FLAG_PROMOTION = 4;
export const FLAG_CASTLE = 8;
/** With FLAG_CASTLE: the king castled towards the HIGHER-coordinate rook (castling side 1). */
export const FLAG_CASTLE_SIDE_1 = 16;
/** With FLAG_PROMOTION: bits 5-6 hold the index (into PROMOTABLE_TYPES: queen, rook, bishop, knight) of the piece promoted to. */
const PROMOTION_SHIFT = 5;
const PROMOTION_MASK = 3 << PROMOTION_SHIFT;

/** The ordinary piece type (QUEEN / ROOK / BISHOP / KNIGHT) a promotion move promotes to, or 0 when the move is not a promotion. */
export function promotionOf(move: Pick<Move, 'flags'>): number {
  return move.flags & FLAG_PROMOTION ? PROMOTABLE_TYPES[(move.flags & PROMOTION_MASK) >> PROMOTION_SHIFT] : 0;
}

/** The piece type that ends up on the board for a promotion move (a PROMOTED_* type), or 0 when the move is not a promotion. */
const promotedPieceType = (move: Pick<Move, 'flags'>): number => (move.flags & FLAG_PROMOTION ? PROMOTED_TYPE_OF[promotionOf(move)] : 0);

// --- Attacks -----------------------------------------------------------------------------------------------------------

/**
 * A bitmask (bit = seat) of the live enemy seats that attack `square` — i.e. that would give check to `victim`'s king standing
 * there. Seats whose status is not 'active' never attack; `victim`'s own pieces never count.
 */
export function attackers(cells: Int8Array, status: readonly SeatStatus[], square: number, victim: Seat): number {
  let mask = 0;
  const file = fileOf(square);
  const rank = rankOf(square);

  // Pawns: a pawn of seat `a` on p attacks p + forward ± sideways, so square is attacked from p = square - forward ∓ sideways.
  for (let a = 0; a < 4; a++) {
    if (a === victim || status[a] !== 'active') continue;
    const [df, dr] = FORWARD[a];
    const sideF = -dr;
    const sideR = df;
    const pawn = pieceCode(a as Seat, PAWN);
    for (const sign of [1, -1]) {
      const pf = file - df - sign * sideF;
      const pr = rank - dr - sign * sideR;
      if (isPlayable(pf, pr) && cells[index(pf, pr)] === pawn) mask |= 1 << a;
    }
  }

  const knightTargets = KNIGHT_TARGETS[square];
  for (let i = 0; i < knightTargets.length; i++) {
    const code = cells[knightTargets[i]];
    if (code > 0 && baseTypeOf(code) === KNIGHT) {
      const a = seatOf(code);
      if (a !== victim && status[a] === 'active') mask |= 1 << a;
    }
  }

  const kingTargets = KING_TARGETS[square];
  for (let i = 0; i < kingTargets.length; i++) {
    const code = cells[kingTargets[i]];
    if (code > 0 && typeOf(code) === KING) {
      const a = seatOf(code);
      if (a !== victim && status[a] === 'active') mask |= 1 << a;
    }
  }

  for (let d = 0; d < 8; d++) {
    const ray = RAYS[square * 8 + d];
    for (let i = 0; i < ray.length; i++) {
      const code = cells[ray[i]];
      if (code === EMPTY) continue;
      if (code > 0) {
        const a = seatOf(code);
        if (a !== victim && status[a] === 'active') {
          const type = baseTypeOf(code);
          if (type === QUEEN || (d < ORTHOGONAL_COUNT ? type === ROOK : type === BISHOP)) mask |= 1 << a;
        }
      }
      break; // the first piece on the ray blocks it, whoever owns it
    }
  }
  return mask;
}

/** Whether `seat`'s king is currently attacked by any live enemy seat. */
export function isInCheck(state: Pick<FourPlayerState, 'cells' | 'status' | 'kings'>, seat: Seat): boolean {
  const king = state.kings[seat];
  return king >= 0 && attackers(state.cells, state.status, king, seat) !== 0;
}

// --- Move generation ---------------------------------------------------------------------------------------------------

const isCapturable = (code: number, seat: Seat): boolean => code > 0 && seatOf(code) !== seat && typeOf(code) !== KING;

function pushPawnMove(out: Move[], state: FourPlayerState, seat: Seat, from: number, to: number, captured: number, flags: number): void {
  if (forwardCoord(seat, to) < state.rules.promotionCoord) {
    out.push({ from, to, captured, flags });
    return;
  }
  // Reaching the last line is a promotion, and the player picks the piece: one move per choice (queen first).
  for (let choice = 0; choice < PROMOTABLE_TYPES.length; choice++) out.push({ from, to, captured, flags: flags | FLAG_PROMOTION | (choice << PROMOTION_SHIFT) });
}

/** Pseudo-legal moves (king safety NOT yet checked) for every piece `seat` can move right now. */
export function pseudoMoves(state: FourPlayerState, seat: Seat): Move[] {
  const status = state.status[seat];
  const out: Move[] = [];
  if (status === 'frozen') return out;
  const cells = state.cells;

  if (status === 'dead-king') {
    // Only the king walks, and only onto empty squares.
    const from = state.kings[seat];
    if (from < 0) return out;
    const targets = KING_TARGETS[from];
    for (let i = 0; i < targets.length; i++) if (cells[targets[i]] === EMPTY) out.push({ from, to: targets[i], captured: 0, flags: 0 });
    return out;
  }

  for (let from = 0; from < cells.length; from++) {
    const code = cells[from];
    if (code <= 0 || seatOf(code) !== seat) continue;
    const type = baseTypeOf(code); // a promoted piece moves like the piece it became

    if (type === PAWN) {
      const one = stepForward(seat, from);
      if (one >= 0 && cells[one] === EMPTY) {
        pushPawnMove(out, state, seat, from, one, 0, 0);
        if (forwardCoord(seat, from) === PAWN_START_COORD) {
          const two = stepForward(seat, from, 2);
          if (two >= 0 && cells[two] === EMPTY) out.push({ from, to: two, captured: 0, flags: FLAG_DOUBLE_STEP });
        }
      }
      for (const target of pawnCaptureSquares(seat, from)) {
        if (target < 0) continue;
        const there = cells[target];
        if (isCapturable(there, seat)) {
          pushPawnMove(out, state, seat, from, target, there, 0);
        } else if (there === EMPTY && state.ep && state.ep.passed === target && state.ep.by !== seat) {
          const victim = cells[state.ep.pawn];
          if (victim > 0 && typeOf(victim) === PAWN && seatOf(victim) === state.ep.by) pushPawnMove(out, state, seat, from, target, victim, FLAG_EN_PASSANT);
        }
      }
    } else if (type === KNIGHT) {
      const targets = KNIGHT_TARGETS[from];
      for (let i = 0; i < targets.length; i++) {
        const there = cells[targets[i]];
        if (there === EMPTY || isCapturable(there, seat)) out.push({ from, to: targets[i], captured: there > 0 ? there : 0, flags: 0 });
      }
    } else if (type === KING) {
      const targets = KING_TARGETS[from];
      for (let i = 0; i < targets.length; i++) {
        const there = cells[targets[i]];
        if (there === EMPTY || isCapturable(there, seat)) out.push({ from, to: targets[i], captured: there > 0 ? there : 0, flags: 0 });
      }
      for (let side = 0; side < 2; side++) {
        if (!(state.castling & (1 << (seat * 2 + side))) || from !== KING_START_SQUARE[seat]) continue;
        const castle = CASTLES[seat][side];
        if (cells[castle.rook] !== pieceCode(seat, ROOK)) continue;
        if (castle.between.some((square) => cells[square] !== EMPTY)) continue;
        // The king may not castle out of, through or into check.
        if (castle.kingPath.some((square) => attackers(cells, state.status, square, seat) !== 0)) continue;
        out.push({ from, to: castle.kingTo, captured: 0, flags: FLAG_CASTLE | (side === 1 ? FLAG_CASTLE_SIDE_1 : 0) });
      }
    } else {
      // Bishop, rook, queen (and promoted queen).
      const first = type === BISHOP ? ORTHOGONAL_COUNT : 0;
      const last = type === ROOK ? ORTHOGONAL_COUNT : DIRECTIONS.length;
      for (let d = first; d < last; d++) {
        const ray = RAYS[from * 8 + d];
        for (let i = 0; i < ray.length; i++) {
          const there = cells[ray[i]];
          if (there === EMPTY) {
            out.push({ from, to: ray[i], captured: 0, flags: 0 });
            continue;
          }
          if (isCapturable(there, seat)) out.push({ from, to: ray[i], captured: there, flags: 0 });
          break;
        }
      }
    }
  }
  return out;
}

/** Plays `move` on a SCRATCH cell array in place and returns what is needed to undo it. */
function makeScratch(cells: Int8Array, state: FourPlayerState, move: Move, seat: Seat): () => void {
  const { from, to } = move;
  const piece = cells[from];
  const oldTo = cells[to];
  const epSquare = move.flags & FLAG_EN_PASSANT && state.ep ? state.ep.pawn : -1;
  const oldEp = epSquare >= 0 ? cells[epSquare] : 0;
  cells[from] = EMPTY;
  cells[to] = move.flags & FLAG_PROMOTION ? pieceCode(seat, promotedPieceType(move)) : piece;
  if (epSquare >= 0) cells[epSquare] = EMPTY;
  let rookFrom = -1;
  let rookTo = -1;
  let oldRookTo = 0;
  if (move.flags & FLAG_CASTLE) {
    const castle = CASTLES[seat][move.flags & FLAG_CASTLE_SIDE_1 ? 1 : 0];
    rookFrom = castle.rook;
    rookTo = castle.rookTo;
    oldRookTo = cells[rookTo];
    cells[rookTo] = cells[rookFrom];
    cells[rookFrom] = EMPTY;
  }
  return () => {
    if (rookFrom >= 0) {
      cells[rookFrom] = cells[rookTo];
      cells[rookTo] = oldRookTo;
    }
    if (epSquare >= 0) cells[epSquare] = oldEp;
    cells[to] = oldTo;
    cells[from] = piece;
  };
}

/** The moves `seat` may actually play: pseudo-legal moves that leave its own king attacked by no live enemy. */
export function legalMoves(state: FourPlayerState, seat: Seat): Move[] {
  const pseudo = pseudoMoves(state, seat);
  if (pseudo.length === 0) return pseudo;
  const scratch = state.cells.slice();
  const out: Move[] = [];
  for (const move of pseudo) {
    const movesKing = typeOf(scratch[move.from]) === KING;
    const undo = makeScratch(scratch, state, move, seat);
    const king = movesKing ? move.to : state.kings[seat];
    const exposed = king >= 0 && attackers(scratch, state.status, king, seat) !== 0;
    undo();
    if (!exposed) out.push(move);
  }
  return out;
}

/**
 * Finds the legal move `from → to` for `seat`. A promotion has four moves with the same from/to, so `promotion` (QUEEN, ROOK, BISHOP
 * or KNIGHT) picks one; it defaults to the queen, and is ignored for a move that is not a promotion.
 */
export function findLegalMove(state: FourPlayerState, seat: Seat, from: number, to: number, promotion: number = QUEEN): Move | null {
  return legalMoves(state, seat).find((move) => move.from === from && move.to === to && (!(move.flags & FLAG_PROMOTION) || promotionOf(move) === promotion)) ?? null;
}

// --- Applying a move ---------------------------------------------------------------------------------------------------

/**
 * Applies `move` for the seat that owns the moving piece and returns the new state with the SAME `turn` (passing the turn,
 * eliminations and game-over are elimination.ts's job). Captures score for the mover unless the victim's seat is already dead.
 * The move is trusted to be legal; callers get moves from legalMoves/findLegalMove.
 */
export function applyMoveRaw(state: FourPlayerState, move: Move): FourPlayerState {
  const cells = state.cells.slice();
  const piece = cells[move.from];
  const seat = seatOf(piece);
  const type = typeOf(piece);

  let castling = state.castling;
  const score = state.score.slice();
  const kings = state.kings.slice();

  if (move.captured) {
    const victimSeat = seatOf(move.captured);
    if (state.status[victimSeat] === 'active') score[seat] += CAPTURE_POINTS[typeOf(move.captured)] ?? 0;
  }

  cells[move.from] = EMPTY;
  cells[move.to] = move.flags & FLAG_PROMOTION ? pieceCode(seat, promotedPieceType(move)) : piece;
  if (move.flags & FLAG_EN_PASSANT && state.ep) cells[state.ep.pawn] = EMPTY;
  if (move.flags & FLAG_CASTLE) {
    const castle = CASTLES[seat][move.flags & FLAG_CASTLE_SIDE_1 ? 1 : 0];
    cells[castle.rookTo] = cells[castle.rook];
    cells[castle.rook] = EMPTY;
  }
  if (type === KING) {
    kings[seat] = move.to;
    castling &= ~(3 << (seat * 2));
  }
  const fromBit = ROOK_START_BIT.get(move.from);
  if (fromBit !== undefined) castling &= ~(1 << fromBit);
  const toBit = ROOK_START_BIT.get(move.to);
  if (toBit !== undefined) castling &= ~(1 << toBit);

  const ep = move.flags & FLAG_DOUBLE_STEP ? { passed: stepForward(seat, move.from), pawn: move.to, by: seat } : null;
  return { ...state, cells, score, kings, castling, ep, ply: state.ply + 1 };
}

const PROMOTION_LETTERS: Record<number, string> = { [QUEEN]: 'Q', [ROOK]: 'R', [BISHOP]: 'B', [KNIGHT]: 'N' };

/** Coordinate notation for the move list: "e2-e4", "d4xe5", "e7-e8=Q" (or =R / =B / =N), "O-O" / "O-O-O" (side 0 is the long side for Red/Yellow only by position, so castling shows both squares). */
export function moveLabel(move: Move): string {
  const name = (square: number) => `${'abcdefghijklmn'[fileOf(square)]}${rankOf(square) + 1}`;
  if (move.flags & FLAG_CASTLE) return `${name(move.from)}-${name(move.to)} (castle)`;
  return `${name(move.from)}${move.captured ? 'x' : '-'}${name(move.to)}${move.flags & FLAG_PROMOTION ? `=${PROMOTION_LETTERS[promotionOf(move)]}` : ''}${move.flags & FLAG_EN_PASSANT ? ' e.p.' : ''}`;
}
