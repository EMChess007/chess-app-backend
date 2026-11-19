import { Chess, validateFen } from 'chess.js';

/**
 * "From Position" online (command #53): a direct challenge whose creator picked the starting position (Board Editor or a pasted FEN).
 *
 * THE RULE IS MIRRORED, NOT SHARED: this is the server twin of the app's `normalizePlayFen` + `validateEditorFen(fen, { forPlay: true })`
 * (src/logic/boardEditor.ts). The server never trusts the client's own check, so it re-judges the position with the SAME rules: chess.js's
 * structural check (exactly one king per colour, no pawns on rank 1/8, well-formed fields), the side NOT to move not in check, every castling right backed
 * by its king and rook on their home squares, an en passant square that follows a real double step, and a position that is not already
 * checkmate / stalemate / a draw. `scripts/test-from-position.mjs` runs both implementations on one corpus and fails when they disagree
 * (edit BOTH together). Only the English message is kept here (the app shows its own Greek twin for the client-side check; the server's
 * refusal travels as the ack `error`).
 *
 * It is ordinary chess from there on - no variant flag - so a room created from it is just a classical room whose `initialFen` is this
 * FEN (the same plumbing Setup Chess uses), rejoin / spectate / saved history / PGN (`[SetUp "1"] [FEN "..."]`) all read that one field.
 */

export type FromPositionValidation = { ok: true; fen: string } | { ok: false; error: string };

/** A pasted FEN with only the first four fields gets the clocks "0 1"; whitespace is collapsed (mirror of the app's normalizePlayFen). */
export function normalizePlayFen(fen: string): string {
  const fields = fen.trim().split(/\s+/);
  return fields.length === 4 ? [...fields, '0', '1'].join(' ') : fields.join(' ');
}

function inconsistentCastling(fen: string): string | null {
  const chess = new Chess(fen, { skipValidation: true });
  const is = (square: string, type: 'k' | 'r', color: 'w' | 'b') => {
    const piece = chess.get(square as Parameters<Chess['get']>[0]);
    return piece !== undefined && piece.type === type && piece.color === color;
  };
  const rights = fen.trim().split(/\s+/)[2] ?? '-';
  if (rights.includes('K') && !(is('e1', 'k', 'w') && is('h1', 'r', 'w'))) return 'K';
  if (rights.includes('Q') && !(is('e1', 'k', 'w') && is('a1', 'r', 'w'))) return 'Q';
  if (rights.includes('k') && !(is('e8', 'k', 'b') && is('h8', 'r', 'b'))) return 'k';
  if (rights.includes('q') && !(is('e8', 'k', 'b') && is('a8', 'r', 'b'))) return 'q';
  return null;
}

function enPassantProblem(fen: string): boolean {
  const fields = fen.trim().split(/\s+/);
  const target = fields[3];
  if (!target || target === '-') return false;
  const whiteToMove = fields[1] === 'w';
  if (target[1] !== (whiteToMove ? '6' : '3')) return true;
  const chess = new Chess(fen, { skipValidation: true });
  const at = (square: string) => chess.get(square as Parameters<Chess['get']>[0]);
  const file = target[0];
  const pawn = at(`${file}${whiteToMove ? 5 : 4}`);
  return !(pawn && pawn.type === 'p' && pawn.color === (whiteToMove ? 'b' : 'w')) || Boolean(at(target)) || Boolean(at(`${file}${whiteToMove ? 7 : 2}`));
}

/** The one place the server judges a challenge's starting position. Returns the NORMALIZED fen to start the room from. */
export function validateFromPositionFen(rawFen: unknown): FromPositionValidation {
  if (typeof rawFen !== 'string' || rawFen.length > 200) return { ok: false, error: 'Invalid FEN.' };
  const fen = normalizePlayFen(rawFen);

  const structural = validateFen(fen);
  if (!structural.ok) return { ok: false, error: structural.error ?? 'Invalid FEN.' };

  const fields = fen.split(' ');
  const flipped = new Chess([fields[0], fields[1] === 'w' ? 'b' : 'w', '-', '-', '0', '1'].join(' '));
  if (flipped.isCheck()) return { ok: false, error: 'The side not to move cannot be in check.' };

  const badRight = inconsistentCastling(fen);
  if (badRight) return { ok: false, error: `Castling right "${badRight}" needs the king and that rook on their starting squares.` };
  if (enPassantProblem(fen)) return { ok: false, error: 'The en passant square does not match the position (it must follow a pawn double step).' };

  const game = new Chess(fen);
  if (game.isCheckmate()) return { ok: false, error: 'This position is already checkmate - there is no game to play.' };
  if (game.isStalemate()) return { ok: false, error: 'This position is already stalemate - there is no game to play.' };
  if (game.isDraw()) return { ok: false, error: 'This position is already a draw (insufficient material or the fifty-move rule) - there is no game to play.' };

  return { ok: true, fen };
}
