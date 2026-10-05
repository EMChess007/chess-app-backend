import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'socket.io';
import { prisma } from '../lib/prisma.js';
import type { PieceColor } from './RoomChessEngine.js';
import type { RoomManager } from './rooms.js';
import type {
  TimeControl,
  TournamentLobbyState,
  TournamentMatchReadyPayload,
  TournamentStandingRow,
  TournamentStandingsPayload,
  TournamentStatus,
} from './types.js';

// No 0/O/1/I/L — same alphabet as ChallengeManager's codes, for the same reason (read aloud/
// glanced at without ambiguity).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const MIN_PARTICIPANTS_TO_START = 3;
const MAX_PARTICIPANTS = 8;

function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

interface Participant {
  userId: string;
  username: string;
  socketId: string | null;
  points: number;
}

interface Match {
  a: string;
  b: string;
  status: 'pending' | 'active' | 'finished';
  roomId: string | null;
  /** `a`'s color once the match is active — `b`'s color is always the other one. */
  aColor: PieceColor | null;
  aToken: string | null;
  bToken: string | null;
  /** The room's state at creation time, for a player entering via the Standings screen's "Play
   * Now" (see buildStandingsPayloadFor) rather than reacting live to tournament_match_ready —
   * this is only ever the FRESH starting position, not the current one, so it's only correct for
   * a player entering right as the match becomes active. A player who navigates away mid-match
   * and comes back later would need the existing rejoin_game flow (by roomId+playerToken) for a
   * fully-current position instead; that isn't wired up for tournament matches yet. */
  fen: string | null;
  whiteMs: number | null;
  blackMs: number | null;
  /** The winner's userId, or null for a draw — only meaningful once status is 'finished'. */
  winner: string | null;
}

interface Tournament {
  id: string;
  code: string;
  name: string;
  timeControl: TimeControl;
  timeControlLabel?: string;
  chess960: boolean;
  kingOfTheHill: boolean;
  threeCheck: boolean;
  creatorUserId: string;
  status: TournamentStatus;
  participants: Map<string, Participant>;
  matches: Match[];
}

function allPairs<T>(items: T[]): [T, T][] {
  const pairs: [T, T][] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) pairs.push([items[i], items[j]]);
  }
  return pairs;
}

export type TournamentResult<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };

/**
 * Small (~8-player) friend-group round-robin tournaments, built on top of the same RoomManager
 * every other online game uses — a tournament match IS an ordinary game room, just one whose
 * finish is wired back here (see Room.onFinished) to update points and pair up whoever's newly
 * free. One instance per process, same lifetime/scope as RoomManager/ChallengeManager.
 *
 * Pairing algorithm: rather than explicit numbered rounds, every unique pair is generated once
 * up front at start() and a pair is launched into a real game room the moment BOTH its players are
 * simultaneously free (not already in another active tournament match) and connected. This is
 * simpler than circle-method round scheduling, needs no bye handling for an odd participant
 * count, and naturally matches "start the next available pairing for whoever's free" rather than
 * gating everyone on the slowest game in a synchronized round.
 *
 * Live orchestration (this class's own state) does not survive a server restart, same as
 * RoomManager's own in-memory rooms — Tournament/TournamentParticipant rows in Postgres are a
 * best-effort durable mirror of what happened, not something this class ever reads back from.
 */
export class TournamentManager {
  private tournaments = new Map<string, Tournament>();
  private codeToId = new Map<string, string>();
  private socketToTournament = new Map<string, string>();

  constructor(
    private io: Server,
    private rooms: RoomManager
  ) {}

