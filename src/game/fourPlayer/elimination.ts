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
import { applyMoveRaw, attackers, legalMoves, type Move } from './moves.js';
import { activeSeats, HARD_MAX_PLIES, KING, seatOf, typeOf, type FourPlayerResult, type FourPlayerState, type SeatStatus } from './state.js';

export type EliminationReason = 'checkmate' | 'stalemate' | 'resign' | 'timeout';

export type GameEvent =
  | { kind: 'move'; seat: Seat; move: Move }
  | { kind: 'deadKingMove'; seat: Seat; move: Move }
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
  const mask = attackers(state.cells, state.status, king, seat);
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
  if (activeSeats(state).length <= 1) return endGame(state, 'elimination', events);
  return endIfDeadPosition(state, events);
}

function endGame(state: FourPlayerState, reason: FourPlayerResult['reason'], events: GameEvent[]): FourPlayerState {
  const best = Math.max(...state.score);
  const winners = ([0, 1, 2, 3] as Seat[]).filter((seat) => state.score[seat] === best);
  const result: FourPlayerResult = { winners, reason };
  events.push({ kind: 'gameOver', result });
  return { ...state, result };
}

/**
 * Eliminates an ACTIVE seat: its pieces become dead (that is just its status changing — see state.ts), its castling rights vanish,
 * points are awarded per `reason`, and the game ends if only one seat is left. Resign/timeout award nothing. No-op for a seat that is
 * not active.
 */
export function eliminateSeat(state: FourPlayerState, seat: Seat, reason: EliminationReason, events: GameEvent[] = []): FourPlayerState {
  if (state.status[seat] !== 'active' || state.result) return state;
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
  let next: FourPlayerState = { ...withStatus(state, seat, 'dead-king'), score, castling: state.castling & ~(3 << (seat * 2)) };
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
      const inCheck = current.kings[seat] >= 0 && attackers(current.cells, current.status, current.kings[seat], seat) !== 0;
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

/**
 * Plays `move` (which must be one of legalMoves(state, state.turn)) and then resolves everything that follows. Returns the new state
 * (whose `turn` is the next seat that has to choose a move, or a finished game) and the events that happened, in order.
 */
export function playMove(state: FourPlayerState, move: Move, rng: Rng = Math.random): Applied {
  if (state.result) return { state, events: [] };
  const events: GameEvent[] = [{ kind: 'move', seat: state.turn, move }];
  let next = applyMoveRaw(state, move);
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
  return { state: next, events };
}

/** The moves the seat whose turn it is may play (empty when the game is over). */
export function currentMoves(state: FourPlayerState): Move[] {
  return state.result ? [] : legalMoves(state, state.turn);
}
