import type { Server, Socket } from 'socket.io';
import { prisma } from '../lib/prisma.js';
import { verifyToken } from '../lib/jwt.js';
import { ChallengeManager } from './challenges.js';
import { Matchmaker } from './matchmaking.js';
import { RoomManager } from './rooms.js';
import { SetupChessPairingManager } from './setupChessPairing.js';
import { TournamentManager } from './tournaments.js';
import type {
  Ack,
  CreateChallengePayload,
  CreateTournamentPayload,
  JoinChallengePayload,
  JoinQueuePayload,
  JoinTournamentPayload,
  MakeMovePayload,
  MatchFoundPayload,
  OfferDrawPayload,
  RejoinGamePayload,
  ResignPayload,
  RespondDrawPayload,
  SendChatPayload,
  SetupChessPieceWire,
  SubmitSetupChessPayload,
  TimeControl,
  TournamentIdPayload,
  TournamentLobbyState,
  TournamentStandingsPayload,
} from './types.js';

/** Optional: a logged-in user can pass their existing JWT via `socket.handshake.auth.token` to
 * be identified by userId (for future rating/history use); guests simply omit it and play
 * anonymously — auth was never made mandatory for gameplay elsewhere in this app either. */
function extractUserId(socket: Socket): string | null {
  const token = socket.handshake.auth?.token;
  if (typeof token !== 'string' || !token) return null;
  try {
    return verifyToken(token).userId;
  } catch {
    return null;
  }
}

export function isValidTimeControl(value: unknown): value is TimeControl {
  if (typeof value !== 'object' || value === null) return false;
  const tc = value as Record<string, unknown>;
  return (
    typeof tc.initialSeconds === 'number' &&
    Number.isFinite(tc.initialSeconds) &&
    tc.initialSeconds >= 0 &&
    typeof tc.incrementSeconds === 'number' &&
    Number.isFinite(tc.incrementSeconds) &&
    tc.incrementSeconds >= 0 &&
    // "No time limit" (initialSeconds 0) has no clock, so an increment would be meaningless — and it
    // would otherwise never pair with the client's own {0, 0} entries (matchmaking matches exactly).
    (tc.initialSeconds > 0 || tc.incrementSeconds === 0)
  );
}

interface PairableEntry {
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
  isSpellChess: boolean;
  isHorde: boolean;
  isCrazyhouse: boolean;
}

/** Giveaway, Atomic, Duck Chess, Spell Chess, Horde and Crazyhouse cannot be combined with any other variant (see game/giveaway.ts,
 * atomic.ts, duckChess.ts, spellChess.ts, horde.ts, crazyhouse.ts) — a client that sends one of them together with another flag is
 * misbehaving, so reject it instead of silently picking one. */
function conflictingVariantError(flags: { isChess960?: unknown; isKingOfTheHill?: unknown; isThreeCheck?: unknown; isSetupChess?: unknown; isFogOfWar?: unknown; isGiveaway?: unknown; isAtomic?: unknown; isDuckChess?: unknown; isSpellChess?: unknown; isHorde?: unknown; isCrazyhouse?: unknown }): string | null {
  const all = [flags.isChess960, flags.isKingOfTheHill, flags.isThreeCheck, flags.isSetupChess, flags.isFogOfWar, flags.isGiveaway, flags.isAtomic, flags.isDuckChess, flags.isSpellChess, flags.isHorde, flags.isCrazyhouse];
  if (!flags.isGiveaway && !flags.isAtomic && !flags.isDuckChess && !flags.isSpellChess && !flags.isHorde && !flags.isCrazyhouse) return null;
  if (all.filter(Boolean).length < 2) return null;
  return `${flags.isGiveaway ? 'Giveaway' : flags.isAtomic ? 'Atomic' : flags.isDuckChess ? 'Duck Chess' : flags.isSpellChess ? 'Spell Chess' : flags.isHorde ? 'Horde' : 'Crazyhouse'} cannot be combined with another variant.`;
}

