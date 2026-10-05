// Server-side twin of the mobile app's src/logic/spellChess.ts -- Spell Chess's rules. See that file's header
// for the full statement (confirmed directly against chess.com's own Help Center). In short: two spells, Freeze
// and Jump, each with its own charge count and a 3-own-turn cooldown once cast; at most one spell per turn, cast
// before the mover's own move; Freeze immobilizes a 3x3 (edge-clipped) zone for the opponent's immediate next
// turn only, and can also waive the "a move must resolve check" rule when every checking piece sits in the zone
// being frozen; Jump marks one occupied square transparent to the mover's own sliding pieces (rook/bishop/queen)
// for one full turn (the caster's move plus the opponent's reply), letting them capture the first piece beyond
// it -- including the enemy king outright. Checkmate/stalemate/draw all still apply exactly as chess.js computes
// them, PLUS a Jump-augmented king capture ends the game immediately (see getSpellChessWinner).
//
// The server is the AUTHORITY for all of it: RoomManager.applyMove validates any submitted spell cast against the
// room's own SpellChessState (charges/cooldowns) before the move is even tried, builds a scratch RoomChessEngine
// with the resulting frozenSquares/jumpSquare/freezeEscapeActive, and only on a successful move commits both the
// new position and the new SpellChessState (via afterSpellChessMove) to the room -- the same two-part-turn
// pattern Duck Chess already uses for its own move+placement turn (see rooms.ts and duckChess.ts).
//
// The rules block below (between the "Shared rules block" markers) is a VERBATIM copy of the mobile file's --
// this project's backend and mobile app are separate npm projects with no shared module, so hand-mirroring is
// the convention -- and scripts/test-spell.mjs fails if the two copies ever differ. Edit BOTH files together.

import type { AppliedMove, PieceColor, RoomChessEngine } from './RoomChessEngine.js';

// --- Shared rules block (mirrored VERBATIM in backend/src/game/spellChess.ts; scripts/test-spell.mjs fails if the
// two copies differ -- edit both together) --------------------------------------------------------------------

export const FREEZE_INITIAL_CHARGES = 5;
export const JUMP_INITIAL_CHARGES = 2;
export const SPELL_COOLDOWN_TURNS = 3;

const FILES = 'abcdefgh';
const fileOf = (square: string) => square.charCodeAt(0) - 97;
const rankOf = (square: string) => Number(square[1]) - 1;
const inBounds = (file: number, rank: number) => file >= 0 && file <= 7 && rank >= 0 && rank <= 7;
const nameOf = (file: number, rank: number) => `${FILES[file]}${rank + 1}`;

export interface SpellCharges {
  freeze: number;
  jump: number;
}

export interface SpellCooldowns {
  /** Turns of that player's own remaining before Freeze/Jump is castable again; 0 = ready now. */
  freeze: number;
  jump: number;
}

export interface SpellChessPlayerState {
  charges: SpellCharges;
  cooldowns: SpellCooldowns;
}

export interface PendingFreeze {
  squares: string[];
  /** Whose upcoming move this immobilizes — always the color opposite whoever cast it. Consumed (and
   * cleared) the instant that color's next move is played, win or not. */
  restricts: PieceColor;
}

export interface PendingJump {
  square: string;
  /** Plies left including the one about to be played; starts at 2 (caster's own move, then the
   * opponent's reply) and is decremented by exactly one every time ANY move is played while set. */
  pliesLeft: 1 | 2;
}

export interface SpellChessState {
  w: SpellChessPlayerState;
  b: SpellChessPlayerState;
  pendingFreeze: PendingFreeze | null;
  pendingJump: PendingJump | null;
}

function freshPlayerState(): SpellChessPlayerState {
  return { charges: { freeze: FREEZE_INITIAL_CHARGES, jump: JUMP_INITIAL_CHARGES }, cooldowns: { freeze: 0, jump: 0 } };
}

export function initialSpellChessState(): SpellChessState {
  return { w: freshPlayerState(), b: freshPlayerState(), pendingFreeze: null, pendingJump: null };
}

/** The 3x3 area centered on `center`, clipped to the board (a 2x3/2x2 area at an edge/corner — chess.com's
 * own wording: "You can place the freeze area anywhere on the board, including edges, creating a 2x3 or
 * 2x2 freeze zone"). */
