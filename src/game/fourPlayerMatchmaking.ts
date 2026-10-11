/**
 * 4 Player Chess ONLINE - the matchmaker (workstream W4; design in FOUR_PLAYER_ONLINE_SPEC.md §7).
 *
 * A SEPARATE class from the 2-player `Matchmaker` (which is untouched): that one pairs two sockets, this one forms a lobby of up to four
 * humans per time control and tops it up with bots. It owns the queue and the fill timer and nothing else - it neither knows sockets nor the
 * room manager: starting a game and notifying a queued socket are INJECTED (`startGame`, `notify`), which is what lets the tests drive the
 * whole thing with fake timers and no network.
 *
 * THE RULES (decisions A1-A5, and the six details confirmed on the spec):
 *  - One lobby per time control (`initialSeconds|incrementSeconds`); lobbies never mix, and a socket is in at most ONE lobby.
 *  - The 4th human to arrive starts the game at once (the first four, FIFO).
 *  - With >= FOUR_MIN_HUMANS (2) queued, a fill timer of FOUR_FILL_WAIT_MS (30 s) starts - from the moment the lobby FIRST holds two
 *    humans, not from each player's own join, so a player who waited alone is not penalised and a late second player does not trigger an
 *    instant one-human-plus-bots start. At expiry every queued human (2 or 3) plus bots to make four play.
 *  - Dropping below two cancels the timer; reaching two again restarts it from zero. A lone human waits indefinitely.
 *  - Every change is pushed to the whole lobby as `four_queue_update { queued, fillInMs }` (`fillInMs` null while there is no timer).
 *  - Seats are assigned by a uniform random shuffle (crypto RNG): Red moves first, so the order is a fairness matter.
 *  - Time controls outside the live range ("No time limit", Daily, ...) are refused (the shared validator).
 *
 * If starting a game throws, the humans are put BACK at the front of their lobby (and the timer is re-evaluated) instead of vanishing from
 * the queue with no game: a bug must never silently eat a lobby.
 */
import { randomInt as cryptoRandomInt } from 'node:crypto';
import { FOUR_BOT_ELO, FOUR_BOT_NAME, FOUR_MIN_HUMANS, resolveFourFillWaitMs } from './fourPlayerConfig.js';
import type { FourSeatSetup, FourSeatSetups } from './fourPlayerRooms.js';
import { validateFourTimeControl, type FourAck, type FourQueueUpdatePayload, type FourTimeControl } from './fourPlayerWire.js';

export interface FourQueueEntry {
  socketId: string;
  userId: string | null;
  /** Shown to the other players: a username, "Guest"... (resolved by the caller). */
  name: string;
  timeControl: FourTimeControl;
  timeControlLabel?: string;
  joinedAt: number;
}

export interface FourMatchmakerDeps {
  /** Starts a game with the four seats already shuffled. May throw: the humans are then put back in their lobby. */
  startGame(seats: FourSeatSetups, timeControl: FourTimeControl, timeControlLabel: string | undefined): void;
  /** Sends a queued socket its lobby's state. Must not throw (the matchmaker does not guard it). */
  notify(socketId: string, update: FourQueueUpdatePayload): void;
  /** The fill wait in ms; default resolveFourFillWaitMs() (30 s, or the dev/test override). */
  fillWaitMs?: number;
  /** A uniform integer in [0, maxExclusive); default crypto.randomInt. Injected so a test can enumerate every shuffle. */
  randomInt?: (maxExclusive: number) => number;
}

interface Lobby {
  key: string;
  timeControl: FourTimeControl;
  entries: FourQueueEntry[];
  timer: ReturnType<typeof setTimeout> | null;
  timerStartedAt: number;
}

const keyOf = (tc: FourTimeControl): string => `${tc.initialSeconds}|${tc.incrementSeconds}`;

