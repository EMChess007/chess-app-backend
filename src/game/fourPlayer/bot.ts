// GENERATED FILE - DO NOT EDIT BY HAND.
// Source: src/logic/fourPlayer/bot.ts in the EM-Chess app repo. Regenerate with `npm run sync:fourplayer`; CI runs it with --check.
// The only difference from the source is that relative imports carry the '.js' suffix NodeNext requires.

/**
 * 4 Player Chess — the bot. Stockfish cannot play this game (no 4-seat position, no UCI variant), so this is a small heuristic in the
 * same spirit as the other variants' bots in bots.ts (chooseGiveawayBotMove, chooseAtomicBotMove, chooseHordeBotMove, …), and strength
 * is driven by an ELO number in the same way: the named roster bot a player picks (Kiddo 400 … The Unbeatable 3000) is passed in as
 * `elo` and decides how good its play is. It is a heuristic dial, not a calibrated rating — 4-player games are never rated.
 *
 * STRENGTH FROM ELO (`botStrength`) has three layers, all continuous or monotonic in the ELO:
 *  1. bestChance = 0.2 + 0.7 * clamp((elo - 400) / 2600): the chance of playing the bot's SCORED choice at all; otherwise it plays a
 *     uniformly random legal move (the exact family used by the other variants' bots: ~20% at 400, ~90% at 3000).
 *  2. noise = 2.5 * (1 - strength): random wobble added to every candidate's score, so a weak bot's "best" move is a plausible but
 *     often second-rate one rather than the true best (0 at 3000).
 *  3. a search TIER that decides what the scored choice can see:
 *       greedy  (elo < 1000): one ply — points won and material change only (it will hang pieces and walk into mates);
 *       careful (1000 <= elo < 1800): one ply plus a hanging-piece penalty, a castling nudge, and it spots mating/stalemating the
 *               next seat;
 *       deep    (elo >= 1800): two ply — assumes the next ACTIVE seat's worst reply for it, including being checkmated by it.
 *     (The other two seats move in between in ways nobody can predict, so they are covered only by the hanging-piece term.)
 *
 * Material is measured over ACTIVE seats only: an eliminated seat's pieces are dead, worth nothing to anyone, and a bot gets no credit
 * for "ganging up" on a corpse.
 */

import { forwardCoord, nextSeat, type Seat } from './board.js';
import { FLAG_CASTLE, FLAG_PROMOTION, applyMoveRaw, attackers, isInCheck, legalMoves, type Move } from './moves.js';
import { PAWN, seatOf, typeOf, type FourPlayerState, type SeatStatus } from './state.js';

type Rng = () => number;
export type BotTier = 'greedy' | 'careful' | 'deep';

export interface BotStrength {
  /** Probability of playing the scored choice instead of a random legal move. */
  bestChance: number;
  /** Amplitude of the random wobble added to each candidate's score (in pawns). */
  noise: number;
  tier: BotTier;
}

/** ELO below which a bot only sees points and material (greedy), and from which it looks two ply ahead (deep). */
export const CAREFUL_FROM_ELO = 1000;
export const DEEP_FROM_ELO = 1800;

/** Maps a roster ELO (400..3000, clamped outside) to how the bot plays — see the file header. */
export function botStrength(elo: number): BotStrength {
  const strength = Math.min(1, Math.max(0, (elo - 400) / 2600));
  return {
    bestChance: 0.2 + 0.7 * strength,
    noise: 2.5 * (1 - strength),
    tier: elo < CAREFUL_FROM_ELO ? 'greedy' : elo < DEEP_FROM_ELO ? 'careful' : 'deep',
  };
}

/** Material value by piece type (index = type code): P, N, B, R, Q, K (never counted), then promoted Q, N, B, R (worth what they play like). */
const VALUE = [0, 1, 3, 3.25, 5, 9, 0, 9, 3, 3.25, 5];
const CHECKMATE_VALUE = 25;
const STALEMATE_VALUE = -6;

function materialBySeat(state: FourPlayerState): number[] {
  const mat = [0, 0, 0, 0];
  const cells = state.cells;
  for (let i = 0; i < cells.length; i++) {
    const code = cells[i];
    if (code <= 0) continue;
    const seat = seatOf(code);
    if (state.status[seat] !== 'active') continue;
    const type = typeOf(code);
    mat[seat] += VALUE[type];
    if (type === PAWN) mat[seat] += 0.04 * forwardCoord(seat, i); // a small reward for advancing pawns
  }
  return mat;
}

