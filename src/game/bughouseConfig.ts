/**
 * Bughouse ONLINE - server tunables (hand-written; the limits that CLIENT AND SERVER share - the six time controls, the chat length, the id length, the ten quick-message codes -
 * live in the generated `bughouse/wire.ts`, one definition for both sides). See BUGHOUSE_SPEC.md HP2, HP5, HP10 and decisions B17, B19, B22.
 *
 * The numbers deliberately mirror the 4-seat games' (fourPlayerConfig.ts) where the spec says "as the 4-seat games" - the same 45 s grace, 30 s fill wait, 5-minute retention - but are
 * NEW constants here: fourPlayerConfig.ts is not touched by Bughouse, so a change to one mode's number can never move the other's.
 */

/** How long a finished match's RESULT stays available to a late `bug_rejoin` (B22). */
export const BUG_FINISHED_RETENTION_MS = 5 * 60 * 1000;

/** Team chat: a seat may send at most one line per this long (the same limit as the 4-seat chat). */
export const BUG_CHAT_MIN_INTERVAL_MS = 1000;

/** Quick messages (HP10): at most one per 1.5 s and 8 per 10 s per seat; the same code again within 1 s is a duplicate. Excess is refused, never queued. */
export const BUG_QUICK_MIN_INTERVAL_MS = 1500;
export const BUG_QUICK_WINDOW_MS = 10_000;
export const BUG_QUICK_WINDOW_MAX = 8;
export const BUG_QUICK_DUPLICATE_MS = 1000;

/** `bug_move` / `bug_drop` rate limit per seat: at most `max` calls (legal or not) in any `windowMs`. */
export const BUG_ACTION_RATE_LIMIT = { windowMs: 1000, max: 10 } as const;

/** Display names are cut to this length. */
export const BUG_NAME_MAX_LENGTH = 40;

/** How long a disconnected human's seat is left alone (its clock keeps running) before a bot takes it over (B19). The human can take it back by rejoining until the match ends. */
export const BUG_TAKEOVER_GRACE_MS = 45_000;

/** How long a match with no original human connected is kept before it ends `voided` (rule 22). */
export const BUG_ALL_GONE_MS = 45_000;

/** The strength of a bot that FILLS a seat or TAKES OVER one: fixed Amateur for v1. The bot's cost does not grow with the strength dial (bughouse/bot.ts), so there is no clamp. */
export const BUG_BOT_ELO = 1200;
export const BUG_BOT_NAME = 'Bot (Amateur)';

/** A bot "thinks" this long before moving (pacing only - the decision itself takes a few milliseconds): the local game's own values. */
export const BUG_BOT_THINK_MS = 450;
export const BUG_BOT_THINK_BULLET_MS = 200;
/** The Bughouse bullet controls are 1 min and 2 | 1: "bullet" is an initial time of at most this. */
export const BUG_BULLET_MAX_INITIAL_MS = 120_000;

/** A game needs at least this many humans to start (B17); the empty seats are filled with bots. Four humans start at once. */
export const BUG_MIN_HUMANS = 2;
/** How long the lobby of one time control waits, measured from the moment it first holds BUG_MIN_HUMANS, before the bots fill the rest. */
export const BUG_FILL_WAIT_MS = 30_000;
/** The largest `FOUR_FILL_MS` / `FOUR_GRACE_MS` override that is honoured (a typo like 3000000 must not silently make a lobby wait 50 minutes). */
export const BUG_OVERRIDE_MAX_MS = 600_000;

/** Each spectator costs one send per state, so a room has a ceiling. A spectator already watching a room is never refused by it. */
export const BUG_MAX_SPECTATORS_PER_ROOM = 50;
/** The active-games list is newest first and at most this long. */
export const BUG_ACTIVE_GAMES_LIST_MAX = 100;

/**
 * The rule behind the two timing overrides (a test/dev convenience, never a production knob; the rule of fourPlayerConfig.ts `envMsOverride`, CHECKLIST.md section 7):
 * `env[name]` is honoured ONLY when NODE_ENV is not 'production', ONLY for a plain decimal whole number of milliseconds, and ONLY in 1..max. Anything else - unset, production,
 * " 3000", "3e3", "0x10", "-5", "0", "1.5", "", too large - gives `fallback`.
 *
 * NO NEW VARIABLE. Bughouse reads the 4-seat games' two EXISTING overrides, `FOUR_FILL_MS` and `FOUR_GRACE_MS` (the real-socket tests already start their dev server with them), so that
 * Bughouse adds nothing to any workflow, `.env.example` or deployment config: CHECKLIST.md section 7 says a test-only switch is set only by the test stack's own process, and the one
 * new switch Bughouse does add - the seed, in bughouseTestSwitches.ts - follows that rule to the letter. The PRODUCTION numbers stay separate constants (45 s, 30 s).
 */
function envMsOverride(env: Record<string, string | undefined>, name: string, fallback: number, max: number): number {
  const raw = env[name];
  if (env.NODE_ENV === 'production' || raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) return fallback;
  const ms = Number(raw);
  return ms >= 1 && ms <= max ? ms : fallback;
}

/** The fill wait: BUG_FILL_WAIT_MS (30 s), unless `FOUR_FILL_MS=<ms>` says otherwise (never in production). */
export function resolveBugFillWaitMs(env: Record<string, string | undefined> = process.env): number {
  return envMsOverride(env, 'FOUR_FILL_MS', BUG_FILL_WAIT_MS, BUG_OVERRIDE_MAX_MS);
}

/** The takeover grace: BUG_TAKEOVER_GRACE_MS (45 s), unless `FOUR_GRACE_MS=<ms>` says otherwise (never in production). It exists so the real-socket tests can watch a disconnect -> takeover -> retake without waiting 45 s. */
export function resolveBugGraceMs(env: Record<string, string | undefined> = process.env): number {
  return envMsOverride(env, 'FOUR_GRACE_MS', BUG_TAKEOVER_GRACE_MS, BUG_OVERRIDE_MAX_MS);
}

/** The pause before a bot's move, by time control (bullet is quicker). */
export function bugBotThinkMs(initialMs: number): number {
  return initialMs <= BUG_BULLET_MAX_INITIAL_MS ? BUG_BOT_THINK_BULLET_MS : BUG_BOT_THINK_MS;
}

/** "3 min", "3 | 2" - the label the lists and the queue screen show. */
export function bugTimeControlLabel(initialMs: number, incrementMs: number): string {
  return incrementMs > 0 ? `${initialMs / 60000} | ${incrementMs / 1000}` : `${initialMs / 60000} min`;
}
