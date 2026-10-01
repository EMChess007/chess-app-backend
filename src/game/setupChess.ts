import { Chess } from 'chess.js';
import type { PieceColor } from './RoomChessEngine.js';

export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';

/** Classical value of a full army (8+10+6+6+9 = 8 pawns, 2 rooks, 2 knights, 2 bishops, 1 queen)
 * — mirrors the frontend's src/logic/setupChess.ts exactly (see that file for the full rationale;
 * this is the authoritative server-side copy, since a client's claimed army is never trusted). */
export const SETUP_CHESS_BUDGET = 39;

export const SETUP_CHESS_PIECE_COST: Record<Exclude<PieceType, 'k'>, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
};

export interface SetupChessPiece {
  square: string;
  type: PieceType;
}

export function pieceCost(type: PieceType): number {
  return type === 'k' ? 0 : SETUP_CHESS_PIECE_COST[type];
}

export function computeArmyCost(pieces: SetupChessPiece[]): number {
  return pieces.reduce((sum, p) => sum + pieceCost(p.type), 0);
}

export function backRankFor(color: PieceColor): number {
  return color === 'w' ? 1 : 8;
}

export function pawnRankFor(color: PieceColor): number {
  return color === 'w' ? 2 : 7;
}

export function isSquareAllowed(square: string, type: PieceType, color: PieceColor): boolean {
  const rank = parseInt(square[1], 10);
  return type === 'p' ? rank === pawnRankFor(color) : rank === backRankFor(color);
}

export type SetupChessValidation = { ok: true } | { ok: false; error: string };

/** Authoritative validation of one submitted army — never trusts the client's own budget/king-
 * count bookkeeping. Checks square legality (right rank for that piece/color, no duplicate
 * squares), exactly one king, and total cost within budget. */
export function validateSetupArmy(pieces: SetupChessPiece[], color: PieceColor): SetupChessValidation {
  const seen = new Set<string>();
  for (const { square, type } of pieces) {
    if (seen.has(square)) return { ok: false, error: `Duplicate piece on ${square}.` };
    seen.add(square);
    if (!isSquareAllowed(square, type, color)) return { ok: false, error: `Illegal square for that piece: ${square}.` };
  }
  const kings = pieces.filter((p) => p.type === 'k').length;
  if (kings !== 1) return { ok: false, error: 'You need exactly one king.' };
  const cost = computeArmyCost(pieces);
  if (cost > SETUP_CHESS_BUDGET) return { ok: false, error: `Army costs ${cost}, budget is ${SETUP_CHESS_BUDGET}.` };
  return { ok: true };
}

/** Same merge as the frontend's mergeSetupArmies — see that file's doc comment for the castling-
 * rights convention (only available if king+matching rook both sit on their classical corner
 * squares). Kept as an independent copy rather than a shared package, same precedent as every
 * other piece of duplicated rules logic between this app's two separate npm projects. */
export function mergeSetupArmies(whitePieces: SetupChessPiece[], blackPieces: SetupChessPiece[]): string {
  const grid: (string | null)[][] = Array.from({ length: 8 }, () => Array(8).fill(null));

  const place = (pieces: SetupChessPiece[], color: PieceColor) => {
    for (const { square, type } of pieces) {
      const file = square.charCodeAt(0) - 97;
      const rank = parseInt(square[1], 10);
      const row = 8 - rank;
      grid[row][file] = color === 'w' ? type.toUpperCase() : type;
    }
  };
  place(whitePieces, 'w');
  place(blackPieces, 'b');

  const placement = grid
    .map((row) => {
      let rankStr = '';
      let emptyCount = 0;
      for (const cell of row) {
        if (!cell) {
          emptyCount += 1;
          continue;
        }
        if (emptyCount > 0) {
          rankStr += emptyCount;
          emptyCount = 0;
        }
        rankStr += cell;
      }
      if (emptyCount > 0) rankStr += emptyCount;
      return rankStr;
    })
    .join('/');

  const hasPieceAt = (pieces: SetupChessPiece[], square: string, type: PieceType) =>
    pieces.some((p) => p.square === square && p.type === type);
  const castling =
    (hasPieceAt(whitePieces, 'e1', 'k') && hasPieceAt(whitePieces, 'h1', 'r') ? 'K' : '') +
    (hasPieceAt(whitePieces, 'e1', 'k') && hasPieceAt(whitePieces, 'a1', 'r') ? 'Q' : '') +
    (hasPieceAt(blackPieces, 'e8', 'k') && hasPieceAt(blackPieces, 'h8', 'r') ? 'k' : '') +
    (hasPieceAt(blackPieces, 'e8', 'k') && hasPieceAt(blackPieces, 'a8', 'r') ? 'q' : '');

  return `${placement} w ${castling || '-'} - 0 1`;
}

/** The one rule two independently-valid armies can still violate once merged: the side not to
 * move (Black, since Setup Chess always starts with White to move) must not already be in check
 * — a real game could never reach such a position. Mirrors BoardSetupScreen's own
 * validateEditorFen rule (see src/logic/boardEditor.ts on the frontend) but only needs this one
 * check here, since square-legality and king-count are already guaranteed by validateSetupArmy
 * on both halves before they're ever merged. */
export function isMergedPositionLegal(fen: string): boolean {
  const fields = fen.split(' ');
  const flippedFen = [fields[0], 'b', '-', '-', '0', '1'].join(' ');
  const flipped = new Chess(flippedFen);
  return !flipped.isCheck();
}
