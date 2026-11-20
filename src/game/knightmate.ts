/**
 * Knightmate -- a self-contained rules engine (no chess.js: chess.js cannot have a royal knight), the same approach as
 * atomic.ts. Rules per chessvariants.com (Knightmate page + FAQ) and the XBoard / GNU Knightmate page:
 *
 *  - The KNIGHT is the royal piece: one per side, on e1 / e8 at the start. It moves as a knight, check / checkmate apply to
 *    it, and it may never be left (or moved) where an enemy piece attacks it. The ordinary KING is replaced by a COMMONER
 *    (two per side, b1 / g1 and b8 / g8): it steps one square in any direction, is NOT royal and can be captured.
 *    Two royal knights can never stand a knight's move apart (each would attack the other), just as two kings can never touch.
 *  - Start: Black "rmbqkbmr" / pawns, White the same in capitals (r rook, m commoner, b bishop, q queen, k ROYAL KNIGHT).
 *  - CASTLING: the unmoved royal knight moves two squares toward an unmoved rook (it ends on the g- or c-file) and the rook jumps
 *    to its other side; the FIDE conditions (every square between them empty, not in check, not through or into an attacked
 *    square). As the commoners start on b1 / g1, castling only becomes possible after they have moved away.
 *  - PROMOTION: queen, rook, bishop or COMMONER -- never a knight (there are no ordinary knights in this game).
 *  - Everything else as in chess: en passant, stalemate = draw, the fifty-move rule, threefold repetition (repetition.ts).
 *  - INSUFFICIENT MATERIAL: an automatic draw ONLY when both sides have nothing but their royal knight; every other position
 *    plays on (the fifty-move rule covers the rest).
 *
 * Internal letters (FEN and Piece.type): k = ROYAL KNIGHT, m = COMMONER (n never occurs). The SAME letters, in capitals, are the
 * notation (SAN / PGN / move list): K = royal knight, M = Commoner, promotion to a Commoner is "=M" (the rules sheet legend explains it;
 * the board draws the knight with a crown badge and the commoner as the theme's king with a corner badge, see Piece.tsx).
 * Clock: a flag with the opponent holding ONLY the royal knight is a draw (kmOnlyRoyalKnight), otherwise the flagged side loses.
 * This file is the SERVER twin of the app's src/logic/knightmate.ts: the shared rules block below
 * is mirrored VERBATIM there (backend/scripts/test-knightmate.mjs fails if the two copies differ -- edit both together).
 *
 * Mutually exclusive with every other variant (4 Player Chess, 4 Player Giveaway, Chaturaji and Crazy Bughouse included). Every
 * ChessEngine used with this file MUST be constructed with { knightmate: true }.
 */

// --- Shared rules block (mirrored VERBATIM in backend/src/game/knightmate.ts) -------------------------------------------

export type KmColor = 'w' | 'b';
/** k = royal knight, m = commoner. */
export type KmType = 'p' | 'b' | 'r' | 'q' | 'k' | 'm';
export type KmPromotion = 'q' | 'r' | 'b' | 'm';

export interface KmPiece {
  type: KmType;
  color: KmColor;
}

export interface KmPosition {
  /** 64 cells, index = file + 8 * rank (a1 = 0, h1 = 7, a8 = 56, h8 = 63). */
  board: (KmPiece | null)[];
  turn: KmColor;
  /** Subset of "KQkq" (K / Q = White kingside / queenside), "" for none. */
  castling: string;
  /** En passant target square index, -1 for none (only set when an enemy pawn can actually capture). */
  ep: number;
  halfmove: number;
  fullmove: number;
}

export interface KmMove {
  from: number;
  to: number;
  promotion?: KmPromotion;
  /** 'k' = kingside, 'q' = queenside (the royal knight's two-square step). */
  castle?: 'k' | 'q';
  enPassant?: boolean;
}

