import { Chess, Move as ChessJsMove, type Square as ChessJsSquare } from 'chess.js';
import {
  applyAtomicMove,
  atomicCapturedType,
  atomicFen,
  atomicSan,
  findAtomicMove,
  generateAtomicMoves,
  getAtomicKingWinner,
  getAtomicStatus,
  parseAtomicFen,
  type AtomicMove,
  type AtomicPosition,
} from './atomic.js';
import { collapseFenRank, expandFenRank, getChess960BackRankFiles } from './chess960.js';

const FILES = 'abcdefgh';

/** chess.js's KSIDE_CASTLE (32) | QSIDE_CASTLE (64) move flags — see RoomChessEngineOptions.giveaway. */
const CASTLE_FLAGS = 32 | 64;

/** chess.js's own internal move shape — not exported by name, but structurally identical to this
 * (TypeScript matches structurally, so this works wherever chess.js's own unexported
 * `InternalMove` type is expected, e.g. the `Move` class's constructor). See `ChessInternals`
 * below for why this exists — this is the server-side twin of the mobile app's identical
 * src/logic/ChessEngine.ts addition; see that file's own doc comment for the full rationale. */
interface InternalMove {
  color: PieceColor;
  from: number;
  to: number;
  piece: 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
  captured?: 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
  promotion?: 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
  flags: number;
}

interface ChessInternals {
  _moves(options?: { legal?: boolean; square?: ChessJsSquare; piece?: string }): InternalMove[];
  _makeMove(move: InternalMove): void;
  /** Places a piece on a 0x88 square index with no validation at all — unlike the public put()/load(),
   * which refuse a second king of one colour. See loadGiveawayFen. */
  _set(square: number, piece: { type: 'k'; color: PieceColor }): void;
}

/** Inverse of squareFromIndex: algebraic square to chess.js's 0x88 board index. */
function indexFromSquare(square: string): number {
  return (8 - Number(square[1])) * 16 + FILES.indexOf(square[0]);
}

/**
 * Loads a Giveaway FEN, keeping a SECOND king of one colour — the server twin of the mobile app's
 * identical loadGiveawayFen (src/logic/ChessEngine.ts; see its doc comment for the full rationale).
 * chess.js's load()/put() silently drop all but the first king of a colour, but Giveaway lets a pawn
 * promote to a king while the side's own king is alive.
 */
function loadGiveawayFen(fen: string): Chess {
  const [placement, ...rest] = fen.split(' ');
  const seen: Record<PieceColor, boolean> = { w: false, b: false };
  const extras: { square: string; color: PieceColor }[] = [];
  const ranks = placement.split('/').map((rank, rankIndex) => {
    let file = 0;
    let out = '';
    for (const ch of rank) {
      if (ch >= '1' && ch <= '8') {
        out += ch;
        file += Number(ch);
        continue;
      }
      if (ch === 'K' || ch === 'k') {
        const color: PieceColor = ch === 'K' ? 'w' : 'b';
        if (seen[color]) {
          extras.push({ square: `${FILES[file]}${8 - rankIndex}`, color });
          out += '1';
          file += 1;
          continue;
        }
        seen[color] = true;
      }
      out += ch;
      file += 1;
    }
    return out;
  });
  const chess = new Chess([ranks.join('/'), ...rest].join(' '), { skipValidation: true });
  for (const extra of extras) {
    (chess as unknown as ChessInternals)._set(indexFromSquare(extra.square), { type: 'k', color: extra.color });
  }
  return chess;
}

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** The four center squares — reaching one with your own king is an immediate win in King of the
 * Hill mode, regardless of the rest of the position. */
export const KING_OF_THE_HILL_SQUARES = ['d4', 'd5', 'e4', 'e5'] as const;

/** Number of times a side must have delivered check to win outright in Three-Check mode. */
export const THREE_CHECK_TARGET = 3;

export type PieceColor = 'w' | 'b';
export type GameStatus = 'playing' | 'checkmate' | 'stalemate' | 'draw' | 'check';

