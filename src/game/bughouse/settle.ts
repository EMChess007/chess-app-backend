// GENERATED FILE - DO NOT EDIT BY HAND.
// Source: src/logic/bughouse/settle.ts in the EM-Chess app repo. Regenerate with `npm run sync:bughouse`; CI runs it with --check.
// The only difference from the source is that relative imports carry the '.js' suffix NodeNext requires.

/**
 * Bughouse W1: the flag settlement (BUGHOUSE_SPEC.md rule 25, HP2). The funnel reads ONE monotonic instant `nowMs` (integer milliseconds) per input and calls `settle`; nothing here
 * reads a clock. MIRRORED to the backend.
 *
 * BEFORE any input is applied - a move, a drop, a resignation, a timer firing - the flags that are already due (deadline <= nowMs) are settled: the player with the EARLIEST deadline loses
 * the match, and the input, if it was an action, is DISCARDED (it arrived after a flag had fallen). That alone decides a flag against a checkmate: the flag wins when its deadline is not
 * later than the instant the mating move was taken, otherwise the mate was committed first. An exact-millisecond tie between two deadlines is broken by clock.ts flagLoser (the lower start
 * seq loses, then the room's creation number modulo 2 picks the board). A timer that fires late cannot change the order: the comparison is between deadlines and receipt instants, never
 * between callback times.
 */
import { flagLoser, isWholeMs, type RunningClock } from './clock.js';
import { applyAction, finishMatch, runningClocks, type BughouseMatch } from './match.js';
import type { BughouseEvent, BughouseInput, MatchResult, RejectReason } from './rules.js';
import { seatPlace, type BughouseTeam } from './types.js';

export type SettleOutcome =
  /** Nothing was due and there was no input (a timer fired early): the match is unchanged. */
  | { kind: 'idle'; match: BughouseMatch }
  /** The input was committed. */
  | { kind: 'applied'; match: BughouseMatch; events: BughouseEvent[] }
  /** A flag was due: the match ended by flag at this commit; `discarded` is the input that arrived too late (null for a timer). */
  | { kind: 'flag'; match: BughouseMatch; events: BughouseEvent[]; discarded: BughouseInput | null }
  /** The input was refused; the match is unchanged (no seq, no time). */
  | { kind: 'rejected'; match: BughouseMatch; reason: RejectReason };

const otherTeam = (team: BughouseTeam): BughouseTeam => (team === 1 ? 2 : 1);

/** The flag that falls first among the running clocks that are due at `nowMs` (deadline <= nowMs), or null if none is due. Pure; changes nothing. */
export function dueFlag(match: BughouseMatch, nowMs: number): RunningClock | null {
  const due = runningClocks(match).filter((clock) => clock.deadline <= nowMs);
  return due.length === 0 ? null : due.reduce((a, b) => flagLoser(a, b, match.roomNumber));
}

/**
 * One step of the funnel: settle the flags due at `nowMs`, then apply `input`. `input` is null for a timer firing. The result says which of the four things happened; only
 * `applied` and `flag` change the match (and bump its seq by exactly one).
 */
export function settle(match: BughouseMatch, input: BughouseInput | null, nowMs: number): SettleOutcome {
  if (match.result !== null) return input === null ? { kind: 'idle', match } : { kind: 'rejected', match, reason: 'over' };
  if (!isWholeMs(nowMs) || nowMs < match.nowMs) return { kind: 'rejected', match, reason: 'time' };

  const loser = dueFlag(match, nowMs);
  if (loser !== null) {
    const result: MatchResult = { winnerTeam: otherTeam(seatPlace(loser.seat).team), reason: 'flag', board: loser.board, loserSeat: loser.seat };
    // Every running clock stops at the instant the first flag fell, so the other board's clock never shows time that was spent after the match was decided.
    const next = finishMatch(match, result, nowMs, loser.deadline);
    return { kind: 'flag', match: next, events: [{ kind: 'result', seq: next.seq, result }], discarded: input };
  }

  if (input === null) return { kind: 'idle', match };
  const outcome = applyAction(match, input.seat, input.action, nowMs);
  return outcome.ok ? { kind: 'applied', match: outcome.match, events: outcome.events } : { kind: 'rejected', match, reason: outcome.reason };
}
