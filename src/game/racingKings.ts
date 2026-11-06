// Server-side twin of the mobile app's src/logic/racingKings.ts -- Racing Kings (Lichess rules): both sides have the same
// army on ranks 1-2 (see RACING_KINGS_START_FEN), NO check may ever be given (a move that checks either king is illegal),
// and the first king on the 8th rank wins -- except that White moves first, so when White's king gets there Black gets one
// reply: if its king reaches rank 8 too the game is a DRAW, otherwise White wins. Stalemate, the fifty-move rule, threefold
// repetition and insufficient material are draws as in ordinary chess.
//
// How little the server needs: chess.js already keeps your own king out of check; the one extra rule (no checking move) is
// a filter on its verbose moves by the "+" / "#" SAN suffix, implemented in RoomChessEngine (see its `racingKings` option).
// The goal-rank result is decided here from the FEN, plus one legal-move look for the "White is on rank 8, can Black follow"
// case (racingKingsOutcome below), and RoomManager.applyMove checks it BEFORE asking the engine whether the game is over.
//
// The rules block below (between the "Shared rules block" markers) is a VERBATIM copy of the mobile file's -- this
// project's backend and mobile app are separate npm projects with no shared module, so hand-mirroring is the convention --
// and scripts/test-racingKings.mjs fails if the two copies ever differ. Edit BOTH files together.

import type { PieceColor } from './RoomChessEngine.js';

// --- Shared rules block (mirrored VERBATIM in backend/src/game/racingKings.ts; scripts/test-racingKings.mjs fails if the
// two copies differ -- edit both together) --------------------------------------------------------------------------

/** The standard Racing Kings start position (Lichess / chess.com): Black's army fills the a-d files of ranks 1-2, White's
 * the e-h files (Black king a2, White king h2; queens a1 / h1). */
export const RACING_KINGS_START_FEN = '8/8/8/8/8/8/krbnNBRK/qrbnNBRQ w - - 0 1';

/** The rank a king must reach (FEN rank 8). */
export const RACING_KINGS_GOAL_RANK = '8';

/** Which kings stand on the goal rank, read from the FEN's piece placement (its FIRST row is rank 8). */
export function racingKingsKingsOnGoal(fen: string): { w: boolean; b: boolean } {
  const rank8 = fen.split(' ')[0].split('/')[0] ?? '';
  return { w: rank8.includes('K'), b: rank8.includes('k') };
}

/** The result a position can have WITHOUT looking at legal moves: 'draw' when both kings are on rank 8, 'b' when only
 * Black's is, 'w' when only White's is AND it is White's move (Black had its reply and did not make it), else null.
 * White's king on rank 8 with BLACK to move is undecided here -- Black may still reach rank 8 (see getRacingKingsOutcome). */
export function racingKingsOutcomeFromFen(fen: string): 'w' | 'b' | 'draw' | null {
  const { w, b } = racingKingsKingsOnGoal(fen);
  if (w && b) return 'draw';
  if (b) return 'b';
  if (w) return fen.split(' ')[1] === 'w' ? 'w' : null;
  return null;
}

// --- End of the shared rules block --------------------------------------------------------------------------------

/** The minimal engine surface the outcome needs (RoomChessEngine satisfies it). */
interface RacingKingsEngineLike {
  getFen(): string;
  getTurn(): PieceColor;
  getLegalMoves(square: string): string[];
}

/** The result of a live engine: 'w' / 'b' (the winner), 'draw' (both kings made it), or null (play on). Stalemate and the
 * fifty-move draw are the engine's own getStatus(). Mirrors the mobile app's getRacingKingsOutcome. */
export function racingKingsOutcome(engine: RacingKingsEngineLike): 'w' | 'b' | 'draw' | null {
  const fen = engine.getFen();
  const direct = racingKingsOutcomeFromFen(fen);
  if (direct) return direct;
  if (!racingKingsKingsOnGoal(fen).w) return null;
  // White is on rank 8 and Black is to move: Black's one reply decides draw (it reaches) versus White's win (it cannot).
  const rows = fen.split(' ')[0].split('/');
  for (let r = 0; r < 8; r++) {
    let file = 0;
    for (const ch of rows[r]) {
      if (ch >= '1' && ch <= '8') {
        file += Number(ch);
        continue;
      }
      if (ch === 'k') {
        const square = `${'abcdefgh'[file]}${8 - r}`;
        return engine.getLegalMoves(square).some((to) => to[1] === RACING_KINGS_GOAL_RANK) ? null : 'w';
      }
      file++;
    }
  }
  return 'w';
}
