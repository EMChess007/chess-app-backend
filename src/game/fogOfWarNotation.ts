// Fog of War notation: no player is ever told about a check. THIS FILE IS BYTE-IDENTICAL in the backend
// (backend/src/game/fogOfWarNotation.ts) - backend/scripts/test-fogOfWarNotation.mjs fails if the two drift. Edit BOTH.
//
// chess.com: in Fog of War "players are not notified when their king is in check". chess.js, though, writes '+' (check)
// and '#' (checkmate) into every SAN it produces, computed on the TRUE board - so a discovered check by a piece the victim
// cannot see arrived as "Nc3+" (and, further down, as a heavy "you put them in check" haptic: haptics.ts reads the suffix).
// ChessEngine/RoomChessEngine.movePseudoLegal therefore strip it (like Duck Chess and Giveaway, which have no check either)
// and keep the real notation in `trueSan`, which only the server ever uses - for spectators (who see the whole board) and the
// finished game's saved PGN. A player-facing payload or view must only ever read `san`.

/** `san` without its trailing check ('+') / checkmate ('#') marker. */
export function stripCheckSuffix(san: string): string {
  return san.replace(/[+#]$/, '');
}

/** `move` as a Fog of War player may see it: `san` without the marker, the original kept as `trueSan` (only when it differed). */
export function hideCheckFromPlayers<T extends { san: string; trueSan?: string }>(move: T): T {
  const plain = stripCheckSuffix(move.san);
  return plain === move.san ? move : { ...move, san: plain, trueSan: move.san };
}
