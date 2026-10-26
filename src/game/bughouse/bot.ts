// GENERATED FILE - DO NOT EDIT BY HAND.
// Source: src/logic/bughouse/bot.ts in the EM-Chess app repo. Regenerate with `npm run sync:bughouse`; CI runs it with --check.
// The only difference from the source is that relative imports carry the '.js' suffix NodeNext requires.

/**
 * Bughouse W2: the bot (BUGHOUSE_SPEC.md HP4). One pure function - `chooseBughouseAction(match, seat, elo, rng)` - that picks a legal move or drop for a seat, and the helper the
 * server's safety net uses when a bot misbehaves. MIRRORED to the backend (the server runs it in-process, so it has a hard WORK budget, not a time budget).
 *
 * WHY NOT THE CRAZYHOUSE BOT. bots.ts `chooseCrazyhouseBotMove` needs `ChessEngine` (client-only) and costs ~80 ms on average: it builds a verbose move list (chess.js: ~4.5 ms) and
 * a scratch engine per candidate. Run synchronously on the one event loop that serves every room's clocks that would be a stall. This bot keeps its idea (material incl. the pocket,
 * safe drops, one reply of look-ahead, the ELO as "the chance of using the scored choice") on a much cheaper footing:
 *   - the moves come from chess.js's string list (`moves()`, ~0.25 ms; the verbose list is ~18x dearer) and are scored from the notation and the board alone, without being played;
 *   - only the best BUGHOUSE_BOT_LOOKAHEAD candidates are played, through the engine's own `applyAction` (so the check / mate / `stuck` verdict is the real Bughouse one) and answered
 *     by one reply look-ahead (the opponent's best capture, a mate in one, and a mating DROP from its pocket beside our king);
 *   - the work is bounded by COUNTS (candidates, probes), never by a clock: the same position, ELO and random stream give the same action on every machine, and the cost does not
 *     grow with the strength dial, so the budget is the same at every tier (measured in test-bughouse-bot.mjs).
 *
 * LEGAL ONLY. Every candidate is a chess.js move or a `legalDropOptions` drop; nothing here is trusted by the server anyway (it validates through `settle`). NOT PARTNER-AWARE (v1):
 * the bot drops what is in its pocket on its own merits and never plans around what its partner could capture; it uses no premoves and sends no quick messages.
 */
import type { Chess } from 'chess.js';
import { reserveTotal, type ReservePieceType } from '../crazyhouse.js';
import { legalDropOptions, openBoard, pieceAtOf } from './board.js';
import { applyAction, crazyhouseOfBoard, type BughouseMatch } from './match.js';
import type { BoardDropOption, BughouseAction } from './rules.js';
import { opponentOnBoard, seatPlace, type BoardId, type BughouseColor, type BughouseSeat } from './types.js';

/** The most candidates that get the (costlier) exact look-ahead. */
export const BUGHOUSE_BOT_LOOKAHEAD = 5;
/** The most drop candidates scored per decision (a pocket can offer hundreds of piece x square pairs). */
export const BUGHOUSE_BOT_MAX_DROP_CANDIDATES = 12;
/** The most squares near the mover's own king probed for an opponent's mating drop, per look-ahead candidate (every candidate is probed alike). */
export const BUGHOUSE_BOT_DROP_PROBES = 3;
/** When every candidate of a batch loses to a mate in one, up to this many further batches of BUGHOUSE_BOT_LOOKAHEAD are tried (so at most 3 x 5 = 15 candidates are ever played out). */
export const BUGHOUSE_BOT_RESCUE_BATCHES = 2;

const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const WIN = 1000;
/** What a captured piece is worth to the bot's TEAM beyond taking it off the board: the partner receives it. */
const BANK_SHARE = 0.5;
/** The pass-1 score that makes sure a notation mate is among the finalists (removed again before the final choice). */
const SAN_MATE_BONUS = 100;

