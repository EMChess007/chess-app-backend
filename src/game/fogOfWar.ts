// Server-side mirror of the mobile app's src/logic/fogOfWar.ts — see that file for the full
// rationale behind the visibility rule and the move-history redaction logic. The two differ only
// in how they read the board: the mobile ChessEngine exposes getBoard() directly, while
// RoomChessEngine (deliberately thin — see its own doc comment) only exposes getFen(), so
// visibility here is computed straight off the FEN placement field instead.

import { expandFenRank, collapseFenRank } from './chess960.js';
import { RoomChessEngine, type AppliedMove, type PieceColor } from './RoomChessEngine.js';

const FILES = 'abcdefgh';

function squaresWithOwnPieces(fen: string, color: PieceColor): string[] {
  const ranks = fen.split(' ')[0].split('/');
  const squares: string[] = [];
  ranks.forEach((rank, rankIndex) => {
    const row = expandFenRank(rank);
    row.forEach((piece, file) => {
      if (piece === '.') return;
      const pieceColor: PieceColor = piece === piece.toUpperCase() ? 'w' : 'b';
      if (pieceColor === color) squares.push(`${FILES[file]}${8 - rankIndex}`);
    });
  });
  return squares;
}

/** Every square `color`'s own pieces currently occupy, or could move to / capture on — see the
 * mobile app's identical getVisibleSquares for the full rationale. */
export function getVisibleSquares(engine: RoomChessEngine, color: PieceColor): Set<string> {
  const visible = new Set(squaresWithOwnPieces(engine.getFen(), color));
  for (const move of engine.getPseudoLegalMoves(color)) {
    visible.add(move.to);
  }
  return visible;
}

/** Builds the redacted FEN sent to `viewerColor` over the wire — identical to the true FEN except
 * the placement field has every square outside their own visibility blanked out. Turn, castling
 * rights, en-passant target and the move clocks are left untouched; see fogOfWar.ts's design
 * notes (mobile app conversation) for why those fields are treated as public information rather
 * than redacted. Reuses expandFenRank/collapseFenRank (already used by Chess960 castling) rather
 * than introducing a second FEN-manipulation approach. */
export function buildRedactedFen(engine: RoomChessEngine, viewerColor: PieceColor): string {
  const visible = getVisibleSquares(engine, viewerColor);
  const [placement, ...rest] = engine.getFen().split(' ');
  const ranks = placement.split('/');
  const redactedRanks = ranks.map((rank, rankIndex) => {
    const row = expandFenRank(rank);
    const redactedRow = row.map((piece, file) => (visible.has(`${FILES[file]}${8 - rankIndex}`) ? piece : '.'));
    return collapseFenRank(redactedRow);
  });
  return [redactedRanks.join('/'), ...rest].join(' ');
}

/** Fog of War's only win condition — reaching and directly capturing the enemy king. `mover` is
 * whoever's turn it was when `move` was made. */
export function getFogOfWarWinner(move: AppliedMove | null, mover: PieceColor): PieceColor | null {
  return move?.captured === 'k' ? mover : null;
}

export type RedactedHistoryEntry = { revealed: true; san: string; from: string; to: string } | { revealed: false };

/** Replays a Fog of War game from the start and decides, ply by ply, whether `viewerColor` would
 * actually have learned what happened on that move — see the mobile app's identical
 * redactMoveHistory for the full rationale (same pre/post visibility union rule). Used to build
 * the move history sent to a reconnecting player (rejoin) and, incrementally, the per-recipient
 * payload for each live move as it happens. */
export function redactMoveHistory(initialFen: string, history: AppliedMove[], viewerColor: PieceColor): RedactedHistoryEntry[] {
  const engine = new RoomChessEngine(initialFen);
  let visibleBefore = getVisibleSquares(engine, viewerColor);
  const result: RedactedHistoryEntry[] = [];

  for (const move of history) {
    const mover = engine.getTurn();
    engine.movePseudoLegal(move.from, move.to, move.promotion);
    const visibleAfter = getVisibleSquares(engine, viewerColor);

    const revealed = mover === viewerColor || visibleBefore.has(move.to) || visibleAfter.has(move.to);
    result.push(revealed ? { revealed: true, san: move.san, from: move.from, to: move.to } : { revealed: false });
    visibleBefore = visibleAfter;
  }
  return result;
}
