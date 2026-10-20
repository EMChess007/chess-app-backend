// GENERATED FILE - DO NOT EDIT BY HAND.
// Source: src/logic/bughouse/types.ts in the EM-Chess app repo. Regenerate with `npm run sync:bughouse`; CI runs it with --check.
// The only difference from the source is that relative imports carry the '.js' suffix NodeNext requires.

/**
 * Bughouse (BUGHOUSE_SPEC.md section 7, W0): the EMPTY engine module - the board and the seat map, nothing else yet. W1 puts the match engine here.
 *
 * MIRRORED to the backend: this directory is listed in MIRRORED_TO_BACKEND.json and `npm run sync:bughouse` (in the backend repo) writes the server copy
 * (backend/src/game/bughouse/); CI runs it with --check. Edit THIS file only. The closure rule applies: a mirrored file may import only another mirrored file (or
 * `../crazyhouse`, the rules block that has its own verbatim mirror), never a package, a client-only module or a UI type.
 *
 * THE BOARD IS A REQUIRED ARGUMENT (AGENTS.md "Rules learned"; BUGHOUSE_SPEC.md HP9). Two boards exist at once, so a helper that names a square, a cell, a pocket or a clock
 * and that DEFAULTS to a board works until the day there are two (that is the class of bug that sent every online Chaturaji move to the wrong square). Every such helper in
 * this module takes `board: BoardId` as its FIRST parameter, with no default and not optional; bughouseBoardArgument.test.ts scans the module for it. Orientation (which
 * colour is at the bottom) is a property of the VIEW, never of the board's data.
 */

/** The two boards of a match. */
export type BoardId = 'A' | 'B';
export const BOARD_IDS: readonly BoardId[] = ['A', 'B'];

export function otherBoard(board: BoardId): BoardId {
  return board === 'A' ? 'B' : 'A';
}

export type BughouseColor = 'w' | 'b';
export type BughouseSeat = 0 | 1 | 2 | 3;
export type BughouseTeam = 1 | 2;
export const BUGHOUSE_SEATS: readonly BughouseSeat[] = [0, 1, 2, 3];

/** Where a seat sits. */
export interface SeatPlace {
  board: BoardId;
  color: BughouseColor;
  team: BughouseTeam;
  /** The teammate: the seat of the OTHER colour on the OTHER board. */
  partner: BughouseSeat;
}

/**
 * The fixed seat map (BUGHOUSE_SPEC.md section 1.1, B20): seat 0 = Board A White, 1 = Board A Black, 2 = Board B White, 3 = Board B Black. Team 1 = seats 0 + 3, Team 2 =
 * seats 1 + 2. A player's opponent on their own board is the other seat of that board.
 */
const SEATS: readonly SeatPlace[] = [
  { board: 'A', color: 'w', team: 1, partner: 3 },
  { board: 'A', color: 'b', team: 2, partner: 2 },
  { board: 'B', color: 'w', team: 2, partner: 1 },
  { board: 'B', color: 'b', team: 1, partner: 0 },
];

export function seatPlace(seat: BughouseSeat): SeatPlace {
  return SEATS[seat];
}

/** The seat of `color` on `board` - both arguments required. */
export function seatAt(board: BoardId, color: BughouseColor): BughouseSeat {
  return ((board === 'A' ? 0 : 2) + (color === 'w' ? 0 : 1)) as BughouseSeat;
}

export function partnerOf(seat: BughouseSeat): BughouseSeat {
  return SEATS[seat].partner;
}

/** The seat that plays the other colour on the same board. */
export function opponentOnBoard(seat: BughouseSeat): BughouseSeat {
  return seatAt(SEATS[seat].board, SEATS[seat].color === 'w' ? 'b' : 'w');
}

/** A square of ONE board as a key: "A:e4". The board is part of the key and cannot be left out. */
export function boardSquareKey(board: BoardId, square: string): string {
  return `${board}:${square}`;
}

/** The inverse of boardSquareKey; null for anything that is not "A:e4" / "B:h8". */
export function parseBoardSquareKey(key: string): { board: BoardId; square: string } | null {
  const match = /^([AB]):([a-h][1-8])$/.exec(key);
  return match ? { board: match[1] as BoardId, square: match[2] } : null;
}
