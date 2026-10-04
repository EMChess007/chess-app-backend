// Server-side twin of the mobile app's src/logic/atomic.ts — the rules of Atomic chess (explosions,
// own-king explosion illegal, enemy-king explosion wins, adjacent kings never in check, Atomic's own
// castling, SAN, status, repetition, insufficient material). See that file's header for the full
// statement of the rules and how they were verified against lichess's scalachess and chessops.
//
// This is the server's AUTHORITY for Atomic: RoomChessEngine's `atomic` mode answers every legality and
// game-state question from here (chess.js is only kept as the board model), RoomManager.applyMove rejects
// anything outside generateAtomicMoves, and the winner of an exploded king is declared from
// getAtomicKingWinner — a modified client can not submit an illegal move or claim a win.
//
// The block between the "Representation" and "Engine-facing helpers" markers below is a VERBATIM copy of
// the mobile file's (this project's backend and mobile app are separate npm projects with no shared
// module, so hand-mirroring is the convention — see types/multiplayer.ts). scripts/test-atomic.mjs fails
// if the two copies ever differ, so the rules cannot silently drift apart; edit BOTH files together.

import type { PieceColor } from './RoomChessEngine.js';

export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
export interface Piece {
  type: PieceType;
  color: PieceColor;
}
/** A piece an explosion removed, and the square it stood on. */
export interface ExplodedPiece {
  square: string;
  piece: Piece;
}
export type GameStatus = 'playing' | 'checkmate' | 'stalemate' | 'draw' | 'check';

// --- Representation ----------------------------------------------------------------------------

const PAWN = 1;
const KNIGHT = 2;
const BISHOP = 3;
const ROOK = 4;
const QUEEN = 5;
const KING = 6;

const TYPE_BY_CODE: PieceType[] = ['p', 'n', 'b', 'r', 'q', 'k'];
const CODE_BY_TYPE: Record<PieceType, number> = { p: PAWN, n: KNIGHT, b: BISHOP, r: ROOK, q: QUEEN, k: KING };
const FILES = 'abcdefgh';

/** Castling-right bits. */
const WHITE_KING_SIDE = 1;
const WHITE_QUEEN_SIDE = 2;
const BLACK_KING_SIDE = 4;
const BLACK_QUEEN_SIDE = 8;

/**
 * A position as a flat 64-entry array (a1 = 0, b1 = 1 … h8 = 63): 0 is empty, +1..+6 are white
 * pawn/knight/bishop/rook/queen/king, negative for black. Positions are treated as immutable —
 * applyAtomicMove returns a new one — so they can be cached freely.
 */
export interface AtomicPosition {
  squares: Int8Array;
  turn: PieceColor;
  castling: number;
  /** En passant target square index, or -1. Set after EVERY double pawn push (not only when a capture
   * is actually possible), matching ChessEngine.getFen()'s forceEnpassantSquare. */
  ep: number;
  halfmove: number;
  fullmove: number;
}

export interface AtomicMove {
  from: number;
  to: number;
  promotion?: 'n' | 'b' | 'r' | 'q';
  /** Set for castling; `from`/`to` are then the KING's squares (e1→g1 style). */
  castle?: 'k' | 'q';
  enPassant?: boolean;
}

export const squareName = (index: number): string => `${FILES[index & 7]}${(index >> 3) + 1}`;

export function squareIndex(name: string): number {
  return (name.charCodeAt(1) - 49) * 8 + (name.charCodeAt(0) - 97);
}

const fileOf = (s: number) => s & 7;
const rankOf = (s: number) => s >> 3;
const isAdjacent = (a: number, b: number) => a !== b && Math.abs(fileOf(a) - fileOf(b)) <= 1 && Math.abs(rankOf(a) - rankOf(b)) <= 1;
const isLightSquare = (s: number) => ((fileOf(s) + rankOf(s)) & 1) === 1;

// --- FEN ---------------------------------------------------------------------------------------