/** Fisher-Yates with an injectable uniform integer source: every permutation is reachable and, with a uniform source, equally likely. */
export function shuffled<T>(items: readonly T[], randomInt: (maxExclusive: number) => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export class FourPlayerMatchmaker {
  private lobbies = new Map<string, Lobby>();
  private socketToKey = new Map<string, string>();
  private readonly fillWaitMs: number;
  private readonly randomInt: (maxExclusive: number) => number;

  constructor(private deps: FourMatchmakerDeps) {
    this.fillWaitMs = deps.fillWaitMs ?? resolveFourFillWaitMs();
    this.randomInt = deps.randomInt ?? ((n) => cryptoRandomInt(n));
  }

  /** Queues a human. One entry per socket across ALL lobbies; the time control must be inside the live range. */
  join(entry: Omit<FourQueueEntry, 'joinedAt'>): FourAck {
    const timeControl = validateFourTimeControl(entry.timeControl);
    if (!timeControl.ok) return timeControl;
    if (this.socketToKey.has(entry.socketId)) return { ok: false, error: 'You are already in a queue.' };

    const key = keyOf(timeControl.value);
    let lobby = this.lobbies.get(key);
    if (!lobby) {
      lobby = { key, timeControl: timeControl.value, entries: [], timer: null, timerStartedAt: 0 };
      this.lobbies.set(key, lobby);
    }
    lobby.entries.push({ ...entry, timeControl: timeControl.value, joinedAt: Date.now() });
    this.socketToKey.set(entry.socketId, key);

    if (lobby.entries.length >= 4) this.start(lobby);
    else {
      this.rearmTimer(lobby);
      this.notifyLobby(lobby);
    }
    return { ok: true };
  }

  /** Removes a socket from its lobby (a no-op if it is not queued). Safe to call on every disconnect. */
  leave(socketId: string): boolean {
    const key = this.socketToKey.get(socketId);
    if (key === undefined) return false;
    this.socketToKey.delete(socketId);
    const lobby = this.lobbies.get(key);
    if (!lobby) return true;
    lobby.entries = lobby.entries.filter((e) => e.socketId !== socketId);
    this.rearmTimer(lobby);
    if (lobby.entries.length === 0) this.lobbies.delete(key);
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
  lobbySize(timeControl: FourTimeControl): number {
    return this.lobbies.get(keyOf(timeControl))?.entries.length ?? 0;
  }

  /** The fill timer exists exactly while the lobby holds at least FOUR_MIN_HUMANS: started the moment it first does (and not restarted by
   * the next join), cancelled the moment it stops. */
  private rearmTimer(lobby: Lobby): void {
    if (lobby.entries.length >= FOUR_MIN_HUMANS) {
      if (!lobby.timer) {
        lobby.timerStartedAt = Date.now();
        lobby.timer = setTimeout(() => this.onFillTimer(lobby), this.fillWaitMs);
      }
    } else if (lobby.timer) {
      clearTimeout(lobby.timer);
      lobby.timer = null;
    }
  }

  private onFillTimer(lobby: Lobby): void {
    lobby.timer = null;
    if (this.lobbies.get(lobby.key) !== lobby || lobby.entries.length < FOUR_MIN_HUMANS) return;
    this.start(lobby);
  }

  private fillInMs(lobby: Lobby): number | null {
    return lobby.timer ? Math.max(0, this.fillWaitMs - (Date.now() - lobby.timerStartedAt)) : null;
  }

  private notifyLobby(lobby: Lobby): void {
    const update: FourQueueUpdatePayload = { queued: lobby.entries.length, fillInMs: this.fillInMs(lobby) };
    for (const entry of lobby.entries) this.deps.notify(entry.socketId, update);
  }

  /** Takes every queued human of the lobby (at most four), adds bots up to four seats, shuffles, and starts the game. */
  private start(lobby: Lobby): void {
    if (lobby.timer) clearTimeout(lobby.timer);
    lobby.timer = null;
    const entries = lobby.entries.splice(0, 4);
    for (const e of entries) this.socketToKey.delete(e.socketId);
    if (lobby.entries.length === 0) this.lobbies.delete(lobby.key);

    const humans: FourSeatSetup[] = entries.map((e) => ({ kind: 'human', socketId: e.socketId, name: e.name }));
    const bots: FourSeatSetup[] = Array.from({ length: 4 - entries.length }, () => ({ kind: 'bot', socketId: null, name: FOUR_BOT_NAME, elo: FOUR_BOT_ELO, botReason: 'fill' }));
    const seats = shuffled([...humans, ...bots], this.randomInt) as FourSeatSetups;
    try {
      this.deps.startGame(seats, lobby.timeControl, entries[0]?.timeControlLabel);
    } catch (err) {
      console.error(`[fourMatchmaker] starting a game for lobby ${lobby.key} failed; the ${entries.length} humans stay queued:`, err);
      this.restore(lobby, entries);
    }
  }

  /** Puts humans back at the FRONT of their lobby (a failed start) and re-evaluates the timer. */
  private restore(lobby: Lobby, entries: FourQueueEntry[]): void {
    let target = this.lobbies.get(lobby.key);
    if (!target) {
      target = lobby;
      this.lobbies.set(lobby.key, target);
    }
    target.entries.unshift(...entries);
    for (const e of entries) this.socketToKey.set(e.socketId, lobby.key);
    this.rearmTimer(target);
    this.notifyLobby(target);
  }
}