  async create(params: {
    name: string;
    creatorSocketId: string;
    creatorUserId: string;
    creatorUsername: string;
    timeControl: TimeControl;
    timeControlLabel?: string;
    chess960: boolean;
    kingOfTheHill: boolean;
    threeCheck: boolean;
  }): Promise<Tournament> {
    let code = generateCode();
    while (this.codeToId.has(code)) code = generateCode(); // astronomically rare, cheap to guard
    const id = randomUUID();

    const tournament: Tournament = {
      id,
      code,
      name: params.name,
      timeControl: params.timeControl,
      timeControlLabel: params.timeControlLabel,
      chess960: params.chess960,
      kingOfTheHill: params.kingOfTheHill,
      threeCheck: params.threeCheck,
      creatorUserId: params.creatorUserId,
      status: 'lobby',
      participants: new Map([
        [params.creatorUserId, { userId: params.creatorUserId, username: params.creatorUsername, socketId: params.creatorSocketId, points: 0 }],
      ]),
      matches: [],
    };
    this.tournaments.set(id, tournament);
    this.codeToId.set(code, id);
    this.socketToTournament.set(params.creatorSocketId, id);

    // Awaited (unlike persistPoints/persistStatus below, which are fire-and-forget) — a join
    // immediately after creation must never race ahead of this row actually existing, or its own
    // participant insert fails on the tournament_id foreign key.
    try {
      await this.persistCreate(tournament);
    } catch (err) {
      this.tournaments.delete(id);
      this.codeToId.delete(code);
      this.socketToTournament.delete(params.creatorSocketId);
      throw err;
    }
    return tournament;
  }

  async join(code: string, socketId: string, userId: string, username: string): Promise<TournamentResult<{ tournament: TournamentLobbyState }>> {
    const id = this.codeToId.get(code.trim().toUpperCase());
    const tournament = id ? this.tournaments.get(id) : undefined;
    if (!tournament) return { ok: false, error: 'Tournament not found or the code has expired.' };
    if (tournament.status !== 'lobby') {
      // A participant reconnecting after a disconnect mid-tournament also comes through here
      // (the client has no separate "rejoin" flow) — allow it as long as they were already in.
      if (!tournament.participants.has(userId)) {
        return { ok: false, error: 'This tournament has already started.' };
      }
    } else if (!tournament.participants.has(userId) && tournament.participants.size >= MAX_PARTICIPANTS) {
      return { ok: false, error: `This tournament is full (max ${MAX_PARTICIPANTS} players).` };
    }

    const existing = tournament.participants.get(userId);
    if (existing) {
      existing.socketId = socketId;
    } else {
      tournament.participants.set(userId, { userId, username, socketId, points: 0 });
      // Awaited for the same reason as persistCreate above — start() (and thus the first
      // persistPoints update) must never be able to race ahead of every participant row existing.
      try {
        await this.persistParticipant(tournament.id, userId);
      } catch (err) {
        tournament.participants.delete(userId);
        throw err;
      }
    }
    this.socketToTournament.set(socketId, tournament.id);

    if (tournament.status === 'lobby') this.broadcastLobby(tournament);
    else this.broadcastStandings(tournament);

    return { ok: true, tournament: this.toLobbyState(tournament) };
  }

  /** Only meaningful in the lobby phase — the creator leaving before start cancels the whole
   * thing (mirrors ChallengeManager.removeByCreator), since nobody else can ever press Start. A
   * non-creator leaving is just removed. Once active, leaving isn't modeled separately from an
   * ordinary disconnect (see handleDisconnect) — their points/pairings stand either way. */
  leaveLobby(tournamentId: string, socketId: string): void {
    const tournament = this.tournaments.get(tournamentId);
    if (!tournament || tournament.status !== 'lobby') return;
    const participant = [...tournament.participants.values()].find((p) => p.socketId === socketId);
    if (!participant) return;

    this.socketToTournament.delete(socketId);
    if (participant.userId === tournament.creatorUserId) {
      this.deleteTournament(tournament);
      return;
    }
    tournament.participants.delete(participant.userId);
    this.broadcastLobby(tournament);
  }

  private deleteTournament(tournament: Tournament): void {
    this.broadcastLobby({ ...tournament, status: 'finished' });
    this.tournaments.delete(tournament.id);
    this.codeToId.delete(tournament.code);
    this.persistStatus(tournament.id, 'finished').catch((err) => console.error('[tournaments] failed to persist cancellation:', err));
  }

