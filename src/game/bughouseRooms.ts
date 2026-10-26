/**
 * Bughouse ONLINE - the server's room manager (workstream W2; design in BUGHOUSE_SPEC.md HP1, HP2, HP5, HP6, HP10).
 *
 * WHAT IT IS. The Bughouse counterpart of `FourRoomManager` (a NEW class following its pattern; that file is not touched): it owns every live Bughouse match, is the SINGLE authority on
 * both boards, the four pockets and the four clocks, and speaks the `bug_*` protocol of `bughouse/wire.ts` (a GENERATED copy of the app's wire contract). Clients never send positions: they
 * send a move or a drop NAMING THEIR BOARD, the engine judges it for the SOCKET'S seat, and the server publishes the resulting snapshot (`serializeMatch`) with the engine's events.
 *
 * THE ONE FUNNEL (HP1, HP2). Every input of a match - a move, a drop, a resignation, a timer firing - is `run()`: it reads ONE instant from the injected monotonic clock, hands the match,
 * the input (or null for a timer) and that instant to the engine's pure `settle`, and only `applied` and `flag` outcomes change anything. `commit()` is the only place `room.match` is
 * assigned after creation; it publishes exactly one `bug_state` (seq + 1) and then either ends the match or re-arms the timers. The all-gone `voidMatch` goes through `commit()` too.
 * A test pins both facts at source level.
 *
 * CLOCKS. Time is the injected `clock()` - ONE monotonic integer count of milliseconds for every room, every clock and every limit here (never `Date.now()`, so a wall-clock jump cannot
 * reorder anything). After every commit one timer per BOARD is re-armed from `runningClocks(match)`: it fires when that board's running clock would flag. A timer is just an input: its
 * callback reads the clock and calls the funnel with `null`, and the engine settles the flags that are DUE AT THAT INSTANT, earliest deadline first - so a timer that fires late (or
 * a board's timer that fires after the other board's) cannot change which flag wins, and a timer that fires early settles nothing and is simply re-armed.
 *
 * SECURITY. A seat is always derived from the SOCKET (`socketToSeat`), never from the payload; the board of a move is checked against the seat's own by the engine. Player tokens are
 * random UUIDs that leave the server only in `bug_match_found` to their own seat's socket and in that seat's own rejoin answer. Every inbound call takes `unknown` and validates with
 * the shared validators of the wire file. TEAM CHAT AND QUICK MESSAGES (HP10): the recipients are computed HERE from the seat map (`partnerOf(seat)`); nothing the client sends can name
 * one, and spectators and opponents are never sent a line.
 *
 * EMITS CANNOT ABORT A COMMIT: by the time anything is sent the state has already changed, so a send that throws is caught, logged, and the other recipients still get theirs.
 *
 * BOTS. A seat is `controller: 'human' | 'bot'`. After every commit `scheduleBots()` makes sure the seat on move on each board has a pending bot move if a bot plays it (one timer per
 * board, kept while that board's position is unchanged, so a busy other board cannot postpone it). The callback re-checks the room, the board's ply count, the seat and its controller
 * and then plays through the same funnel as anyone: a bot is never trusted (a thrown, null or refused answer is replaced by the first legal action).
 *
 * DISCONNECT -> TAKEOVER -> RETAKE (B19). A disconnected human's seat keeps its clock running and, after the grace, is taken over by a bot (only if some ORIGINAL human is still
 * connected: a bot is never handed an empty room). The human may take the seat back by rejoining at ANY time until the match ends. A disconnect NEVER loses the match; the only
 * non-winning end is `voided`: when no original human is connected for BUG_ALL_GONE_MS the match is voided (rule 22).
 *
 * NOT HERE: friend rooms and pairs (W6), the client (W3-W5). A room is created with its four seats already decided by the matchmaker.
 */

import { randomUUID } from 'node:crypto';
import type { Server } from 'socket.io';
import {
  BOARD_IDS,
  bugRefusal,
  chooseBughouseAction,
  createMatch,
  firstLegalAction,
  normalizeBugChatText,
  partnerOf,
  runningClocks,
  seatAt,
  serializeMatch,
  settle,
  validateBugDropPayload,
  validateBugMovePayload,
  validateBugQuickCode,
  validateBugRejoin,
  validateBugRoomPayload,
  validateBugTimeControl,
  voidMatch,
  type BoardId,
  type BugAck,
  type BugActiveGameSummary,
  type BugChatFromPayload,
  type BugGameOverPayload,
  type BugLogEntry,
  type BugMatchFoundPayload,
  type BugQuickFromPayload,
  type BugRejectReason,
  type BugRejoinAck,
  type BugRoomState,
  type BugSeatInfo,
  type BugSeats,
  type BugSeatUpdatePayload,
  type BugServerToClientEvents,
  type BugSpectateState,
  type BugStatePayload,
  type BughouseAction,
  type BughouseEvent,
  type BughouseInput,
  type BughouseMatch,
  type BughouseSeat,
  type BughouseTimeControl,
  type SettleOutcome,
} from './bughouse/index.js';
import {
  BUG_ACTION_RATE_LIMIT,
  BUG_ACTIVE_GAMES_LIST_MAX,
  BUG_ALL_GONE_MS,
  BUG_BOT_ELO,
  BUG_CHAT_MIN_INTERVAL_MS,
  BUG_FINISHED_RETENTION_MS,
  BUG_MAX_SPECTATORS_PER_ROOM,
  BUG_NAME_MAX_LENGTH,
  BUG_QUICK_DUPLICATE_MS,
  BUG_QUICK_MIN_INTERVAL_MS,
  BUG_QUICK_WINDOW_MAX,
  BUG_QUICK_WINDOW_MS,
  bugBotThinkMs,
  bugTimeControlLabel,
  resolveBugGraceMs,
} from './bughouseConfig.js';

