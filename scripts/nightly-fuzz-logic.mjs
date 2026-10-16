#!/usr/bin/env node
/**
 * Extended, nightly-only fuzz test — thousands of randomized Fog of War games, checking every
 * pseudo-legal candidate at every ply against ground-truth invariants, for BOTH the mobile app's
 * src/logic/ChessEngine.ts and the backend's own src/game/RoomChessEngine.ts. This is the same
 * methodology as scripts/test-fogOfWarEnPassant.mjs and test-fogOfWarVisibilityGroundTruth.mjs,
 * just at a scale too slow to run on every commit (see ci.yml's own, much smaller fuzz counts) —
 * intended for the nightly schedule only (see .github/workflows/nightly.yml).
 *
 * Checks, per ply, across every randomized game:
 *   1. Every candidate getPseudoLegalMoves offers actually succeeds via movePseudoLegal on a
 *      FRESH engine built from the same fen — the exact "shown as available but rejected" bug
 *      class this session found for en passant (see test-fogOfWarEnPassant.mjs) and fixed.
 *   2. The move actually chosen to advance the game also succeeds (same class of check, applied
 *      to the "real" game engine instead of a throwaway probe).
 *   3. A piece's own pseudo-legal reach never includes a square outside the board, and the
 *      from-square always currently holds a piece of the color being queried (basic structural
 *      sanity — would catch a badly wrong board-index conversion).
 *
 * Usage: node scripts/nightly-fuzz-logic.mjs [gameCount] [maxPlies]
 * Writes a human-readable report to nightly-fuzz-report.md in the current working directory
 * (see .github/workflows/nightly.yml for how CI surfaces this on failure).
 */
import { writeFileSync } from 'node:fs';
import { ChessEngine } from '../../src/logic/ChessEngine.ts';
import { getGiveawayMoves as clientGiveawayMoves, getGiveawayWinner as clientGiveawayWinner } from '../../src/logic/giveaway.ts';
import { getAtomicMoves as clientAtomicMoves, getAtomicWinner as clientAtomicWinner } from '../../src/logic/atomic.ts';
import { RoomChessEngine, START_FEN } from '../src/game/RoomChessEngine.ts';
import { getGiveawayMoves as serverGiveawayMoves, getGiveawayWinner as serverGiveawayWinner } from '../src/game/giveaway.ts';
import { generateAtomicMoves, getAtomicKingWinner, squareName } from '../src/game/atomic.ts';
import { getLegalDuckPlacementSquares as clientDuckSquares, hasNoDuckMoves as clientDuckBlockade } from '../../src/logic/duckChess.ts';
import { emptySquares, hasNoDuckMoves as serverDuckBlockade } from '../src/game/duckChess.ts';
import { HORDE_START_FEN, getHordeMoves as clientHordeMoves } from '../../src/logic/horde.ts';
import { getCrazyhouseMoves as clientCrazyhouseMoves, initialCrazyhouseState, RESERVE_PIECE_TYPES } from '../../src/logic/crazyhouse.ts';

const GAMES = Number(process.argv[2] ?? 3000);
const MAX_PLIES = Number(process.argv[3] ?? 80);

function randInt(n) {
  return Math.floor(Math.random() * n);
}