function isValidSetupChessPieces(value: unknown): value is SetupChessPieceWire[] {
  return (
    Array.isArray(value) &&
    value.every(
      (p) =>
        typeof p === 'object' &&
        p !== null &&
        typeof (p as Record<string, unknown>).square === 'string' &&
        ['p', 'n', 'b', 'r', 'q', 'k'].includes((p as Record<string, unknown>).type as string)
    )
  );
}

export function registerSocketHandlers(io: Server): void {
  const matchmaker = new Matchmaker();
  const rooms = new RoomManager(io);
  const challenges = new ChallengeManager();
  const tournaments = new TournamentManager(io, rooms);
  const setupChessPairings = new SetupChessPairingManager(io, rooms);

  /** Creates a room for two already-paired entries (from the anonymous queue or a challenge code
   * alike) and pushes `match_found` to both — the one piece of logic join_queue's pairing and
   * join_challenge's pairing both need identically. */
  function pairAndCreateRoom(a: PairableEntry, b: PairableEntry): void {
    // Coin flip for colors, per "random or alternating" — a simple 50/50 is enough for now.
    const aIsWhite = Math.random() < 0.5;
    const whiteEntry = aIsWhite ? a : b;
    const blackEntry = aIsWhite ? b : a;

    const created = rooms.createRoom({
      white: { socketId: whiteEntry.socketId, userId: whiteEntry.userId },
      black: { socketId: blackEntry.socketId, userId: blackEntry.userId },
      timeControl: a.timeControl,
      timeControlLabel: a.timeControlLabel ?? b.timeControlLabel,
      chess960: a.isChess960,
      kingOfTheHill: a.isKingOfTheHill,
      threeCheck: a.isThreeCheck,
      setupChess: false, // Setup Chess never reaches this path — see the isSetupChess branches below
      fogOfWar: a.isFogOfWar,
      giveaway: a.isGiveaway,
      atomic: a.isAtomic,
      duckChess: a.isDuckChess,
      spellChess: a.isSpellChess,
      horde: a.isHorde,
      crazyhouse: a.isCrazyhouse,
    });

    const basePayload = {
      roomId: created.roomId,
      timeControl: a.timeControl,
      isChess960: a.isChess960,
      isKingOfTheHill: a.isKingOfTheHill,
      isThreeCheck: a.isThreeCheck,
      isSetupChess: false,
      isFogOfWar: a.isFogOfWar,
      isGiveaway: a.isGiveaway,
      isAtomic: a.isAtomic,
      isDuckChess: a.isDuckChess,
      isSpellChess: a.isSpellChess,
      isHorde: a.isHorde,
      isCrazyhouse: a.isCrazyhouse,
      whiteMs: created.whiteMs,
      blackMs: created.blackMs,
    };
    // Fog of War: each color gets its OWN redacted view of the starting position (see
    // RoomManager.createRoom's whiteView/blackView) instead of the one shared `created.fen` —
    // even the classical start isn't fully visible to either side under this variant's rule.
    const whitePayload: MatchFoundPayload = {
      ...basePayload,
      fen: created.whiteView?.fen ?? created.fen,
      visibleSquares: created.whiteView?.visibleSquares,
      color: 'w',
      playerToken: created.whitePlayerToken,
      opponent: { userId: blackEntry.userId },
    };
    const blackPayload: MatchFoundPayload = {
      ...basePayload,
      fen: created.blackView?.fen ?? created.fen,
      visibleSquares: created.blackView?.visibleSquares,
      color: 'b',
      playerToken: created.blackPlayerToken,
      opponent: { userId: whiteEntry.userId },
    };

    io.to(whiteEntry.socketId).emit('match_found', whitePayload);
    io.to(blackEntry.socketId).emit('match_found', blackPayload);
    console.log(`[socket] match_found room=${created.roomId} white=${whiteEntry.socketId} black=${blackEntry.socketId}`);
  }

  io.on('connection', (socket) => {
    const userId = extractUserId(socket);
    console.log(`[socket] connected ${socket.id}${userId ? ` (user ${userId})` : ' (guest)'} — queue size ${matchmaker.size()}`);

    socket.on('join_queue', (payload: JoinQueuePayload, ack?: (res: Ack) => void) => {
      if (!isValidTimeControl(payload?.timeControl)) {
        ack?.({ ok: false, error: 'Invalid time control.' });
        return;
      }
      const conflict = conflictingVariantError(payload);
      if (conflict) {
        ack?.({ ok: false, error: conflict });
        return;
      }

      const entry = {
        socketId: socket.id,
        userId,
        timeControl: payload.timeControl,
        timeControlLabel: typeof payload.timeControlLabel === 'string' ? payload.timeControlLabel : undefined,
        isChess960: Boolean(payload.isChess960),
        isKingOfTheHill: Boolean(payload.isKingOfTheHill),
        isThreeCheck: Boolean(payload.isThreeCheck),
        isSetupChess: Boolean(payload.isSetupChess),
        isFogOfWar: Boolean(payload.isFogOfWar),
        isGiveaway: Boolean(payload.isGiveaway),
        isAtomic: Boolean(payload.isAtomic),
        isDuckChess: Boolean(payload.isDuckChess),
        isSpellChess: Boolean(payload.isSpellChess),
        isHorde: Boolean(payload.isHorde),
        isCrazyhouse: Boolean(payload.isCrazyhouse),
        rating: typeof payload.rating === 'number' ? payload.rating : undefined,
        queuedAt: Date.now(),
      };

      const opponent = matchmaker.join(entry);
      ack?.({ ok: true });
      if (!opponent) return;
      // Setup Chess has no starting position at all until both players submit a blind army — see
      // SetupChessPairingManager's own doc comment for why this can't just be pairAndCreateRoom.
      if (entry.isSetupChess) {
        setupChessPairings.pair(entry, opponent);
      } else {
        pairAndCreateRoom(entry, opponent);
      }
    });

    socket.on('leave_queue', (_payload: unknown, ack?: (res: Ack) => void) => {
      matchmaker.leave(socket.id);
      ack?.({ ok: true });
    });

    socket.on('create_challenge', (payload: CreateChallengePayload, ack?: (res: Ack<{ code: string }>) => void) => {
      if (!isValidTimeControl(payload?.timeControl)) {
        ack?.({ ok: false, error: 'Invalid time control.' });
        return;
      }
      const conflict = conflictingVariantError(payload);
      if (conflict) {
        ack?.({ ok: false, error: conflict });
        return;
      }
      const challenge = challenges.create({
        creatorSocketId: socket.id,
        creatorUserId: userId,
        timeControl: payload.timeControl,
        timeControlLabel: typeof payload.timeControlLabel === 'string' ? payload.timeControlLabel : undefined,
        isChess960: Boolean(payload.isChess960),
        isKingOfTheHill: Boolean(payload.isKingOfTheHill),
        isThreeCheck: Boolean(payload.isThreeCheck),
        isSetupChess: Boolean(payload.isSetupChess),
        isFogOfWar: Boolean(payload.isFogOfWar),
        isGiveaway: Boolean(payload.isGiveaway),
        isAtomic: Boolean(payload.isAtomic),
        isDuckChess: Boolean(payload.isDuckChess),
        isSpellChess: Boolean(payload.isSpellChess),
        isHorde: Boolean(payload.isHorde),
        isCrazyhouse: Boolean(payload.isCrazyhouse),
      });
      ack?.({ ok: true, code: challenge.code });
    });

    socket.on('cancel_challenge', (payload: JoinChallengePayload, ack?: (res: Ack) => void) => {
      const challenge = challenges.find(payload?.code);
      if (!challenge || challenge.creatorSocketId !== socket.id) {
        ack?.({ ok: false, error: 'Challenge not found.' });
        return;
      }
      challenges.remove(payload.code);
      ack?.({ ok: true });
    });

    socket.on('join_challenge', (payload: JoinChallengePayload, ack?: (res: Ack) => void) => {
      const code = typeof payload?.code === 'string' ? payload.code.trim().toUpperCase() : '';
      const challenge = challenges.find(code);
      if (!challenge) {
        ack?.({ ok: false, error: 'That challenge code was not found or has expired.' });
        return;
      }
      if (challenge.creatorSocketId === socket.id) {
        ack?.({ ok: false, error: "You can't join your own challenge." });
        return;
      }
      challenges.remove(code);
      ack?.({ ok: true });

      const creatorEntry = {
        socketId: challenge.creatorSocketId,
        userId: challenge.creatorUserId,
        timeControl: challenge.timeControl,
        timeControlLabel: challenge.timeControlLabel,
        isChess960: challenge.isChess960,
        isKingOfTheHill: challenge.isKingOfTheHill,
        isThreeCheck: challenge.isThreeCheck,
        isSetupChess: challenge.isSetupChess,
        isFogOfWar: challenge.isFogOfWar,
        isGiveaway: challenge.isGiveaway,
        isAtomic: challenge.isAtomic,
        isDuckChess: challenge.isDuckChess,
        isSpellChess: challenge.isSpellChess,
        isHorde: challenge.isHorde,
        isCrazyhouse: challenge.isCrazyhouse,
      };
      const joinerEntry = {
        socketId: socket.id,
        userId,
        timeControl: challenge.timeControl,
        timeControlLabel: challenge.timeControlLabel,
        isChess960: challenge.isChess960,
        isKingOfTheHill: challenge.isKingOfTheHill,
        isThreeCheck: challenge.isThreeCheck,
        isSetupChess: challenge.isSetupChess,
        isFogOfWar: challenge.isFogOfWar,
        isGiveaway: challenge.isGiveaway,
        isAtomic: challenge.isAtomic,
        isDuckChess: challenge.isDuckChess,
        isSpellChess: challenge.isSpellChess,
        isHorde: challenge.isHorde,
        isCrazyhouse: challenge.isCrazyhouse,
      };
      // Same "no room until both blind armies are in" branch as join_queue above.
      if (challenge.isSetupChess) {
        setupChessPairings.pair(creatorEntry, joinerEntry);
      } else {
        pairAndCreateRoom(creatorEntry, joinerEntry);
      }
    });

    socket.on('list_active_games', async (_payload: unknown, ack?: (res: Ack<{ games: Awaited<ReturnType<typeof rooms.listActiveGames>> }>) => void) => {
      // Unlike an Express route handler, socket.io never awaits/catches a listener's own promise
      // — a rejection here (e.g. a transient DB hiccup during the username lookup) would otherwise
      // be a genuinely unhandled rejection, which can crash the whole process (killing every
      // other active game too), not just fail this one request.
      try {
        const games = await rooms.listActiveGames();
        ack?.({ ok: true, games });
      } catch (err) {
        console.error('[socket] list_active_games failed:', err);
        ack?.({ ok: false, error: 'Could not load active games.' });
      }
    });

    socket.on('spectate_game', (payload: { roomId: string }, ack?: (res: Ack) => void) => {
      const result = rooms.spectate(socket.id, payload?.roomId);
      ack?.(result);
    });

    socket.on('stop_spectating', (_payload: unknown, ack?: (res: Ack) => void) => {
      rooms.stopSpectating(socket.id);
      ack?.({ ok: true });
    });

    socket.on('submit_setup_chess', (payload: SubmitSetupChessPayload, ack?: (res: Ack) => void) => {
      const pairingId = typeof payload?.pairingId === 'string' ? payload.pairingId : '';
      if (!pairingId || !isValidSetupChessPieces(payload?.pieces)) {
        ack?.({ ok: false, error: 'Invalid setup.' });
        return;
      }
      ack?.(setupChessPairings.submitSetup(socket.id, pairingId, payload.pieces));
    });

    socket.on('make_move', (payload: MakeMovePayload, ack?: (res: Ack) => void) => {
      const result = rooms.applyMove(socket.id, payload);
      ack?.(result);
    });

    socket.on('rejoin_game', (payload: RejoinGamePayload, ack?: (res: Ack) => void) => {
      const result = rooms.rejoin(socket.id, payload);
      ack?.(result);
    });

    socket.on('resign', (payload: ResignPayload, ack?: (res: Ack) => void) => {
      ack?.(rooms.resign(socket.id, payload?.roomId));
    });

    socket.on('offer_draw', (payload: OfferDrawPayload, ack?: (res: Ack) => void) => {
      ack?.(rooms.offerDraw(socket.id, payload?.roomId));
    });

    socket.on('respond_draw', (payload: RespondDrawPayload, ack?: (res: Ack) => void) => {
      ack?.(rooms.respondToDraw(socket.id, payload?.roomId, Boolean(payload?.accept)));
    });

    socket.on('send_chat', (payload: SendChatPayload, ack?: (res: Ack) => void) => {
      ack?.(rooms.sendChatMessage(socket.id, payload?.roomId, typeof payload?.text === 'string' ? payload.text : ''));
    });

    socket.on('create_tournament', async (payload: CreateTournamentPayload, ack?: (res: Ack<{ code: string; tournamentId: string }>) => void) => {
      if (!userId) {
        ack?.({ ok: false, error: 'You need to be logged in to create a tournament.' });
        return;
      }
      if (!isValidTimeControl(payload?.timeControl)) {
        ack?.({ ok: false, error: 'Invalid time control.' });
        return;
      }
      const name = typeof payload?.name === 'string' ? payload.name.trim().slice(0, 60) : '';
      if (!name) {
        ack?.({ ok: false, error: 'Please enter a tournament name.' });
        return;
      }
      try {
        const user = await prisma.user.findUnique({ where: { id: userId }, select: { username: true } });
        if (!user) {
          ack?.({ ok: false, error: 'Your account could not be found.' });
          return;
        }
        const tournament = await tournaments.create({
          name,
          creatorSocketId: socket.id,
          creatorUserId: userId,
          creatorUsername: user.username,
          timeControl: payload.timeControl,
          timeControlLabel: typeof payload.timeControlLabel === 'string' ? payload.timeControlLabel : undefined,
          chess960: Boolean(payload.isChess960),
          kingOfTheHill: Boolean(payload.isKingOfTheHill),
          threeCheck: Boolean(payload.isThreeCheck),
        });
        ack?.({ ok: true, code: tournament.code, tournamentId: tournament.id });
      } catch (err) {
        console.error('[socket] create_tournament failed:', err);
        ack?.({ ok: false, error: 'Could not create the tournament.' });
      }
    });

    socket.on('join_tournament', async (payload: JoinTournamentPayload, ack?: (res: Ack<{ tournament: TournamentLobbyState }>) => void) => {
      if (!userId) {
        ack?.({ ok: false, error: 'You need to be logged in to join a tournament.' });
        return;
      }
      const code = typeof payload?.code === 'string' ? payload.code.trim() : '';
      if (!code) {
        ack?.({ ok: false, error: 'Please enter a code.' });
        return;
      }
      try {
        const user = await prisma.user.findUnique({ where: { id: userId }, select: { username: true } });
        if (!user) {
          ack?.({ ok: false, error: 'Your account could not be found.' });
          return;
        }
        ack?.(await tournaments.join(code, socket.id, userId, user.username));
      } catch (err) {
        console.error('[socket] join_tournament failed:', err);
        ack?.({ ok: false, error: 'Could not join the tournament.' });
      }
    });

    socket.on('leave_tournament', (payload: TournamentIdPayload, ack?: (res: Ack) => void) => {
      tournaments.leaveLobby(payload?.tournamentId, socket.id);
      ack?.({ ok: true });
    });

    socket.on('start_tournament', (payload: TournamentIdPayload, ack?: (res: Ack) => void) => {
      ack?.(tournaments.start(payload?.tournamentId, socket.id));
    });

    socket.on('get_tournament_standings', (payload: TournamentIdPayload, ack?: (res: Ack<{ standings: TournamentStandingsPayload }>) => void) => {
      if (!userId) {
        ack?.({ ok: false, error: 'You need to be logged in.' });
        return;
      }
      const standings = tournaments.getStandingsPayloadFor(payload?.tournamentId, userId);
      if (!standings) {
        ack?.({ ok: false, error: 'Tournament not found.' });
        return;
      }
      ack?.({ ok: true, standings });
    });

    socket.on('disconnect', () => {
      matchmaker.leave(socket.id);
      challenges.removeByCreator(socket.id);
      rooms.handleDisconnect(socket.id);
      tournaments.handleDisconnect(socket.id);
      setupChessPairings.handleDisconnect(socket.id);
      console.log(`[socket] disconnected ${socket.id}`);
    });
  });
}
