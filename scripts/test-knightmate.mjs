#!/usr/bin/env node
/**
 * Knightmate server-side regression suite -- no running server needed. Run with tsx:
 *   npx tsx scripts/test-knightmate.mjs      (or: npm run test:knightmate)
 *
 *  1. NO DRIFT: the shared rules block of backend/src/game/knightmate.ts must be byte-identical to the mobile app's
 *     src/logic/knightmate.ts (hand-mirrored -- there is no shared module).
 *  2. THE SERVER ENGINE (RoomChessEngine with { knightmate: true }) plays Knightmate by the rules: the opening, a royal knight that
 *     cannot move into check, a commoner that can, a pinned piece, both castlings and the refused ones, promotion choices (never a
 *     knight), stalemate = draw, bare royal knights = draw, the notation (K royal knight, M commoner, =M) and the timeout rule.
 *  3. PARITY with the mobile app: seeded random games are replayed through BOTH engines and every ply must agree on the legal
 *     targets of EVERY square, the resulting FEN, the notation and the status.
 *  4. THE ROOM (RoomManager, stub socket server): wire promotion q / r / b / m (never n; "m" refused outside Knightmate), the notation on
 *     the wire and in the PGN ("K", "M", "=M"), the [Variant "Knightmate"] tag, spectate / rejoin flags, and the flag-fall rule on the real
 *     room clock (a draw against a bare royal knight, otherwise a loss).
 * Queues, challenges and tournaments over real sockets are in test-multiplayer.mjs / test-tournament.mjs.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ChessEngine as ClientEngine } from '../../src/logic/ChessEngine.ts';
import { getKnightmateMoves } from '../../src/logic/knightmateGame.ts';
import { RoomChessEngine } from '../src/game/RoomChessEngine.ts';
import { RoomManager, variantPgnTag } from '../src/game/rooms.ts';
import { buildPgn } from '../src/game/pgn.ts';
import { KNIGHTMATE_START_FEN, kmOnlyRoyalKnight, kmParseFen, kmTimeoutResult } from '../src/game/knightmate.ts';

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ✓ ${message}`);
}
function checkEqual(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  passed++;
  console.log(`  ✓ ${message}`);
}
const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);
const FILES = 'abcdefgh';
const SQUARES = [];
for (const file of FILES) for (let rank = 1; rank <= 8; rank++) SQUARES.push(`${file}${rank}`);

function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const server = (fen) => new RoomChessEngine(fen, { knightmate: true });
const targets = (fen, square) => server(fen).getLegalMoves(square).sort();

// --- 1. No drift -----------------------------------------------------------------------------------
console.log('\n=== 1. The server rules block is a verbatim copy of the mobile one ===');
{
  const START = '// --- Shared rules block';
  const END = '// --- End of the shared rules block';
  const block = (path) => {
    const text = readFileSync(path, 'utf8').split(CRLF).join(LF);
    return text.slice(text.indexOf(START), text.indexOf(END));
  };
  const mobile = block(new URL('../../src/logic/knightmate.ts', import.meta.url));
  const serverBlock = block(new URL('../src/game/knightmate.ts', import.meta.url));
  check(mobile.length > 5000, 'the shared rules block was found in both files');
  check(mobile.includes('KNIGHTMATE_START_FEN') && mobile.includes('kmLegalMoves') && mobile.includes('kmTimeoutResult'), '...and it contains the start position, the move generator and the timeout rule');
  check(mobile === serverBlock, 'backend/src/game/knightmate.ts and src/logic/knightmate.ts have identical rules (edit BOTH together)');
}

// --- 2. The server engine --------------------------------------------------------------------------
console.log('\n=== 2. The server engine plays Knightmate by the rules ===');
{
  check(KNIGHTMATE_START_FEN === 'rmbqkbmr/pppppppp/8/8/8/8/PPPPPPPP/RMBQKBMR w KQkq - 0 1', 'the start position: royal knight (k) on e1/e8, commoners (m) on b1 g1 b8 g8');
  const start = server();
  check(start.getFen() === KNIGHTMATE_START_FEN, 'a Knightmate engine without a FEN starts from the Knightmate position');
  checkEqual(start.getLegalMoves('e1').sort(), ['d3', 'f3'], 'the opening royal knight has exactly its two jumps; the boxed-in commoners none');
  check(start.getLegalMoves('b1').length === 0, '...and the commoner on b1 has no move');
  checkEqual(start.getPieceAt('e1'), { type: 'k', color: 'w' }, 'getPieceAt: the royal knight is type k');
  checkEqual(start.getPieceAt('g8'), { type: 'm', color: 'b' }, 'getPieceAt: the commoner is type m');

  checkEqual(targets('k5r1/8/8/8/8/8/8/4K3 w - - 0 1', 'e1'), ['c2', 'd3', 'f3'], 'the royal knight cannot move into check (g2 is covered by the rook)');
  checkEqual(targets('k7/8/8/8/K7/8/8/8 w - - 0 1', 'a4'), ['b2', 'c3', 'c5'], 'two royal knights can never stand a knight\'s move apart (b6 is refused)');
  checkEqual(targets('k7/8/8/7r/4M3/8/8/K7 w - - 0 1', 'e4'), ['d3', 'd4', 'd5', 'e3', 'e5', 'f3', 'f4', 'f5'], 'a commoner CAN move onto attacked squares (d5 e5 f5)');
  checkEqual(targets('k3r3/8/8/8/8/8/4B3/4K3 w - - 0 1', 'e2'), [], 'a piece pinned to the royal knight cannot leave the line');

  const castle = server('1k6/8/8/8/8/8/8/R3K2R w KQ - 0 1');
  check(castle.getLegalMoves('e1').includes('g1') && castle.getLegalMoves('e1').includes('c1'), 'both castlings are offered');
  check(castle.move('e1', 'g1')?.san === 'O-O' && castle.getFen() === '1k6/8/8/8/8/8/8/R4RK1 b - - 1 1', 'O-O: the royal knight on g1, the rook on f1');
  const queenside = server('1k6/8/8/8/8/8/8/R3K2R w KQ - 0 1');
  check(queenside.move('e1', 'c1')?.san === 'O-O-O' && queenside.getFen() === '1k6/8/8/8/8/8/8/2KR3R b - - 1 1', 'O-O-O: the royal knight on c1, the rook on d1');
  check(!targets('k4r2/8/8/8/8/8/8/R3K2R w KQ - 0 1', 'e1').includes('g1'), 'castling through an attacked square is refused');
  check(!targets('k3r3/8/8/8/8/8/8/R3K2R w KQ - 0 1', 'e1').includes('c1'), 'castling out of check is refused');

  const promo = '7k/P7/8/8/8/8/8/K7 w - - 0 1';
  check(server(promo).move('a7', 'a8', 'n') === null && server(promo).move('a7', 'a8', 'k') === null, 'a pawn can NOT promote to a knight (or a royal knight)');
  check(server(promo).move('a7', 'a8', 'm')?.san === 'a8=M', 'a pawn promotes to a commoner: a8=M');
  const queen = server(promo);
  queen.move('a7', 'a8');
  checkEqual(queen.getPieceAt('a8'), { type: 'q', color: 'w' }, 'an omitted promotion is a queen');

  check(server('k7/8/8/2Q5/8/8/8/7K b - - 0 1').getStatus() === 'stalemate', 'stalemate is reported (a draw)');
  check(server('k7/Q7/8/8/8/8/8/7K b - - 0 1').getStatus() === 'checkmate', 'checkmate is reported');
  check(server('k7/8/8/8/8/8/8/K7 w - - 0 1').getStatus() === 'draw' && server('k7/8/8/8/8/8/8/K7 w - - 0 1').isGameOver(), 'two bare royal knights are a draw');
  check(server('k7/8/8/8/8/8/8/KM6 w - - 0 1').getStatus() === 'playing', 'a commoner left on the board plays on');

  const sanGame = server();
  const sans = [sanGame.move('e2', 'e4')?.san, sanGame.move('a7', 'a6')?.san, sanGame.move('e1', 'f3')?.san, sanGame.move('b8', 'a7')?.san];
  checkEqual(sans, ['e4', 'a6', 'Kf3', 'Ma7'], 'notation: K = royal knight, M = commoner');

  const bareBlack = kmParseFen('k7/8/8/8/8/8/8/KM6 w - - 0 1');
  check(kmOnlyRoyalKnight(bareBlack, 'b') && !kmOnlyRoyalKnight(bareBlack, 'w'), 'only-royal-knight: Black has just its royal knight, White has a commoner too');
  check(kmTimeoutResult(bareBlack, 'w') === 'draw', 'timeout: White flags, Black has only its royal knight -> draw');
  check(kmTimeoutResult(bareBlack, 'b') === 'w', 'timeout: Black flags, White has more -> White wins');
  check(kmTimeoutResult(kmParseFen(KNIGHTMATE_START_FEN), 'w') === 'b', 'timeout from the start position -> the opponent wins');
}

// --- 3. Parity with the mobile app -------------------------------------------------------------------
console.log('\n=== 3. The server engine and the mobile engine agree on every ply of seeded random games ===');
{
  let plies = 0;
  let promotions = 0;
  let castles = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const rng = seeded(seed);
    const client = new ClientEngine(KNIGHTMATE_START_FEN, { knightmate: true });
    const room = server(KNIGHTMATE_START_FEN);
    for (let ply = 0; ply < 160; ply++) {
      assert.equal(room.getFen(), client.getFen(), `seed ${seed} ply ${ply}: FEN`);
      assert.equal(room.getStatus(), client.getStatus(), `seed ${seed} ply ${ply}: status`);
      assert.equal(room.isGameOver(), client.isGameOver(), `seed ${seed} ply ${ply}: game over`);
      assert.equal(room.getTurn(), client.getTurn(), `seed ${seed} ply ${ply}: turn`);
      for (const square of SQUARES) {
        assert.deepEqual(room.getLegalMoves(square).sort(), client.getLegalMoves(square).sort(), `seed ${seed} ply ${ply}: legal targets of ${square}`);
        assert.deepEqual(room.getPieceAt(square), client.getPieceAt(square), `seed ${seed} ply ${ply}: piece on ${square}`);
      }
      if (client.isGameOver()) break;
      const moves = getKnightmateMoves(client);
      const choice = moves[Math.floor(rng() * moves.length)];
      const a = client.move(choice.from, choice.to, choice.promotion);
      const b = room.move(choice.from, choice.to, choice.promotion);
      assert.ok(a && b, `seed ${seed} ply ${ply}: both engines accept ${choice.san}`);
      assert.equal(b.san, a.san, `seed ${seed} ply ${ply}: notation`);
      assert.equal(b.captured, a.captured, `seed ${seed} ply ${ply}: captured piece`);
      if (choice.promotion) promotions++;
      if (choice.san.startsWith('O-O')) castles++;
      plies++;
    }
  }
  passed++;
  console.log(`  ✓ ${plies} plies over 8 seeded games agree: FEN, status, game over, turn, every square's targets and piece, notation, captures`);
  console.log(`    (the walk met ${promotions} promotions and ${castles} castlings)`);
  // A move both engines must refuse.
  const a = new ClientEngine(KNIGHTMATE_START_FEN, { knightmate: true });
  const b = server(KNIGHTMATE_START_FEN);
  check(a.move('e1', 'e2') === null && b.move('e1', 'e2') === null, 'an illegal move is refused by both engines');
}

// --- 4. The room: wire promotion, notation, flag falls, PGN tag ---------------------------------------
console.log('\n=== 4. RoomManager: promotion on the wire (q / r / b / m, never n), "=M" notation, the flag-fall rule, [Variant "Knightmate"] ===');
{
  const sent = [];
  const stubIo = { to: (target) => ({ emit: (event, payload) => sent.push({ target, event, payload }) }) };
  const rooms = new RoomManager(stubIo);
  const flags = { chess960: false, kingOfTheHill: false, threeCheck: false, setupChess: false, fogOfWar: false, giveaway: false, atomic: false, duckChess: false, spellChess: false, horde: false, racingKings: false, torpedo: false, knightmate: true, crazyhouse: false };
  const open = (tag, extra = {}) =>
    rooms.createRoom({ white: { socketId: `${tag}-w`, userId: null }, black: { socketId: `${tag}-b`, userId: null }, timeControl: { initialSeconds: 300, incrementSeconds: 0 }, ...flags, ...extra });

  const room = open('km');
  check(room.fen === KNIGHTMATE_START_FEN, 'a Knightmate room starts from the Knightmate position');
  const play = (id, tag, color, from, to, promotion) => rooms.applyMove(`${tag}-${color}`, { roomId: id, from, to, ...(promotion ? { promotion } : {}) });
  const line = [['w', 'e1', 'f3'], ['b', 'e8', 'f6'], ['w', 'a2', 'a4'], ['b', 'b7', 'b5'], ['w', 'a4', 'b5'], ['b', 'a7', 'a6'], ['w', 'b5', 'a6'], ['b', 'h7', 'h6'], ['w', 'a6', 'a7'], ['b', 'h6', 'h5']];
  const sans = line.map(([color, from, to]) => play(room.roomId, 'km', color, from, to).san);
  checkEqual(sans, ['Kf3', 'Kf6', 'a4', 'b5', 'axb5', 'a6', 'bxa6', 'h6', 'a7', 'h5'], 'the wire notation: Kf3 / Kf6 = the royal knight');
  check(play(room.roomId, 'km', 'w', 'a7', 'b8', 'n').ok === false, 'a promotion to a KNIGHT is refused (there are no ordinary knights)');
  check(play(room.roomId, 'km', 'w', 'a7', 'b8', 'k').ok === false, 'a promotion to a king is refused');
  const promoted = play(room.roomId, 'km', 'w', 'a7', 'b8', 'm');
  check(promoted.ok === true && promoted.san === 'axb8=M', 'promotion to a COMMONER ("m") is accepted: axb8=M');
  const toBlack = sent.filter((s) => s.target === 'km-b' && s.event === 'opponent_move').at(-1);
  check(toBlack && toBlack.payload.promotion === 'm' && toBlack.payload.san === 'axb8=M', 'Black is told promotion "m" and san "axb8=M"');
  check(toBlack.payload.fen.startsWith('rMbq1bmr/'), 'the FEN carries the new white commoner as "M"');
  check(variantPgnTag({ ...flags }) === 'Knightmate', 'the saved PGN is tagged [Variant "Knightmate"]');
  const moves = [...sans, 'axb8=M'].map((san) => ({ san }));
  const pgn = buildPgn(KNIGHTMATE_START_FEN, moves, '*', 'Knightmate');
  check(pgn.includes('[Variant "Knightmate"]') && pgn.includes('1.Kf3 Kf6') && pgn.includes('6.axb8=M'), 'the PGN movetext carries K / M notation and "=M"');
  const spectate = rooms.spectate('watch', room.roomId);
  check(spectate.ok === true && spectate.state.isKnightmate === true, 'a spectator is told isKnightmate');
  const rejoin = rooms.rejoin('km-b2', { roomId: room.roomId, playerToken: room.blackPlayerToken });
  check(rejoin.ok === true && rejoin.state.isKnightmate === true, 'a rejoin answer is told isKnightmate');

  // The Commoner promotion does not exist outside Knightmate, whatever the position.
  const classic = open('cl', { knightmate: false });
  check(play(classic.roomId, 'cl', 'w', 'e2', 'e4', 'm').ok === false, 'promotion "m" is refused in an ordinary room');
  check(play(classic.roomId, 'cl', 'w', 'e2', 'e4').ok === true, '...while the plain move is fine');

  // The flag-fall rule on the real room clock (one second each): the wait ends on the game_over event, never on a fixed time.
  const gameOver = async (target) => {
    for (let i = 0; i < 100; i++) {
      const found = sent.find((s) => s.target === target && s.event === 'game_over');
      if (found) return found.payload;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return null;
  };
  const oneSecond = { initialSeconds: 1, incrementSeconds: 0 };
  open('t1', { timeControl: oneSecond, initialFen: '4k3/8/8/8/8/8/8/Q3K3 w - - 0 1' });
  const draw = await gameOver('t1-b');
  check(draw && draw.reason === 'timeout' && draw.winner === null, 'White flags against a bare royal knight: a DRAW (timeout, no winner)');
  open('t2', { timeControl: oneSecond, initialFen: '4k3/8/8/8/8/8/8/Q3K3 b - - 0 1' });
  const loss = await gameOver('t2-w');
  check(loss && loss.reason === 'timeout' && loss.winner === 'w', 'Black flags against an opponent with a queen: White wins on time');
  open('t3', { timeControl: oneSecond });
  const normal = await gameOver('t3-b');
  check(normal && normal.reason === 'timeout' && normal.winner === 'b', 'from the start position a flag still loses (Black wins on time)');
}

console.log(`\nAll ${passed} Knightmate server checks passed.`);
process.exit(0);