function fuzzEngine(label, EngineClass) {
  let totalChecked = 0;
  let totalGames = 0;
  let totalPlies = 0;
  const mismatches = [];

  for (let g = 0; g < GAMES; g++) {
    totalGames++;
    let engine = new EngineClass(undefined, { skipValidation: true });
    for (let ply = 0; ply < MAX_PLIES; ply++) {
      const turn = engine.getTurn();
      const pseudo = engine.getPseudoLegalMoves(turn);
      if (pseudo.length === 0) break;
      totalPlies++;

      const curFen = engine.getFen();
      for (const cand of pseudo) {
        totalChecked++;
        // Structural sanity: every candidate's squares are real board squares.
        const validSquare = /^[a-h][1-8]$/;
        if (!validSquare.test(cand.from) || !validSquare.test(cand.to)) {
          mismatches.push({ kind: 'invalid-square', game: g, ply, fen: curFen, cand });
          continue;
        }
        const probe = new EngineClass(curFen, { skipValidation: true });
        const result = probe.movePseudoLegal(cand.from, cand.to, cand.promotion ?? 'q');
        if (!result) {
          mismatches.push({ kind: 'shown-but-rejected', game: g, ply, fen: curFen, cand });
        }
      }

      const pick = pseudo[randInt(pseudo.length)];
      const moveEngine = new EngineClass(curFen, { skipValidation: true });
      const applied = moveEngine.movePseudoLegal(pick.from, pick.to, pick.promotion ?? 'q');
      if (!applied) {
        mismatches.push({ kind: 'chosen-move-failed', game: g, ply, fen: curFen, pick });
        break;
      }
      engine = moveEngine;
      if (applied.captured === 'k') break;
    }
  }

  return { label, totalGames, totalPlies, totalChecked, mismatches };
}

/**
 * Giveaway PARITY: every random game is replayed through BOTH implementations (the mobile app's
 * giveaway.ts + ChessEngine, and the server's giveaway.ts + RoomChessEngine — the server keeps ONE live
 * engine for the whole game, the mobile app rebuilds from the FEN every ply, exactly as in production)
 * and they must agree at every ply on the legal move set, the applied move's SAN/capture/promotion, the
 * resulting FEN and the winner. A disagreement is a client/server desync waiting to happen online.
 */
function fuzzGiveawayParity() {
  const uci = (moves) => moves.map((m) => `${m.from}${m.to}${m.promotion ?? ''}`).sort().join();
  const mismatches = [];
  let totalPlies = 0;
  let totalChecked = 0;
  let totalGames = 0;
  for (let g = 0; g < GAMES; g++) {
    totalGames++;
    const server = new RoomChessEngine(START_FEN, { giveaway: true });
    let clientFen = START_FEN;
    for (let ply = 0; ply < MAX_PLIES * 3; ply++) {
      const client = new ChessEngine(clientFen, { skipValidation: true, giveaway: true });
      const serverMoves = serverGiveawayMoves(server);
      totalChecked++;
      if (uci(serverMoves) !== uci(clientGiveawayMoves(client))) {
        mismatches.push({ kind: 'giveaway-legal-moves-differ', game: g, ply, fen: server.getFen() });
        break;
      }
      const winner = serverGiveawayWinner(server);
      if (winner !== clientGiveawayWinner(client)) {
        mismatches.push({ kind: 'giveaway-winner-differs', game: g, ply, fen: server.getFen() });
        break;
      }
      if (winner) break;
      const pick = serverMoves[randInt(serverMoves.length)];
      let a;
      let b;
      try {
        a = server.movePseudoLegal(pick.from, pick.to, pick.promotion);
        b = client.movePseudoLegal(pick.from, pick.to, pick.promotion);
      } catch (err) {
        mismatches.push({ kind: 'giveaway-apply-threw', game: g, ply, fen: clientFen, pick, error: String(err) });
        break;
      }
      if (!a || !b || a.san !== b.san || a.captured !== b.captured || a.promotion !== b.promotion || server.getFen() !== client.getFen()) {
        mismatches.push({ kind: 'giveaway-applied-move-differs', game: g, ply, fen: clientFen, pick, server: a, client: b, serverFen: server.getFen(), clientResultFen: client.getFen() });
        break;
      }
      clientFen = client.getFen();
      totalPlies++;
    }
  }
  return { label: 'Giveaway parity (mobile app vs server)', totalGames, totalPlies, totalChecked, mismatches };
}

/**
 * Atomic PARITY: random capture-biased games replayed through BOTH implementations (mobile ChessEngine +
 * atomic.ts, server RoomChessEngine + its verbatim copy of atomic.ts) — legal moves, status, game-over,
 * king-explosion winner, the applied move's SAN/capture and the resulting FEN must agree at every ply.
 */
