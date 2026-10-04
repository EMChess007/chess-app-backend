#!/usr/bin/env node
/**
 * Duck Chess server-side regression suite — no running server needed. Run with tsx:
 *   npx tsx scripts/test-duck.mjs      (or: npm run test:duck)
 *
 * Layers, mirroring Giveaway / Atomic / Fog of War:
 *  1. NO DRIFT: the shared rules block of backend/src/game/duckChess.ts must be byte-identical to the mobile
 *     app's src/logic/duckChess.ts (hand-mirrored — there is no shared module).
 *  2. THE AUTHORITY: RoomManager.applyMove (driven with a stub socket server, no network) treats a turn as ONE
 *     unit — a regular move AND the duck's new square. It refuses any move the duck blocks (landing on it, sliding
 *     or double-stepping over it, castling across it), refuses the WHOLE turn when the duck destination is missing,
 *     occupied, or the duck's own square (leaving the room untouched), accepts legal turns, ends the game on a
 *     king capture with reason 'duckChess' (no placement), treats a blockade as a draw, and keeps "no check"
 *     honest (moving into attack, castling through attacked squares).
 *  3. PARITY with the mobile app: random Duck games are replayed through BOTH engines and every ply must agree
 *     on the legal move set, the legal duck squares, the applied move's SAN/capture, the resulting FEN and the
 *     blockade/king-capture verdicts.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ChessEngine as ClientEngine } from '../../src/logic/ChessEngine.ts';
import { getLegalDuckPlacementSquares as clientPlacements, hasNoDuckMoves as clientBlockade } from '../../src/logic/duckChess.ts';
import { RoomChessEngine, START_FEN } from '../src/game/RoomChessEngine.ts';
import { emptySquares, hasNoDuckMoves, isLegalDuckPlacement } from '../src/game/duckChess.ts';
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
const duckEngine = (fen, duckSquare = null) => new RoomChessEngine(fen, { duckChess: true, duckSquare });
const uci = (moves) => moves.map((m) => `${m.from}${m.to}${m.promotion ?? ''}`).sort().join();

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
  const mobile = block(new URL('../../src/logic/duckChess.ts', import.meta.url));
  const server = block(new URL('../src/game/duckChess.ts', import.meta.url));
  check(mobile.length > 1500, 'the shared rules block was found in both files');
  check(mobile === server, 'backend/src/game/duckChess.ts and src/logic/duckChess.ts have identical rules (edit BOTH together)');
}

// --- 2. The authority: RoomManager.applyMove ---------------------------------------------------------
console.log('\n=== 2. RoomManager validates Duck Chess turns ===');
function stubIo() {
  const events = [];
  return { events, to: (id) => ({ emit: (event, payload) => events.push({ id, event, payload }) }) };
}
function duckRoom(initialFen) {
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
    duckChess: true,
    initialFen,
  });
  const turn = (who, from, to, duckTo, promotion) => manager.applyMove(who, { roomId: created.roomId, from, to, duckTo, promotion });
  const gameOvers = () => io.events.filter((e) => e.event === 'game_over');
  return { io, manager, roomId: created.roomId, turn, gameOvers };
}
{
  const { turn, io } = duckRoom();
  const missing = turn('W', 'e2', 'e4');
  check(missing.ok === false && /duck/i.test(missing.error), "White's first turn needs the duck as well — a move with no duckTo is refused");
  check(turn('W', 'e2', 'e4', 'e4').ok === false, 'the duck may not be placed on an occupied square (the pawn that just moved there)');
  check(turn('W', 'e2', 'e4', 'e1').ok === false, '...nor on any other occupied square');
  check(turn('W', 'e2', 'e4', 'z9').ok === false && turn('W', 'e2', 'e4', 42).ok === false, '...nor on something that is not a square');
  const ok = turn('W', 'e2', 'e4', 'e6');
  check(ok.ok === true && ok.san === 'e4' && ok.duckSquare === 'e6', 'a legal turn (move + first duck placement) is accepted and acknowledged with the duck\'s square');
  check(io.events.some((e) => e.id === 'B' && e.event === 'opponent_move' && e.payload.duck === 'e6' && e.payload.duckSquare === 'e6' && e.payload.san === 'e4'), 'the opponent is told the move AND the duck in one event');
  // The refusals above must have left the room untouched, so the same turn was still available (it was accepted).
  check(turn('B', 'e7', 'e5', 'a3').ok === false, 'Black cannot double-step e7-e5 over the duck on e6');
  check(turn('B', 'e7', 'e6', 'a3').ok === false, '...nor push onto it');
  check(turn('B', 'd7', 'd5', 'e6').ok === false, 'the duck must MOVE: placing it back on its own square is refused');
  check(turn('B', 'd7', 'd5', 'c4').ok === true, 'a legal reply with the duck on a new square is accepted');
  check(turn('W', 'g1', 'f3', 'c4').ok === false, 'a knight may not land on the duck...');
  check(turn('W', 'g1', 'f3', 'h6').ok === true, '...but is fine once it has moved on');
}
{
  // Castling is blocked when the duck sits on a square the king or rook crosses (the duck got there from the
  // opponent's placement), and only then.
  const { turn } = duckRoom('r3k2r/8/8/8/8/8/P7/R3K2R w KQkq - 0 1');
  check(turn('W', 'a2', 'a3', 'h5').ok === true, 'White plays a3 and puts the duck on h5');
  check(turn('B', 'a8', 'a7', 'f1').ok === true, "Black moves and parks the duck on f1 — right in front of White's kingside castling");
  check(turn('W', 'e1', 'g1', 'h5').ok === false, 'O-O is refused: the king crosses f1, where the duck stands');
  check(turn('W', 'e1', 'c1', 'h5').ok === true, '...while O-O-O is still fine (queenside squares are clear)');
}
console.log('  (the blocking geometry itself is covered exhaustively by the parity run below)');
{
  const { turn } = duckRoom('4k3/8/8/8/8/8/8/R3K3 w - - 0 1');
  turn('W', 'e1', 'e2', 'a4'); // duck on a4
  check(turn('B', 'e8', 'e7', 'a5').ok === true, 'Black replies; the duck goes to a5');
  check(turn('W', 'a1', 'a6', 'h8').ok === false, 'the rook cannot slide over the duck on a5 to reach a6');
  check(turn('W', 'a1', 'a5', 'h8').ok === false, '...and cannot land on it');
  check(turn('W', 'a1', 'a4', 'h8').ok === true, '...but may stop short of it');
}
{
  // Capturing the king ends the game at once and needs no duck; a stray duckTo is ignored.
  const { turn, gameOvers, io } = duckRoom('k7/8/8/8/8/8/8/R3K3 w - - 0 1');
  const ack = turn('W', 'a1', 'a8');
  check(ack.ok === true && ack.san === 'Rxa8', 'a move that captures the king is accepted with NO duck destination');
  const over = gameOvers();
  check(over.length === 2 && over.every((e) => e.payload.reason === 'duckChess' && e.payload.winner === 'w'), 'both players get game_over {reason: "duckChess", winner: white}');
  check(io.events.filter((e) => e.event === 'opponent_move').every((e) => e.payload.duck === undefined), '...and the final move carries no duck');
}
{
  const { turn, gameOvers } = duckRoom('k7/8/8/8/8/8/8/R3K3 w - - 0 1');
  const ack = turn('W', 'a1', 'a8', 'h8');
  check(ack.ok === true && gameOvers().length === 2, 'a duckTo sent with a king capture is simply ignored');
}
{
  // No check: leaving the king en prise and moving into attack are legal; castling out of/through attack is too.
  const { turn } = duckRoom('4r2k/8/8/8/8/8/8/R3K2R w KQ - 0 1');
  const ack = turn('W', 'e1', 'g1', 'a4');
  check(ack.ok === true && ack.san === 'O-O', 'castling OUT OF "check" (Re8 attacks e1) is legal — there is no check');
  const { turn: turn2 } = duckRoom('5r1k/8/8/8/8/8/8/R3K2R w KQ - 0 1');
  check(turn2('W', 'e1', 'g1', 'a4').ok === true, 'castling THROUGH an attacked square is legal too');
  const { turn: turn3 } = duckRoom('4r2k/8/8/8/8/8/8/R3K3 w - - 0 1');
  check(turn3('W', 'a1', 'a7', 'h5').ok === true, 'ignoring a "check" altogether is legal');
}
{
  // A blockade is a draw: after White's turn Black has no regular move.
  const { turn, gameOvers } = duckRoom('8/8/8/8/8/4p3/4P2R/8 w - - 0 1');
  const ack = turn('W', 'h2', 'h1', 'a1');
  check(ack.ok === true, 'the move that blockades the opponent is accepted');
  const over = gameOvers();
  check(over.length === 2 && over.every((e) => e.payload.reason === 'draw' && e.payload.winner === null), 'the blockaded side has no regular move: the game is a draw');
}
{
  const { turn } = duckRoom('8/4P3/8/8/8/8/8/k6K w - - 0 1');
  check(turn('W', 'e7', 'e8', 'a5', 'k').ok === false, 'a forged king promotion is refused');
  const ok = turn('W', 'e7', 'e8', 'a5', 'q');
  check(ok.ok === true && ok.san === 'e8=Q', 'a queen promotion with a duck placement is accepted');
}
{
  check(
    buildPgn(START_FEN, [{ from: 'e2', to: 'e4', san: 'e4', duck: 'e6' }, { from: 'd7', to: 'd5', san: 'd5', duck: 'c4' }], '1-0', 'Duck').includes('1.e4 {@e6} d5 {@c4}'),
    'saved games carry the duck as a PGN comment'
  );
  check(buildPgn(START_FEN, [{ from: 'e2', to: 'e4', san: 'e4' }], '1-0', 'Duck').includes('[Variant "Duck"]'), 'and are tagged [Variant "Duck"]');
  check(isLegalDuckPlacement(START_FEN, 'e4', 'e3') && !isLegalDuckPlacement(START_FEN, 'e3', 'e3') && !isLegalDuckPlacement(START_FEN, null, 'e2'), 'isLegalDuckPlacement: empty, and not where the duck already is');
  check(emptySquares(START_FEN).length === 32, 'emptySquares reads the placement field (32 empty squares at the start)');
  check(hasNoDuckMoves(duckEngine('8/8/8/8/8/8/4P3/8 w - - 0 1', 'e3')) === true, 'hasNoDuckMoves detects a blockade');
}

// --- 3. Parity with the mobile app -------------------------------------------------------------------
console.log('\n=== 3. Parity with the mobile implementation (random Duck games) ===');
{
  const problems = [];
  const seen = { games: 0, plies: 0, castles: 0, kingCaptures: 0, blockades: 0 };
  for (let g = 0; g < 100 && problems.length < 5; g++) {
    const random = seeded(31000 + g);
    const server = duckEngine(START_FEN, null);
    let duck = null;
    let clientFen = START_FEN;
    seen.games++;
    for (let ply = 0; ply < 200; ply++) {
      const client = new ClientEngine(clientFen, { skipValidation: true, duckChess: true, duckSquare: duck });
      const serverMoves = server.getPseudoLegalMoves(server.getTurn());
      const clientMoves = client.getPseudoLegalMoves(client.getTurn());
      if (uci(serverMoves) !== uci(clientMoves)) {
        problems.push(`game ${g} ply ${ply}: legal moves differ (duck ${duck}) in ${server.getFen()}`);
        break;
      }
      if (hasNoDuckMoves(server) !== clientBlockade(client)) {
        problems.push(`game ${g} ply ${ply}: blockade verdict differs in ${server.getFen()}`);
        break;
      }
      if (serverMoves.length === 0) {
        seen.blockades++;
        break;
      }
      const castles = serverMoves.filter((m) => server.getFen().includes('K') && m.from[0] === 'e' && Math.abs(m.to.charCodeAt(0) - m.from.charCodeAt(0)) === 2 && client.getPieceAt(m.from)?.type === 'k');
      const pool = castles.length > 0 && random() < 0.7 ? castles : serverMoves;
      const pick = pool[Math.floor(random() * pool.length)];
      const a = server.movePseudoLegal(pick.from, pick.to, pick.promotion);
      const b = client.movePseudoLegal(pick.from, pick.to, pick.promotion);
      if (!a || !b || a.san !== b.san || a.captured !== b.captured || server.getFen() !== client.getFen()) {
        problems.push(`game ${g} ply ${ply}: applied move differs ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
        break;
      }
      if (a.san === 'O-O' || a.san === 'O-O-O') seen.castles++;
      seen.plies++;
      if (a.captured === 'k') {
        seen.kingCaptures++;
        break;
      }
      const serverSquares = emptySquares(server.getFen()).filter((sq) => sq !== duck).sort().join();
      const clientSquares = [...clientPlacements(client, duck)].sort().join();
      if (serverSquares !== clientSquares) {
        problems.push(`game ${g} ply ${ply}: legal duck squares differ in ${server.getFen()}`);
        break;
      }
      const squares = serverSquares.split(',');
      duck = squares[Math.floor(random() * squares.length)];
      server.setDuckSquare(duck);
      clientFen = client.getFen();
    }
  }
  check(problems.length === 0, `server and mobile agree on every ply of ${seen.plies} plies / ${seen.games} games${problems.length ? ` — ${problems.slice(0, 3).join(' | ')}` : ''}`);
  check(seen.castles > 5, `the random games really exercised castling (${seen.castles})`);
  check(seen.kingCaptures > 20, `...and games that end by a king capture (${seen.kingCaptures})`);
}

console.log(`\nAll good — ${passed} checks passed.`);
process.exit(0);
