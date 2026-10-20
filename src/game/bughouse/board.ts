// GENERATED FILE - DO NOT EDIT BY HAND.
// Source: src/logic/bughouse/board.ts in the EM-Chess app repo. Regenerate with `npm run sync:bughouse`; CI runs it with --check.
// The only difference from the source is that relative imports carry the '.js' suffix NodeNext requires.

/**
 * Bughouse W1: ONE board - chess.js for every ordinary move (legality, castling, en passant, promotion, check) plus the Crazyhouse rules block for drops and promoted marks, exactly
 * as ChessEngine does for a 2-player Crazyhouse game, but with no clock, no history and no UI types, so that the client, the server and the bots can all run the same code.
 * MIRRORED to the backend (the generator allows the one package this file imports, chess.js; see backend/scripts/sync-bughouse.mjs).
 *
 * What differs from ChessEngine, on purpose: the verdict. ChessEngine's Crazyhouse "checkmate" means no move AND no drop with the pocket as it is NOW; in Bughouse a pocket fills
 * when the partner captures, so a check that a dropped piece could block is not a mate (rule 18, HP8) - `judgeBoard` calls that `stuck`. There is also no draw of any kind: chess.js's
 * draw detection is never consulted (insufficient material, repetition and the fifty-move rule do not exist here, rules 20 and 22).
 */
import { Chess, type Square } from 'chess.js';
import {
  RESERVE_PIECE_TYPES,
  crazyhouseDropCouldAnswerCheck,
  crazyhouseDropSan,
  legalDropSquares,
  type CrazyhouseMoveInfo,
  type CrazyhousePieceAt,
  type CrazyhouseState,
  type Reserve,
  type ReservePieceType,
} from '../crazyhouse.js';
import type { BoardDropOption, BoardMoveOption, BoardVerdict, PromotionPiece } from './rules.js';
import type { BughouseColor } from './types.js';

/** The standard start position, both boards. (A literal here: the mirrored closure rule keeps this module free of the app's UI types.) */
export const BOARD_START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** A position the engine can question: null for a FEN chess.js refuses. */
export function openBoard(fen: string): Chess | null {
  try {
    return new Chess(fen);
  } catch {
    return null;
  }
}

/** The state the Crazyhouse block works on for ONE board: the pocket of the White player there, the pocket of the Black player there, and this board's promoted marks (copies). */
export function boardCrazyhouse(promoted: readonly string[], white: Reserve, black: Reserve): CrazyhouseState {
  return { reserve: { w: { ...white }, b: { ...black } }, promoted: [...promoted] };
}

/** A lookup of the pieces on the board AS IT IS NOW: the board is read once (chess.board()), so asking about every square costs an array index each, not a chess.js lookup. It is a
 * snapshot - take a new one after the position changes. */
export function pieceAtOf(chess: Chess): CrazyhousePieceAt {
  const grid = chess.board();
  return (square) => grid[8 - Number(square[1])]?.[square.charCodeAt(0) - 97] ?? undefined;
}

const other = (color: BughouseColor): BughouseColor => (color === 'w' ? 'b' : 'w');

function kingSquareOf(chess: Chess, color: BughouseColor): string | null {
  for (const row of chess.board()) for (const cell of row) if (cell && cell.type === 'k' && cell.color === color) return cell.square;
  return null;
}

/** Whether `color` could drop SOMETHING from its pocket right now. */
function hasLegalDrop(chess: Chess, cz: CrazyhouseState, color: BughouseColor): boolean {
  const pieceAt = pieceAtOf(chess);
  for (const piece of RESERVE_PIECE_TYPES) if (legalDropSquares(cz, color, piece, pieceAt).length > 0) return true;
  return false;
}

