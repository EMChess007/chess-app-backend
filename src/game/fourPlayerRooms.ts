/**
 * 4 Player Chess ONLINE — the server's room manager (workstream W2; design in FOUR_PLAYER_ONLINE_SPEC.md §4).
 *
 * WHAT IT IS. The 4-player counterpart of `RoomManager` (rooms.ts): it owns every live 4-seat game, is the SINGLE authority on the
 * position and the clocks, and speaks the `four_*` protocol of `fourPlayerWire.ts` (a GENERATED copy of the app's wire contract, so a
 * client and this file cannot disagree about a field). Clients never send positions: they send a from/to, the server resolves it with
 * the engine's own `findLegalMove` for the SOCKET'S seat and broadcasts the resulting snapshot (`serialize(state)` + the engine's events).
 *
 * THE ONE FUNNEL. Everything that changes a game - a human move, a resignation, a flag fall - ends in `commit()`, and `commit()` is the
 * only place `room.state`, `room.clock` and `room.seq` are assigned after creation. It publishes exactly one `four_state` (seq + 1) and
 * then either ends the game or re-arms the clock timer. Time is charged by `charge()`, a PURE computation whose result is fed INTO a
 * commit (it never assigns anything), so there is no path that mutates a room without publishing it. A test pins this at source level.
 *
 * CLOCKS. Only the seat on move runs (an engine invariant: the turn is only ever handed to an ACTIVE seat; dead kings' random walks and
 * eliminated seats cost nobody time). A seat's time is charged lazily - when its move arrives, when someone else resigns, or when its
 * timer fires - from `turnStartedAt`, with the engine's own `clockTick`. If charging flags the mover, that seat is eliminated by the
 * engine's normal timeout path and THAT is what gets published (actor 'clock'): the server decides, a client's late move is refused. The
 * timer fires `charge(force)`, which spends the seat's whole remaining time even if the timer woke a millisecond early.
 *
 * SECURITY. A seat is always derived from the SOCKET (`socketToSeat`), never from the payload. Player tokens are random UUIDs; they leave
 * the server only in `four_match_found` to their own seat's socket and in that seat's own rejoin answer. Every inbound call takes
 * `unknown` and validates with the shared validators from the wire file, so a hostile payload can neither throw nor reach the engine.
 *
 * EMITS CANNOT ABORT A COMMIT. By the time anything is sent the state has already changed, so a send that throws (a socket going away)
 * must neither skip the other recipients nor leave the room half-updated: `emit()` catches, logs and moves on. (Lesson from the 2-player
 * `endGame`, where the result record had to be written BEFORE anything that could fail.)
 *
 * BOTS (W3). A seat is `controller: 'human' | 'bot'`. After every commit - and when a room is created - `scheduleBot()` arms ONE bot timer
 * if the seat on move is a bot's; when it fires the bot's move goes through the same funnel as anyone's (actor 'bot': time charged, move
 * played, increment added). The callback re-checks the room, the `seq` it was armed for, the seat's controller and that it is still the
 * seat's turn, so a callback that outlived a retake is a no-op. Bots run on their OWN random stream (`botRng`), so the engine's randomness
 * (dead kings' walks) does not depend on what a bot decided - which is what lets a test replay a game on an independent engine. A bot
 * decision is synchronous on the shared event loop, so every bot is clamped to FOUR_SERVER_BOT_MAX_ELO (the "careful" tier, ~20 ms worst case).
 *
 * DISCONNECT -> TAKEOVER -> RETAKE. A disconnected human's seat keeps its clock running and, after FOUR_TAKEOVER_GRACE_MS, is taken over by a
 * bot (named as the human, elo FOUR_BOT_ELO, `botReason: 'takeover'`) - but only if the seat is still active, still disconnected and some
 * ORIGINAL human is still connected: a bot is never handed an empty room. The human may retake the seat by rejoining at ANY time until the
 * game ends: the seat becomes human again, its grace timer and pending bot move are cancelled.
 *
 * EVERY HUMAN LEAVES. When no original human has a live socket an FOUR_ALL_GONE_MS timer starts (any rejoin cancels it); at expiry the game
 * ends with reason 'abandoned' and no winners. And when no human-controlled seat is still ACTIVE but a human is still watching (eliminated
 * seats place by score, so the game is finished for them), bots FAST-FORWARD: no think delay, one ply per timer tick.
 *
 * NOT HERE (W4): the queue, seat assignment and the socket event registration. A room is created with its four seats already decided.
 */

