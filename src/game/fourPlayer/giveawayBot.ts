// GENERATED FILE - DO NOT EDIT BY HAND.
// Source: src/logic/fourPlayer/giveawayBot.ts in the EM-Chess app repo. Regenerate with `npm run sync:fourplayer`; CI runs it with --check.
// The only difference from the source is that relative imports carry the '.js' suffix NodeNext requires.

/**
 * 4 Player Giveaway - the bot (workstream W2; design in FOUR_PLAYER_GIVEAWAY_SPEC.md section 6). Like the 4 Player Chess bot (bot.ts) it is a small
 * heuristic, NOT Stockfish (which cannot play a 4-seat game), driven by the SAME ELO dial: `botStrength(elo)` decides `bestChance` (the probability of
 * playing the scored choice at all, else a uniformly random legal move), `noise` (random wobble on every candidate's score) and the tier. So the
 * roster bots (Kiddo 400 ... The Unbeatable 3000), the setup screen's picker and the online "Bot (Amateur)" work unchanged. It is a first version,
 * deliberately: like the 2-player Giveaway bot it is "a heuristic to be tuned later", not a calibrated opponent.
 *
 * WHAT A GIVEAWAY BOT WANTS. To lose all its pieces (or to be stuck on its own turn), while NOT handing someone else the win. The candidate list it
 * receives is already the legal set, i.e. the captures when it has any (forced) - its choices are WHICH capture, or which quiet move. Only the next
 * ACTIVE seat answers before it moves again (the other two move in between in ways nobody can predict), so, as in bot.ts, it looks at that one seat.
 *   score(move) = EXPOSURE  - the own pieces the next seat can capture after the move: +1 for each (a captured piece is a step towards winning) plus a
 *                             tiny value tiebreak (a loose queen is slightly better to lose than a loose pawn: it is the piece that keeps making captures forced)
 *               - HAND_WIN  (careful tier) if the move wins the game for someone else: it captures a seat's last piece (that seat wins at once) or leaves the
 *                             next seat with no legal move (it is stuck, and wins)
 *               - VICTIM    (careful tier) a small penalty for taking a piece from a seat that is close to running out (it is being helped towards the win)
 *               + noise.
 * TIERS: greedy (elo < 1000) sees only EXPOSURE - it will hand out wins; careful (elo >= 1000) adds the two penalties. There is no deep tier in v1
 * (decision D12), so one decision costs a few legal-move generations: the server clamp (FOUR_SERVER_BOT_MAX_ELO) stays but never binds for this variant.
 *
 * `chooseBotMoveFor` is the one entry point callers should use when they do not already know the variant: it dispatches on `state.rules.mode`, so the
 * server's default chooser and the local game can never put the Chess bot (which scores check and mate) on a Giveaway position.
 */

import { nextSeat, type Seat } from './board.js';
import { botStrength, chooseBotMove } from './bot.js';
import { piecesLeft } from './giveaway.js';
import { applyMoveRaw, legalMoves, type Move } from './moves.js';
import { seatOf, typeOf, type FourPlayerState } from './state.js';

type Rng = () => number;

/** Value of a piece type for the exposure tiebreak (index = type code; the king is an ordinary piece here; promoted pieces play like what they became). */
const VALUE = [0, 1, 3, 3.25, 5, 9, 4, 9, 3, 3.25, 5];
/** Handing someone the win dwarfs every other term. */
export const HAND_WIN = 30;
/** Weight of the "tiny value tiebreak" inside EXPOSURE: even the biggest value gap (a queen against a pawn) stays well under ONE extra exposed piece. */
export const VALUE_TIEBREAK = 0.02;

/** The next seat clockwise that is still active (the one who answers my move), or null when it is only me. */
function nextActive(state: FourPlayerState, me: Seat): Seat | null {
  let seat = nextSeat(me);
  for (let i = 0; i < 3; i++, seat = nextSeat(seat)) if (state.status[seat] === 'active') return seat;
  return null;
}

/**
 * The own pieces of `me` that `opponent` could capture next (distinct pieces), as a score: 1 per piece plus the value tiebreak. A piece attacked by
 * several of the opponent's pieces counts ONCE: distinct victims are distinct destination squares (an en passant lands on the empty passed square, so
 * it can never share a destination with an ordinary capture, and two pawns taking the same pawn en passant take the same victim).
 */
function exposure(replies: readonly Move[], me: Seat): number {
  const seen = new Set<number>();
  let score = 0;
  for (const reply of replies) {
    if (reply.captured === 0 || seatOf(reply.captured) !== me || seen.has(reply.to)) continue;
    seen.add(reply.to);
    score += 1 + VALUE_TIEBREAK * VALUE[typeOf(reply.captured)];
  }
  return score;
}

/**
 * Picks a move for the seat to move, playing at the strength of a bot rated `elo` (see the file header). Returns null only if that seat has no legal
 * move (which cannot happen mid-game: the engine ends the game when a seat is stuck instead of handing it the turn).
 */
export function chooseGiveawayFourBotMove(state: FourPlayerState, elo: number, rng: Rng = Math.random): Move | null {
  const me = state.turn;
  const moves = legalMoves(state, me);
  if (moves.length === 0) return null;
  const pick = <T>(list: T[]): T => list[Math.min(list.length - 1, Math.floor(rng() * list.length))];

  const strength = botStrength(elo);
  if (rng() >= strength.bestChance) return pick(moves); // the "weak moment": any legal move at all

  const careful = strength.tier !== 'greedy';
  const opponent = nextActive(state, me);
  const scored: { move: Move; score: number }[] = [];

  for (const move of moves) {
    const after = applyMoveRaw(state, move);
    let score = 0;
    let handsWin = false;
    if (opponent !== null) {
      const replies = legalMoves(after, opponent);
      score += exposure(replies, me);
      if (careful && replies.length === 0) handsWin = true; // the next seat would be stuck, which wins it the game
    }
    if (careful && move.captured !== 0) {
      const victim = seatOf(move.captured);
      const left = piecesLeft(after.cells)[victim];
      if (left === 0) handsWin = true; // I took the victim's last piece: it wins on the spot
      else score -= 4 / (1 + left); // closer to emptying a seat = closer to handing it the win
    }
    if (handsWin) score -= HAND_WIN;
    scored.push({ move, score: score + rng() * (strength.noise + 0.05) });
  }

  // EQUIVALENT-MUTANT NOTE (W2 set, "ties are not broken among the best" = taking the first best instead of a random one): the noise added above already makes
  // exact ties vanishingly rare (a float draw), so the random pick is a second line of defence - removing either the noise or this pick alone changes nothing
  // observable. (The noise is pinned separately: the careful bot's victim preference is only MID-DECISION because of it - see the test of that name.)
  const best = Math.max(...scored.map((s) => s.score));
  return pick(scored.filter((s) => s.score >= best - 1e-9)).move;
}

/** The bot for whatever game `state` is: the Giveaway heuristic for Giveaway, the 4 Player Chess bot otherwise. Same signature as both. */
export function chooseBotMoveFor(state: FourPlayerState, elo: number, rng: Rng = Math.random): Move | null {
  return state.rules.mode === 'giveaway' ? chooseGiveawayFourBotMove(state, elo, rng) : chooseBotMove(state, elo, rng);
}
