import { Chess, type Square as ChessJsSquare } from 'chess.js';
import { collapseFenRank, expandFenRank, getChess960BackRankFiles } from './chess960.js';

const FILES = 'abcdefgh';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** The four center squares — reaching one with your own king is an immediate win in King of the
 * Hill mode, regardless of the rest of the position. */
export const KING_OF_THE_HILL_SQUARES = ['d4', 'd5', 'e4', 'e5'] as const;

export type PieceColor = 'w' | 'b';
export type GameStatus = 'playing' | 'checkmate' | 'stalemate' | 'draw' | 'check';

export interface AppliedMove {
  from: string;
  to: string;
  promotion?: 'n' | 'b' | 'r' | 'q';
  san: string;
}

export interface RoomChessEngineOptions {
  /** Resolve castling using Chess960 rules instead of chess.js's own, which assumes classical
   * e1/e8 king and a1/h1/a8/h8 rook starting squares and gets it wrong for most 960 setups.
   * Ported from the mobile app's src/logic/ChessEngine.ts — see that file for the full
   * rationale; this is the same algorithm, trimmed to what server-side move validation needs
   * (no board/legal-move enumeration, since the server only ever applies one move at a time). */
  chess960?: boolean;
  /** The FEN the game actually started from — required in Chess960 mode to know which files
   * the king and rooks originally stood on (fixed for the game, unlike the current FEN). */
  initialFen?: string;
}

/**
 * Authoritative, server-side chess rules engine for a game room. Never trusts anything about
 * a move beyond `from`/`to`/`promotion` — every call goes through chess.js (or, for Chess960
 * castling, the hand-rolled logic below) and returns null for anything illegal.
 */
export class RoomChessEngine {
  private chess: Chess;
  private chess960: boolean;
  private files: { kingFile: number; queenRookFile: number; kingRookFile: number };

  constructor(fen?: string, options?: RoomChessEngineOptions) {
    this.chess = fen ? new Chess(fen) : new Chess();
    this.chess960 = options?.chess960 ?? false;
    this.files = getChess960BackRankFiles(options?.initialFen ?? fen ?? START_FEN);
  }

  getTurn(): PieceColor {
    return this.chess.turn();
  }

  move(from: string, to: string, promotion?: 'n' | 'b' | 'r' | 'q'): AppliedMove | null {
    if (this.chess960) {
      const side = this.matchChess960CastleAttempt(from, to);
      if (side) {
        return this.performChess960Castle(side);
      }
    }

    try {
      const result = this.chess.move({ from, to, promotion });
      if (!result) return null;
      // Real promotion only (chess.js only sets `promotion` on the result when the move
      // actually promoted a pawn) — never just echo back whatever the client claimed.
      const actualPromotion = result.promotion as 'n' | 'b' | 'r' | 'q' | undefined;
      return { from: result.from, to: result.to, promotion: actualPromotion, san: result.san };
    } catch {
      return null;
    }
  }

  getStatus(): GameStatus {
    if (this.chess.isCheckmate()) return 'checkmate';
    if (this.chess.isStalemate()) return 'stalemate';
    if (this.chess.isDraw()) return 'draw';
    if (this.chess.isCheck()) return 'check';
    return 'playing';
  }

  isGameOver(): boolean {
    return this.chess.isGameOver();
  }

  getFen(): string {
    return this.chess.fen();
  }

  /** Whether either king is currently on one of the 4 center squares — checked by the caller only
   * when the room is actually in King of the Hill mode (see rooms.ts's applyMove). Chess.js has
   * no idea this rule exists, so this is a plain independent board check, not part of getStatus(). */
  getKingOfTheHillWinner(): PieceColor | null {
    for (const square of KING_OF_THE_HILL_SQUARES) {
      const piece = this.chess.get(square as ChessJsSquare);
      if (piece?.type === 'k') return piece.color;
    }
    return null;
  }

  // --- Chess960 castling (see mobile ChessEngine.ts for the twin implementation) ------------

