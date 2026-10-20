// GENERATED FILE - DO NOT EDIT BY HAND.
// Source: src/logic/bughouse/premove.ts in the EM-Chess app repo. Regenerate with `npm run sync:bughouse`; CI runs it with --check.
// The only difference from the source is that relative imports carry the '.js' suffix NodeNext requires.

/**
 * Bughouse W1: premove resolution as a pure function (BUGHOUSE_SPEC.md HP3). MIRRORED to the backend.
 *
 * A premove is client-only and is never sent early. When the authoritative snapshot that GIVES THE PLAYER THE TURN arrives, the queued intent is validated against THAT match (both
 * boards, all four pockets) with `resolvePremove`: valid, it becomes the ordinary action the client sends; invalid, it says WHY, so the screen can show the reason (a toast) and
 * remove the marker. The server never stores a premove and never sees one. Queue length is one; replacing and cancelling are the screen's business.
 */
import { legalActions, type BughouseMatch } from './match.js';
import type { BughouseAction, PromotionPiece } from './rules.js';
import { seatPlace, type BughouseSeat } from './types.js';
import { pieceAtOf, openBoard } from './board.js';
import type { ReservePieceType } from '../crazyhouse.js';

/** What the player queued: a move or a drop. (The board is the seat's own, so it is not part of the intent; `resolvePremove` adds it.) */
export type Premove = { kind: 'move'; from: string; to: string; promotion?: PromotionPiece } | { kind: 'drop'; piece: ReservePieceType; square: string };

/** Why a premove was cancelled - one visible reason each (HP3). `gameOver` is shown silently; `notYourTurn` means "not yet": the snapshot did not give the turn. */
export type PremoveCancel = 'gameOver' | 'notYourTurn' | 'noLongerLegal' | 'squareOccupied' | 'notInPocket' | 'checkNotAnswered';

export type PremoveResolution = { ok: true; action: BughouseAction } | { ok: false; reason: PremoveCancel };

export function resolvePremove(match: BughouseMatch, seat: BughouseSeat, premove: Premove): PremoveResolution {
  if (match.result !== null) return { ok: false, reason: 'gameOver' };
  const place = seatPlace(seat);
  if (match.verdicts[place.board].turn !== place.color) return { ok: false, reason: 'notYourTurn' };
  const legal = legalActions(match, seat);

  if (premove.kind === 'move') {
    const found = legal.moves.some((m) => m.from === premove.from && m.to === premove.to && (m.promotion ?? null) === (premove.promotion ?? null));
    return found ? { ok: true, action: { kind: 'move', board: place.board, from: premove.from, to: premove.to, ...(premove.promotion ? { promotion: premove.promotion } : {}) } } : { ok: false, reason: 'noLongerLegal' };
  }

  // a drop: the pocket first (it can only have shrunk through the player's own drop), then the square, then the rules about check and ranks
  if (!(match.pockets[seat][premove.piece] > 0)) return { ok: false, reason: 'notInPocket' };
  const chess = openBoard(match.boards[place.board].fen);
  if (chess === null) return { ok: false, reason: 'noLongerLegal' };
  if (pieceAtOf(chess)(premove.square)) return { ok: false, reason: 'squareOccupied' };
  if (legal.drops.some((d) => d.piece === premove.piece && d.square === premove.square)) return { ok: true, action: { kind: 'drop', board: place.board, piece: premove.piece, square: premove.square } };
  return { ok: false, reason: match.verdicts[place.board].inCheck ? 'checkNotAnswered' : 'noLongerLegal' };
}