export interface AppliedMove {
  from: string;
  to: string;
  /** 'k' only ever appears in Giveaway (Antichess), where a pawn may promote to a king. */
  promotion?: 'n' | 'b' | 'r' | 'q' | 'k';
  san: string;
  /** The type of piece captured by this move, if any — only ever populated by movePseudoLegal
   * (Fog of War), which needs it to detect a king capture; the normal move() path has never
   * needed it since every other variant's win conditions don't depend on what was captured. */
  captured?: 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
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
  /**
   * Giveaway (Antichess) only — the server-side twin of the mobile app's identical ChessEngine
   * option (see src/logic/ChessEngine.ts and src/logic/giveaway.ts there for the rules). Changes
   * what getPseudoLegalMoves/movePseudoLegal generate: castling is dropped, a pawn reaching its last
   * rank may also promote to a KING, and SAN loses its '+'/'#' suffix (chess.js's check detection is
   * meaningless here). Positions may be kingless or hold two kings of a colour, so the engine is built
   * through loadGiveawayFen and rebuilt from its own FEN after every move. Every other mode leaves
   * this off, so its behaviour is untouched.
   */
  giveaway?: boolean;
  /**
   * Atomic chess only — the server-side twin of the mobile app's identical ChessEngine option (see
   * src/logic/atomic.ts there, mirrored verbatim in ./atomic.ts). The engine's public move API
   * (move/getStatus/isGameOver/getFen) is answered by atomic.ts instead of chess.js, which stays only as
   * the board model, reloaded from the new FEN after every move. A finished game's FEN has no king for
   * the loser, so this implies skipValidation. Every other mode leaves this off.
   */
  atomic?: boolean;
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
  private giveaway: boolean;
  private atomic: boolean;
  /** Atomic only: the position's FEN as produced by atomic.ts (the source of truth in that mode). */
  private atomicCurrentFen: string;
  private atomicPosCache: AtomicPosition | null = null;
  private atomicLegalCache: AtomicMove[] | null = null;

  constructor(fen?: string, options?: RoomChessEngineOptions) {
    this.giveaway = options?.giveaway ?? false;
    this.atomic = options?.atomic ?? false;
    this.chess = fen ? (this.giveaway ? loadGiveawayFen(fen) : new Chess(fen, { skipValidation: this.atomic })) : new Chess();
    this.atomicCurrentFen = fen ?? START_FEN;
    this.chess960 = options?.chess960 ?? false;
    this.files = getChess960BackRankFiles(options?.initialFen ?? fen ?? START_FEN);
  }

  getTurn(): PieceColor {
    return this.chess.turn();
  }

  move(from: string, to: string, promotion?: 'n' | 'b' | 'r' | 'q'): AppliedMove | null {
    if (this.atomic) return this.moveAtomic(from, to, promotion);
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
    if (this.atomic) return getAtomicStatus(this.getAtomicPosition(), this.getAtomicLegal());
    if (this.chess.isCheckmate()) return 'checkmate';
    if (this.chess.isStalemate()) return 'stalemate';
    if (this.chess.isDraw()) return 'draw';
    if (this.chess.isCheck()) return 'check';
    return 'playing';
  }

  isGameOver(): boolean {
    if (this.atomic) {
      if (getAtomicKingWinner(this.getAtomicPosition())) return true;
      const status = this.getStatus();
      return status === 'checkmate' || status === 'stalemate' || status === 'draw';
    }
    return this.chess.isGameOver();
  }