import { randomUUID } from 'node:crypto';
import type { Server } from 'socket.io';
import {
  clocksToWireMs,
  normalizeFourChatText,
  validateFourId,
  validateFourMovePayload,
  validateFourTimeControl,
  validateFourVariant,
  type FourActiveGameSummary,
  type FourActor,
  type FourAck,
  type FourChatMessagePayload,
  type FourClocksMs,
  type FourGameOverPayload,
  type FourLogEntry,
  type FourMatchFoundPayload,
  type FourMoveInfo,
  type FourPromotion,
  type FourRejoinAck,
  type FourRejoinState,
  type FourRoomState,
  type FourSeatInfo,
  type FourSeats,
  type FourSeatUpdatePayload,
  type FourServerToClientEvents,
  type FourSpectateState,
  type FourStatePayload,
  type FourTimeControl,
  type FourVariant,
  type FourWireEvent,
} from './fourPlayerWire.js';
import {
  BISHOP,
  KNIGHT,
  QUEEN,
  ROOK,
  addIncrement,
  chooseBotMoveFor,
  clockTick,
  createClock,
  findLegalMove,
  initialState,
  legalMoves,
  moveLabel,
  parseSquare,
  piecesLeft,
  playMove,
  promotionOf,
  resign,
  rulesFor,
  serialize,
  squareName,
  type FourPlayerClock,
  type FourPlayerState,
  type GameEvent,
  type Move,
  type Seat,
} from './fourPlayer/index.js';
import {
  FOUR_ACTIVE_GAMES_LIST_MAX,
  FOUR_ALL_GONE_MS,
  FOUR_BOT_ELO,
  FOUR_CHAT_MIN_INTERVAL_MS,
  FOUR_FAST_FORWARD_DELAY_MS,
  FOUR_FINISHED_RETENTION_MS,
  FOUR_FINISHED_SWEEP_INTERVAL_MS,
  FOUR_MAX_SPECTATORS_PER_ROOM,
  FOUR_MOVE_RATE_LIMIT,
  FOUR_NAME_MAX_LENGTH,
  FOUR_SERVER_BOT_MAX_ELO,
  fourBotThinkMs,
  resolveFourGraceMs,
} from './fourPlayerConfig.js';

/** What a bot decision needs from the engine: given a position, a strength and a random stream, a move (or null). Injectable for tests. */
export type FourBotChooser = (state: FourPlayerState, elo: number, rng: () => number) => Move | null;

/** One seat as the matchmaker (W4) hands it over; `seats[i]` is seat i (Red, Blue, Yellow, Green), already in the random order decided. */
export interface FourSeatSetup {
  kind: 'human' | 'bot';
  /** The human's socket; null for a bot. */
  socketId: string | null;
  /** Shown to everyone: a username, "Guest" or a bot's name. Never a userId. */
  name: string;
  /** Bots only. */
  elo?: number;
  /** Bots only: why this seat is a bot. */
  botReason?: 'fill' | 'takeover';
}
export type FourSeatSetups = [FourSeatSetup, FourSeatSetup, FourSeatSetup, FourSeatSetup];

export interface CreateFourRoomParams {
  seats: FourSeatSetups;
  timeControl: FourTimeControl;
  timeControlLabel?: string;
  /** Which game this room plays; omitted = 4 Player Chess. Fixed for the room's whole life. */
  variant?: FourVariant;
}

export interface CreateFourRoomResult {
  roomId: string;
  /** Per seat: the human's token, null for a bot. (Also sent to each human in `four_match_found`.) */
  tokens: (string | null)[];
}

interface FourSeatRuntime {
  controller: 'human' | 'bot';
  botReason?: 'fill' | 'takeover';
  elo?: number;
  /** True for a seat that started as a human - W3's takeover turns `controller` into 'bot' but the seat keeps this. */
  originalHuman: boolean;
  socketId: string | null;
  name: string;
  playerToken: string | null;
  connected: boolean;
  disconnectedAt: number | null;
  lastChatAt: number | null;
  /** Timestamps of this seat's recent `four_make_move` calls (rate limit). */
  moveCalls: number[];
  /** A disconnected human's countdown to the bot takeover (see FOUR_TAKEOVER_GRACE_MS); null when there is none. */
  graceTimer: ReturnType<typeof setTimeout> | null;
}

interface FourRoom {
  id: string;
  /** 4 Player Chess ('ffa') or 4 Player Giveaway: picks the start rules, the default bot and what `scores` mean in `four_game_over`. */
  variant: FourVariant;
  status: 'active' | 'finished';
  state: FourPlayerState;
  clock: FourPlayerClock;
  /** `Date.now()` at which the seat on move started its turn (the clock is charged from here). Reset on every commit. */
  turnStartedAt: number;
  /** Number of `four_state` published so far; the match-found snapshot is seq 0. */
  seq: number;
  seats: [FourSeatRuntime, FourSeatRuntime, FourSeatRuntime, FourSeatRuntime];
  log: FourLogEntry[];
  spectators: Set<string>;
  timeControl: FourTimeControl;
  timeControlLabel: string;
  clockTimer: ReturnType<typeof setTimeout> | null;
  /** At most one: the pending move of the bot on move (see scheduleBot). */
  botTimer: ReturnType<typeof setTimeout> | null;
  /** Running while NO original human has a live socket; at expiry the game ends with no result. */
  allGoneTimer: ReturnType<typeof setTimeout> | null;
  /** The randomness the ENGINE uses (dead kings' walks); injectable for tests. */
  rng: () => number;
}

/** What a finished room keeps for a late `four_rejoin` (see FOUR_FINISHED_RETENTION_MS): the result, and who may ask for it. */
interface FourFinishedRoom {
  gameOver: FourGameOverPayload;
  tokens: readonly string[];
  finishedAt: number;
}

/** The seat's pieces/time as they stand after an action, ready to be committed. */
interface CommitStep {
  actor: FourActor;
  state: FourPlayerState;
  clock: FourPlayerClock;
  events: GameEvent[];
  move: FourMoveInfo | null;
  log?: FourLogEntry;
}

const PROMOTION_TYPE: Record<FourPromotion, number> = { q: QUEEN, r: ROOK, b: BISHOP, n: KNIGHT };
const PROMOTION_LETTER: Record<number, FourPromotion> = { [QUEEN]: 'q', [ROOK]: 'r', [BISHOP]: 'b', [KNIGHT]: 'n' };

const NO_GAME = 'No active game found for this connection.';

