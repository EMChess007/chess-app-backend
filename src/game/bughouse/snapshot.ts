// GENERATED FILE - DO NOT EDIT BY HAND.
// Source: src/logic/bughouse/snapshot.ts in the EM-Chess app repo. Regenerate with `npm run sync:bughouse`; CI runs it with --check.
// The only difference from the source is that relative imports carry the '.js' suffix NodeNext requires.

/**
 * Bughouse W1: the match as text, for the wire and for a persisted rejoin (BUGHOUSE_SPEC.md HP1 `bug_state`, HP5). MIRRORED to the backend.
 *
 * `serializeMatch` writes the match as one JSON line with a FIXED key order, so the same match is the same bytes on every run, on the client and on the server (the byte-identical
 * snapshot per `seq` of HP1). `deserializeMatch` is for HOSTILE input too (a rejoin record, a forged frame): it accepts only the exact shape, rejects every unknown key, re-derives the
 * verdicts from the positions and requires them to match what the text says, checks the running clocks against whose turn it is, ties `seq` to the plies played, and runs the
 * conservation invariant - a text that passes describes a match this engine could have reached.
 */
import { RESERVE_PIECE_TYPES, type Reserve } from '../crazyhouse.js';
import { fenOf, openBoard } from './board.js';
import { isWholeMs, type SeatClock } from './clock.js';
import { conservationProblems } from './invariants.js';
import { judgeBoardState, type BoardState, type BughouseMatch } from './match.js';
import type { BoardVerdict, MatchResult, ResultReason } from './rules.js';
import { BOARD_IDS, BUGHOUSE_SEATS, seatAt, seatPlace, type BoardId, type BughouseSeat, type BughouseTeam } from './types.js';

export const SNAPSHOT_VERSION = 1;

export interface BughouseSnapshot {
  v: number;
  timeControl: { initialMs: number; incrementMs: number };
  roomNumber: number;
  seq: number;
  nowMs: number;
  boards: Record<BoardId, BoardState>;
  pockets: Reserve[];
  clocks: SeatClock[];
  verdicts: Record<BoardId, BoardVerdict>;
  result: MatchResult | null;
}

const reserveOf = (r: Reserve): Reserve => ({ p: r.p, n: r.n, b: r.b, r: r.r, q: r.q });
const clockOf = (c: SeatClock): SeatClock => ({ remainingMs: c.remainingMs, runningSince: c.runningSince, startSeq: c.startSeq });
const verdictOf = (v: BoardVerdict): BoardVerdict => ({ status: v.status, turn: v.turn, inCheck: v.inCheck, stuck: v.stuck });
const boardOf = (b: BoardState): BoardState => ({ fen: b.fen, promoted: [...b.promoted], plies: b.plies });

function resultOf(r: MatchResult | null): MatchResult | null {
  if (r === null) return null;
  if ('voided' in r) return { voided: true, reason: r.reason };
  return { winnerTeam: r.winnerTeam, reason: r.reason, board: r.board, loserSeat: r.loserSeat };
}

/** The match as a plain object with the key order the text uses. */
export function snapshotOf(match: BughouseMatch): BughouseSnapshot {
  return {
    v: SNAPSHOT_VERSION,
    timeControl: { initialMs: match.timeControl.initialMs, incrementMs: match.timeControl.incrementMs },
    roomNumber: match.roomNumber,
    seq: match.seq,
    nowMs: match.nowMs,
    boards: { A: boardOf(match.boards.A), B: boardOf(match.boards.B) },
    pockets: match.pockets.map(reserveOf),
    clocks: match.clocks.map(clockOf),
    verdicts: { A: verdictOf(match.verdicts.A), B: verdictOf(match.verdicts.B) },
    result: resultOf(match.result),
  };
}

export function serializeMatch(match: BughouseMatch): string {
  return JSON.stringify(snapshotOf(match));
}

export type DeserializeOutcome = { ok: true; match: BughouseMatch } | { ok: false; error: string };

const fail = (error: string): DeserializeOutcome => ({ ok: false, error });

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasExactKeys = (value: Record<string, unknown>, keys: string[]): boolean => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
};
const SQUARE = /^[a-h][1-8]$/;
const REASONS: ResultReason[] = ['checkmate', 'flag', 'resign', 'disconnect'];
const POCKET_LIMIT = 64;

function parseReserve(value: unknown): Reserve | null {
  if (!isObject(value) || !hasExactKeys(value, [...RESERVE_PIECE_TYPES])) return null;
  const out = { p: 0, n: 0, b: 0, r: 0, q: 0 };
  for (const type of RESERVE_PIECE_TYPES) {
    const n = value[type];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > POCKET_LIMIT) return null;
    out[type] = n;
  }
  return out;
}

function parseClock(value: unknown, seq: number, nowMs: number): SeatClock | null {
  if (!isObject(value) || !hasExactKeys(value, ['remainingMs', 'runningSince', 'startSeq'])) return null;
  const { remainingMs, runningSince, startSeq } = value;
  if (!isWholeMs(remainingMs) || !isWholeMs(startSeq) || startSeq > seq) return null;
  if (runningSince !== null && (!isWholeMs(runningSince) || runningSince > nowMs)) return null;
  return { remainingMs, runningSince: runningSince as number | null, startSeq };
}

