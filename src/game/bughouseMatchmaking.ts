/**
 * Bughouse ONLINE - the matchmaker (workstream W2; BUGHOUSE_SPEC.md B11, B17, B20, HP11).
 *
 * A SEPARATE class and a SEPARATE instance from the 2-player `Matchmaker` and from `FourPlayerMatchmaker` (both untouched): Bughouse has its own queue, its own fill timer and its own
 * event names, so a Bughouse player can never be matched into a 2-player or 4-seat game, nor the reverse (no cross-variant mix by construction; the lobby key still carries the variant,
 * `initialMs|incrementMs|bughouse`, so the separation reads in the data too). Like the 4-seat matchmaker it neither knows sockets nor the room manager: starting a game and notifying
 * a queued socket are INJECTED, which is what lets the tests drive the whole thing with an injected clock and no network.
 *
 * THE RULES (B17, the same as the 4-seat games):
 *  - One lobby per time control; the six time controls of B11 are the only ones accepted (the shared validator); a socket is in at most ONE lobby.
 *  - The 4th human to arrive starts the match at once (the first four, FIFO).
 *  - With >= BUG_MIN_HUMANS (2) queued, a fill timer of BUG_FILL_WAIT_MS (30 s) starts - from the moment the lobby FIRST holds two humans - and at expiry every queued human (2 or 3) plus
 *    bots to make four play. Dropping below two cancels the timer; reaching two again restarts it from zero. A lone human waits indefinitely.
 *  - Every change is pushed to the whole lobby as `bug_queue_update { queued, fillInMs }`.
 *  - Seats are assigned by a uniform random shuffle (B20: the seat map is fixed, the people on it are random, so no team, colour or board is systematically favoured).
 *
 * THE SEAM FOR PAIRS (W6, HP11). A lobby holds GROUPS, not people: today every group is one human (`join`), and a friend pair will enter as a group of two (`joinGroup`) that is never
 * split - `start()` takes whole groups, first come first served, up to four humans. Seat placement is ONE function (`placeGroups`), which today shuffles everybody; W6 replaces its body
 * with the team-aware assignment (a pair takes seats 0 + 3) and nothing else changes.
 *
 * If starting a match throws, the humans are put BACK at the front of their lobby instead of vanishing from the queue with no match.
 */
import { randomInt as cryptoRandomInt } from 'node:crypto';
import { BUG_BOT_ELO, BUG_BOT_NAME, BUG_MIN_HUMANS, bugTimeControlLabel, resolveBugFillWaitMs } from './bughouseConfig.js';
import type { BugSeatSetup, BugSeatSetups, BugTimers } from './bughouseRooms.js';
import { realTimers } from './bughouseRooms.js';
import { bugRefusal, validateBugTimeControl, type BugAck, type BugQueueUpdatePayload, type BughouseTimeControl } from './bughouse/index.js';

export interface BugQueueEntry {
  socketId: string;
  userId: string | null;
  /** Shown to the other players: a username, "Guest"... (resolved by the caller). */
  name: string;
  timeControl: BughouseTimeControl;
  joinedAt: number;
}

export interface BugMatchmakerDeps {
  /** Starts a match with the four seats already placed. May throw: the humans are then put back in their lobby. */
  startGame(seats: BugSeatSetups, timeControl: BughouseTimeControl, timeControlLabel: string): void;
  /** Sends a queued socket its lobby's state. Must not throw (the matchmaker does not guard it). */
  notify(socketId: string, update: BugQueueUpdatePayload): void;
  /** The fill wait in ms; default resolveBugFillWaitMs() (30 s, or the dev/test override). */
  fillWaitMs?: number;
  /** A uniform integer in [0, maxExclusive); default crypto.randomInt. Injected so a test can enumerate every shuffle. */
  randomInt?: (maxExclusive: number) => number;
  /** The clock and timers (default: the real ones); the room manager's own type, so one fake serves both. */
  timers?: BugTimers;
}

/** Humans who queued together and are never split: one human today, a friend pair in W6. */
interface QueueGroup {
  members: BugQueueEntry[];
}

interface Lobby {
  key: string;
  timeControl: BughouseTimeControl;
  groups: QueueGroup[];
  timer: unknown;
  timerStartedAt: number;
}