export type KmStatus = 'playing' | 'check' | 'checkmate' | 'stalemate' | 'draw';

export const KNIGHTMATE_START_FEN = 'rmbqkbmr/pppppppp/8/8/8/8/PPPPPPPP/RMBQKBMR w KQkq - 0 1';

export const KNIGHTMATE_PROMOTIONS: readonly KmPromotion[] = ['q', 'r', 'b', 'm'];

const KM_FILES = 'abcdefgh';
const KM_KNIGHT_STEPS: readonly (readonly [number, number])[] = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KM_KING_STEPS: readonly (readonly [number, number])[] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const KM_DIAGONALS: readonly (readonly [number, number])[] = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
const KM_ORTHOGONALS: readonly (readonly [number, number])[] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const KM_VALID_TYPES = 'pbrqkm';

export function kmSquareName(index: number): string {
  return `${KM_FILES[index % 8]}${Math.floor(index / 8) + 1}`;
}

export function kmSquareIndex(name: string): number {
  const file = KM_FILES.indexOf(name[0] ?? '');
  const rank = Number(name[1]) - 1;
  if (file < 0 || !(rank >= 0 && rank < 8) || name.length !== 2) return -1;
  return file + 8 * rank;
}

export function kmOpponent(color: KmColor): KmColor {
  return color === 'w' ? 'b' : 'w';
}

export function kmParseFen(fen: string): KmPosition {
  const fields = fen.trim().split(/\s+/);
  const rows = (fields[0] ?? '').split('/');
  if (rows.length !== 8) throw new Error(`Knightmate FEN needs 8 ranks: ${fen}`);
  const board: (KmPiece | null)[] = new Array(64).fill(null);
  for (let row = 0; row < 8; row++) {
    const rank = 7 - row;
    let file = 0;
    for (const ch of rows[row]) {
      if (ch >= '1' && ch <= '8') {
        file += Number(ch);
        continue;
      }
      const type = ch.toLowerCase();
      if (file > 7 || !KM_VALID_TYPES.includes(type)) throw new Error(`Bad Knightmate FEN piece "${ch}": ${fen}`);
      board[file + 8 * rank] = { type: type as KmType, color: ch === type ? 'b' : 'w' };
      file++;
    }
    if (file !== 8) throw new Error(`Knightmate FEN rank ${rank + 1} does not have 8 files: ${fen}`);
  }
  const turn = fields[1] === 'b' ? 'b' : 'w';
  const castling = (fields[2] ?? '-') === '-' ? '' : [...'KQkq'].filter((c) => fields[2].includes(c)).join('');
  const epField = fields[3] ?? '-';
  const ep = epField === '-' ? -1 : kmSquareIndex(epField);
  return { board, turn, castling, ep, halfmove: Number(fields[4] ?? 0) || 0, fullmove: Number(fields[5] ?? 1) || 1 };
}

export function kmFen(pos: KmPosition): string {
  const rows: string[] = [];
  for (let rank = 7; rank >= 0; rank--) {
    let row = '';
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const piece = pos.board[file + 8 * rank];
      if (!piece) {
        empty++;
        continue;
      }
      if (empty) row += String(empty);
      empty = 0;
      row += piece.color === 'w' ? piece.type.toUpperCase() : piece.type;
    }
    rows.push(row + (empty ? String(empty) : ''));
  }
  return `${rows.join('/')} ${pos.turn} ${pos.castling || '-'} ${pos.ep < 0 ? '-' : kmSquareName(pos.ep)} ${pos.halfmove} ${pos.fullmove}`;
}