/** What the side to move faces - see BoardStatus in rules.ts. `cz` carries the two pockets of THIS board. */
export function judgeBoard(chess: Chess, cz: CrazyhouseState): BoardVerdict {
  const turn = chess.turn();
  const inCheck = chess.isCheck();
  // "has a legal move": chess.js's own isCheckmate() / isStalemate() are `no legal move` on its raw generator, without the SAN (and the check / mate probe of every move) that `moves()` pays for
  const noMove = inCheck ? chess.isCheckmate() : chess.isStalemate();
  const canAct = !noMove || hasLegalDrop(chess, cz, turn);
  if (canAct) return { status: inCheck ? 'check' : 'playing', turn, inCheck, stuck: null };
  if (!inCheck) return { status: 'stuck', turn, inCheck: false, stuck: 'noAction' };
  const king = kingSquareOf(chess, turn);
  if (king !== null && crazyhouseDropCouldAnswerCheck(king, turn, pieceAtOf(chess))) return { status: 'stuck', turn, inCheck: true, stuck: 'check' };
  return { status: 'checkmate', turn, inCheck: true, stuck: null };
}

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Every legal ordinary move of the side to move, each promotion listed once, sorted by from / to / promotion. */
export function legalMoveOptions(chess: Chess): BoardMoveOption[] {
  const options: BoardMoveOption[] = chess.moves({ verbose: true }).map((m) => (m.promotion ? { from: m.from, to: m.to, promotion: m.promotion as PromotionPiece } : { from: m.from, to: m.to }));
  options.sort((a, b) => byKey(`${a.from}${a.to}${a.promotion ?? ''}`, `${b.from}${b.to}${b.promotion ?? ''}`));
  return options;
}

/** Every legal drop of the side to move (pocket piece x square), in the Crazyhouse block's own order. */
export function legalDropOptions(chess: Chess, cz: CrazyhouseState): BoardDropOption[] {
  const turn = chess.turn();
  const pieceAt = pieceAtOf(chess);
  const options: BoardDropOption[] = [];
  for (const piece of RESERVE_PIECE_TYPES) for (const square of legalDropSquares(cz, turn, piece, pieceAt)) options.push({ piece, square });
  return options;
}

/** The FEN the engine stores for a position: the en passant square is always written when a pawn has just double-stepped, like ChessEngine.getFen. */
export function fenOf(chess: Chess): string {
  return chess.fen({ forceEnpassantSquare: true });
}

export interface PlayedMove {
  mover: BughouseColor;
  /** What the Crazyhouse block needs to know about the move. */
  info: CrazyhouseMoveInfo;
  /** chess.js's notation without any "+" / "#" (the caller appends the Bughouse verdict's own). */
  san: string;
}

/** Plays a move on `chess` (mutating it) or returns null when it is not legal. The promotion field is only honoured for a move that promotes. */
export function playMove(chess: Chess, from: string, to: string, promotion: PromotionPiece | undefined): PlayedMove | null {
  let result;
  try {
    result = chess.move({ from: from as Square, to: to as Square, promotion });
  } catch {
    return null;
  }
  if (!result) return null;
  const rank = result.color === 'w' ? '1' : '8';
  const actualPromotion = result.promotion as PromotionPiece | undefined;
  return {
    mover: result.color,
    info: {
      from: result.from,
      to: result.to,
      promotion: actualPromotion,
      captured: result.captured,
      enPassant: result.flags.includes('e'),
      castleRook: result.flags.includes('k') ? { from: `h${rank}`, to: `f${rank}` } : result.flags.includes('q') ? { from: `a${rank}`, to: `d${rank}` } : undefined,
    },
    san: result.san.replace(/[+#]+$/, ''),
  };
}

/**
 * Plays a drop on `chess` (mutating it): the piece goes on `square`, the turn passes, the en passant square is cleared (a drop is never "a pawn that just double-stepped"), the
 * halfmove clock resets and the fullmove number advances after Black - ChessEngine.drop, step for step. Castling rights are FLAGS in the FEN that chess.js keeps, so a rook dropped
 * back on h1 does not restore a lost right (B6). Legality is the CALLER's job (legalDropSquares); false when chess.js refuses the placement.
 */
export function playDrop(chess: Chess, piece: ReservePieceType, square: string): boolean {
  const turn = chess.turn();
  if (!chess.put({ type: piece, color: turn }, square as Square)) return false;
  const fields = chess.fen().split(' ');
  fields[1] = other(turn);
  fields[3] = '-';
  fields[4] = '0';
  if (turn === 'b') fields[5] = String(Number(fields[5]) + 1);
  try {
    chess.load(fields.join(' '));
  } catch {
    return false;
  }
  return true;
}

/** The notation of a drop with the verdict's suffix: "N@f3", "N@f3+", "Q@e8#" ("#" only for a REAL mate; a stuck check is "+"). */
export function dropNotation(piece: ReservePieceType, square: string, verdict: BoardVerdict): string {
  return crazyhouseDropSan(piece, square, verdict.status === 'checkmate' ? '#' : verdict.inCheck ? '+' : '');
}

/** The notation of a move with the verdict's suffix. */
export function moveNotation(san: string, verdict: BoardVerdict): string {
  return `${san}${verdict.status === 'checkmate' ? '#' : verdict.inCheck ? '+' : ''}`;
}