export function getFreezeZoneSquares(center: string): string[] {
  const cf = fileOf(center);
  const cr = rankOf(center);
  const squares: string[] = [];
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      const f = cf + df;
      const r = cr + dr;
      if (inBounds(f, r)) squares.push(nameOf(f, r));
    }
  }
  return squares;
}

export function canCastFreeze(state: SpellChessState, color: PieceColor): boolean {
  const p = state[color];
  return p.charges.freeze > 0 && p.cooldowns.freeze === 0;
}

export function canCastJump(state: SpellChessState, color: PieceColor): boolean {
  const p = state[color];
  return p.charges.jump > 0 && p.cooldowns.jump === 0;
}

/** Whether `color` may cast ANY spell right now — false mid-turn once they've already cast one (callers
 * track that themselves per turn; this only reflects charges/cooldown). */
export function canCastAnySpell(state: SpellChessState, color: PieceColor): boolean {
  return canCastFreeze(state, color) || canCastJump(state, color);
}

const other = (color: PieceColor): PieceColor => (color === 'w' ? 'b' : 'w');

/** Casts Freeze for `color` around `center`. Illegal casts (no charge, on cooldown) are returned
 * unchanged — callers should guard with canCastFreeze first; this is a safety net, not the primary check. */
export function castFreeze(state: SpellChessState, color: PieceColor, center: string): SpellChessState {
  if (!canCastFreeze(state, color)) return state;
  const player = state[color];
  return {
    ...state,
    [color]: { charges: { ...player.charges, freeze: player.charges.freeze - 1 }, cooldowns: { ...player.cooldowns, freeze: SPELL_COOLDOWN_TURNS } },
    pendingFreeze: { squares: getFreezeZoneSquares(center), restricts: other(color) },
  };
}

/** Casts Jump for `color` targeting `square` (must be occupied — callers should check via getPieceAt
 * before offering it; an empty square just never matches anything in getJumpAugmentedCaptures). */
export function castJump(state: SpellChessState, color: PieceColor, square: string): SpellChessState {
  if (!canCastJump(state, color)) return state;
  const player = state[color];
  return {
    ...state,
    [color]: { charges: { ...player.charges, jump: player.charges.jump - 1 }, cooldowns: { ...player.cooldowns, jump: SPELL_COOLDOWN_TURNS } },
    pendingJump: { square, pliesLeft: 2 },
  };
}

/** Advances cooldowns and expires pending effects after `mover` has just played their move (whether or
 * not they cast a spell this turn). Call exactly once per ply, after the move is applied. */
export function afterSpellChessMove(state: SpellChessState, mover: PieceColor): SpellChessState {
  const player = state[mover];
  const next: SpellChessState = {
    ...state,
    [mover]: {
      charges: player.charges,
      cooldowns: { freeze: Math.max(0, player.cooldowns.freeze - 1), jump: Math.max(0, player.cooldowns.jump - 1) },
    },
  };
  if (next.pendingFreeze && next.pendingFreeze.restricts === mover) next.pendingFreeze = null;
  if (next.pendingJump) {
    next.pendingJump = next.pendingJump.pliesLeft <= 1 ? null : { square: next.pendingJump.square, pliesLeft: 1 };
  }
  return next;
}

/** Squares immobile for `color`'s move right now — empty unless a freeze was cast against them last turn. */
export function frozenSquaresFor(state: SpellChessState, color: PieceColor): string[] {
  return state.pendingFreeze && state.pendingFreeze.restricts === color ? state.pendingFreeze.squares : [];
}

/** The one square currently "jumpable" (either side may exploit it while it's their turn), or null. */
export function activeJumpSquare(state: SpellChessState): string | null {
  return state.pendingJump?.square ?? null;
}

