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
 *  - Atomic: same idea — every move comes from the mobile app's own atomic.ts and MUST be accepted; a fraction
 *    of turns first submit a pseudo-legal move that Atomic forbids (a king capture, a blast that would reach
 *    the mover's own king, ...) which the server MUST refuse; every game_over (king exploded, checkmate,
 *    stalemate, insufficient material, repetition) must agree with the mobile app's own judgement.
 *  - Giveaway: every move comes from the mobile app's own getGiveawayMoves and MUST be accepted; a
 *    fraction of turns ALSO first submit a deliberately illegal move (a non-capturing move while a
 *    capture is mandatory) and the server MUST reject it — the "server is the authority" check —
 *    and every game_over must agree with the mobile app's own winner detection.
 *
 * Usage:
 *   npm run dev                                (in one terminal, from backend/)
 *   npx tsx scripts/nightly-fuzz-online.mjs [fogGames] [maxPlies] [giveawayGames] [atomicGames]
 * (giveawayGames and atomicGames default to the same count as fogGames.) BACKEND_URL env var overrides the
 * default http://localhost:3000.
 */
import { writeFileSync } from 'node:fs';
import { io } from 'socket.io-client';
import { ChessEngine } from '../../src/logic/ChessEngine.ts';
import { getGiveawayMoves, getGiveawayWinner } from '../../src/logic/giveaway.ts';
import { getAtomicMoves, getAtomicWinner, isAtomicThreefoldRepetition } from '../../src/logic/atomic.ts';

const SERVER_URL = process.env.BACKEND_URL ?? 'http://localhost:3000';
const GAMES = Number(process.argv[2] ?? 100);
const MAX_PLIES = Number(process.argv[3] ?? 60);
const GIVEAWAY_GAMES = Number(process.argv[4] ?? GAMES);
const ATOMIC_GAMES = Number(process.argv[5] ?? GAMES);

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
      await emitAck(alice, 'join_queue', { timeControl, isChess960: false, isFogOfWar: true });
      return waitFor(alice, 'match_found');
    })(),
    (async () => {
      await new Promise((r) => setTimeout(r, 80));
      await emitAck(bob, 'join_queue', { timeControl, isChess960: false, isFogOfWar: true });
      return waitFor(bob, 'match_found');
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
      await emitAck(alice, 'join_queue', { timeControl, isGiveaway: true });
      return waitFor(alice, 'match_found');
    })(),
    (async () => {
      await new Promise((r) => setTimeout(r, 80));
      await emitAck(bob, 'join_queue', { timeControl, isGiveaway: true });
      return waitFor(bob, 'match_found');
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
      await emitAck(alice, 'join_queue', { timeControl, isAtomic: true });
      return waitFor(alice, 'match_found');
    })(),
    (async () => {
      await new Promise((r) => setTimeout(r, 80));
      await emitAck(bob, 'join_queue', { timeControl, isAtomic: true });
      return waitFor(bob, 'match_found');
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

async function main() {
  console.log(`Nightly online fuzz: ${GAMES} real Fog of War games + ${GIVEAWAY_GAMES} real Giveaway games + ${ATOMIC_GAMES} real Atomic games through ${SERVER_URL}, up to ${MAX_PLIES} plies each.\n`);
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

  const expected = allIssues.filter((i) => i.kind === 'expected-blind-pawn-push-blocked-by-fog');
  const unexpected = allIssues.filter((i) => i.kind !== 'expected-blind-pawn-push-blocked-by-fog');

  console.log(`\nCompleted ${completedGames}/${GAMES} games, ${totalPlies} total plies.`);
  console.log(`Expected blind-push-into-fog rejections (not a bug — see script's own doc comment): ${expected.length}`);
  console.log(`Giveaway: ${giveaway.games}/${GIVEAWAY_GAMES} games, ${giveaway.plies} plies, ${giveaway.probes} illegal moves correctly refused, ${giveaway.finished} games ended by the stuck-wins rule.`);
  console.log(`Atomic: ${atomic.games}/${ATOMIC_GAMES} games, ${atomic.plies} plies, ${atomic.probes} illegal moves correctly refused, ${atomic.finished} games ended (${atomic.kingExplosions} by an exploded king).`);
  console.log(`Unexpected issues: ${unexpected.length}`);

  const reportLines = [
    '# Nightly online fuzz report (Fog of War + Giveaway + Atomic)',
    '',
    `Run at: ${new Date().toISOString()}`,
    `Server: ${SERVER_URL}`,
    '',
    `- Games completed: ${completedGames}/${GAMES}`,
    `- Total plies: ${totalPlies}`,
    `- Expected blind-push-into-fog rejections: ${expected.length} (normal Fog of War Online behavior, not a failure)`,
    `- Giveaway: ${giveaway.games}/${GIVEAWAY_GAMES} games, ${giveaway.plies} plies, ${giveaway.probes} illegal moves correctly refused by the server, ${giveaway.finished} games ended by the stuck-wins rule`,
    `- Atomic: ${atomic.games}/${ATOMIC_GAMES} games, ${atomic.plies} plies, ${atomic.probes} illegal moves correctly refused by the server, ${atomic.finished} games ended (${atomic.kingExplosions} by an exploded king)`,
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
