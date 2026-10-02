#!/usr/bin/env node
/**
 * Extended, nightly-only fuzz test for the REAL server/socket Fog of War path — plays many
 * randomized games end-to-end through the actual running server (not a pure-logic simulation;
 * see nightly-fuzz-logic.mjs for that), two socket.io-client "players" submitting pseudo-legal
 * moves computed from their OWN locally-tracked (server-confirmed) fen. Catches anything the pure
 * logic fuzz can't: a move the client computed as pseudo-legal being rejected by the server (a
 * client/server desync), an unexpected disconnect, or the server throwing mid-game.
 *
 * Usage:
 *   npm run dev                                (in one terminal, from backend/)
 *   node scripts/nightly-fuzz-online.mjs [gameCount] [maxPlies]
 * BACKEND_URL env var overrides the default http://localhost:3000.
 */
import { writeFileSync } from 'node:fs';
import { io } from 'socket.io-client';
import { ChessEngine } from '../../src/logic/ChessEngine.ts';

const SERVER_URL = process.env.BACKEND_URL ?? 'http://localhost:3000';
const GAMES = Number(process.argv[2] ?? 100);
const MAX_PLIES = Number(process.argv[3] ?? 60);

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

async function main() {
  console.log(`Nightly online fuzz: ${GAMES} real Fog of War games through ${SERVER_URL}, up to ${MAX_PLIES} plies each.\n`);
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

  const expected = allIssues.filter((i) => i.kind === 'expected-blind-pawn-push-blocked-by-fog');
  const unexpected = allIssues.filter((i) => i.kind !== 'expected-blind-pawn-push-blocked-by-fog');

  console.log(`\nCompleted ${completedGames}/${GAMES} games, ${totalPlies} total plies.`);
  console.log(`Expected blind-push-into-fog rejections (not a bug — see script's own doc comment): ${expected.length}`);
  console.log(`Unexpected issues: ${unexpected.length}`);

  const reportLines = [
    '# Nightly online Fog of War fuzz report',
    '',
    `Run at: ${new Date().toISOString()}`,
    `Server: ${SERVER_URL}`,
    '',
    `- Games completed: ${completedGames}/${GAMES}`,
    `- Total plies: ${totalPlies}`,
    `- Expected blind-push-into-fog rejections: ${expected.length} (normal Fog of War Online behavior, not a failure)`,
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
  writeFileSync('nightly-fuzz-online-report.md', `# Nightly online Fog of War fuzz report\n\nFATAL: ${err instanceof Error ? err.stack : String(err)}\n\n## Result: FAIL\n`);
  process.exit(1);
});
