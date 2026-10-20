import { Router } from 'express';
import type { FourHandlerDeps } from './fourPlayerHandlers.js';
import { deserialize, rulesFor, serialize } from './fourPlayer/index.js';
import type { FourVariant } from './fourPlayerWire.js';

/**
 * TEST-ONLY SWITCHES of the 4-seat server (Chaturaji W5), for the browser end-to-end suite (scripts/e2e-browser). Both follow the rule of the login rate-limit override
 * (src/lib/authRateLimit.ts, CHECKLIST.md section 7): an explicit opt-in variable whose name says what it does, NO effect when NODE_ENV is "production" (one startup warning that
 * does not print the value), a validated value, set only by the e2e stack's own child process - never in a workflow, `.env.example` or a deployment config. With neither set the server
 * is exactly what it was: `seededFourDeps(null)` is `{}` and the setup router is not mounted at all.
 *
 *   FOUR_TEST_SEED=<n>              seeds the room manager's engine and bot randomness and the seat shuffle (mulberry32), so the bots' play is a function of the position.
 *   FOUR_TEST_SETUP_ENDPOINT=enabled   mounts POST /test-setup/four-start, which arms ONE start position for the next room of a variant (loopback callers only).
 *
 * This module reads exactly these two variables and NODE_ENV, and logs no secret and no value.
 */
export const FOUR_TEST_SEED_VAR = 'FOUR_TEST_SEED';
export const FOUR_TEST_SETUP_VAR = 'FOUR_TEST_SETUP_ENDPOINT';
export const FOUR_TEST_SEED_MAX = 2147483647;

type Env = Record<string, string | undefined>;

/** The seed in force for `env`, or null (the production default: real randomness). */
export function resolveFourTestSeed(env: Env = process.env, warn: (message: string) => void = console.warn): number | null {
  const raw = env.FOUR_TEST_SEED;
  if (raw === undefined) return null;
  if (env.NODE_ENV === 'production') {
    warn('[four] FOUR_TEST_SEED is set but NODE_ENV is "production": ignoring it, the 4-seat games use real randomness.');
    return null;
  }
  const seed = /^\d+$/.test(raw) ? Number(raw) : 0;
  if (seed < 1 || seed > FOUR_TEST_SEED_MAX) {
    warn(`[four] FOUR_TEST_SEED is not a whole number in 1..${FOUR_TEST_SEED_MAX}: ignoring it, the 4-seat games use real randomness.`);
    return null;
  }
  return seed;
}

/** Whether the test-setup endpoint is mounted: only outside production, only when the variable is exactly "enabled". */
export function resolveFourTestSetup(env: Env = process.env, warn: (message: string) => void = console.warn): boolean {
  const raw = env.FOUR_TEST_SETUP_ENDPOINT;
  if (raw === undefined) return false;
  if (env.NODE_ENV === 'production') {
    warn('[four] FOUR_TEST_SETUP_ENDPOINT is set but NODE_ENV is "production": ignoring it, the test-setup endpoint is not mounted.');
    return false;
  }
  if (raw !== 'enabled') {
    warn('[four] FOUR_TEST_SETUP_ENDPOINT is not "enabled": ignoring it, the test-setup endpoint is not mounted.');
    return false;
  }
  return true;
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

/** The handler dependencies that seed the 4-seat randomness; `{}` (nothing injected, `Math.random` and the crypto shuffle as always) for a null seed. */
export function seededFourDeps(seed: number | null): Pick<FourHandlerDeps, 'roomOptions' | 'matchmakerOptions'> {
  if (seed === null) return {};
  const engine = mulberry32(seed);
  const bots = mulberry32(seed + 1);
  const shuffle = mulberry32(seed + 2);
  return { roomOptions: { rng: engine, botRng: bots }, matchmakerOptions: { randomInt: (maxExclusive: number) => Math.floor(shuffle() * maxExclusive) } };
}

/** Start positions armed through the endpoint: one per variant, consumed by the next room of that variant. */
export class FourStartSnapshots {
  private readonly armed = new Map<FourVariant, string>();
  arm(variant: FourVariant, snapshot: string): void {
    this.armed.set(variant, snapshot);
  }
  take(variant: FourVariant): string | undefined {
    const snapshot = this.armed.get(variant);
    this.armed.delete(variant);
    return snapshot;
  }
  has(variant: FourVariant): boolean {
    return this.armed.has(variant);
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** POST /test-setup/four-start {variant, snapshot}: validates the snapshot against the variant's rules (it must parse back to itself and not be over) and arms it. */
export function createFourTestSetupRouter(snapshots: FourStartSnapshots): Router {
  const router = Router();
  router.post('/four-start', (req, res) => {
    if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) {
      res.status(403).json({ error: 'Loopback callers only.' });
      return;
    }
    const body = (req.body ?? {}) as { variant?: unknown; snapshot?: unknown };
    const variant = body.variant === 'chaturaji' || body.variant === 'giveaway' || body.variant === 'ffa' ? body.variant : null;
    if (variant === null || typeof body.snapshot !== 'string') {
      res.status(400).json({ error: 'Expected { variant: "ffa" | "giveaway" | "chaturaji", snapshot: string }.' });
      return;
    }
    try {
      const rules = rulesFor(variant);
      const state = deserialize(body.snapshot, rules);
      if (serialize(state) !== body.snapshot || state.result) throw new Error('not a live position');
    } catch {
      res.status(400).json({ error: 'The snapshot is not a live position of that variant.' });
      return;
    }
    snapshots.arm(variant, body.snapshot);
    res.json({ ok: true });
  });
  return router;
}