/** Whether `square` is attacked by a piece of `by` (the royal knight attacks like a knight, the commoner like a one-step king). */
export function kmIsAttacked(pos: KmPosition, square: number, by: KmColor): boolean {
  const file = square % 8;
  const rank = Math.floor(square / 8);
  const at = (f: number, r: number): KmPiece | null => (f < 0 || f > 7 || r < 0 || r > 7 ? null : pos.board[f + 8 * r]);
  const pawnRank = by === 'w' ? rank - 1 : rank + 1;
  for (const df of [-1, 1]) {
    const p = at(file + df, pawnRank);
    if (p && p.color === by && p.type === 'p') return true;
  }
  for (const [df, dr] of KM_KNIGHT_STEPS) {
    const p = at(file + df, rank + dr);
    if (p && p.color === by && p.type === 'k') return true;
  }
  for (const [df, dr] of KM_KING_STEPS) {
    const p = at(file + df, rank + dr);
    if (p && p.color === by && p.type === 'm') return true;
  }
  for (const [rays, slider] of [[KM_DIAGONALS, 'b'], [KM_ORTHOGONALS, 'r']] as const) {
    for (const [df, dr] of rays) {
      for (let f = file + df, r = rank + dr; f >= 0 && f <= 7 && r >= 0 && r <= 7; f += df, r += dr) {
        const p = pos.board[f + 8 * r];
        if (!p) continue;
        if (p.color === by && (p.type === slider || p.type === 'q')) return true;
        break;
      }
    }
  }
  return false;
}

/** The index of `color`'s royal knight, -1 when it has none (a custom position). */
export function kmRoyalSquare(pos: KmPosition, color: KmColor): number {
  return pos.board.findIndex((p) => p?.type === 'k' && p.color === color);
}

export function kmInCheck(pos: KmPosition, color: KmColor = pos.turn): boolean {
  const royal = kmRoyalSquare(pos, color);
  return royal >= 0 && kmIsAttacked(pos, royal, kmOpponent(color));
}

/** Every move the side to move can make IGNORING whether its own royal knight is left attacked (castling is already fully checked). */
export function kmPseudoMoves(pos: KmPosition): KmMove[] {
  const moves: KmMove[] = [];
  const us = pos.turn;
  const them = kmOpponent(us);
  const push = (from: number, to: number) => moves.push({ from, to });
  for (let from = 0; from < 64; from++) {
    const piece = pos.board[from];
    if (!piece || piece.color !== us) continue;
    const file = from % 8;
    const rank = Math.floor(from / 8);
    if (piece.type === 'p') {
      const dir = us === 'w' ? 1 : -1;
      const startRank = us === 'w' ? 1 : 6;
      const lastRank = us === 'w' ? 7 : 0;
      const add = (to: number, enPassant = false) => {
        if (Math.floor(to / 8) === lastRank) for (const promotion of KNIGHTMATE_PROMOTIONS) moves.push({ from, to, promotion });
        else moves.push(enPassant ? { from, to, enPassant: true } : { from, to });
      };
      const ahead = from + 8 * dir;
      if (!pos.board[ahead]) {
        add(ahead);
        if (rank === startRank && !pos.board[ahead + 8 * dir]) push(from, ahead + 8 * dir);
      }
      for (const df of [-1, 1]) {
        if (file + df < 0 || file + df > 7) continue;
        const to = ahead + df;
        const target = pos.board[to];
        if (target && target.color === them) add(to);
        else if (!target && to === pos.ep) add(to, true);
      }
    } else if (piece.type === 'k' || piece.type === 'm') {
      for (const [df, dr] of piece.type === 'k' ? KM_KNIGHT_STEPS : KM_KING_STEPS) {
        const f = file + df;
        const r = rank + dr;
        if (f < 0 || f > 7 || r < 0 || r > 7) continue;
        const target = pos.board[f + 8 * r];
        if (!target || target.color === them) push(from, f + 8 * r);
      }
    } else {
      const rays = piece.type === 'b' ? KM_DIAGONALS : piece.type === 'r' ? KM_ORTHOGONALS : [...KM_DIAGONALS, ...KM_ORTHOGONALS];
      for (const [df, dr] of rays) {
        for (let f = file + df, r = rank + dr; f >= 0 && f <= 7 && r >= 0 && r <= 7; f += df, r += dr) {
          const target = pos.board[f + 8 * r];
          if (!target) push(from, f + 8 * r);
          else {
            if (target.color === them) push(from, f + 8 * r);
            break;
          }
        }
      }
    }
  }
  // Castling: the royal knight on its home square, the rook on its corner, both unmoved (the rights say so).
  const home = us === 'w' ? 4 : 60;
  const royal = pos.board[home];
  if (royal && royal.type === 'k' && royal.color === us && !kmIsAttacked(pos, home, them)) {
    const rookAt = (index: number) => pos.board[index]?.type === 'r' && pos.board[index]?.color === us;
    const empty = (...indexes: number[]) => indexes.every((i) => !pos.board[i]);
    const safe = (...indexes: number[]) => indexes.every((i) => !kmIsAttacked(pos, i, them));
    if (pos.castling.includes(us === 'w' ? 'K' : 'k') && rookAt(home + 3) && empty(home + 1, home + 2) && safe(home + 1, home + 2)) {
      moves.push({ from: home, to: home + 2, castle: 'k' });
    }
    if (pos.castling.includes(us === 'w' ? 'Q' : 'q') && rookAt(home - 4) && empty(home - 1, home - 2, home - 3) && safe(home - 1, home - 2)) {
      moves.push({ from: home, to: home - 2, castle: 'q' });
    }
  }
  return moves;
}

