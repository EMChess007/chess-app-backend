// GENERATED FILE - DO NOT EDIT BY HAND.
// Source: src/logic/fourPlayer/elimination.ts in the EM-Chess app repo. Regenerate with `npm run sync:fourplayer`; CI runs it with --check.
// The only difference from the source is that relative imports carry the '.js' suffix NodeNext requires.

/**
 * 4 Player Chess — turn passing, elimination and scoring (FFA). This is the part of the rules that has no 2-player analogue.
 *
 * THE KEY IDEA: CHECKMATE IS NEVER "PENDING" STATE — IT IS DETECTED LAZILY, WHEN THE MATED SEAT'S TURN ARRIVES.
 * After every applied move the turn passes clockwise to the next non-frozen seat (`advance`), and only THEN is that seat looked at:
 *   - ACTIVE seat with a legal move → it is simply its turn. (It may be in check; it must answer it.)
 *   - ACTIVE seat with NO legal move → in check = CHECKMATED, otherwise STALEMATED. It is eliminated on the spot, the elimination
 *     consumes its turn (it does not also move), and the loop carries on to the next seat.
 *   - DEAD-KING seat (eliminated earlier, king still walking) → the engine plays a random legal king move for it (empty squares only);
 *     with no legal move it FREEZES (checkmated or stalemated: no points either way) and is skipped from then on.
 *   - FROZEN seat → skipped.
 * (GIVEAWAY plays by different turn rules: no check, no mate, no stalemate-elimination, no walking dead kings - see giveaway.ts. The
 * functions below dispatch on `state.rules.mode`; the paragraphs here describe FFA.)
 *
 * Because nothing is decided until the mated seat's turn, every seat between the mating move and that turn gets to change the position:
 * a mate can dissolve (the checking piece is captured or blocked), or an intervening player can deliver the mate themselves — in that
 * case the credit goes to the seat that attacks the king and moved MOST RECENTLY before the mated seat's turn (`mateCredit`), not
 * necessarily to whoever first created the threat. Eliminating a seat also turns ITS pieces dead, which can lift checks on others,
 * which is why seats are evaluated one at a time, in order, rather than all at once.
 *
 * GAME END (FFA): as soon as at most ONE seat is still active (three eliminated), or when no checkmate is possible any more (every
 * active seat is a bare king — `isDeadPosition`), or the ply cap is reached. The winner(s) are the seat(s) with the HIGHEST SCORE
 * among all four (not only the survivor), ties shared.
 *
 * SCORING (simplified from chess.com's table; the numbers live in FourPlayerRules): capturing a live piece scores its value (pawn 1,
 * knight 3, bishop 5, rook 5, queen 9; a promoted piece is worth what it became, except the promoted queen: 1); dead pieces score 0; checkmating a seat +20 to the credited seat;
 * stalemating a seat gives the STALEMATED seat +20 and every other still-active seat +10. Not modelled: check-fork bonuses, draw
 * claims, points for mating an already-dead king.
 */

import { nextSeat, seatBefore, type Seat } from './board.js';
import { applyMoveRaw, attackers, kingsAttackedBy, legalMoves, type Move } from './moves.js';
import { capWinners, giveawayResult, seatOutOfPieces } from './giveaway.js';
import { activeSeats, geometryOf, HARD_MAX_PLIES, KING, optionsOf, seatOf, typeOf, type FourPlayerResult, type FourPlayerState, type SeatStatus } from './state.js';

/** `kingCaptured` is Capture the King's only way to be eliminated by an opponent: the seat's king was taken (`credit` = the capturer). */
export type EliminationReason = 'checkmate' | 'stalemate' | 'resign' | 'timeout' | 'kingCaptured';

export type GameEvent =
  | { kind: 'move'; seat: Seat; move: Move }
  | { kind: 'deadKingMove'; seat: Seat; move: Move }
  /** Check-fork points (`RuleOptions.forkPoints`): the mover's piece attacks `kings` (2 or 3) live enemy kings and scores `points` for it. */
  | { kind: 'fork'; seat: Seat; kings: number; points: number }
  | { kind: 'eliminated'; seat: Seat; reason: EliminationReason; credit: Seat | null; points: readonly number[] }
  | { kind: 'frozen'; seat: Seat }
  | { kind: 'gameOver'; result: FourPlayerResult };