  getFen(): string {
    if (this.atomic) return this.atomicCurrentFen;
    // forceEnpassantSquare: see the mobile app's identical ChessEngine.getFen() for the full
    // rationale — without this, chess.js's own .fen() can silently drop an en-passant target
    // that movePseudoLegal would otherwise still accept once Fog of War allows king exposure.
    return this.chess.fen({ forceEnpassantSquare: true });
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

  /** How many times each side has delivered check so far — derived from chess.js's own move
   * history (every SAN it produces already ends in '+' or '#' for a checking move) rather than
   * tracked as separate mutable state, so it's always consistent with the actual game. */
  getCheckCounts(): Record<PieceColor, number> {
    const counts: Record<PieceColor, number> = { w: 0, b: 0 };
    for (const move of this.chess.history({ verbose: true })) {
      if (move.san.endsWith('+') || move.san.endsWith('#')) counts[move.color]++;
    }
    return counts;
  }

  /** Whether either side has delivered check THREE_CHECK_TARGET times — checked by the caller
   * only when the room is actually in Three-Check mode (see rooms.ts's applyMove). */
  getThreeCheckWinner(): PieceColor | null {
    const counts = this.getCheckCounts();
    if (counts.w >= THREE_CHECK_TARGET) return 'w';
    if (counts.b >= THREE_CHECK_TARGET) return 'b';
    return null;
  }

  // --- Atomic (see atomic.ts) --------------------------------------------

  /** The current position in atomic.ts's representation (parsed once per position and cached). Only
   * meaningful for an engine constructed with { atomic: true }. Treat as read-only. */
  getAtomicPosition(): AtomicPosition {
    this.atomicPosCache ??= parseAtomicFen(this.atomicCurrentFen);
    return this.atomicPosCache;
  }

  private getAtomicLegal(): AtomicMove[] {
    this.atomicLegalCache ??= generateAtomicMoves(this.getAtomicPosition());
    return this.atomicLegalCache;
  }

  /** Applies a legal Atomic move: atomic.ts computes the whole resulting position (explosion, castling
   * rights, clocks, en passant square) and chess.js is simply reloaded from the new FEN. Returns null for
   * anything illegal — including a king capture or a move that would explode the mover's own king. */
  private moveAtomic(from: string, to: string, promotion?: string): AppliedMove | null {
    const pos = this.getAtomicPosition();
    const found = findAtomicMove(pos, from, to, promotion);
    if (!found) return null;

    const legal = this.getAtomicLegal();
    const result = applyAtomicMove(pos, found);
    const san = atomicSan(pos, found, legal, result.position);
    const newFen = atomicFen(result.position);
    this.chess.load(newFen, { skipValidation: true });
    this.atomicCurrentFen = newFen;
    this.atomicPosCache = null;
    this.atomicLegalCache = null;
    return { from, to, promotion: found.promotion, san, captured: atomicCapturedType(pos, found) };
  }

  // --- Fog of War (see ChessInternals above) -----------------------------

  /** Pseudo-legal moves for `color` (defaults to the side to move) — see the mobile app's
   * identical ChessEngine.getPseudoLegalMoves for the full rationale. Used here both to validate
   * a submitted Fog of War move server-side and to compute each player's own visibility
   * (off-turn too, via a throwaway turn-flipped clone — chess.js's generator is always
   * turn-bound). */
  getPseudoLegalMoves(color?: PieceColor): AppliedMove[] {
    const turn = this.chess.turn();
    const source = !color || color === turn ? this.chess : this.cloneWithTurn(color);
    return this.generateRaw(source).map(toAppliedMoveFromRaw);
  }

  /** Server-authoritative Fog of War move application — validates `from`/`to`/`promotion`
   * against the current side's own pseudo-legal moves (never trusts the client beyond that) and
   * applies it directly via chess.js's internal _makeMove, bypassing the public move()'s
   * king-safety gate entirely. Returns null if nothing matches. */
  movePseudoLegal(from: string, to: string, promotion?: AppliedMove['promotion']): AppliedMove | null {
    const internals = this.chess as unknown as ChessInternals;
    const candidates = this.generateRaw(this.chess);
    // See the mobile app's identical movePseudoLegal — compared off the raw move's own fields,
    // not a chess.js Move wrapper built (at full cost) for every candidate scanned.
    const raw = candidates.find(
      (m) => squareFromIndex(m.from) === from && squareFromIndex(m.to) === to && (!m.promotion || m.promotion === promotion)
    );
    if (!raw) return null;
    const pretty = new ChessJsMove(this.chess, raw);
    internals._makeMove(raw);
    const applied = toAppliedMove(pretty);
    if (!this.giveaway) return applied;
    // Giveaway only: unlike Fog of War (where a king capture ends the game on the spot), a Giveaway game
    // CARRIES ON after a king is captured, and chess.js's live internal state does not cope — its
    // _kings entry for the captured side keeps pointing at the old square, and its castling rights
    // survive, so a later castle candidate (built from that stale square) makes _makeMove throw
    // "Cannot read properties of undefined (reading 'type')" — found by scripts/test-giveaway.mjs's
    // parity run, which would have taken the whole server process down mid-game. Rebuilding the
    // engine from its own FEN after every move gives it fresh bookkeeping derived from the actual
    // board — exactly what the mobile app does implicitly by building a new engine from the FEN on
    // every ply (and loadGiveawayFen keeps a promoted second king through that rebuild).
    this.chess = loadGiveawayFen(this.chess.fen({ forceEnpassantSquare: true }));
    return { ...applied, san: applied.san.replace(/[+#]$/, '') };
  }

  /** chess.js's raw pseudo-legal candidates for `source`'s side to move, adjusted for Giveaway when
   * that option is on — the same adjustment as the mobile app's ChessEngine.generateRaw (castling
   * dropped; each queen promotion also offered as a king promotion). */
  private generateRaw(source: Chess): InternalMove[] {
    const raw = (source as unknown as ChessInternals)._moves({ legal: false });
    if (!this.giveaway) return raw;
    const out: InternalMove[] = [];
    for (const m of raw) {
      if (m.flags & CASTLE_FLAGS) continue;
      out.push(m);
      if (m.promotion === 'q') out.push({ ...m, promotion: 'k' });
    }
    return out;
  }

  private cloneWithTurn(color: PieceColor): Chess {
    const fields = this.chess.fen().split(' ');
    fields[1] = color;
    // skipValidation: the position being cloned can legitimately be missing a king here — either
    // the king was just captured (Fog of War's own win condition) or this engine was constructed
    // from an already-redacted fen in the first place. chess.js validates the WHOLE position on
    // load regardless of which color's moves are actually being asked for, so this is required
    // even when only querying the side that still has its king — confirmed the hard way: omitting
    // this crashed the whole process with "Invalid FEN: missing white king" the moment a Fog of
    // War king capture needed the mover's own (off-turn) visibility recomputed afterward.
    return new Chess(fields.join(' '), { skipValidation: true });
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

function toAppliedMove(pretty: ChessJsMove): AppliedMove {
  return {
    from: pretty.from,
    to: pretty.to,
    promotion: pretty.promotion as AppliedMove['promotion'],
    san: pretty.san,
    captured: pretty.captured as AppliedMove['captured'],
  };
}

/** Mirrors chess.js's own internal (unexported) `algebraic()` — see the mobile app's identical
 * ChessEngine.squareFromIndex for the full rationale. */
function squareFromIndex(index: number): string {
  const file = index & 0xf;
  const rank = index >> 4;
  return `${FILES[file]}${'87654321'[rank]}`;
}

/** See the mobile app's identical ChessEngine.toAppMoveFromRaw — avoids constructing a full
 * chess.js Move (which eagerly computes `.san` via a complete `_moves({legal:true})` regeneration
 * plus two `.fen()` calls) for every pseudo-legal candidate, when getPseudoLegalMoves' only
 * caller here (visibility computation) ever reads is `.to`. `san` is a placeholder, never read —
 * grep getPseudoLegalMoves before changing that. */
function toAppliedMoveFromRaw(raw: InternalMove): AppliedMove {
  return {
    from: squareFromIndex(raw.from),
    to: squareFromIndex(raw.to),
    promotion: raw.promotion as AppliedMove['promotion'],
    san: '',
    captured: raw.captured as AppliedMove['captured'],
  };
}

function fileRange(a: number, b: number): number[] {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const out: number[] = [];
  for (let f = lo; f <= hi; f++) out.push(f);
  return out;
}
