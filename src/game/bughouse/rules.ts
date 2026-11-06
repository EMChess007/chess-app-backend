// GENERATED FILE - DO NOT EDIT BY HAND.
// Source: src/logic/bughouse/rules.ts in the EM-Chess app repo. Regenerate with `npm run sync:bughouse`; CI runs it with --check.
// The only difference from the source is that relative imports carry the '.js' suffix NodeNext requires.

/**
 * Bughouse W1 (BUGHOUSE_SPEC.md sections 1 and 4): the vocabulary of a match - time controls, the per-board verdict, actions, results, events and refusals. Types and literals only;
 * no behaviour, no import of chess.js. MIRRORED to the backend (see types.ts).
 *
 * THERE IS NO DRAW ANYWHERE IN THIS MODULE (rule 22, S-U2): a match ends with a winning team, or it is `voided` because nobody is left to play it. Nothing in these types can
 * express a tie, and no function can produce one.
 */
import type { ReservePieceType } from '../crazyhouse.js';
import type { BoardId, BughouseColor, BughouseSeat, BughouseTeam } from './types.js';

/**
 * A time control: integer milliseconds. `initialMs: 0` is "No time limit" (command #35): no clock ever runs, nothing can flag (`runningClocks` is empty). Daily is a clock of whole days
 * (86 400 000 ms a day, 14 days at most = 1 209 600 000 ms, inside the 2^31 - 1 ms a timer can wait).
 */
export interface BughouseTimeControl {
  initialMs: number;
  incrementMs: number;
}

/** "No time limit": the engine's reading of `initialMs === 0`. */
export const isUnlimitedBughouse = (timeControl: BughouseTimeControl): boolean => timeControl.initialMs === 0;

const MS_PER_DAY = 86_400_000;

/** The label the pickers, the queue and the lists show: "No time limit", "3 min", "3 | 2", "1 day", "7 days" - the very labels of the app's list (`bughouseTimeControls.test.ts` compares them). */
export function bughouseControlLabel(control: BughouseTimeControl): string {
  if (control.initialMs === 0) return 'No time limit';
  if (control.initialMs >= MS_PER_DAY) {
    const days = control.initialMs / MS_PER_DAY;
    return days === 1 ? '1 day' : `${days} days`;
  }
  const minutes = control.initialMs / 60000;
  return control.incrementMs === 0 ? `${minutes} min` : `${minutes} | ${control.incrementMs / 1000}`;
}

/**
 * Every control the app offers (the app's ONE list, logic/timeControls.ts `TIME_CONTROLS`, in milliseconds): the six of spec rule 26 were all that Bughouse had before command #35.
 * This module is MIRRORED to the server and must not import the app's list, so the 21 are literals here and `bughouseTimeControls.test.ts` proves they equal `TIME_CONTROLS` converted.
 */
export const BUGHOUSE_TIME_CONTROLS: readonly BughouseTimeControl[] = [
  // the spec's six first (rule 26, in their old order: the tests and the persisted records index them), then the rest of the app's list
  { initialMs: 60000, incrementMs: 0 },
  { initialMs: 120000, incrementMs: 1000 },
  { initialMs: 180000, incrementMs: 0 },
  { initialMs: 180000, incrementMs: 2000 },
  { initialMs: 300000, incrementMs: 0 },
  { initialMs: 300000, incrementMs: 2000 },
  { initialMs: 0, incrementMs: 0 },
  { initialMs: 60000, incrementMs: 1000 },
  { initialMs: 300000, incrementMs: 5000 },
  { initialMs: 600000, incrementMs: 0 },
  { initialMs: 900000, incrementMs: 10000 },
  { initialMs: 1800000, incrementMs: 0 },
  { initialMs: 600000, incrementMs: 5000 },
  { initialMs: 1200000, incrementMs: 0 },
  { initialMs: 3600000, incrementMs: 0 },
  { initialMs: 86400000, incrementMs: 0 },
  { initialMs: 172800000, incrementMs: 0 },
  { initialMs: 259200000, incrementMs: 0 },
  { initialMs: 432000000, incrementMs: 0 },
  { initialMs: 604800000, incrementMs: 0 },
  { initialMs: 1209600000, incrementMs: 0 },
];