export class FourRoomManager {
  private rooms = new Map<string, FourRoom>();
  private finishedRooms = new Map<string, FourFinishedRoom>();
  private socketToSeat = new Map<string, { roomId: string; seat: Seat }>();
  private socketToSpectating = new Map<string, string>();
  private readonly rng: () => number;
  private readonly botRng: () => number;
  private readonly chooseBot: FourBotChooser;
  /** How long a disconnected human's seat is left alone before a bot takes it over: 45 s (FOUR_TAKEOVER_GRACE_MS), or the FOUR_GRACE_MS test override. */
  private readonly graceMs: number;

  /**
   * `rng` is the ENGINE's randomness (dead kings' walks), `botRng` the BOTS' (kept separate so a bot's decision never shifts the engine's
   * stream), `chooseBotMove` the decision function (the engine's own; a test can inject a recording or faulty one), `graceMs` the takeover
   * grace (default `resolveFourGraceMs()`: 45 s unless the non-production FOUR_GRACE_MS override is set).
   */
  constructor(private io: Server, options: { rng?: () => number; botRng?: () => number; chooseBotMove?: FourBotChooser; graceMs?: number } = {}) {
    this.rng = options.rng ?? Math.random;
    this.botRng = options.botRng ?? Math.random;
    this.chooseBot = options.chooseBotMove ?? chooseBotMoveFor; // dispatches on the position's rules, so a Giveaway room never gets the Chess bot
    this.graceMs = options.graceMs ?? resolveFourGraceMs();
    // Without a sweep a long-running process would keep every finished game's tiny record until a late rejoin happened to look at it.
    // unref()'d so it never keeps the process alive on its own (same as the 2-player manager).
    setInterval(() => this.sweepFinishedRooms(), FOUR_FINISHED_SWEEP_INTERVAL_MS).unref();
  }

  // --- Creation -------------------------------------------------------------------------------------------------------------

  /**
   * Starts a game with the four seats already decided (the matchmaker, W4, shuffles them) and tells every human their own seat, token
   * and the starting snapshot (`four_match_found`, seq 0). Throws on a programming error (a bad time control, not four seats, no human):
   * this is internal, callers validate user input before it gets here.
   */
  createRoom(params: CreateFourRoomParams): CreateFourRoomResult {
    const timeControl = validateFourTimeControl(params.timeControl);
    if (!timeControl.ok) throw new Error(`createRoom: ${timeControl.error}`);
    const variant = validateFourVariant(params.variant);
    if (!variant.ok) throw new Error(`createRoom: ${variant.error}`);
    if (!Array.isArray(params.seats) || params.seats.length !== 4) throw new Error('createRoom: exactly four seats are required');
    if (!params.seats.some((s) => s.kind === 'human')) throw new Error('createRoom: at least one human seat is required');
    const humanSockets = params.seats.filter((s) => s.kind === 'human').map((s) => s.socketId);
    if (humanSockets.some((id) => !id) || new Set(humanSockets).size !== humanSockets.length) throw new Error('createRoom: every human seat needs its own socket');
    for (const socketId of humanSockets) {
      if (this.socketToSeat.has(socketId as string)) throw new Error('createRoom: a socket is already seated in another game');
    }
    for (const socketId of humanSockets) this.stopSpectating(socketId as string); // a player cannot also be a spectator

    const id = randomUUID();
    const seats = params.seats.map((setup): FourSeatRuntime => {
      const human = setup.kind === 'human';
      return {
        controller: setup.kind,
        botReason: human ? undefined : (setup.botReason ?? 'fill'),
        elo: human ? undefined : setup.elo,
        originalHuman: human,
        socketId: human ? setup.socketId : null,
        name: String(setup.name).slice(0, FOUR_NAME_MAX_LENGTH),
        playerToken: human ? randomUUID() : null,
        connected: true,
        disconnectedAt: null,
        lastChatAt: null,
        moveCalls: [],
        graceTimer: null,
      };
    }) as FourRoom['seats'];

    const room: FourRoom = {
      id,
      variant: variant.value,
      status: 'active',
      state: initialState(rulesFor(variant.value)),
      clock: createClock(timeControl.value.initialSeconds, timeControl.value.incrementSeconds, true),
      turnStartedAt: Date.now(),
      seq: 0,
      seats,
      log: [],
      spectators: new Set(),
      timeControl: timeControl.value,
      timeControlLabel: params.timeControlLabel ?? defaultLabel(timeControl.value),
      clockTimer: null,
      botTimer: null,
      allGoneTimer: null,
      rng: this.rng,
    };
    this.rooms.set(id, room);

    // ONE reading of the clocks for every recipient. They were read inside the loop at first, so on a real clock the seat on move showed
    // 299999 / 299998 / 300000 ms to different players of the SAME starting snapshot (found by the first real-socket run, W6: every stub
    // test freezes Date, so none could see it).
    const startingClocksMs = this.liveClocksMs(room);
    const startingSeats = this.seatInfos(room);
    for (const seat of [0, 1, 2, 3] as Seat[]) {
      const runtime = seats[seat];
      if (runtime.controller !== 'human' || !runtime.socketId) continue;
      this.socketToSeat.set(runtime.socketId, { roomId: id, seat });
      const payload: FourMatchFoundPayload = {
        roomId: id,
        variant: room.variant,
        seat,
        playerToken: runtime.playerToken as string,
        seats: startingSeats,
        timeControl: room.timeControl,
        timeControlLabel: room.timeControlLabel,
        state: serialize(room.state),
        clocksMs: startingClocksMs,
        seq: 0,
      };
      this.emit(runtime.socketId, 'four_match_found', payload);
    }
    this.armClockTimer(room);
    this.scheduleBot(room); // Red may be a bot
    return { roomId: id, tokens: seats.map((s) => s.playerToken) };
  }

