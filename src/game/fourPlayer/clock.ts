// GENERATED FILE - DO NOT EDIT BY HAND.
// Source: src/logic/fourPlayer/clock.ts in the EM-Chess app repo. Regenerate with `npm run sync:fourplayer`; CI runs it with --check.
// The only difference from the source is that relative imports carry the '.js' suffix NodeNext requires.

/**
 * 4 Player Chess — the per-seat clocks, as a pure model (the React hook that drives it from a timer is useFourPlayerClock.ts).
 *
 * FOUR INDEPENDENT CLOCKS, and only the seat whose turn it is runs. That seat is always an ACTIVE one: the engine hands out the turn
 * only to active seats (eliminated seats are resolved instantly inside `advance`), so a dead king's random walk costs nobody time and
 * an eliminated seat's clock is simply never touched again — it stays frozen at whatever it showed when the seat went out. A seat that
 * runs out of time is eliminated through the engine's normal path, `resign(state, seat, rng, 'timeout')`: no points for anyone, its
 * pieces go dead and its king starts walking, the turn passes on, and the game ends if that was the third elimination.
 *
 * With "No time limit" the clock is disabled (`enabled: false`): nothing ticks and nobody can time out.
 */

import { resign, type GameEvent } from './elimination.js';
import type { Seat } from './board.js';
import type { FourPlayerState } from './state.js';

export interface FourPlayerClock {
  /** False for "No time limit". */
  readonly enabled: boolean;
  /** Seconds added to a seat's clock after each move IT makes (Fischer increment). */
  readonly incrementSeconds: number;
  /** Remaining seconds per seat (fractional while running). */
  readonly seconds: readonly number[];
}

/** Four equal clocks. Pass `enabled: false` for an untimed game (the numbers are then irrelevant and nothing ever ticks). */
export function createClock(initialSeconds: number, incrementSeconds: number, enabled: boolean): FourPlayerClock {
  return { enabled, incrementSeconds, seconds: [initialSeconds, initialSeconds, initialSeconds, initialSeconds] };
}

/** Adds the increment to `seat` — called after that seat plays a move (never for a dead king's walk, never for an eliminated seat). */
export function addIncrement(clock: FourPlayerClock, seat: Seat, state: Pick<FourPlayerState, 'status'>): FourPlayerClock {
  if (!clock.enabled || state.status[seat] !== 'active') return clock;
  const seconds = clock.seconds.slice();
  seconds[seat] += clock.incrementSeconds;
  return { ...clock, seconds };
}

export interface ClockTick {
  state: FourPlayerState;
  clock: FourPlayerClock;
  /** The events the timeout produced (an 'eliminated' with reason 'timeout', maybe the game ending); empty for a plain tick. */
  events: GameEvent[];
}

/**
 * Lets `elapsedSeconds` of real time pass: the seat to move loses that much (never below 0); if its clock reaches 0 it is eliminated
 * for time, which also passes the turn on. Nothing happens when the clock is disabled, the game is over, or the seat to move is not
 * active.
 */
export function clockTick(state: FourPlayerState, clock: FourPlayerClock, elapsedSeconds: number, rng: () => number = Math.random): ClockTick {
  const seat = state.turn;
  if (!clock.enabled || state.result || state.status[seat] !== 'active' || elapsedSeconds <= 0) return { state, clock, events: [] };
  const seconds = clock.seconds.slice();
  seconds[seat] = Math.max(0, seconds[seat] - elapsedSeconds);
  const next: FourPlayerClock = { ...clock, seconds };
  if (seconds[seat] > 0) return { state, clock: next, events: [] };
  const timedOut = resign(state, seat, rng, 'timeout');
  return { state: timedOut.state, clock: next, events: timedOut.events };
}