function fuzzAtomicParity() {
  const uci = (moves) => moves.map((m) => `${m.from}${m.to}${m.promotion ?? ''}`).sort().join();
  const mismatches = [];
  let totalPlies = 0;
  let totalChecked = 0;
  let totalGames = 0;
  for (let g = 0; g < GAMES; g++) {
    totalGames++;
    const server = new RoomChessEngine(START_FEN, { atomic: true });
    let clientFen = START_FEN;
    for (let ply = 0; ply < MAX_PLIES * 3; ply++) {
      const client = new ChessEngine(clientFen, { atomic: true });
      const serverLegal = generateAtomicMoves(server.getAtomicPosition()).map((m) => ({ from: squareName(m.from), to: squareName(m.to), promotion: m.promotion, ep: m.enPassant }));
      totalChecked++;
      if (uci(serverLegal) !== uci(clientAtomicMoves(client))) {
        mismatches.push({ kind: 'atomic-legal-moves-differ', game: g, ply, fen: server.getFen() });
        break;
      }
      if (server.getStatus() !== client.getStatus() || server.isGameOver() !== client.isGameOver() || getAtomicKingWinner(server.getAtomicPosition()) !== clientAtomicWinner(client)) {
        mismatches.push({ kind: 'atomic-status-differs', game: g, ply, fen: server.getFen(), server: server.getStatus(), client: client.getStatus() });
        break;
      }
      if (server.isGameOver()) break;
      const captures = serverLegal.filter((m) => client.getPieceAt(m.to) || m.ep);
      const pool = captures.length > 0 && Math.random() < 0.6 ? captures : serverLegal;
      const pick = pool[randInt(pool.length)];
      let a;
      let b;
      try {
        a = server.move(pick.from, pick.to, pick.promotion ?? 'q');
        b = client.move(pick.from, pick.to, pick.promotion ?? 'q');
      } catch (err) {
        mismatches.push({ kind: 'atomic-apply-threw', game: g, ply, fen: clientFen, pick, error: String(err) });
        break;
      }
      if (!a || !b || a.san !== b.san || a.captured !== b.captured || server.getFen() !== client.getFen()) {
        mismatches.push({ kind: 'atomic-applied-move-differs', game: g, ply, fen: clientFen, pick, server: a, client: b });
        break;
      }
      clientFen = client.getFen();
      totalPlies++;
    }
  }
  return { label: 'Atomic parity (mobile app vs server)', totalGames, totalPlies, totalChecked, mismatches };
}

/**
 * Duck Chess PARITY: random games (a regular move, then a random legal duck square, as one turn) replayed through
 * BOTH implementations — the legal move set, the legal duck squares, the blockade verdict, the applied move's
 * SAN/capture and the resulting FEN must agree at every ply. The server keeps ONE live engine and moves its duck
 * with setDuckSquare; the mobile app builds a fresh engine from { fen, duckSquare } every ply, as in production.
 */
