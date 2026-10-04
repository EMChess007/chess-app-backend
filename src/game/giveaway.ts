// Server-side mirror of the mobile app's src/logic/giveaway.ts — see that file for the full
// statement of the rules. Like fogOfWar.ts, it sits on RoomChessEngine's pseudo-legal generator
// (chess.js's own legal-move filtering is all about king safety, which does not exist here), so a
// RoomChessEngine used with this file MUST be constructed with { giveaway: true } (which also
// drops castling, adds king promotion and skips chess.js's strict FEN validation).
//
// The rules, exactly as shipped (and tested) in Local and Bots:
//  - Captures are MANDATORY: if the side to move has any capture anywhere on the board, every
//    non-capturing move is illegal that turn — globally, not per piece.
//  - The king is an ordinary piece: it can be captured, there is no check/checkmate, and capturing
//    one is NOT a win condition by itself.
//  - You WIN the instant it is your turn and you have no legal move — no pieces left, or every
//    remaining piece is blocked. Being stuck wins; it never loses or draws.
//  - No castling; a pawn may promote to a king as well as the usual pieces.
//
// This file is the server's AUTHORITY for all of that: RoomManager.applyMove rejects any move that is
// not in getGiveawayMoves, and declares the winner from getGiveawayWinner — a modified client can
// not submit a non-capturing move while a capture exists. Kept in lockstep with the mobile app by
// scripts/test-giveaway.mjs, which replays random Giveaway games through BOTH implementations and
// requires identical legal moves, positions and winners at every ply.

import type { AppliedMove, PieceColor, RoomChessEngine } from './RoomChessEngine.js';

/** Every legal Giveaway move for the side to move, optionally narrowed to those starting on
 * `square`. The mandatory-capture collapse happens BEFORE the square filter on purpose: if any
 * piece on the board can capture, a piece with no capture of its own correctly has no legal moves
 * at all (rather than its quiet moves looking available). */
export function getGiveawayMoves(engine: RoomChessEngine, square?: string): AppliedMove[] {
  const all = engine.getPseudoLegalMoves(engine.getTurn());
  const capturing = all.filter((m) => m.captured);
  const legal = capturing.length > 0 ? capturing : all;
  return square ? legal.filter((m) => m.from === square) : legal;
}

/** The side that has just won, or null while the game goes on: whoever is to move wins the
 * instant they have no legal move at all. */
export function getGiveawayWinner(engine: RoomChessEngine): PieceColor | null {
  return getGiveawayMoves(engine).length === 0 ? engine.getTurn() : null;
}

/** Whether `from`-`to` (with `promotion`, which only matters for a pawn reaching its last rank) is
 * one of the side to move's legal Giveaway moves. */
export function isLegalGiveawayMove(engine: RoomChessEngine, from: string, to: string, promotion?: AppliedMove['promotion']): boolean {
  return getGiveawayMoves(engine, from).some((m) => m.to === to && (!m.promotion || m.promotion === promotion));
}

/** Why a move was refused, for the ack message: a missed mandatory capture is the one case worth
 * naming specifically. */
export function describeGiveawayRejection(engine: RoomChessEngine): string {
  return getGiveawayMoves(engine).some((m) => m.captured) ? 'Invalid move — a capture is mandatory.' : 'Invalid move.';
}
