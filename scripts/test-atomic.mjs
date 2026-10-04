#!/usr/bin/env node
/**
 * Atomic chess server-side regression suite — no running server needed. Run with tsx:
 *   npx tsx scripts/test-atomic.mjs      (or: npm run test:atomic)
 *
 * Layers, mirroring Giveaway / Fog of War:
 *  1. NO DRIFT: the rules block of backend/src/game/atomic.ts must be byte-identical to the mobile app's
 *     src/logic/atomic.ts (the two are hand-mirrored — there is no shared module — so this is what stops
 *     them ever disagreeing about a rule).
 *  2. THE AUTHORITY: RoomManager.applyMove (driven with a stub socket server, no network) rejects any move
 *     outside Atomic's legal set — a king capture, a capture that would explode the mover's own king, a
 *     forged king promotion — accepts the legal ones, and ends the game with the right reason: 'atomic' for
 *     an exploded king, 'checkmate'/'stalemate'/'draw' otherwise (insufficient material, 50-move,
 *     threefold repetition from the room's FEN history).
 *  3. PARITY with the mobile app: random capture-biased Atomic games are replayed through BOTH engines
 *     (mobile ChessEngine + atomic.ts, server RoomChessEngine + atomic.ts) and every ply must agree on the
 *     legal move set, the applied move's SAN/capture, the resulting FEN, the status and the winner.
 *
 * The rules themselves are verified against chessops (perft, random play, SAN) by the mobile app's own
 * suite (src/logic/__tests__/atomicOracle.test.ts); this file is about the SERVER's use of them.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ChessEngine as ClientEngine } from '../../src/logic/ChessEngine.ts';
import { getAtomicMoves as clientMoves, getAtomicWinner as clientWinner } from '../../src/logic/atomic.ts';
import { RoomChessEngine, START_FEN } from '../src/game/RoomChessEngine.ts';
import { generateAtomicMoves, getAtomicKingWinner, squareName } from '../src/game/atomic.ts';
import { buildPgn } from '../src/game/pgn.ts';
import { RoomManager } from '../src/game/rooms.ts';

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ✓ ${message}`);
}

const atomicEngine = (fen) => new RoomChessEngine(fen, { atomic: true });
const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);

function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- 1. No drift ---------------------------------------------------------------------------------
console.log('\n=== 1. The server rules are a verbatim copy of the mobile rules ===');
{
  const START = '// --- Representation';
  const END = '// --- Engine-facing helper';
  const core = (path) => {
    const text = readFileSync(path, 'utf8').split(CRLF).join(LF);
    return text.slice(text.indexOf(START), text.indexOf(END));
  };
  const mobile = core(new URL('../../src/logic/atomic.ts', import.meta.url));
  const server = core(new URL('../src/game/atomic.ts', import.meta.url));
  check(mobile.length > 10000, 'the shared rules block was found in both files');
  check(mobile === server, 'backend/src/game/atomic.ts and src/logic/atomic.ts have identical rules (edit BOTH together)');
}

// --- 2. The authority: RoomManager.applyMove -----------------------------------------------------
console.log('\n=== 2. RoomManager validates Atomic moves ===');
function stubIo() {
  const events = [];
  return { events, to: (id) => ({ emit: (event, payload) => events.push({ id, event, payload }) }) };
}
function atomicRoom(initialFen, overrides = {}) {
  const io = stubIo();
  const manager = new RoomManager(io);
  const created = manager.createRoom({
    white: { socketId: 'W', userId: null },
    black: { socketId: 'B', userId: null },
    timeControl: { initialSeconds: 0, incrementSeconds: 0 },
    chess960: false,
    kingOfTheHill: false,
    threeCheck: false,
    setupChess: false,
    fogOfWar: false,
    giveaway: false,
    atomic: true,
    initialFen,
    ...overrides,
  });
  const move = (who, from, to, promotion) => manager.applyMove(who, { roomId: created.roomId, from, to, promotion });
  const gameOvers = () => io.events.filter((e) => e.event === 'game_over');
  return { io, manager, roomId: created.roomId, move, gameOvers };
}
{
  // Rxd5 explodes the black knight on c6 but not the pawn on e6; Black's c8-bishop is not adjacent.
  const { move, io } = atomicRoom('2b1k3/8/2n1p3/3p4/3R4/8/8/4K3 w - - 0 1');
  const ack = move('W', 'd4', 'd5');
  check(ack.ok === true && ack.san === 'Rxd5', 'a capture is accepted and written in SAN');
  check(ack.fen.split(' ')[0] === '2b1k3/8/4p3/8/8/8/8/4K3', 'the explosion removed the rook, the pawn and the neighbouring knight but spared the neighbouring pawn');
  check(io.events.some((e) => e.id === 'B' && e.event === 'opponent_move' && e.payload.fen === ack.fen), 'the new position is relayed to the opponent');
}
{
  const { move } = atomicRoom('4k3/8/8/8/8/8/3pr3/3QK3 w - - 0 1');
  check(move('W', 'e1', 'e2').ok === false, 'a king can never capture (it would explode itself)');
  check(move('W', 'd1', 'd2').ok === false, 'a capture whose blast reaches the mover\'s OWN king is rejected');
  check(move('W', 'd1', 'e2').ok === false, '...and so is the other one');
}
{
  const { move, gameOvers } = atomicRoom('4k3/3p4/8/8/8/8/8/3QK3 w - - 0 1');
  const ack = move('W', 'd1', 'd7');
  check(ack.ok === true && ack.san === 'Qxd7#', 'exploding the enemy king is a legal move, written Qxd7#');
  const over = gameOvers();
  check(over.length === 2 && over.every((e) => e.payload.reason === 'atomic' && e.payload.winner === 'w'), 'both players get game_over {reason: "atomic", winner: white}');
}
{
  // The mover's own king is in check from the e8 rook, but Qxg7 blows up the black king: legal, and it wins.
  const { move, gameOvers } = atomicRoom('4r2k/6p1/8/8/3Q4/8/8/4K3 w - - 0 1');
  check(move('W', 'd4', 'g7').ok === true, 'a king explosion wins even while the mover is in check');
  check(gameOvers().every((e) => e.payload.reason === 'atomic'), '...with reason atomic');
}
{
  const { move, gameOvers } = atomicRoom('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1');
  check(move('W', 'a1', 'a8').ok === true, 'a back-rank mating move is accepted');
  const over = gameOvers();
  check(over.length === 2 && over.every((e) => e.payload.reason === 'checkmate' && e.payload.winner === 'w'), 'ordinary mate keeps the reason "checkmate"');
}
{
  const { move, gameOvers } = atomicRoom('k7/p7/P7/8/8/8/8/1R5K w - - 0 1');
  // Black is already stalemated if white passes; make a quiet waiting move that keeps it.
  check(move('W', 'h1', 'h2').ok === true, 'a quiet move is accepted');
  const over = gameOvers();
  check(over.length === 2 && over.every((e) => e.payload.reason === 'stalemate' && e.payload.winner === null), 'no legal move and not in check is stalemate (a draw)');
}
{
  const { move, gameOvers } = atomicRoom('4k3/8/8/8/8/8/p7/R3K3 w - - 0 1');
  check(move('W', 'a1', 'a2').ok === true, 'a capture that leaves only the kings is accepted');
  const over = gameOvers();
  check(over.length === 2 && over.every((e) => e.payload.reason === 'draw' && e.payload.winner === null), 'bare kings are an insufficient-material draw');
}
{
  const { move, gameOvers } = atomicRoom('4k3/8/8/8/8/8/4P3/R3K3 w - - 99 80');
  check(move('W', 'a1', 'a2').ok === true, 'a quiet move on halfmove clock 99 is accepted');
  check(gameOvers().every((e) => e.payload.reason === 'draw') && gameOvers().length === 2, 'the 50-move rule ends the game as a draw');
}
{
  const { move, gameOvers } = atomicRoom(undefined);
  const shuffle = [
    ['W', 'g1', 'f3'],
    ['B', 'g8', 'f6'],
    ['W', 'f3', 'g1'],
    ['B', 'f6', 'g8'],
  ];
  let ok = true;
  for (let i = 0; i < 7; i++) ok = ok && move(...shuffle[i % 4]).ok;
  check(ok && gameOvers().length === 0, 'seven plies of shuffling do not end the game');
  check(move(...shuffle[3]).ok === true, 'the eighth ply is accepted');
  const over = gameOvers();
  check(over.length === 2 && over.every((e) => e.payload.reason === 'draw' && e.payload.winner === null), 'the third occurrence of the starting position is a threefold-repetition draw (from the room\'s FEN history)');
}
{
  const { move } = atomicRoom('8/4P3/8/8/8/8/8/k6K w - - 0 1');
  check(move('W', 'e7', 'e8', 'k').ok === false, 'a forged king promotion is refused in Atomic');
  check(move('W', 'e7', 'e8').ok === false, '...and a promotion with no piece named is refused too');
  check(move('W', 'e7', 'e8', 'q').ok === true, 'a queen promotion is fine');
}
{
  // Castling next to the enemy king, and a rook exploded (not captured) loses its right.
  const { move } = atomicRoom('6r1/8/8/8/8/8/5k2/4K2R w K - 0 1');
  check(move('W', 'e1', 'g1').ok === true, 'castling is legal here: g1 is attacked, but it touches the enemy king');
  const far = atomicRoom('6r1/8/8/8/8/8/k7/4K2R w K - 0 1');
  check(far.move('W', 'e1', 'g1').ok === false, '...and illegal when the enemy king is far away');
  const blown = atomicRoom('4k3/8/8/8/8/8/6p1/4KB1R w K - 0 1');
  const ack = blown.move('W', 'f1', 'g2');
  check(ack.ok === true && ack.fen.split(' ')[2] === '-', 'a rook blown up next door loses its castling right');
}
{
  check(buildPgn(START_FEN, [{ from: 'e2', to: 'e4', san: 'e4' }], '1-0', 'Atomic').includes('[Variant "Atomic"]'), 'saved games are tagged [Variant "Atomic"]');
}

// --- 3. Parity with the mobile app ----------------------------------------------------------------
console.log('\n=== 3. Parity with the mobile implementation (random capture-biased games) ===');
{
  const problems = [];
  const seen = { games: 0, plies: 0, captures: 0, explosions: 0, finished: 0, kingWins: 0 };
  const uci = (moves) => moves.map((m) => `${m.from}${m.to}${m.promotion ?? ''}`).sort().join();
  for (let g = 0; g < 100 && problems.length < 5; g++) {
    const random = seeded(9000 + g);
    const server = atomicEngine(START_FEN);
    let clientFen = START_FEN;
    seen.games++;
    for (let ply = 0; ply < 200; ply++) {
      const client = new ClientEngine(clientFen, { atomic: true });
      const serverLegal = generateAtomicMoves(server.getAtomicPosition()).map((m) => ({ from: squareName(m.from), to: squareName(m.to), promotion: m.promotion, castle: m.castle, ep: m.enPassant }));
      const clientLegal = clientMoves(client);
      if (uci(serverLegal) !== uci(clientLegal)) {
        problems.push(`game ${g} ply ${ply}: legal moves differ in ${server.getFen()}`);
        break;
      }
      if (server.getStatus() !== client.getStatus() || server.isGameOver() !== client.isGameOver()) {
        problems.push(`game ${g} ply ${ply}: status ${server.getStatus()} vs ${client.getStatus()} in ${server.getFen()}`);
        break;
      }
      const serverWinner = getAtomicKingWinner(server.getAtomicPosition());
      if (serverWinner !== clientWinner(client)) {
        problems.push(`game ${g} ply ${ply}: king winner differs in ${server.getFen()}`);
        break;
      }
      if (server.isGameOver()) {
        seen.finished++;
        if (serverWinner) seen.kingWins++;
        break;
      }
      const captures = serverLegal.filter((m) => client.getPieceAt(m.to) || m.ep);
      const pool = captures.length > 0 && random() < 0.6 ? captures : serverLegal;
      const pick = pool[Math.floor(random() * pool.length)];
      const a = server.move(pick.from, pick.to, pick.promotion ?? 'q');
      const b = client.move(pick.from, pick.to, pick.promotion ?? 'q');
      if (!a || !b || a.san !== b.san || a.captured !== b.captured || server.getFen() !== client.getFen()) {
        problems.push(`game ${g} ply ${ply}: applied move differs ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
        break;
      }
      clientFen = client.getFen();
      seen.plies++;
      if (a.captured) seen.captures++;
      if (b.exploded && b.exploded.length > 2) seen.explosions++;
    }
  }
  check(problems.length === 0, `server and mobile agree on every ply of ${seen.plies} plies / ${seen.games} games${problems.length ? ` — ${problems.slice(0, 3).join(' | ')}` : ''}`);
  check(seen.captures > 400, `the random games really exercised captures (${seen.captures})`);
  check(seen.explosions > 50, `...multi-piece explosions (${seen.explosions})`);
  check(seen.kingWins > 3, `...and king explosions that end the game (${seen.kingWins})`);
}

console.log(`\nAll good — ${passed} checks passed.`);
process.exit(0);