function fuzzDuckParity() {
  const uci = (moves) => moves.map((m) => `${m.from}${m.to}${m.promotion ?? ''}`).sort().join();
  const mismatches = [];
  let totalPlies = 0;
  let totalChecked = 0;
  let totalGames = 0;
  for (let g = 0; g < GAMES; g++) {
    totalGames++;
    const server = new RoomChessEngine(START_FEN, { duckChess: true, duckSquare: null });
    let duck = null;
    let clientFen = START_FEN;
    for (let ply = 0; ply < MAX_PLIES * 3; ply++) {
      const client = new ChessEngine(clientFen, { skipValidation: true, duckChess: true, duckSquare: duck });
      const serverMoves = server.getPseudoLegalMoves(server.getTurn());
      totalChecked++;
      if (uci(serverMoves) !== uci(client.getPseudoLegalMoves(client.getTurn()))) {
        mismatches.push({ kind: 'duck-legal-moves-differ', game: g, ply, duck, fen: server.getFen() });
        break;
      }
      if (serverDuckBlockade(server) !== clientDuckBlockade(client)) {
        mismatches.push({ kind: 'duck-blockade-differs', game: g, ply, duck, fen: server.getFen() });
        break;
      }
      if (serverMoves.length === 0) break;
      const pick = serverMoves[randInt(serverMoves.length)];
      let a;
      let b;
      try {
        a = server.movePseudoLegal(pick.from, pick.to, pick.promotion);
        b = client.movePseudoLegal(pick.from, pick.to, pick.promotion);
      } catch (err) {
        mismatches.push({ kind: 'duck-apply-threw', game: g, ply, fen: clientFen, pick, error: String(err) });
        break;
      }
      if (!a || !b || a.san !== b.san || a.captured !== b.captured || server.getFen() !== client.getFen()) {
        mismatches.push({ kind: 'duck-applied-move-differs', game: g, ply, fen: clientFen, pick, server: a, client: b });
        break;
      }
      totalPlies++;
      if (a.captured === 'k') break;
      const serverSquares = emptySquares(server.getFen()).filter((sq) => sq !== duck).sort();
      const clientSquares = [...clientDuckSquares(client, duck)].sort();
      if (serverSquares.join() !== clientSquares.join()) {
        mismatches.push({ kind: 'duck-placement-squares-differ', game: g, ply, duck, fen: server.getFen() });
        break;
      }
      duck = serverSquares[randInt(serverSquares.length)];
      server.setDuckSquare(duck);
      clientFen = client.getFen();
    }
  }
  return { label: 'Duck Chess parity (mobile app vs server)', totalGames, totalPlies, totalChecked, mismatches };
}

/**
 * Horde PARITY: random games from the 36-pawn start through BOTH implementations. At every ply every move the mobile
 * engine offers (getHordeMoves — including the rank-1 double step chess.js cannot generate) must be accepted by the server
 * engine with the same resulting FEN, a sample of moves the mobile engine does NOT offer must be refused by the server, and
 * both must agree on the game-over verdict and status. Horde games are long (36 pawns), and every ply costs a fresh engine per
 * candidate, so this section plays at most 400 games however many the other sections play.
 */
function fuzzHordeParity() {
  const mismatches = [];
  let totalPlies = 0;
  let totalChecked = 0;
  let totalGames = 0;
  const squares = [];
  for (const f of 'abcdefgh') for (let r = 1; r <= 8; r++) squares.push(`${f}${r}`);
  const gameCount = Math.min(GAMES, 400);
  for (let g = 0; g < gameCount; g++) {
    totalGames++;
    let fen = HORDE_START_FEN;
    for (let ply = 0; ply < MAX_PLIES * 2; ply++) {
      const client = new ChessEngine(fen, { horde: true });
      const server = new RoomChessEngine(fen, { horde: true });
      if (server.isGameOver() !== client.isGameOver() || server.getStatus() !== client.getStatus()) {
        mismatches.push({ kind: 'horde-verdict-differs', game: g, ply, fen, server: [server.getStatus(), server.isGameOver()], client: [client.getStatus(), client.isGameOver()] });
        break;
      }
      if (client.isGameOver()) break;
      const candidates = clientHordeMoves(client);
      if (candidates.length === 0) break;
      let broken = false;
      for (const m of candidates) {
        totalChecked++;
        const s = new RoomChessEngine(fen, { horde: true });
        const c = new ChessEngine(fen, { horde: true });
        let a;
        let b;
        try {
          a = s.move(m.from, m.to, m.promotion);
          b = c.move(m.from, m.to, m.promotion);
        } catch (err) {
          mismatches.push({ kind: 'horde-apply-threw', game: g, ply, fen, move: m, error: String(err) });
          broken = true;
          break;
        }
        if (!a || !b || a.san !== b.san || s.getFen() !== c.getFen()) {
          mismatches.push({ kind: 'horde-move-differs', game: g, ply, fen, move: m, server: a, client: b });
          broken = true;
          break;
        }
      }
      if (broken) break;
      const offered = new Set(candidates.map((m) => `${m.from}${m.to}`));
      for (let probe = 0; probe < 20; probe++) {
        const from = squares[randInt(64)];
        const to = squares[randInt(64)];
        if (from === to || offered.has(`${from}${to}`)) continue;
        totalChecked++;
        if (new RoomChessEngine(fen, { horde: true }).move(from, to, 'q')) {
          mismatches.push({ kind: 'horde-server-accepts-illegal-move', game: g, ply, fen, move: { from, to } });
          broken = true;
          break;
        }
      }
      if (broken) break;
      const pick = candidates[randInt(candidates.length)];
      const next = new ChessEngine(fen, { horde: true });
      next.move(pick.from, pick.to, pick.promotion);
      fen = next.getFen();
      totalPlies++;
    }
  }
  return { label: 'Horde parity (mobile app vs server)', totalGames, totalPlies, totalChecked, mismatches };
}

