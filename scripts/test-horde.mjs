#!/usr/bin/env node
/**
 * Horde chess server-side regression suite — no running server needed. Run with tsx:
 *   npx tsx scripts/test-horde.mjs      (or: npm run test:horde)
 *
 *  1. NO DRIFT: the shared rules block of backend/src/game/horde.ts must be byte-identical to the mobile app's
 *     src/logic/horde.ts (hand-mirrored — there is no shared module).
 *  2. THE AUTHORITY: RoomManager.applyMove (driven with a stub socket server, no network). A Horde room starts from the
 *     36-pawn position; the positional double step is enforced (rank 1 AND rank 2 may double-step, blocked squares
 *     refuse it, rank 3 never may, and a pawn that stepped 1->2 may still double-step later); the game ends exactly as
 *     the rules say — White wins by checkmate, Black by capturing every White piece (reason 'horde', NOT the stalemate
 *     chess.js would report), a stalemate is a draw, and "Black king vs a lone White bishop" is NOT an
 *     insufficient-material draw.
 *  3. PARITY with the mobile app: random Horde games are replayed through BOTH engines and every ply must agree on every
 *     candidate move (accepted by both or refused by both), the resulting FEN, and the game-over verdict.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ChessEngine as ClientEngine } from '../../src/logic/ChessEngine.ts';
import { getHordeMoves as clientHordeMoves } from '../../src/logic/horde.ts';
import { RoomChessEngine } from '../src/game/RoomChessEngine.ts';
import { HORDE_START_FEN, getHordeWinnerFromFen, hordeFirstRankDoubleStep, hordeWhitePieceCount } from '../src/game/horde.ts';
import { buildPgn } from '../src/game/pgn.ts';
import { RoomManager } from '../src/game/rooms.ts';

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
  const mobile = block(new URL('../../src/logic/horde.ts', import.meta.url));
  const server = block(new URL('../src/game/horde.ts', import.meta.url));
  check(mobile.length > 1500, 'the shared rules block was found in both files');
  check(mobile.includes('hordeFirstRankDoubleStep') && mobile.includes('getHordeWinnerFromFen'), '...and it contains the double-step rule and the winner rule');
  check(mobile === server, 'backend/src/game/horde.ts and src/logic/horde.ts have identical rules (edit BOTH together)');
}

// --- 2. The authority: RoomManager.applyMove ---------------------------------------------------------
console.log('\n=== 2. RoomManager plays Horde by the rules ===');
function stubIo() {
  const events = [];
  return { events, to: (id) => ({ emit: (event, payload) => events.push({ id, event, payload }) }) };
}
function hordeRoom(initialFen) {
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
    atomic: false,
    duckChess: false,
    spellChess: false,
    horde: true,
    ...(initialFen ? { initialFen } : {}),
  });
  const turn = (who, from, to, promotion) => manager.applyMove(who, { roomId: created.roomId, from, to, ...(promotion ? { promotion } : {}) });
  const room = () => manager.rooms.get(created.roomId);
  const gameOvers = () => io.events.filter((e) => e.event === 'game_over');
  return { io, manager, created, turn, room, gameOvers };
}
{
  const { created, turn, room } = hordeRoom();
  check(created.fen === HORDE_START_FEN, 'a Horde room starts from the standard 36-pawn position');
  check(hordeWhitePieceCount(room().engine.getFen()) === 36, '...with 36 White pieces and no White king');
  check(turn('W', 'a4', 'a5').ok === true, 'White plays a4-a5');
  check(turn('B', 'a7', 'a6').ok === true, 'Black replies a7-a6');
  check(turn('W', 'a1', 'a3').ok === false, 'a1-a3 is refused (the pawn on a2 is in the way)');
  check(turn('W', 'e4', 'e6').ok === false, 'e4-e6 is refused (a double step needs rank 1 or 2)');
}
{
  // The positional double step.
  const r1 = hordeRoom('4k3/8/8/8/8/8/8/4P3 w - - 0 1');
  const dbl = r1.turn('W', 'e1', 'e3');
  check(dbl.ok === true && dbl.san === 'e3', 'a White pawn on RANK 1 may double-step (e1-e3)');

  const blocked = hordeRoom('4k3/8/8/8/8/4p3/8/4P3 w - - 0 1');
  check(blocked.turn('W', 'e1', 'e3').ok === false, 'the rank-1 double step is refused when the square on rank 3 is occupied');
  const blockedMid = hordeRoom('4k3/8/8/8/8/8/4p3/4P3 w - - 0 1');
  check(blockedMid.turn('W', 'e1', 'e3').ok === false && blockedMid.turn('W', 'e1', 'e2').ok === false, '...and when the square on rank 2 is occupied');

  const rank2 = hordeRoom('4k3/8/8/8/8/8/4P3/8 w - - 0 1');
  check(rank2.turn('W', 'e2', 'e4').ok === true, 'a pawn on RANK 2 may double-step (e2-e4)');

  const rank3 = hordeRoom('4k3/8/8/8/8/4P3/8/8 w - - 0 1');
  check(rank3.turn('W', 'e3', 'e5').ok === false && rank3.turn('W', 'e3', 'e4').ok === true, 'a pawn on RANK 3 may not double-step');

  // Positional, not a first-move flag: 1 -> 2, then (Black moves) 2 -> 4.
  const stepped = hordeRoom('4k3/8/8/8/8/8/8/4P3 w - - 0 1');
  check(stepped.turn('W', 'e1', 'e2').ok === true && stepped.turn('B', 'e8', 'd8').ok === true && stepped.turn('W', 'e2', 'e4').ok === true, 'a pawn that stepped 1->2 may still double-step 2->4 on a later move');

  // En passant: Black captures the rank-1 double-stepper (chess.com: "en passant captures are allowed").
  const ep = hordeRoom('4k3/8/8/8/8/3p4/8/4P3 w - - 0 1');
  ep.turn('W', 'e1', 'e3');
  check(ep.room().engine.getFen().split(' ')[3] === 'e2', 'the rank-1 double step records its en passant square (chess.js does so when an enemy pawn can capture)');
  check(ep.turn('B', 'd3', 'e2').ok === true, 'Black captures a rank-1 double-stepper en passant');
}
{
  // How the game ends.
  const mate = hordeRoom('kb6/p7/1P6/8/8/8/8/1R6 w - - 0 1');
  check(mate.turn('W', 'b6', 'b7').ok === true, 'White plays b6-b7, a pawn giving mate');
  const over = mate.gameOvers();
  check(over.length === 2 && over.every((e) => e.payload.reason === 'checkmate' && e.payload.winner === 'w'), "White wins by checkmate: both players get game_over {checkmate, winner: white}");

  const extinct = hordeRoom('4k3/8/8/8/8/8/3P4/3r4 w - - 0 1');
  check(extinct.turn('W', 'd2', 'd3').ok === true && extinct.turn('B', 'd1', 'd3').ok === true, 'Black captures the last White pawn');
  const horde = extinct.gameOvers();
  check(horde.length === 2 && horde.every((e) => e.payload.reason === 'horde' && e.payload.winner === 'b'), "Black wins with reason 'horde' — NOT the 'stalemate' draw chess.js would report for a side with no pieces");

  const stale = hordeRoom('4k3/8/8/8/8/p7/P7/8 b - - 0 1');
  check(stale.turn('B', 'e8', 'e7').ok === true, 'Black makes a quiet move...');
  const staleOver = stale.gameOvers();
  check(staleOver.length === 2 && staleOver.every((e) => e.payload.reason === 'stalemate' && e.payload.winner === null), '...and White, stalemated (pieces, but no legal move), draws — a stalemate is never a loss');

  const bishop = hordeRoom('4k3/8/8/8/8/8/8/2B5 b - - 0 1');
  check(bishop.turn('B', 'e8', 'd8').ok === true && bishop.gameOvers().length === 0, 'Black king vs a lone White bishop is NOT an insufficient-material draw — play goes on');

  const castle = hordeRoom('r3k2r/8/8/8/8/8/8/4P3 b kq - 0 1');
  check(castle.turn('B', 'e8', 'g8').ok === true, 'Black may castle');
}
{
  // PGN: the saved game is tagged and carries its non-standard start position.
  const { turn, room } = hordeRoom();
  turn('W', 'a4', 'a5');
  const pgn = buildPgn(room().initialFen, room().moves, '*', 'Horde');
  check(pgn.includes('[Variant "Horde"]') && pgn.includes('[SetUp "1"]') && pgn.includes(`[FEN "${HORDE_START_FEN}"]`), 'the saved PGN is tagged [Variant "Horde"] with SetUp/FEN');
}
check(hordeFirstRankDoubleStep('e1', () => false) === 'e3' && hordeFirstRankDoubleStep('e2', () => false) === null, 'the shared double-step rule: rank 1 only (rank 2 is chess.js\'s own)');
check(getHordeWinnerFromFen('4k3/8/8/8/8/8/8/8 w - - 0 1') === 'b' && getHordeWinnerFromFen(HORDE_START_FEN) === null, 'the shared winner rule: Black wins exactly when White has no pieces');

// --- 3. Parity with the mobile app --------------------------------------------------------------------
console.log('\n=== 3. The server and mobile engines agree ===');
{
  const random = seeded(8675309);
  const problems = [];
  const seen = { plies: 0, doubleSteps: 0, promotions: 0, captures: 0, refusals: 0, ended: 0 };
  const squares = [];
  for (const f of 'abcdefgh') for (let r = 1; r <= 8; r++) squares.push(`${f}${r}`);

  for (let game = 0; game < 10 && problems.length === 0; game++) {
    let fen = HORDE_START_FEN;
    for (let ply = 0; ply < 110 && problems.length === 0; ply++) {
      const client = new ClientEngine(fen, { horde: true });
      const candidates = clientHordeMoves(client);
      const mover = client.getTurn();

      // Every move the mobile engine offers must be accepted by the server engine, with the same resulting FEN.
      for (const m of candidates) {
        const server = new RoomChessEngine(fen, { horde: true });
        const serverMove = server.move(m.from, m.to, m.promotion);
        const clientAfter = new ClientEngine(fen, { horde: true });
        clientAfter.move(m.from, m.to, m.promotion);
        if (!serverMove) {
          problems.push(`ply ${ply}: the mobile engine offers ${m.from}${m.to}${m.promotion ?? ''} but the server refuses it (${fen})`);
          break;
        }
        if (server.getFen() !== clientAfter.getFen()) {
          problems.push(`ply ${ply}: ${m.from}${m.to} gives different positions (${server.getFen()} vs ${clientAfter.getFen()})`);
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
        const accepted = new RoomChessEngine(fen, { horde: true }).move(from, to, 'q');
        if (accepted) {
          problems.push(`ply ${ply}: the server accepts ${from}${to} which the mobile engine does not offer (${fen})`);
          break;
        }
        seen.refusals++;
      }
      // The rank-1 double steps in particular (they are the move chess.js cannot generate).
      for (const f of 'abcdefgh') {
        const wantsIt = client.getLegalMoves(`${f}1`).includes(`${f}3`) && mover === 'w';
        const server = new RoomChessEngine(fen, { horde: true });
        const piece = server.getPieceAt(`${f}1`);
        const accepted = piece?.type === 'p' && piece.color === 'w' ? !!server.move(`${f}1`, `${f}3`) : false;
        if (accepted !== (wantsIt && !!piece && piece.type === 'p')) problems.push(`ply ${ply}: rank-1 double step ${f}1${f}3 disagrees (server ${accepted}, mobile ${wantsIt}) at ${fen}`);
      }
      if (problems.length > 0) break;

      // Both engines agree on whether the game is over (the winner rule is shared; the status rules are each engine's own).
      const server = new RoomChessEngine(fen, { horde: true });
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
      if (piece?.type === 'p' && piece.color === 'w' && pick.from[1] === '1' && pick.to[1] === '3') seen.doubleSteps++;
      if (pick.promotion) seen.promotions++;
      if (pick.captured) seen.captures++;
      client.move(pick.from, pick.to, pick.promotion);
      fen = client.getFen();
      seen.plies++;
    }
  }
  check(problems.length === 0, `server and mobile agree on every candidate of ${seen.plies} plies / 10 games${problems.length ? ` — ${problems.slice(0, 3).join(' | ')}` : ''}`);
  check(seen.refusals > 1000, `...and on ${seen.refusals} sampled moves that must be refused`);
  check(seen.captures > 50 && seen.doubleSteps > 3, `the random games really exercised captures (${seen.captures}) and rank-1 double steps (${seen.doubleSteps})`);
}

console.log(`\nAll good — ${passed} checks passed.`);
process.exit(0);
