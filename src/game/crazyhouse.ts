// Server-side twin of the mobile app's src/logic/crazyhouse.ts -- Crazyhouse. See that file's header for the full rules
// (confirmed against chess.com's own documentation) and for how promoted pieces are tracked: a captured piece changes
// colour into the capturer's reserve; a turn is ONE action, an ordinary move or a drop on any empty square (pawns never on
// rank 1/8); a captured PROMOTED piece goes to the reserve as a pawn; drops may give check or mate; notation "N@f3".
//
// What the server needs on top of chess.js (which stays authoritative for every ordinary move): the reserve + promoted-
// squares state (CrazyhouseState, carried BESIDE the FEN like Duck Chess's duck -- see RoomChessEngine's `crazyhouse`
// option and RoomManager), the legal drop squares, and drops applied as moves. Because a drop can never expose the mover's
// own king, drop legality is pure geometry (crazyhouseCheckInfo / legalDropSquares) -- no search.
//
// The rules block below (between the "Shared rules block" markers) is a VERBATIM copy of the mobile file's -- this
// project's backend and mobile app are separate npm projects with no shared module, so hand-mirroring is the
// convention -- and scripts/test-crazyhouse.mjs fails if the two copies ever differ. Edit BOTH files together.

import type { PieceColor } from './RoomChessEngine.js';

// --- Shared rules block (mirrored VERBATIM in backend/src/game/crazyhouse.ts; scripts/test-crazyhouse.mjs fails if the
// two copies differ -- edit both together) ------------------------------------------------------------------------

export type ReservePieceType = 'p' | 'n' | 'b' | 'r' | 'q';
export const RESERVE_PIECE_TYPES: ReservePieceType[] = ['p', 'n', 'b', 'r', 'q'];

export type Reserve = Record<ReservePieceType, number>;

export interface CrazyhouseState {
  reserve: { w: Reserve; b: Reserve };
  /** Squares currently holding a promoted piece (never a pawn or king) — see the header comment. */
  promoted: string[];
}

export interface CrazyhouseDrop {
  piece: ReservePieceType;
  square: string;
}

const CZ_FILES = 'abcdefgh';
const czFile = (square: string) => square.charCodeAt(0) - 97;
const czRank = (square: string) => Number(square[1]) - 1;
const czInBounds = (file: number, rank: number) => file >= 0 && file <= 7 && rank >= 0 && rank <= 7;
const czName = (file: number, rank: number) => `${CZ_FILES[file]}${rank + 1}`;
const czOther = (color: PieceColor): PieceColor => (color === 'w' ? 'b' : 'w');

export function emptyReserve(): Reserve {
  return { p: 0, n: 0, b: 0, r: 0, q: 0 };
}

export function initialCrazyhouseState(): CrazyhouseState {
  return { reserve: { w: emptyReserve(), b: emptyReserve() }, promoted: [] };
}

export function cloneCrazyhouseState(state: CrazyhouseState): CrazyhouseState {
  return { reserve: { w: { ...state.reserve.w }, b: { ...state.reserve.b } }, promoted: [...state.promoted] };
}

export function reserveTotal(reserve: Reserve): number {
  return reserve.p + reserve.n + reserve.b + reserve.r + reserve.q;
}

/** A square on the board, as the helpers below see it — just enough to find checks without a chess engine. */
export type CrazyhousePieceAt = (square: string) => { type: string; color: PieceColor } | null | undefined;

const KNIGHT_STEPS: [number, number][] = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const ORTHOGONAL_STEPS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAGONAL_STEPS: [number, number][] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

/** Who is giving `color`'s king check on `kingSquare`: how many pieces, and — for exactly one SLIDING checker — the empty
 * squares between it and the king (where a drop could block). Knights, pawns and an adjacent king cannot be blocked. */