  start(tournamentId: string, socketId: string): TournamentResult {
    const tournament = this.tournaments.get(tournamentId);
    if (!tournament) return { ok: false, error: 'Tournament not found.' };
    const requester = [...tournament.participants.values()].find((p) => p.socketId === socketId);
    if (!requester || requester.userId !== tournament.creatorUserId) {
      return { ok: false, error: 'Only the tournament creator can start it.' };
    }
    if (tournament.status !== 'lobby') return { ok: false, error: 'This tournament has already started.' };
    if (tournament.participants.size < MIN_PARTICIPANTS_TO_START) {
      return { ok: false, error: `At least ${MIN_PARTICIPANTS_TO_START} players are needed to start.` };
    }

    tournament.status = 'active';
    const ids = [...tournament.participants.keys()];
    tournament.matches = allPairs(ids).map(([a, b]) => ({
      a,
      b,
      status: 'pending',
      roomId: null,
      aColor: null,
      aToken: null,
      bToken: null,
      fen: null,
      whiteMs: null,
      blackMs: null,
      winner: null,
    }));

    this.persistStatus(tournament.id, 'active').catch((err) => console.error('[tournaments] failed to persist start:', err));
    this.startEligibleMatches(tournament);
    // Both pushes matter here: lobby_update (status: 'active') is what tells anyone still sitting
    // on the lobby screen to move on to Standings, since they're not listening for
    // standings_update yet — and standings_update itself carries whether THIS start already gave
    // them a match (yourNextMatch).
    this.broadcastLobby(tournament);
    this.broadcastStandings(tournament);
    return { ok: true };
  }

  /** Launches a real game room for every pending pairing whose both players are simultaneously
   * free (not already in another active match here) and connected — called right after start()
   * and again after every match finishes, so the tournament keeps progressing on its own. */
  private startEligibleMatches(tournament: Tournament): void {
    const busy = new Set<string>();
    for (const m of tournament.matches) {
      if (m.status === 'active') {
        busy.add(m.a);
        busy.add(m.b);
      }
    }
    for (const match of tournament.matches) {
      if (match.status !== 'pending') continue;
      if (busy.has(match.a) || busy.has(match.b)) continue;
      const pa = tournament.participants.get(match.a);
      const pb = tournament.participants.get(match.b);
      if (!pa?.socketId || !pb?.socketId) continue; // wait until both are connected

      busy.add(match.a);
      busy.add(match.b);
      match.status = 'active';

      const aIsWhite = Math.random() < 0.5;
      const white = aIsWhite ? pa : pb;
      const black = aIsWhite ? pb : pa;
      match.aColor = aIsWhite ? 'w' : 'b';

      const created = this.rooms.createRoom({
        white: { socketId: white.socketId!, userId: white.userId },
        black: { socketId: black.socketId!, userId: black.userId },
        timeControl: tournament.timeControl,
        timeControlLabel: tournament.timeControlLabel,
        chess960: tournament.chess960,
        kingOfTheHill: tournament.kingOfTheHill,
        threeCheck: tournament.threeCheck,
        setupChess: false, // Tournaments don't support Setup Chess yet — see VariantSelector's excludeVariants on TournamentScreen
        fogOfWar: false, // Tournaments don't support Fog of War either — same exclusion
        giveaway: false, // ...nor Giveaway (1v1 Online only)
        atomic: false, // ...nor Atomic
        duckChess: false, // ...nor Duck Chess
        spellChess: false, // ...nor Spell Chess
        horde: false, // ...nor Horde
        onFinished: (winnerColor) => this.handleMatchFinished(tournament.id, match, white.userId, black.userId, winnerColor),
      });
      match.roomId = created.roomId;
      match.aToken = aIsWhite ? created.whitePlayerToken : created.blackPlayerToken;
      match.bToken = aIsWhite ? created.blackPlayerToken : created.whitePlayerToken;
      match.fen = created.fen;
      match.whiteMs = created.whiteMs;
      match.blackMs = created.blackMs;

      const basePayload = {
        roomId: created.roomId,
        timeControl: tournament.timeControl,
        isChess960: tournament.chess960,
        isKingOfTheHill: tournament.kingOfTheHill,
        isThreeCheck: tournament.threeCheck,
        fen: created.fen,
        whiteMs: created.whiteMs,
        blackMs: created.blackMs,
      };
      const whitePayload: TournamentMatchReadyPayload = {
        ...basePayload,
        color: 'w',
        playerToken: created.whitePlayerToken,
        opponent: { userId: black.userId, username: black.username },
      };
      const blackPayload: TournamentMatchReadyPayload = {
        ...basePayload,
        color: 'b',
        playerToken: created.blackPlayerToken,
        opponent: { userId: white.userId, username: white.username },
      };
      this.io.to(white.socketId!).emit('tournament_match_ready', whitePayload);
      this.io.to(black.socketId!).emit('tournament_match_ready', blackPayload);
    }
  }

