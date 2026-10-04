import { randomUUID } from 'node:crypto';
import type { Server } from 'socket.io';
import type { PieceColor } from './RoomChessEngine.js';
import type { RoomManager } from './rooms.js';
import { isMergedPositionLegal, mergeSetupArmies, validateSetupArmy, type SetupChessPiece } from './setupChess.js';
import type { Ack, MatchFoundPayload, SetupChessPairedPayload, TimeControl } from './types.js';

interface PairingEntry {
  socketId: string;
  userId: string | null;
  timeControl: TimeControl;
  timeControlLabel?: string;
}

interface PendingSide {
  socketId: string;
  userId: string | null;
  color: PieceColor;
  pieces: SetupChessPiece[] | null;
}

interface Pairing {
  id: string;
  timeControl: TimeControl;
  timeControlLabel?: string;
  a: PendingSide;
  b: PendingSide;
}

/**
 * Setup Chess needs a phase between "two players matched" and "the room actually exists" that no
 * other variant does — there's no starting position at all until both players' blind armies are
 * submitted and merged. This sits parallel to Matchmaker/ChallengeManager (same "one instance per
 * process, in-memory" scope) rather than extending RoomManager's own Room/status machinery, so
 * every other variant's room-creation path stays completely untouched.
 */
export class SetupChessPairingManager {
  private pairings = new Map<string, Pairing>();
  private socketToPairing = new Map<string, string>();

  constructor(
    private io: Server,
    private rooms: RoomManager
  ) {}

  /** Called the instant two Setup Chess entries match (from the matchmaking queue or a challenge
   * code) — assigns colors with the same coin flip every other pairing path uses, and tells both
   * sides to start building via `setup_chess_paired` (never `match_found`, since no room/roomId
   * exists yet). */
  pair(entryA: PairingEntry, entryB: PairingEntry): void {
    const id = randomUUID();
    const aIsWhite = Math.random() < 0.5;
    const pairing: Pairing = {
      id,
      timeControl: entryA.timeControl,
      timeControlLabel: entryA.timeControlLabel ?? entryB.timeControlLabel,
      a: { socketId: entryA.socketId, userId: entryA.userId, color: aIsWhite ? 'w' : 'b', pieces: null },
      b: { socketId: entryB.socketId, userId: entryB.userId, color: aIsWhite ? 'b' : 'w', pieces: null },
    };
    this.pairings.set(id, pairing);
    this.socketToPairing.set(entryA.socketId, id);
    this.socketToPairing.set(entryB.socketId, id);

    const basePayload = { pairingId: id, timeControl: pairing.timeControl };
    const aPayload: SetupChessPairedPayload = { ...basePayload, color: pairing.a.color, opponent: { userId: entryB.userId } };
    const bPayload: SetupChessPairedPayload = { ...basePayload, color: pairing.b.color, opponent: { userId: entryA.userId } };
    this.io.to(entryA.socketId).emit('setup_chess_paired', aPayload);
    this.io.to(entryB.socketId).emit('setup_chess_paired', bPayload);
  }

  /** One player's army arrives — validated authoritatively regardless of what the client's own
   * builder already checked. Once BOTH sides are in, merges them, re-validates the combined
   * position (the one thing neither side's own army can guarantee alone — see
   * isMergedPositionLegal), and either creates the real room (emitting the normal `match_found`
   * both players already know how to handle) or asks both sides to rebuild if the merge turned
   * out illegal. */
  submitSetup(socketId: string, pairingId: string, pieces: SetupChessPiece[]): Ack {
    const pairing = this.pairings.get(pairingId);
    if (!pairing) return { ok: false, error: 'This pairing no longer exists.' };
    const side = pairing.a.socketId === socketId ? pairing.a : pairing.b.socketId === socketId ? pairing.b : null;
    if (!side) return { ok: false, error: 'You are not part of this pairing.' };

    const validation = validateSetupArmy(pieces, side.color);
    if (!validation.ok) return { ok: false, error: validation.error };

    side.pieces = pieces;
    const other = pairing.a === side ? pairing.b : pairing.a;
    if (!other.pieces) return { ok: true }; // waiting on the opponent

    const whiteSide = pairing.a.color === 'w' ? pairing.a : pairing.b;
    const blackSide = pairing.a.color === 'b' ? pairing.a : pairing.b;
    const fen = mergeSetupArmies(whiteSide.pieces!, blackSide.pieces!);

    if (!isMergedPositionLegal(fen)) {
      pairing.a.pieces = null;
      pairing.b.pieces = null;
      this.io.to(pairing.a.socketId).emit('setup_chess_invalid', {});
      this.io.to(pairing.b.socketId).emit('setup_chess_invalid', {});
      return { ok: true };
    }

    const created = this.rooms.createRoom({
      white: { socketId: whiteSide.socketId, userId: whiteSide.userId },
      black: { socketId: blackSide.socketId, userId: blackSide.userId },
      timeControl: pairing.timeControl,
      timeControlLabel: pairing.timeControlLabel,
      chess960: false,
      kingOfTheHill: false,
      threeCheck: false,
      setupChess: true,
      fogOfWar: false, // Fog of War isn't combinable with Setup Chess
      giveaway: false, // ...and neither is Giveaway
      atomic: false, // ...nor Atomic
      duckChess: false, // ...nor Duck Chess
      initialFen: fen,
    });

    const basePayload = {
      roomId: created.roomId,
      timeControl: pairing.timeControl,
      isChess960: false,
      isKingOfTheHill: false,
      isThreeCheck: false,
      isSetupChess: true,
      isFogOfWar: false,
      isGiveaway: false,
      isAtomic: false,
      isDuckChess: false,
      fen: created.fen,
      whiteMs: created.whiteMs,
      blackMs: created.blackMs,
    };
    const whitePayload: MatchFoundPayload = {
      ...basePayload,
      color: 'w',
      playerToken: created.whitePlayerToken,
      opponent: { userId: blackSide.userId },
    };
    const blackPayload: MatchFoundPayload = {
      ...basePayload,
      color: 'b',
      playerToken: created.blackPlayerToken,
      opponent: { userId: whiteSide.userId },
    };
    this.io.to(whiteSide.socketId).emit('match_found', whitePayload);
    this.io.to(blackSide.socketId).emit('match_found', blackPayload);

    this.removePairing(pairing);
    return { ok: true };
  }

  /** Called from the io-level 'disconnect' handler for every socket — a no-op if it wasn't
   * mid-setup. The remaining player can't be matched into an incomplete room, so the fairest
   * outcome is just telling them their opponent left and letting them back out to try again. */
  handleDisconnect(socketId: string): void {
    const pairingId = this.socketToPairing.get(socketId);
    if (!pairingId) return;
    const pairing = this.pairings.get(pairingId);
    if (!pairing) return;
    const other = pairing.a.socketId === socketId ? pairing.b : pairing.a;
    this.io.to(other.socketId).emit('setup_chess_opponent_left', {});
    this.removePairing(pairing);
  }

  private removePairing(pairing: Pairing): void {
    this.pairings.delete(pairing.id);
    this.socketToPairing.delete(pairing.a.socketId);
    this.socketToPairing.delete(pairing.b.socketId);
  }
}
