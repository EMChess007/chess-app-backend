import { AttemptLimiter, type AttemptScope } from '../lib/attemptLimiter.js';

/**
 * The attempt limits of the 2-player `join_challenge` event (the invite-code join), built on the shared `AttemptLimiter` so the Bughouse friend rooms reuse the same module.
 *
 *   - per SOCKET: 5 failures in 5 minutes, then a 5-minute cooldown;
 *   - per USER (a logged-in account, any socket): 10 failures in 15 minutes;
 *   - per client ADDRESS (see src/lib/clientIp.ts for how it is derived behind a proxy): 30 failures in 15 minutes.
 * Only FAILED attempts count; a successful join counts for nothing and resets nothing. Every refusal - a wrong or expired code, a malformed payload, a blocked scope - answers
 * with the ONE message below, so the answer is no oracle for which of those it was; a code is never logged and never reaches the limiter.
 */
export const JOIN_REFUSED_MESSAGE = 'That challenge code was not found or has expired.';

export const JOIN_CHALLENGE_SCOPES: readonly AttemptScope[] = [
  { name: 'socket', maxFailures: 5, windowMs: 5 * 60 * 1000, cooldownMs: 5 * 60 * 1000 },
  { name: 'user', maxFailures: 10, windowMs: 15 * 60 * 1000, cooldownMs: 0 },
  { name: 'ip', maxFailures: 30, windowMs: 15 * 60 * 1000, cooldownMs: 0 },
];

/** How often remembered keys with nothing left to remember are dropped. */
export const JOIN_LIMITER_SWEEP_MS = 5 * 60 * 1000;

export function createJoinChallengeLimiter(now: () => number = Date.now): AttemptLimiter {
  return new AttemptLimiter(JOIN_CHALLENGE_SCOPES, now);
}
