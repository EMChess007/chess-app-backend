// GENERATED FILE - DO NOT EDIT BY HAND.
// Source: src/logic/fourPlayer/chaturajiBot.ts in the EM-Chess app repo. Regenerate with `npm run sync:fourplayer`; CI runs it with --check.
// The only difference from the source is that relative imports carry the '.js' suffix NodeNext requires.

/**
 * Chaturaji - the bot (workstream W2; CHATURAJI_SPEC.md section 7). Like the 4 Player Chess bot (bot.ts) and the Giveaway bot (giveawayBot.ts) it is a small
 * heuristic, NOT Stockfish (which cannot play a 4-seat game), driven by the SAME ELO dial: `botStrength(elo)` decides `bestChance` (the probability of
 * playing the scored choice at all, else a uniformly random legal move), `noise` (random wobble added to every candidate's score) and the tier. So the roster
 * bots (Kiddo 400 ... The Unbeatable 3000), the setup picker and the online "Bot (Amateur)" fill work unchanged. It is a first version, deliberately: like the
 * other variants' bots it is "a heuristic to be tuned later", not a calibrated opponent. Deterministic for a given rng (the only source of randomness).
 *
 * WHAT CHATURAJI ASKS OF A BOT (Capture the King, points, no mate):
 *   - POINTS are the whole game: a capture scores its piece value (pawn 1, knight 3, bishop 5, boat 5), a KING capture 3 AND eliminates a rival, a check fork
 *     +1 / +5; inactive pieces score 0. A move is scored by the points it wins and the material it changes (the 4 Player Chess evaluation, `evaluate`).
 *   - A CHECK NEEDS NO ANSWER, but a king that can be captured WILL be captured: the careful tier does not "get out of check", it looks at what the next
 *     active seat can capture after the move and prices a king at KING_LOSS (an elimination, far more than the 3 points it scores the capturer). So it
 *     ignores an attack that costs nothing, answers one that does (by moving the king, capturing the attacker or blocking), and never walks its king into a capture.
 *   - A PIECE THE NEXT SEAT CAN TAKE costs its value unless I can take back (then only the difference): the "hanging piece" term, exact for the one seat that
 *     answers before I move again (the other two move in between in ways nobody can predict - the same reason the other bots look at one seat only).
 *   - THE END: a capture that ENDS the game (the last rival's king) is simulated with the engine and priced by who wins: +END_WIN when I am among the winners
 *     (the +3 per surviving king for the last seat is already in the engine's final score), -END_LOSS when I would hand the win to someone else on points.
 *   - PROMOTION: a pawn on the far edge becomes a boat (5 instead of 1); the careful tier adds a bonus and the evaluation rewards every step towards it.
 * TIERS: greedy (elo < 1000) sees points and material only - it will hang its king; careful (elo >= 1000) adds the reply term, the king threat bonus, the
 * end-of-game pricing and the promotion bonus. There is NO deep tier in v1 (decision C12): `deep` plays as careful, so one decision stays a few move
 * generations (the server clamp FOUR_SERVER_BOT_MAX_ELO stays, but never binds for this variant).
 */

import { nextSeat, type Seat } from './board.js';
import { botStrength, evaluate } from './bot.js';
import { playMove } from './elimination.js';
import { FLAG_PROMOTION, applyMoveRaw, attackers, kingsAttackedBy, legalMoves, type Move } from './moves.js';
import { CAPTURE_POINTS, KING, geometryOf, optionsOf, seatOf, typeOf, type FourPlayerState, type SeatStatus } from './state.js';

type Rng = () => number;

/** What losing a king costs its owner, in points: an elimination (the capturer scores only `kingPoints`, but the owner loses the rest of the game). */
export const KING_LOSS = 14;
/** Every tier: capturing a KING also puts a rival out (its army goes inactive and can no longer score for anyone), on top of the 3 points the king is worth. */
export const KING_CAPTURE_BONUS = 2;
/** Weight of the next seat's best capture in the score of a move (1 = "it will certainly play it"). */
export const REPLY_WEIGHT = 0.85;
/** Bonus for a move that ends the game with me among the winners / penalty when it ends it and I am not. */
export const END_WIN = 25;
export const END_LOSS = 25;
/** Careful tier: a small bonus per live enemy king the moved piece attacks (a threat the next seat has to notice), and for promoting. */
export const KING_THREAT = 0.3;
export const PROMOTION_BONUS = 0.5;

/** The next seat clockwise that is still active (the one who answers my move), or null when it is only me. */
function nextActive(state: FourPlayerState, me: Seat): Seat | null {
  let seat = nextSeat(me);
  for (let i = 0; i < 3; i++, seat = nextSeat(seat)) if (state.status[seat] === 'active') return seat;
  return null;
}