/** Plays `move` (assumed to come from kmPseudoMoves) and returns the new position and the captured piece type. */
export function kmApply(pos: KmPosition, move: KmMove): { position: KmPosition; captured?: KmType } {
  const board = pos.board.slice();
  const piece = board[move.from] as KmPiece;
  let captured: KmType | undefined = board[move.to]?.type;
  board[move.from] = null;
  if (move.enPassant) {
    const victim = move.to + (pos.turn === 'w' ? -8 : 8);
    captured = board[victim]?.type;
    board[victim] = null;
  }
  board[move.to] = move.promotion ? { type: move.promotion, color: piece.color } : piece;
  if (move.castle) {
    const rookFrom = move.castle === 'k' ? move.from + 3 : move.from - 4;
    const rookTo = move.castle === 'k' ? move.from + 1 : move.from - 1;
    board[rookTo] = board[rookFrom];
    board[rookFrom] = null;
  }
  let castling = pos.castling;
  const drop = (letters: string) => {
    castling = [...castling].filter((c) => !letters.includes(c)).join('');
  };
  if (piece.type === 'k') drop(piece.color === 'w' ? 'KQ' : 'kq');
  for (const square of [move.from, move.to]) {
    if (square === 0) drop('Q');
    else if (square === 7) drop('K');
    else if (square === 56) drop('q');
    else if (square === 63) drop('k');
  }
  let ep = -1;
  if (piece.type === 'p' && Math.abs(move.to - move.from) === 16) {
    const behind = (move.from + move.to) / 2;
    const rank = Math.floor(move.to / 8);
    const enemyPawnNear = [-1, 1].some((df) => {
      const file = (move.to % 8) + df;
      const near = file < 0 || file > 7 ? null : board[file + 8 * rank];
      return near?.type === 'p' && near.color !== piece.color;
    });
    if (enemyPawnNear) ep = behind;
  }
  const position: KmPosition = {
    board,
    turn: kmOpponent(pos.turn),
    castling,
    ep,
    halfmove: piece.type === 'p' || captured ? 0 : pos.halfmove + 1,
    fullmove: pos.turn === 'b' ? pos.fullmove + 1 : pos.fullmove,
  };
  return { position, captured };
}

/** Every legal move: the pseudo-legal ones that do not leave the mover's own royal knight attacked. */
export function kmLegalMoves(pos: KmPosition): KmMove[] {
  return kmPseudoMoves(pos).filter((move) => !kmInCheck(kmApply(pos, move).position, pos.turn));
}