/** The lobby key: the time control AND the variant ('bughouse'), the same shape as the 4-seat lobbies' `initialSeconds|incrementSeconds|variant`. */
const keyOf = (tc: BughouseTimeControl): string => `${tc.initialMs}|${tc.incrementMs}|bughouse`;

/** Fisher-Yates with an injectable uniform integer source: every permutation is reachable and, with a uniform source, equally likely. */
export function shuffled<T>(items: readonly T[], randomInt: (maxExclusive: number) => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * THE ONE PLACE seats are assigned. Today (solo queue, B20): the humans and the bots that fill the rest are shuffled uniformly over the four seats. W6 changes this body only: a pair of
 * friends takes seats 0 + 3 (one team), a second pair seats 1 + 2, solos fill the free team, bots after the fill wait.
 */
export function placeGroups(groups: readonly QueueGroup[], randomInt: (maxExclusive: number) => number): BugSeatSetups {
  const humans: BugSeatSetup[] = groups.flatMap((group) => group.members.map((m): BugSeatSetup => ({ kind: 'human', socketId: m.socketId, name: m.name })));
  const bots: BugSeatSetup[] = Array.from({ length: 4 - humans.length }, () => ({ kind: 'bot', socketId: null, name: BUG_BOT_NAME, elo: BUG_BOT_ELO, botReason: 'fill' }));
  return shuffled([...humans, ...bots], randomInt) as BugSeatSetups;
}

const sizeOf = (lobby: Lobby): number => lobby.groups.reduce((n, group) => n + group.members.length, 0);

export class BughouseMatchmaker {
  private lobbies = new Map<string, Lobby>();
  private socketToKey = new Map<string, string>();
  private readonly fillWaitMs: number;
  private readonly randomInt: (maxExclusive: number) => number;
  private readonly timers: BugTimers;

  constructor(private deps: BugMatchmakerDeps) {
    this.fillWaitMs = deps.fillWaitMs ?? resolveBugFillWaitMs();
    this.randomInt = deps.randomInt ?? ((n) => cryptoRandomInt(n));
    this.timers = deps.timers ?? realTimers;
  }

  /** Queues one human (a group of one). One entry per socket across ALL lobbies; the time control must be one of the six. */
  join(entry: Omit<BugQueueEntry, 'joinedAt'>): BugAck {
    return this.joinGroup([entry]);
  }

  /** Queues humans who play together (W6's friend pair): they enter, start and are seated as one group. Refused whole if any member is already queued. */
  joinGroup(members: Omit<BugQueueEntry, 'joinedAt'>[]): BugAck {
    if (members.length < 1 || members.length > 2) return bugRefusal('invalidRequest', 'Invalid request.');
    const timeControl = validateBugTimeControl(members[0].timeControl);
    if (!timeControl.ok) return timeControl;
    const key = keyOf(timeControl.value);
    // a group plays one time control: every member must have asked for the same one
    if (members.some((m) => { const tc = validateBugTimeControl(m.timeControl); return !tc.ok || keyOf(tc.value) !== key; })) return bugRefusal('invalidRequest', 'Unknown time control.');
    if (members.some((m) => this.socketToKey.has(m.socketId)) || new Set(members.map((m) => m.socketId)).size !== members.length) {
      return bugRefusal('invalidRequest', 'You are already in a queue.');
    }

    let lobby = this.lobbies.get(key);
    if (!lobby) {
      lobby = { key, timeControl: timeControl.value, groups: [], timer: null, timerStartedAt: 0 };
      this.lobbies.set(key, lobby);
    }
    const joinedAt = this.timers.now();
    lobby.groups.push({ members: members.map((m) => ({ ...m, timeControl: timeControl.value, joinedAt })) });
    for (const m of members) this.socketToKey.set(m.socketId, key);

    if (sizeOf(lobby) >= 4) this.start(lobby);
    else {
      this.rearmTimer(lobby);
      this.notifyLobby(lobby);
    }
    return { ok: true };
  }

  /** Removes a socket from its lobby (a no-op if it is not queued); a group it belonged to leaves with it only as far as that member (W6 decides what a broken pair does). Safe to call on every disconnect. */
  leave(socketId: string): boolean {
    const key = this.socketToKey.get(socketId);
    if (key === undefined) return false;
    this.socketToKey.delete(socketId);
    const lobby = this.lobbies.get(key);
    if (!lobby) return true;
    for (const group of lobby.groups) group.members = group.members.filter((m) => m.socketId !== socketId);
    lobby.groups = lobby.groups.filter((group) => group.members.length > 0);
    this.rearmTimer(lobby);
    if (lobby.groups.length === 0) this.lobbies.delete(key);
    else this.notifyLobby(lobby);
    return true;
  }

  isQueued(socketId: string): boolean {
    return this.socketToKey.has(socketId);
  }

  /** Total humans waiting, over every lobby. */
  size(): number {
    return this.socketToKey.size;
  }

  /** Humans waiting in the lobby for this time control. */
  lobbySize(timeControl: BughouseTimeControl): number {
    const lobby = this.lobbies.get(keyOf(timeControl));
    return lobby ? sizeOf(lobby) : 0;
  }

  /** The fill timer exists exactly while the lobby holds at least BUG_MIN_HUMANS: started the moment it first does (and not restarted by the next join), cancelled the moment it stops. */
  private rearmTimer(lobby: Lobby): void {
    if (sizeOf(lobby) >= BUG_MIN_HUMANS) {
      if (lobby.timer === null) {
        lobby.timerStartedAt = this.timers.now();
        lobby.timer = this.timers.setTimer(() => this.onFillTimer(lobby), this.fillWaitMs);
      }
    } else if (lobby.timer !== null) {
      this.timers.clearTimer(lobby.timer);
      lobby.timer = null;
    }
  }

  /** The fill timer fired: start with whoever is queued (2 or 3 humans) plus bots. A replaced lobby's timer is cleared with it, so the callback only ever sees its own lobby. */
  private onFillTimer(lobby: Lobby): void {
    lobby.timer = null;
    if (this.lobbies.get(lobby.key) !== lobby || sizeOf(lobby) < BUG_MIN_HUMANS) return;
    this.start(lobby);
  }

  private fillInMs(lobby: Lobby): number | null {
    return lobby.timer !== null ? Math.max(0, this.fillWaitMs - (this.timers.now() - lobby.timerStartedAt)) : null;
  }

  private notifyLobby(lobby: Lobby): void {
    const update: BugQueueUpdatePayload = { queued: sizeOf(lobby), fillInMs: this.fillInMs(lobby) };
    for (const group of lobby.groups) for (const member of group.members) this.deps.notify(member.socketId, update);
  }

  /** Takes whole groups of the lobby, first come first served, up to four humans; adds bots up to four seats, places them, and starts the match. */
  private start(lobby: Lobby): void {
    if (lobby.timer !== null) this.timers.clearTimer(lobby.timer);
    lobby.timer = null;
    const taken: QueueGroup[] = [];
    let humans = 0;
    while (lobby.groups.length > 0 && humans + lobby.groups[0].members.length <= 4) {
      const group = lobby.groups.shift() as QueueGroup;
      taken.push(group);
      humans += group.members.length;
    }
    for (const group of taken) for (const m of group.members) this.socketToKey.delete(m.socketId);
    if (lobby.groups.length === 0) this.lobbies.delete(lobby.key);
    else {
      // humans are still queued behind the match that just started (only possible with groups): their fill clock starts from now, and they are told
      this.rearmTimer(lobby);
      this.notifyLobby(lobby);
    }

    const seats = placeGroups(taken, this.randomInt);
    try {
      this.deps.startGame(seats, lobby.timeControl, bugTimeControlLabel(lobby.timeControl.initialMs, lobby.timeControl.incrementMs));
    } catch (err) {
      console.error(`[bughouseMatchmaker] starting a match for lobby ${lobby.key} failed; the ${humans} humans stay queued:`, err);
      this.restore(lobby, taken);
    }
  }

  /** Puts groups back at the FRONT of their lobby (a failed start) and re-evaluates the timer. */
  private restore(lobby: Lobby, groups: QueueGroup[]): void {
    let target = this.lobbies.get(lobby.key);
    if (!target) {
      target = lobby;
      this.lobbies.set(lobby.key, target);
    }
    target.groups.unshift(...groups);
    for (const group of groups) for (const m of group.members) this.socketToKey.set(m.socketId, lobby.key);
    this.rearmTimer(target);
    this.notifyLobby(target);
  }
}
