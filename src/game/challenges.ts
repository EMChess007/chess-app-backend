import { randomBytes } from 'node:crypto';
import type { TimeControl } from './types.js';

export interface PendingChallenge {
  code: string;
  creatorSocketId: string;
  creatorUserId: string | null;
  timeControl: TimeControl;
  timeControlLabel?: string;
  isChess960: boolean;
  isKingOfTheHill: boolean;
  isThreeCheck: boolean;
  isSetupChess: boolean;
  createdAt: number;
}

// Long enough that nobody's waiting around for a code to go stale mid-conversation, short enough
// that abandoned challenges don't linger in memory forever.
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
// No 0/O/1/I/L — the whole point of a short code is that a person can read it aloud or glance at
// it without ambiguity.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

/**
 * In-memory registry of "challenge a specific friend" invites — one process-wide instance,
 * mirroring Matchmaker's own scope/lifetime. A challenge pairs exactly two specific people (via a
 * short code shared out-of-band, e.g. a native share sheet) instead of the anonymous FIFO queue.
 */
export class ChallengeManager {
  private challenges = new Map<string, PendingChallenge>();

  constructor() {
    // A code nobody ever joins (or whose creator forgot about it) would otherwise sit in memory
    // until this same socket happens to call find() on it again, which may never happen — sweep
    // periodically so a long-running process doesn't accumulate them unbounded. The interval
    // itself is unref()'d so it never keeps the process alive on its own.
    setInterval(() => this.sweepExpired(), 5 * 60 * 1000).unref();
  }

  create(params: Omit<PendingChallenge, 'code' | 'createdAt'>): PendingChallenge {
    // A creator who somehow ends up calling this twice (e.g. a fast double-tap before the UI
    // disables the button) would otherwise leave their first code orphaned — still joinable by
    // anyone who has it, but no longer visible/cancellable from the creator's own screen.
    this.removeByCreator(params.creatorSocketId);

    let code = generateCode();
    while (this.challenges.has(code)) code = generateCode(); // astronomically rare, cheap to guard
    const challenge: PendingChallenge = { ...params, code, createdAt: Date.now() };
    this.challenges.set(code, challenge);
    return challenge;
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [code, challenge] of this.challenges) {
      if (now - challenge.createdAt > CHALLENGE_TTL_MS) this.challenges.delete(code);
    }
  }

  /** Looks up a still-valid (non-expired) challenge by code, transparently discarding it if it
   * has aged out — a joiner sees "not found" either way. */
  find(code: string): PendingChallenge | null {
    const challenge = this.challenges.get(code);
    if (!challenge) return null;
    if (Date.now() - challenge.createdAt > CHALLENGE_TTL_MS) {
      this.challenges.delete(code);
      return null;
    }
    return challenge;
  }

  remove(code: string): void {
    this.challenges.delete(code);
  }

  /** Called on disconnect — a code whose creator left can no longer be joined. */
  removeByCreator(socketId: string): void {
    for (const [code, challenge] of this.challenges) {
      if (challenge.creatorSocketId === socketId) this.challenges.delete(code);
    }
  }
}
