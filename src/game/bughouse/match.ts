// GENERATED FILE - DO NOT EDIT BY HAND.
// Source: src/logic/bughouse/match.ts in the EM-Chess app repo. Regenerate with `npm run sync:bughouse`; CI runs it with --check.
// The only difference from the source is that relative imports carry the '.js' suffix NodeNext requires.

/**
 * Bughouse W1: the match (BUGHOUSE_SPEC.md sections 1 and 4, HP1 / HP2 / HP8). A BughouseMatch is plain data - two boards, four pockets, four clocks, one global sequence number, a
 * verdict per board and the result - and every function here is PURE: it takes a match and returns a new one, reads no clock and keeps no state. MIRRORED to the backend.
 *
 * ONE COMMIT IS ONE ATOMIC STEP ACROSS BOTH BOARDS (HP1). `applyAction` plays the move or drop on its board, credits the capture to the capturer's PARTNER's pocket on the OTHER board
 * (a captured promoted piece is credited as a pawn), charges the mover's clock and starts the opponent's, recomputes the verdicts, bumps `seq` - and returns the new match whole. No
 * caller can see a capture without its credit. The credited piece is droppable from the very commit that contains the capture: it is in the pocket of the match that carries that `seq`.
 *
 * The flag settlement that must run BEFORE any input is `settle` (settle.ts); `applyAction` refuses to commit while a flag is due. The board is a REQUIRED argument wherever a function
 * names a square, a pocket or a clock by board; a seat names its board by itself (seatPlace).
 */
import {
  applyCrazyhouseDrop,
  applyCrazyhouseMoveForPartner,
  creditCrazyhouseReserve,
  emptyReserve,
  legalDropSquares,
  RESERVE_PIECE_TYPES,
  type CrazyhouseState,
  type Reserve,
  type ReservePieceType,
} from '../crazyhouse.js';
import {
  BOARD_START_FEN,
  boardCrazyhouse,
  dropNotation,
  fenOf,
  judgeBoard,
  legalDropOptions,
  legalMoveOptions,
  moveNotation,
  openBoard,
  pieceAtOf,
  playDrop,
  playMove,
} from './board.js';
import { afterMove, deadlineOf, frozen, isRunning, isWholeMs, started, type RunningClock, type SeatClock } from './clock.js';
import type { BoardDropOption, BoardMoveOption, BoardVerdict, BughouseAction, BughouseEvent, BughouseTimeControl, MatchResult, RejectReason } from './rules.js';
import { BOARD_IDS, BUGHOUSE_SEATS, opponentOnBoard, partnerOf, seatAt, seatPlace, type BoardId, type BughouseSeat, type BughouseTeam } from './types.js';

/** One board: its FEN (always with the en passant square written when a pawn has just double-stepped), the squares holding a promoted piece, and how many plies it has seen. */
export interface BoardState {
  fen: string;
  promoted: string[];
  plies: number;
}

export interface BughouseMatch {
  readonly timeControl: BughouseTimeControl;
  /** The room's creation number: only its parity matters, as the last level of the flag tie-break (clock.ts flagLoser). */
  readonly roomNumber: number;
  /** The global sequence number: the number of commits so far. Strictly increasing, one per accepted input that changes the match. */
  readonly seq: number;
  /** The latest instant (integer ms) the match has been told about; no later input may carry an earlier one. */
  readonly nowMs: number;
  readonly boards: Readonly<Record<BoardId, BoardState>>;
  /** The pocket of each seat: the pieces its player may drop, fed by its PARTNER's captures. Indexed by seat. */
  readonly pockets: readonly Reserve[];
  /** The clock of each seat. Indexed by seat. */
  readonly clocks: readonly SeatClock[];
  /** What the side to move on each board is facing. Derived - recomputed by every commit and by deserialisation. */
  readonly verdicts: Readonly<Record<BoardId, BoardVerdict>>;
  readonly result: MatchResult | null;
}

export interface NewMatchOptions {
  timeControl: BughouseTimeControl;
  roomNumber: number;
  /** The instant (integer ms) the match starts: both White clocks start running then, with no first-move grace (rule 3). */
  startMs: number;
}

