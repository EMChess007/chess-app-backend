// GENERATED FILE - DO NOT EDIT BY HAND.
// Source: src/logic/fourPlayer/giveaway.ts in the EM-Chess app repo. Regenerate with `npm run sync:fourplayer`; CI runs it with --check.
// The only difference from the source is that relative imports carry the '.js' suffix NodeNext requires.

/**
 * 4 Player Giveaway (4-seat Antichess) - the rule helpers. Design and decisions: FOUR_PLAYER_GIVEAWAY_SPEC.md (sections 4-5).
 *
 * THE GAME IN ONE PARAGRAPH. The same board, armies, clocks and seat order as 4 Player Chess, but you want to LOSE your pieces. Captures
 * are MANDATORY: if any piece of the seat to move can capture a piece of any other (active) seat, the legal moves are exactly the captures,
 * and the mover picks whichever. Kings are ordinary pieces (they can be captured, may stand next to each other, there is no check and no
 * castling). The first seat to lose its LAST PIECE wins at once, and the first seat to be STUCK (no legal move) on its own turn wins; either
 * ends the game with that single winner - no 2nd-4th place. A seat that resigns or flags is eliminated, cannot win, and leaves its pieces
 * behind as WALLS. If one active seat is left it wins; at the ply cap the seat(s) with the fewest pieces win.
 *
 * WALLS (decision D2). An eliminated seat's pieces are never removed and can never be captured, so they are inert and permanent: they block
 * squares and slide-rays (a rook, bishop or queen ray ends at the first wall, which it can neither take nor pass), a pawn facing one is
 * blocked, a knight or king cannot land on one, and they are never "attacked" or "forcing" - a wall never creates a mandatory capture.
 * (4 Player Chess does the opposite: dead pieces stay capturable for 0 points. Eliminated Giveaway seats are given the status 'frozen'
 * at once, never 'dead-king', so no king walks.)
 *
 * WHERE THE ENGINE DISPATCHES ON `state.rules.mode === 'giveaway'` - the complete list; every other function is mode-blind, so 4 Player Chess
 * cannot change by accident (fourPlayerFfaGolden.test.ts replays recorded FFA games byte for byte to prove it):
 *   moves.ts        isCapturable (kings and active-seat pieces only), pseudoMoves (no castling, no en passant against a wall), legalMoves
 *                   (the capture filter REPLACES king safety), applyMoveRaw (no points; a captured king's square is cleared from `kings`)
 *   elimination.ts  eliminateSeat (-> 'frozen', no points), finishIfOver (lastStanding, no dead-position rule), endGame (cap = fewest pieces),
 *                   advance (outOfPieces / stuck), playMove (outOfPieces right after the move, before the cap), resign (the mover may be stuck)
 *   state.ts        GIVEAWAY_RULES, initialState / stateFromPieces start with no castling rights
 * This module holds only PURE helpers over a state and imports nothing from moves.ts / elimination.ts but TYPES, so moves.ts can import it
 * without a cycle.
 *
 * THE ORDER OF THE END-OF-GAME CHECKS (each is tested): after a move, (1) a seat left with no pieces wins (`outOfPieces`), (2) else the ply cap,
 * (3) else the turn passes and the seat to move is checked for being stuck (`stuck`); a resignation / flag fall checks (4) one active seat
 * left (`lastStanding`) first and then whether the seat now to move is stuck. So a capture that takes the last piece on the cap ply is an
 * `outOfPieces` win, not a cap tie-break.
 */

import type { Seat } from './board.js';
import type { Move } from './moves.js';
import { activeSeats, seatOf, type FourPlayerRules, type FourPlayerResult, type FourPlayerState } from './state.js';

export const isGiveawayRules = (rules: Pick<FourPlayerRules, 'mode'>): boolean => rules.mode === 'giveaway';

/** The mandatory-capture rule: exactly the captures if there is any (en passant included - it is recorded as a capture), else every move. */
export function mandatoryCaptures(moves: Move[]): Move[] {
  const captures = moves.filter((move) => move.captured !== 0);
  return captures.length > 0 ? captures : moves;
}

/** How many pieces each seat has on the board (kings included, promoted pieces too, walls of eliminated seats too). This is what the Giveaway seat card shows. */
export function piecesLeft(cells: Int8Array): [number, number, number, number] {
  const counts: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < cells.length; i++) if (cells[i] > 0) counts[seatOf(cells[i])]++;
  return counts;
}

/** The ACTIVE seat that has no piece left, scanning clockwise from the seat after `mover`; null if there is none. (A move captures at most one piece, so in play there is at most one.) */
export function seatOutOfPieces(state: Pick<FourPlayerState, 'cells' | 'status'>, mover: Seat): Seat | null {
  const counts = piecesLeft(state.cells);
  for (let step = 1; step <= 4; step++) {
    const seat = ((mover + step) % 4) as Seat;
    if (state.status[seat] === 'active' && counts[seat] === 0) return seat;
  }
  return null;
}

/** The winners at the ply cap: the ACTIVE seat(s) with the fewest pieces (eliminated seats cannot win). Ties are shared. */
export function capWinners(state: Pick<FourPlayerState, 'cells' | 'status'>): Seat[] {
  const counts = piecesLeft(state.cells);
  const active = activeSeats(state);
  const fewest = Math.min(...active.map((seat) => counts[seat]));
  return active.filter((seat) => counts[seat] === fewest);
}

export const giveawayResult = (winners: Seat[], reason: FourPlayerResult['reason']): FourPlayerResult => ({ winners, reason });