  // --- The funnel -----------------------------------------------------------------------------------------------------------

  /**
   * THE ONLY MUTATOR of `room.state`, `room.clock` and `room.seq` (after creation). Installs `step`'s position and clock, restarts the
   * turn timer base, records the move in the log, publishes exactly one `four_state` (seq + 1) to every seat and spectator, then ends
   * the game if the engine says it is over or re-arms the clock timer for the seat now on move.
   */
  private commit(room: FourRoom, step: CommitStep): void {
    room.state = step.state;
    room.clock = step.clock;
    room.turnStartedAt = Date.now();
    room.seq++;
    if (step.log) room.log.push(step.log);
    const payload: FourStatePayload = {
      roomId: room.id,
      seq: room.seq,
      actor: step.actor,
      move: step.move,
      events: step.events as FourWireEvent[],
      state: serialize(room.state),
      clocksMs: clocksToWireMs(room.clock.seconds),
    };
    this.broadcast(room, 'four_state', payload);
    if (room.state.result) this.endGame(room);
    else {
      this.armClockTimer(room);
      this.scheduleBot(room);
    }
  }

  /**
   * What the seat on move's clock looks like NOW, as a pure computation (assigns nothing): the engine's `clockTick` with the time since
   * the turn began. If it returns events, the mover's time ran out and the engine already eliminated it (state includes that). With
   * `force` (the timer fired) the seat's whole remaining time is spent, so a timer that woke a hair early still flags.
   */
  private charge(room: FourRoom, force: boolean): { state: FourPlayerState; clock: FourPlayerClock; events: GameEvent[] } {
    const mover = room.state.turn;
    let elapsed = (Date.now() - room.turnStartedAt) / 1000;
    if (force) elapsed = Math.max(elapsed, room.clock.seconds[mover]);
    return clockTick(room.state, room.clock, elapsed, room.rng);
  }

  /** (Re)starts the one timer a room has: it fires when the seat on move would run out of time. */
  private armClockTimer(room: FourRoom): void {
    if (room.clockTimer) clearTimeout(room.clockTimer);
    room.clockTimer = null;
    if (room.status !== 'active' || room.state.result) return;
    const remainingMs = Math.max(0, Math.ceil(room.clock.seconds[room.state.turn] * 1000));
    room.clockTimer = setTimeout(() => this.onClockTimer(room), remainingMs);
  }

  /**
   * The clock timer fired. EQUIVALENT-MUTANT NOTE (W2 mutation set, "the status guard in the timer callback alone"): the `status !== 'active'` guard is
   * a second line of defence - `finish()` clears this timer, so a finished room's callback can never run - and removing it changes nothing observable.
   */
  private onClockTimer(room: FourRoom): void {
    room.clockTimer = null;
    if (room.status !== 'active') return;
    const tick = this.charge(room, true);
    if (tick.events.length > 0) this.commit(room, { actor: 'clock', state: tick.state, clock: tick.clock, events: tick.events, move: null });
    else this.armClockTimer(room); // not actually out of time (cannot happen with force; kept so a stale timer can never stall a room)
  }

  // --- Bots, takeover and abandonment ---------------------------------------------------------------------------------------------

  /**
   * Original humans that currently have a live socket: the ones who can still watch or play (a seat a bot has taken over does not count).
   * EQUIVALENT-MUTANT NOTES (W3 mutation set): counting `s.connected` instead of `s.socketId !== null`, or dropping `s.originalHuman &&`, changes nothing:
   * `socketId` and `connected` are always set and cleared together (rejoin / handleDisconnect; a taken-over seat has both cleared) and a bot seat has no socket.
   */
  private connectedHumans(room: FourRoom): number {
    return room.seats.filter((s) => s.originalHuman && s.socketId !== null).length;
  }

  /**
   * True when no human-controlled seat is still ACTIVE but at least one human is still connected: those humans are eliminated and only
   * waiting for the final placing, so the bots finish the game without think delays. A disconnected ACTIVE human still counts as playing
   * (it may come back) until its seat is taken over.
   */
  private isFastForward(room: FourRoom): boolean {
    const humanStillPlaying = room.seats.some((s, seat) => s.controller === 'human' && room.state.status[seat] === 'active');
    return !humanStillPlaying && this.connectedHumans(room) > 0;
  }

  /** (Re)arms the room's ONE bot timer: it fires when the bot on move should play. Called after every commit and after a takeover or a
   * retake, so it also CANCELS a pending move whose seat is no longer a bot's. */
  private scheduleBot(room: FourRoom): void {
    if (room.botTimer) clearTimeout(room.botTimer);
    room.botTimer = null;
    if (room.status !== 'active' || room.state.result) return;
    const seat = room.state.turn;
    if (room.seats[seat].controller !== 'bot' || room.state.status[seat] !== 'active') return;
    const delay = this.isFastForward(room) ? FOUR_FAST_FORWARD_DELAY_MS : fourBotThinkMs(room.timeControl.initialSeconds);
    const armedFor = room.seq;
    room.botTimer = setTimeout(() => this.playBotTurn(room, armedFor), delay);
  }