/**
 * Crazyhouse PARITY: random games through BOTH implementations, carrying the reserves/promoted squares ply to ply. At every ply
 * every turn the mobile engine offers (ordinary moves incl. promotions, and every legal drop) must be accepted by the server
 * engine with the same SAN, FEN and CrazyhouseState; sampled moves AND drops the mobile engine does not offer must be refused by
 * the server; and both must agree on the verdict. The walk is biased toward drops, captures and promotions so reserves fill up
 * and promoted pieces get captured. Every ply costs a fresh engine per candidate (up to ~100 with drops), so this section plays
 * at most 100 games however many the other sections play.
 */
function fuzzCrazyhouseParity() {
  const mismatches = [];
  let totalPlies = 0;
  let totalChecked = 0;
  let totalGames = 0;
  const squares = [];
  for (const f of 'abcdefgh') for (let r = 1; r <= 8; r++) squares.push(`${f}${r}`);
  const gameCount = Math.min(GAMES, 100);
  for (let g = 0; g < gameCount; g++) {
    totalGames++;
    let fen = START_FEN;
    let state = initialCrazyhouseState();
    for (let ply = 0; ply < MAX_PLIES * 2; ply++) {
      const client = new ChessEngine(fen, { crazyhouse: true, crazyhouseState: state });
      const server = new RoomChessEngine(fen, { crazyhouse: true, crazyhouseState: state });
      if (server.isGameOver() !== client.isGameOver() || server.getStatus() !== client.getStatus()) {
        mismatches.push({ kind: 'crazyhouse-verdict-differs', game: g, ply, fen, server: [server.getStatus(), server.isGameOver()], client: [client.getStatus(), client.isGameOver()] });
        break;
      }
      if (client.isGameOver()) break;
      const moves = clientCrazyhouseMoves(client);
      const drops = client.getLegalDrops();
      const sample = [...moves, ...drops.map((d) => ({ drop: d.piece, from: d.square, to: d.square }))];
      if (sample.length === 0) break;
      let broken = false;
      for (const m of sample) {
        totalChecked++;
        const s = new RoomChessEngine(fen, { crazyhouse: true, crazyhouseState: state });
        const c = new ChessEngine(fen, { crazyhouse: true, crazyhouseState: state });
        let a;
        let b;
        try {
          a = m.drop ? s.drop(m.drop, m.to) : s.move(m.from, m.to, m.promotion);
          b = m.drop ? c.drop(m.drop, m.to) : c.move(m.from, m.to, m.promotion);
        } catch (err) {
          mismatches.push({ kind: 'crazyhouse-apply-threw', game: g, ply, fen, move: m, error: String(err) });
          broken = true;
          break;
        }
        if (!a || !b || a.san !== b.san || s.getFen() !== c.getFen() || JSON.stringify(s.getCrazyhouseState()) !== JSON.stringify(c.getCrazyhouseState())) {
          mismatches.push({ kind: 'crazyhouse-turn-differs', game: g, ply, fen, move: m, server: a, client: b });
          broken = true;
          break;
        }
      }
      if (broken) break;
      const offeredMoves = new Set(moves.map((m) => `${m.from}${m.to}`));
      const offeredDrops = new Set(drops.map((d) => `${d.piece}${d.square}`));
      for (let probe = 0; probe < 20; probe++) {
        const from = squares[randInt(64)];
        const to = squares[randInt(64)];
        if (from !== to && !offeredMoves.has(`${from}${to}`)) {
          totalChecked++;
          if (new RoomChessEngine(fen, { crazyhouse: true, crazyhouseState: state }).move(from, to, 'q')) {
            mismatches.push({ kind: 'crazyhouse-server-accepts-illegal-move', game: g, ply, fen, move: { from, to } });
            broken = true;
            break;
          }
        }
        const piece = RESERVE_PIECE_TYPES[randInt(5)];
        if (!offeredDrops.has(`${piece}${to}`)) {
          totalChecked++;
          if (new RoomChessEngine(fen, { crazyhouse: true, crazyhouseState: state }).drop(piece, to)) {
            mismatches.push({ kind: 'crazyhouse-server-accepts-illegal-drop', game: g, ply, fen, drop: { piece, square: to } });
            broken = true;
            break;
          }
        }
      }
      if (broken) break;
      const capturing = moves.filter((m) => m.captured || m.promotion === 'q');
      let pick;
      if (drops.length > 0 && Math.random() < 0.45) {
        const d = drops[randInt(drops.length)];
        pick = { drop: d.piece, from: d.square, to: d.square };
      } else if (capturing.length > 0 && Math.random() < 0.6) {
        pick = capturing[randInt(capturing.length)];
      } else {
        const plain = moves.filter((m) => !m.promotion || m.promotion === 'q');
        pick = plain.length > 0 ? plain[randInt(plain.length)] : sample[randInt(sample.length)];
      }
      if (pick.drop) client.drop(pick.drop, pick.to);
      else client.move(pick.from, pick.to, pick.promotion);
      fen = client.getFen();
      state = client.getCrazyhouseState();
      totalPlies++;
    }
  }
  return { label: 'Crazyhouse parity (mobile app vs server)', totalGames, totalPlies, totalChecked, mismatches };
}

