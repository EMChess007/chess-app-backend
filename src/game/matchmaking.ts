import type { TimeControl } from './types.js';

export interface QueueEntry {
  socketId: string;
  userId: string | null;
  timeControl: TimeControl;
  timeControlLabel?: string;
  isChess960: boolean;
  isKingOfTheHill: boolean;
  isThreeCheck: boolean;
  isSetupChess: boolean;
  isFogOfWar: boolean;
  isGiveaway: boolean;
  isAtomic: boolean;
  isDuckChess: boolean;
  /**
   * Accepted from the client but deliberately unused for pairing right now — matchmaking is
   * "compatible time control + same Chess960 flag" only, per this task's scope. Kept on the
   * entry so a future rating-aware matching pass (e.g. widening an ELO window the longer
   * someone waits) doesn't need any client-facing changes, just logic here.
   */
  rating?: number;
  queuedAt: number;
}

/** In-memory matchmaking queue — one instance per process. Pairing is exact-match only:
 * same isChess960/isKingOfTheHill/isThreeCheck/isSetupChess/isFogOfWar/isGiveaway/isAtomic/isDuckChess flags, and identical time
 * control (initial + increment). */
export class Matchmaker {
  private queue: QueueEntry[] = [];

  /** Adds `entry` to the queue and looks for a compatible waiting opponent. Returns that
   * opponent (already removed from the queue) if one was found, otherwise null (entry is now
   * waiting). */
  join(entry: QueueEntry): QueueEntry | null {
    const matchIndex = this.queue.findIndex(
      (q) =>
        q.socketId !== entry.socketId &&
        q.isChess960 === entry.isChess960 &&
        q.isKingOfTheHill === entry.isKingOfTheHill &&
        q.isThreeCheck === entry.isThreeCheck &&
        q.isSetupChess === entry.isSetupChess &&
        q.isFogOfWar === entry.isFogOfWar &&
        q.isGiveaway === entry.isGiveaway &&
        q.isAtomic === entry.isAtomic &&
        q.isDuckChess === entry.isDuckChess &&
        q.timeControl.initialSeconds === entry.timeControl.initialSeconds &&
        q.timeControl.incrementSeconds === entry.timeControl.incrementSeconds
    );

    if (matchIndex === -1) {
      this.queue.push(entry);
      return null;
    }

    const [opponent] = this.queue.splice(matchIndex, 1);
    return opponent;
  }

  /** Removes `socketId` from the queue, if present. Safe to call unconditionally (e.g. on
   * every disconnect) — returns whether it actually removed anything. */
  leave(socketId: string): boolean {
    const before = this.queue.length;
    this.queue = this.queue.filter((q) => q.socketId !== socketId);
    return this.queue.length < before;
  }

  size(): number {
    return this.queue.length;
  }
}