export function parseAtomicFen(fen: string): AtomicPosition {
  const [placement, turn = 'w', castlingField = '-', epField = '-', halfmove = '0', fullmove = '1'] = fen.trim().split(/\s+/);
  const ranks = placement.split('/');
  if (ranks.length !== 8) throw new Error(`Invalid Atomic FEN (ranks): ${fen}`);
  const squares = new Int8Array(64);
  for (let r = 0; r < 8; r++) {
    let file = 0;
    for (const ch of ranks[r]) {
      if (ch >= '1' && ch <= '8') {
        file += ch.charCodeAt(0) - 48;
        continue;
      }
      const type = ch.toLowerCase() as PieceType;
      const code = CODE_BY_TYPE[type];
      if (!code || file > 7) throw new Error(`Invalid Atomic FEN (piece): ${fen}`);
      squares[(7 - r) * 8 + file] = ch === type ? -code : code;
      file += 1;
    }
    if (file !== 8) throw new Error(`Invalid Atomic FEN (rank width): ${fen}`);
  }
  let castling = 0;
  if (castlingField.includes('K')) castling |= WHITE_KING_SIDE;
  if (castlingField.includes('Q')) castling |= WHITE_QUEEN_SIDE;
  if (castlingField.includes('k')) castling |= BLACK_KING_SIDE;
  if (castlingField.includes('q')) castling |= BLACK_QUEEN_SIDE;
  return {
    squares,
    turn: turn === 'b' ? 'b' : 'w',
    castling,
    ep: epField === '-' ? -1 : squareIndex(epField),
    halfmove: parseInt(halfmove, 10) || 0,
    fullmove: parseInt(fullmove, 10) || 1,
  };
}

function castlingString(bits: number): string {
  const s = (bits & WHITE_KING_SIDE ? 'K' : '') + (bits & WHITE_QUEEN_SIDE ? 'Q' : '') + (bits & BLACK_KING_SIDE ? 'k' : '') + (bits & BLACK_QUEEN_SIDE ? 'q' : '');
  return s || '-';
}

function placementString(squares: Int8Array): string {
  const rows: string[] = [];
  for (let r = 7; r >= 0; r--) {
    let row = '';
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const v = squares[r * 8 + f];
      if (v === 0) {
        empty += 1;
        continue;
      }
      if (empty) row += empty;
      empty = 0;
      const letter = TYPE_BY_CODE[Math.abs(v) - 1];
      row += v > 0 ? letter.toUpperCase() : letter;
    }
    if (empty) row += empty;
    rows.push(row);
  }
  return rows.join('/');
}

export function atomicFen(pos: AtomicPosition): string {
  return [placementString(pos.squares), pos.turn, castlingString(pos.castling), pos.ep >= 0 ? squareName(pos.ep) : '-', pos.halfmove, pos.fullmove].join(' ');
}

// --- Geometry tables ---------------------------------------------------------------------------

function buildTargets(deltas: number[][]): number[][] {
  const out: number[][] = [];
  for (let s = 0; s < 64; s++) {
    const list: number[] = [];
    for (const [df, dr] of deltas) {
      const f = fileOf(s) + df;
      const r = rankOf(s) + dr;
      if (f >= 0 && f < 8 && r >= 0 && r < 8) list.push(r * 8 + f);
    }
    out.push(list);
  }
  return out;
}