/** A status array in which only `seat` is active - makes `attackers` report only that seat's pieces (who DEFENDS a square). */
function onlyActive(seat: Seat): SeatStatus[] {
  return (['dead-king', 'dead-king', 'dead-king', 'dead-king'] as SeatStatus[]).map((s, i) => (i === seat ? 'active' : s));
}

/** What losing the piece `code` costs its owner, in points. */
const lossOf = (code: number): number => (typeOf(code) === KING ? KING_LOSS : CAPTURE_POINTS[typeOf(code)] ?? 0);

/**
 * The most the seat `next` can win from `me` with one capture right now: the value of my piece, less what I take back when I can recapture on that square
 * (then only the difference to the capturing piece), and a king at KING_LOSS (a king is never "defended": it is gone).
 */
export function worstReplyLoss(after: FourPlayerState, me: Seat, next: Seat): number {
  const geo = geometryOf(after.rules);
  const mine = onlyActive(me);
  let worst = 0;
  for (const reply of legalMoves(after, next)) {
    if (reply.captured === 0 || seatOf(reply.captured) !== me) continue;
    let loss = lossOf(reply.captured);
    if (typeOf(reply.captured) !== KING && attackers(after.cells, mine, reply.to, next, geo) !== 0) loss = Math.max(0, loss - lossOf(after.cells[reply.from]));
    if (loss > worst) worst = loss;
  }
  return worst;
}

/**
 * Picks a move for the seat to move, playing at the strength of a bot rated `elo` (see the file header). Returns null only if that seat has no legal move
 * (which cannot happen mid-game: the engine eliminates such a seat instead of handing it the turn).
 */
export function chooseChaturajiBotMove(state: FourPlayerState, elo: number, rng: Rng = Math.random): Move | null {
  if (state.result) return null; // a finished game has no move to choose
  const me = state.turn;
  const moves = legalMoves(state, me);
  if (moves.length === 0) return null;
  const pick = <T>(list: T[]): T => list[Math.min(list.length - 1, Math.floor(rng() * list.length))];

  const strength = botStrength(elo);
  if (rng() >= strength.bestChance) return pick(moves); // the "weak moment": any legal move at all

  const careful = strength.tier !== 'greedy'; // 'deep' plays as careful: there is no deep tier
  const scored = scoreMoves(state, moves, careful, strength.noise + 0.05, rng);

  // The best score wins; exact ties (only possible when the wobble draws are equal) are broken at random.
  const best = Math.max(...scored.map((s) => s.score));
  return pick(scored.filter((s) => s.score >= best - 1e-9)).move;
}

export interface ScoredMove {
  move: Move;
  score: number;
}

/**
 * The score of every move in `moves` (the legal moves of the seat to move), in order: the points it wins and the material it changes, plus - for the careful tier - what
 * the next seat can win back, the end of the game, a threat to a king and a promotion; then a random wobble of up to `wobble` (the rng is drawn once per move, in order).
 * Exported so that the weights can be pinned directly (a test compares the same move's score between the tiers, and with a nil wobble reads the exact value).
 */
export function scoreMoves(state: FourPlayerState, moves: readonly Move[], careful: boolean, wobble: number, rng: Rng): ScoredMove[] {
  const me = state.turn;
  const options = optionsOf(state.rules);
  const scored: ScoredMove[] = [];

  for (const move of moves) {
    const capturesKing = move.captured !== 0 && typeOf(move.captured) === KING;
    // A king capture eliminates a seat (and can end the game): simulate it with the engine so the position after it is the real one. Every other move is
    // applied raw (no turn passing) - the cheap path that covers all but a handful of the candidates.
    const applied = capturesKing ? playMove(state, move, () => 0) : null;
    const after = applied ? applied.state : applyMoveRaw(state, move);
    // (the material term is `evaluate(after)` in absolute terms: the position's own value before the move is the same constant for every candidate and cannot change a choice)
    let score = (after.score[me] - state.score[me]) * 1.5 + evaluate(after, me) + (capturesKing ? KING_CAPTURE_BONUS : 0);

    if (!applied && options.forkPoints) {
      const kings = kingsAttackedBy(after, move.to);
      score += (kings >= 3 ? options.forkPoints.triple : kings === 2 ? options.forkPoints.double : 0) * 1.5;
    }

    if (careful) {
      if (applied?.state.result) {
        score += applied.state.result.winners.includes(me) ? END_WIN : -END_LOSS;
      } else {
        const opponent = nextActive(after, me);
        if (opponent !== null) score -= REPLY_WEIGHT * worstReplyLoss(after, me, opponent);
        if (!applied) score += KING_THREAT * kingsAttackedBy(after, move.to);
      }
      if (move.flags & FLAG_PROMOTION) score += PROMOTION_BONUS;
    }
    scored.push({ move, score: score + rng() * wobble });
  }
  return scored;
}
