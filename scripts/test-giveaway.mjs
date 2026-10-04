#!/usr/bin/env node
/**
 * Giveaway (Antichess) server-side regression suite — no running server needed. Run with tsx:
 *   npx tsx scripts/test-giveaway.mjs      (or: npm run test:giveaway)
 *
 * Three layers, mirroring how Fog of War is covered:
 *  1. RULES on the server's own implementation (src/game/giveaway.ts + RoomChessEngine's `giveaway`
 *     option), on hand-written positions: mandatory capture is global, en passant counts, kings are
 *     ordinary capturable pieces and capturing one is NOT a win, being stuck WINS, castling is gone,
 *     a pawn may promote to a king, SAN carries no '+'/'#'.
 *  2. THE AUTHORITY: RoomManager.applyMove (driven with a stub socket server, no network) rejects any
 *     move outside the legal Giveaway set — the exact "client submits an illegal non-capturing move"
 *     gap this suite exists to keep closed — accepts the legal ones, and declares the winner.
 *  3. PARITY with the mobile app: random Giveaway games are replayed through BOTH implementations
 *     (the frontend's src/logic/giveaway.ts + ChessEngine, and the backend's) and every ply must
 *     agree on the legal move set, the applied move's SAN/capture, the resulting FEN and the winner.
 */
