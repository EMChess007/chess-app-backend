// Server-side twin of the mobile app's src/logic/torpedo.ts -- Torpedo chess. See that file's header for the full rules and
// the sources that agree on them (chess.com support article and terms page, the PyChess variant page, Mats Winther's
// AlphaZero-variants page, ChessBase "AlphaZero/Kramnik: Torpedo pawns"): a pawn may ALWAYS move one or two squares forward,
// from any rank; en passant works after every double step; everything else (check, mate, stalemate, castling, promotion,
// repetition, fifty-move rule, insufficient material) is standard chess.
//
// How little the server needs: chess.js (loaded with skipValidation, as RoomChessEngine does for Torpedo: its FEN loader
// refuses an en passant square on rank 4/5) generates every ordinary move and the HOME-rank double step. The only moves
// it cannot generate are the double steps from the other ranks, synthesized in RoomChessEngine (see its `torpedo` option), which
// also looks for such a step before calling a position checkmate or stalemate.
//
// The rules block below (between the "Shared rules block" markers) is a VERBATIM copy of the mobile file's -- this
// project's backend and mobile app are separate npm projects with no shared module, so hand-mirroring is the
// convention -- and scripts/test-torpedo.mjs fails if the two copies ever differ. Edit BOTH files together.

import type { PieceColor } from './RoomChessEngine.js';

// --- Shared rules block (mirrored VERBATIM in backend/src/game/torpedo.ts; scripts/test-torpedo.mjs fails if the two
// copies differ -- edit both together) ------------------------------------------------------------------------------

/** Torpedo starts from the ordinary chess start position. */
export const TORPEDO_START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** The square a pawn of `color` standing on `from` may reach with a torpedo double step that chess.js does NOT already
 * generate, or null. chess.js covers the home-rank double step (rank 2 for White, rank 7 for Black), so this answers null
 * from there; from every other rank 2-7 it answers the square two ahead when both squares in front are empty. A White pawn
 * on rank 6 lands on rank 8 (a promotion), a Black pawn on rank 3 on rank 1. Never leaves the board: White from rank 7 and
 * Black from rank 2 have only the single step. */
export function torpedoExtraDoubleStep(from: string, color: PieceColor, isOccupied: (square: string) => boolean): string | null {
  if (from.length !== 2) return null;
  const rank = Number(from[1]);
  if (!(rank >= 2 && rank <= 7)) return null;
  const step = color === 'w' ? 1 : -1;
  const homeRank = color === 'w' ? 2 : 7;
  const target = rank + 2 * step;
  if (rank === homeRank || target < 1 || target > 8) return null;
  const file = from[0];
  return isOccupied(`${file}${rank + step}`) || isOccupied(`${file}${target}`) ? null : `${file}${target}`;
}

// --- End of the shared rules block --------------------------------------------------------------------------------