function parseBoard(value: unknown): BoardState | null {
  if (!isObject(value) || !hasExactKeys(value, ['fen', 'promoted', 'plies'])) return null;
  const { fen, promoted, plies } = value;
  if (typeof fen !== 'string' || !Array.isArray(promoted) || !isWholeMs(plies)) return null;
  if (!promoted.every((s) => typeof s === 'string' && SQUARE.test(s)) || new Set(promoted).size !== promoted.length) return null;
  if (promoted.join() !== [...promoted].sort().join()) return null; // the Crazyhouse block keeps them sorted
  const chess = openBoard(fen);
  if (chess === null || fenOf(chess) !== fen) return null; // only the canonical text of a position
  return { fen, promoted: [...promoted] as string[], plies };
}

function parseResult(value: unknown): MatchResult | null | undefined {
  if (value === null) return null;
  if (!isObject(value)) return undefined;
  if (hasExactKeys(value, ['voided', 'reason'])) return value.voided === true && value.reason === 'abandoned' ? { voided: true, reason: 'abandoned' } : undefined;
  if (!hasExactKeys(value, ['winnerTeam', 'reason', 'board', 'loserSeat'])) return undefined;
  const { winnerTeam, reason, board, loserSeat } = value;
  if ((winnerTeam !== 1 && winnerTeam !== 2) || !REASONS.includes(reason as ResultReason) || !BOARD_IDS.includes(board as BoardId)) return undefined;
  if (typeof loserSeat !== 'number' || !Number.isInteger(loserSeat) || loserSeat < 0 || loserSeat > 3) return undefined;
  const place = seatPlace(loserSeat as BughouseSeat);
  if (place.board !== board || place.team === winnerTeam) return undefined; // the loser sits on the deciding board and is on the other team
  return { winnerTeam: winnerTeam as BughouseTeam, reason: reason as ResultReason, board: board as BoardId, loserSeat: loserSeat as BughouseSeat };
}

/** Reads a match back from `serializeMatch` text, or says why not. Never throws. */
export function deserializeMatch(text: string): DeserializeOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail('not JSON');
  }
  if (!isObject(raw) || !hasExactKeys(raw, ['v', 'timeControl', 'roomNumber', 'seq', 'nowMs', 'boards', 'pockets', 'clocks', 'verdicts', 'result'])) return fail('not a Bughouse snapshot');
  if (raw.v !== SNAPSHOT_VERSION) return fail('unknown version');
  const tc = raw.timeControl;
  if (!isObject(tc) || !hasExactKeys(tc, ['initialMs', 'incrementMs']) || !isWholeMs(tc.initialMs) || tc.initialMs <= 0 || !isWholeMs(tc.incrementMs)) return fail('bad time control');
  const { roomNumber, seq, nowMs } = raw;
  if (!isWholeMs(roomNumber) || !isWholeMs(seq) || !isWholeMs(nowMs)) return fail('bad room number, seq or time');

  const rawBoards = raw.boards;
  if (!isObject(rawBoards) || !hasExactKeys(rawBoards, ['A', 'B'])) return fail('bad boards');
  const boardA = parseBoard(rawBoards.A);
  const boardB = parseBoard(rawBoards.B);
  if (boardA === null || boardB === null) return fail('bad board position');
  const boards: Record<BoardId, BoardState> = { A: boardA, B: boardB };

  if (!Array.isArray(raw.pockets) || raw.pockets.length !== 4 || !Array.isArray(raw.clocks) || raw.clocks.length !== 4) return fail('bad pockets or clocks');
  const pockets = raw.pockets.map(parseReserve);
  const clocks = raw.clocks.map((c) => parseClock(c, seq, nowMs));
  if (pockets.some((p) => p === null) || clocks.some((c) => c === null)) return fail('bad pocket or clock');

  const result = parseResult(raw.result);
  if (result === undefined) return fail('bad result');

  const rawVerdicts = raw.verdicts;
  if (!isObject(rawVerdicts) || !hasExactKeys(rawVerdicts, ['A', 'B'])) return fail('bad verdicts');
  const fixedPockets = pockets as Reserve[];
  const verdicts = {} as Record<BoardId, BoardVerdict>;
  for (const board of BOARD_IDS) verdicts[board] = judgeBoardState(board, boards[board], fixedPockets[seatAt(board, 'w')], fixedPockets[seatAt(board, 'b')]);
  if (JSON.stringify(verdicts.A) !== JSON.stringify(rawVerdicts.A) || JSON.stringify(verdicts.B) !== JSON.stringify(rawVerdicts.B)) return fail('the verdicts do not match the positions');

  const fixedClocks = clocks as SeatClock[];
  for (const seat of BUGHOUSE_SEATS) {
    const place = seatPlace(seat);
    const shouldRun = result === null && verdicts[place.board].turn === place.color;
    if ((fixedClocks[seat].runningSince !== null) !== shouldRun) return fail(`seat ${seat}: its clock should ${shouldRun ? '' : 'not '}be running`);
  }

  // seq counts the commits: one per ply, plus one for a result that is not a mate
  const plies = boards.A.plies + boards.B.plies;
  const extra = result === null || ('winnerTeam' in result && result.reason === 'checkmate') ? 0 : 1;
  if (seq !== plies + extra) return fail('seq does not match the plies played');
  if (result !== null && 'winnerTeam' in result && result.reason === 'checkmate' && verdicts[result.board].status !== 'checkmate') return fail('a checkmate result without a mate on the board');

  const match: BughouseMatch = {
    timeControl: { initialMs: tc.initialMs, incrementMs: tc.incrementMs as number },
    roomNumber,
    seq,
    nowMs,
    boards,
    pockets: fixedPockets,
    clocks: fixedClocks,
    verdicts,
    result,
  };
  const problems = conservationProblems(match);
  if (problems.length > 0) return fail(`not a reachable match: ${problems[0]}`);
  return { ok: true, match };
}