const otherTeam = (team: BughouseTeam): BughouseTeam => (team === 1 ? 2 : 1);

export function isSeat(value: unknown): value is BughouseSeat {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3;
}

/** The Crazyhouse block's view of ONE board: the White player's pocket there, the Black player's pocket there, this board's promoted marks. */
export function crazyhouseOfBoard(match: BughouseMatch, board: BoardId): CrazyhouseState {
  return boardCrazyhouse(match.boards[board].promoted, match.pockets[seatAt(board, 'w')], match.pockets[seatAt(board, 'b')]);
}

export function pocketOfSeat(match: BughouseMatch, seat: BughouseSeat): Reserve {
  return { ...match.pockets[seat] };
}

export function clockOfSeat(match: BughouseMatch, seat: BughouseSeat): SeatClock {
  return { ...match.clocks[seat] };
}

/** The verdict of a board in the given pockets, from its FEN: used to start a match and to recompute the board whose pocket just changed. */
export function judgeBoardState(board: BoardId, state: BoardState, white: Reserve, black: Reserve): BoardVerdict {
  const chess = openBoard(state.fen);
  if (chess === null) throw new Error(`board ${board}: the stored position is not a valid FEN`);
  return judgeBoard(chess, boardCrazyhouse(state.promoted, white, black));
}

export function createMatch(options: NewMatchOptions): BughouseMatch {
  const { timeControl, roomNumber, startMs } = options;
  if (!isWholeMs(timeControl.initialMs) || timeControl.initialMs <= 0 || !isWholeMs(timeControl.incrementMs)) throw new RangeError('the time control must be whole milliseconds');
  if (!Number.isSafeInteger(roomNumber) || roomNumber < 0) throw new RangeError('the room number must be a whole number');
  if (!isWholeMs(startMs)) throw new RangeError('the start instant must be whole milliseconds');
  const pockets = BUGHOUSE_SEATS.map(() => emptyReserve());
  const clocks: SeatClock[] = BUGHOUSE_SEATS.map((seat) => ({ remainingMs: timeControl.initialMs, runningSince: seatPlace(seat).color === 'w' ? startMs : null, startSeq: 0 }));
  const boards: Record<BoardId, BoardState> = { A: { fen: BOARD_START_FEN, promoted: [], plies: 0 }, B: { fen: BOARD_START_FEN, promoted: [], plies: 0 } };
  const verdicts = {
    A: judgeBoardState('A', boards.A, pockets[seatAt('A', 'w')], pockets[seatAt('A', 'b')]),
    B: judgeBoardState('B', boards.B, pockets[seatAt('B', 'w')], pockets[seatAt('B', 'b')]),
  };
  return { timeControl: { ...timeControl }, roomNumber, seq: 0, nowMs: startMs, boards, pockets, clocks, verdicts, result: null };
}

/** Every running clock with the instant its flag falls. Two at most while the match is on (one per board). */
export function runningClocks(match: BughouseMatch): RunningClock[] {
  const running: RunningClock[] = [];
  for (const seat of BUGHOUSE_SEATS) {
    const deadline = deadlineOf(match.clocks[seat]);
    if (deadline !== null) running.push({ seat, board: seatPlace(seat).board, deadline, startSeq: match.clocks[seat].startSeq });
  }
  return running;
}

// --- Listing what can be played ---------------------------------------------------------------------------------------------------------------

/** The legal ordinary moves of the side to move on `board` (empty once the match is over). */
export function legalMovesOn(match: BughouseMatch, board: BoardId): BoardMoveOption[] {
  if (match.result !== null) return [];
  const chess = openBoard(match.boards[board].fen);
  return chess === null ? [] : legalMoveOptions(chess);
}

/** The legal drops of the side to move on `board`, from that player's pocket as it is now (empty once the match is over). */
export function legalDropsOn(match: BughouseMatch, board: BoardId): BoardDropOption[] {
  if (match.result !== null) return [];
  const chess = openBoard(match.boards[board].fen);
  return chess === null ? [] : legalDropOptions(chess, crazyhouseOfBoard(match, board));
}