export function crazyhouseCheckInfo(kingSquare: string, color: PieceColor, pieceAt: CrazyhousePieceAt): { checkers: number; blockSquares: string[] } {
  const enemy = czOther(color);
  const kf = czFile(kingSquare);
  const kr = czRank(kingSquare);
  let checkers = 0;
  let blockSquares: string[] = [];
  const scan = (steps: [number, number][], sliders: string[]) => {
    for (const [df, dr] of steps) {
      const between: string[] = [];
      let f = kf + df;
      let r = kr + dr;
      while (czInBounds(f, r)) {
        const sq = czName(f, r);
        const piece = pieceAt(sq);
        if (piece) {
          if (piece.color === enemy && sliders.includes(piece.type)) {
            checkers++;
            blockSquares = between;
          }
          break;
        }
        between.push(sq);
        f += df;
        r += dr;
      }
    }
  };
  scan(ORTHOGONAL_STEPS, ['r', 'q']);
  scan(DIAGONAL_STEPS, ['b', 'q']);
  for (const [df, dr] of KNIGHT_STEPS) {
    const f = kf + df;
    const r = kr + dr;
    if (!czInBounds(f, r)) continue;
    const piece = pieceAt(czName(f, r));
    if (piece && piece.color === enemy && piece.type === 'n') {
      checkers++;
      blockSquares = [];
    }
  }
  // Pawns attack toward the king from the side they advance from: Black pawns sit one rank ABOVE a White king.
  const pawnRank = color === 'w' ? kr + 1 : kr - 1;
  for (const df of [-1, 1]) {
    const f = kf + df;
    if (!czInBounds(f, pawnRank)) continue;
    const piece = pieceAt(czName(f, pawnRank));
    if (piece && piece.color === enemy && piece.type === 'p') {
      checkers++;
      blockSquares = [];
    }
  }
  // A king can never give check, and the one non-slider/slider mix above is covered by the count.
  return { checkers, blockSquares: checkers === 1 ? blockSquares : [] };
}

/** Every square `color` may drop a `piece` on: empty; not the 1st/8th rank for a pawn; and — if `color`'s king is in
 * check — only a square that blocks a single sliding check. Returns [] when the reserve has none of that piece. */
export function legalDropSquares(state: CrazyhouseState, color: PieceColor, piece: ReservePieceType, pieceAt: CrazyhousePieceAt): string[] {
  if (!(state.reserve[color][piece] > 0)) return []; // also refuses a piece type the reserve has no slot for ("k", junk)
  let kingSquare: string | null = null;
  const empties: string[] = [];
  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const sq = czName(file, rank);
      const occupant = pieceAt(sq);
      if (!occupant) {
        if (piece === 'p' && (rank === 0 || rank === 7)) continue;
        empties.push(sq);
      } else if (occupant.type === 'k' && occupant.color === color) {
        kingSquare = sq;
      }
    }
  }
  if (!kingSquare) return empties;
  const { checkers, blockSquares } = crazyhouseCheckInfo(kingSquare, color, pieceAt);
  if (checkers === 0) return empties;
  const blocking = new Set(blockSquares);
  // EQUIVALENT-MUTANT NOTE (Crazyhouse mutation set, "a drop may answer a double check"): crazyhouseCheckInfo already returns an EMPTY blockSquares list unless exactly
  // one piece gives check, so `empties.filter((sq) => blocking.has(sq))` is [] for a double check too; the explicit `checkers === 1 ?` only spells the rule out.
  return checkers === 1 ? empties.filter((sq) => blocking.has(sq)) : [];
}

/** Every legal drop for `color` (each reserve type × each legal square). */
export function legalDrops(state: CrazyhouseState, color: PieceColor, pieceAt: CrazyhousePieceAt): CrazyhouseDrop[] {
  const drops: CrazyhouseDrop[] = [];
  for (const piece of RESERVE_PIECE_TYPES) {
    for (const square of legalDropSquares(state, color, piece, pieceAt)) drops.push({ piece, square });
  }
  return drops;
}

/** What one ordinary move did, as far as the reserve and the promoted set care. */
export interface CrazyhouseMoveInfo {
  from: string;
  to: string;
  /** Set when a pawn promoted on this move. */
  promotion?: string;
  /** The type of the piece captured (a promoted piece reports its board type, e.g. 'q'). */
  captured?: string;
  /** True for an en passant capture: the captured pawn stands beside `from`, not on `to`. */
  enPassant?: boolean;
  /** Castling: the rook's own move. */
  castleRook?: { from: string; to: string };
}

/** The state after `mover` plays an ordinary move — see the header comment's five rules. Returns a new object. */
export function applyCrazyhouseMove(state: CrazyhouseState, mover: PieceColor, move: CrazyhouseMoveInfo): CrazyhouseState {
  const next = cloneCrazyhouseState(state);
  let promoted = new Set(next.promoted);
  const wasPromoted = promoted.has(move.from);
  promoted.delete(move.from);

  if (move.captured) {
    // EQUIVALENT-MUTANT NOTE (Crazyhouse mutation set, "an en passant capture is banked from the wrong square"): the pawn taken en passant is never a promoted piece (the
    // promoted marks sit on queens / rooks / bishops / knights), so neither its square nor the (empty) target square is ever in `promoted`: the mark lookup and the
    // delete below cannot tell the two squares apart in any reachable state. The correct square is kept because it is the one that is true.
    const capturedSquare = move.enPassant ? `${move.to[0]}${move.from[1]}` : move.to;
    // A captured promoted piece goes into the reserve as a PAWN.
    const type = (promoted.has(capturedSquare) ? 'p' : move.captured) as ReservePieceType;
    promoted.delete(capturedSquare);
    if (RESERVE_PIECE_TYPES.includes(type)) next.reserve[mover][type]++;
  }

  if (move.promotion || wasPromoted) promoted.add(move.to);

  if (move.castleRook && promoted.has(move.castleRook.from)) {
    promoted.delete(move.castleRook.from);
    promoted.add(move.castleRook.to);
  }
  next.promoted = [...promoted].sort();
  return next;
}