const KNIGHT_TARGETS = buildTargets([[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]]);
const KING_TARGETS = buildTargets([[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]);

/** Directions 0-3 are rook rays, 4-7 bishop rays; RAYS[dir][square] lists the squares outward in order. */
const DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const RAYS: number[][][] = DIRECTIONS.map(([df, dr]) => {
  const perSquare: number[][] = [];
  for (let s = 0; s < 64; s++) {
    const ray: number[] = [];
    let f = fileOf(s) + df;
    let r = rankOf(s) + dr;
    while (f >= 0 && f < 8 && r >= 0 && r < 8) {
      ray.push(r * 8 + f);
      f += df;
      r += dr;
    }
    perSquare.push(ray);
  }
  return perSquare;
});

// --- Attacks -----------------------------------------------------------------------------------

/** Whether any piece of the colour `by` (+1 white, -1 black) attacks `target` — KINGS EXCLUDED, since
 * in Atomic a king can never capture. Does NOT apply the adjacent-kings immunity; callers do. */
function isAttacked(squares: Int8Array, target: number, by: number): boolean {
  const pawnRank = rankOf(target) - by;
  if (pawnRank >= 0 && pawnRank < 8) {
    const f = fileOf(target);
    if (f > 0 && squares[pawnRank * 8 + f - 1] === by * PAWN) return true;
    if (f < 7 && squares[pawnRank * 8 + f + 1] === by * PAWN) return true;
  }
  for (const t of KNIGHT_TARGETS[target]) if (squares[t] === by * KNIGHT) return true;
  for (let d = 0; d < 8; d++) {
    const straight = d < 4;
    for (const s of RAYS[d][target]) {
      const v = squares[s];
      if (v === 0) continue;
      if (v === by * QUEEN || v === by * (straight ? ROOK : BISHOP)) return true;
      break;
    }
  }
  return false;
}

function findKing(squares: Int8Array, sign: number): number {
  const code = sign * KING;
  for (let s = 0; s < 64; s++) if (squares[s] === code) return s;
  return -1;
}

// --- Applying a move to a board (shared by legality testing and real play) ----------------------

/** Mutates `sq` with the move's board effect, explosion included. Returns the captured piece code
 * (0 for a non-capture). When `removed` is given it is filled with every piece the move took off the
 * board, capturer first, then the captured piece, then the blast victims. */
function applyToBoard(sq: Int8Array, move: AtomicMove, sign: number, removed?: ExplodedPiece[]): number {
  const piece = sq[move.from];
  let captured = sq[move.to];
  let captureSquare = move.to;
  sq[move.from] = 0;

  if (move.enPassant) {
    captureSquare = move.to - 8 * sign;
    captured = sq[captureSquare];
    sq[captureSquare] = 0;
  }
  if (move.castle) {
    const rank = rankOf(move.from) * 8;
    if (move.castle === 'k') {
      sq[rank + 5] = sq[rank + 7];
      sq[rank + 7] = 0;
    } else {
      sq[rank + 3] = sq[rank];
      sq[rank] = 0;
    }
  }
  sq[move.to] = move.promotion ? sign * CODE_BY_TYPE[move.promotion] : piece;

  if (captured === 0) return 0;

  const toPiece = (code: number): Piece => ({ type: TYPE_BY_CODE[Math.abs(code) - 1], color: code > 0 ? 'w' : 'b' });
  removed?.push({ square: squareName(move.to), piece: toPiece(piece) });
  removed?.push({ square: squareName(captureSquare), piece: toPiece(captured) });
  sq[move.to] = 0;
  for (const n of KING_TARGETS[move.to]) {
    const v = sq[n];
    if (v !== 0 && Math.abs(v) !== PAWN) {
      removed?.push({ square: squareName(n), piece: toPiece(v) });
      sq[n] = 0;
    }
  }
  return captured;
}

// --- Move generation ---------------------------------------------------------------------------

const SCRATCH = new Int8Array(64);

/** Whether `move` (already pseudo-legal in shape) leaves the mover legal under Atomic's rules. */
function isLegalMove(pos: AtomicPosition, move: AtomicMove, sign: number, ownKing: number, enemyKing: number): boolean {
  SCRATCH.set(pos.squares);
  const movedKing = pos.squares[move.from] === sign * KING;
  applyToBoard(SCRATCH, move, sign);
  const kingSquare = movedKing ? move.to : ownKing;
  if (SCRATCH[kingSquare] !== sign * KING) return false; // own king exploded (or a king "capture")
  if (SCRATCH[enemyKing] !== -sign * KING) return true; // enemy king exploded: always playable, wins
  if (isAdjacent(kingSquare, enemyKing)) return true; // kings touching: neither is ever in check
  return !isAttacked(SCRATCH, kingSquare, -sign);
}

/** A castling-path square is safe if the enemy king touches it or nothing attacks it. */
function isSafeForCastling(squares: Int8Array, square: number, sign: number, enemyKing: number): boolean {
  return isAdjacent(square, enemyKing) || !isAttacked(squares, square, -sign);
}

const PROMOTIONS: ('q' | 'r' | 'b' | 'n')[] = ['q', 'r', 'b', 'n'];

function generatePseudo(pos: AtomicPosition, sign: number, ownKing: number, enemyKing: number): AtomicMove[] {
  const sq = pos.squares;
  const moves: AtomicMove[] = [];
  const promotionRank = sign === 1 ? 7 : 0;
  const startRank = sign === 1 ? 1 : 6;

  const pushPawnMove = (from: number, to: number, extra?: Partial<AtomicMove>) => {
    if (rankOf(to) === promotionRank) {
      for (const promotion of PROMOTIONS) moves.push({ from, to, promotion });
    } else {
      moves.push({ from, to, ...extra });
    }
  };

  for (let from = 0; from < 64; from++) {
    const v = sq[from];
    if (v === 0 || v * sign < 0) continue;
    const code = Math.abs(v);

    if (code === PAWN) {
      const one = from + 8 * sign;
      if (sq[one] === 0) {
        pushPawnMove(from, one);
        const two = one + 8 * sign;
        if (rankOf(from) === startRank && sq[two] === 0) moves.push({ from, to: two });
      }
      const f = fileOf(from);
      for (const df of [-1, 1]) {
        if (f + df < 0 || f + df > 7) continue;
        const to = one + df;
        if (sq[to] * sign < 0) pushPawnMove(from, to);
        else if (to === pos.ep && sq[to - 8 * sign] === -sign * PAWN) moves.push({ from, to, enPassant: true });
      }
    } else if (code === KNIGHT || code === KING) {
      for (const to of code === KNIGHT ? KNIGHT_TARGETS[from] : KING_TARGETS[from]) {
        if (sq[to] * sign <= 0) moves.push({ from, to });
      }
    } else {
      const first = code === BISHOP ? 4 : 0;
      const last = code === ROOK ? 4 : 8;
      for (let d = first; d < last; d++) {
        for (const to of RAYS[d][from]) {
          const target = sq[to];
          if (target * sign > 0) break;
          moves.push({ from, to });
          if (target !== 0) break;
        }
      }
    }
  }

  // Castling. The king must be on its home square (so ownKing === home); rights are cleared whenever
  // it or the rook moves or either is blown up, but the piece check keeps a hand-made FEN honest.
  const home = sign === 1 ? 4 : 60;
  if (ownKing === home && isSafeForCastling(sq, home, sign, enemyKing)) {
    const kingSide = sign === 1 ? WHITE_KING_SIDE : BLACK_KING_SIDE;
    const queenSide = sign === 1 ? WHITE_QUEEN_SIDE : BLACK_QUEEN_SIDE;
    const wantsKing = (pos.castling & kingSide) !== 0 && sq[home + 3] === sign * ROOK && sq[home + 1] === 0 && sq[home + 2] === 0;
    const wantsQueen = (pos.castling & queenSide) !== 0 && sq[home - 4] === sign * ROOK && sq[home - 1] === 0 && sq[home - 2] === 0 && sq[home - 3] === 0;
    if (wantsKing || wantsQueen) {
      // Path squares are tested with the king lifted off its home square so a slider behind it counts.
      const lifted = sq.slice();
      lifted[home] = 0;
      if (wantsKing && isSafeForCastling(lifted, home + 1, sign, enemyKing) && isSafeForCastling(lifted, home + 2, sign, enemyKing)) {
        moves.push({ from: home, to: home + 2, castle: 'k' });
      }
      if (wantsQueen && isSafeForCastling(lifted, home - 1, sign, enemyKing) && isSafeForCastling(lifted, home - 2, sign, enemyKing)) {
        moves.push({ from: home, to: home - 2, castle: 'q' });
      }
    }
  }

  return moves;
}

/** Every legal Atomic move for the side to move. Empty when either king is gone (the game is over). */
export function generateAtomicMoves(pos: AtomicPosition): AtomicMove[] {
  const sign = pos.turn === 'w' ? 1 : -1;
  const ownKing = findKing(pos.squares, sign);
  const enemyKing = findKing(pos.squares, -sign);
  if (ownKing < 0 || enemyKing < 0) return [];
  return generatePseudo(pos, sign, ownKing, enemyKing).filter((m) => isLegalMove(pos, m, sign, ownKing, enemyKing));
}

// --- Check, winner, status ---------------------------------------------------------------------

/** Whether the side to move is in check under Atomic's rules (never while the kings touch). */
export function isAtomicCheck(pos: AtomicPosition): boolean {
  const sign = pos.turn === 'w' ? 1 : -1;
  const ownKing = findKing(pos.squares, sign);
  const enemyKing = findKing(pos.squares, -sign);
  if (ownKing < 0 || enemyKing < 0 || isAdjacent(ownKing, enemyKing)) return false;
  return isAttacked(pos.squares, ownKing, -sign);
}

/** The side that has won by exploding the other's king, or null while both kings stand. */
export function getAtomicKingWinner(pos: AtomicPosition): PieceColor | null {
  const white = findKing(pos.squares, 1) >= 0;
  const black = findKing(pos.squares, -1) >= 0;
  if (white && !black) return 'w';
  if (black && !white) return 'b';
  return null;
}

/**
 * Atomic's automatic insufficient-material draw, ported from lichess's scalachess
 * (`Atomic.isInsufficientMaterial`, which uses InsufficientMatingMaterial's helpers). Chosen over
 * chessops's per-side rule because it is stricter in the right places: it also recognises closed pawn
 * positions and K+2 same-coloured bishops vs a bare king as dead, and it does NOT end the game when
 * opposite-coloured bishops could still help-mate (see the comparison in TESTING.md §7). Kings cannot
 * capture and bishops of opposite colours can never explode each other, so:
 *  - when each side has at least two pieces (a king and one more), only an all-bishop board of at most 4
 *    pieces with bishops on both square colours is dead;
 *  - an all-knight board is dead up to 4 pieces (K+2N vs K, K+N vs K+N); 3 knights can mate;
 *  - otherwise a board of kings, rooks and minors (no queens or pawns) is dead only up to 3 pieces
 *    (K+R/B/N vs K) and only when its bishops are not on opposite colours;
 *  - a CLOSED position — every piece is a king, a bishop or a pawn that is blocked head-on by another
 *    pawn and has no legal move, and every bishop is "pawnitised" (it can only ever meet pawns it cannot
 *    capture) — is dead too, since no capture, hence no explosion or mate, can ever occur.
 */
export function isAtomicInsufficientMaterial(pos: AtomicPosition): boolean {
  const sq = pos.squares;
  if (findKing(sq, 1) < 0 || findKing(sq, -1) < 0) return false;

  let whitePieces = 0;
  let blackPieces = 0;
  let onlyKingsAndBishops = true;
  let onlyKingsAndKnights = true;
  let onlyKingsRooksAndMinors = true;
  let onlyKingsBishopsAndPawns = true;
  let bishopOnLight = false;
  let bishopOnDark = false;
  for (let s = 0; s < 64; s++) {
    const v = sq[s];
    if (v === 0) continue;
    if (v > 0) whitePieces += 1;
    else blackPieces += 1;
    const code = Math.abs(v);
    if (code !== KING && code !== BISHOP) onlyKingsAndBishops = false;
    if (code !== KING && code !== KNIGHT) onlyKingsAndKnights = false;
    if (code !== KING && code !== ROOK && code !== KNIGHT && code !== BISHOP) onlyKingsRooksAndMinors = false;
    if (code !== KING && code !== BISHOP && code !== PAWN) onlyKingsBishopsAndPawns = false;
    if (code === BISHOP) {
      if (isLightSquare(s)) bishopOnLight = true;
      else bishopOnDark = true;
    }
  }
  const total = whitePieces + blackPieces;
  const bishopsOnOppositeColors = bishopOnLight && bishopOnDark;

  let cannotWin: boolean;
  if (whitePieces >= 2 && blackPieces >= 2) cannotWin = onlyKingsAndBishops && total <= 4 && bishopsOnOppositeColors;
  else if (onlyKingsAndKnights) cannotWin = total <= 4;
  else cannotWin = onlyKingsRooksAndMinors && !bishopsOnOppositeColors && total <= 3;
  if (cannotWin) return true;

  return onlyKingsBishopsAndPawns && isClosedPawnPosition(pos);
}

/** scalachess's atomicClosedPosition: every piece is a king, a bishop, or a pawn with no legal move that
 * is blocked head-on by another pawn; and the bishops (if any) are pawnitised. */
function isClosedPawnPosition(pos: AtomicPosition): boolean {
  const sq = pos.squares;
  // A pawn's own legal moves, judged with ITS colour to move (cached per colour).
  const legalFor = new Map<number, AtomicMove[]>();
  const movesOf = (sign: number) => {
    let moves = legalFor.get(sign);
    if (!moves) {
      moves = generateAtomicMoves({ ...pos, turn: sign === 1 ? 'w' : 'b' });
      legalFor.set(sign, moves);
    }
    return moves;
  };

  let bishop = -1;
  for (let s = 0; s < 64; s++) {
    const v = sq[s];
    if (v === 0) continue;
    const code = Math.abs(v);
    if (code === BISHOP && bishop < 0) bishop = s;
    if (code !== PAWN) continue;
    const sign = v > 0 ? 1 : -1;
    const front = s + 8 * sign;
    if (front < 0 || front > 63 || Math.abs(sq[front]) !== PAWN) return false;
    if (movesOf(sign).some((m) => m.from === s)) return false;
  }
  if (bishop < 0) return true;

  const bishopSign = sq[bishop] > 0 ? 1 : -1;
  const bishopLight = isLightSquare(bishop);
  for (let s = 0; s < 64; s++) {
    const v = sq[s];
    if (v === 0) continue;
    const code = Math.abs(v);
    const sameSide = v * bishopSign > 0;
    const ok =
      code === KING ||
      (code === PAWN && sameSide) ||
      (code === PAWN && !sameSide && isLightSquare(s) === !bishopLight) ||
      (code === BISHOP && sameSide && isLightSquare(s) === bishopLight);
    if (!ok) return false;
  }
  return true;
}

/**
 * Status of a position in terms of the existing GameStatus values, so the screens' existing
 * 'check'/'checkmate'/'stalemate'/'draw' handling works unchanged. A king-exploded win is NOT a
 * status (see getAtomicKingWinner) — it reports 'playing'. Threefold repetition needs the move
 * history and so lives outside this position-only function.
 */
export function getAtomicStatus(pos: AtomicPosition, legal: AtomicMove[] = generateAtomicMoves(pos)): GameStatus {
  if (getAtomicKingWinner(pos)) return 'playing';
  const check = isAtomicCheck(pos);
  if (legal.length === 0) return check ? 'checkmate' : 'stalemate';
  if (pos.halfmove >= 100 || isAtomicInsufficientMaterial(pos)) return 'draw';
  return check ? 'check' : 'playing';
}

// --- Applying a move for real, SAN -------------------------------------------------------------

export interface AtomicApplyResult {
  position: AtomicPosition;
  /** The piece type the move captured (en passant included), if any. */
  captured?: PieceType;
  /** Every piece the explosion removed — the capturer, the captured piece and the blast victims. */
  exploded: ExplodedPiece[];
}

/** Home squares whose occupant leaving (or being blown up) ends a castling right. */
const RIGHTS_LOST_AT: Record<number, number> = {
  0: WHITE_QUEEN_SIDE,
  4: WHITE_KING_SIDE | WHITE_QUEEN_SIDE,
  7: WHITE_KING_SIDE,
  56: BLACK_QUEEN_SIDE,
  60: BLACK_KING_SIDE | BLACK_QUEEN_SIDE,
  63: BLACK_KING_SIDE,
};

/** Applies a (legal) move, returning the new position. Does not re-validate. */
export function applyAtomicMove(pos: AtomicPosition, move: AtomicMove): AtomicApplyResult {
  const sign = pos.turn === 'w' ? 1 : -1;
  const squares = pos.squares.slice();
  const piece = pos.squares[move.from];
  const exploded: ExplodedPiece[] = [];
  const capturedCode = applyToBoard(squares, move, sign, exploded);

  let castling = pos.castling;
  for (const touched of [move.from, move.to, ...exploded.map((e) => squareIndex(e.square))]) {
    castling &= ~(RIGHTS_LOST_AT[touched] ?? 0);
  }

  const isPawn = Math.abs(piece) === PAWN;
  return {
    position: {
      squares,
      turn: pos.turn === 'w' ? 'b' : 'w',
      castling,
      ep: isPawn && Math.abs(move.to - move.from) === 16 ? (move.from + move.to) / 2 : -1,
      halfmove: isPawn || capturedCode !== 0 ? 0 : pos.halfmove + 1,
      fullmove: pos.turn === 'b' ? pos.fullmove + 1 : pos.fullmove,
    },
    captured: capturedCode !== 0 ? TYPE_BY_CODE[Math.abs(capturedCode) - 1] : undefined,
    exploded,
  };
}

/** Standard SAN for `move` from `pos` (legal moves given for disambiguation), with '+' for check and
 * '#' for checkmate OR an exploded enemy king, computed under Atomic's rules. */
export function atomicSan(pos: AtomicPosition, move: AtomicMove, legal: AtomicMove[], after: AtomicPosition): string {
  const code = Math.abs(pos.squares[move.from]);
  let san: string;
  if (move.castle) {
    san = move.castle === 'k' ? 'O-O' : 'O-O-O';
  } else {
    const isCapture = move.enPassant || pos.squares[move.to] !== 0;
    if (code === PAWN) {
      san = (isCapture ? `${FILES[fileOf(move.from)]}x` : '') + squareName(move.to);
      if (move.promotion) san += `=${move.promotion.toUpperCase()}`;
    } else {
      let ambiguities = 0;
      let sameRank = 0;
      let sameFile = 0;
      for (const other of legal) {
        if (other.from === move.from || other.to !== move.to || Math.abs(pos.squares[other.from]) !== code) continue;
        ambiguities += 1;
        if (rankOf(other.from) === rankOf(move.from)) sameRank += 1;
        if (fileOf(other.from) === fileOf(move.from)) sameFile += 1;
      }
      const from = squareName(move.from);
      const disambiguator = ambiguities === 0 ? '' : sameRank > 0 && sameFile > 0 ? from : sameFile > 0 ? from[1] : from[0];
      san = `${TYPE_BY_CODE[code - 1].toUpperCase()}${disambiguator}${isCapture ? 'x' : ''}${squareName(move.to)}`;
    }
  }
  if (getAtomicKingWinner(after)) return `${san}#`;
  if (isAtomicCheck(after)) return generateAtomicMoves(after).length === 0 ? `${san}#` : `${san}+`;
  return san;
}

// --- Repetition (history-based) ----------------------------------------------------------------

/** The part of a FEN that defines "the same position" for repetition: placement, side to move,
 * castling rights and — only when an en passant capture is actually legal — the ep square. */
export function atomicPositionKey(fen: string): string {
  const pos = parseAtomicFen(fen);
  const epPossible = pos.ep >= 0 && generateAtomicMoves(pos).some((m) => m.enPassant);
  return `${placementString(pos.squares)} ${pos.turn} ${castlingString(pos.castling)} ${epPossible ? squareName(pos.ep) : '-'}`;
}

/** Whether the LAST position in `fens` (initial position first, then each move's resulting FEN) has now
 * occurred three times. Computed from the history rather than tracked, so it is right after Undo too. */
export function isAtomicThreefoldRepetition(fens: string[]): boolean {
  if (fens.length < 9) return false; // the earliest a position can occur 3 times is the 9th (ply 8)
  const last = atomicPositionKey(fens[fens.length - 1]);
  let seen = 0;
  for (let i = fens.length - 1; i >= 0; i -= 2) {
    // Only positions with the same side to move can repeat, so every second entry is enough.
    if (atomicPositionKey(fens[i]) === last) seen += 1;
    if (seen >= 3) return true;
  }
  return false;
}

// --- Engine-facing helper (server only) ---------------------------------------------------------

/** Resolves a wire-level from/to/promotion to the matching legal Atomic move, or null. A promotion piece is
 * only required (and only matched) for pawn moves onto the last rank — a client's stray promotion field on
 * an ordinary move is ignored, and a king promotion ('k') never matches (it is Giveaway-only). */
export function findAtomicMove(pos: AtomicPosition, from: string, to: string, promotion?: string): AtomicMove | null {
  const f = squareIndex(from);
  const t = squareIndex(to);
  for (const m of generateAtomicMoves(pos)) {
    if (m.from === f && m.to === t && (!m.promotion || m.promotion === promotion)) return m;
  }
  return null;
}

/** The type of piece a legal move captures (en passant included), if any. */
export function atomicCapturedType(pos: AtomicPosition, m: AtomicMove): PieceType | undefined {
  if (m.enPassant) return 'p';
  const v = pos.squares[m.to];
  return v === 0 ? undefined : (['p', 'n', 'b', 'r', 'q', 'k'] as const)[Math.abs(v) - 1];
}