/** True when every piece on the board is a royal knight (both sides have nothing else): the only automatic insufficient-material draw. */
export function kmInsufficientMaterial(pos: KmPosition): boolean {
  return pos.board.every((p) => p === null || p.type === 'k');
}

/** True when `color` has nothing but its royal knight left. A flag fall against such an opponent is a draw (it cannot mate with
 * a lone royal knight and the other side ran out of time), otherwise the flagged side loses -- see knightmateTimeoutResult. */
export function kmOnlyRoyalKnight(pos: KmPosition, color: KmColor): boolean {
  return pos.board.every((p) => p === null || p.color !== color || p.type === 'k');
}

/** The result of `flagged` running out of time in `pos`: 'draw' when the OPPONENT has only its royal knight, else the opponent wins. */
export function kmTimeoutResult(pos: KmPosition, flagged: KmColor): 'draw' | KmColor {
  return kmOnlyRoyalKnight(pos, kmOpponent(flagged)) ? 'draw' : kmOpponent(flagged);
}

/** The position's status for the side to move. Threefold repetition is the caller's (repetition.ts, history based). */
export function kmStatus(pos: KmPosition, legal: readonly KmMove[]): KmStatus {
  const inCheck = kmInCheck(pos);
  if (legal.length === 0) return inCheck ? 'checkmate' : 'stalemate';
  if (kmInsufficientMaterial(pos) || pos.halfmove >= 100) return 'draw';
  return inCheck ? 'check' : 'playing';
}

/** The legal move for from -> to; a promotion needs `promotion` (a queen when it is omitted). */
export function kmFindMove(pos: KmPosition, from: string, to: string, promotion?: string, legal: readonly KmMove[] = kmLegalMoves(pos)): KmMove | null {
  const f = kmSquareIndex(from);
  const t = kmSquareIndex(to);
  const matches = legal.filter((m) => m.from === f && m.to === t);
  if (matches.length === 0) return null;
  if (!matches[0].promotion) return matches[0];
  return matches.find((m) => m.promotion === (promotion ?? 'q')) ?? null;
}

const KM_SAN_LETTER: Record<KmType, string> = { p: '', b: 'B', r: 'R', q: 'Q', k: 'K', m: 'M' };
const KM_PROMOTION_LETTER: Record<KmPromotion, string> = { q: 'Q', r: 'R', b: 'B', m: 'M' };

/** Standard algebraic notation for a legal `move` of `pos` (`legal` = kmLegalMoves(pos), `next` = the position after it). */
export function kmSan(pos: KmPosition, move: KmMove, legal: readonly KmMove[], next: KmPosition): string {
  const piece = pos.board[move.from] as KmPiece;
  let san: string;
  if (move.castle) san = move.castle === 'k' ? 'O-O' : 'O-O-O';
  else {
    const capture = !!pos.board[move.to] || !!move.enPassant;
    const fromName = kmSquareName(move.from);
    san = KM_SAN_LETTER[piece.type];
    if (piece.type === 'p') {
      if (capture) san += fromName[0];
    } else {
      const rivals = legal.filter((m) => m.to === move.to && m.from !== move.from && pos.board[m.from]?.type === piece.type);
      if (rivals.length > 0) {
        const sameFile = rivals.some((m) => m.from % 8 === move.from % 8);
        const sameRank = rivals.some((m) => Math.floor(m.from / 8) === Math.floor(move.from / 8));
        if (!sameFile) san += fromName[0];
        else if (!sameRank) san += fromName[1];
        else san += fromName;
      }
    }
    san += (capture ? 'x' : '') + kmSquareName(move.to);
    if (move.promotion) san += `=${KM_PROMOTION_LETTER[move.promotion]}`;
  }
  if (kmInCheck(next)) san += kmLegalMoves(next).length === 0 ? '#' : '+';
  return san;
}

// --- End of the shared rules block ----------------------------------------------------------------------------------
