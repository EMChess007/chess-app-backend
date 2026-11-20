#!/usr/bin/env node
/**
 * From Position (command #53) server-side regression suite -- no running server needed. Run with tsx:
 *   npx tsx scripts/test-from-position.mjs      (or: npm run test:fromPosition)
 *
 *  1. PARITY: the server's validateFromPositionFen (src/game/fromPosition.ts) and the app's
 *     normalizePlayFen + validateEditorFen(fen, { forPlay: true }) (src/logic/boardEditor.ts) are run on one corpus (hand-picked cases + a seeded
 *     random one: real positions from random games, then with the turn, castling field and en passant square scrambled) and must agree on
 *     accept/refuse, on the normalized FEN and on the English message.
 *  2. THE ROOM: RoomManager (stub socket server, no network) starts a room from a validated FEN, answers rejoin / spectate with that start FEN,
 *     and the PGN of the game carries [SetUp "1"] [FEN "..."] with Black's first move numbered "1..." from the FEN's own move number.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';
import { normalizePlayFen as clientNormalize, validateEditorFen } from '../../src/logic/boardEditor.ts';
import { validateFromPositionFen } from '../src/game/fromPosition.ts';
import { buildPgn } from '../src/game/pgn.ts';
import { RoomManager } from '../src/game/rooms.ts';

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ✓ ${message}`);
}

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function compare(raw) {
  const server = validateFromPositionFen(raw);
  const fen = clientNormalize(raw);
  const client = validateEditorFen(fen, { forPlay: true });
  if (server.ok !== client.ok) return `ok differs for ${JSON.stringify(raw)}: server ${server.ok}, client ${client.ok}`;
  if (server.ok) return server.fen === fen ? null : `normalized fen differs for ${JSON.stringify(raw)}: ${server.fen} vs ${fen}`;
  return server.error === client.error ? null : `message differs for ${JSON.stringify(raw)}: "${server.error}" vs "${client.error}"`;
}

console.log('\n=== 1. parity with the app validator ===');
const HAND = [
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -',
  '  rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR   b   KQkq  -  3  9 ',
  'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2',
  '4k3/8/8/8/8/8/8/4K2R w K - 0 1',
  '4k3/8/8/8/8/8/8/4K2R w Kq - 0 1',
  '4k3/8/8/8/8/8/8/4K3 w K - 0 1',
  '4k3/8/8/8/8/8/8/4K3 w - e6 0 1',
  '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 3',
  '4k3/8/3p4/4P3/8/8/8/4K3 w - d6 0 3',
  '4k3/8/8/8/3Pp3/8/8/4K3 b - d3 0 3',
  '4k3/8/8/8/8/8/4q3/4K2R b K - 0 1',
  '7k/6Q1/6K1/8/8/8/8/8 b - - 0 1',
  '7k/5Q2/8/6K1/8/8/8/8 b - - 0 1',
  '4k3/8/8/8/8/8/8/4K3 w - - 0 1',
  '4k3/8/8/8/8/8/8/4K3 w - - 100 80',
  '4k3/pppp4/8/8/8/8/4PPPP/4K3 b - - 0 7',
  '8/8/8/8/8/8/8/4K3 w - - 0 1',
  '4k3/8/8/8/8/8/8/4K3 x - - 0 1',
  'not a fen',
  '',
];
for (const fen of HAND) {
  const diff = compare(fen);
  check(diff === null, `hand-picked ${JSON.stringify(fen)} agrees`);
}

const rand = mulberry32(53);
const SQUARES_EP = ['-', '-', '-', 'e3', 'e6', 'd3', 'd6', 'a3', 'h6', 'c4'];
let random = 0;
let accepted = 0;
const diffs = [];
for (let i = 0; i < 700; i++) {
  const game = new Chess();
  const plies = Math.floor(rand() * 90);
  for (let p = 0; p < plies && !game.isGameOver(); p++) {
    const moves = game.moves();
    game.move(moves[Math.floor(rand() * moves.length)]);
  }
  const fields = game.fen().split(' ');
  if (rand() < 0.5) fields[1] = fields[1] === 'w' ? 'b' : 'w';
  if (rand() < 0.4) fields[2] = ['KQkq', 'K', 'q', 'Qk', '-', 'KQ'][Math.floor(rand() * 6)];
  if (rand() < 0.4) fields[3] = SQUARES_EP[Math.floor(rand() * SQUARES_EP.length)];
  const raw = rand() < 0.2 ? fields.slice(0, 4).join(' ') : fields.join(' ');
  random++;
  if (validateFromPositionFen(raw).ok) accepted++;
  const diff = compare(raw);
  if (diff) diffs.push(diff);
}
check(diffs.length === 0, `${random} seeded random positions: server and app validators agree on every one (${diffs[0] ?? 'no difference'})`);
check(accepted > 100 && accepted < random - 100, `the random corpus really exercises both outcomes (${accepted} accepted, ${random - accepted} refused)`);

console.log('\n=== 2. the room, rejoin, spectate and PGN keep the start FEN ===');
const START = '4k3/pppp4/8/8/8/8/4PPPP/4K3 b - - 0 7';
const sent = [];
const stubIo = { to: () => ({ emit: (event, payload) => sent.push({ event, payload }) }) };
const rooms = new RoomManager(stubIo);
const checked = validateFromPositionFen(START);
check(checked.ok && checked.fen === START, 'the FEN is accepted unchanged');
const created = rooms.createRoom({
  white: { socketId: 'sw', userId: null },
  black: { socketId: 'sb', userId: null },
  timeControl: { initialSeconds: 300, incrementSeconds: 0 },
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
  racingKings: false,
  torpedo: false,
  knightmate: false,
  crazyhouse: false,
  initialFen: checked.fen,
  fromPosition: true,
});
check(created.fen === START, 'createRoom answers with the start FEN');
const m1 = rooms.applyMove('sb', { roomId: created.roomId, from: 'a7', to: 'a5' });
check(m1.ok === true && m1.san === 'a5', 'Black moves first');
const m2 = rooms.applyMove('sw', { roomId: created.roomId, from: 'e2', to: 'e4' });
check(m2.ok === true, 'White answers');
const rejoin = rooms.rejoin('sb2', { roomId: created.roomId, playerToken: created.blackPlayerToken });
check(rejoin.ok === true && rejoin.state.initialFen === START && rejoin.state.isFromPosition === true && rejoin.state.moves.length === 2, 'rejoin: start FEN + flag + both moves');
const spectate = rooms.spectate('watch', created.roomId);
check(spectate.ok === true && spectate.state.initialFen === START && spectate.state.isFromPosition === true, 'spectate: start FEN + flag');

const classic = rooms.createRoom({
  white: { socketId: 'cw', userId: null },
  black: { socketId: 'cb', userId: null },
  timeControl: { initialSeconds: 300, incrementSeconds: 0 },
  chess960: false, kingOfTheHill: false, threeCheck: false, setupChess: false, fogOfWar: false, giveaway: false, atomic: false,
  duckChess: false, spellChess: false, horde: false, racingKings: false, torpedo: false, knightmate: false, crazyhouse: false,
});
const classicRejoin = rooms.rejoin('cb2', { roomId: classic.roomId, playerToken: classic.blackPlayerToken });
check(classicRejoin.ok === true && classicRejoin.state.initialFen === undefined && classicRejoin.state.isFromPosition === undefined, 'an ordinary room carries neither field (wire unchanged)');

const pgn = buildPgn(START, [{ san: 'a5' }, { san: 'e4' }], '0-1');
check(pgn.includes('[SetUp "1"]') && pgn.includes(`[FEN "${START}"]`), 'the PGN has [SetUp "1"] and [FEN "..."]');
check(/7\.\.\.a5 8\.e4/.test(pgn), 'Black\'s first move is numbered "7..." from the FEN\'s own move number');
const roomsSource = readFileSync(new URL('../src/game/rooms.ts', import.meta.url), 'utf8');
check(roomsSource.includes('buildPgn(room.initialFen,'), 'the saved game row is built from room.initialFen (source pin; the DB write itself is not exercised here)');

console.log(`\nAll good - ${passed} checks passed.`);
process.exit(0);
