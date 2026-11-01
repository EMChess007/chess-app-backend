import type { BugHandlerDeps } from './bughouseHandlers.js';

/**
 * TEST-ONLY SWITCH of the Bughouse server (W2), for the real-socket suites. It follows the rule of the login rate-limit override (src/lib/authRateLimit.ts) and of the 4-seat switches
 * (src/game/fourTestSwitches.ts), CHECKLIST.md section 7: an explicit opt-in variable whose name says what it does, NO effect when NODE_ENV is "production" (one startup warning that does
 * not print the value), a validated value, set only by the e2e stack's own child process - never in a workflow, `.env.example` or a deployment config. With it unset the server is exactly
 * what it was: `seededBughouseDeps(null)` is `{}`.
 *
 *   BUGHOUSE_TEST_SEED=<n>   seeds the bots' randomness and the seat shuffle (mulberry32), so a bot's play is a function of the position and the seats are placed reproducibly.
 *
 * This module reads exactly this variable and NODE_ENV, and logs no secret and no value. (The two timing overrides are the 4-seat games' existing FOUR_FILL_MS and FOUR_GRACE_MS, read by
 * bughouseConfig.ts under the same rule: Bughouse adds no other variable.)
 */
export const BUGHOUSE_TEST_SEED_VAR = 'BUGHOUSE_TEST_SEED';
export const BUGHOUSE_TEST_SEED_MAX = 2147483647;

type Env = Record<string, string | undefined>;

/** The seed in force for `env`, or null (the production default: real randomness). */
export function resolveBughouseTestSeed(env: Env = process.env, warn: (message: string) => void = console.warn): number | null {
  const raw = env.BUGHOUSE_TEST_SEED;
  if (raw === undefined) return null;
  if (env.NODE_ENV === 'production') {
    warn('[bughouse] BUGHOUSE_TEST_SEED is set but NODE_ENV is "production": ignoring it, the Bughouse games use real randomness.');
    return null;
  }
  const seed = /^\d+$/.test(raw) ? Number(raw) : 0;
  if (seed < 1 || seed > BUGHOUSE_TEST_SEED_MAX) {
    warn(`[bughouse] BUGHOUSE_TEST_SEED is not a whole number in 1..${BUGHOUSE_TEST_SEED_MAX}: ignoring it, the Bughouse games use real randomness.`);
    return null;
  }
  return seed;
}

/**
 * W6, the second Bughouse test-only switch: `BUGHOUSE_ROOM_TTL_TEST_MS=<ms>` SHORTENS the life of a friend-room code (10 minutes) so a browser or phone run can watch an expiry in seconds. Same
 * rule (CHECKLIST.md section 7): ignored when NODE_ENV is "production" (one warning, the value is not printed), only a plain decimal whole number inside 1000..600000 (it can shorten the life,
 * never lengthen it past the production 10 minutes and never switch expiry off), set only by the test stack's own child process. Unset: the production life, exactly as before.
 */
export const BUGHOUSE_ROOM_TTL_VAR = 'BUGHOUSE_ROOM_TTL_TEST_MS';
export const BUGHOUSE_ROOM_TTL_MIN_MS = 1000;
export const BUGHOUSE_ROOM_TTL_MAX_MS = 600_000;

/** The room life in force for `env`: BUG_ROOM_TTL_MS (10 minutes) unless the override is honoured. */
export function resolveBugRoomTtlMs(env: Env = process.env, warn: (message: string) => void = console.warn): number {
  const raw = env.BUGHOUSE_ROOM_TTL_TEST_MS;
  if (raw === undefined) return BUGHOUSE_ROOM_TTL_MAX_MS;
  if (env.NODE_ENV === 'production') {
    warn('[bughouse] BUGHOUSE_ROOM_TTL_TEST_MS is set but NODE_ENV is "production": ignoring it, friend-room codes live 10 minutes.');
    return BUGHOUSE_ROOM_TTL_MAX_MS;
  }
  const ms = /^\d+$/.test(raw) ? Number(raw) : 0;
  if (ms < BUGHOUSE_ROOM_TTL_MIN_MS || ms > BUGHOUSE_ROOM_TTL_MAX_MS) {
    warn(`[bughouse] BUGHOUSE_ROOM_TTL_TEST_MS is not a whole number of milliseconds in ${BUGHOUSE_ROOM_TTL_MIN_MS}..${BUGHOUSE_ROOM_TTL_MAX_MS}: ignoring it, friend-room codes live 10 minutes.`);
    return BUGHOUSE_ROOM_TTL_MAX_MS;
  }
  return ms;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The handler dependencies that seed the Bughouse randomness; `{}` (nothing injected, `Math.random` and the crypto shuffle as always) for a null seed. */
export function seededBughouseDeps(seed: number | null): Pick<BugHandlerDeps, 'roomOptions' | 'matchmakerOptions'> {
  if (seed === null) return {};
  const bots = mulberry32(seed + 1);
  const shuffle = mulberry32(seed + 2);
  return { roomOptions: { botRng: bots }, matchmakerOptions: { randomInt: (maxExclusive: number) => Math.floor(shuffle() * maxExclusive) } };
}
