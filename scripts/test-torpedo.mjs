#!/usr/bin/env node
/**
 * Torpedo chess server-side regression suite — no running server needed. Run with tsx:
 *   npx tsx scripts/test-torpedo.mjs      (or: npm run test:torpedo)
 *
 *  1. NO DRIFT: the shared rules block of backend/src/game/torpedo.ts must be byte-identical to the mobile app's
 *     src/logic/torpedo.ts (hand-mirrored — there is no shared module).
 *  2. THE SERVER ENGINE (RoomChessEngine with { torpedo: true }): a pawn may step two squares from ANY rank when both squares
 *     are empty and its king stays safe; a double step onto the last rank promotes; en passant works after a double step on
 *     rank 4 / 5 too (and survives a FEN reload); a double step can block a check, so such a position is not checkmate and the
 *     "mating" move is "+", not "#"; everything else (draws, castling) is standard chess.
 *  3. PARITY with the mobile app: random Torpedo games are replayed through BOTH engines and every ply must agree on every
 *     candidate move (accepted by both or refused by both), the resulting FEN, and the game-over verdict.
 * The room layer (matchmaking, challenges, tournaments, clocks) is Part 2 of the variant.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ChessEngine as ClientEngine } from '../../src/logic/ChessEngine.ts';
import { getTorpedoMoves as clientTorpedoMoves } from '../../src/logic/torpedo.ts';
import { RoomChessEngine } from '../src/game/RoomChessEngine.ts';
import { TORPEDO_START_FEN, torpedoExtraDoubleStep } from '../src/game/torpedo.ts';

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ✓ ${message}`);
}
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

// --- 1. No drift -----------------------------------------------------------------------------------
console.log('\n=== 1. The server rules block is a verbatim copy of the mobile one ===');
{
  const START = '// --- Shared rules block';
  const END = '// --- End of the shared rules block';
  const block = (path) => {
    const text = readFileSync(path, 'utf8').split(CRLF).join(LF);
    return text.slice(text.indexOf(START), text.indexOf(END));
  };
  const mobile = block(new URL('../../src/logic/torpedo.ts', import.meta.url));
  const server = block(new URL('../src/game/torpedo.ts', import.meta.url));
  check(mobile.length > 800, 'the shared rules block was found in both files');
  check(mobile.includes('torpedoExtraDoubleStep') && mobile.includes('TORPEDO_START_FEN'), '...and it contains the start position and the double-step rule');
  check(mobile === server, 'backend/src/game/torpedo.ts and src/logic/torpedo.ts have identical rules (edit BOTH together)');
}

// --- 2. The server engine ---------------------------------------------------------------------------
console.log('\n=== 2. The server engine plays Torpedo ===');
const torpedo = (fen) => new RoomChessEngine(fen, { torpedo: true });
{
  check(TORPEDO_START_FEN === 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'the start position is the ordinary one');
  check(torpedoExtraDoubleStep('e3', 'w', () => false) === 'e5' && torpedoExtraDoubleStep('e2', 'w', () => false) === null, 'the shared rule: e3 -> e5, the home rank is chess.js business');

  const white = torpedo('4k3/8/8/8/8/4P3/8/4K3 w - - 0 1');
  check(white.getLegalMoves('e3').sort().join() === 'e4,e5', 'a White pawn on e3 may go to e4 or e5');
  const stepped = white.move('e3', 'e5');
  check(stepped !== null && stepped.san === 'e5' && white.getPieceAt('e5')?.type === 'p' && white.getPieceAt('e3') === null, 'e3-e5 is played');

  const black = torpedo('4k3/8/3p4/8/8/8/8/4K3 b - - 0 1');
  check(black.getLegalMoves('d6').sort().join() === 'd4,d5', 'a Black pawn on d6 may go to d5 or d4');

  check(torpedo('4k3/8/8/4n3/8/4P3/8/4K3 w - - 0 1').move('e3', 'e5') === null, 'the double step is refused when the far square is occupied');
  check(torpedo('4k3/8/8/8/4n3/4P3/8/4K3 w - - 0 1').move('e3', 'e5') === null, '...and when the near square is occupied');
  check(torpedo('4k3/8/3p4/8/8/4P3/8/4K3 w - - 0 1').move('d6', 'd4') === null, '...and for the side that is not to move');

  const pinned = torpedo('7b/8/8/8/3P4/8/8/K3k3 w - - 0 1');
  check(pinned.move('d4', 'd6') === null && pinned.move('d4', 'd5') === null, 'a pinned pawn cannot step at all (the king stays safe)');

  const promo = torpedo('8/7k/4P3/8/8/8/8/K7 w - - 0 1');
  const promoted = promo.move('e6', 'e8', 'n');
  check(promoted !== null && promoted.promotion === 'n' && promo.getPieceAt('e8')?.type === 'n', 'e6-e8 is a promotion (to the chosen piece)');
  check(torpedo('7k/8/8/8/8/2p5/8/K7 b - - 0 1').move('c3', 'c1', 'q')?.promotion === 'q', 'a Black pawn on c3 promotes on c1');

  const ep = torpedo('4k3/8/8/3p4/8/4P3/8/4K3 w - - 0 1');
  ep.move('e3', 'e5');
  check(ep.getFen() === '4k3/8/8/3pP3/8/8/8/4K3 b - e4 0 1', 'the double step from rank 3 records the en passant square e4');
  const reloaded = torpedo(ep.getFen());
  check(reloaded.getFen() === ep.getFen() && reloaded.getLegalMoves('d5').includes('e4'), '...which survives a reload from the FEN');
  check(reloaded.move('d5', 'e4') !== null && reloaded.getPieceAt('e5') === null, 'Black takes en passant and the e5 pawn is gone');

  const blackEp = torpedo('4k3/8/4p3/8/3P4/8/8/4K3 b - - 0 1');
  blackEp.move('e6', 'e4');
  check(blackEp.getFen().split(' ')[3] === 'e5' && blackEp.move('d4', 'e5') !== null, 'a Black double step from rank 6 can be taken en passant on e5');

  const BLOCKABLE_MATE = '7K/r7/8/8/1k6/4P3/8/b5r1 w - - 0 1';
  const standard = new RoomChessEngine(BLOCKABLE_MATE, { skipValidation: true });
  check(standard.getStatus() === 'checkmate', 'control: without the option this position is checkmate');
  const blockable = torpedo(BLOCKABLE_MATE);
  check(blockable.getStatus() === 'check' && !blockable.isGameOver(), 'Torpedo: still check, the game goes on (e3-e5 blocks)');
  check(blockable.move('e3', 'e4') === null && blockable.move('e3', 'e5') !== null, '...and only the long step saves White');
  const mating = torpedo('7K/r7/8/8/1k6/4P3/3b4/6r1 b - - 0 1');
  const mover = mating.move('d2', 'c3');
  check(mover?.san === 'Bc3+' && mating.getStatus() === 'check', 'the move that gives such a check is written "+", not "#"');
  const realMate = torpedo('7K/r7/8/8/1k6/7P/8/b5r1 w - - 0 1');
  check(realMate.getStatus() === 'checkmate' && realMate.isGameOver(), 'a real checkmate (no double step helps) is still checkmate');
  check(torpedo('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1').getStatus() === 'stalemate', 'a stalemate is still a stalemate');

  check(torpedo('4k3/8/8/8/8/8/R7/4K3 w - - 100 80').getStatus() === 'draw', 'the fifty-move rule draws');
  check(torpedo('4k3/8/8/8/8/8/8/3BK3 w - - 0 1').getStatus() === 'draw', 'king and bishop against king is insufficient material');
  check(torpedo('4k3/8/8/8/8/8/P7/4K3 w - - 0 1').getStatus() === 'playing', '...but not while a pawn is on the board');

  const castle = torpedo('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  check(castle.move('e1', 'g1')?.san === 'O-O', 'castling works');
}

// --- 3. Parity with the mobile engine ------------------------------------------------------------------
console.log('\n=== 3. The server and mobile engines agree ===');
{
  const random = seeded(24681357);
  const problems = [];
  const seen = { plies: 0, doubleSteps: 0, promotions: 0, captures: 0, refusals: 0, ended: 0, enPassant: 0 };
  const squares = [];
  for (const f of 'abcdefgh') for (let r = 1; r <= 8; r++) squares.push(`${f}${r}`);

  for (let game = 0; game < 12 && problems.length === 0; game++) {
    let fen = TORPEDO_START_FEN;
    for (let ply = 0; ply < 110 && problems.length === 0; ply++) {
      const client = new ClientEngine(fen, { torpedo: true });
      const candidates = clientTorpedoMoves(client);

      // Every move the mobile engine offers must be accepted by the server engine, with the same resulting FEN and SAN.
      for (const m of candidates) {
        const server = new RoomChessEngine(fen, { torpedo: true });
        const serverMove = server.move(m.from, m.to, m.promotion);
        const clientAfter = new ClientEngine(fen, { torpedo: true });
        const clientMove = clientAfter.move(m.from, m.to, m.promotion);
        if (!serverMove) {
          problems.push(`ply ${ply}: the mobile engine offers ${m.from}${m.to}${m.promotion ?? ''} but the server refuses it (${fen})`);
          break;
        }
        if (server.getFen() !== clientAfter.getFen() || serverMove.san !== clientMove?.san) {
          problems.push(`ply ${ply}: ${m.from}${m.to} gives different results (${server.getFen()} ${serverMove.san} vs ${clientAfter.getFen()} ${clientMove?.san})`);
          break;
        }
      }
      if (problems.length > 0) break;

      // ...and a sample of moves the mobile engine does NOT offer must be refused by the server as well.
      const offered = new Set(candidates.map((m) => `${m.from}${m.to}`));
      for (let probe = 0; probe < 40; probe++) {
        const from = squares[Math.floor(random() * 64)];
        const to = squares[Math.floor(random() * 64)];
        if (from === to || offered.has(`${from}${to}`)) continue;
        if (new RoomChessEngine(fen, { torpedo: true }).move(from, to, 'q')) {
          problems.push(`ply ${ply}: the server accepts ${from}${to} which the mobile engine does not offer (${fen})`);
          break;
        }
        seen.refusals++;
      }
      // The server's own move list agrees with the mobile one, square by square.
      const server = new RoomChessEngine(fen, { torpedo: true });
      for (const from of squares) {
        const a = [...new Set(client.getLegalMoves(from))].sort().join();
        const b = [...new Set(server.getLegalMoves(from))].sort().join();
        if (client.getPieceAt(from)?.color === client.getTurn() && a !== b) problems.push(`ply ${ply}: legal moves from ${from} differ (${a} vs ${b}) at ${fen}`);
      }
      if (problems.length > 0) break;

      // Both engines agree on whether the game is over and on its status.
      if (server.isGameOver() !== client.isGameOver() || server.getStatus() !== client.getStatus()) {
        problems.push(`ply ${ply}: verdicts differ at ${fen}: server ${server.getStatus()}/${server.isGameOver()} mobile ${client.getStatus()}/${client.isGameOver()}`);
        break;
      }
      if (client.isGameOver() || candidates.length === 0) {
        seen.ended++;
        break;
      }

      const pick = candidates[Math.floor(random() * candidates.length)];
      const piece = client.getPieceAt(pick.from);
      if (piece?.type === 'p' && pick.from[0] === pick.to[0] && Math.abs(Number(pick.to[1]) - Number(pick.from[1])) === 2) seen.doubleSteps++;
      if (pick.promotion) seen.promotions++;
      if (pick.captured) seen.captures++;
      if (piece?.type === 'p' && !client.getPieceAt(pick.to) && pick.from[0] !== pick.to[0]) seen.enPassant++;
      client.move(pick.from, pick.to, pick.promotion);
      fen = client.getFen();
      seen.plies++;
    }
  }
  check(problems.length === 0, `server and mobile agree on every candidate of ${seen.plies} plies / 12 games${problems.length ? ` — ${problems.slice(0, 3).join(' | ')}` : ''}`);
  check(seen.refusals > 1000, `...and on ${seen.refusals} sampled moves that must be refused`);
  check(seen.captures > 50 && seen.doubleSteps > 50, `the random games really exercised captures (${seen.captures}) and double steps (${seen.doubleSteps})`);
}

console.log(`\nAll good — ${passed} checks passed.`);
process.exit(0);