export interface LegalActions {
  moves: BoardMoveOption[];
  drops: BoardDropOption[];
}

/** What `seat` may do right now: its board's legal moves and drops if it is its turn there, nothing otherwise. A resignation is always possible and is not listed. */
export function legalActions(match: BughouseMatch, seat: BughouseSeat): LegalActions {
  const place = seatPlace(seat);
  if (match.result !== null || match.verdicts[place.board].turn !== place.color) return { moves: [], drops: [] };
  return { moves: legalMovesOn(match, place.board), drops: legalDropsOn(match, place.board) };
}

// --- Committing an input ----------------------------------------------------------------------------------------------------------------------

export type ApplyOutcome = { ok: true; match: BughouseMatch; events: BughouseEvent[] } | { ok: false; reason: RejectReason };

const reject = (reason: RejectReason): ApplyOutcome => ({ ok: false, reason });

const SQUARE = /^[a-h][1-8]$/;

function wellFormed(action: BughouseAction): boolean {
  if (typeof action !== 'object' || action === null) return false;
  switch (action.kind) {
    case 'resign':
    case 'disconnect':
      return true;
    case 'move':
      return BOARD_IDS.includes(action.board) && typeof action.from === 'string' && SQUARE.test(action.from) && typeof action.to === 'string' && SQUARE.test(action.to) && (action.promotion === undefined || (action.promotion.length === 1 && 'qrbn'.includes(action.promotion)));
    case 'drop':
      return BOARD_IDS.includes(action.board) && RESERVE_PIECE_TYPES.includes(action.piece) && typeof action.square === 'string' && SQUARE.test(action.square);
    default:
      return false;
  }
}

/** The match with a result, every running clock frozen at `endMs`, and one more commit. */
export function finishMatch(match: BughouseMatch, result: MatchResult, nowMs: number, endMs: number): BughouseMatch {
  return { ...match, seq: match.seq + 1, nowMs, clocks: match.clocks.map((clock) => frozen(clock, endMs)), result };
}

/**
 * The match abandoned because no human is left in it (rule 22): ends `voided` - nobody wins, nothing is recorded. One more commit; every running clock stops at `nowMs`. Refused
 * (null) when the match is already over or the instant goes backwards. The server calls this when the all-gone timer expires; it is the only way a match gets a non-winning result.
 */
export function voidMatch(match: BughouseMatch, nowMs: number): BughouseMatch | null {
  if (match.result !== null || !isWholeMs(nowMs) || nowMs < match.nowMs) return null;
  return finishMatch(match, { voided: true, reason: 'abandoned' }, nowMs, nowMs);
}

/**
 * Applies `action` by `seat` at the instant `nowMs`: the pure commit. Refuses (changing nothing) with a RejectReason, or returns the new match and what happened. It does NOT settle
 * flags - `settle` does that first, and this function refuses with `flagDue` if a flag is due at `nowMs`, so the order "due flags before any action" cannot be bypassed.
 */