export interface Applied {
  state: FourPlayerState;
  events: GameEvent[];
}

type Rng = () => number;

/** The seat credited with checkmating `seat`: walking BACKWARDS from it, the first live seat that currently attacks its king. */
export function mateCredit(state: FourPlayerState, seat: Seat): Seat | null {
  const king = state.kings[seat];
  if (king < 0) return null;
  const mask = attackers(state.cells, state.status, king, seat, geometryOf(state.rules));
  for (let steps = 1; steps <= 3; steps++) {
    const candidate = seatBefore(seat, steps);
    if (mask & (1 << candidate)) return candidate;
  }
  return null;
}

function withStatus(state: FourPlayerState, seat: Seat, status: SeatStatus): FourPlayerState {
  const next = state.status.slice();
  next[seat] = status;
  return { ...state, status: next };
}

/** Ends the game if at most one seat is still active, or if no checkmate is possible any more. */
function finishIfOver(state: FourPlayerState, events: GameEvent[]): FourPlayerState {
  if (state.result) return state;
  if (state.rules.mode === 'giveaway') {
    // One active seat left wins. There is no dead-position rule: kings can capture kings, so only the cap ends a game that goes nowhere.
    const active = activeSeats(state);
    return active.length <= 1 ? finishWith(state, giveawayResult(active, 'lastStanding'), events) : state;
  }
  if (activeSeats(state).length <= 1) return endGame(state, 'elimination', events);
  return optionsOf(state.rules).deadPositionEnds ? endIfDeadPosition(state, events) : state;
}

/** Ends the game with this exact result (and announces it). */
function finishWith(state: FourPlayerState, result: FourPlayerResult, events: GameEvent[]): FourPlayerState {
  events.push({ kind: 'gameOver', result });
  return { ...state, result };
}

function endGame(state: FourPlayerState, reason: FourPlayerResult['reason'], events: GameEvent[]): FourPlayerState {
  if (state.rules.mode === 'giveaway') return finishWith(state, giveawayResult(capWinners(state), reason), events); // only 'cap' reaches here: the fewest pieces win
  let scored = state;
  const bonus = optionsOf(state.rules).lastStandingKingBonus;
  if (bonus > 0 && reason === 'elimination') {
    // The one seat left is paid for every OTHER seat's king still on the board: a resigned / timed-out seat's walking king (a captured king is gone, and an
    // eliminated seat whose king was captured has none). Nobody left = nobody to pay.
    const last = activeSeats(state);
    if (last.length === 1) {
      const kingsLeft = ([0, 1, 2, 3] as Seat[]).filter((seat) => seat !== last[0] && state.kings[seat] >= 0).length;
      if (kingsLeft > 0) {
        const score = state.score.slice();
        score[last[0]] += bonus * kingsLeft;
        scored = { ...state, score };
      }
    }
  }
  const best = Math.max(...scored.score);
  const winners = ([0, 1, 2, 3] as Seat[]).filter((seat) => scored.score[seat] === best);
  return finishWith(scored, { winners, reason }, events);
}

/**
 * Eliminates an ACTIVE seat: its pieces become dead (that is just its status changing — see state.ts), its castling rights vanish,
 * points are awarded per `reason`, and the game ends if only one seat is left. Resign/timeout award nothing. No-op for a seat that is
 * not active.
 */
