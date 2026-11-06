#!/usr/bin/env node
/**
 * Racing Kings server-side regression suite -- no running server needed. Run with tsx:
 *   npx tsx scripts/test-racingKings.mjs      (or: npm run test:racingKings)
 *
 *  1. NO DRIFT: the shared rules block of backend/src/game/racingKings.ts must be byte-identical to the mobile app's
 *     src/logic/racingKings.ts (hand-mirrored -- there is no shared module).
 *  2. THE AUTHORITY: RoomManager.applyMove (driven with a stub socket server, no network). A Racing Kings room starts from the
 *     standard position; a move that gives check is refused; a king on rank 8 ends the game exactly as the rules say (Black
 *     first = Black wins, White first and Black cannot follow = White wins, White first and Black follows = DRAW with a null
 *     winner); a stalemate is a draw.
 *  3. PARITY with the mobile app: seeded random games are replayed through BOTH engines and every ply must agree on every
 *     candidate move (accepted by both or refused by both), the resulting FEN, and the game-over verdict.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ChessEngine as ClientEngine } from '../../src/logic/ChessEngine.ts';
import { getRacingKingsMoves as clientMoves, getRacingKingsOutcome as clientOutcome } from '../../src/logic/racingKings.ts';
import { RoomChessEngine } from '../src/game/RoomChessEngine.ts';
import { RACING_KINGS_START_FEN, racingKingsOutcome } from '../src/game/racingKings.ts';
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
  const mobile = block(new URL('../../src/logic/racingKings.ts', import.meta.url));
  const server = block(new URL('../src/game/racingKings.ts', import.meta.url));
  check(mobile.length > 800, 'the shared rules block was found in both files');
  check(mobile.includes('racingKingsOutcomeFromFen') && mobile.includes('RACING_KINGS_START_FEN'), '...and it contains the start position and the outcome rule');
  check(mobile === server, 'backend/src/game/racingKings.ts and src/logic/racingKings.ts have identical rules (edit BOTH together)');
}

// --- 2. The authority: RoomManager.applyMove ---------------------------------------------------------
console.log('\n=== 2. RoomManager plays Racing Kings by the rules ===');
function stubIo() {
  const events = [];
  return { events, to: (id) => ({ emit: (event, payload) => events.push({ id, event, payload }) }) };
}
function rkRoom(initialFen) {
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
    horde: false,
    racingKings: true,
    crazyhouse: false,
    ...(initialFen ? { initialFen } : {}),
  });
  const turn = (who, from, to) => manager.applyMove(who, { roomId: created.roomId, from, to });
  const room = () => manager.rooms.get(created.roomId);
  const gameOvers = () => io.events.filter((e) => e.event === 'game_over');
  return { io, manager, created, turn, room, gameOvers };
}
{
  const { created, room } = rkRoom();
  check(created.fen === RACING_KINGS_START_FEN, 'a Racing Kings room starts from the standard position');
  check(room().racingKings === true && room().horde === false, '...flagged racingKings and nothing else');
}
{
  // Giving check is illegal; a quiet move with the same piece is fine.
  const chk = rkRoom('8/8/7k/8/8/8/8/R3K3 w - - 0 1');
  check(chk.turn('W', 'a1', 'a6').ok === false, 'a rook move that gives check is refused');
  check(chk.room().engine.getFen() === '8/8/7k/8/8/8/8/R3K3 w - - 0 1', '...and nothing was played');
  check(chk.turn('W', 'a1', 'a5').ok === true, 'a quiet rook move is accepted');
}
{
  // Black reaches rank 8 first: Black wins at once.
  const blackFirst = rkRoom('8/6k1/8/8/8/8/K7/8 b - - 0 1');
  check(blackFirst.turn('B', 'g7', 'g8').ok === true, 'Black king steps onto rank 8');
  const over = blackFirst.gameOvers();
  check(over.length === 2 && over.every((e) => e.payload.reason === 'racingKings' && e.payload.winner === 'b'), "Black wins with reason 'racingKings' when it gets there first");
}
{
  // White reaches rank 8 first and Black cannot follow: White wins at once.
  const whiteWins = rkRoom('8/6K1/8/8/8/8/8/k7 w - - 0 1');
  check(whiteWins.turn('W', 'g7', 'g8').ok === true, 'White king steps onto rank 8');
  const over = whiteWins.gameOvers();
  check(over.length === 2 && over.every((e) => e.payload.reason === 'racingKings' && e.payload.winner === 'w'), 'White wins when Black cannot reach rank 8 with its reply');
}
{
  // Black's king on g7, White's on b7: White steps to rank 8, Black follows -> draw with a null winner.
  const draw = rkRoom('8/1K4k1/8/8/8/8/r7/R7 w - - 0 1');
  check(draw.turn('W', 'b7', 'b8').ok === true, 'White king reaches rank 8 first');
  check(draw.gameOvers().length === 0 && draw.room().status === 'active', '...the game is NOT over: Black can still reach rank 8');
  check(draw.turn('B', 'g7', 'g8').ok === true, 'Black king follows onto rank 8');
  const over = draw.gameOvers();
  check(over.length === 2 && over.every((e) => e.payload.reason === 'racingKings' && e.payload.winner === null), "both kings on rank 8 is a DRAW: reason 'racingKings', winner null");
}
{
  // White on rank 8, Black replies with a non-reaching move: White wins (Black could have followed, it did not).
  const miss = rkRoom('8/1K4k1/8/8/8/8/r7/R7 w - - 0 1');
  miss.turn('W', 'b7', 'b8');
  check(miss.turn('B', 'g7', 'g6').ok === true, 'Black declines to follow');
  const over = miss.gameOvers();
  check(over.length === 2 && over.every((e) => e.payload.winner === 'w' && e.payload.reason === 'racingKings'), 'White wins when Black does not reach rank 8 on its reply');
}
{
  // Stalemate is a draw.
  const stale = rkRoom('6r1/8/8/8/k7/8/1r6/7K w - - 0 1');
  check(stale.room().engine.getStatus() === 'stalemate', 'a side with no check-free move is stalemated');
}
{
  // Pure functions on the server side.
  const e = new RoomChessEngine('K7/8/8/8/8/8/8/k7 b - - 0 1', { racingKings: true });
  check(racingKingsOutcome(e) === 'w', 'racingKingsOutcome: White on rank 8, Black unable to follow -> w');
  const e2 = new RoomChessEngine('K7/6k1/8/8/8/8/8/8 b - - 0 1', { racingKings: true });
  check(racingKingsOutcome(e2) === null, 'racingKingsOutcome: White on rank 8, Black able to follow -> undecided');
}

// --- 3. Parity with the mobile engine ------------------------------------------------------------------
console.log('\n=== 3. Server and mobile engines agree over seeded random games ===');
{
  const SQUARES = [];
  for (const f of 'abcdefgh') for (const r of '12345678') SQUARES.push(`${f}${r}`);
  let plies = 0;
  let candidates = 0;
  for (let game = 0; game < 25; game++) {
    const rng = seeded(1000 + game);
    let fen = RACING_KINGS_START_FEN;
    for (let ply = 0; ply < 80; ply++) {
      const client = new ClientEngine(fen, { racingKings: true });
      const server = new RoomChessEngine(fen, { racingKings: true });
      assert.equal(server.isGameOver(), client.isGameOver(), `isGameOver agrees at ${fen}`);
      assert.equal(server.getStatus(), client.getStatus(), `status agrees at ${fen}`);
      assert.equal(racingKingsOutcome(server), clientOutcome(client), `goal outcome agrees at ${fen}`);
      if (client.isGameOver() || clientOutcome(client)) break;
      const legal = clientMoves(client);
      // every legal move for the client is accepted by the server; a handful of random attempts agree both ways
      const attempts = [...legal.map((m) => [m.from, m.to])];
      for (let i = 0; i < 6; i++) attempts.push([SQUARES[Math.floor(rng() * 64)], SQUARES[Math.floor(rng() * 64)]]);
      for (const [from, to] of attempts) {
        const c = new ClientEngine(fen, { racingKings: true }).move(from, to);
        const s = new RoomChessEngine(fen, { racingKings: true }).move(from, to);
        assert.equal(Boolean(s), Boolean(c), `move ${from}${to} accepted by both or refused by both at ${fen}`);
        candidates++;
      }
      if (legal.length === 0) break;
      const pick = legal[Math.floor(rng() * legal.length)];
      client.move(pick.from, pick.to);
      server.move(pick.from, pick.to);
      assert.equal(server.getFen(), client.getFen(), `FEN agrees after ${pick.from}${pick.to}`);
      fen = client.getFen();
      plies++;
    }
  }
  check(plies > 200 && candidates > 1000, `25 seeded games: ${plies} plies and ${candidates} candidate moves agree between the two engines`);
}

console.log(`\nAll ${passed} Racing Kings checks passed.`);
