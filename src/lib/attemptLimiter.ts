/**
 * A limiter for FAILED guesses of a secret (an invite code), one shared module: the 2-player `join_challenge` uses it today and the Bughouse friend rooms will reuse it
 * (BUGHOUSE_SPEC.md, HP11). Why it exists: an invite code is 6 characters from a 31-letter alphabet (about 887 million) with a 10-minute life, which is guessable at network
 * speed when nothing limits attempts, and only the HTTP routes had a limiter - a socket event has none of its own.
 *
 * WHAT IT COUNTS. Only FAILED attempts are recorded (`recordFailure`); a successful attempt records nothing AND resets nothing - otherwise an attacker holding one valid
 * code could interleave a success to wipe his failure count. Every attempt is first `check`ed; a blocked attempt is refused without being recorded, so hammering a blocked
 * scope never extends the block.
 *
 * SCOPES. Independent counters keyed by whatever the caller names (a socket id, a user id, a client address). A `null` key skips that scope (a guest has no user id). An attempt is
 * refused when ANY scope is blocked, and a failure counts in EVERY scope at once.
 *   - `maxFailures` within `windowMs` blocks the scope. The window is sliding: a failure stops counting exactly `windowMs` after it happened.
 *   - With `cooldownMs > 0` the block lasts `cooldownMs` from the failure that reached the maximum, after which the scope's history is cleared; with `cooldownMs === 0` the block
 *     lasts until enough old failures have left the window (a sliding limit).
 *
 * BOUNDARIES (pinned by test-attempt-limiter.mjs): with `maxFailures = 5` the fifth failure is allowed through `check` before it happens and the SIXTH attempt is refused; a
 * failure made at t stops counting at t + windowMs (counted while `t > now - windowMs`); a cooldown that started at t ends at t + cooldownMs (refused while `now < t + cooldownMs`).
 *
 * EQUIVALENT-MUTANT NOTES (mutation re-run of the join_challenge limiter; each proof is pinned by the reference-model test in test-attempt-limiter.mjs, which compares this module
 * with a naive model over 32,000 seeded random checks, so a change that cannot be told apart from the model is behaviour-neutral by construction):
 *   (1) `blockedUntil > t` vs `>=` in `waitFor`: both callers run `expire` first, and `expire` clears the block at `t >= blockedUntil`, so `waitFor` never sees them equal;
 *   (2) `blocker = failures[0]` (or the newest) instead of `failures[length - max]`: a blocked scope never records, so `failures.length <= maxFailures` always and the index is 0;
 *   (3) `length < max - 1` in the sliding branch: at length max-1 the index is -1, the blocker is `undefined`, the wait is NaN and `NaN > 0` is false - the same "allowed";
 *   (4) `check` without its `expire`: a stale failure gives `blocker + window - t <= 0`, which is "allowed" anyway (the stale failure is the oldest one, index 0);
 *   (5) `recordFailure` without its `expire`: the protocol is check-then-record, and `check` has just expired what it needed;
 *   (6) looking up a `null` key in `check`: a null key is never stored, so `Map.get(null)` is always undefined;
 *   (7) `sweep` dropping a key inside a cooldown: during a cooldown the key holds at least `maxFailures` failures, so it is never "empty" and the `blockedUntil` half is redundant.
 *
 * The clock is injected (`now`), so nothing here reads the wall clock in a test. Memory is bounded: `sweep()` drops every key whose failures have all left the window and whose
 * block is over; the owner calls it on an unref'd interval. This module never sees a code and logs nothing.
 */
export interface AttemptScope {
  /** The name callers use in the `keys` object. */
  name: string;
  maxFailures: number;
  windowMs: number;
  /** 0 = a sliding limit; otherwise the block length once `maxFailures` is reached. */
  cooldownMs: number;
}

export type AttemptKeys = Record<string, string | null | undefined>;