export function eliminateSeat(state: FourPlayerState, seat: Seat, reason: EliminationReason, events: GameEvent[] = [], creditSeat: Seat | null = null): FourPlayerState {
  if (state.status[seat] !== 'active' || state.result) return state;
  if (state.rules.mode === 'giveaway') {
    // Resigned / flagged: out of contention, never a winner. Frozen at once (no walking king); its pieces stay as walls. No points, no credit.
    events.push({ kind: 'eliminated', seat, reason, credit: null, points: [0, 0, 0, 0] });
    return finishIfOver({ ...withStatus(state, seat, 'frozen'), castling: 0 }, events);
  }
  const rules = state.rules;
  const score = state.score.slice();
  let credit: Seat | null = null;
  if (reason === 'checkmate') {
    credit = mateCredit(state, seat);
    if (credit !== null) score[credit] += rules.checkmatePoints;
  } else if (reason === 'stalemate') {
    score[seat] += rules.stalematedPoints;
    for (const other of activeSeats(state)) if (other !== seat) score[other] += rules.stalemateOthersPoints;
  }
  const points = score.map((value, i) => value - state.score[i]);
  // Its king was captured: there is no king left to walk, so the seat is inert at once ('frozen') and its army stays on the board as dead pieces.
  // Any other elimination leaves the walking king ('dead-king').
  if (reason === 'kingCaptured') credit = creditSeat;
  let next: FourPlayerState = { ...withStatus(state, seat, reason === 'kingCaptured' ? 'frozen' : 'dead-king'), score, castling: state.castling & ~(3 << (seat * 2)) };
  events.push({ kind: 'eliminated', seat, reason, credit, points });
  next = finishIfOver(next, events);
  return next;
}

/**
 * True when no checkmate can ever happen again: every ACTIVE seat has nothing but its king. Dead pieces never attack and kings can
 * never give check (they may not stand next to each other), so the game can only drain plies until the cap. Deliberately strict —
 * K+minor-piece endings are NOT declared dead: with several seats and cooperative blocks a mate is not provably impossible there.
 */
export function isDeadPosition(state: FourPlayerState): boolean {
  const { cells, status } = state;
  for (let i = 0; i < cells.length; i++) {
    const code = cells[i];
    if (code <= 0 || typeOf(code) === KING) continue;
    if (status[seatOf(code)] === 'active') return false;
  }
  return true;
}

function endIfDeadPosition(state: FourPlayerState, events: GameEvent[]): FourPlayerState {
  return !state.result && isDeadPosition(state) ? endGame(state, 'deadPosition', events) : state;
}

function capIfReached(state: FourPlayerState, events: GameEvent[]): FourPlayerState {
  return !state.result && state.ply >= Math.min(state.rules.maxPlies, HARD_MAX_PLIES) ? endGame(state, 'cap', events) : state;
}

/**
 * Passes the turn clockwise (starting after `state.turn`) until it reaches an active seat that has a legal move, resolving
 * eliminations and playing dead kings' random moves on the way — see the file header. Stops immediately if the game is over.
 */
export function advance(state: FourPlayerState, events: GameEvent[], rng: Rng = Math.random): FourPlayerState {
  if (state.rules.mode === 'giveaway') return advanceGiveaway(state, events);
  let current = state;
  for (let guard = 0; guard < 64 && !current.result; guard++) {
    current = finishIfOver(current, events);
    if (current.result) break;
    const seat = nextSeat(current.turn);
    current = { ...current, turn: seat };
    const status = current.status[seat];
    if (status === 'frozen') continue;

    const moves = legalMoves(current, seat);
    if (status === 'active') {
      if (moves.length > 0) return current;
      // Capture the King has no checkmate: a seat with no move at all is simply stalemated (eliminated, and the rules' stalemate points apply - 0 for Chaturaji).
      const inCheck = !optionsOf(current.rules).captureTheKing && current.kings[seat] >= 0 && attackers(current.cells, current.status, current.kings[seat], seat, geometryOf(current.rules)) !== 0;
      current = eliminateSeat(current, seat, inCheck ? 'checkmate' : 'stalemate', events);
      continue;
    }

    // dead-king: a random king move, or freeze when it has none.
    if (moves.length === 0) {
      current = withStatus(current, seat, 'frozen');
      events.push({ kind: 'frozen', seat });
      continue;
    }
    const move = moves[Math.min(moves.length - 1, Math.floor(rng() * moves.length))];
    current = applyMoveRaw(current, move);
    events.push({ kind: 'deadKingMove', seat, move });
    current = capIfReached(current, events);
  }
  return current;
}

/** Giveaway: the seat to move has no legal move, so IT WINS (`stuck`) and the game ends on the spot. */
function winStuck(state: FourPlayerState, events: GameEvent[]): FourPlayerState {
  return finishWith(state, giveawayResult([state.turn], 'stuck'), events);
}