/** What a bot decision needs from the engine: a match, a seat, a strength and a random stream, an action (or null). Injectable for tests. */
export type BugBotChooser = (match: BughouseMatch, seat: BughouseSeat, elo: number, rng: () => number) => BughouseAction | null;

/** The clock and the timers every room, every limit and every countdown here use. Injectable, so a test can drive a whole match without waiting and without a wall clock. */
export interface BugTimers {
  /** ONE monotonic count of integer milliseconds. */
  now(): number;
  setTimer(callback: () => void, ms: number, options?: { unref?: boolean }): unknown;
  clearTimer(handle: unknown): void;
}

export const realTimers: BugTimers = {
  now: () => Math.floor(performance.now()),
  setTimer: (callback, ms, options) => {
    const handle = setTimeout(callback, ms);
    if (options?.unref) handle.unref();
    return handle;
  },
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** One seat as the matchmaker hands it over; `seats[i]` is seat i (A White, A Black, B White, B Black), already in the random order decided. */
export interface BugSeatSetup {
  kind: 'human' | 'bot';
  /** The human's socket; null for a bot. */
  socketId: string | null;
  /** Shown to everyone: a username, "Guest" or a bot's name. Never a userId. */
  name: string;
  elo?: number;
  botReason?: 'fill' | 'takeover';
}
export type BugSeatSetups = [BugSeatSetup, BugSeatSetup, BugSeatSetup, BugSeatSetup];

export interface CreateBugRoomParams {
  seats: BugSeatSetups;
  timeControl: BughouseTimeControl;
  timeControlLabel?: string;
}

export interface CreateBugRoomResult {
  roomId: string;
  /** Per seat: the human's token, null for a bot. (Also sent to each human in `bug_match_found`.) */
  tokens: (string | null)[];
}

interface BugSeatRuntime {
  controller: 'human' | 'bot';
  botReason?: 'fill' | 'takeover';
  elo?: number;
  /** True for a seat that started as a human - a takeover turns `controller` into 'bot' but the seat keeps this. */
  originalHuman: boolean;
  socketId: string | null;
  name: string;
  playerToken: string | null;
  connected: boolean;
  disconnectedAt: number | null;
  /** When this seat last sent a chat line that was accepted. */
  lastChatAt: number | null;
  /** Instants of this seat's recent `bug_move` / `bug_drop` calls (rate limit). */
  actionCalls: number[];
  /** This seat's accepted quick messages in the last BUG_QUICK_WINDOW_MS. */
  quickLog: { at: number; code: number }[];
  graceTimer: unknown;
}

interface PendingBotMove {
  handle: unknown;
  /** The seat the move is armed for. (A board's seat on move changes with every ply, so this alone says whether the position the move was armed for is still the one to play on.) */
  seat: BughouseSeat;
}

interface BugRoom {
  id: string;
  status: 'active' | 'finished';
  match: BughouseMatch;
  seats: [BugSeatRuntime, BugSeatRuntime, BugSeatRuntime, BugSeatRuntime];
  log: BugLogEntry[];
  spectators: Set<string>;
  timeControl: BughouseTimeControl;
  timeControlLabel: string;
  clockTimers: Record<BoardId, unknown>;
  botTimers: Record<BoardId, PendingBotMove | null>;
  allGoneTimer: unknown;
}

/** What a finished room keeps for a late `bug_rejoin` (B22): the result, who may ask for it, and when it goes. */
interface BugFinishedRoom {
  gameOver: BugGameOverPayload;
  tokens: readonly string[];
  finishedAt: number;
  cleanup: unknown;
}

const NO_GAME = 'No active game found for this connection.';

const REFUSAL_TEXT: Record<BugRejectReason, string> = {
  over: 'The match is over.',
  time: 'The match clock refused that instant.',
  flagDue: 'A flag had already fallen.',
  malformed: 'Invalid request.',
  wrongBoard: 'That is not your board.',
  notYourTurn: 'Not your turn.',
  illegalMove: 'Illegal move.',
  dropNotInPocket: 'That piece is not in your pocket.',
  illegalDrop: 'Illegal drop.',
  invalidRequest: 'Invalid request.',
  noGame: NO_GAME,
  rateLimited: 'Too many requests - slow down.',
  duplicate: 'You just sent that.',
  partnerIsBot: 'Your partner is a bot.',
};

const SEATS: readonly BughouseSeat[] = [0, 1, 2, 3];

export class BughouseRoomManager {
  private rooms = new Map<string, BugRoom>();
  private finishedRooms = new Map<string, BugFinishedRoom>();
  private socketToSeat = new Map<string, { roomId: string; seat: BughouseSeat }>();
  private socketToSpectating = new Map<string, string>();
  private readonly timers: BugTimers;
  private readonly botRng: () => number;
  private readonly chooseBot: BugBotChooser;
  /** How long a disconnected human's seat is left alone before a bot takes it over: 45 s (BUG_TAKEOVER_GRACE_MS), or the FOUR_GRACE_MS test override (see bughouseConfig.ts). */
  private readonly graceMs: number;
  private readonly allGoneMs: number;
  /** The room-creation counter: only its parity matters (the last level of the flag tie-break, HP2). */
  private roomCounter = 0;

  constructor(
    private io: Server,
    options: { timers?: BugTimers; botRng?: () => number; chooseBotAction?: BugBotChooser; graceMs?: number; allGoneMs?: number } = {},
  ) {
    this.timers = options.timers ?? realTimers;
    this.botRng = options.botRng ?? Math.random;
    this.chooseBot = options.chooseBotAction ?? chooseBughouseAction;
    this.graceMs = options.graceMs ?? resolveBugGraceMs();
    this.allGoneMs = options.allGoneMs ?? BUG_ALL_GONE_MS;
  }

  // --- Creation -------------------------------------------------------------------------------------------------------------

  /**
   * Starts a match with the four seats already decided (the matchmaker shuffles them) and tells every human their own seat, token and the starting snapshot (`bug_match_found`, seq 0).
   * Throws on a programming error (a time control outside the six, not four seats, no human): this is internal, callers validate user input before it gets here.
   */
  createRoom(params: CreateBugRoomParams): CreateBugRoomResult {
    const timeControl = validateBugTimeControl(params.timeControl);
    if (!timeControl.ok) throw new Error(`createRoom: ${timeControl.error}`);
    if (!Array.isArray(params.seats) || params.seats.length !== 4) throw new Error('createRoom: exactly four seats are required');
    if (!params.seats.some((s) => s.kind === 'human')) throw new Error('createRoom: at least one human seat is required');
    const humanSockets = params.seats.filter((s) => s.kind === 'human').map((s) => s.socketId);
    if (humanSockets.some((id) => !id) || new Set(humanSockets).size !== humanSockets.length) throw new Error('createRoom: every human seat needs its own socket');
    for (const socketId of humanSockets) {
      if (this.socketToSeat.has(socketId as string)) throw new Error('createRoom: a socket is already seated in another game');
    }
    for (const socketId of humanSockets) this.stopSpectating(socketId as string); // a player cannot also be a spectator

    const id = randomUUID();
    const seats = params.seats.map((setup): BugSeatRuntime => {
      const human = setup.kind === 'human';
      return {
        controller: setup.kind,
        botReason: human ? undefined : (setup.botReason ?? 'fill'),
        elo: human ? undefined : setup.elo,
        originalHuman: human,
        socketId: human ? setup.socketId : null,
        name: String(setup.name).slice(0, BUG_NAME_MAX_LENGTH),
        playerToken: human ? randomUUID() : null,
        connected: true,
        disconnectedAt: null,
        lastChatAt: null,
        actionCalls: [],
        quickLog: [],
        graceTimer: null,
      };
    }) as BugRoom['seats'];

    const startMs = this.timers.now();
    const room: BugRoom = {
      id,
      status: 'active',
      match: createMatch({ timeControl: timeControl.value, roomNumber: this.roomCounter++, startMs }),
      seats,
      log: [],
      spectators: new Set(),
      timeControl: timeControl.value,
      timeControlLabel: params.timeControlLabel ?? bugTimeControlLabel(timeControl.value.initialMs, timeControl.value.incrementMs),
      clockTimers: { A: null, B: null },
      botTimers: { A: null, B: null },
      allGoneTimer: null,
    };
    this.rooms.set(id, room);

    // ONE reading of the clock for every recipient, so everyone gets byte-identical starting payloads.
    const startingSeats = this.seatInfos(room);
    const state = serializeMatch(room.match);
    for (const seat of SEATS) {
      const runtime = seats[seat];
      if (runtime.controller !== 'human' || !runtime.socketId) continue;
      this.socketToSeat.set(runtime.socketId, { roomId: id, seat });
      const payload: BugMatchFoundPayload = {
        roomId: id,
        seat,
        playerToken: runtime.playerToken as string,
        seats: startingSeats,
        timeControl: room.timeControl,
        timeControlLabel: room.timeControlLabel,
        state,
        serverNowMs: startMs,
        seq: 0,
      };
      this.emit(runtime.socketId, 'bug_match_found', payload);
    }
    this.armClockTimers(room);
    this.scheduleBots(room); // seat 0 or seat 2 may be a bot
    return { roomId: id, tokens: seats.map((s) => s.playerToken) };
  }

  // --- The funnel -----------------------------------------------------------------------------------------------------------

  /**
   * THE ONLY MUTATOR of `room.match` (after creation). Installs the engine's new match, logs the played move or drop, publishes exactly one `bug_state` (seq as the engine counted it) to
   * every seat and spectator, then ends the match if the engine says it is over or re-arms the timers.
   */
  private commit(room: BugRoom, next: BughouseMatch, events: BughouseEvent[]): void {
    room.match = next;
    for (const event of events) {
      if (event.kind === 'move' || event.kind === 'drop') room.log.push({ seq: event.seq, seat: event.seat, board: event.board, san: event.san });
    }
    const payload: BugStatePayload = { roomId: room.id, seq: next.seq, events, state: serializeMatch(next), serverNowMs: next.nowMs };
    this.broadcast(room, 'bug_state', payload);
    if (next.result !== null) this.endMatch(room);
    else {
      this.armClockTimers(room);
      this.scheduleBots(room);
    }
  }

  /**
   * THE FUNNEL. One instant is read from the clock, once, and the engine's `settle` does the rest: it settles the flags due at that instant before anything else, then applies the input
   * (null = a timer firing). Only `applied` and `flag` change the match. `Math.max(.., match.nowMs)`: the match refuses an instant earlier than one it has seen, and a monotonic clock never
   * goes back, so this only matters for an injected clock that misbehaves - it must not be able to wedge a room.
   */
  private run(room: BugRoom, input: BughouseInput | null): SettleOutcome {
    const at = Math.max(this.timers.now(), room.match.nowMs);
    const outcome = settle(room.match, input, at);
    if (outcome.kind === 'applied' || outcome.kind === 'flag') this.commit(room, outcome.match, outcome.events);
    else if (outcome.kind === 'idle') this.armClockTimers(room); // a timer that woke a hair early: nothing was due, so wait for the rest
    return outcome;
  }

  /** (Re)starts the one timer each board has: it fires when that board's running clock would flag. */
  private armClockTimers(room: BugRoom): void {
    const running = runningClocks(room.match); // none once the match is over: finishing a match freezes every clock
    for (const board of BOARD_IDS) {
      if (room.clockTimers[board] !== null) this.timers.clearTimer(room.clockTimers[board]);
      room.clockTimers[board] = null;
      const clock = running.find((c) => c.board === board);
      if (!clock) continue;
      room.clockTimers[board] = this.timers.setTimer(() => this.onClockTimer(room, board), Math.max(0, clock.deadline - this.timers.now()));
    }
  }

  /** A board's clock timer fired: it is just an input (null) to the funnel. */
  private onClockTimer(room: BugRoom, board: BoardId): void {
    room.clockTimers[board] = null;
    if (room.status !== 'active') return;
    this.run(room, null);
  }

  // --- Bots, takeover and abandonment ---------------------------------------------------------------------------------------------

  /** Original humans that currently have a live socket: the ones who can still watch or play (a seat a bot has taken over does not count). */
  private connectedHumans(room: BugRoom): number {
    return room.seats.filter((s) => s.originalHuman && s.socketId !== null).length;
  }

  /** The seat on move on `board` if a bot plays it and it can act; null when nobody has to be scheduled. */
  private botDue(room: BugRoom, board: BoardId): BughouseSeat | null {
    const verdict = room.match.verdicts[board];
    if (verdict.status === 'stuck') return null; // nothing to play until a partner capture fills the pocket - that commit re-evaluates this
    const seat = seatAt(board, verdict.turn);
    return room.seats[seat].controller === 'bot' ? seat : null;
  }

  /** After every commit (and a takeover or a retake): each board has exactly the bot move it needs. A pending move for the same seat on move is KEPT (a busy other board must not postpone it). */
  private scheduleBots(room: BugRoom): void {
    for (const board of BOARD_IDS) {
      const due = this.botDue(room, board);
      const pending = room.botTimers[board];
      if (pending && due === pending.seat) continue;
      if (pending) this.timers.clearTimer(pending.handle);
      room.botTimers[board] = null;
      if (due === null) continue;
      const handle = this.timers.setTimer(() => this.playBotTurn(room, board, due), bugBotThinkMs(room.timeControl.initialMs));
      room.botTimers[board] = { handle, seat: due };
    }
  }

  /**
   * The bot on move plays - through the same funnel as any move (time charged by the engine, increment added), but nothing about it is trusted: an answer that throws, is null or is
   * refused by the engine is replaced by the first legal action, so a faulty bot can never stall a board.
   */
  private playBotTurn(room: BugRoom, board: BoardId, seat: BughouseSeat): void {
    room.botTimers[board] = null;
    if (room.status !== 'active' || this.botDue(room, board) !== seat) return; // stale: the position moved on, the match ended, or a human took the seat back
    const runtime = room.seats[seat];
    let action: BughouseAction | null = null;
    let fault = 'no action';
    try {
      action = this.chooseBot(room.match, seat, runtime.elo ?? BUG_BOT_ELO, this.botRng);
    } catch (err) {
      fault = `an error (${err instanceof Error ? err.message : String(err)})`;
    }
    if (action) {
      const outcome = this.run(room, { seat, action });
      if (outcome.kind === 'applied' || outcome.kind === 'flag') return;
      fault = `an action the engine refused (${outcome.kind === 'rejected' ? outcome.reason : outcome.kind})`;
    }
    console.error(`[bughouseRooms] the bot of seat ${seat} in room ${room.id} returned ${fault}; playing the first legal action instead`);
    const fallback = firstLegalAction(room.match, seat);
    if (fallback) this.run(room, { seat, action: fallback });
    else console.error(`[bughouseRooms] seat ${seat} of room ${room.id} is on move with no legal action`);
  }

  /** The grace period of a disconnected human ran out. Takes the seat over with a bot - unless it came back, or nobody is left (then the all-gone timer decides: a bot is never handed an empty room). */
  private onGraceExpired(room: BugRoom, seat: BughouseSeat): void {
    const runtime = room.seats[seat];
    runtime.graceTimer = null;
    if (room.status !== 'active') return;
    if (runtime.controller !== 'human' || runtime.connected) return;
    if (this.connectedHumans(room) === 0) return;
    runtime.controller = 'bot';
    runtime.botReason = 'takeover';
    runtime.elo = BUG_BOT_ELO;
    this.broadcastSeats(room);
    this.scheduleBots(room); // if it is this seat's turn, the bot plays it
  }

  /** Starts the all-gone countdown if no original human is connected (and none is running). */
  private checkAllGone(room: BugRoom): void {
    if (room.allGoneTimer !== null || this.connectedHumans(room) > 0) return;
    room.allGoneTimer = this.timers.setTimer(() => this.endAbandoned(room), this.allGoneMs);
  }

  /** Nobody came back: the match is VOIDED (rule 22) - no winner, nothing recorded - through the same commit as every other end. */
  private endAbandoned(room: BugRoom): void {
    room.allGoneTimer = null;
    if (room.status !== 'active' || this.connectedHumans(room) > 0) return;
    const next = voidMatch(room.match, Math.max(this.timers.now(), room.match.nowMs));
    if (next === null || next.result === null) return;
    this.commit(room, next, [{ kind: 'result', seq: next.seq, result: next.result }]);
  }

  // --- Moves, drops and resignation -----------------------------------------------------------------------------------------------

  /** `bug_move`. The seat is the socket's own; the engine judges the move on the seat's board. */
  makeMove(socketId: string, payload: unknown): BugAck<{ seq: number }> {
    const parsed = validateBugMovePayload(payload);
    if (!parsed.ok) return parsed;
    const { roomId, board, from, to, promotion } = parsed.value;
    return this.submit(socketId, roomId, { kind: 'move', board, from, to, ...(promotion === undefined ? {} : { promotion }) }, true);
  }

  /** `bug_drop`. */
  makeDrop(socketId: string, payload: unknown): BugAck<{ seq: number }> {
    const parsed = validateBugDropPayload(payload);
    if (!parsed.ok) return parsed;
    const { roomId, board, piece, square } = parsed.value;
    return this.submit(socketId, roomId, { kind: 'drop', board, piece, square }, true);
  }

  /** `bug_resign`: the resigner's team loses at once, from any seat and at any time (also off turn). */
  resign(socketId: string, payload: unknown): BugAck {
    const parsed = validateBugRoomPayload(payload);
    if (!parsed.ok) return parsed;
    const result = this.submit(socketId, parsed.value.roomId, { kind: 'resign' }, false);
    return result.ok ? { ok: true } : result;
  }

  private submit(socketId: string, roomId: string, action: BughouseAction, limited: boolean): BugAck<{ seq: number }> {
    const located = this.locate(socketId, roomId);
    if (!located) return bugRefusal('noGame', NO_GAME);
    const { room, seat } = located;
    if (limited && this.actionRateLimited(room.seats[seat])) return bugRefusal('rateLimited', REFUSAL_TEXT.rateLimited);
    const outcome = this.run(room, { seat, action });
    if (outcome.kind === 'applied') return { ok: true, seq: room.match.seq };
    // a flag was already due: it ended the match (published), and this request arrived after it
    if (outcome.kind === 'flag') return bugRefusal('flagDue', REFUSAL_TEXT.flagDue);
    if (outcome.kind === 'rejected') return bugRefusal(outcome.reason, REFUSAL_TEXT[outcome.reason]);
    throw new Error('submit: the engine answered an input with idle'); // settle is idle only for a null input (a timer)
  }

  private actionRateLimited(seat: BugSeatRuntime): boolean {
    const now = this.timers.now();
    const recent = seat.actionCalls.filter((t) => now - t < BUG_ACTION_RATE_LIMIT.windowMs);
    const limited = recent.length >= BUG_ACTION_RATE_LIMIT.max;
    if (!limited) recent.push(now);
    seat.actionCalls = recent;
    return limited;
  }

  // --- End of the match -----------------------------------------------------------------------------------------------------------

  /** Ends a match the ENGINE has decided (a mate, a flag, a resignation, a void). */
  private endMatch(room: BugRoom): void {
    const result = room.match.result;
    if (result === null) throw new Error('endMatch: the engine has not ended this match');
    this.finish(room, { roomId: room.id, result, state: serializeMatch(room.match) });
  }

  /**
   * Ends a match for any reason: the result is recorded for late rejoins FIRST (so nothing below can lose it), then EVERY timer the room owns is cleared (both clock timers, both bot
   * timers, all-gone, each seat's grace - a timer left behind would keep the whole room alive), `bug_game_over` goes to every seat and spectator, sockets are released and the room
   * is removed. The result stays rejoinable for BUG_FINISHED_RETENTION_MS (B22) and is then dropped by its own timer.
   */
  private finish(room: BugRoom, gameOver: BugGameOverPayload): void {
    room.status = 'finished';
    const finishedAt = this.timers.now();
    const cleanup = this.timers.setTimer(() => this.finishedRooms.delete(room.id), BUG_FINISHED_RETENTION_MS, { unref: true });
    this.finishedRooms.set(room.id, { gameOver, tokens: room.seats.map((s) => s.playerToken).filter((t): t is string => t !== null), finishedAt, cleanup });
    for (const board of BOARD_IDS) {
      if (room.clockTimers[board] !== null) this.timers.clearTimer(room.clockTimers[board]);
      room.clockTimers[board] = null;
      const pending = room.botTimers[board];
      if (pending) this.timers.clearTimer(pending.handle);
      room.botTimers[board] = null;
    }
    if (room.allGoneTimer !== null) this.timers.clearTimer(room.allGoneTimer);
    room.allGoneTimer = null;
    for (const seat of room.seats) {
      if (seat.graceTimer !== null) this.timers.clearTimer(seat.graceTimer);
      seat.graceTimer = null;
    }

    this.broadcast(room, 'bug_game_over', gameOver);
    for (const seat of room.seats) if (seat.socketId) this.socketToSeat.delete(seat.socketId);
    for (const spectator of room.spectators) this.socketToSpectating.delete(spectator);
    this.rooms.delete(room.id);
  }

  // --- Connection lifecycle -------------------------------------------------------------------------------------------------------

  /**
   * `bug_rejoin`: a human re-attaches with its token (a fresh socket after a drop, a second device, or a client that restarted with the stored roomId and token). A newer connection
   * silently replaces the older one. A match that already ENDED (within the retention) answers with its result instead of "not found".
   */
  rejoin(socketId: string, payload: unknown): BugRejoinAck {
    const parsed = validateBugRejoin(payload);
    if (!parsed.ok) return bugRefusal('invalidRequest', 'Invalid request.');
    const { roomId, playerToken } = parsed.value;

    const room = this.rooms.get(roomId);
    if (!room || room.status !== 'active') {
      const finished = this.finishedRooms.get(roomId);
      if (finished && finished.tokens.includes(playerToken) && this.timers.now() - finished.finishedAt < BUG_FINISHED_RETENTION_MS) {
        return { ok: true, finished: true, gameOver: finished.gameOver };
      }
      return bugRefusal('noGame', 'The game was not found or has already ended.');
    }
    const seat = SEATS.find((s) => room.seats[s].playerToken === playerToken);
    if (seat === undefined) return bugRefusal('noGame', 'Invalid playerToken.');
    // A socket seated elsewhere (or spectating) cannot also take this seat.
    const current = this.socketToSeat.get(socketId);
    if (current && !(current.roomId === room.id && current.seat === seat)) return bugRefusal('noGame', 'This connection is already in another game.');
    this.stopSpectating(socketId);

    const runtime = room.seats[seat];
    if (runtime.socketId && runtime.socketId !== socketId) this.socketToSeat.delete(runtime.socketId); // the older connection no longer owns the seat
    runtime.socketId = socketId;
    runtime.connected = true;
    runtime.disconnectedAt = null;
    this.socketToSeat.set(socketId, { roomId: room.id, seat });
    // Back in: the grace countdown and the all-gone countdown (if this was the last human) are over...
    if (runtime.graceTimer !== null) this.timers.clearTimer(runtime.graceTimer);
    runtime.graceTimer = null;
    if (room.allGoneTimer !== null) this.timers.clearTimer(room.allGoneTimer);
    room.allGoneTimer = null;
    // ...and a seat a bot had taken over is the human's again (RETAKE, at any time until the match ends). scheduleBots also cancels a bot move that was already pending for this seat.
    if (runtime.controller === 'bot') {
      runtime.controller = 'human';
      runtime.botReason = undefined;
      runtime.elo = undefined;
    }
    this.scheduleBots(room);
    this.broadcastSeats(room);

    return { ok: true, state: { ...this.roomState(room), seat } };
  }

  /** A socket went away: a seated human is marked disconnected (everyone is told; its clock keeps running), a spectator just leaves. A socket already replaced by a newer connection for the same seat is ignored. */
  handleDisconnect(socketId: string): void {
    this.stopSpectating(socketId);
    const located = this.socketToSeat.get(socketId);
    if (!located) return;
    this.socketToSeat.delete(socketId);
    const room = this.rooms.get(located.roomId);
    if (!room || room.status !== 'active') return;
    const runtime = room.seats[located.seat];
    if (runtime.socketId !== socketId) return; // replaced by a newer connection
    runtime.socketId = null;
    runtime.connected = false;
    runtime.disconnectedAt = this.timers.now();
    // A human's seat is taken over by a bot if it stays away for the grace period.
    if (runtime.controller === 'human' && runtime.graceTimer === null) {
      runtime.graceTimer = this.timers.setTimer(() => this.onGraceExpired(room, located.seat), this.graceMs);
    }
    this.broadcastSeats(room);
    this.checkAllGone(room);
  }

  // --- Spectating, chat and quick messages ----------------------------------------------------------------------------------------

  /** Whether the socket is SEATED in a game (a player, not a spectator): such a socket cannot queue for another game. */
  isSeated(socketId: string): boolean {
    return this.socketToSeat.has(socketId);
  }

  /** Games in progress, NEWEST first and at most BUG_ACTIVE_GAMES_LIST_MAX - names and kinds only, never a token or a socket id. */
  listActiveGames(): BugActiveGameSummary[] {
    return [...this.rooms.values()]
      .filter((room) => room.status === 'active')
      .reverse()
      .slice(0, BUG_ACTIVE_GAMES_LIST_MAX)
      .map((room) => ({ roomId: room.id, timeControlLabel: room.timeControlLabel, seats: room.seats.map((s) => ({ name: s.name, kind: s.controller })) }));
  }

  /** `bug_spectate_game`: read-only, both boards (one snapshot). A socket that plays in a game cannot also watch; a room holds at most BUG_MAX_SPECTATORS_PER_ROOM. */
  spectate(socketId: string, payload: unknown): BugAck<{ state: BugSpectateState }> {
    const parsed = validateBugRoomPayload(payload);
    if (!parsed.ok) return parsed;
    const room = this.rooms.get(parsed.value.roomId);
    if (!room || room.status !== 'active') return bugRefusal('noGame', 'The game was not found or has already ended.');
    if (this.socketToSeat.has(socketId)) return bugRefusal('noGame', 'You are playing in a game - you cannot also spectate.');
    if (!room.spectators.has(socketId) && room.spectators.size >= BUG_MAX_SPECTATORS_PER_ROOM) return bugRefusal('rateLimited', 'This game has too many spectators.');
    this.stopSpectating(socketId);
    room.spectators.add(socketId);
    this.socketToSpectating.set(socketId, room.id);
    return { ok: true, state: this.roomState(room) };
  }

  /** `bug_stop_spectating` (also implicit on disconnect, rejoin and starting to play). */
  stopSpectating(socketId: string): void {
    const roomId = this.socketToSpectating.get(socketId);
    if (!roomId) return;
    this.socketToSpectating.delete(socketId);
    this.rooms.get(roomId)?.spectators.delete(socketId);
  }

  /**
   * `bug_chat` (Q1, HP10): free text to the sender's PARTNER only. The recipients are computed here from the seat map - the payload is read for `roomId` and `text` and nothing else, so
   * nothing a client sends can name a recipient. The sender gets the line back (the echo) so its own panel shows it; opponents and spectators never do, and nothing is stored. A partner
   * that is a BOT (a fill, or a seat taken over) is a refusal the sender is told about, and nothing is delivered or counted; a partner who is a human but not connected right now cannot
   * receive it (`delivered: false`). A seat may send one line per BUG_CHAT_MIN_INTERVAL_MS.
   */
  sendChat(socketId: string, payload: unknown): BugAck<{ delivered: boolean }> {
    const parsed = validateBugRoomPayload(payload);
    if (!parsed.ok) return parsed;
    const located = this.locate(socketId, parsed.value.roomId);
    if (!located) return bugRefusal('noGame', NO_GAME);
    const text = normalizeBugChatText((payload as { text?: unknown }).text);
    if (!text.ok) return text;
    const { room, seat } = located;
    const partner = room.seats[partnerOf(seat)];
    if (partner.controller === 'bot') return bugRefusal('partnerIsBot', REFUSAL_TEXT.partnerIsBot);
    const runtime = room.seats[seat];
    const now = this.timers.now();
    if (runtime.lastChatAt !== null && now - runtime.lastChatAt < BUG_CHAT_MIN_INTERVAL_MS) return bugRefusal('rateLimited', 'You are sending messages too fast.');
    runtime.lastChatAt = now;
    const message: BugChatFromPayload = { seat, name: runtime.name, text: text.value };
    this.emit(socketId, 'bug_chat_from', message);
    if (partner.socketId) this.emit(partner.socketId, 'bug_chat_from', message);
    return { ok: true, delivered: partner.socketId !== null };
  }

  /**
   * `bug_quick` (B14, HP10): one of the ten codes, 0-9 - never text - to the sender's PARTNER only (no echo, no spectator, nothing stored). Per seat: the same code again within
   * BUG_QUICK_DUPLICATE_MS is a duplicate, then at most one per BUG_QUICK_MIN_INTERVAL_MS and BUG_QUICK_WINDOW_MAX per BUG_QUICK_WINDOW_MS; an excess is refused, never queued, and a
   * refused message counts toward nothing. A BOT partner is told to the sender (`partnerIsBot`) and consumes nothing.
   */
  sendQuick(socketId: string, payload: unknown): BugAck<{ delivered: boolean }> {
    const parsed = validateBugRoomPayload(payload);
    if (!parsed.ok) return parsed;
    const code = validateBugQuickCode((payload as { code?: unknown }).code);
    if (!code.ok) return code;
    const located = this.locate(socketId, parsed.value.roomId);
    if (!located) return bugRefusal('noGame', NO_GAME);
    const { room, seat } = located;
    const partner = room.seats[partnerOf(seat)];
    if (partner.controller === 'bot') return bugRefusal('partnerIsBot', REFUSAL_TEXT.partnerIsBot);
    const runtime = room.seats[seat];
    const now = this.timers.now();
    const recent = runtime.quickLog.filter((entry) => now - entry.at < BUG_QUICK_WINDOW_MS);
    runtime.quickLog = recent;
    const last = recent.length > 0 ? recent[recent.length - 1] : null;
    if (last !== null && last.code === code.value && now - last.at < BUG_QUICK_DUPLICATE_MS) return bugRefusal('duplicate', REFUSAL_TEXT.duplicate);
    if (last !== null && now - last.at < BUG_QUICK_MIN_INTERVAL_MS) return bugRefusal('rateLimited', REFUSAL_TEXT.rateLimited);
    if (recent.length >= BUG_QUICK_WINDOW_MAX) return bugRefusal('rateLimited', REFUSAL_TEXT.rateLimited);
    recent.push({ at: now, code: code.value });
    const message: BugQuickFromPayload = { seat, code: code.value };
    if (partner.socketId) this.emit(partner.socketId, 'bug_quick_from', message);
    return { ok: true, delivered: partner.socketId !== null };
  }

  // --- Helpers --------------------------------------------------------------------------------------------------------------------

  /** The active room and seat of a socket - but only if the socket really sits in the room named by the request. */
  private locate(socketId: string, roomId: string): { room: BugRoom; seat: BughouseSeat } | null {
    const seated = this.socketToSeat.get(socketId);
    if (!seated || seated.roomId !== roomId) return null;
    const room = this.rooms.get(roomId);
    if (!room || room.status !== 'active') return null;
    return { room, seat: seated.seat };
  }

  private seatInfos(room: BugRoom): BugSeats {
    const now = this.timers.now();
    return SEATS.map((seat): BugSeatInfo => {
      const s = room.seats[seat];
      return {
        seat,
        kind: s.controller,
        ...(s.botReason ? { botReason: s.botReason } : {}),
        name: s.name,
        ...(s.elo !== undefined ? { elo: s.elo } : {}),
        connected: s.controller === 'bot' ? true : s.connected,
        // A disconnected human whose seat is still waiting to be taken over: how long it has left (the client counts down from this).
        ...(s.graceTimer !== null && s.disconnectedAt !== null ? { graceMsLeft: Math.max(0, this.graceMs - (now - s.disconnectedAt)) } : {}),
      };
    }) as BugSeats;
  }

  private roomState(room: BugRoom): BugRoomState {
    return {
      roomId: room.id,
      seats: this.seatInfos(room),
      timeControl: room.timeControl,
      timeControlLabel: room.timeControlLabel,
      seq: room.match.seq,
      state: serializeMatch(room.match),
      serverNowMs: this.timers.now(),
      log: room.log.slice(),
    };
  }

  private broadcastSeats(room: BugRoom): void {
    const payload: BugSeatUpdatePayload = { roomId: room.id, seats: this.seatInfos(room) };
    this.broadcast(room, 'bug_seat_update', payload);
  }

  /** To every human seat that has a live socket, and every spectator. NEVER used for chat or quick messages (those go to explicit recipients). */
  private broadcast<K extends keyof BugServerToClientEvents>(room: BugRoom, event: K, payload: Parameters<BugServerToClientEvents[K]>[0]): void {
    for (const seat of room.seats) if (seat.socketId) this.emit(seat.socketId, event, payload);
    for (const spectator of room.spectators) this.emit(spectator, event, payload);
  }

  /** The only place an event leaves the manager. A failing send must not abort the funnel that called it (see the file header). */
  private emit<K extends keyof BugServerToClientEvents>(socketId: string, event: K, payload: Parameters<BugServerToClientEvents[K]>[0]): void {
    try {
      this.io.to(socketId).emit(event, payload);
    } catch (err) {
      console.error(`[bughouseRooms] failed to send ${event} to ${socketId}:`, err);
    }
  }
}