export function applyAction(match: BughouseMatch, seat: BughouseSeat, action: BughouseAction, nowMs: number): ApplyOutcome {
  if (match.result !== null) return reject('over');
  if (!isWholeMs(nowMs) || nowMs < match.nowMs) return reject('time');
  if (!isSeat(seat) || !wellFormed(action)) return reject('malformed');
  if (runningClocks(match).some((clock) => clock.deadline <= nowMs)) return reject('flagDue');
  const place = seatPlace(seat);

  if (action.kind === 'resign' || action.kind === 'disconnect') {
    const result: MatchResult = { winnerTeam: otherTeam(place.team), reason: action.kind === 'resign' ? 'resign' : 'disconnect', board: place.board, loserSeat: seat };
    const next = finishMatch(match, result, nowMs, nowMs);
    return { ok: true, match: next, events: [{ kind: 'result', seq: next.seq, result }] };
  }

  if (action.board !== place.board) return reject('wrongBoard');
  const board = place.board;
  if (match.verdicts[board].turn !== place.color) return reject('notYourTurn');
  const chess = openBoard(match.boards[board].fen);
  if (chess === null) return reject('malformed');
  const cz = crazyhouseOfBoard(match, board);
  const seq = match.seq + 1;
  const pockets = [...match.pockets];
  let after: CrazyhouseState;
  let banked: ReservePieceType | null = null;
  let notation: (verdict: BoardVerdict) => string;
  let event: (san: string) => BughouseEvent;

  if (action.kind === 'move') {
    const played = playMove(chess, action.from, action.to, action.promotion);
    if (played === null) return reject('illegalMove');
    const partnered = applyCrazyhouseMoveForPartner(cz, place.color, played.info);
    after = partnered.state;
    banked = partnered.banked;
    notation = (verdict) => moveNotation(played.san, verdict);
    event = (san) => ({ kind: 'move', seq, seat, board, from: played.info.from, to: played.info.to, san });
  } else {
    if (!(cz.reserve[place.color][action.piece] > 0)) return reject('dropNotInPocket');
    if (!legalDropSquares(cz, place.color, action.piece, pieceAtOf(chess)).includes(action.square)) return reject('illegalDrop');
    if (!playDrop(chess, action.piece, action.square)) return reject('illegalDrop');
    after = applyCrazyhouseDrop(cz, place.color, action.piece);
    pockets[seat] = after.reserve[place.color];
    const dropped = action;
    notation = (verdict) => dropNotation(dropped.piece, dropped.square, verdict);
    event = (san) => ({ kind: 'drop', seq, seat, board, piece: dropped.piece, square: dropped.square, san });
  }

  // The credit: the capturer's PARTNER (the other colour on the OTHER board) gets the piece, in the same step.
  const events: BughouseEvent[] = [];
  const recipient = partnerOf(seat);
  if (banked !== null) {
    const recipientPlace = seatPlace(recipient);
    pockets[recipient] = creditCrazyhouseReserve(crazyhouseOfBoard(match, recipientPlace.board), recipientPlace.color, banked).reserve[recipientPlace.color];
  }

  const boards: Record<BoardId, BoardState> = { ...match.boards, [board]: { fen: fenOf(chess), promoted: after.promoted, plies: match.boards[board].plies + 1 } };
  const verdicts: Record<BoardId, BoardVerdict> = { ...match.verdicts };
  verdicts[board] = judgeBoard(chess, boardCrazyhouse(after.promoted, pockets[seatAt(board, 'w')], pockets[seatAt(board, 'b')]));
  if (banked !== null) {
    const otherBoard = seatPlace(recipient).board;
    verdicts[otherBoard] = judgeBoardState(otherBoard, boards[otherBoard], pockets[seatAt(otherBoard, 'w')], pockets[seatAt(otherBoard, 'b')]);
  }
  events.push(event(notation(verdicts[board])));
  if (banked !== null) events.push({ kind: 'bank', seq, seat: recipient, piece: banked });

  const base: BughouseMatch = { ...match, seq, nowMs, boards, pockets, verdicts };
  if (verdicts[board].status === 'checkmate') {
    const result: MatchResult = { winnerTeam: place.team, reason: 'checkmate', board, loserSeat: opponentOnBoard(seat) };
    const next: BughouseMatch = { ...base, clocks: match.clocks.map((clock, index) => (index === seat ? frozen(afterMove(clock, nowMs, match.timeControl.incrementMs), nowMs) : frozen(clock, nowMs))), result };
    events.push({ kind: 'result', seq, result });
    return { ok: true, match: next, events };
  }
  const clocks = [...match.clocks];
  if (!isRunning(clocks[seat])) return reject('notYourTurn');
  clocks[seat] = afterMove(clocks[seat], nowMs, match.timeControl.incrementMs);
  const opponent = opponentOnBoard(seat);
  clocks[opponent] = started(clocks[opponent], nowMs, seq);
  return { ok: true, match: { ...base, clocks }, events };
}