  private matchChess960CastleAttempt(from: string, to: string): 'k' | 'q' | null {
    const piece = this.chess.get(from as ChessJsSquare);
    if (!piece || piece.type !== 'k' || piece.color !== this.chess.turn()) return null;

    const rank = piece.color === 'w' ? '1' : '8';
    if (from !== `${FILES[this.files.kingFile]}${rank}`) return null;

    if (to === `${FILES[6]}${rank}` && this.isChess960CastleLegal(piece.color, 'k')) return 'k';
    if (to === `${FILES[2]}${rank}` && this.isChess960CastleLegal(piece.color, 'q')) return 'q';
    return null;
  }

  private isChess960CastleLegal(color: PieceColor, side: 'k' | 'q'): boolean {
    const castlingChar = side === 'k' ? (color === 'w' ? 'K' : 'k') : color === 'w' ? 'Q' : 'q';
    if (!this.chess.fen().split(' ')[2].includes(castlingChar)) return false;

    const rank = color === 'w' ? '1' : '8';
    const kingFile = this.files.kingFile;
    const rookFile = side === 'k' ? this.files.kingRookFile : this.files.queenRookFile;

    const kingFromSq = `${FILES[kingFile]}${rank}` as ChessJsSquare;
    const rookFromSq = `${FILES[rookFile]}${rank}` as ChessJsSquare;

    const kingPiece = this.chess.get(kingFromSq);
    const rookPiece = this.chess.get(rookFromSq);
    if (!kingPiece || kingPiece.type !== 'k' || kingPiece.color !== color) return false;
    if (!rookPiece || rookPiece.type !== 'r' || rookPiece.color !== color) return false;

    const kingToFile = side === 'k' ? 6 : 2;
    const rookToFile = side === 'k' ? 5 : 3;

    const mustBeEmpty = new Set<number>([...fileRange(kingFile, kingToFile), ...fileRange(rookFile, rookToFile)]);
    mustBeEmpty.delete(kingFile);
    mustBeEmpty.delete(rookFile);

    for (const file of mustBeEmpty) {
      if (this.chess.get(`${FILES[file]}${rank}` as ChessJsSquare)) return false;
    }

    const opponent: PieceColor = color === 'w' ? 'b' : 'w';
    for (const file of fileRange(kingFile, kingToFile)) {
      if (this.chess.isAttacked(`${FILES[file]}${rank}` as ChessJsSquare, opponent)) return false;
    }

    return true;
  }

  private performChess960Castle(side: 'k' | 'q'): AppliedMove | null {
    const color = this.chess.turn();
    if (!this.isChess960CastleLegal(color, side)) return null;

    const rank = color === 'w' ? '1' : '8';
    const rankIndex = color === 'w' ? 7 : 0;
    const kingFile = this.files.kingFile;
    const rookFile = side === 'k' ? this.files.kingRookFile : this.files.queenRookFile;
    const kingToFile = side === 'k' ? 6 : 2;
    const rookToFile = side === 'k' ? 5 : 3;

    const [placement, , castling, , halfmove, fullmove] = this.chess.fen().split(' ');
    const ranks = placement.split('/');
    const row = expandFenRank(ranks[rankIndex]);

    const kingChar = row[kingFile];
    const rookChar = row[rookFile];
    row[kingFile] = '.';
    row[rookFile] = '.';
    row[kingToFile] = kingChar;
    row[rookToFile] = rookChar;
    ranks[rankIndex] = collapseFenRank(row);

    const newCastling = (color === 'w' ? castling.replace(/[KQ]/g, '') : castling.replace(/[kq]/g, '')) || '-';
    const newTurn = color === 'w' ? 'b' : 'w';
    const newHalfmove = String(Number(halfmove) + 1);
    const newFullmove = color === 'b' ? String(Number(fullmove) + 1) : fullmove;

    const newFen = [ranks.join('/'), newTurn, newCastling, '-', newHalfmove, newFullmove].join(' ');
    this.chess.load(newFen);

    const from = `${FILES[kingFile]}${rank}`;
    const to = `${FILES[kingToFile]}${rank}`;
    const san = side === 'k' ? 'O-O' : 'O-O-O';
    return { from, to, san };
  }
}

function fileRange(a: number, b: number): number[] {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const out: number[] = [];
  for (let f = lo; f <= hi; f++) out.push(f);
  return out;
}