  /** The bot on move plays - through the same funnel as any move (time charged, increment added), but nothing about it is trusted: the
   * decision is clamped to FOUR_SERVER_BOT_MAX_ELO and checked against the legal moves, and a faulty bot can never stall a room.
   * EQUIVALENT-MUTANT NOTE (W3 set, "the no-legal-move guard"): the `legal.length === 0` branch is unreachable - the engine hands the turn only to an
   * active seat that HAS a legal move (one without is eliminated on the spot in 4 Player Chess; in 4 Player Giveaway it WINS and the game ends) - so it is a log-and-return safety net that no test can reach. */
  private playBotTurn(room: FourRoom, armedFor: number): void {
    room.botTimer = null;
    if (room.status !== 'active' || room.seq !== armedFor) return; // stale: the position moved on since this was armed
    const seat = room.state.turn;
    const runtime = room.seats[seat];
    if (runtime.controller !== 'bot' || room.state.status[seat] !== 'active') return; // a human retook the seat

    const tick = this.charge(room, false);
    if (tick.events.length > 0) {
      this.commit(room, { actor: 'clock', state: tick.state, clock: tick.clock, events: tick.events, move: null });
      return;
    }
    const legal = legalMoves(tick.state, seat);
    if (legal.length === 0) {
      console.error(`[fourRooms] seat ${seat} of room ${room.id} is on move with no legal move`); // the engine never hands out such a turn
      return;
    }
    const elo = Math.min(runtime.elo ?? FOUR_BOT_ELO, FOUR_SERVER_BOT_MAX_ELO);
    // An exception inside a timer callback would be an uncaught exception - it would take down EVERY game on this process - so a bot that
    // throws is treated like one that returns nothing: log it and play the first legal move.
    let move: Move | null = null;
    let fault = 'no move';
    try {
      move = this.chooseBot(tick.state, elo, this.botRng);
    } catch (err) {
      fault = `an error (${err instanceof Error ? err.message : String(err)})`;
    }
    if (move && !legal.some((m) => m.from === move!.from && m.to === move!.to && m.flags === move!.flags)) {
      fault = 'an illegal move';
      move = null;
    }
    if (!move) {
      console.error(`[fourRooms] the bot of seat ${seat} in room ${room.id} returned ${fault}; playing the first legal move instead`);
      move = legal[0];
    }
    const applied = playMove(tick.state, move, room.rng);
    this.commit(room, {
      actor: 'bot',
      state: applied.state,
      clock: addIncrement(tick.clock, seat, applied.state),
      events: applied.events,
      move: describeMove(seat, move),
      log: { seat, text: moveLabel(move) },
    });
  }

  /** The grace period of a disconnected human ran out. Takes the seat over with a bot - unless it came back, was eliminated meanwhile,
   * or nobody is left (then the all-gone timer decides: a bot is never handed an empty room).
   * EQUIVALENT-MUTANT NOTES (W3 set): the `status !== 'active'` guard and the `connected` / `controller` guard are second lines of defence: `finish()`
   * clears every grace timer and `rejoin()` cancels the seat's own, so this callback only ever runs for a disconnected, still-human seat of a live room. */
  private onGraceExpired(room: FourRoom, seat: Seat): void {
    const runtime = room.seats[seat];
    runtime.graceTimer = null;
    if (room.status !== 'active') return;
    if (runtime.controller !== 'human' || runtime.connected) return;
    if (room.state.status[seat] !== 'active') return;
    if (this.connectedHumans(room) === 0) return;
    runtime.controller = 'bot';
    runtime.botReason = 'takeover';
    runtime.elo = FOUR_BOT_ELO;
    this.broadcastSeats(room);
    this.scheduleBot(room); // if it is this seat's turn, the bot plays it
  }

  /** Starts the all-gone countdown if no original human is connected (and none is running). */
  private checkAllGone(room: FourRoom): void {
    if (room.allGoneTimer || this.connectedHumans(room) > 0) return;
    room.allGoneTimer = setTimeout(() => this.endAbandoned(room), FOUR_ALL_GONE_MS);
  }

  /** Nobody came back: the game ends with NO RESULT (no winners; nothing was ever persisted for 4-player).
   * EQUIVALENT-MUTANT NOTE (W3 set, "endAbandoned ends a game somebody has rejoined"): the `connectedHumans() > 0` guard is a second line of defence -
   * `rejoin()` cancels this countdown the moment anyone comes back - so removing it changes nothing observable. */
  private endAbandoned(room: FourRoom): void {
    room.allGoneTimer = null;
    if (room.status !== 'active' || this.connectedHumans(room) > 0) return;
    this.finish(room, { roomId: room.id, reason: 'abandoned', winners: [], scores: this.scoresOf(room), state: serialize(room.state) });
  }

  // --- Moves and resignation ------------------------------------------------------------------------------------------------

  /** `four_make_move`. The seat is the socket's own; an illegal / out-of-turn / late move leaves the room untouched (a LATE one also
   * publishes the flag fall that made it late). */
  makeMove(socketId: string, payload: unknown): FourAck<{ seq: number }> {
    const parsed = validateFourMovePayload(payload);
    if (!parsed.ok) return parsed;
    const located = this.locate(socketId, parsed.value.roomId);
    if (!located) return { ok: false, error: NO_GAME };
    const { room, seat } = located;
    if (this.rateLimited(room.seats[seat])) return { ok: false, error: 'Too many moves - slow down.' };
    if (room.state.status[seat] !== 'active') return { ok: false, error: 'You are out of this game.' };
    if (room.state.turn !== seat) return { ok: false, error: 'Not your turn.' };

    const promotionType = parsed.value.promotion ? PROMOTION_TYPE[parsed.value.promotion] : QUEEN;
    const move = findLegalMove(room.state, seat, parseSquare(parsed.value.from), parseSquare(parsed.value.to), promotionType);
    if (!move) return { ok: false, error: 'Illegal move.' };

    const tick = this.charge(room, false);
    if (tick.events.length > 0) {
      // The clock ran out before this move arrived: the seat is eliminated for time (that is what everyone sees), the move is void.
      this.commit(room, { actor: 'clock', state: tick.state, clock: tick.clock, events: tick.events, move: null });
      return { ok: false, error: 'Your time ran out.' };
    }
    const applied = playMove(tick.state, move, room.rng);
    this.commit(room, {
      actor: 'human',
      state: applied.state,
      clock: addIncrement(tick.clock, seat, applied.state),
      events: applied.events,
      move: describeMove(seat, move),
      log: { seat, text: moveLabel(move) },
    });
    return { ok: true, seq: room.seq };
  }

