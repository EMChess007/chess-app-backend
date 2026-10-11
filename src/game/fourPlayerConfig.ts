/**
 * 4 Player Chess ONLINE — server tunables (hand-written; the limits that CLIENT AND SERVER share - time-control range, chat length, id
 * length - live in the generated `fourPlayerWire.ts`, one definition for both sides). See FOUR_PLAYER_ONLINE_SPEC.md §2.
 *
 * Only the constants a workstream actually uses are here: the room manager's (W2) now; the bot / takeover / grace constants arrive with
 * the bot driver (W3) and the fill-wait / minimum-humans constants with the matchmaker (W4), so nothing sits in this file unused.
 */

/** How long a finished room's RESULT stays available to a late `four_rejoin`. Deliberately equal to the 2-player server's
 * FINISHED_RETENTION_MS (rooms.ts) - a test pins that, so the two modes never quietly diverge. Not imported from rooms.ts because that
 * module pulls in the database client. */
export const FOUR_FINISHED_RETENTION_MS = 5 * 60 * 1000;
/** How often finished-room records past their retention are dropped (an `unref()`'d interval; same approach as the 2-player manager). */
export const FOUR_FINISHED_SWEEP_INTERVAL_MS = 60 * 1000;

/** A seat may chat at most once per this long (the 2-player server has no limit; four recipients make one worthwhile). */
export const FOUR_CHAT_MIN_INTERVAL_MS = 1000;

/** `four_make_move` rate limit per seat: at most `max` calls (legal or not) in any `windowMs`. A human cannot play 10 moves a second, and
 * counting illegal attempts too stops a client from hammering the legality check. */
export const FOUR_MOVE_RATE_LIMIT = { windowMs: 1000, max: 10 } as const;

/** Display names are cut to this length (they come from usernames, which the account system already limits). */
export const FOUR_NAME_MAX_LENGTH = 40;

// --- Bots, takeover and abandonment (W3) ---------------------------------------------------------------------------------------------

/** How long a disconnected human's seat is left alone (its clock keeps running) before a bot takes it over. Same as the 2-player
 * abandonment grace. The human can retake the seat by rejoining at ANY time until the game ends. */
export const FOUR_TAKEOVER_GRACE_MS = 45_000;

/** How long a game with no original human connected is kept before it ends with NO RESULT (reason 'abandoned', no winners). */
export const FOUR_ALL_GONE_MS = 45_000;

/** The strength of a bot that FILLS a seat or TAKES OVER one: fixed Amateur for v1, no scaling (decision A3). */
export const FOUR_BOT_ELO = 1200;

/**
 * The hard ceiling on any server bot's ELO. A bot decision runs SYNCHRONOUSLY on the event loop that serves every game; measured on the
 * 4-seat engine, the "careful" tier (ELO 1000-1799) tops out around 20 ms per decision while the "deep" tier (1800+) can hold the loop for
 * ~200 ms (spec section 6.3: 1700 -> max 18 ms, 1800 -> max 191 ms, 3000 -> max 210 ms). Clamping to the top of the careful tier gives the
 * same safety as a worker thread with none of its plumbing. A test asserts the clamp AND that this stays below the deep tier.
 */
export const FOUR_SERVER_BOT_MAX_ELO = 1700;

/** A bot "thinks" this long before moving (pacing only - the decision itself takes about a millisecond): the local game's own values. */
export const FOUR_BOT_THINK_MS = 450;
export const FOUR_BOT_THINK_BULLET_MS = 200;
/** The app's Bullet presets are 1 and 2 minutes; the server only knows `initialSeconds`, so "bullet" is `<= 120`. */
export const FOUR_BULLET_MAX_INITIAL_SECONDS = 120;

/** Bots play with this delay when they are only finishing a game for the humans who are watching it (fast-forward): not zero work, but
 * one ply per timer tick, so the event loop is released between plies and one such game can never starve the others. */
export const FOUR_FAST_FORWARD_DELAY_MS = 0;

/** The pause before a bot's move, by time control (the local game's rule: bullet is quicker). */
export function fourBotThinkMs(initialSeconds: number): number {
  return initialSeconds <= FOUR_BULLET_MAX_INITIAL_SECONDS ? FOUR_BOT_THINK_BULLET_MS : FOUR_BOT_THINK_MS;
}