/** The state after `color` drops a `piece` — one fewer in the reserve; a dropped piece is never promoted. */
export function applyCrazyhouseDrop(state: CrazyhouseState, color: PieceColor, piece: ReservePieceType): CrazyhouseState {
  const next = cloneCrazyhouseState(state);
  if (next.reserve[color][piece] > 0) next.reserve[color][piece]--;
  next.promoted = [...next.promoted].sort();
  return next;
}

/** "N@f3" (pawn: "@f3"... written "P@f3" like the other piece letters, so a drop is never mistaken for a move). */
export function crazyhouseDropSan(piece: ReservePieceType, square: string, suffix: '' | '+' | '#' = ''): string {
  return `${piece.toUpperCase()}@${square}${suffix}`;
}

// Bughouse additions (BUGHOUSE_SPEC.md W0). Pure additions: nothing above changes behaviour, and 2-player Crazyhouse never calls them. In Bughouse a capture is banked by the
// capturer's PARTNER on the OTHER board, and a "mate" is only a mate when no dropped piece could ever answer it.

/** The piece type a capture would put in a reserve - a captured PROMOTED piece banks a PAWN, a king or an unknown type banks nothing, a move that captures nothing is null. It is
 * the rule applyCrazyhouseMove applies to the capturer's own reserve, asked on its own so that a caller can bank the piece somewhere else. */
export function crazyhouseBankedPiece(state: CrazyhouseState, move: CrazyhouseMoveInfo): ReservePieceType | null {
  if (!move.captured) return null;
  const capturedSquare = move.enPassant ? `${move.to[0]}${move.from[1]}` : move.to;
  const type = (state.promoted.includes(capturedSquare) ? 'p' : move.captured) as ReservePieceType;
  return RESERVE_PIECE_TYPES.includes(type) ? type : null;
}

/** `state` plus one `piece` in `color`'s reserve (a new object; the promoted marks are copied). A type the reserve has no slot for changes nothing. */
export function creditCrazyhouseReserve(state: CrazyhouseState, color: PieceColor, piece: ReservePieceType): CrazyhouseState {
  const next = cloneCrazyhouseState(state);
  if (RESERVE_PIECE_TYPES.includes(piece)) next.reserve[color][piece]++;
  return next;
}

/** What one ordinary move did on a Bughouse board: this board's state after it (the promoted marks move exactly as in applyCrazyhouseMove, but the MOVER's reserve is left as
 * it was - the capturer's partner banks it) and the piece the partner's reserve on the other board gains (null when nothing was captured). */
export interface CrazyhousePartnerMove {
  state: CrazyhouseState;
  banked: ReservePieceType | null;
}

export function applyCrazyhouseMoveForPartner(state: CrazyhouseState, mover: PieceColor, move: CrazyhouseMoveInfo): CrazyhousePartnerMove {
  const banked = crazyhouseBankedPiece(state, move);
  const next = applyCrazyhouseMove(state, mover, move);
  next.reserve[mover] = { ...state.reserve[mover] };
  return { state: next, banked };
}

/** Could SOME dropped piece ever answer the check on `color`'s king, whatever the reserve holds now? True exactly when ONE sliding piece gives the check and at least one empty
 * square lies between it and the king (a knight or pawn check, a double check and an adjacent slider can never be blocked; not being in check is false). Of the pieces a drop
 * can use, only a pawn is limited (never rank 1 or 8); any other piece blocks on any of the squares. This is the question behind Bughouse's "stuck" (BUGHOUSE_SPEC.md rule 18). */
export function crazyhouseDropCouldAnswerCheck(kingSquare: string, color: PieceColor, pieceAt: CrazyhousePieceAt): boolean {
  return crazyhouseCheckInfo(kingSquare, color, pieceAt).blockSquares.length > 0;
}

// --- End of the shared rules block --------------------------------------------------------------------------------