  /** `four_resign`: the seat is eliminated (no points to anyone) and the game goes on without it; the human stays attached as a watcher
   * until the game is over. Resigning off turn is fine - the seat on move's clock is charged first and may flag. */
  resign(socketId: string, payload: unknown): FourAck {
    const roomId = this.roomIdOf(payload);
    const located = roomId ? this.locate(socketId, roomId) : null;
    if (!located) return { ok: false, error: NO_GAME };
    const { room, seat } = located;
    if (room.state.status[seat] !== 'active') return { ok: false, error: 'You are already out of this game.' };

    const tick = this.charge(room, false);
    let base = { state: tick.state, clock: tick.clock }; // the position and clocks AFTER the seat on move has been charged its elapsed time
    if (tick.events.length > 0) {
      this.commit(room, { actor: 'clock', state: tick.state, clock: tick.clock, events: tick.events, move: null });
      if (room.status !== 'active' || room.state.status[seat] !== 'active') return { ok: true }; // the flag fall already took this seat (or ended the game)
      base = { state: room.state, clock: room.clock }; // the flag fall was committed (and its timer base reset); resign on top of it
    }
    const resigned = resign(base.state, seat, room.rng, 'resign');
    this.commit(room, { actor: 'resign', state: resigned.state, clock: base.clock, events: resigned.events, move: null });
    return { ok: true };
  }

  private rateLimited(seat: FourSeatRuntime): boolean {
    const now = Date.now();
    const recent = seat.moveCalls.filter((t) => now - t < FOUR_MOVE_RATE_LIMIT.windowMs);
    const limited = recent.length >= FOUR_MOVE_RATE_LIMIT.max;
    if (!limited) recent.push(now);
    seat.moveCalls = recent;
    return limited;
  }

  // --- End of game ----------------------------------------------------------------------------------------------------------

  /** Ends a game the ENGINE has decided (the last non-eliminated seat, the dead position, the ply cap). */
  private endGame(room: FourRoom): void {
    const result = room.state.result;
    if (!result) throw new Error('endGame: the engine has not ended this game');
    this.finish(room, { roomId: room.id, reason: result.reason, winners: [...result.winners], scores: this.scoresOf(room), state: serialize(room.state) });
  }

  /** `four_game_over.scores`: the final POINTS in 4 Player Chess, the PIECES LEFT in 4 Player Giveaway (which has no points; the client knows the variant). */
  private scoresOf(room: FourRoom): number[] {
    return room.variant === 'giveaway' ? piecesLeft(room.state.cells) : [...room.state.score];
  }

  /**
   * Ends a game for any reason: the result is recorded for late rejoins FIRST (so nothing below can lose it), then EVERY timer the room
   * owns is cleared (clock, bot, all-gone, each seat's grace - a timer left behind would keep the whole room alive), `four_game_over`
   * goes to every seat and spectator, sockets are released and the room is removed.
   */
  private finish(room: FourRoom, gameOver: FourGameOverPayload): void {
    room.status = 'finished';
    this.finishedRooms.set(room.id, { gameOver, tokens: room.seats.map((s) => s.playerToken).filter((t): t is string => t !== null), finishedAt: Date.now() });
    for (const timer of [room.clockTimer, room.botTimer, room.allGoneTimer, ...room.seats.map((s) => s.graceTimer)]) if (timer) clearTimeout(timer);
    room.clockTimer = null;
    room.botTimer = null;
    room.allGoneTimer = null;
    for (const seat of room.seats) seat.graceTimer = null;

    this.broadcast(room, 'four_game_over', gameOver);
    for (const seat of room.seats) if (seat.socketId) this.socketToSeat.delete(seat.socketId);
    for (const spectator of room.spectators) this.socketToSpectating.delete(spectator);
    this.rooms.delete(room.id);
  }

  /** Drops finished-room records older than the retention; returns how many were removed. Public so tests can drive the clock. */
  sweepFinishedRooms(now: number = Date.now()): number {
    let removed = 0;
    for (const [roomId, finished] of this.finishedRooms) {
      if (now - finished.finishedAt > FOUR_FINISHED_RETENTION_MS) {
        this.finishedRooms.delete(roomId);
        removed++;
      }
    }
    return removed;
  }

  // --- Connection lifecycle -------------------------------------------------------------------------------------------------

