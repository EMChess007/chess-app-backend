import { START_FEN, type AppliedMove } from './RoomChessEngine.js';

/** Renders a sequence of already-known SAN moves with move numbers — mirrors the mobile app's
 * src/logic/sanFormat.ts exactly (hand-mirrored, same pattern as this project's other
 * frontend/backend type duplication). */
function formatSanMoves(startTurn: 'w' | 'b', startMoveNumber: number, sanMoves: string[]): string {
  let turn = startTurn;
  let moveNumber = startMoveNumber;
  const parts: string[] = [];

  sanMoves.forEach((san, i) => {
    if (turn === 'w') {
      parts.push(`${moveNumber}.${san}`);
    } else {
      parts.push(i === 0 ? `${moveNumber}...${san}` : san);
      moveNumber += 1;
    }
    turn = turn === 'w' ? 'b' : 'w';
  });

  return parts.join(' ');
}

/** Builds a minimal but valid PGN from a finished room's moves — mirrors the mobile app's
 * src/logic/pgn.ts (buildPgn), which every locally-played game already goes through, so online
 * games end up with the exact same PGN shape in game history. */
export function buildPgn(initialFen: string, moves: AppliedMove[], result: string, variant?: string): string {
  const fenParts = initialFen.split(' ');
  const startTurn: 'w' | 'b' = fenParts[1] === 'b' ? 'b' : 'w';
  const startMoveNumber = parseInt(fenParts[5], 10) || 1;

  const movetext = formatSanMoves(
    startTurn,
    startMoveNumber,
    // Duck Chess: where the duck went rides along as a standard PGN comment, "e4 {@g6}" — mirrors the mobile
    // app's buildPgn. Spell Chess: the cast (if any) rides along the same way, prefixed before the move instead
    // of after it, matching the mobile app's spellMoveNotation (e.g. "{F@e4} Nf3", "{J@d5} Rxd8").
    moves.map((m) =>
      m.duck
        ? `${m.san} {@${m.duck}}`
        : m.spell
          ? `{${m.spell.type === 'freeze' ? 'F' : 'J'}@${m.spell.type === 'freeze' ? m.spell.center : m.spell.square}} ${m.san}`
          : m.san
    )
  );

  const tags = [`[Result "${result}"]`];
  // Mirrors the mobile app's buildPgn: a variant tag makes replay/analysis refuse games whose moves
  // are not legal ordinary chess (Giveaway is tagged "Antichess", like the mobile app's own saves).
  if (variant) tags.push(`[Variant "${variant}"]`);
  if (initialFen !== START_FEN) {
    tags.push('[SetUp "1"]', `[FEN "${initialFen}"]`);
  }

  return `${tags.join('\n')}\n\n${movetext} ${result}`.trim();
}
