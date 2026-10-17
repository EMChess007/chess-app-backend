// Server-side twin of the mobile app's src/logic/horde.ts -- Horde chess. See that file's header for the full rules
// (confirmed against chess.com's own documentation): White has 36 pawns and NO king, Black has the normal army; White
// wins by checkmating Black's king, Black by capturing every White piece; stalemate is a draw; en passant works normally;
// White pawns on the first AND second ranks may move two squares (positional, not a first-move flag).
//
// How little the server needs: chess.js (loaded with skipValidation, as RoomChessEngine does for Horde) already
// tolerates a missing White king and generates Black's legal moves, checkmate and stalemate correctly. The ONLY move it
// cannot generate is the rank-1 double step, synthesized in RoomChessEngine (see its `horde` option), and the only
// results it gets wrong are insufficient material and "White has nothing left" (it reports stalemate) -- both overridden
// there and in RoomManager.applyMove, which checks getHordeWinnerFromFen BEFORE asking the engine whether the game is over.
//
// The rules block below (between the "Shared rules block" markers) is a VERBATIM copy of the mobile file's -- this
// project's backend and mobile app are separate npm projects with no shared module, so hand-mirroring is the
// convention -- and scripts/test-horde.mjs fails if the two copies ever differ. Edit BOTH files together.

import type { PieceColor } from './RoomChessEngine.js';

// --- Shared rules block (mirrored VERBATIM in backend/src/game/horde.ts; scripts/test-horde.mjs fails if the two
// copies differ -- edit both together) ------------------------------------------------------------------------------

/** The standard Horde start position (the layout Lichess and chess.com both use): 36 White pawns — ranks 1-4 full, plus
 * b5, c5, f5, g5 — against Black's normal army. "kq": Black keeps its castling rights; White has no king to castle. */
export const HORDE_START_FEN = 'rnbqkbnr/pppppppp/8/1PP2PP1/PPPPPPPP/PPPPPPPP/PPPPPPPP/PPPPPPPP w kq - 0 1';
export const HORDE_START_PAWN_COUNT = 36;

/** Whether a pawn that has just double-stepped from RANK 1 (rank 1 -> 3) may be captured en passant by a Black pawn
 * beside it. chess.com's documentation says only "en passant captures are allowed" and does not single this case out,
 * so it is treated like any other double step (true). Lichess's rules (and the chessops library the tests use as an
 * oracle) say NO for this one case — flip this constant, in BOTH copies of this block, to follow them; the tests pin
 * exactly this divergence, so they will tell you what else to update. */
export const HORDE_FIRST_RANK_DOUBLE_STEP_ALLOWS_EN_PASSANT = true;

/** The square a White pawn standing on `from` may reach with the Horde-only RANK-1 double step (rank 1 -> rank 3), or null.
 * Needs the next two squares on its file empty. Rank 2 -> rank 4 is NOT handled here: chess.js already generates it. */
export function hordeFirstRankDoubleStep(from: string, isOccupied: (square: string) => boolean): string | null {
  if (from.length !== 2 || from[1] !== '1') return null;
  const file = from[0];
  return isOccupied(`${file}2`) || isOccupied(`${file}3`) ? null : `${file}3`;
}

/** How many White pieces (pawns and anything promoted) the FEN's piece-placement field still has. */
export function hordeWhitePieceCount(fen: string): number {
  const placement = fen.split(' ')[0];
  let count = 0;
  for (let i = 0; i < placement.length; i++) {
    const ch = placement[i];
    if (ch >= 'A' && ch <= 'Z') count++;
  }
  return count;
}

/** Black's win condition: 'b' once White has no pieces left, else null. (Checkmate — White's win — is chess.js's own
 * checkmate detection, so it is not repeated here.) Must be checked BEFORE the stalemate status: a White side with
 * nothing left has no legal move and no king in check, which chess.js calls stalemate. */
export function getHordeWinnerFromFen(fen: string): PieceColor | null {
  return hordeWhitePieceCount(fen) === 0 ? 'b' : null;
}

// --- End of the shared rules block --------------------------------------------------------------------------------