import assert from 'node:assert/strict';
import { ChessEngine as ClientEngine } from '../../src/logic/ChessEngine.ts';
import { getGiveawayMoves as clientMoves, getGiveawayWinner as clientWinner } from '../../src/logic/giveaway.ts';
import { RoomChessEngine, START_FEN } from '../src/game/RoomChessEngine.ts';
import { getGiveawayMoves, getGiveawayWinner, isLegalGiveawayMove } from '../src/game/giveaway.ts';
import { RoomManager } from '../src/game/rooms.ts';

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ✓ ${message}`);
}
const giveawayEngine = (fen) => new RoomChessEngine(fen, { giveaway: true });
const uci = (moves) => moves.map((m) => `${m.from}${m.to}${m.promotion ?? ''}`).sort();

function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- 1. Rules --------------------------------------------------------------------------------
console.log('\n=== 1. Rules on the server implementation ===');
{
  // White: Ke1, Ra1, Pe4. Black: Ke8, Pd5. Only e4xd5 captures anything.
  const FEN = '4k3/8/8/3p4/4P3/8/8/R3K3 w - - 0 1';
  const engine = giveawayEngine(FEN);
  check(uci(getGiveawayMoves(engine)).join() === 'e4d5', 'when only one piece can capture, that capture is the ONLY legal move on the whole board');
  check(getGiveawayMoves(engine, 'a1').length === 0 && getGiveawayMoves(engine, 'e1').length === 0, "every other piece's move list collapses to empty (the rule is global, not per piece)");
  const free = giveawayEngine('4k3/8/8/8/8/8/8/R3K3 w - - 0 1');
  check(getGiveawayMoves(free).length === free.getPseudoLegalMoves('w').length, 'with no capture available anywhere every ordinary move stays legal');
  check(uci(getGiveawayMoves(giveawayEngine('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1'))).join() === 'e5d6', 'en passant counts as a capture, so it becomes the only legal move');
  check(uci(getGiveawayMoves(giveawayEngine('4k3/8/8/3p4/4P3/8/8/3RK3 w - - 0 1'))).join() === 'd1d5,e4d5', 'a capture offered by several pieces keeps all of them');
}
{
  // Kings are ordinary pieces: Ra1xa8 captures the black king and the game simply goes on.
  const engine = giveawayEngine('k7/7p/8/8/8/8/8/R3K3 w - - 0 1');
  check(uci(getGiveawayMoves(engine)).join() === 'a1a8', 'a king may be captured like any other piece');
  const move = engine.movePseudoLegal('a1', 'a8');
  check(move?.captured === 'k', 'the capture of a king is applied');
  check(getGiveawayWinner(engine) === null, 'capturing a king is NOT a win — the game continues (there is no king-capture win condition in Giveaway)');
}
{
  const stuck = giveawayEngine('8/8/8/8/p7/P7/8/8 b - - 0 1');
  check(getGiveawayMoves(stuck).length === 0 && getGiveawayWinner(stuck) === 'b', 'a side to move with no legal move WINS (stuck wins, it does not lose)');
  const noPieces = giveawayEngine('8/8/8/8/8/8/8/4K3 b - - 0 1');
  check(getGiveawayWinner(noPieces) === 'b', 'a side with no pieces left also wins');
}
{
  const castling = giveawayEngine('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  check(!getGiveawayMoves(castling).some((m) => m.from === 'e1' && (m.to === 'g1' || m.to === 'c1')), 'castling is never offered');
  check(new RoomChessEngine('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1').getPseudoLegalMoves('w').some((m) => m.from === 'e1' && m.to === 'g1'), '...while an ordinary engine still offers it (the option is opt-in)');
  const promo = giveawayEngine('8/4P3/8/8/8/8/8/k6K w - - 0 1');
  check(uci(getGiveawayMoves(promo, 'e7')).join() === 'e7e8b,e7e8k,e7e8n,e7e8q,e7e8r', 'a pawn may promote to a king as well as q/r/b/n');
  const applied = promo.movePseudoLegal('e7', 'e8', 'k');
  check(applied?.promotion === 'k' && /=K$/.test(applied.san), 'a king promotion applies and is written =K');
  // A promoted king may be a SECOND king of a colour; the live engine must keep it through later plies.
  const second = giveawayEngine('7k/4P3/8/8/8/8/8/K7 w - - 0 1');
  second.movePseudoLegal('e7', 'e8', 'k');
  second.movePseudoLegal('h8', 'g8');
  check(second.getFen().split(' ')[0] === '4K1k1/8/8/8/8/8/8/K7', 'a promoted second king (own king alive) survives later plies on the live server engine');
  check(getGiveawayMoves(second, 'e8').length > 0 && getGiveawayMoves(second, 'a1').length > 0, '...and both kings can move');
  const sanEngine = giveawayEngine('4k3/8/8/8/8/8/8/R3K3 w - - 0 1');
  check(sanEngine.movePseudoLegal('a1', 'a8')?.san === 'Ra8', "SAN has no '+' even though chess.js would call it check");
}

// --- 2. The authority: RoomManager.applyMove -------------------------------------------------
console.log('\n=== 2. RoomManager validates Giveaway moves ===');
function stubIo() {
  const events = [];
  return { events, to: (id) => ({ emit: (event, payload) => events.push({ id, event, payload }) }) };
}
function giveawayRoom(initialFen) {
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
    giveaway: true,
    initialFen,
  });
  return { io, manager, roomId: created.roomId };
}
{
  const { manager, roomId, io } = giveawayRoom();
  check((await manager.applyMove('W', { roomId, from: 'e2', to: 'e4' })).ok === true, 'a quiet first move is legal while no capture exists');
  check((await manager.applyMove('B', { roomId, from: 'd7', to: 'd5' })).ok === true, 'a quiet reply is legal too');
  const refused = manager.applyMove('W', { roomId, from: 'g1', to: 'f3' });
  check(refused.ok === false && /capture is mandatory/i.test(refused.error), 'a non-capturing move is REJECTED while a capture exists, with a mandatory-capture message');
  check(manager.applyMove('W', { roomId, from: 'e4', to: 'e5' }).ok === false, 'a pawn push is rejected for the same reason');
  const castle = manager.applyMove('W', { roomId, from: 'e1', to: 'g1' });
  check(castle.ok === false, 'an illegal move of any other kind is still rejected');
  const taken = manager.applyMove('W', { roomId, from: 'e4', to: 'd5' });
  check(taken.ok === true && taken.san === 'exd5', 'the mandatory capture is accepted');
  check(io.events.some((e) => e.id === 'B' && e.event === 'opponent_move' && e.payload.san === 'exd5'), 'and relayed to the opponent');
  check(manager.applyMove('B', { roomId, from: 'd8', to: 'd5' }).ok === true, "Black's own mandatory recapture (Qxd5) is accepted");
}
{
  // The only legal move (a2-a3) leaves Black blocked, so Black wins on the spot.
  const { manager, roomId, io } = giveawayRoom('8/8/8/8/p7/8/P7/8 w - - 0 1');
  const ack = manager.applyMove('W', { roomId, from: 'a2', to: 'a3' });
  check(ack.ok === true, 'the forced blocking move is accepted');
  const over = io.events.filter((e) => e.event === 'game_over');
  check(over.length === 2 && over.every((e) => e.payload.reason === 'giveaway' && e.payload.winner === 'b'), 'both players get game_over {reason: "giveaway", winner: black} — the side left with no legal move WINS');
}
{
  // Capturing a king ends nothing: Black still has a legal move afterwards.
  const { manager, roomId, io } = giveawayRoom('k7/7p/8/8/8/8/8/R3K3 w - - 0 1');
  const ack = manager.applyMove('W', { roomId, from: 'a1', to: 'a8' });
  check(ack.ok === true, 'capturing the king is just the mandatory capture');
  check(!io.events.some((e) => e.event === 'game_over'), 'no game_over is sent — capturing a king is not a win condition in Giveaway');
}
{
  // A client forging a king promotion in a classic room is refused.
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
    initialFen: '8/4P3/8/8/8/8/8/k6K w - - 0 1',
  });
  const ack = manager.applyMove('W', { roomId: created.roomId, from: 'e7', to: 'e8', promotion: 'k' });
  check(ack.ok === false, "a king promotion is refused outside Giveaway");
}

// --- 3. Parity with the mobile app ----------------------------------------------------------
console.log('\n=== 3. Parity with the mobile implementation (random Giveaway games) ===');
{
  const problems = [];
  const seen = { games: 0, plies: 0, finished: 0, kingCaptures: 0, kingPromotions: 0, captures: 0 };
  for (let g = 0; g < 120 && problems.length < 5; g++) {
    const random = seeded(7000 + g);
    const server = giveawayEngine(START_FEN);
    let clientFen = START_FEN;
    seen.games++;
    for (let ply = 0; ply < 220; ply++) {
      const client = new ClientEngine(clientFen, { skipValidation: true, giveaway: true });
      const serverMoves = getGiveawayMoves(server);
      const clientSideMoves = clientMoves(client);
      if (uci(serverMoves).join() !== uci(clientSideMoves).join()) {
        problems.push(`game ${g} ply ${ply}: legal moves differ in ${server.getFen()}`);
        break;
      }
      const sw = getGiveawayWinner(server);
      const cw = clientWinner(client);
      if (sw !== cw) {
        problems.push(`game ${g} ply ${ply}: winner ${sw} vs ${cw} in ${server.getFen()}`);
        break;
      }
      if (sw) {
        seen.finished++;
        break;
      }
      const pick = serverMoves[Math.floor(random() * serverMoves.length)];
      if (!isLegalGiveawayMove(server, pick.from, pick.to, pick.promotion)) {
        problems.push(`game ${g} ply ${ply}: offered move ${pick.from}${pick.to} fails isLegalGiveawayMove`);
        break;
      }
      const a = server.movePseudoLegal(pick.from, pick.to, pick.promotion);
      const b = client.movePseudoLegal(pick.from, pick.to, pick.promotion);
      if (!a || !b || a.san !== b.san || a.captured !== b.captured || a.promotion !== b.promotion) {
        problems.push(`game ${g} ply ${ply}: applied move differs ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
        break;
      }
      if (server.getFen() !== client.getFen()) {
        problems.push(`game ${g} ply ${ply}: FEN differs ${server.getFen()} vs ${client.getFen()}`);
        break;
      }
      clientFen = client.getFen();
      seen.plies++;
      if (a.captured) seen.captures++;
      if (a.captured === 'k') seen.kingCaptures++;
      if (a.promotion === 'k') seen.kingPromotions++;
    }
  }
  check(problems.length === 0, `server and mobile agree on every ply of ${seen.plies} plies / ${seen.games} games${problems.length ? ` — ${problems.slice(0, 3).join(' | ')}` : ''}`);
  check(seen.captures > 500, `the random games really exercised captures (${seen.captures})`);
  check(seen.kingCaptures > 0, `...king captures (${seen.kingCaptures})`);
  check(seen.finished > 0, `...and games that end by a side being stuck (${seen.finished})`);
  console.log(`  (king promotions seen: ${seen.kingPromotions})`);
}

console.log(`\nAll good — ${passed} checks passed.`);
process.exit(0);
