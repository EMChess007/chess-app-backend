#!/usr/bin/env node
/**
 * Fog of War castling — server-side regression suite, no running server needed. Run with tsx:
 *   npx tsx scripts/test-fogOfWarCastling.mjs      (or: npm run test:fogOfWarCastling)
 *
 * THE RULE (chess.com, "What is Fog of War chess?"): "the king can castle while in check, and can castle through, or
 * into check". So in Fog of War castling needs ONLY: king and rook unmoved (castling rights), the squares between them
 * empty, the target squares free — no attacked-square conditions. chess.js's pseudo-legal generator still withholds the
 * castle in those three cases, which made the server refuse e1-c1 on a true board where a HIDDEN piece attacked the
 * king while the client (which only sees its own fog) offered it: a rules bug AND an information leak (the refusal says
 * "a hidden piece attacks your king"). Found by nightly #18 / backend issue #12 (game 171, ply 42).
 *
 * Layers:
 *  1. NO DRIFT: the `unrestricted-castles` block of RoomChessEngine.ts is byte-identical to the mobile ChessEngine.ts.
 *  2. THE RULE on both engines: out of / through / into check, both sides, both colours, plus everything that still
 *     forbids a castle (rights, blocked squares, missing rook) and the variants that must NOT change (an ordinary
 *     engine, Spell Chess, Giveaway).
 *  3. GAME 171 PLY 42: the exact position, through RoomManager.applyMove (the authority) with a stub socket server.
 *  4. PARITY: random castling-rich positions must give the same pseudo-legal set and the same resulting FEN on both engines.
 *  5. NO LEAK, STRICT (the nightly classifier as a property): for random true positions, EVERY move the player's own
 *     redacted view offers is accepted by the server — except a quiet pawn push into a hidden piece (the one accepted
 *     "blind move" outcome). Anything else is a refusal that depends on hidden information.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ChessEngine as ClientEngine } from '../../src/logic/ChessEngine.ts';
import { RoomChessEngine } from '../src/game/RoomChessEngine.ts';
import { buildRedactedFen } from '../src/game/fogOfWar.ts';
import { RoomManager } from '../src/game/rooms.ts';

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ✓ ${message}`);
}
const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);
const ENGINES = [
  ['mobile ChessEngine', (fen) => new ClientEngine(fen, { skipValidation: true })],
  ['server RoomChessEngine', (fen) => new RoomChessEngine(fen, { skipValidation: true })],
];
const castlesOf = (engine, color) => {
  const rank = color === 'w' ? '1' : '8';
  return engine
    .getPseudoLegalMoves(color)
    .filter((m) => m.from === `e${rank}` && (m.to === `g${rank}` || m.to === `c${rank}`))
    .map((m) => m.to)
    .sort();
};

function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- 1. No drift -----------------------------------------------------------------------------------
console.log('\n=== 1. The castling block is a verbatim copy of the mobile one ===');
{
  const START = '// BEGIN unrestricted-castles';
  const END = '// END unrestricted-castles';
  const block = (path) => {
    const text = readFileSync(path, 'utf8').split(CRLF).join(LF);
    return text.slice(text.indexOf(START), text.indexOf(END));
  };
  const mobile = block(new URL('../../src/logic/ChessEngine.ts', import.meta.url));
  const server = block(new URL('../src/game/RoomChessEngine.ts', import.meta.url));
  check(mobile.length > 1200, 'the unrestricted-castles block was found in both engines');
  check(mobile === server, 'ChessEngine.ts and RoomChessEngine.ts castle identically (edit BOTH together)');
}

// --- 2. The rule, on both engines ------------------------------------------------------------------
console.log('\n=== 2. Castling out of, through and into check (both engines) ===');
const OUT = '4r2k/8/8/8/8/8/8/R3K2R w KQ - 0 1'; // rook e8 checks the king
const THROUGH_K = '5r1k/8/8/8/8/8/8/R3K2R w KQ - 0 1';
const INTO_K = '6rk/8/8/8/8/8/8/R3K2R w KQ - 0 1';
const THROUGH_Q = '3r3k/8/8/8/8/8/8/R3K2R w KQ - 0 1';
const INTO_Q = '2r4k/8/8/8/8/8/8/R3K2R w KQ - 0 1';
for (const [name, make] of ENGINES) {
  console.log(` -- ${name}`);
  for (const [label, fen] of [['out of check', OUT], ['through check (f1)', THROUGH_K], ['into check (g1)', INTO_K], ['through check (d1)', THROUGH_Q], ['into check (c1)', INTO_Q]]) {
    check(JSON.stringify(castlesOf(make(fen), 'w')) === JSON.stringify(['c1', 'g1']), `${label}: both castles are offered`);
  }
  const after = (fen, to) => {
    const e = make(fen);
    return [e.movePseudoLegal('e1', to), e.getFen()];
  };
  check(JSON.stringify(castlesOf(make('7k/8/8/8/8/8/8/R3K2R w KQ - 0 1'), 'w')) === JSON.stringify(['c1', 'g1']), 'a castle chess.js already offers is not added a second time');
  let [m, f] = after(OUT, 'g1');
  check(m && m.san.startsWith('O-O') && f === '4r2k/8/8/8/8/8/8/R4RK1 b - - 1 1', 'O-O out of check lands king g1 + rook f1 and spends the rights');
  [m, f] = after(THROUGH_Q, 'c1');
  check(m && m.san.startsWith('O-O-O') && f === '3r3k/8/8/8/8/8/8/2KR3R b - - 1 1', 'O-O-O through an attacked d1 lands king c1 + rook d1');
  [m, f] = after(INTO_K, 'g1');
  check(m && f === '6rk/8/8/8/8/8/8/R4RK1 b - - 1 1', 'O-O onto an attacked g1 is played');
  check(JSON.stringify(castlesOf(make('r3k2r/8/8/8/8/8/8/4R2K b kq - 0 1'), 'b')) === JSON.stringify(['c8', 'g8']), 'black castles out of check too');
  const blackThrough = make('r3k2r/8/8/8/8/8/8/5R1K b kq - 0 1');
  check(blackThrough.movePseudoLegal('e8', 'g8') !== null && blackThrough.getFen() === 'r4rk1/8/8/8/8/8/8/5R1K w - - 1 2', 'black O-O through an attacked f8');
  for (const [label, fen, expected] of [
    ['no right on that side', '4r2k/8/8/8/8/8/8/R3K2R w Q - 0 1', ['c1']],
    ['no rights at all', '4r2k/8/8/8/8/8/8/R3K2R w - - 0 1', []],
    ['own piece on f1', '4r2k/8/8/8/8/8/8/R3KB1R w KQ - 0 1', ['c1']],
    ['enemy piece on g1', '4r2k/8/8/8/8/8/8/R3K1rR w KQ - 0 1', ['c1']],
    ['piece on b1 (queenside only)', '4r2k/8/8/8/8/8/8/Rn2K2R w KQ - 0 1', ['g1']],
    ['piece on d1', '4r2k/8/8/8/8/8/8/R2nK2R w KQ - 0 1', ['g1']],
    ['rook gone, right still flagged', '4r2k/8/8/8/8/8/8/4K2R w KQ - 0 1', ['g1']],
    ['king not on e1', '4r2k/8/8/8/8/8/8/R2K3R w KQ - 0 1', []],
    ['a knight on e1 (rights still flagged)', '4r2k/8/8/8/8/8/K7/R3N2R w KQ - 0 1', []],
    ['the enemy king on e1', '4r3/8/8/8/8/8/K7/R3k2R w KQ - 0 1', []],
  ]) {
    check(JSON.stringify(castlesOf(make(fen), 'w')) === JSON.stringify(expected), `still forbidden — ${label}`);
  }
}
console.log(' -- variants that must not change');
{
  const ordinary = new RoomChessEngine(THROUGH_K);
  check(ordinary.move('e1', 'g1') === null && new RoomChessEngine(OUT).move('e1', 'g1') === null, 'an ordinary engine still refuses castling through / out of check');
  const spell = (fen) => new RoomChessEngine(fen, { spellChess: true, freezeEscapeActive: true });
  check(!spell(OUT).getPseudoLegalMoves('w').some((m) => m.from === 'e1' && m.to === 'g1'), 'Spell Chess (freeze-escape uses the pseudo-legal API) keeps chess.js castling: none out of check');
  check(spell('7k/8/8/8/8/8/8/R3K2R w KQ - 0 1').getPseudoLegalMoves('w').filter((m) => m.from === 'e1' && Math.abs(m.to.charCodeAt(0) - 101) === 2).length === 2, '...and still offers the ordinary castles');
  const giveaway = new RoomChessEngine('7k/8/8/8/8/8/8/R3K2R w KQ - 0 1', { giveaway: true });
  check(!giveaway.getPseudoLegalMoves('w').some((m) => m.from === 'e1' && (m.to === 'g1' || m.to === 'c1')), 'Giveaway still has no castling');
}

// --- 3. Game 171 ply 42 through the authority ------------------------------------------------------
console.log('\n=== 3. Game 171 ply 42 through RoomManager.applyMove ===');
function stubIo() {
  const events = [];
  return { events, to: (id) => ({ emit: (event, payload) => events.push({ id, event, payload }) }) };
}
function fogRoom(initialFen) {
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
    fogOfWar: true,
    giveaway: false,
    atomic: false,
    duckChess: false,
    initialFen,
  });
  const move = (who, from, to, promotion) => manager.applyMove(who, { roomId: created.roomId, from, to, promotion });
  return { io, manager, created, move };
}
const TRUTH_171 = '1b2k3/8/8/8/Pb3B2/N2P1p1N/2P1P1BP/R3K2R w KQ - 0 22'; // bishop b4 (hidden from White) checks e1
const VIEW_171 = '1b6/8/8/8/P4B2/N2P1p1N/2P1P1BP/R3K2R w KQ - 0 22'; // what White's client holds
{
  const { created, move, io } = fogRoom(TRUTH_171);
  check(created.whiteView.fen === VIEW_171, "White's redacted view is exactly the fog view the client held in the failing game (no black king, no bishop b4)");
  const client = new ClientEngine(created.whiteView.fen, { skipValidation: true });
  check(client.getPseudoLegalMoves('w').some((m) => m.from === 'e1' && m.to === 'c1'), "the client offers e1-c1 from its fog view");
  const res = move('W', 'e1', 'c1');
  check(res.ok === true && res.san === 'O-O-O', 'the server ACCEPTS it although a hidden bishop attacks the king (was: "Invalid move.")');
  check(res.fen.split(' ')[0].includes('2KR3R'), 'the acknowledged position has king c1 + rook d1');
  check(io.events.some((e) => e.id === 'B' && e.event === 'opponent_move'), 'the opponent is told something happened');
}
{
  // Negative control with the SAME hidden attacker: a pawn push into a hidden piece is still the one accepted refusal.
  const { move } = fogRoom('4k3/8/8/8/8/1p6/1P6/R3K2R w KQ - 0 1');
  const res = move('W', 'b2', 'b3');
  check(res.ok === false && res.error === 'Invalid move.', 'the blind pawn push into a hidden piece is still refused (the accepted fog mechanic)');
}

// --- 4. Parity on random castling-rich positions ---------------------------------------------------
const FILES = 'abcdefgh';
function randomPosition(rng) {
  const board = Array.from({ length: 8 }, () => Array(8).fill(null)); // [rank index 0 = rank 8][file]
  const put = (sq, p) => {
    board[8 - Number(sq[1])][FILES.indexOf(sq[0])] = p;
  };
  const rights = [];
  const castleRich = rng() < 0.85;
  if (castleRich) {
    put('e1', 'K');
    put('e8', 'k');
    if (rng() < 0.9) (put('h1', 'R'), rights.push('K'));
    if (rng() < 0.9) (put('a1', 'R'), rights.push('Q'));
    if (rng() < 0.9) (put('h8', 'r'), rights.push('k'));
    if (rng() < 0.9) (put('a8', 'r'), rights.push('q'));
  } else {
    put(`${FILES[Math.floor(rng() * 8)]}${1 + Math.floor(rng() * 8)}`, 'K');
  }
  const extras = 'qrbnpQRBNP';
  for (let i = Math.floor(rng() * 14); i > 0; i--) {
    const sq = `${FILES[Math.floor(rng() * 8)]}${1 + Math.floor(rng() * 8)}`;
    if (board[8 - Number(sq[1])][FILES.indexOf(sq[0])]) continue;
    const p = extras[Math.floor(rng() * extras.length)];
    if ((p === 'p' || p === 'P') && (sq[1] === '1' || sq[1] === '8')) continue;
    put(sq, p);
  }
  if (!board.flat().includes('k')) put('h8', board[0][7] ? null : 'k');
  if (!board.flat().includes('k') || !board.flat().includes('K')) return null;
  const placement = board
    .map((row) => {
      let s = '';
      let n = 0;
      for (const c of row) {
        if (c) (s += (n ? n : '') + c, (n = 0));
        else n++;
      }
      return s + (n || '');
    })
    .join('/');
  const turn = rng() < 0.5 ? 'w' : 'b';
  return `${placement} ${turn} ${rights.join('') || '-'} - 0 1`;
}
const uci = (moves) => moves.map((m) => `${m.from}${m.to}${m.promotion ?? ''}`).sort().join();
console.log('\n=== 4. Parity: mobile and server agree on random castling-rich positions ===');
{
  const rng = seeded(171);
  let positions = 0;
  let withExtraCastle = 0;
  let mismatched = 0;
  for (let i = 0; i < 4000; i++) {
    const fen = randomPosition(rng);
    if (!fen) continue;
    let client;
    let server;
    try {
      client = new ClientEngine(fen, { skipValidation: true });
      server = new RoomChessEngine(fen, { skipValidation: true });
    } catch {
      continue;
    }
    positions++;
    const turn = client.getTurn();
    const cm = client.getPseudoLegalMoves(turn);
    const sm = server.getPseudoLegalMoves(turn);
    if (uci(cm) !== uci(sm)) mismatched++;
    const ordinary = new Set(new ClientEngine(fen, { skipValidation: true }).getLegalMoves(turn === 'w' ? 'e1' : 'e8'));
    const rank = turn === 'w' ? '1' : '8';
    for (const c of castlesOf(client, turn)) {
      if (!ordinary.has(c)) {
        withExtraCastle++;
        const a = new ClientEngine(fen, { skipValidation: true });
        const b = new RoomChessEngine(fen, { skipValidation: true });
        const ma = a.movePseudoLegal(`e${rank}`, c);
        const mb = b.movePseudoLegal(`e${rank}`, c);
        if (!ma || !mb || a.getFen() !== b.getFen() || ma.san !== mb.san) mismatched++;
      }
    }
  }
  check(positions > 3000, `${positions} random positions generated`);
  check(withExtraCastle > 200, `${withExtraCastle} of them contain a castle chess.js alone would refuse (the new behaviour is exercised)`);
  check(mismatched === 0, 'pseudo-legal sets, applied castles (SAN + FEN) are identical on both engines');
}

// --- 5. No hidden-information refusal --------------------------------------------------------------
console.log('\n=== 5. Every move the redacted view offers is accepted — except the blind pawn push ===');
{
  const rng = seeded(4242);
  let positions = 0;
  let offered = 0;
  let blind = 0;
  let castlesOffered = 0;
  let extraCastlesAccepted = 0; // castles chess.js alone would refuse (king in check / transit or landing square attacked on the TRUE board)
  const unexpected = [];
  for (let i = 0; i < 6000; i++) {
    const fen = randomPosition(rng);
    if (!fen) continue;
    let truth;
    try {
      truth = new RoomChessEngine(fen, { skipValidation: true });
    } catch {
      continue;
    }
    const color = truth.getTurn();
    const view = buildRedactedFen(truth, color);
    let client;
    try {
      client = new ClientEngine(view, { skipValidation: true });
    } catch {
      continue; // a view without the mover's king cannot happen (own pieces are visible), but stay safe
    }
    positions++;
    for (const m of client.getPseudoLegalMoves(color)) {
      offered++;
      if (m.promotion && m.promotion !== 'q') continue; // one candidate per promotion piece; q is enough
      const server = new RoomChessEngine(fen, { skipValidation: true });
      const isCastle = (m.from === 'e1' || m.from === 'e8') && Math.abs(m.to.charCodeAt(0) - 101) === 2 && client.getPieceAt(m.from)?.type === 'k';
      if (isCastle) castlesOffered++;
      const ok = server.movePseudoLegal(m.from, m.to, m.promotion);
      if (ok) {
        if (isCastle && !new ClientEngine(fen, { skipValidation: true }).getLegalMoves(m.from).includes(m.to)) extraCastlesAccepted++;
        continue;
      }
      // The one accepted refusal: a quiet pawn push (same file, no capture) into a square a hidden piece occupies.
      const piece = client.getPieceAt(m.from);
      const quietPawnPush = piece?.type === 'p' && m.from[0] === m.to[0] && !m.captured;
      if (quietPawnPush) {
        blind++;
        continue;
      }
      unexpected.push(`${fen} ${m.from}${m.to}`);
    }
  }
  check(positions > 4500, `${positions} random true positions, ${offered} offered moves (${castlesOffered} castles) replayed on the server`);
  check(castlesOffered > 500, 'plenty of castles were among them');
  check(extraCastlesAccepted > 100, `${extraCastlesAccepted} of those castles are ones the ordinary rule forbids (hidden check / attacked squares) — all accepted`);
  check(unexpected.length === 0, `no refusal other than a blind pawn push (${blind} blind pushes seen)${unexpected.length ? ': ' + unexpected.slice(0, 3).join(' | ') : ''}`);
}

console.log(`\nAll ${passed} checks passed.`);
