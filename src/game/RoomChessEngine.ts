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
import { isCastleBlockedByDuck, isMoveBlockedByDuck } from './duckChess.js';
import { HORDE_FIRST_RANK_DOUBLE_STEP_ALLOWS_EN_PASSANT, getHordeWinnerFromFen, hordeFirstRankDoubleStep } from './horde.js';
import { castlingRookOrigin, getJumpAugmentedCaptures } from './spellChess.js';
import {
  applyCrazyhouseDrop,
  applyCrazyhouseMove,
  cloneCrazyhouseState,
  crazyhouseDropSan,
  initialCrazyhouseState,
  legalDropSquares,
  legalDrops,
  type CrazyhouseDrop,
  type CrazyhouseState,
  type ReservePieceType,
} from './crazyhouse.js';

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
  /** Duck Chess only — the square the duck was placed on as the second half of this turn. Absent for every other
   * mode, and for the move that captures a king (the game ends with no placement). */
  duck?: string;
  /** Spell Chess only — the spell (if any) cast immediately before this move — see spellChess.ts's SpellCast.
   * Absent for every other mode, and for a turn nothing was cast on. */
  spell?: { type: 'freeze'; center: string; squares: string[] } | { type: 'jump'; square: string };
  /** Crazyhouse only -- set when this turn was a DROP of that reserve piece (from === to === the square). */
  drop?: ReservePieceType;
  /** Crazyhouse only -- the reserves and promoted squares AFTER this ply (a copy; see crazyhouse.ts). */
  crazyhouse?: CrazyhouseState;
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
  /**
   * Duck Chess only — the server-side twin of the mobile app's identical ChessEngine option (see
   * src/logic/duckChess.ts there, mirrored in ./duckChess.ts). Moves come from the pseudo-legal generator (no
   * check concept) with the duck in the way: generateRaw drops every candidate that lands on the duck, slides or
   * double-steps over it, or castles across it, and adds back the castles chess.js withholds for attack reasons
   * (there is no check). `duckSquare` is where the duck stands now; the room keeps it up to date with
   * setDuckSquare. SAN carries no '+'/'#'. Implies skipValidation (positions may lack a king).
   */
  duckChess?: boolean;
  duckSquare?: string | null;
  /**
   * Spell Chess only — the server-side twin of the mobile app's identical ChessEngine option (see
   * src/logic/spellChess.ts there, mirrored in ./spellChess.ts). Unlike Giveaway/Atomic/Duck Chess,
   * checkmate/stalemate/check/draw all still apply exactly as normal — these options only ever affect
   * move() via the two special cases spellChess.ts documents (a Jump-augmented capture, or a move played
   * while escaping check through a just-cast Freeze). `frozenSquares`/`jumpSquare` mirror the room's
   * current SpellChessState (via frozenSquaresFor/activeJumpSquare); `freezeEscapeActive` is computed by
   * the caller once per move attempt (see checkIsWaivedByFreeze) since it depends on the mover's own
   * color, not just the state.
   */
  spellChess?: boolean;
  frozenSquares?: string[];
  jumpSquare?: string | null;
  freezeEscapeActive?: boolean;
  /**
   * Horde only -- the server-side twin of the mobile app's identical ChessEngine option (see src/logic/horde.ts there,
   * mirrored in ./horde.ts). chess.js's own legality stays authoritative (it tolerates a missing White king when loaded
   * with skipValidation -- implied by this option -- and applies no king-safety filter to a side that has none), plus
   * ONE synthesized move: the rank-1 double step (rank 1 -> 3), applied through chess.js's unvalidated _makeMove.
   * getStatus()/isGameOver() are overridden because chess.js gets two Horde cases wrong: it calls "Black king + one
   * White bishop" insufficient material (a draw), and a White side with nothing left "stalemate" (that is Black's WIN,
   * which RoomManager checks first via getHordeWinnerFromFen). Not combinable with any other variant.
   */
  horde?: boolean;
  /**
   * Crazyhouse only -- the server-side twin of the mobile app's identical ChessEngine option (see src/logic/crazyhouse.ts there,
   * mirrored in ./crazyhouse.ts). chess.js stays authoritative for every ordinary move; this adds drop() and keeps the reserve
   * and the promoted-piece set (`crazyhouseState`, passed in because it is NOT part of the FEN, like duckSquare) up to date on
   * every move()/drop() -- read it back with getCrazyhouseState(). getStatus()/isGameOver() are overridden: a side is only
   * checkmated/stalemated if it also has no legal drop, and chess.js's insufficient-material draw is never used. Not combinable
   * with any other variant.
   */
  crazyhouse?: boolean;
  crazyhouseState?: CrazyhouseState | null;
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
  private duckChess: boolean;
  private duckSquare: string | null;
  private spellChess: boolean;
  private horde: boolean;
  private crazyhouse: boolean;
  private crazyhouseState: CrazyhouseState;
  private frozenSquares: string[];
  private jumpSquare: string | null;
  private freezeEscapeActive: boolean;
  /** Atomic only: the position's FEN as produced by atomic.ts (the source of truth in that mode). */
  private atomicCurrentFen: string;
  private atomicPosCache: AtomicPosition | null = null;
  private atomicLegalCache: AtomicMove[] | null = null;

  constructor(fen?: string, options?: RoomChessEngineOptions) {
    this.giveaway = options?.giveaway ?? false;
    this.atomic = options?.atomic ?? false;
    this.duckChess = options?.duckChess ?? false;
    this.duckSquare = options?.duckChess ? (options.duckSquare ?? null) : null;
    this.spellChess = options?.spellChess ?? false;
    this.horde = options?.horde ?? false;
    this.crazyhouse = options?.crazyhouse ?? false;
    this.crazyhouseState = cloneCrazyhouseState(options?.crazyhouse ? (options.crazyhouseState ?? initialCrazyhouseState()) : initialCrazyhouseState());
    this.frozenSquares = options?.spellChess ? (options.frozenSquares ?? []) : [];
    this.jumpSquare = options?.spellChess ? (options.jumpSquare ?? null) : null;
    this.freezeEscapeActive = options?.spellChess ? (options.freezeEscapeActive ?? false) : false;
    this.chess = fen ? (this.giveaway ? loadGiveawayFen(fen) : new Chess(fen, { skipValidation: this.atomic || this.duckChess || this.spellChess || this.horde })) : new Chess();
    this.atomicCurrentFen = fen ?? START_FEN;
    this.chess960 = options?.chess960 ?? false;
    this.files = getChess960BackRankFiles(options?.initialFen ?? fen ?? START_FEN);
  }

  getTurn(): PieceColor {
    return this.chess.turn();
  }

  move(from: string, to: string, promotion?: 'n' | 'b' | 'r' | 'q'): AppliedMove | null {
    if (this.atomic) return this.moveAtomic(from, to, promotion);
    if (this.spellChess) return this.moveSpellChess(from, to, promotion);
    if (this.horde && this.hordeDoubleStepTarget(from) === to) return this.applyHordeDoubleStep(from, to);
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
      const played: AppliedMove = { from: result.from, to: result.to, promotion: actualPromotion, san: result.san };
      if (!this.crazyhouse) return played;
      // Crazyhouse: bank the capture (a promoted piece becomes a pawn) and carry the promoted status along -- see crazyhouse.ts.
      const rank = result.color === 'w' ? '1' : '8';
      this.crazyhouseState = applyCrazyhouseMove(this.crazyhouseState, result.color, {
        from: result.from,
        to: result.to,
        promotion: actualPromotion,
        captured: result.captured,
        enPassant: result.flags.includes('e'),
        castleRook: result.flags.includes('k') ? { from: `h${rank}`, to: `f${rank}` } : result.flags.includes('q') ? { from: `a${rank}`, to: `d${rank}` } : undefined,
      });
      return { ...played, crazyhouse: cloneCrazyhouseState(this.crazyhouseState) };
    } catch {
      return null;
    }
  }

  getStatus(): GameStatus {
    if (this.atomic) return getAtomicStatus(this.getAtomicPosition(), this.getAtomicLegal());
    if (this.crazyhouse) {
      // A side is only mated/stalemated if it ALSO has no legal drop (a drop can interpose or simply be played), and chess.js's
      // isDraw() is never consulted: it calls king-versus-king a draw, but a reserve can still be dropped. The fifty-move rule
      // stays (a drop resets the halfmove clock, see drop()).
      const inCheck = this.chess.isCheck();
      if (this.chess.moves().length === 0 && !this.hasLegalDrop()) return inCheck ? 'checkmate' : 'stalemate';
      if (this.chess.isDrawByFiftyMoves()) return 'draw';
      return inCheck ? 'check' : 'playing';
    }
    if (this.horde) {
      // Never chess.js's isDraw(): its insufficient-material rule misreads Horde (see RoomChessEngineOptions.horde). The
      // fifty-move rule is the only automatic draw besides stalemate; "White has nothing left" is RoomManager's win check.
      if (this.chess.isCheckmate()) return 'checkmate';
      if (this.chess.isStalemate()) return 'stalemate';
      if (this.chess.isDrawByFiftyMoves()) return 'draw';
      if (this.chess.isCheck()) return 'check';
      return 'playing';
    }
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
    if (this.crazyhouse) {
      const status = this.getStatus();
      return status === 'checkmate' || status === 'stalemate' || status === 'draw';
    }
    if (this.horde) {
      if (getHordeWinnerFromFen(this.getFen())) return true;
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

  // --- Crazyhouse (see crazyhouse.ts) -------------------------------------

  /** The reserves and promoted squares after everything this engine has played (a copy). Always the initial empty state
   * outside Crazyhouse. */
  getCrazyhouseState(): CrazyhouseState {
    return cloneCrazyhouseState(this.crazyhouseState);
  }

  /** Where the side to move may drop a `piece` right now (empty outside Crazyhouse, and when the reserve has none). */
  getLegalDropSquares(piece: ReservePieceType): string[] {
    if (!this.crazyhouse) return [];
    return legalDropSquares(this.crazyhouseState, this.chess.turn(), piece, (sq) => this.getPieceAt(sq));
  }

  /** Every legal drop for the side to move. */
  getLegalDrops(): CrazyhouseDrop[] {
    if (!this.crazyhouse) return [];
    return legalDrops(this.crazyhouseState, this.chess.turn(), (sq) => this.getPieceAt(sq));
  }

  /** Whether the side to move has any legal drop (stops at the first). */
  private hasLegalDrop(): boolean {
    const turn = this.chess.turn();
    for (const piece of ['q', 'r', 'b', 'n', 'p'] as ReservePieceType[]) {
      if (legalDropSquares(this.crazyhouseState, turn, piece, (sq) => this.getPieceAt(sq)).length > 0) return true;
    }
    return false;
  }

  /** Plays a drop for the side to move: the piece goes on `square`, the turn passes, the en passant square is cleared (a drop is
   * never "a pawn that just double-stepped"), the halfmove clock resets and the fullmove number advances after Black. Castling
   * rights are FLAGS in the FEN that chess.js keeps, so a rook dropped back on h1 does not restore a lost right. Returns the
   * turn ("N@f3", from === to === the square, with the new state in `crazyhouse`), or null when the drop is not legal. */
  drop(piece: ReservePieceType, square: string): AppliedMove | null {
    if (!this.crazyhouse) return null;
    const turn = this.chess.turn();
    if (!this.getLegalDropSquares(piece).includes(square)) return null;
    if (!this.chess.put({ type: piece, color: turn }, square as ChessJsSquare)) return null;
    const fields = this.chess.fen().split(' ');
    fields[1] = turn === 'w' ? 'b' : 'w';
    fields[3] = '-';
    fields[4] = '0';
    if (turn === 'b') fields[5] = String(Number(fields[5]) + 1);
    this.chess.load(fields.join(' '));
    this.crazyhouseState = applyCrazyhouseDrop(this.crazyhouseState, turn, piece);
    const status = this.getStatus();
    return {
      from: square,
      to: square,
      san: crazyhouseDropSan(piece, square, status === 'checkmate' ? '#' : status === 'check' ? '+' : ''),
      drop: piece,
      crazyhouse: cloneCrazyhouseState(this.crazyhouseState),
    };
  }

  // --- Duck Chess (see duckChess.ts) --------------------------------------

  /** Where the duck stands now (null before White's first move, and always null outside Duck Chess). */
  getDuckSquare(): string | null {
    return this.duckSquare;
  }

  /** Moves the duck — called by the room once a turn's second half (the placement) has been validated. */
  setDuckSquare(square: string | null): void {
    this.duckSquare = this.duckChess ? square : null;
  }

  /** The piece on `square`, or null if empty — the server-side twin of the mobile app's identical
   * ChessEngine.getPieceAt, needed by spellChess.ts's getJumpAugmentedCaptures/getCheckingPieceSquares. */
  getPieceAt(square: string): { type: 'p' | 'n' | 'b' | 'r' | 'q' | 'k'; color: PieceColor } | null {
    const piece = this.chess.get(square as ChessJsSquare);
    return piece ? { type: piece.type, color: piece.color } : null;
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
    // Duck Chess has no check either, so no '+'/'#' (and its games end at a king capture, so no rebuild is needed).
    if (this.duckChess) return { ...applied, san: applied.san.replace(/[+#]$/, '') };
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

  // --- Horde (see horde.ts) ----------------------------------------------

  /** Where the White pawn on `square` may go with the Horde-only rank-1 double step, or null -- the server-side twin of the
   * mobile app's identical ChessEngine.hordeDoubleStepTarget. Also null unless it is White's turn and the pawn really stands there. */
  private hordeDoubleStepTarget(square: string): string | null {
    const piece = this.chess.get(square as ChessJsSquare);
    if (!piece || piece.type !== 'p' || piece.color !== 'w' || this.chess.turn() !== 'w') return null;
    return hordeFirstRankDoubleStep(square, (sq) => this.chess.get(sq as ChessJsSquare) !== undefined);
  }

  /** Plays the rank-1 double step chess.js cannot generate: a hand-built move with chess.js's BIG_PAWN flag (4) through the
   * unvalidated _makeMove, so the en passant square is set like any double step (HORDE_FIRST_RANK_DOUBLE_STEP_ALLOWS_EN_PASSANT
   * picks the flag). White has no king to leave in check and the squares were checked empty, so no legality filter is needed. */
  private applyHordeDoubleStep(from: string, to: string): AppliedMove | null {
    const raw: InternalMove = { color: 'w', from: indexFromSquare(from), to: indexFromSquare(to), piece: 'p', flags: HORDE_FIRST_RANK_DOUBLE_STEP_ALLOWS_EN_PASSANT ? 4 /* BIG_PAWN: sets the en passant square */ : 1 /* NORMAL: no en passant */ };
    const internals = this.chess as unknown as ChessInternals;
    const pretty = new ChessJsMove(this.chess, raw);
    internals._makeMove(raw);
    return toAppliedMove(pretty);
  }

  // --- Spell Chess (see spellChess.ts) -----------------------------------

  /** True when from->to is a castling move whose ROOK sits in a frozen square — the server-side twin of the mobile
   * app's identical ChessEngine.castlesWithFrozenRook (castling moves the rook as well as the king). */
  private castlesWithFrozenRook(from: string, to: string): boolean {
    if (this.frozenSquares.length === 0) return false;
    const piece = this.getPieceAt(from);
    const rook = piece ? castlingRookOrigin(from, to, piece.type) : null;
    return rook !== null && this.frozenSquares.includes(rook);
  }

  /** Applies a Spell Chess move — the server-side twin of the mobile app's identical
   * ChessEngine.moveSpellChess (see that file for the full rationale): a frozen origin is always
   * rejected; a Jump-augmented capture (if one matches `from`/`to` exactly) is force-applied via
   * applyRawSpellMove since it is never among chess.js's own pseudo-legal candidates; while
   * freezeEscapeActive, falls back to movePseudoLegal (no check filtering at all); otherwise this is
   * just an ordinary chess.js move — checkmate/stalemate/check/draw all still apply exactly as
   * normal. See RoomChessEngineOptions.spellChess. */
  private moveSpellChess(from: string, to: string, promotion?: 'n' | 'b' | 'r' | 'q'): AppliedMove | null {
    if (this.frozenSquares.includes(from)) return null;
    if (this.castlesWithFrozenRook(from, to)) return null;

    if (this.jumpSquare) {
      const match = getJumpAugmentedCaptures(this, this.jumpSquare, this.chess.turn()).find((m) => m.from === from && m.to === to);
      if (match) return this.applyRawSpellMove(from, to, match.captured);
    }

    if (this.freezeEscapeActive) return this.movePseudoLegal(from, to, promotion);

    try {
      const result = this.chess.move({ from, to, promotion });
      if (!result) return null;
      const actualPromotion = result.promotion as 'n' | 'b' | 'r' | 'q' | undefined;
      return { from: result.from, to: result.to, promotion: actualPromotion, san: result.san, captured: result.captured as AppliedMove['captured'] };
    } catch {
      return null;
    }
  }

  /** Force-applies a Jump-augmented capture straight through chess.js's unvalidated `_makeMove` (see
   * ChessInternals) — the server-side twin of the mobile app's identical ChessEngine.applyRawSpellMove;
   * see that file's own doc comment for the full rationale. Nothing but `to` is touched, so the
   * jumped-over piece is correctly left exactly where it stood — it was bypassed, not captured. */
  private applyRawSpellMove(from: string, to: string, captured: AppliedMove['captured']): AppliedMove | null {
    const piece = this.chess.get(from as ChessJsSquare);
    if (!piece) return null;
    const raw: InternalMove = {
      color: piece.color,
      from: indexFromSquare(from),
      to: indexFromSquare(to),
      piece: piece.type,
      captured,
      flags: captured ? 2 /* chess.js's CAPTURE flag */ : 1 /* chess.js's NORMAL flag */,
    };
    const internals = this.chess as unknown as ChessInternals;
    const pretty = new ChessJsMove(this.chess, raw);
    internals._makeMove(raw);
    return { ...toAppliedMove(pretty), captured };
  }

  /** chess.js's raw pseudo-legal candidates for `source`'s side to move, adjusted for Giveaway when
   * that option is on — the same adjustment as the mobile app's ChessEngine.generateRaw (castling
   * dropped; each queen promotion also offered as a king promotion). */
  private generateRaw(source: Chess): InternalMove[] {
    const raw = (source as unknown as ChessInternals)._moves({ legal: false });
    if (this.duckChess) {
      const duck = this.duckSquare;
      const kept = duck
        ? raw.filter((m) =>
            m.flags & CASTLE_FLAGS
              ? !isCastleBlockedByDuck(squareFromIndex(m.from), squareFromIndex(m.to), duck)
              : !isMoveBlockedByDuck(m.piece, squareFromIndex(m.from), squareFromIndex(m.to), duck)
          )
        : raw.slice();

      // There is no check in Duck Chess, so castling has no attack-based restrictions either (out of, through
      // or into "check"). chess.js's generator withholds O-O/O-O-O when the king's squares are attacked, so add
      // back every castle whose right remains and whose squares are merely empty (and not blocked by the duck).
      const color = source.turn();
      const rank = color === 'w' ? '1' : '8';
      const king = source.get(`e${rank}` as ChessJsSquare);
      if (king && king.type === 'k' && king.color === color) {
        const rights = source.getCastlingRights(color);
        for (const side of ['k', 'q'] as const) {
          if (!rights[side]) continue;
          const rook = source.get((side === 'k' ? `h${rank}` : `a${rank}`) as ChessJsSquare);
          if (!rook || rook.type !== 'r' || rook.color !== color) continue;
          const between = side === 'k' ? ['f', 'g'] : ['b', 'c', 'd'];
          if (between.some((file) => source.get(`${file}${rank}` as ChessJsSquare))) continue;
          const to = side === 'k' ? `g${rank}` : `c${rank}`;
          if (kept.some((m) => m.flags & CASTLE_FLAGS && m.to === indexFromSquare(to))) continue; // chess.js already offered it
          if (duck && isCastleBlockedByDuck(`e${rank}`, to, duck)) continue;
          kept.push({ color, from: indexFromSquare(`e${rank}`), to: indexFromSquare(to), piece: 'k', flags: side === 'k' ? 32 : 64 });
        }
      }
      return kept;
    }
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
