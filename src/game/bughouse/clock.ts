// GENERATED FILE - DO NOT EDIT BY HAND.
// Source: src/logic/bughouse/clock.ts in the EM-Chess app repo. Regenerate with `npm run sync:bughouse`; CI runs it with --check.
// The only difference from the source is that relative imports carry the '.js' suffix NodeNext requires.

/**
 * Bughouse W1: the four clocks (BUGHOUSE_SPEC.md rules 24-26, HP2). Every number is an integer count of milliseconds on ONE monotonic clock for the whole match - the caller (the
 * server's funnel, or a test) reads it once per input and passes it in; nothing in this module reads a clock, a timer or `Date`. MIRRORED to the backend.
 *
 * A clock stores `remainingMs` as of the instant it STARTED running (`runningSince`); while it runs, its flag deadline is `d = runningSince + remainingMs`. A clock that is not
 * running has `runningSince: null` and `remainingMs` is simply what is left. `startSeq` is the match's global sequence number at the commit that started the clock (0 at the start of
 * the match): the first level of the tie-break between two flags that fall in the same millisecond.
 */
import type { BoardId, BughouseSeat } from './types.js';

export interface SeatClock {
  remainingMs: number;
  runningSince: number | null;
  startSeq: number;
}

export const isWholeMs = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function isRunning(clock: SeatClock): boolean {
  return clock.runningSince !== null;
}

/** The instant a running clock's flag falls; null for a clock that is not running. */
export function deadlineOf(clock: SeatClock): number | null {
  return clock.runningSince === null ? null : clock.runningSince + clock.remainingMs;
}

/** What is left on a clock at `nowMs` (never negative: a flag that has fallen reads 0). */
export function remainingAt(clock: SeatClock, nowMs: number): number {
  if (clock.runningSince === null) return clock.remainingMs;
  return Math.max(0, clock.remainingMs - (nowMs - clock.runningSince));
}

/** The clock after its owner moved at `nowMs`: charged for the time used, plus the increment, stopped. */
export function afterMove(clock: SeatClock, nowMs: number, incrementMs: number): SeatClock {
  return { remainingMs: remainingAt(clock, nowMs) + incrementMs, runningSince: null, startSeq: clock.startSeq };
}

/** The clock started at `nowMs` by the commit with sequence number `seq`. */
export function started(clock: SeatClock, nowMs: number, seq: number): SeatClock {
  return { remainingMs: clock.remainingMs, runningSince: nowMs, startSeq: seq };
}

/** The clock frozen at `nowMs` (the match has ended): charged up to that instant, stopped. */
export function frozen(clock: SeatClock, nowMs: number): SeatClock {
  return { remainingMs: remainingAt(clock, nowMs), runningSince: null, startSeq: clock.startSeq };
}

/** A running clock of a seat, as the flag settlement sees it. */
export interface RunningClock {
  seat: BughouseSeat;
  board: BoardId;
  deadline: number;
  startSeq: number;
}

/**
 * Which of two flags that fell loses (HP2, the one rule with no source):
 *  1. the earlier deadline loses;
 *  2. equal deadlines: the clock that started running at the LOWER global seq loses (that player has been on the move longer in the server's total order);
 *  3. equal start seq (possible only at seq 0, before any commit): the board whose index equals the room's creation number modulo 2 loses (A = 0, B = 1).
 * Deterministic and replayable; no team, colour or seat is systematically disadvantaged because the creation number alternates. Never a draw.
 */
export function flagLoser(a: RunningClock, b: RunningClock, roomNumber: number): RunningClock {
  if (a.deadline !== b.deadline) return a.deadline < b.deadline ? a : b;
  if (a.startSeq !== b.startSeq) return a.startSeq < b.startSeq ? a : b;
  const losingBoard: BoardId = roomNumber % 2 === 0 ? 'A' : 'B';
  return a.board === losingBoard ? a : b;
}