  private handleMatchFinished(tournamentId: string, match: Match, whiteUserId: string, blackUserId: string, winnerColor: PieceColor | null): void {
    const tournament = this.tournaments.get(tournamentId);
    if (!tournament) return;

    match.status = 'finished';
    const winnerUserId = winnerColor === 'w' ? whiteUserId : winnerColor === 'b' ? blackUserId : null;
    match.winner = winnerUserId;

    if (winnerUserId) {
      const winner = tournament.participants.get(winnerUserId);
      if (winner) winner.points += 1;
    } else {
      const white = tournament.participants.get(whiteUserId);
      const black = tournament.participants.get(blackUserId);
      if (white) white.points += 0.5;
      if (black) black.points += 0.5;
    }
    this.persistPoints(tournament).catch((err) => console.error('[tournaments] failed to persist points:', err));

    if (tournament.matches.every((m) => m.status === 'finished')) {
      tournament.status = 'finished';
      this.persistStatus(tournament.id, 'finished').catch((err) => console.error('[tournaments] failed to persist finish:', err));
    } else {
      this.startEligibleMatches(tournament);
    }
    this.broadcastStandings(tournament);
  }

  getStandings(tournamentId: string): TournamentStandingRow[] | null {
    const tournament = this.tournaments.get(tournamentId);
    if (!tournament) return null;
    return this.computeStandings(tournament);
  }

  private computeStandings(tournament: Tournament): TournamentStandingRow[] {
    return [...tournament.participants.values()]
      .map((p) => ({
        userId: p.userId,
        username: p.username,
        points: p.points,
        played: tournament.matches.filter((m) => m.status === 'finished' && (m.a === p.userId || m.b === p.userId)).length,
      }))
      .sort((a, b) => b.points - a.points);
  }

  /** Snapshot for a socket that just asked (join/get_standings) rather than waiting for a push —
   * same shape as broadcastStandings sends, for one specific requester. */
  getStandingsPayloadFor(tournamentId: string, userId: string): TournamentStandingsPayload | null {
    const tournament = this.tournaments.get(tournamentId);
    if (!tournament) return null;
    return this.buildStandingsPayloadFor(tournament, userId);
  }

  private buildStandingsPayloadFor(tournament: Tournament, userId: string): TournamentStandingsPayload {
    const match = tournament.matches.find((m) => m.status !== 'finished' && (m.a === userId || m.b === userId));
    let yourNextMatch: TournamentStandingsPayload['yourNextMatch'] = null;
    if (match) {
      const isA = match.a === userId;
      const opponentUserId = isA ? match.b : match.a;
      const opponent = tournament.participants.get(opponentUserId);
      const isActive = match.status === 'active';
      yourNextMatch = {
        status: isActive ? 'active' : 'pending',
        opponentUsername: opponent?.username ?? 'Player',
        timeControl: tournament.timeControl,
        isChess960: tournament.chess960,
        isKingOfTheHill: tournament.kingOfTheHill,
        isThreeCheck: tournament.threeCheck,
        roomId: match.roomId,
        playerToken: isActive ? (isA ? match.aToken : match.bToken) : null,
        color: isActive ? (isA ? match.aColor : match.aColor === 'w' ? 'b' : 'w') : null,
        fen: isActive ? match.fen : null,
        whiteMs: isActive ? match.whiteMs : null,
        blackMs: isActive ? match.blackMs : null,
      };
    }
    return { standings: this.computeStandings(tournament), status: tournament.status, yourNextMatch };
  }

