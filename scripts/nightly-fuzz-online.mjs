#!/usr/bin/env node
/**
 * Extended, nightly-only fuzz test for the REAL server/socket path of the online-capable variants
 * — plays many randomized games end-to-end through the actual running server (not a pure-logic
 * simulation; see nightly-fuzz-logic.mjs for that), two socket.io-client "players" submitting moves
 * computed from their OWN locally-tracked (server-confirmed) fen. Catches anything the pure logic
 * fuzz can't: a move the client computed as legal being rejected by the server (a client/server
 * desync), an unexpected disconnect, or the server throwing mid-game.
 *
 * Variants covered (each section reports separately):
 *  - Fog of War: pseudo-legal moves from each side's own redacted fen.
 *  - Duck Chess: a turn is a move AND the duck's new square. Every turn comes from the mobile app's own duck-aware
 *    move generation and legal duck squares and MUST be accepted; a fraction of turns first submit something the
 *    server MUST refuse — a move the duck blocks (landing on it / passing over it), or a legal move with a bad duck
 *    (missing, occupied, or the square it already stands on) — and the refused turn must leave the room untouched
 *    (the real turn is then accepted). Every ack / opponent_move must carry the duck square the mobile app expects,
 *    and a king capture must end the game with reason duckChess.
 *  - Atomic: same idea — every move comes from the mobile app's own atomic.ts and MUST be accepted; a fraction
 *    of turns first submit a pseudo-legal move that Atomic forbids (a king capture, a blast that would reach
 *    the mover's own king, ...) which the server MUST refuse; every game_over (king exploded, checkmate,
 *    stalemate, insufficient material, repetition) must agree with the mobile app's own judgement.
 *  - Giveaway: every move comes from the mobile app's own getGiveawayMoves and MUST be accepted; a
 *    fraction of turns ALSO first submit a deliberately illegal move (a non-capturing move while a
 *    capture is mandatory) and the server MUST reject it — the "server is the authority" check —
 *    and every game_over must agree with the mobile app's own winner detection.
 *  - 4 Player Chess: FOUR real sockets per game in one room, each keeping its OWN position (built only from the snapshots it is sent, read
 *    with the mobile app's own 4-seat engine) and moving from its own legal-move generation. The headline assertion is that all four hold the
 *    byte-identical snapshot for every seq (issue kind 'snapshot-mismatch'); also: seq contiguous per client, illegal / out-of-turn moves refused
 *    and the room left untouched, resignations, disconnects with a bot takeover and a retake by token (needs the server started with
 *    FOUR_GRACE_MS, see below), and a four_game_over that agrees across seats and with the app engine's own reading of the final position.
 *
 * Usage:
 *   FOUR_GRACE_MS=1500 npm run dev             (in one terminal, from backend/; the override shortens the 4 Player bot-takeover grace from 45 s so the
 *                                               fuzz can watch takeovers - it is ignored when NODE_ENV=production. Without it the 4 Player section
 *                                               still runs, but brings a dropped player back inside the grace instead of waiting for the takeover.)
 *   npx tsx scripts/nightly-fuzz-online.mjs [fogGames] [maxPlies] [giveawayGames] [atomicGames] [duckGames] [fourPlayerGames]
 * (the others default to the same count as fogGames.) BACKEND_URL env var overrides the
 * default http://localhost:3000.
 */
import { writeFileSync } from 'node:fs';
import { io } from 'socket.io-client';
import { ChessEngine } from '../../src/logic/ChessEngine.ts';
import { getGiveawayMoves, getGiveawayWinner } from '../../src/logic/giveaway.ts';
import { getAtomicMoves, getAtomicWinner, isAtomicThreefoldRepetition } from '../../src/logic/atomic.ts';
import { getLegalDuckPlacementSquares, hasNoDuckMoves } from '../../src/logic/duckChess.ts';
// The MOBILE APP's 4-seat engine (not the server's generated mirror): the 4 Player clients are independent of the server. Imported file by file, like
// the other variants' logic: under tsx the app's .ts files load as CommonJS, and a namespace import of its index.ts (which is only `export *`) would
// expose nothing but `default`.
import { PLAYABLE_SQUARES, squareName } from '../../src/logic/fourPlayer/board.ts';
import { BISHOP, KNIGHT, QUEEN, ROOK, deserialize } from '../../src/logic/fourPlayer/state.ts';
import { legalMoves, promotionOf } from '../../src/logic/fourPlayer/moves.ts';
const FP = { PLAYABLE_SQUARES, squareName, BISHOP, KNIGHT, QUEEN, ROOK, deserialize, legalMoves, promotionOf };

const SERVER_URL = process.env.BACKEND_URL ?? 'http://localhost:3000';
const GAMES = Number(process.argv[2] ?? 100);
const MAX_PLIES = Number(process.argv[3] ?? 60);
const GIVEAWAY_GAMES = Number(process.argv[4] ?? GAMES);
const ATOMIC_GAMES = Number(process.argv[5] ?? GAMES);
const DUCK_GAMES = Number(process.argv[6] ?? GAMES);
const FOUR_GAMES = Number(process.argv[7] ?? GAMES);

function connect(name) {
  return new Promise((resolve, reject) => {
    const socket = io(SERVER_URL, { transports: ['websocket'], reconnection: false });
    const timer = setTimeout(() => reject(new Error(`${name}: connect timed out`)), 8000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(new Error(`${name}: connect_error — ${err.message}`));
    });
  });
}

function emitAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(5000).emit(event, payload, (err, response) => {
      if (err) reject(new Error(`"${event}" ack never arrived (timeout)`));
      else resolve(response);
    });
  });
}

/**
 * Resolves with the next `event` on `socket` — and, because `socket.once` only sees events that arrive AFTER it is
 * called, THE LISTENER MUST BE ATTACHED BEFORE the emit that provokes the event.
 *
 * THE TRAP (it failed the nightly once in ~800 pairings, as 'timed out waiting for "match_found"'): the second
 * player's join_queue makes the server send the ack and match_found back to back. If both frames arrive in one network
 * read (a busy CI runner), the socket parses them in a single synchronous pass: the ack callback only QUEUES the
 * awaiting code, and match_found fires before it runs — with nobody listening yet. Writing
 * `await emitAck(join_queue); return waitFor(match_found)` is therefore a race; register the listener first.
 * (Not a server bug: the real app keeps a permanent match_found listener.)
 */