/**
 * What the side to move on a board is facing (rules 18 and 19, HP8):
 *  - `playing`   : not in check, has a move or a drop;
 *  - `check`     : in check, has a move or a drop that answers it;
 *  - `checkmate` : in check, no move, no drop - and NO dropped piece could ever answer it (a knight or pawn check, a double check, an adjacent slider): a REAL mate;
 *  - `stuck`     : no move and no drop RIGHT NOW, but not a real mate - in check with a single slider and an empty square between (a piece arriving in the pocket could block,
 *                  B4), or not in check with nothing to move and nothing to drop (B5). Nothing ends; the player waits and the clock decides.
 */
export type BoardStatus = 'playing' | 'check' | 'checkmate' | 'stuck';
export type StuckReason = 'check' | 'noAction';

export interface BoardVerdict {
  status: BoardStatus;
  /** Whose turn it is on the board. */
  turn: BughouseColor;
  /** Whether the side to move is in check (true for `check`, `checkmate` and a `stuck` with reason `check`). */
  inCheck: boolean;
  /** Why the player is stuck; null unless status is `stuck`. */
  stuck: StuckReason | null;
}

export type ResultReason = 'checkmate' | 'flag' | 'resign';

/** The match was won: the team, how, on which board and by whose loss. */
export interface DecidedResult {
  winnerTeam: BughouseTeam;
  reason: ResultReason;
  /** The deciding board: where the mate happened, or the loser's board for a flag or a resignation. */
  board: BoardId;
  loserSeat: BughouseSeat;
}

/** Nobody is left to play the match: no winner, nothing recorded (rule 22). */
export interface VoidedResult {
  voided: true;
  reason: 'abandoned';
}

export type MatchResult = DecidedResult | VoidedResult;

export function isVoided(result: MatchResult): result is VoidedResult {
  return 'voided' in result;
}

/** A promotion piece. */
export type PromotionPiece = 'q' | 'r' | 'b' | 'n';

/**
 * What a seat can ask for. A move and a drop NAME THEIR BOARD (HP9: every wire field says which board it belongs to); the engine refuses one whose board is not the seat's own.
 * There is NO disconnect action and no disconnect result (B19, W2): a seat whose human is gone is handed to a bot after the grace and the human can take it back; the only
 * non-winning end is `voided` (no human left).
 */
export type BughouseAction =
  | { kind: 'move'; board: BoardId; from: string; to: string; promotion?: PromotionPiece }
  | { kind: 'drop'; board: BoardId; piece: ReservePieceType; square: string }
  | { kind: 'resign' };

/** One input to the funnel: a seat's action. A timer firing is `null` (it is just a chance to settle flags, HP2). */
export interface BughouseInput {
  seat: BughouseSeat;
  action: BughouseAction;
}

/** A move that can be played, as listed for a seat. */
export interface BoardMoveOption {
  from: string;
  to: string;
  promotion?: PromotionPiece;
}

/** A drop that can be played, as listed for a seat. */
export interface BoardDropOption {
  piece: ReservePieceType;
  square: string;
}

/** Why an input was refused. A refusal changes nothing: no state, no seq, no time. */
export type RejectReason =
  | 'over' //          the match has ended
  | 'time' //          the instant is not an integer, or is earlier than one already seen
  | 'flagDue' //       a flag is already due (only reachable by calling commitAction without settle)
  | 'malformed' //     not an action this engine knows, or a field of the wrong kind
  | 'wrongBoard' //    the action names a board that is not the seat's own
  | 'notYourTurn' //   it is the opponent's turn on the seat's board
  | 'illegalMove' //   the move is not legal in the position
  | 'dropNotInPocket' // the pocket holds none of that piece
  | 'illegalDrop'; //  the square is occupied, a pawn on rank 1 / 8, or the drop does not answer the check

/** What a commit did, in order. `seq` is the match's global sequence number AFTER the commit. */
export type BughouseEvent =
  | { kind: 'move'; seq: number; seat: BughouseSeat; board: BoardId; from: string; to: string; san: string }
  | { kind: 'drop'; seq: number; seat: BughouseSeat; board: BoardId; piece: ReservePieceType; square: string; san: string }
  /** The piece a capture put in the pocket of `seat` (the capturer's PARTNER, on the other board); droppable from this very `seq`. */
  | { kind: 'bank'; seq: number; seat: BughouseSeat; piece: ReservePieceType }
  | { kind: 'result'; seq: number; result: MatchResult };