/** How good `state` is for `me`: its material against the average of the other ACTIVE seats'. */
export function evaluate(state: FourPlayerState, me: Seat): number {
  const mat = materialBySeat(state);
  let others = 0;
  let count = 0;
  for (let seat = 0; seat < 4; seat++) {
    if (seat !== me && state.status[seat] === 'active') {
      others += mat[seat];
      count++;
    }
  }
  return mat[me] - (count ? others / count : 0);
}

/** A status array in which only `seat` is active — makes `attackers` report only that seat's pieces (i.e. who DEFENDS a square). */
function onlyActive(seat: Seat): SeatStatus[] {
  return (['dead-king', 'dead-king', 'dead-king', 'dead-king'] as SeatStatus[]).map((s, i) => (i === seat ? 'active' : s));
}

/** The value of the piece that just moved to `to` if it can simply be taken (attacked by a live enemy and not defended), else 0. */
function hangingValue(state: FourPlayerState, to: number, me: Seat): number {
  if (attackers(state.cells, state.status, to, me) === 0) return 0;
  const defender = nextSeat(me); // any seat other than `me`, so that `me`'s pieces count as attackers of the square
  if (attackers(state.cells, onlyActive(me), to, defender) !== 0) return 0;
  return VALUE[typeOf(state.cells[to])];
}

/** The next seat clockwise that is still active (the one who actually answers my move), or null when it is only me. */
function nextActive(state: FourPlayerState, me: Seat): Seat | null {
  let seat = nextSeat(me);
  for (let i = 0; i < 3; i++, seat = nextSeat(seat)) if (state.status[seat] === 'active') return seat;
  return null;
}

/** One-ply score of `move` for `me`: points won and the material change, plus (careful and deep) hanging-piece, castling and promotion terms. */
function scoreMove(state: FourPlayerState, move: Move, me: Seat, baseEval: number, tier: BotTier): { score: number; after: FourPlayerState } {
  const after = applyMoveRaw(state, move);
  let score = (after.score[me] - state.score[me]) * 1.5 + (evaluate(after, me) - baseEval);
  if (tier !== 'greedy') {
    score -= hangingValue(after, move.to, me) * 0.8;
    if (move.flags & FLAG_CASTLE) score += 0.3;
    if (move.flags & FLAG_PROMOTION) score += 1;
  }
  return { score, after };
}

/**
 * Picks a move for the seat to move, playing at the strength of a bot rated `elo` (see the file header). Returns null only if that
 * seat has no legal move (which cannot happen mid-game: the engine resolves such seats before handing out the turn).
 */
export function chooseBotMove(state: FourPlayerState, elo: number, rng: Rng = Math.random): Move | null {
  const me = state.turn;
  const moves = legalMoves(state, me);
  if (moves.length === 0) return null;
  const pick = <T>(list: T[]): T => list[Math.min(list.length - 1, Math.floor(rng() * list.length))];

  const strength = botStrength(elo);
  if (rng() >= strength.bestChance) return pick(moves); // the "weak moment": any legal move at all

  const baseEval = evaluate(state, me);
  const opponent = strength.tier === 'greedy' ? null : nextActive(state, me);
  const scored: { move: Move; score: number }[] = [];

  for (const move of moves) {
    const { score: oneply, after } = scoreMove(state, move, me, baseEval, strength.tier);
    let score = oneply;

    if (opponent !== null) {
      const replies = legalMoves(after, opponent);
      if (replies.length === 0) {
        // The next seat cannot move at all: checkmated (if attacked) or stalemated.
        score += isInCheck(after, opponent) ? CHECKMATE_VALUE : STALEMATE_VALUE;
      } else if (strength.tier === 'deep') {
        // Assume the next seat's reply that is worst for me (careful stops at the one-ply score above).
        let worst = Infinity;
        for (const reply of replies) {
          const afterReply = applyMoveRaw(after, reply);
          let value = evaluate(afterReply, me) - baseEval;
          if (isInCheck(afterReply, me) && legalMoves(afterReply, me).length === 0) value -= CHECKMATE_VALUE;
          if (value < worst) worst = value;
        }
        // Replace the one-ply material term with the worst-case one, keeping the points/hanging/castle terms.
        score = oneply - (evaluate(after, me) - baseEval) + worst;
      }
    }
    scored.push({ move, score: score + rng() * (strength.noise + 0.05) });
  }

  const best = Math.max(...scored.map((s) => s.score));
  return pick(scored.filter((s) => s.score >= best - 1e-9)).move;
}