function waitFor(socket, event, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function randInt(n) {
  return Math.floor(Math.random() * n);
}

async function playOneGame(gameIndex) {
  const alice = await connect(`Alice${gameIndex}`);
  const bob = await connect(`Bob${gameIndex}`);
  const timeControl = { initialSeconds: 300, incrementSeconds: 0 };

  const [matchA, matchB] = await Promise.all([
    (async () => {
      const matchFound = waitFor(alice, 'match_found'); // BEFORE the emit — see waitFor's doc comment
      matchFound.catch(() => {}); // no unhandled rejection if the join fails first; the caller still sees it
      await emitAck(alice, 'join_queue', { timeControl, isChess960: false, isFogOfWar: true });
      return matchFound;
    })(),
    (async () => {
      await new Promise((r) => setTimeout(r, 80));
      const matchFound = waitFor(bob, 'match_found'); // BEFORE the emit — see waitFor's doc comment
      matchFound.catch(() => {}); // no unhandled rejection if the join fails first; the caller still sees it
      await emitAck(bob, 'join_queue', { timeControl, isChess960: false, isFogOfWar: true });
      return matchFound;
    })(),
  ]);

  const roomId = matchA.roomId;
  const players = {
    w: matchA.color === 'w' ? alice : bob,
    b: matchA.color === 'b' ? alice : bob,
  };

  // Each side only ever sees its OWN server-redacted fen — tracked separately per color, never
  // shared, since conflating them (using White's own view to compute Black's move, say) would
  // produce exactly the kind of bogus "from square" this test is specifically trying NOT to
  // generate itself. Re-synced from that side's own make_move ack (the mover) or its own
  // opponent_move push (the non-mover) after every ply.
  const fenByColor = { w: matchA.color === 'w' ? matchA.fen : matchB.fen, b: matchA.color === 'b' ? matchA.fen : matchB.fen };
  const issues = [];
  let plies = 0;
  let gameOver = false;
  alice.once('game_over', () => {
    gameOver = true;
  });
  bob.once('game_over', () => {
    gameOver = true;
  });

  for (; plies < MAX_PLIES; plies++) {
    if (gameOver) break;
    const turn = new ChessEngine(fenByColor.w, { skipValidation: true }).getTurn();
    const mover = players[turn];
    const engine = new ChessEngine(fenByColor[turn], { skipValidation: true });
    const pseudo = engine.getPseudoLegalMoves(turn);
    if (pseudo.length === 0) break;
    const pick = pseudo[randInt(pseudo.length)];

    const opponentColor = turn === 'w' ? 'b' : 'w';
    const opponent = players[opponentColor];
    const opponentMovePromise = waitFor(opponent, 'opponent_move', 5000).catch(() => null);
    const ack = await emitAck(mover, 'make_move', { roomId, from: pick.from, to: pick.to, promotion: pick.promotion });

    if (!ack.ok) {
      // A move the mover's OWN current-view engine considered pseudo-legal was rejected by the
      // server. One specific shape of this is EXPECTED, not a bug: a quiet (non-capturing) pawn
      // push to a same-file square that LOOKS empty in this player's own redacted fen but is
      // actually occupied by a fogged enemy piece — buildRedactedFen blanks a fogged square the
      // same way it renders a genuinely empty one, so the client-side engine (which only ever
      // sees that redacted fen) has no way to tell the two apart ahead of time. This is the
      // "blind push that turns out blocked" mechanic inherent to Fog of War Online, not a desync —
      // logged separately so it doesn't drown out a genuinely unexpected rejection (any other
      // move type, or a capture, being rejected WOULD be a real bug worth failing the run over).
      const movingPiece = engine.getPieceAt(pick.from);
      const isAmbiguousBlindPush = movingPiece?.type === 'p' && !pick.captured && pick.from[0] === pick.to[0];
      const record = { game: gameIndex, ply: plies, fen: fenByColor[turn], pick, error: ack.error };
      if (isAmbiguousBlindPush) {
        issues.push({ kind: 'expected-blind-pawn-push-blocked-by-fog', ...record });
      } else {
        issues.push({ kind: 'server-rejected-client-pseudo-legal-move', ...record });
      }
      break;
    }
    fenByColor[turn] = ack.fen;
    const opponentPayload = await opponentMovePromise;
    if (opponentPayload) fenByColor[opponentColor] = opponentPayload.fen;
  }

  const gameOverA = waitFor(alice, 'game_over', 3000).catch(() => null);
  const gameOverB = waitFor(bob, 'game_over', 3000).catch(() => null);
  alice.disconnect();
  bob.disconnect();
  await Promise.all([gameOverA, gameOverB]).catch(() => {});

  return { plies, issues };
}

/** One real Giveaway game through the server — see the file header for what is checked. */
async function playGiveawayGame(gameIndex) {
  const alice = await connect(`GAlice${gameIndex}`);
  const bob = await connect(`GBob${gameIndex}`);
  const timeControl = { initialSeconds: 300, incrementSeconds: 0 };

  const [matchA, matchB] = await Promise.all([
    (async () => {
      const matchFound = waitFor(alice, 'match_found'); // BEFORE the emit — see waitFor's doc comment
      matchFound.catch(() => {}); // no unhandled rejection if the join fails first; the caller still sees it
      await emitAck(alice, 'join_queue', { timeControl, isGiveaway: true });
      return matchFound;
    })(),
    (async () => {
      await new Promise((r) => setTimeout(r, 80));
      const matchFound = waitFor(bob, 'match_found'); // BEFORE the emit — see waitFor's doc comment
      matchFound.catch(() => {}); // no unhandled rejection if the join fails first; the caller still sees it
      await emitAck(bob, 'join_queue', { timeControl, isGiveaway: true });
      return matchFound;
    })(),
  ]);

  const roomId = matchA.roomId;
  const players = { w: matchA.color === 'w' ? alice : bob, b: matchA.color === 'b' ? alice : bob };
  const issues = [];
  const stats = { plies: 0, illegalProbes: 0, finished: false };
  let gameOverPayload = null;
  const onOver = (p) => (gameOverPayload = p);
  alice.once('game_over', onOver);
  bob.once('game_over', onOver);
  let fen = matchA.fen;
  if (matchA.isGiveaway !== true) issues.push({ kind: 'match-found-missing-isGiveaway', game: gameIndex });

  const newEngine = (f) => new ChessEngine(f, { skipValidation: true, giveaway: true });

  for (; stats.plies < MAX_PLIES; stats.plies++) {
    if (gameOverPayload) break;
    const engine = newEngine(fen);
    const turn = engine.getTurn();
    const mover = players[turn];
    const legal = getGiveawayMoves(engine);
    if (legal.length === 0) break;

    // Server authority: first try a pseudo-legal move that is NOT a legal Giveaway move (only
    // exists when a capture is mandatory and a quiet move is also pseudo-legal) — it must bounce.
    if (Math.random() < 0.3) {
      const key = (m) => `${m.from}${m.to}${m.promotion ?? ''}`;
      const legalKeys = new Set(legal.map(key));
      const illegal = engine.getPseudoLegalMoves(turn).filter((m) => !legalKeys.has(key(m)));
      if (illegal.length > 0) {
        const bad = illegal[randInt(illegal.length)];
        stats.illegalProbes++;
        const refusal = await emitAck(mover, 'make_move', { roomId, from: bad.from, to: bad.to, promotion: bad.promotion });
        if (refusal.ok) {
          issues.push({ kind: 'server-ACCEPTED-illegal-giveaway-move', game: gameIndex, ply: stats.plies, fen, move: bad });
          break;
        }
      }
    }

    const pick = legal[randInt(legal.length)];
    const opponentColor = turn === 'w' ? 'b' : 'w';
    const opponentMove = waitFor(players[opponentColor], 'opponent_move', 5000).catch(() => null);
    const ack = await emitAck(mover, 'make_move', { roomId, from: pick.from, to: pick.to, promotion: pick.promotion });
    if (!ack.ok) {
      issues.push({ kind: 'server-rejected-legal-giveaway-move', game: gameIndex, ply: stats.plies, fen, pick, error: ack.error });
      break;
    }
    fen = ack.fen;
    const pushed = await opponentMove;
    if (pushed && pushed.fen !== ack.fen) {
      issues.push({ kind: 'opponent-fen-differs-from-mover-ack', game: gameIndex, ply: stats.plies, ack: ack.fen, pushed: pushed.fen });
      break;
    }

    // The server's verdict must match the mobile app's own winner detection for the new position.
    const winner = getGiveawayWinner(newEngine(fen));
    if (winner) {
      stats.finished = true;
      await new Promise((r) => setTimeout(r, 150));
      if (!gameOverPayload || gameOverPayload.reason !== 'giveaway' || gameOverPayload.winner !== winner) {
        issues.push({ kind: 'game-over-disagrees-with-mobile-winner', game: gameIndex, ply: stats.plies, fen, expected: winner, got: gameOverPayload });
      }
      break;
    }
    if (gameOverPayload && !['timeout', 'abandonment'].includes(gameOverPayload.reason)) {
      issues.push({ kind: 'unexpected-game-over', game: gameIndex, ply: stats.plies, fen, got: gameOverPayload });
      break;
    }
  }

  const overA = waitFor(alice, 'game_over', 1000).catch(() => null);
  alice.disconnect();
  bob.disconnect();
  await overA;
  return { stats, issues };
}

/** One real Atomic game through the server — see the file header for what is checked. */
async function playAtomicGame(gameIndex) {
  const alice = await connect(`AAlice${gameIndex}`);
  const bob = await connect(`ABob${gameIndex}`);
  const timeControl = { initialSeconds: 300, incrementSeconds: 0 };

  const [matchA] = await Promise.all([
    (async () => {
      const matchFound = waitFor(alice, 'match_found'); // BEFORE the emit — see waitFor's doc comment
      matchFound.catch(() => {}); // no unhandled rejection if the join fails first; the caller still sees it
      await emitAck(alice, 'join_queue', { timeControl, isAtomic: true });
      return matchFound;
    })(),
    (async () => {
      await new Promise((r) => setTimeout(r, 80));
      const matchFound = waitFor(bob, 'match_found'); // BEFORE the emit — see waitFor's doc comment
      matchFound.catch(() => {}); // no unhandled rejection if the join fails first; the caller still sees it
      await emitAck(bob, 'join_queue', { timeControl, isAtomic: true });
      return matchFound;
    })(),
  ]);

  const roomId = matchA.roomId;
  const players = { w: matchA.color === 'w' ? alice : bob, b: matchA.color === 'b' ? alice : bob };
  const issues = [];
  const stats = { plies: 0, illegalProbes: 0, finished: false, kingExplosions: 0 };
  let gameOverPayload = null;
  const onOver = (p) => (gameOverPayload = p);
  alice.once('game_over', onOver);
  bob.once('game_over', onOver);
  let fen = matchA.fen;
  const fens = [fen];
  if (matchA.isAtomic !== true) issues.push({ kind: 'match-found-missing-isAtomic', game: gameIndex });

  const newEngine = (f) => new ChessEngine(f, { atomic: true });
  const key = (m) => `${m.from}${m.to}${m.promotion ?? ''}`;

  for (; stats.plies < MAX_PLIES * 2; stats.plies++) {
    if (gameOverPayload) break;
    const engine = newEngine(fen);
    const turn = engine.getTurn();
    const mover = players[turn];
    const legal = getAtomicMoves(engine);
    if (legal.length === 0) break;

    // Server authority: a move chess.js calls pseudo-legal that Atomic forbids must bounce.
    if (Math.random() < 0.3) {
      const legalKeys = new Set(legal.map(key));
      const illegal = new ChessEngine(fen, { skipValidation: true }).getPseudoLegalMoves(turn).filter((m) => !legalKeys.has(key(m)));
      if (illegal.length > 0) {
        const bad = illegal[randInt(illegal.length)];
        stats.illegalProbes++;
        const refusal = await emitAck(mover, 'make_move', { roomId, from: bad.from, to: bad.to, promotion: bad.promotion });
        if (refusal.ok) {
          issues.push({ kind: 'server-ACCEPTED-illegal-atomic-move', game: gameIndex, ply: stats.plies, fen, move: bad });
          break;
        }
      }
    }

    // Prefer captures half the time so explosions actually happen in 80-ply games.
    const captures = legal.filter((m) => m.captured);
    const pool = captures.length > 0 && Math.random() < 0.5 ? captures : legal;
    const pick = pool[randInt(pool.length)];
    const opponentColor = turn === 'w' ? 'b' : 'w';
    const opponentMove = waitFor(players[opponentColor], 'opponent_move', 5000).catch(() => null);
    const ack = await emitAck(mover, 'make_move', { roomId, from: pick.from, to: pick.to, promotion: pick.promotion ?? 'q' });
    if (!ack.ok) {
      issues.push({ kind: 'server-rejected-legal-atomic-move', game: gameIndex, ply: stats.plies, fen, pick, error: ack.error });
      break;
    }
    fen = ack.fen;
    fens.push(fen);
    const pushed = await opponentMove;
    if (pushed && pushed.fen !== ack.fen) {
      issues.push({ kind: 'opponent-fen-differs-from-mover-ack', game: gameIndex, ply: stats.plies, ack: ack.fen, pushed: pushed.fen });
      break;
    }

    // The server's verdict must match the mobile app's own judgement of the new position.
    const after = newEngine(fen);
    const kingWinner = getAtomicWinner(after);
    const status = after.getStatus();
    let expected = null;
    if (kingWinner) expected = { reason: 'atomic', winner: kingWinner };
    else if (after.isGameOver()) expected = { reason: status === 'checkmate' ? 'checkmate' : status === 'stalemate' ? 'stalemate' : 'draw', winner: status === 'checkmate' ? turn : null };
    else if (isAtomicThreefoldRepetition(fens)) expected = { reason: 'draw', winner: null };
    if (expected) {
      stats.finished = true;
      if (kingWinner) stats.kingExplosions++;
      await new Promise((r) => setTimeout(r, 150));
      if (!gameOverPayload || gameOverPayload.reason !== expected.reason || gameOverPayload.winner !== expected.winner) {
        issues.push({ kind: 'game-over-disagrees-with-mobile', game: gameIndex, ply: stats.plies, fen, expected, got: gameOverPayload });
      }
      break;
    }
    if (gameOverPayload && !['timeout', 'abandonment'].includes(gameOverPayload.reason)) {
      issues.push({ kind: 'unexpected-game-over', game: gameIndex, ply: stats.plies, fen, got: gameOverPayload });
      break;
    }
  }

  const overA = waitFor(alice, 'game_over', 1000).catch(() => null);
  alice.disconnect();
  bob.disconnect();
  await overA;
  return { stats, issues };
}

/** One real Duck Chess game through the server — see the file header for what is checked. */
async function playDuckGame(gameIndex) {
  const alice = await connect(`DAlice${gameIndex}`);
  const bob = await connect(`DBob${gameIndex}`);
  const timeControl = { initialSeconds: 300, incrementSeconds: 0 };

  const [matchA] = await Promise.all([
    (async () => {
      const matchFound = waitFor(alice, 'match_found'); // BEFORE the emit — see waitFor's doc comment
      matchFound.catch(() => {}); // no unhandled rejection if the join fails first; the caller still sees it
      await emitAck(alice, 'join_queue', { timeControl, isDuckChess: true });
      return matchFound;
    })(),
    (async () => {
      await new Promise((r) => setTimeout(r, 80));
      const matchFound = waitFor(bob, 'match_found'); // BEFORE the emit — see waitFor's doc comment
      matchFound.catch(() => {}); // no unhandled rejection if the join fails first; the caller still sees it
      await emitAck(bob, 'join_queue', { timeControl, isDuckChess: true });
      return matchFound;
    })(),
  ]);

  const roomId = matchA.roomId;
  const players = { w: matchA.color === 'w' ? alice : bob, b: matchA.color === 'b' ? alice : bob };
  const issues = [];
  const stats = { plies: 0, illegalProbes: 0, finished: false, kingCaptures: 0 };
  let gameOverPayload = null;
  const onOver = (p) => (gameOverPayload = p);
  alice.once('game_over', onOver);
  bob.once('game_over', onOver);
  let fen = matchA.fen;
  let duck = null;
  if (matchA.isDuckChess !== true) issues.push({ kind: 'match-found-missing-isDuckChess', game: gameIndex });

  const newEngine = (f, d) => new ChessEngine(f, { skipValidation: true, duckChess: true, duckSquare: d });
  const key = (m) => `${m.from}${m.to}${m.promotion ?? ''}`;

  for (; stats.plies < MAX_PLIES * 2; stats.plies++) {
    if (gameOverPayload) break;
    const engine = newEngine(fen, duck);
    const turn = engine.getTurn();
    const mover = players[turn];
    const legal = engine.getPseudoLegalMoves(turn);
    if (legal.length === 0) break;

    // Server authority, part 1: a move the duck blocks (plain chess says it is fine) must bounce.
    if (duck && Math.random() < 0.25) {
      const legalKeys = new Set(legal.map(key));
      const blocked = new ChessEngine(fen, { skipValidation: true }).getPseudoLegalMoves(turn).filter((m) => !legalKeys.has(key(m)));
      if (blocked.length > 0) {
        const bad = blocked[randInt(blocked.length)];
        stats.illegalProbes++;
        const refusal = await emitAck(mover, 'make_move', { roomId, from: bad.from, to: bad.to, promotion: bad.promotion, duckTo: 'a1' });
        if (refusal.ok) {
          issues.push({ kind: 'server-ACCEPTED-duck-blocked-move', game: gameIndex, ply: stats.plies, fen, duck, move: bad });
          break;
        }
      }
    }

    const pick = legal[randInt(legal.length)];
    const after = newEngine(fen, duck);
    const applied = after.movePseudoLegal(pick.from, pick.to, pick.promotion);
    const kingCapture = applied?.captured === 'k';
    const squares = kingCapture ? [] : getLegalDuckPlacementSquares(after, duck);

    // Server authority, part 2: a legal move with a bad duck refuses the WHOLE turn and leaves the room untouched.
    if (!kingCapture && Math.random() < 0.25) {
      const occupiedSquare = ['a1', 'e1', 'e8', 'h8', 'd1', 'd8'].find((sq) => !squares.includes(sq) && sq !== duck && after.getPieceAt(sq));
      const badDucks = [undefined, ...(occupiedSquare ? [occupiedSquare] : []), ...(duck ? [duck] : [])];
      const badDuck = badDucks[randInt(badDucks.length)];
      stats.illegalProbes++;
      const refusal = await emitAck(mover, 'make_move', { roomId, from: pick.from, to: pick.to, promotion: pick.promotion, duckTo: badDuck });
      if (refusal.ok) {
        issues.push({ kind: 'server-ACCEPTED-bad-duck-destination', game: gameIndex, ply: stats.plies, fen, duck, move: pick, duckTo: badDuck });
        break;
      }
    }

    const duckTo = kingCapture ? undefined : squares[randInt(squares.length)];
    const opponentColor = turn === 'w' ? 'b' : 'w';
    const opponentMove = waitFor(players[opponentColor], 'opponent_move', 5000).catch(() => null);
    const ack = await emitAck(mover, 'make_move', { roomId, from: pick.from, to: pick.to, promotion: pick.promotion, duckTo });
    if (!ack.ok) {
      issues.push({ kind: 'server-rejected-legal-duck-turn', game: gameIndex, ply: stats.plies, fen, duck, pick, duckTo, error: ack.error });
      break;
    }
    fen = ack.fen;
    if (!kingCapture) duck = duckTo;
    if (!kingCapture && ack.duckSquare !== duck) {
      issues.push({ kind: 'ack-duck-differs', game: gameIndex, ply: stats.plies, expected: duck, got: ack.duckSquare });
      break;
    }
    const pushed = await opponentMove;
    if (pushed && (pushed.fen !== ack.fen || (!kingCapture && pushed.duckSquare !== duck))) {
      issues.push({ kind: 'opponent-state-differs-from-mover-ack', game: gameIndex, ply: stats.plies, ack: { fen: ack.fen, duck: ack.duckSquare }, pushed: { fen: pushed.fen, duck: pushed.duckSquare } });
      break;
    }

    let expected = null;
    if (kingCapture) expected = { reason: 'duckChess', winner: turn };
    else if (hasNoDuckMoves(newEngine(fen, duck))) expected = { reason: 'draw', winner: null };
    if (expected) {
      stats.finished = true;
      if (kingCapture) stats.kingCaptures++;
      await new Promise((r) => setTimeout(r, 150));
      if (!gameOverPayload || gameOverPayload.reason !== expected.reason || gameOverPayload.winner !== expected.winner) {
        issues.push({ kind: 'game-over-disagrees-with-mobile', game: gameIndex, ply: stats.plies, fen, expected, got: gameOverPayload });
      }
      break;
    }
    if (gameOverPayload && !['timeout', 'abandonment'].includes(gameOverPayload.reason)) {
      issues.push({ kind: 'unexpected-game-over', game: gameIndex, ply: stats.plies, fen, got: gameOverPayload });
      break;
    }
  }

  const overA = waitFor(alice, 'game_over', 1000).catch(() => null);
  alice.disconnect();
  bob.disconnect();
  await overA;
  return { stats, issues };
}

// --- 4 Player Chess ---------------------------------------------------------------------------------------------------------------------

/**
 * One 4 Player Chess game with FOUR real socket.io-client players (the server's matchmaker puts them in one room; four humans start at once),
 * checked against the spec's section 10 requirement: IDENTICAL snapshots to every seat for every seq, seq contiguous, every client move legal
 * in its OWN engine, the final result consistent with four_game_over, random disconnects and rejoins.
 *
 * The clients' engine is the MOBILE APP's (src/logic/fourPlayer), not the server's generated mirror, exactly as the other sections use the
 * app's ChessEngine / giveaway / atomic / duck logic: each client keeps its OWN position, built only from the snapshots it was sent, and
 * computes its moves from that. A move it computed as legal being refused, or two clients holding different positions, is a client/server
 * desync - the thing this file exists to catch.
 *
 * Per game: the seat on move plays a random legal move from its own tracked position; on a fraction of its turns it first submits an illegal
 * move (an unreachable destination) and the server MUST refuse it and send nothing; sometimes another seat tries a legal move out of turn
 * (refused too). Some games have a seat resign part-way. Some drop one seat's connection and later bring the player back with their token -
 * with the takeover grace shortened by FOUR_GRACE_MS on the server, the bot takeover happens first, then the retake; if the server still has
 * the full 45 s grace (the override is ignored in production), the player is brought straight back inside the grace instead. A game that has
 * not ended by itself is finished by resigning seats, and the four_game_over each client got must agree with the others, with the position it
 * ends in, and with the app engine's own reading of that position (scores, winners, reason).
 */
async function playFourPlayerGame(gameIndex) {
  const issues = [];
  const stats = { plies: 0, illegalProbes: 0, finished: false, naturalEnd: false, rejoins: 0, takeovers: 0, resigns: 0 };
  const problem = (kind, extra = {}) => issues.push({ kind, game: gameIndex, ply: stats.plies, ...extra });
  const timeControl = { initialSeconds: 300, incrementSeconds: 2 };
  const names = [0, 1, 2, 3].map((i) => `F${gameIndex}x${i}`);
  const sockets = [];
  for (const name of names) sockets.push(await connect(name));
  const clients = sockets.map((socket) => fourClient(socket));
  const found = sockets.map((s) => waitFor(s, 'four_match_found')); // BEFORE the emits - see waitFor's doc comment
  found.forEach((p) => p.catch(() => {})); // no unhandled rejection if a join fails first; the caller still sees it
  for (let i = 0; i < 4; i++) {
    const ack = await emitAck(sockets[i], 'four_join_queue', { timeControl, timeControlLabel: '5 | 2' });
    if (!ack.ok) problem('four-join-queue-refused', { player: i, error: ack.error });
  }
  const matches = await Promise.all(found);
  const roomId = matches[0].roomId;
  const seatsOf = []; // by seat: { client, socket, token, connected }
  matches.forEach((match, i) => {
    clients[i].start(match);
    seatsOf[match.seat] = { client: clients[i], socket: sockets[i], token: match.playerToken, connected: true, name: names[i] };
  });
  if (new Set(matches.map((m) => m.roomId)).size !== 1 || new Set(matches.map((m) => m.seat)).size !== 4) problem('match-found-inconsistent', { seats: matches.map((m) => m.seat), rooms: matches.map((m) => m.roomId) });
  if (new Set(matches.map((m) => JSON.stringify({ ...m, seat: 0, playerToken: 0 }))).size !== 1) problem('match-found-snapshots-differ', { clocks: matches.map((m) => m.clocksMs) });

  const live = () => seatsOf.filter((s) => s.connected);
  const lead = () => live()[0].client;
  /** Waits until every connected client has received the four_state with this seq. */
  const allHave = (seq, ms = 4000) => until(() => live().every((s) => s.client.bySeq.has(seq)), ms);
  /** THE headline check: at this seq every connected client holds the byte-identical snapshot (position, clocks, who moved and how, the events). */
  const compareAt = (seq) => {
    const copies = live().map((s) => ({ seat: seatIndexOf(s), p: s.client.bySeq.get(seq) })).filter((c) => c.p);
    if (copies.length < live().length) return problem('missing-four-state', { seq, have: copies.map((c) => c.seat) });
    const key = (p) => JSON.stringify({ roomId: p.roomId, seq: p.seq, actor: p.actor, move: p.move, events: p.events, state: p.state, clocksMs: p.clocksMs });
    const first = key(copies[0].p);
    for (const c of copies) {
      if (key(c.p) !== first) return problem('snapshot-mismatch', { seq, seatA: copies[0].seat, seatB: c.seat, a: copies[0].p, b: c.p });
    }
    const clocks = copies[0].p.clocksMs;
    if (!Array.isArray(clocks) || clocks.length !== 4 || clocks.some((ms) => !Number.isFinite(ms) || ms < 0 || ms > 300_000 + 60_000)) problem('implausible-clocks', { seq, clocks });
  };
  const seatIndexOf = (entry) => seatsOf.indexOf(entry);
  // The server allows 10 four_make_move calls per second per seat and counts REFUSED ones too (a human cannot play faster, and it stops a client
  // hammering the legality check). This fuzz plays far faster than a human, so it paces itself to 8 per seat per second: otherwise a legal move
  // would be refused for 'Too many moves' and look like a bug. (test-fourplayer-online.mjs scenario 3 tests the limit itself.)
  const moveCalls = [[], [], [], []];
  const paced = async (seat) => {
    for (;;) {
      const now = Date.now();
      moveCalls[seat] = moveCalls[seat].filter((t) => now - t < 1000);
      if (moveCalls[seat].length < 8) break;
      await sleep(1000 - (now - moveCalls[seat][0]) + 5);
    }
    moveCalls[seat].push(Date.now());
  };
  /** The snapshot text the room had at `seq`, as the lead client saw it (the starting snapshot for seq 0). */
  const textAt = (seq) => (seq === 0 ? lead().startText : lead().bySeq.get(seq)?.state);

  const plan = {
    resignAtPly: Math.random() < 0.5 ? 6 + randInt(20) : null,
    resignSeat: randInt(4),
    dropAtPly: Math.random() < 0.4 ? 4 + randInt(18) : null,
    dropSeat: randInt(4),
    backAfterPlies: 1 + randInt(8),
  };
  let dropped = null; // { seat, atPly, sawTakeover }
  let resigned = false;
  let graceMs = null;
  const graceShort = () => graceMs !== null && graceMs <= 10_000;

  const bringBack = async () => {
    const entry = seatsOf[dropped.seat];
    const back = await connect(`${names[dropped.seat]}-back`);
    const client = fourClient(back);
    const ack = await emitAck(back, 'four_rejoin', { roomId, playerToken: entry.token });
    stats.rejoins++;
    if (!ack.ok || ack.finished) return problem('rejoin-refused', { seat: dropped.seat, ack });
    // The room may have moved on (a bot) between the server answering and the others' copies arriving: compare AT the rejoin's seq.
    await until(() => lead().latest().seq >= ack.state.seq, 4000).catch(() => {});
    if (textAt(ack.state.seq) !== ack.state.state) problem('rejoin-state-mismatch', { seat: dropped.seat, rejoinSeq: ack.state.seq, leadSeq: lead().latest().seq });
    if (ack.state.seat !== dropped.seat || ack.state.seats[dropped.seat].kind !== 'human') problem('rejoin-did-not-restore-the-seat', { seat: dropped.seat, seats: ack.state.seats });
    client.startFromRejoin(ack.state);
    seatsOf[dropped.seat] = { client, socket: back, token: entry.token, connected: true, name: entry.name };
    dropped.done = true;
    sockets.push(back);
  };

  const resignSeat = async (seat) => {
    const entry = seatsOf[seat];
    if (!entry.connected || lead().tracked.status[seat] !== 'active') return false;
    const seqBefore = lead().latest().seq;
    const ack = await emitAck(entry.socket, 'four_resign', { roomId });
    if (!ack.ok) {
      problem('server-refused-resign', { seat, error: ack.error });
      return false;
    }
    stats.resigns++;
    await until(() => lead().latest().seq > seqBefore && live().every((s) => s.client.latest().seq === lead().latest().seq), 4000).catch(() => problem('resignation-state-did-not-reach-everyone', { seat, seqBefore }));
    compareAt(lead().latest().seq);
    return true;
  };

  for (; stats.plies < MAX_PLIES; stats.plies++) {
    const leader = lead();
    if (leader.tracked.result) break;

    if (plan.resignAtPly === stats.plies && !resigned) {
      resigned = true;
      await resignSeat(plan.resignSeat);
      if (lead().tracked.result) break;
    }
    if (plan.dropAtPly === stats.plies && !dropped) {
      const candidates = [0, 1, 2, 3].filter((s) => seatsOf[s].connected && lead().tracked.status[s] === 'active');
      const seat = candidates.length > 0 ? candidates[plan.dropSeat % candidates.length] : null;
      if (seat !== null && live().length === 4) {
        const others = live().filter((s) => seatIndexOf(s) !== seat);
        const before = others.map((s) => s.client.seatUpdates.length);
        seatsOf[seat].socket.disconnect();
        seatsOf[seat].connected = false;
        dropped = { seat, atPly: stats.plies, sawTakeover: false, done: false };
        await until(() => others.every((s, i) => s.client.seatUpdates.length > before[i]), 4000).catch(() => problem('no-seat-update-after-disconnect', { seat }));
        const away = others[0].client.seatUpdates.at(-1)?.seats?.[seat];
        if (!away || away.connected !== false || away.kind !== 'human' || !(away.graceMsLeft > 0)) problem('bad-away-announcement', { seat, away });
        else graceMs = away.graceMsLeft;
        // With the full 45 s grace nothing would happen for 45 s if this seat's turn came: bring the player straight back, inside the grace.
        if (!graceShort()) await bringBack();
      }
    }
    if (dropped && !dropped.done && graceShort() && stats.plies >= dropped.atPly + plan.backAfterPlies) {
      await bringBack();
    }

    const turn = lead().tracked.turn;
    const mover = seatsOf[turn];
    if (!mover.connected) {
      // The seat on move belongs to a player who is away: nothing happens until the grace runs out and the bot takes over and plays.
      const seqBefore = lead().latest().seq;
      const ok = await until(() => lead().latest().seq > seqBefore, (graceMs ?? 1500) + 8000).then(() => true, () => false);
      if (!ok) {
        problem('stalled-waiting-for-takeover', { seat: turn, graceMs });
        break;
      }
      const after = lead().latest().payload;
      if (after.actor === 'bot') {
        stats.takeovers++;
        if (dropped) dropped.sawTakeover = true;
      }
      await allHave(after.seq).catch(() => {});
      compareAt(after.seq);
      continue;
    }

    // The mover's OWN position and its own legal moves.
    const own = mover.client;
    if (own.tracked.turn !== turn || own.latest().seq !== leader.latest().seq) {
      problem('client-positions-differ-before-a-move', { seat: turn, ownSeq: own.latest().seq, leadSeq: leader.latest().seq });
      break;
    }
    const moves = FP.legalMoves(own.tracked, turn);
    if (moves.length === 0) {
      problem('no-legal-move-for-the-seat-on-move', { seat: turn, state: own.latest().text });
      break;
    }

    // Probes: something the server MUST refuse, and which must leave the room untouched.
    const probes = [];
    if (Math.random() < 0.3) {
      const pick = moves[randInt(moves.length)];
      const legalTos = new Set(moves.filter((m) => m.from === pick.from).map((m) => m.to));
      const to = FP.PLAYABLE_SQUARES.find((s) => s !== pick.from && !legalTos.has(s));
      probes.push({ socketOf: turn, payload: { roomId, from: FP.squareName(pick.from), to: FP.squareName(to) }, kind: 'server-ACCEPTED-illegal-fourplayer-move' });
    }
    if (Math.random() < 0.15) {
      const other = [0, 1, 2, 3].find((s) => s !== turn && seatsOf[s].connected);
      if (other !== undefined) {
        const m = FP.legalMoves(own.tracked, other)[0];
        if (m) probes.push({ socketOf: other, payload: { roomId, from: FP.squareName(m.from), to: FP.squareName(m.to) }, kind: 'server-ACCEPTED-out-of-turn-fourplayer-move' });
      }
    }
    const seqBefore = leader.latest().seq;
    for (const probe of probes) {
      stats.illegalProbes++;
      await paced(probe.socketOf);
      const ack = await emitAck(seatsOf[probe.socketOf].socket, 'four_make_move', probe.payload);
      if (ack.ok) problem(probe.kind, { payload: probe.payload, ack });
    }
    if (probes.length > 0) {
      await sleep(15);
      if (live().some((s) => s.client.latest().seq !== seqBefore)) problem('refused-move-changed-the-room', { seqBefore, seqNow: live().map((s) => s.client.latest().seq) });
    }

    const pick = moves[randInt(moves.length)];
    const promotion = FP.promotionOf(pick);
    const letter = promotion ? { [FP.QUEEN]: 'q', [FP.ROOK]: 'r', [FP.BISHOP]: 'b', [FP.KNIGHT]: 'n' }[promotion] : undefined;
    const payload = { roomId, from: FP.squareName(pick.from), to: FP.squareName(pick.to), ...(letter ? { promotion: letter } : {}) };
    await paced(turn);
    const ack = await emitAck(mover.socket, 'four_make_move', payload);
    if (!ack.ok) {
      problem('server-rejected-legal-fourplayer-move', { seat: turn, payload, error: ack.error, state: own.latest().text });
      break;
    }
    if (ack.seq !== seqBefore + 1) problem('ack-seq-not-contiguous', { ackSeq: ack.seq, expected: seqBefore + 1 });
    await allHave(ack.seq).catch(() => {});
    compareAt(ack.seq);
    const sent = mover.client.bySeq.get(ack.seq);
    if (sent && (sent.actor !== 'human' || !sent.move || sent.move.seat !== turn || sent.move.from !== payload.from || sent.move.to !== payload.to)) {
      problem('four-state-does-not-describe-the-move', { sent: payload, got: { actor: sent.actor, move: sent.move } });
    }
  }

  // If a seat was dropped and never came back, bring it back now (its token must still work), so the end of the game is seen by all four.
  if (dropped && !dropped.done) await bringBack().catch((e) => problem('rejoin-threw', { error: String(e) }));

  // End the game: it may have ended by itself; otherwise resign seats until three are out.
  stats.naturalEnd = !!lead().tracked.result;
  if (!lead().tracked.result) {
    for (const seat of [0, 1, 2, 3].sort(() => Math.random() - 0.5)) {
      if (lead().tracked.result) break;
      await resignSeat(seat);
    }
  }
  const ended = await until(() => live().every((s) => s.client.gameOvers.length >= 1), 6000).then(() => true, () => false);
  if (!ended) problem('no-game-over-for-some-seat', { seqs: live().map((s) => s.client.latest().seq), overs: live().map((s) => s.client.gameOvers.length) });
  else {
    stats.finished = true;
    const over = live()[0].client.gameOvers[0];
    for (const s of live()) {
      if (s.client.gameOvers.length !== 1) problem('game-over-delivered-more-than-once', { seat: seatIndexOf(s), count: s.client.gameOvers.length });
      if (JSON.stringify(s.client.gameOvers[0]) !== JSON.stringify(over)) problem('game-over-differs-between-seats', { a: over, b: s.client.gameOvers[0] });
    }
    // ...and with the app engine's own reading of the final position.
    let final = null;
    try {
      final = FP.deserialize(over.state);
    } catch (e) {
      problem('client-cannot-read-the-final-snapshot', { error: String(e) });
    }
    if (final) {
      if (!final.result && over.reason !== 'abandoned') problem('game-over-without-a-result-in-the-snapshot', { over });
      if (final.result && final.result.reason !== over.reason) problem('game-over-reason-disagrees-with-the-engine', { engine: final.result.reason, got: over.reason });
      if (JSON.stringify([...final.score]) !== JSON.stringify(over.scores)) problem('game-over-scores-disagree-with-the-engine', { engine: [...final.score], got: over.scores });
      const best = Math.max(...final.score);
      const expectedWinners = [0, 1, 2, 3].filter((s) => final.score[s] === best);
      if (final.result && JSON.stringify(expectedWinners) !== JSON.stringify([...over.winners].sort((a, b) => a - b))) problem('game-over-winners-disagree-with-the-engine', { engine: expectedWinners, got: over.winners });
      const last = lead().latest();
      if (last.text !== over.state) problem('game-over-snapshot-differs-from-the-last-four-state', { lastSeq: last.seq });
    }
    for (const s of live()) {
      const seqs = s.client.states.map((p) => p.seq);
      // contiguity is per client from the seq it started at (a rejoined client starts at its rejoin snapshot)
      if (seqs.some((q, i) => i > 0 && q !== seqs[i - 1] + 1)) problem('seq-not-contiguous', { seat: seatIndexOf(s), seqs: seqs.slice(0, 60) });
    }
    // A late rejoin of the finished game answers the result.
    const late = await connect(`F${gameIndex}-late`);
    const lateAck = await emitAck(late, 'four_rejoin', { roomId, playerToken: seatsOf[randInt(4)].token });
    if (!(lateAck.ok === true && lateAck.finished === true && JSON.stringify(lateAck.gameOver) === JSON.stringify(over))) problem('rejoin-after-end-wrong', { ack: lateAck });
    late.disconnect();
  }
  for (const s of seatsOf) s.socket.disconnect();
  sockets.forEach((s) => s.disconnect());
  for (const c of clients) issues.push(...c.drainProblems().map((p) => ({ ...p, game: gameIndex })));
  return { stats, issues };
}

/** One real player's side of a 4 Player room: a recorder of everything it is sent, plus its OWN position built only from those snapshots. */
function fourClient(socket) {
  const c = {
    states: [],
    bySeq: new Map(),
    seatUpdates: [],
    gameOvers: [],
    tracked: null,
    trackedSeq: -1,
    problems: [],
    latest() {
      const last = this.states.at(-1);
      return last ? { seq: last.seq, text: last.state, payload: last } : { seq: this.trackedSeq, text: this.startText, payload: null };
    },
    start(match) {
      this.startText = match.state;
      this.tracked = FP.deserialize(match.state);
      this.trackedSeq = 0;
    },
    startFromRejoin(state) {
      // A four_state that followed the ack on the same socket may already have been handled (the waitFor trap, again): never go BACK to the older snapshot.
      this.startText = state.state;
      if (this.trackedSeq >= state.seq) return;
      this.tracked = FP.deserialize(state.state);
      this.trackedSeq = state.seq;
    },
    drainProblems() {
      return this.problems.splice(0);
    },
  };
  socket.on('four_state', (p) => {
    // contiguity per client: each state is exactly the next one after the last it saw
    if (c.trackedSeq >= 0 && p.seq !== c.trackedSeq + 1) c.problems.push({ kind: 'seq-gap-or-duplicate', game: -1, expected: c.trackedSeq + 1, got: p.seq });
    c.states.push(p);
    c.bySeq.set(p.seq, p);
    try {
      c.tracked = FP.deserialize(p.state);
      c.trackedSeq = p.seq;
    } catch (e) {
      c.problems.push({ kind: 'client-cannot-read-snapshot', game: -1, seq: p.seq, error: String(e) });
    }
  });
  socket.on('four_seat_update', (p) => c.seatUpdates.push(p));
  socket.on('four_game_over', (p) => c.gameOvers.push(p));
  return c;
}

/** Polls until `test()` is truthy; rejects after `ms`. (Four sockets' events arrive independently, so "the next event on one socket" is not enough.) */
function until(test, ms = 4000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (test()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error('timed out waiting for a condition'));
      setTimeout(tick, 5);
    };
    tick();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`Nightly online fuzz: ${GAMES} real Fog of War games + ${GIVEAWAY_GAMES} Giveaway + ${ATOMIC_GAMES} Atomic + ${DUCK_GAMES} Duck Chess + ${FOUR_GAMES} 4 Player Chess games through ${SERVER_URL}, up to ${MAX_PLIES} plies each.\n`);
  let totalPlies = 0;
  const allIssues = [];
  let completedGames = 0;

  for (let g = 0; g < GAMES; g++) {
    try {
      const { plies, issues } = await playOneGame(g);
      totalPlies += plies;
      allIssues.push(...issues);
      completedGames++;
      if ((g + 1) % 10 === 0) console.log(`  ...${g + 1}/${GAMES} games played`);
    } catch (err) {
      allIssues.push({ kind: 'exception', game: g, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // --- Giveaway ---
  const giveaway = { games: 0, plies: 0, probes: 0, finished: 0, issues: [] };
  for (let g = 0; g < GIVEAWAY_GAMES; g++) {
    try {
      const { stats, issues } = await playGiveawayGame(g);
      giveaway.games++;
      giveaway.plies += stats.plies;
      giveaway.probes += stats.illegalProbes;
      if (stats.finished) giveaway.finished++;
      giveaway.issues.push(...issues);
      if ((g + 1) % 10 === 0) console.log(`  ...${g + 1}/${GIVEAWAY_GAMES} Giveaway games played`);
    } catch (err) {
      giveaway.issues.push({ kind: 'exception', game: g, error: err instanceof Error ? err.message : String(err) });
    }
  }
  allIssues.push(...giveaway.issues.map((i) => ({ ...i, variant: 'giveaway' })));

  // --- Atomic ---
  const atomic = { games: 0, plies: 0, probes: 0, finished: 0, kingExplosions: 0, issues: [] };
  for (let g = 0; g < ATOMIC_GAMES; g++) {
    try {
      const { stats, issues } = await playAtomicGame(g);
      atomic.games++;
      atomic.plies += stats.plies;
      atomic.probes += stats.illegalProbes;
      if (stats.finished) atomic.finished++;
      atomic.kingExplosions += stats.kingExplosions;
      atomic.issues.push(...issues);
      if ((g + 1) % 10 === 0) console.log(`  ...${g + 1}/${ATOMIC_GAMES} Atomic games played`);
    } catch (err) {
      atomic.issues.push({ kind: 'exception', game: g, error: err instanceof Error ? err.message : String(err) });
    }
  }
  allIssues.push(...atomic.issues.map((i) => ({ ...i, variant: 'atomic' })));

  // --- Duck Chess ---
  const duckStats = { games: 0, plies: 0, probes: 0, finished: 0, kingCaptures: 0, issues: [] };
  for (let g = 0; g < DUCK_GAMES; g++) {
    try {
      const { stats, issues } = await playDuckGame(g);
      duckStats.games++;
      duckStats.plies += stats.plies;
      duckStats.probes += stats.illegalProbes;
      if (stats.finished) duckStats.finished++;
      duckStats.kingCaptures += stats.kingCaptures;
      duckStats.issues.push(...issues);
      if ((g + 1) % 10 === 0) console.log(`  ...${g + 1}/${DUCK_GAMES} Duck Chess games played`);
    } catch (err) {
      duckStats.issues.push({ kind: 'exception', game: g, error: err instanceof Error ? err.message : String(err) });
    }
  }
  allIssues.push(...duckStats.issues.map((i) => ({ ...i, variant: 'duckChess' })));

  // --- 4 Player Chess ---
  const fourStats = { games: 0, plies: 0, probes: 0, finished: 0, natural: 0, rejoins: 0, takeovers: 0, resigns: 0, issues: [] };
  for (let g = 0; g < FOUR_GAMES; g++) {
    try {
      const { stats, issues } = await playFourPlayerGame(g);
      fourStats.games++;
      fourStats.plies += stats.plies;
      fourStats.probes += stats.illegalProbes;
      if (stats.finished) fourStats.finished++;
      if (stats.naturalEnd) fourStats.natural++;
      fourStats.rejoins += stats.rejoins;
      fourStats.takeovers += stats.takeovers;
      fourStats.resigns += stats.resigns;
      fourStats.issues.push(...issues);
      if ((g + 1) % 10 === 0) console.log(`  ...${g + 1}/${FOUR_GAMES} 4 Player Chess games played`);
    } catch (err) {
      fourStats.issues.push({ kind: 'exception', game: g, error: err instanceof Error ? err.message : String(err) });
    }
  }
  allIssues.push(...fourStats.issues.map((i) => ({ ...i, variant: 'fourPlayer' })));

  const expected = allIssues.filter((i) => i.kind === 'expected-blind-pawn-push-blocked-by-fog');
  const unexpected = allIssues.filter((i) => i.kind !== 'expected-blind-pawn-push-blocked-by-fog');

  console.log(`\nCompleted ${completedGames}/${GAMES} games, ${totalPlies} total plies.`);
  console.log(`Expected blind-push-into-fog rejections (not a bug — see script's own doc comment): ${expected.length}`);
  console.log(`Giveaway: ${giveaway.games}/${GIVEAWAY_GAMES} games, ${giveaway.plies} plies, ${giveaway.probes} illegal moves correctly refused, ${giveaway.finished} games ended by the stuck-wins rule.`);
  console.log(`Atomic: ${atomic.games}/${ATOMIC_GAMES} games, ${atomic.plies} plies, ${atomic.probes} illegal moves correctly refused, ${atomic.finished} games ended (${atomic.kingExplosions} by an exploded king).`);
  console.log(`Duck Chess: ${duckStats.games}/${DUCK_GAMES} games, ${duckStats.plies} turns, ${duckStats.probes} illegal turns correctly refused, ${duckStats.finished} games ended (${duckStats.kingCaptures} by a king capture).`);
  console.log(`4 Player Chess: ${fourStats.games}/${FOUR_GAMES} games, ${fourStats.plies} plies, ${fourStats.probes} illegal/out-of-turn moves correctly refused, ${fourStats.rejoins} disconnect/rejoin cycles (${fourStats.takeovers} bot takeovers observed), ${fourStats.resigns} resignations, ${fourStats.finished} games ended (${fourStats.natural} by the engine itself).`);
  console.log(`Unexpected issues: ${unexpected.length}`);

  const reportLines = [
    '# Nightly online fuzz report (Fog of War + Giveaway + Atomic + Duck Chess + 4 Player Chess)',
    '',
    `Run at: ${new Date().toISOString()}`,
    `Server: ${SERVER_URL}`,
    '',
    `- Games completed: ${completedGames}/${GAMES}`,
    `- Total plies: ${totalPlies}`,
    `- Expected blind-push-into-fog rejections: ${expected.length} (normal Fog of War Online behavior, not a failure)`,
    `- Giveaway: ${giveaway.games}/${GIVEAWAY_GAMES} games, ${giveaway.plies} plies, ${giveaway.probes} illegal moves correctly refused by the server, ${giveaway.finished} games ended by the stuck-wins rule`,
    `- Atomic: ${atomic.games}/${ATOMIC_GAMES} games, ${atomic.plies} plies, ${atomic.probes} illegal moves correctly refused by the server, ${atomic.finished} games ended (${atomic.kingExplosions} by an exploded king)`,
    `- Duck Chess: ${duckStats.games}/${DUCK_GAMES} games, ${duckStats.plies} turns, ${duckStats.probes} illegal turns correctly refused by the server, ${duckStats.finished} games ended (${duckStats.kingCaptures} by a king capture)`,
    `- 4 Player Chess: ${fourStats.games}/${FOUR_GAMES} games (four real sockets each), ${fourStats.plies} plies, ${fourStats.probes} illegal / out-of-turn moves correctly refused by the server, ${fourStats.rejoins} disconnect/rejoin cycles (${fourStats.takeovers} bot takeovers observed), ${fourStats.resigns} resignations, ${fourStats.finished} games ended (${fourStats.natural} by the engine itself); every seq checked for byte-identical snapshots across all four sockets`,
    `- Unexpected issues: ${unexpected.length}`,
    '',
  ];
  if (unexpected.length > 0) {
    reportLines.push('## Unexpected issues', '');
    for (const issue of unexpected.slice(0, 30)) {
      console.log(' ', JSON.stringify(issue));
      reportLines.push('```json', JSON.stringify(issue), '```', '');
    }
  }
  reportLines.push(unexpected.length === 0 ? '## Result: PASS' : '## Result: FAIL');
  writeFileSync('nightly-fuzz-online-report.md', reportLines.join('\n'));
  process.exit(unexpected.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error running nightly online fuzz:', err);
  writeFileSync('nightly-fuzz-online-report.md', `# Nightly online fuzz report\n\nFATAL: ${err instanceof Error ? err.stack : String(err)}\n\n## Result: FAIL\n`);
  process.exit(1);
});