/**
 * Everything one Spell Chess turn needs to VALIDATE or REPLAY its move, derived in the one place that knows which
 * state each input must be read from. Every call site (RoomManager.applyMove, OnlineGameScreen's live and rejoin
 * replays) goes through this so the order of operations cannot be re-derived wrongly.
 *
 * THE TRAP (it let a frozen player escape their own freeze): castFreeze overwrites `pendingFreeze`, and the pending
 * freeze that restricts the mover RIGHT NOW is exactly the one it overwrites. So:
 *  - `frozenSquares` is read from the state BEFORE this turn's cast. Freeze only ever restricts the opponent's NEXT
 *    move; read it after the cast and a mover who is frozen and casts their own Freeze finds nothing frozen.
 *  - `jumpSquare` is read from the state AFTER the cast: a Jump takes effect at once, for the caster's own move.
 *  - `freezeZone` is the zone being cast THIS turn (null when no Freeze was cast, or the cast was not allowed). It —
 *    never `frozenSquares` — is what may waive check (checkIsWaivedByFreeze).
 * Expiry itself is separate and correct: a freeze lives until its restricted color has moved (afterSpellChessMove).
 */
export interface SpellTurnContext {
  stateAfterCast: SpellChessState;
  frozenSquares: string[];
  jumpSquare: string | null;
  freezeZone: string[] | null;
}

export function spellTurnContext(
  state: SpellChessState,
  mover: PieceColor,
  cast: { type: 'freeze'; center: string } | { type: 'jump'; square: string } | null | undefined
): SpellTurnContext {
  const stateAfterCast = !cast ? state : cast.type === 'freeze' ? castFreeze(state, mover, cast.center) : castJump(state, mover, cast.square);
  return {
    stateAfterCast,
    frozenSquares: frozenSquaresFor(state, mover),
    jumpSquare: activeJumpSquare(stateAfterCast),
    freezeZone: cast && cast.type === 'freeze' && stateAfterCast !== state ? getFreezeZoneSquares(cast.center) : null,
  };
}

/** For a standard castling move — a king travelling two files along its home rank — the square of the rook that
 * castling moves as well; null for anything else. (Spell Chess excludes Chess960, so the rooks are on the a/h files.)
 * A frozen piece cannot move, and castling moves the rook too: a Freeze covering that rook forbids castling even when
 * the king itself is free. */
export function castlingRookOrigin(from: string, to: string, pieceType: string): string | null {
  if (pieceType !== 'k' || fileOf(from) !== 4 || rankOf(to) !== rankOf(from)) return null;
  if (rankOf(from) !== 0 && rankOf(from) !== 7) return null;
  if (fileOf(to) === 6) return nameOf(7, rankOf(from));
  if (fileOf(to) === 2) return nameOf(0, rankOf(from));
  return null;
}

// --- End of the shared rules block --------------------------------------------------------------------------------

// --- Server-only helpers --------------------------------------------------------------------------------------

type SlidingType = 'r' | 'b' | 'q';
const isSliding = (type: string): type is SlidingType => type === 'r' || type === 'b' || type === 'q';
const ORTHOGONAL_TYPES: SlidingType[] = ['r', 'q'];
const DIAGONAL_TYPES: SlidingType[] = ['b', 'q'];
const DIRECTIONS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

const FILES2 = 'abcdefgh';
const fileOf2 = (square: string) => square.charCodeAt(0) - 97;
const rankOf2 = (square: string) => Number(square[1]) - 1;
const inBounds2 = (file: number, rank: number) => file >= 0 && file <= 7 && rank >= 0 && rank <= 7;
const nameOf2 = (file: number, rank: number) => `${FILES2[file]}${rank + 1}`;

/** Walks from `square` in direction (df, dr), returning the first occupied square found (with its piece), or
 * null if the edge of the board is reached with nothing on it -- the server-side twin of the mobile app's
 * identical firstPieceInDirection, using RoomChessEngine.getPieceAt (there is no getBoard() here). */
function firstPieceInDirection(
  engine: RoomChessEngine,
  square: string,
  df: number,
  dr: number
): { square: string; piece: { type: 'p' | 'n' | 'b' | 'r' | 'q' | 'k'; color: PieceColor } } | null {
  let f = fileOf2(square) + df;
  let r = rankOf2(square) + dr;
  while (inBounds2(f, r)) {
    const sq = nameOf2(f, r);
    const piece = engine.getPieceAt(sq);
    if (piece) return { square: sq, piece };
    f += df;
    r += dr;
  }
  return null;
}