  /**
   * `four_rejoin`: a human re-attaches with its token (a fresh socket after a drop, or a second device). A newer connection silently
   * replaces the older one. A game that already ENDED (within the retention) answers with its result instead of "not found".
   */
  rejoin(socketId: string, payload: unknown): FourRejoinAck {
    const roomId = validateFourId((payload as { roomId?: unknown } | null)?.roomId, 'room');
    const token = validateFourId((payload as { playerToken?: unknown } | null)?.playerToken, 'token');
    if (!roomId.ok || !token.ok) return { ok: false, error: 'Invalid request.' };

    const room = this.rooms.get(roomId.value);
    if (!room || room.status !== 'active') {
      const finished = this.finishedRooms.get(roomId.value);
      if (finished && finished.tokens.includes(token.value) && Date.now() - finished.finishedAt <= FOUR_FINISHED_RETENTION_MS) {
        return { ok: true, finished: true, gameOver: finished.gameOver };
      }
      return { ok: false, error: 'The game was not found or has already ended.' };
    }
    const seat = ([0, 1, 2, 3] as Seat[]).find((s) => room.seats[s].playerToken === token.value);
    if (seat === undefined) return { ok: false, error: 'Invalid playerToken.' };
    // A socket seated elsewhere (or spectating) cannot also take this seat.
    const current = this.socketToSeat.get(socketId);
    if (current && !(current.roomId === room.id && current.seat === seat)) return { ok: false, error: 'This connection is already in another game.' };
    this.stopSpectating(socketId);

    const runtime = room.seats[seat];
    if (runtime.socketId && runtime.socketId !== socketId) this.socketToSeat.delete(runtime.socketId); // the older connection no longer owns the seat
    runtime.socketId = socketId;
    runtime.connected = true;
    runtime.disconnectedAt = null;
    this.socketToSeat.set(socketId, { roomId: room.id, seat });
    // Back in: the grace countdown and the all-gone countdown (if this was the last human) are over...
    if (runtime.graceTimer) clearTimeout(runtime.graceTimer);
    runtime.graceTimer = null;
    if (room.allGoneTimer) clearTimeout(room.allGoneTimer);
    room.allGoneTimer = null;
    // ...and a seat a bot had taken over is the human's again (RETAKE, at any time until the game ends). scheduleBot also cancels a bot
    // move that was already pending for this seat.
    if (runtime.controller === 'bot') {
      runtime.controller = 'human';
      runtime.botReason = undefined;
      runtime.elo = undefined;
    }
    this.scheduleBot(room);
    this.broadcastSeats(room);

    const state: FourRejoinState = { ...this.roomState(room), seat };
    return { ok: true, state };
  }