console.log(`Nightly fuzz: ${GAMES} games x up to ${MAX_PLIES} plies, two engine implementations (Fog of War) + Giveaway, Atomic, Duck Chess, Horde and Crazyhouse parity.\n`);

const results = [
  fuzzEngine('Mobile app (src/logic/ChessEngine.ts)', ChessEngine),
  fuzzEngine('Server (backend/src/game/RoomChessEngine.ts)', RoomChessEngine),
  fuzzGiveawayParity(),
  fuzzAtomicParity(),
  fuzzDuckParity(),
  fuzzHordeParity(),
  fuzzCrazyhouseParity(),
];

let reportLines = [`# Nightly logic fuzz report (Fog of War + Giveaway + Atomic + Duck Chess + Horde + Crazyhouse parity)`, '', `Run at: ${new Date().toISOString()}`, ''];
let anyFailure = false;

for (const r of results) {
  console.log(`=== ${r.label} ===`);
  console.log(`  Games: ${r.totalGames}, plies: ${r.totalPlies}, candidates checked: ${r.totalChecked}`);
  console.log(`  Mismatches: ${r.mismatches.length}`);
  reportLines.push(`## ${r.label}`, '', `- Games: ${r.totalGames}`, `- Plies: ${r.totalPlies}`, `- Candidates checked: ${r.totalChecked}`, `- Mismatches: ${r.mismatches.length}`, '');
  if (r.mismatches.length > 0) {
    anyFailure = true;
    console.log('  Examples:');
    reportLines.push('### Examples', '');
    for (const m of r.mismatches.slice(0, 20)) {
      console.log('   ', JSON.stringify(m));
      reportLines.push('```json', JSON.stringify(m), '```', '');
    }
  }
  console.log('');
}

reportLines.push(anyFailure ? '## Result: FAIL' : '## Result: PASS');
writeFileSync('nightly-fuzz-report.md', reportLines.join('\n'));
console.log(anyFailure ? 'FAIL: mismatches found — see nightly-fuzz-report.md' : 'PASS: no mismatches found.');
process.exit(anyFailure ? 1 : 0);