/**
 * Giveaway's version of `advance`: pass the turn clockwise to the next ACTIVE seat (eliminated seats are skipped, never stuck, never win). If that seat has
 * no legal move it has WON (`stuck`); otherwise it simply moves. There is no elimination-by-stalemate and no dead king. Stops at once on a finished game.
 * A seat that is "stuck" here but has no pieces at all can only come from a hand-built position (a real game ends at the capture - `outOfPieces`).
 */
function advanceGiveaway(state: FourPlayerState, events: GameEvent[]): FourPlayerState {
  let current = finishIfOver(state, events);
  for (let guard = 0; guard < 8 && !current.result; guard++) {
    current = { ...current, turn: nextSeat(current.turn) };
    if (current.status[current.turn] !== 'active') continue;
    return legalMoves(current, current.turn).length === 0 ? winStuck(current, events) : current;
  }
  return current;
}

/**
 * Plays `move` (which must be one of legalMoves(state, state.turn)) and then resolves everything that follows. Returns the new state
 * (whose `turn` is the next seat that has to choose a move, or a finished game) and the events that happened, in order.
 */
export function playMove(state: FourPlayerState, move: Move, rng: Rng = Math.random): Applied {
  if (state.result) return { state, events: [] };
  const events: GameEvent[] = [{ kind: 'move', seat: state.turn, move }];
  let next = applyMoveRaw(state, move);
  if (next.rules.mode === 'giveaway') {
    // A seat whose last piece was just captured has won - checked BEFORE the cap, so it also beats a tie-break on the cap ply.
    const out = seatOutOfPieces(next, state.turn);
    if (out !== null) next = finishWith(next, giveawayResult([out], 'outOfPieces'), events);
  } else {
    const options = optionsOf(next.rules);
    if (options.forkPoints) {
      // Check forks: the piece that just moved attacks 2 / 3 live enemy kings. Scored BEFORE a king capture can end the game, so the final scores include it.
      const kings = kingsAttackedBy(next, move.to);
      const points = kings >= 3 ? options.forkPoints.triple : kings === 2 ? options.forkPoints.double : 0;
      if (points > 0) {
        const score = next.score.slice();
        score[state.turn] += points;
        next = { ...next, score };
        events.push({ kind: 'fork', seat: state.turn, kings, points });
      }
    }
    if (options.captureTheKing && move.captured && typeOf(move.captured) === KING) {
      // The king was just captured (applyMoveRaw scored it and cleared `kings`): its seat is out - an active seat is eliminated (and may end the game), a
      // resigned seat's walking king just stops walking.
      const victim = seatOf(move.captured);
      if (next.status[victim] === 'active') next = eliminateSeat(next, victim, 'kingCaptured', events, state.turn);
      else if (next.status[victim] === 'dead-king') {
        next = withStatus(next, victim, 'frozen');
        events.push({ kind: 'frozen', seat: victim });
      }
    }
  }
  next = capIfReached(next, events);
  next = advance(next, events, rng);
  return { state: next, events };
}

/** A seat resigns (or times out) at any moment. If it was its turn, the turn passes on. Returns the state unchanged for an inactive seat. */
export function resign(state: FourPlayerState, seat: Seat, rng: Rng = Math.random, reason: 'resign' | 'timeout' = 'resign'): Applied {
  const events: GameEvent[] = [];
  if (state.status[seat] !== 'active' || state.result) return { state, events };
  let next = eliminateSeat(state, seat, reason, events);
  if (!next.result && state.turn === seat) next = advance(next, events, rng);
  // Giveaway: the pieces that just became walls may have been the mover's only captures AND its quiet moves may all be blocked - then the seat
  // that is ALREADY to move is stuck (and wins). In FFA the mover can never be left without moves by someone else's elimination.
  else if (!next.result && next.rules.mode === 'giveaway' && legalMoves(next, next.turn).length === 0) next = winStuck(next, events);
  return { state: next, events };
}

/** The moves the seat whose turn it is may play (empty when the game is over). */
export function currentMoves(state: FourPlayerState): Move[] {
  return state.result ? [] : legalMoves(state, state.turn);
}