  /** A socket went away: a seated human is marked disconnected (everyone is told; its clock keeps running), a spectator just leaves.
   * A socket that was already replaced by a newer connection for the same seat is ignored.
   * EQUIVALENT-MUTANT NOTE (W2 set, "a replaced socket's late disconnect"): the `runtime.socketId !== socketId` check below is a second line of defence -
   * `rejoin()` already deleted the replaced socket from `socketToSeat`, so such a late disconnect returns at the `located` check first. */
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
    runtime.disconnectedAt = Date.now();
    // An ACTIVE human's seat is taken over by a bot if it stays away for the grace period (an eliminated one has nothing left to play).
    if (runtime.controller === 'human' && room.state.status[located.seat] === 'active' && !runtime.graceTimer) {
      runtime.graceTimer = setTimeout(() => this.onGraceExpired(room, located.seat), this.graceMs);
    }
    this.broadcastSeats(room);
    this.checkAllGone(room);
    this.scheduleBot(room); // the room may have just become a fast-forward one (the last human left while only eliminated ones watched)
  }

  // --- Spectating and chat --------------------------------------------------------------------------------------------------

  /** Whether the socket is SEATED in a game (a player, not a spectator): such a socket cannot queue for another game. */
  isSeated(socketId: string): boolean {
    return this.socketToSeat.has(socketId);
  }

  /** Games in progress, NEWEST first (rooms are kept in creation order, so this reads them backwards) and at most
   * FOUR_ACTIVE_GAMES_LIST_MAX - names and kinds only, never a token or a socket id. */
  listActiveGames(): FourActiveGameSummary[] {
    return [...this.rooms.values()]
      .filter((room) => room.status === 'active')
      .reverse()
      .slice(0, FOUR_ACTIVE_GAMES_LIST_MAX)
      .map((room) => ({ roomId: room.id, variant: room.variant, timeControlLabel: room.timeControlLabel, seats: room.seats.map((s) => ({ name: s.name, kind: s.controller })) }));
  }

  /** `four_spectate_game`: read-only. A socket that plays in a game, or already watches one, cannot start watching another without leaving.
   * A room holds at most FOUR_MAX_SPECTATORS_PER_ROOM spectators (each costs a send per state); a refused request leaves the socket
   * watching whatever it was watching before. */
  spectate(socketId: string, payload: unknown): FourAck<{ state: FourSpectateState }> {
    const roomId = this.roomIdOf(payload);
    const room = roomId ? this.rooms.get(roomId) : undefined;
    if (!room || room.status !== 'active') return { ok: false, error: 'The game was not found or has already ended.' };
    if (this.socketToSeat.has(socketId)) return { ok: false, error: 'You are playing in a game - you cannot also spectate.' };
    if (!room.spectators.has(socketId) && room.spectators.size >= FOUR_MAX_SPECTATORS_PER_ROOM) return { ok: false, error: 'This game has too many spectators.' };
    this.stopSpectating(socketId);
    room.spectators.add(socketId);
    this.socketToSpectating.set(socketId, room.id);
    return { ok: true, state: this.roomState(room) };
  }

  /** `four_stop_spectating` (also implicit on disconnect, rejoin and starting to play). */
  stopSpectating(socketId: string): void {
    const roomId = this.socketToSpectating.get(socketId);
    if (!roomId) return;
    this.socketToSpectating.delete(socketId);
    this.rooms.get(roomId)?.spectators.delete(socketId);
  }

  /**
   * `four_send_chat`: relayed to the OTHER human seats and to spectators (who cannot send - they own no seat). Text is trimmed and cut
   * like the 2-player chat; a seat may send at most one message per FOUR_CHAT_MIN_INTERVAL_MS. Nothing is stored.
   */
  sendChat(socketId: string, payload: unknown): FourAck {
    const roomId = this.roomIdOf(payload);
    const located = roomId ? this.locate(socketId, roomId) : null;
    if (!located) return { ok: false, error: NO_GAME };
    const text = normalizeFourChatText((payload as { text?: unknown }).text);
    if (!text.ok) return text;
    const { room, seat } = located;
    const runtime = room.seats[seat];
    const now = Date.now();
    if (runtime.lastChatAt !== null && now - runtime.lastChatAt < FOUR_CHAT_MIN_INTERVAL_MS) return { ok: false, error: 'You are sending messages too fast.' };
    runtime.lastChatAt = now;
    const message: FourChatMessagePayload = { fromSeat: seat, name: runtime.name, text: text.value, sentAt: now };
    for (const other of [0, 1, 2, 3] as Seat[]) {
      const target = room.seats[other];
      if (other !== seat && target.socketId) this.emit(target.socketId, 'four_chat_message', message);
    }
    for (const spectator of room.spectators) this.emit(spectator, 'four_chat_message', message);
    return { ok: true };
  }

  // --- Helpers --------------------------------------------------------------------------------------------------------------

  private roomIdOf(payload: unknown): string | null {
    const roomId = validateFourId((payload as { roomId?: unknown } | null)?.roomId, 'room');
    return roomId.ok ? roomId.value : null;
  }

  /** The active room and seat of a socket - but only if the socket really sits in the room named by the request. */
  private locate(socketId: string, roomId: string): { room: FourRoom; seat: Seat } | null {
    const seated = this.socketToSeat.get(socketId);
    if (!seated || seated.roomId !== roomId) return null;
    const room = this.rooms.get(roomId);
    if (!room || room.status !== 'active') return null;
    return { room, seat: seated.seat };
  }

  private seatInfos(room: FourRoom): FourSeats {
    return ([0, 1, 2, 3] as Seat[]).map((seat): FourSeatInfo => {
      const s = room.seats[seat];
      return {
        seat,
        kind: s.controller,
        ...(s.botReason ? { botReason: s.botReason } : {}),
        name: s.name,
        ...(s.elo !== undefined ? { elo: s.elo } : {}),
        connected: s.controller === 'bot' ? true : s.connected,
        // A disconnected human whose seat is still waiting to be taken over: how long it has left (the client counts down from this).
        ...(s.graceTimer && s.disconnectedAt !== null ? { graceMsLeft: Math.max(0, this.graceMs - (Date.now() - s.disconnectedAt)) } : {}),
      };
    }) as FourSeats;
  }

  /** The clocks as a client should START counting from right now: the seat on move has already spent part of its turn. */
  private liveClocksMs(room: FourRoom): FourClocksMs {
    const seconds = room.clock.seconds.slice();
    if (room.state.status[room.state.turn] === 'active' && !room.state.result) {
      seconds[room.state.turn] = Math.max(0, seconds[room.state.turn] - (Date.now() - room.turnStartedAt) / 1000);
    }
    return clocksToWireMs(seconds);
  }

  private roomState(room: FourRoom): FourRoomState {
    return {
      roomId: room.id,
      variant: room.variant,
      seats: this.seatInfos(room),
      timeControl: room.timeControl,
      timeControlLabel: room.timeControlLabel,
      seq: room.seq,
      state: serialize(room.state),
      clocksMs: this.liveClocksMs(room),
      log: room.log.slice(),
    };
  }

  private broadcastSeats(room: FourRoom): void {
    const payload: FourSeatUpdatePayload = { roomId: room.id, seats: this.seatInfos(room) };
    this.broadcast(room, 'four_seat_update', payload);
  }

  /** To every human seat that has a live socket, and every spectator. */
  private broadcast<K extends keyof FourServerToClientEvents>(room: FourRoom, event: K, payload: Parameters<FourServerToClientEvents[K]>[0]): void {
    for (const seat of room.seats) if (seat.socketId) this.emit(seat.socketId, event, payload);
    for (const spectator of room.spectators) this.emit(spectator, event, payload);
  }

  /** The only place an event leaves the manager. A failing send must not abort the funnel that called it (see the file header). */
  private emit<K extends keyof FourServerToClientEvents>(socketId: string, event: K, payload: Parameters<FourServerToClientEvents[K]>[0]): void {
    try {
      this.io.to(socketId).emit(event, payload);
    } catch (err) {
      console.error(`[fourRooms] failed to send ${event} to ${socketId}:`, err);
    }
  }
}

/** A played move as the wire carries it (squares as names, the promotion piece as a letter, the coordinate label). */
function describeMove(seat: Seat, move: Move): FourMoveInfo {
  const promotion = promotionOf(move);
  return { seat, from: squareName(move.from), to: squareName(move.to), ...(promotion ? { promotion: PROMOTION_LETTER[promotion] } : {}), label: moveLabel(move) };
}

function defaultLabel(tc: FourTimeControl): string {
  return tc.incrementSeconds > 0 ? `${tc.initialSeconds / 60} | ${tc.incrementSeconds}` : `${tc.initialSeconds / 60} min`;
}