const SAN_PATTERN = /^([NBRQK])?[a-h]?[1-8]?(x)?([a-h][1-8])(?:=([QRBN]))?[+#]?$/;
const otherColor = (color: BughouseColor): BughouseColor => (color === 'w' ? 'b' : 'w');
const distance = (a: string, b: string): number => Math.max(Math.abs(a.charCodeAt(0) - b.charCodeAt(0)), Math.abs(Number(a[1]) - Number(b[1])));

interface Scored {
  action: BughouseAction;
  score: number;
  /** The moves are resolved lazily (move + undo costs ~0.3 ms), so a candidate may still hold only its notation. */
  san: string | null;
}

/** The action a SAN string stands for in `chess`'s position (chess.js resolves the disambiguation), or null. The position is left exactly as it was. */
function resolveSan(chess: Chess, board: BoardId, san: string): BughouseAction | null {
  let played;
  try {
    played = chess.move(san);
  } catch {
    return null;
  }
  if (!played) return null;
  chess.undo();
  return played.promotion
    ? { kind: 'move', board, from: played.from, to: played.to, promotion: played.promotion as 'q' | 'r' | 'b' | 'n' }
    : { kind: 'move', board, from: played.from, to: played.to };
}

function kingSquare(chess: Chess, color: BughouseColor): string | null {
  for (const row of chess.board()) for (const cell of row) if (cell && cell.type === 'k' && cell.color === color) return cell.square;
  return null;
}

/** The legal action that is first in a fixed order (moves in chess.js's order, then drops), or null when the seat has none. The server's safety net for a bot that answers badly. */
export function firstLegalAction(match: BughouseMatch, seat: BughouseSeat): BughouseAction | null {
  const place = seatPlace(seat);
  if (match.result !== null || match.verdicts[place.board].turn !== place.color) return null;
  const chess = openBoard(match.boards[place.board].fen);
  if (chess === null) return null;
  for (const san of chess.moves()) {
    const action = resolveSan(chess, place.board, san);
    if (action) return action;
  }
  const drops = legalDropOptions(chess, crazyhouseOfBoard(match, place.board));
  return drops.length > 0 ? { kind: 'drop', board: place.board, piece: drops[0].piece, square: drops[0].square } : null;
}

/** A random legal turn that never under-promotes (the Crazyhouse bot's "not the best choice" branch). */
function randomAction(chess: Chess, board: BoardId, sans: string[], drops: BoardDropOption[], rng: () => number): BughouseAction | null {
  const plain = sans.filter((san) => !/=[RBN]/.test(san));
  if (drops.length > 0 && (plain.length === 0 || rng() < 0.3)) {
    const drop = drops[Math.floor(rng() * drops.length)];
    return { kind: 'drop', board, piece: drop.piece, square: drop.square };
  }
  const pool = plain.length > 0 ? plain : sans;
  return pool.length === 0 ? null : resolveSan(chess, board, pool[Math.floor(rng() * pool.length)]);
}

/** Whether `piece`, dropped on `square`, stands in line with `king` the way that piece attacks (blockers ignored: this only orders the probes). */
function touchesKing(piece: string, square: string, king: string): boolean {
  const df = Math.abs(square.charCodeAt(0) - king.charCodeAt(0));
  const dr = Math.abs(Number(square[1]) - Number(king[1]));
  const straight = (df === 0) !== (dr === 0);
  const diagonal = df === dr && df > 0;
  if (piece === 'n') return df * dr === 2;
  if (piece === 'b') return diagonal;
  if (piece === 'r') return straight;
  if (piece === 'q') return straight || diagonal;
  return diagonal && df === 1; // a pawn
}

/**
 * The drops a mating-drop probe tries, at most `limit` of them: those that touch `king` the way their piece attacks (a knight's jump, a rook's file or rank, ...) from ANY distance - a
 * mate by a dropped rook or queen can come from far away - and any other drop within two squares of it; the touching ones first, then the nearer ones first (ties in the given order).
 * Exported to be pinned.
 */
export function nearestDrops(drops: readonly BoardDropOption[], king: string, limit: number): BoardDropOption[] {
  return drops
    .map((drop) => ({ drop, d: distance(drop.square, king), touches: touchesKing(drop.piece, drop.square, king) }))
    .filter((c) => c.touches || c.d <= 2)
    .sort((a, b) => Number(b.touches) - Number(a.touches) || a.d - b.d)
    .slice(0, limit)
    .map((c) => c.drop);
}

/** What the side that just moved is up against in `after` (the position with the opponent to move): its best capture, a mate in one by a move, a mating drop beside its king. */
export function replyDanger(afterMatch: BughouseMatch, board: BoardId, mover: BughouseSeat, probeDrops: boolean): { loss: number; mated: boolean } {
  const chess = openBoard(afterMatch.boards[board].fen);
  if (chess === null) return { loss: 0, mated: false };
  const pieceAt = pieceAtOf(chess);
  let loss = 0;
  for (const san of chess.moves()) {
    if (san.includes('#')) return { loss, mated: true };
    const parsed = SAN_PATTERN.exec(san);
    if (parsed && parsed[2]) loss = Math.max(loss, VALUE[pieceAt(parsed[3])?.type ?? 'p']);
  }
  if (!probeDrops) return { loss, mated: false };
  const replier = opponentOnBoard(mover);
  const myKing = kingSquare(chess, seatPlace(mover).color);
  if (myKing === null) return { loss, mated: false };
  for (const drop of nearestDrops(legalDropOptions(chess, crazyhouseOfBoard(afterMatch, board)), myKing, BUGHOUSE_BOT_DROP_PROBES)) {
    const reply = applyAction(afterMatch, replier, { kind: 'drop', board, piece: drop.piece, square: drop.square }, afterMatch.nowMs);
    if (reply.ok && reply.match.result !== null && 'winnerTeam' in reply.match.result && reply.match.result.reason === 'checkmate') return { loss, mated: true };
  }
  return { loss, mated: false };
}

/**
 * Picks a legal move or drop for `seat`, or null when the seat cannot act (it is not its turn, the match is over, or it is `stuck`). `elo` is the strength dial: the chance that the
 * scored choice is used instead of a random legal turn rises from ~20 % at 400 to ~90 % at 3000. `rng` is the only source of randomness (a seeded one gives a reproducible bot).
 */
export function chooseBughouseAction(match: BughouseMatch, seat: BughouseSeat, elo: number, rng: () => number): BughouseAction | null {
  const place = seatPlace(seat);
  const board = place.board;
  if (match.result !== null || match.verdicts[board].turn !== place.color) return null;
  const chess = openBoard(match.boards[board].fen);
  if (chess === null) return null;
  const cz = crazyhouseOfBoard(match, board);
  const sans = chess.moves();
  const drops = legalDropOptions(chess, cz);
  if (sans.length + drops.length === 0) return null;

  const bestChance = 0.2 + 0.7 * Math.min(1, Math.max(0, (elo - 400) / 2600));
  if (rng() >= bestChance) return randomAction(chess, board, sans, drops, rng);

  const candidates = scorePass(chess, match, seat, sans, drops, rng);
  if (candidates.length === 0) return firstLegalAction(match, seat);

  // Pass 2: the best few are played through the engine and answered by one reply. If every one of them walks into a mate, the next few get their turn (at most BUGHOUSE_BOT_RESCUE_BATCHES
  // more batches), so the work stays bounded by counts and a position where the best-looking moves all lose still finds a safe one.
  const scored: { action: BughouseAction; score: number }[] = [];
  let next = 0;
  for (let batch = 0; batch <= BUGHOUSE_BOT_RESCUE_BATCHES && next < candidates.length; batch++) {
    if (batch > 0 && Math.max(...scored.map((s) => s.score)) > -WIN / 2) break;
    const finalists = candidates.slice(next, next + BUGHOUSE_BOT_LOOKAHEAD);
    next += finalists.length;
    for (const candidate of finalists) {
      let action = candidate.action;
      if (candidate.san !== null) {
        const resolved = resolveSan(chess, board, candidate.san);
        if (resolved === null) continue;
        action = resolved;
      }
      const outcome = applyAction(match, seat, action, match.nowMs);
      if (!outcome.ok) continue;
      if (outcome.match.result !== null && 'winnerTeam' in outcome.match.result && outcome.match.result.reason === 'checkmate') return action; // mate in one, by move or by drop
      // EVERY finalist is probed alike (a subset would make the unprobed ones look safe and bias the choice toward them)
      const danger = replyDanger(outcome.match, board, seat, reserveTotal(outcome.match.pockets[opponentOnBoard(seat)]) > 0);
      // (the pass-1 bonus for a notation mate is only a ticket to this look-ahead: a mate the engine does not confirm - the opponent has a drop - earns nothing for it)
      const ticket = candidate.san !== null && candidate.san.includes('#') ? SAN_MATE_BONUS : 0;
      scored.push({ action, score: candidate.score - ticket - danger.loss - (danger.mated ? WIN : 0) });
    }
  }
  if (scored.length === 0) return firstLegalAction(match, seat);
  const top = Math.max(...scored.map((s) => s.score));
  const best = scored.filter((s) => s.score === top);
  return best[Math.floor(rng() * best.length)].action;
}

/** What pass 1 knows about a candidate: the action (a move holds only its notation until it is resolved), its score and, for a move, its notation. */
export type BotCandidate = Scored;

/**
 * PASS 1, exported so that its numbers can be pinned: every legal move of `seat` scored from its notation and the board alone (nothing is played), and the drops worth scoring, best first.
 * A candidate that is a move carries its `san`; one that is a drop carries `san: null` and the drop in `action`. `rng` only adds the tie-breaking jitters.
 */
export function scoreCandidates(match: BughouseMatch, seat: BughouseSeat, rng: () => number, maxDrops: number = BUGHOUSE_BOT_MAX_DROP_CANDIDATES): BotCandidate[] {
  const place = seatPlace(seat);
  const chess = openBoard(match.boards[place.board].fen);
  if (chess === null) return [];
  return scorePass(chess, match, seat, chess.moves(), legalDropOptions(chess, crazyhouseOfBoard(match, place.board)), rng, maxDrops);
}

function scorePass(chess: Chess, match: BughouseMatch, seat: BughouseSeat, sans: string[], drops: BoardDropOption[], rng: () => number, maxDrops: number = BUGHOUSE_BOT_MAX_DROP_CANDIDATES): Scored[] {
  const place = seatPlace(seat);
  const board = place.board;
  const me = place.color;
  const opponent = otherColor(me);
  const pieceAt = pieceAtOf(chess);
  const promoted = new Set(match.boards[board].promoted);
  const enemyKing = kingSquare(chess, opponent);

  // Pass 1: every move scored from its notation and the board, nothing played.
  const candidates: Scored[] = [];
  for (const san of sans) {
    let score = rng() * 0.02; // breaks ties reproducibly
    if (san.startsWith('O-O')) {
      candidates.push({ action: { kind: 'move', board, from: '', to: '' }, score: score + 0.3, san });
      continue;
    }
    const parsed = SAN_PATTERN.exec(san);
    if (!parsed) continue;
    const piece = parsed[1] ? parsed[1].toLowerCase() : 'p';
    const dest = parsed[3];
    const promotion = parsed[4] ? parsed[4].toLowerCase() : null;
    if (promotion !== null && promotion !== 'q' && promotion !== 'n') continue; // rook and bishop promotions are never better than a queen for this bot
    if (parsed[2]) {
      const victim = pieceAt(dest)?.type ?? 'p'; // an empty destination is en passant
      score += VALUE[victim] + BANK_SHARE * VALUE[promoted.has(dest) ? 'p' : victim];
    }
    if (promotion !== null) score += VALUE[promotion] - 1;
    if (/[+#]/.test(san)) score += 0.5;
    // a mate in chess.js's eyes (it knows nothing of pockets) must reach the exact look-ahead whatever the safety rule below thinks of its square: a mating queen stands next to the king it mates
    if (san.includes('#')) score += SAN_MATE_BONUS;
    const moved = promotion ?? piece;
    if (moved !== 'k' && chess.isAttacked(dest as never, opponent)) score -= 0.4 * VALUE[moved];
    if (!parsed[2] && dest[0] >= 'c' && dest[0] <= 'f' && dest[1] >= '3' && dest[1] <= '6') score += 0.04;
    candidates.push({ action: { kind: 'move', board, from: '', to: '' }, score, san });
  }

  // The drops worth scoring: safe squares, or squares beside the enemy king, nearest the king first.
  const dropCandidates = drops
    .map((drop) => {
      const attacked = chess.isAttacked(drop.square as never, opponent);
      const defended = chess.isAttacked(drop.square as never, me);
      const near = enemyKing ? distance(drop.square, enemyKing) : 8;
      const safe = !attacked || defended;
      // which drops get scored when there are more than the cap: safe before unsafe, near the enemy king before far, and the more valuable piece before the cheaper one on the same square
      return { drop, near, safe, rank: (safe ? 0 : 2) + near * 0.5 - 0.1 * VALUE[drop.piece] + rng() * 0.1 };
    })
    .filter((c) => c.safe || c.near <= 2)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, maxDrops);
  for (const { drop, near, safe } of dropCandidates) {
    // a piece in the pocket is worth using: dropped it is on the board, kept it can be lost with the match; a pawn is kept a little longer
    let score = rng() * 0.02 + (safe ? 0.3 * VALUE[drop.piece] : -0.5 * VALUE[drop.piece]);
    if (near <= 2) score += (3 - near) * 0.15;
    if (drop.piece === 'p') score -= 0.3;
    candidates.push({ action: { kind: 'drop', board, piece: drop.piece as ReservePieceType, square: drop.square }, score, san: null });
  }
  return candidates.sort((a, b) => b.score - a.score);
}