/**
 * Every extra capture a Jump on `jumpSquare` currently enables for `mover` -- see this module's own doc comment
 * for the exact rule. The server-side twin of the mobile app's identical getJumpAugmentedCaptures; returns
 * from/to/captured only (no `san` -- RoomChessEngine.applyRawSpellMove builds that itself via chess.js). Recomputed
 * fresh from the live board every time (never cached across moves).
 */
export function getJumpAugmentedCaptures(
  engine: RoomChessEngine,
  jumpSquare: string,
  mover: PieceColor
): { from: string; to: string; captured?: 'p' | 'n' | 'b' | 'r' | 'q' | 'k' }[] {
  if (!engine.getPieceAt(jumpSquare)) return [];
  const out: { from: string; to: string; captured?: 'p' | 'n' | 'b' | 'r' | 'q' | 'k' }[] = [];
  for (const [df, dr] of DIRECTIONS) {
    const near = firstPieceInDirection(engine, jumpSquare, -df, -dr);
    if (!near || near.piece.color !== mover || !isSliding(near.piece.type)) continue;
    const allowedTypes = df !== 0 && dr !== 0 ? DIAGONAL_TYPES : ORTHOGONAL_TYPES;
    if (!(allowedTypes as string[]).includes(near.piece.type)) continue;
    const far = firstPieceInDirection(engine, jumpSquare, df, dr);
    if (!far || far.piece.color === mover) continue;
    out.push({ from: near.square, to: far.square, captured: far.piece.type });
  }
  return out;
}

/** The squares of every enemy piece currently giving `kingColor`'s king check -- the server-side twin of the
 * mobile app's identical getCheckingPieceSquares. Scans all 64 squares for the king (RoomChessEngine has no
 * getBoard()), then reuses getPseudoLegalMoves (already exposed for Fog of War) to find the attacker(s). */
export function getCheckingPieceSquares(engine: RoomChessEngine, kingColor: PieceColor): string[] {
  let kingSquare: string | null = null;
  for (let rank = 0; rank < 8 && !kingSquare; rank++) {
    for (let file = 0; file < 8; file++) {
      const sq = nameOf2(file, rank);
      const piece = engine.getPieceAt(sq);
      if (piece?.type === 'k' && piece.color === kingColor) {
        kingSquare = sq;
        break;
      }
    }
  }
  if (!kingSquare) return [];
  const attacker = kingColor === 'w' ? 'b' : 'w';
  return engine
    .getPseudoLegalMoves(attacker)
    .filter((m) => m.to === kingSquare)
    .map((m) => m.from);
}

/** True when `color` is in check right now AND every single checking piece sits inside a freeze zone `color` is
 * about to cast (or just cast) THIS turn -- the server-side twin of the mobile app's identical
 * checkIsWaivedByFreeze; see that file for the full rationale. */
export function checkIsWaivedByFreeze(engine: RoomChessEngine, color: PieceColor, freezeZone: string[]): boolean {
  if (freezeZone.length === 0) return false;
  const checkers = getCheckingPieceSquares(engine, color);
  return checkers.length > 0 && checkers.every((sq) => freezeZone.includes(sq));
}

/** Spell Chess's one additional, non-exclusive win condition -- capturing the enemy king outright via a
 * Jump-augmented move (checkmate/stalemate/draw all still apply as normal on top of this). `mover` is whoever
 * just moved. The server-side twin of the mobile app's identical getSpellChessWinner. */
export function getSpellChessWinner(move: AppliedMove | null, mover: PieceColor): PieceColor | null {
  return move?.captured === 'k' ? mover : null;
}

/** A move as shown in game history / PGN: standard SAN, with the cast (if any) prefixed -- "F@e4 Nf3", "J@d5
 * Rxd8". No prefix when nothing was cast that turn. The server-side twin of the mobile app's identical
 * spellMoveNotation. */
export function spellMoveNotation(
  move: Pick<AppliedMove, 'san'>,
  cast: { type: 'freeze'; center: string; squares: string[] } | { type: 'jump'; square: string } | null | undefined
): string {
  if (!cast) return move.san;
  const tag = cast.type === 'freeze' ? `F@${cast.center}` : `J@${cast.square}`;
  return `${tag} ${move.san}`;
}
