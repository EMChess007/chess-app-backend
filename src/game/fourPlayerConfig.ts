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
