// Server-side twin of the mobile app's src/logic/duckChess.ts — Duck Chess's rules. See that file's header for
// the full statement. In short: no check (a king is simply captured), one neutral duck that blocks every piece
// (nothing lands on it; sliders and double pawn steps cannot pass over it; castling is blocked across it), and a
// TURN is a regular move plus where the duck goes next (any other empty square). There is no duck before White's
// first move, a move that captures a king ends the game with no placement, and a side with no regular move at all
// is a draw.
//
// The server is the AUTHORITY for all of it: RoomManager.applyMove refuses any move the duck blocks, requires a
// legal duck destination alongside every move that does not capture a king (an occupied square, the duck's own
// square or a missing one rejects the WHOLE turn, nothing is applied), ends the game on a king capture with reason
// 'duckChess', and declares a blockade a draw. Moves come from RoomChessEngine's pseudo-legal generator
// ({ duckChess: true, duckSquare }) exactly as Fog of War's do.
//
// The rules block below (between the "Shared rules block" markers) is a VERBATIM copy of the mobile file's — this
// project's backend and mobile app are separate npm projects with no shared module, so hand-mirroring is the
// convention — and scripts/test-duck.mjs fails if the two copies ever differ. Edit BOTH files together.

import type { AppliedMove, PieceColor, RoomChessEngine } from './RoomChessEngine.js';

type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';

// --- Shared rules block (mirrored VERBATIM in backend/src/game/duckChess.ts; scripts/test-duck.mjs fails if the
// two copies differ — edit both together) -----------------------------------------------------------------------

const FILES = 'abcdefgh';

const fileOf = (square: string) => square.charCodeAt(0) - 97;
const rankOf = (square: string) => Number(square[1]) - 1;
const nameOf = (file: number, rank: number) => `${FILES[file]}${rank + 1}`;

/** The squares strictly between `from` and `to` when they share a rank, file or diagonal; empty for
 * anything else (a knight's jump) and for adjacent squares. */
export function squaresBetween(from: string, to: string): string[] {
  const df = fileOf(to) - fileOf(from);
  const dr = rankOf(to) - rankOf(from);
  if (!(df === 0 || dr === 0 || Math.abs(df) === Math.abs(dr))) return [];
  const steps = Math.max(Math.abs(df), Math.abs(dr));
  const sf = Math.sign(df);
  const sr = Math.sign(dr);
  const out: string[] = [];
  for (let i = 1; i < steps; i++) out.push(nameOf(fileOf(from) + sf * i, rankOf(from) + sr * i));
  return out;
}

/** Whether the duck stops an ordinary (non-castling) move: nothing may land on it, and sliding pieces and
 * a pawn's double step may not pass over it. Knights and kings jump/step, so only their destination matters. */
export function isMoveBlockedByDuck(piece: PieceType, from: string, to: string, duckSquare: string | null | undefined): boolean {
  if (!duckSquare) return false;
  if (to === duckSquare) return true;
  if (piece === 'n' || piece === 'k') return false;
  return squaresBetween(from, to).includes(duckSquare);
}

/** Whether the duck blocks a castling move (`from` = the king's square, `to` = where it lands, two files
 * away): it may not sit on any square the king or the rook crosses or lands on. */
export function isCastleBlockedByDuck(from: string, to: string, duckSquare: string | null | undefined): boolean {
  if (!duckSquare) return false;
  const rank = from[1];
  const kingSide = fileOf(to) > fileOf(from);
  const crossed = kingSide ? ['f', 'g'] : ['b', 'c', 'd'];
  return crossed.some((file) => `${file}${rank}` === duckSquare);
}

// --- End of the shared rules block --------------------------------------------------------------------------------

// --- Server-only helpers ---------------------------------------------------------------------------------------

/** Every EMPTY square of the position `fen` (read straight off its placement field — the server's engine
 * deliberately exposes only getFen()). */
export function emptySquares(fen: string): string[] {
  const out: string[] = [];
  fen
    .split(' ')[0]
    .split('/')
    .forEach((rank, rankIndex) => {
      let file = 0;
      for (const ch of rank) {
        if (ch >= '1' && ch <= '8') {
          for (let i = 0; i < Number(ch); i++) out.push(`${'abcdefgh'[file + i]}${8 - rankIndex}`);
          file += Number(ch);
        } else {
          file += 1;
        }
      }
    });
  return out;
}

/** Whether `target` is a legal place for the duck after a regular move that produced `fen`: an empty square
 * that is not the one the duck already stands on (it must move every turn). */
export function isLegalDuckPlacement(fen: string, currentDuck: string | null, target: string): boolean {
  return /^[a-h][1-8]$/.test(target) && target !== currentDuck && emptySquares(fen).includes(target);
}

/** Duck Chess's only decisive result — directly capturing the enemy king. `mover` is whoever just moved. */
export function getDuckChessWinner(move: AppliedMove | null, mover: PieceColor): PieceColor | null {
  return move?.captured === 'k' ? mover : null;
}

/** True when the side to move has no regular move at all (blockaded by the duck and its own pieces) — a draw. The
 * engine must already hold the duck's current square. */
export function hasNoDuckMoves(engine: RoomChessEngine): boolean {
  return engine.getPseudoLegalMoves(engine.getTurn()).length === 0;
}
