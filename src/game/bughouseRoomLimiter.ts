import { AttemptLimiter, type AttemptScope } from '../lib/attemptLimiter.js';

/**
 * The attempt limits of the Bughouse friend-room join (BUGHOUSE_SPEC.md HP11), built on the shared `AttemptLimiter` (the module the 2-player `join_challenge` uses). The numbers are the
 * spec's, written out here as literals (a test pins each):
 *   - per SOCKET: 5 failures in 5 minutes, then a 5-minute cooldown;
 *   - per USER (a logged-in account, any socket): 10 failures in 15 minutes;
 *   - per client ADDRESS (src/lib/clientIp.ts): 30 failures in 15 minutes.
 * Only FAILED joins count; a successful join counts for nothing and resets nothing. A code never reaches this module and nothing here logs.
 */
export const BUG_ROOM_JOIN_SCOPES: readonly AttemptScope[] = [
  { name: 'socket', maxFailures: 5, windowMs: 5 * 60 * 1000, cooldownMs: 5 * 60 * 1000 },
  { name: 'user', maxFailures: 10, windowMs: 15 * 60 * 1000, cooldownMs: 0 },
  { name: 'ip', maxFailures: 30, windowMs: 15 * 60 * 1000, cooldownMs: 0 },
];

/** The process-wide cap on open rooms (HP11: "for example 500"). */
export const BUG_ROOM_CAP = 500;

/** How often expired rooms and remembered keys with nothing left to remember are dropped (the challenge manager's interval). */
export const BUG_ROOM_SWEEP_MS = 5 * 60 * 1000;

export function createBugRoomJoinLimiter(now: () => number = Date.now): AttemptLimiter {
  return new AttemptLimiter(BUG_ROOM_JOIN_SCOPES, now);
}