export type AttemptCheck = { allowed: true } | { allowed: false; retryAfterMs: number };

interface KeyState {
  /** Times of the failures still inside the window, oldest first. */
  failures: number[];
  /** While `cooldownMs > 0`: the instant the current block ends, or 0. */
  blockedUntil: number;
}

export class AttemptLimiter {
  private readonly states = new Map<string, Map<string, KeyState>>();

  constructor(
    private readonly scopes: readonly AttemptScope[],
    private readonly now: () => number = Date.now
  ) {
    for (const scope of scopes) this.states.set(scope.name, new Map());
  }

  /** Whether an attempt may proceed. Never records anything. */
  check(keys: AttemptKeys): AttemptCheck {
    const t = this.now();
    let retryAfterMs = 0;
    for (const scope of this.scopes) {
      const key = keys[scope.name];
      if (key === null || key === undefined) continue;
      const state = this.states.get(scope.name)?.get(key);
      if (!state) continue;
      this.expire(scope, state, t);
      const wait = this.waitFor(scope, state, t);
      if (wait > retryAfterMs) retryAfterMs = wait;
    }
    return retryAfterMs > 0 ? { allowed: false, retryAfterMs } : { allowed: true };
  }

  /** Records one failed attempt in every scope whose key is given. Call it only for an attempt that `check` let through. */
  recordFailure(keys: AttemptKeys): void {
    const t = this.now();
    for (const scope of this.scopes) {
      const key = keys[scope.name];
      if (key === null || key === undefined) continue;
      const byKey = this.states.get(scope.name) as Map<string, KeyState>;
      let state = byKey.get(key);
      if (!state) {
        state = { failures: [], blockedUntil: 0 };
        byKey.set(key, state);
      }
      this.expire(scope, state, t);
      if (this.waitFor(scope, state, t) > 0) continue; // already blocked: a refused attempt is never recorded, so hammering a block does not extend it
      state.failures.push(t);
      if (scope.cooldownMs > 0 && state.failures.length >= scope.maxFailures) state.blockedUntil = t + scope.cooldownMs;
    }
  }

  /** Drops the state of every key with nothing left to remember; returns how many keys were dropped. */
  sweep(): number {
    const t = this.now();
    let dropped = 0;
    for (const scope of this.scopes) {
      const byKey = this.states.get(scope.name) as Map<string, KeyState>;
      for (const [key, state] of byKey) {
        this.expire(scope, state, t);
        if (state.failures.length === 0 && state.blockedUntil <= t) {
          byKey.delete(key);
          dropped++;
        }
      }
    }
    return dropped;
  }

  /** How many keys are being remembered (a test and a metric; never a secret). */
  size(): number {
    let n = 0;
    for (const byKey of this.states.values()) n += byKey.size;
    return n;
  }

  /** Forgets failures that left the window; a finished cooldown clears the whole history. */
  private expire(scope: AttemptScope, state: KeyState, t: number): void {
    if (scope.cooldownMs > 0 && state.blockedUntil > 0 && t >= state.blockedUntil) {
      state.failures = [];
      state.blockedUntil = 0;
      return;
    }
    const oldestCounted = t - scope.windowMs; // a failure counts while its time is strictly greater
    let drop = 0;
    while (drop < state.failures.length && state.failures[drop] <= oldestCounted) drop++;
    if (drop > 0) state.failures = state.failures.slice(drop);
  }

  /** Milliseconds until the scope allows an attempt again (0 = allowed now). */
  private waitFor(scope: AttemptScope, state: KeyState, t: number): number {
    if (scope.cooldownMs > 0) return state.blockedUntil > t ? state.blockedUntil - t : 0;
    if (state.failures.length < scope.maxFailures) return 0;
    // sliding: allowed again once the (count - max + 1)-th oldest failure has left the window
    const blocker = state.failures[state.failures.length - scope.maxFailures];
    return blocker + scope.windowMs - t;
  }
}