  private broadcastStandings(tournament: Tournament): void {
    for (const p of tournament.participants.values()) {
      if (!p.socketId) continue;
      this.io.to(p.socketId).emit('tournament_standings_update', this.buildStandingsPayloadFor(tournament, p.userId));
    }
  }

  private toLobbyState(tournament: Tournament): TournamentLobbyState {
    return {
      id: tournament.id,
      code: tournament.code,
      name: tournament.name,
      timeControl: tournament.timeControl,
      isChess960: tournament.chess960,
      isKingOfTheHill: tournament.kingOfTheHill,
      isThreeCheck: tournament.threeCheck,
      status: tournament.status,
      creatorUserId: tournament.creatorUserId,
      participants: [...tournament.participants.values()].map((p) => ({ userId: p.userId, username: p.username })),
    };
  }

  private broadcastLobby(tournament: Tournament): void {
    const payload = this.toLobbyState(tournament);
    for (const p of tournament.participants.values()) {
      if (p.socketId) this.io.to(p.socketId).emit('tournament_lobby_update', payload);
    }
  }

  /** Called from the io-level 'disconnect' handler for every socket, regardless of whether it was
   * in a tournament — a no-op if it wasn't. In the lobby, this removes them (or cancels the whole
   * tournament if it was the creator); once active, it just marks them offline — their points and
   * remaining pairings stand, and they can reconnect via join_tournament with the same code. */
  handleDisconnect(socketId: string): void {
    const tournamentId = this.socketToTournament.get(socketId);
    if (!tournamentId) return;
    const tournament = this.tournaments.get(tournamentId);
    if (!tournament) {
      this.socketToTournament.delete(socketId);
      return;
    }

    if (tournament.status === 'lobby') {
      this.leaveLobby(tournamentId, socketId);
      return;
    }
    const participant = [...tournament.participants.values()].find((p) => p.socketId === socketId);
    if (participant) participant.socketId = null;
    this.socketToTournament.delete(socketId);
  }

  // --- Postgres mirror (best-effort, fire-and-forget — see class doc comment) -----------------

  private async persistCreate(tournament: Tournament): Promise<void> {
    await prisma.tournament.create({
      data: {
        id: tournament.id,
        name: tournament.name,
        code: tournament.code,
        initialSeconds: tournament.timeControl.initialSeconds,
        incrementSeconds: tournament.timeControl.incrementSeconds,
        isChess960: tournament.chess960,
        isKingOfTheHill: tournament.kingOfTheHill,
        isThreeCheck: tournament.threeCheck,
        creatorId: tournament.creatorUserId,
        participants: { create: { userId: tournament.creatorUserId, points: 0 } },
      },
    });
  }

  private async persistParticipant(tournamentId: string, userId: string): Promise<void> {
    await prisma.tournamentParticipant.upsert({
      where: { tournamentId_userId: { tournamentId, userId } },
      create: { tournamentId, userId, points: 0 },
      update: {},
    });
  }

  private async persistStatus(tournamentId: string, status: TournamentStatus): Promise<void> {
    await prisma.tournament.update({ where: { id: tournamentId }, data: { status } });
  }

  private async persistPoints(tournament: Tournament): Promise<void> {
    await prisma.$transaction(
      [...tournament.participants.values()].map((p) =>
        prisma.tournamentParticipant.update({
          where: { tournamentId_userId: { tournamentId: tournament.id, userId: p.userId } },
          data: { points: p.points },
        })
      )
    );
  }
}
