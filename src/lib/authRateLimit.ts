import { rateLimit } from 'express-rate-limit';

/**
 * The login / register rate limit (`app.use('/auth', authLimiter, ...)` in src/index.ts): 20 attempts per 15 minutes per address, answered with a 429 and the message below.
 *
 * TEST-ONLY OVERRIDE. The browser end-to-end tests (Chaturaji W4) register and log in a few dozen throw-away accounts from one address within minutes, far above 20. They start
 * their own private backend with `AUTH_RATE_LIMIT_TEST_OVERRIDE=<n>`, and that is the ONLY thing that raises the limit. It has an effect only when BOTH hold:
 *   - NODE_ENV is not "production", and
 *   - the variable is set to a plain decimal whole number in 1..AUTH_RATE_LIMIT_TEST_CEILING (so the limit is always finite: the override can raise it, never switch it off).
 * Set under NODE_ENV=production it is ignored and ONE warning is logged at startup (the value is never printed); set to anything else it is ignored with one warning too. This
 * module reads exactly two environment variables, NODE_ENV and AUTH_RATE_LIMIT_TEST_OVERRIDE, and logs no secret and no value.
 */
export const AUTH_RATE_LIMIT_DEFAULT = 20;
export const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const AUTH_RATE_LIMIT_MESSAGE = 'Too many attempts. Please try again later.';
export const AUTH_RATE_LIMIT_OVERRIDE_VAR = 'AUTH_RATE_LIMIT_TEST_OVERRIDE';
export const AUTH_RATE_LIMIT_TEST_CEILING = 1000;

/** The limit in force for `env`; `warn` is told (once per call) when the variable is set but ignored. */
export function resolveAuthRateLimit(env: Record<string, string | undefined> = process.env, warn: (message: string) => void = console.warn): number {
  const raw = env.AUTH_RATE_LIMIT_TEST_OVERRIDE;
  if (raw === undefined) return AUTH_RATE_LIMIT_DEFAULT;
  if (env.NODE_ENV === 'production') {
    warn(`[auth] AUTH_RATE_LIMIT_TEST_OVERRIDE is set but NODE_ENV is "production": ignoring it, the login limit stays ${AUTH_RATE_LIMIT_DEFAULT} per 15 minutes.`);
    return AUTH_RATE_LIMIT_DEFAULT;
  }
  const limit = /^\d+$/.test(raw) ? Number(raw) : 0;
  if (limit < 1 || limit > AUTH_RATE_LIMIT_TEST_CEILING) {
    warn(`[auth] AUTH_RATE_LIMIT_TEST_OVERRIDE is not a whole number in 1..${AUTH_RATE_LIMIT_TEST_CEILING}: ignoring it, the login limit stays ${AUTH_RATE_LIMIT_DEFAULT} per 15 minutes.`);
    return AUTH_RATE_LIMIT_DEFAULT;
  }
  return limit;
}

/** The limiter src/index.ts mounts on /auth. Keyed like every express-rate-limit default (the client address). */
export function createAuthLimiter(env: Record<string, string | undefined> = process.env, warn: (message: string) => void = console.warn) {
  return rateLimit({
    windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
    limit: resolveAuthRateLimit(env, warn),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: AUTH_RATE_LIMIT_MESSAGE },
  });
}
