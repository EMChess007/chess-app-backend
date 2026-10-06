#!/usr/bin/env node
/**
 * Crazyhouse server-side regression suite — no running server needed. Run with tsx:
 *   npx tsx scripts/test-crazyhouse.mjs      (or: npm run test:crazyhouse)
 *
 *  1. NO DRIFT: the shared rules block of backend/src/game/crazyhouse.ts must be byte-identical to the mobile app's
 *     src/logic/crazyhouse.ts (hand-mirrored — there is no shared module).
 *  2. THE AUTHORITY: RoomManager.applyMove (driven with a stub socket server, no network). A capture banks the piece in the
 *     capturer's reserve, a captured PROMOTED piece banks a pawn; a drop is one whole turn and is refused when the reserve lacks the
 *     piece, the square is occupied, a pawn would land on rank 1/8, it is not the sender's turn, or a check is not answered by
 *     it; a drop can give mate, and a "mate" a drop can answer is not mate; stalemate likewise; king versus king is never a draw;
 *     castling rights are flags a re-dropped rook does not restore; a dropped pawn never creates an en passant; rejoin and
 *     spectate carry the reserves; the saved PGN is tagged and carries the "N@f3" drops.
 *  3. PARITY with the mobile app: random Crazyhouse games (biased to captures, drops and promotions) are replayed through BOTH
 *     engines and every ply must agree on every candidate turn (accepted by both or refused by both), the resulting FEN, the
 *     reserves/promoted squares and the game-over verdict.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ChessEngine as ClientEngine } from '../../src/logic/ChessEngine.ts';
import { getCrazyhouseMoves } from '../../src/logic/crazyhouse.ts';
import { RoomChessEngine } from '../src/game/RoomChessEngine.ts';
import { RESERVE_PIECE_TYPES, applyCrazyhouseDrop, applyCrazyhouseMove, cloneCrazyhouseState, initialCrazyhouseState } from '../src/game/crazyhouse.ts';
import { buildPgn } from '../src/game/pgn.ts';
import { RoomManager, variantPgnTag } from '../src/game/rooms.ts';

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
  const mobile = block(new URL('../../src/logic/crazyhouse.ts', import.meta.url));
  const server = block(new URL('../src/game/crazyhouse.ts', import.meta.url));
  check(mobile.length > 3000, 'the shared rules block was found in both files');
  check(mobile.includes('applyCrazyhouseMove') && mobile.includes('legalDropSquares') && mobile.includes('crazyhouseCheckInfo'), '...and it contains the promoted-piece tracking, the drop legality and the check geometry');
  check(mobile === server, 'backend/src/game/crazyhouse.ts and src/logic/crazyhouse.ts have identical rules (edit BOTH together)');
}

// --- 2. The authority: RoomManager.applyMove ---------------------------------------------------------
console.log('\n=== 2. RoomManager plays Crazyhouse by the rules ===');
function stubIo() {
  const events = [];
  return { events, to: (id) => ({ emit: (event, payload) => events.push({ id, event, payload }) }) };
}
/** A room; `fen`/`white`/`black`/`promoted` (reserves as { p, n, ... } counts) optionally swap in a prepared position. */
function czRoom({ fen, white = {}, black = {}, promoted = [], crazyhouse = true } = {}) {
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
    crazyhouse,
  });
  const room = () => manager.rooms.get(created.roomId);
  if (fen) {
    const state = initialCrazyhouseState();
    Object.assign(state.reserve.w, white);
    Object.assign(state.reserve.b, black);
    state.promoted = promoted;
    room().engine = new RoomChessEngine(fen, { crazyhouse: true, crazyhouseState: state });
    room().initialFen = fen;
  }
  const turn = (who, from, to, promotion) => manager.applyMove(who, { roomId: created.roomId, from, to, ...(promotion ? { promotion } : {}) });
  const drop = (who, piece, square) => manager.applyMove(who, { roomId: created.roomId, from: square, to: square, drop: piece });
  const state = () => room().engine.getCrazyhouseState();
  const gameOvers = () => io.events.filter((e) => e.event === 'game_over');
  return { io, manager, created, turn, drop, room, state, gameOvers };
}
{
  // Captures bank pieces; a drop is a whole turn.
  const g = czRoom();
  check(g.created.fen.startsWith('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w'), 'a Crazyhouse room starts from the ordinary start position');
  check(g.turn('W', 'e2', 'e4').ok && g.turn('B', 'd7', 'd5').ok, '1.e4 d5');
  const exd5 = g.turn('W', 'e4', 'd5');
  check(exd5.ok === true && exd5.crazyhouse.reserve.w.p === 1, '2.exd5 — and the mover’s ack already carries the new reserve');
  check(g.state().reserve.w.p === 1 && g.state().reserve.b.p === 0, "White's capture went into WHITE's reserve (the capturer's), as a pawn");
  const nf6 = g.turn('B', 'g8', 'f6');
  check(nf6.ok === true, '2...Nf6');
  const dropped = g.drop('W', 'p', 'e5');
  check(dropped.crazyhouse && dropped.crazyhouse.reserve.w.p === 0, 'the drop ack carries the state too');
  check(dropped.ok === true && dropped.san === 'P@e5' && dropped.turn === 'b', 'White drops the pawn: P@e5, and it is Black\'s turn (a drop is a whole turn)');
  check(g.state().reserve.w.p === 0, '...the reserve is one smaller');
  const toB = g.io.events.filter((e) => e.id === 'B' && e.event === 'opponent_move').pop();
  check(toB.payload.drop === 'p' && toB.payload.from === 'e5' && toB.payload.to === 'e5' && toB.payload.crazyhouse.reserve.w.p === 0, 'Black is told: drop p on e5, with the full state afterwards');
  const spec = g.manager.rooms.get(g.created.roomId);
  check(g.drop('B', 'n', 'e4').ok === false, 'Black cannot drop a knight: its reserve is empty');
  check(spec.engine.getFen().split(' ')[3] === '-', 'a dropped pawn never creates an en passant square');
}
{
  // Refusals: every illegal drop leaves the room untouched.
  const g = czRoom({ fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1', white: { p: 1, n: 1 } });
  const before = g.room().engine.getFen();
  const refused = [
    ['pawn on rank 1', () => g.drop('W', 'p', 'a1')],
    ['pawn on rank 8', () => g.drop('W', 'p', 'a8')],
    ['an occupied square (own king)', () => g.drop('W', 'n', 'e1')],
    ['an occupied square (enemy king)', () => g.drop('W', 'n', 'e8')],
    ['a piece the reserve lacks (bishop)', () => g.drop('W', 'b', 'c3')],
    ['a king', () => g.drop('W', 'k', 'c3')],
    ['a nonsense piece', () => g.drop('W', 'x', 'c3')],
    ["Black's turn (not the sender's)", () => g.drop('B', 'n', 'c3')],
    ['a square off the board', () => g.drop('W', 'n', 'i9')],
  ];
  for (const [what, attempt] of refused) {
    const ack = attempt();
    check(ack.ok === false && g.room().engine.getFen() === before && g.room().engine.getTurn() === 'w' && g.room().moves.length === 0, `refused: a drop on ${what} (room untouched)`);
  }
  check(g.state().reserve.w.p === 1 && g.state().reserve.w.n === 1, 'no refused drop spent anything from the reserve');
  check(g.drop('W', 'p', 'a2').ok === true, 'a pawn on rank 2 is fine');
  const classic = czRoom({ crazyhouse: false });
  check(classic.drop('W', 'n', 'c3').ok === false, 'a drop in a NON-Crazyhouse room is refused');
}
{
  // Check: only a drop that answers it.
  const g = czRoom({ fen: '4k3/8/8/8/8/8/8/r3K3 w - - 0 1', white: { n: 1, p: 1 } });
  check(g.drop('W', 'n', 'f5').ok === false, 'in check from a1: a drop elsewhere (f5) does not answer it — refused');
  check(g.drop('W', 'p', 'c1').ok === false, '...a pawn cannot interpose on rank 1 (pawn rule)');
  check(g.drop('W', 'n', 'c1').ok === true, '...a knight interposing on c1 does');
  // A queen checks along a diagonal and is blocked on it (found by mutation testing).
  const queenDiag = czRoom({ fen: '4k3/8/8/8/8/2q5/8/4K3 w - - 0 1', white: { n: 1 } });
  check(queenDiag.drop('W', 'n', 'a5').ok === false && queenDiag.drop('W', 'n', 'd2').ok === true, 'in check from a queen on c3: only d2 (between it and the king) answers it');
  const bishopDiag = czRoom({ fen: '4k3/8/8/8/8/2b5/8/4K3 w - - 0 1', white: { n: 1 } });
  check(bishopDiag.drop('W', 'n', 'a5').ok === false && bishopDiag.drop('W', 'n', 'd2').ok === true, '...and likewise for a bishop');
  const knightCheck = czRoom({ fen: '4k3/8/8/8/8/3n4/8/4K3 w - - 0 1', white: { q: 1 } });
  check(knightCheck.drop('W', 'q', 'c1').ok === false && knightCheck.drop('W', 'q', 'd3').ok === false, 'in check from a KNIGHT no drop is legal (not even on the checker\'s own square — it is occupied)');
  // Every one of the eight knight jumps is a check (found by mutation testing: a wrong entry in the step table went unnoticed).
  for (const [df, dr] of [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]]) {
    const knightSquare = `${'abcdefgh'[3 + df]}${4 + dr}`; // the king stands on d4
    const board = Array.from({ length: 8 }, (_, r) => Array.from({ length: 8 }, (_, f) => (`${'abcdefgh'[f]}${8 - r}` === 'd4' ? 'K' : `${'abcdefgh'[f]}${8 - r}` === knightSquare ? 'n' : `${'abcdefgh'[f]}${8 - r}` === 'h8' ? 'k' : '1')).join('')).map((rank) => rank.replace(/1+/g, (m) => String(m.length))).join('/');
    const jump = czRoom({ fen: `${board} w - - 0 1`, white: { q: 1 } });
    check(jump.drop('W', 'q', 'a1').ok === false, `in check from a knight on ${knightSquare}: no drop is legal`);
  }
  // A PAWN check cannot be blocked either — and its direction depends on the king's colour (found by mutation testing).
  const pawnCheckW = czRoom({ fen: '4k3/8/8/8/8/8/3p4/4K3 w - - 0 1', white: { q: 1 } });
  check(pawnCheckW.drop('W', 'q', 'a5').ok === false && pawnCheckW.drop('W', 'q', 'd1').ok === false, 'in check from a Black PAWN (d2 vs Ke1) no drop is legal');
  const noPawnCheckW = czRoom({ fen: '4k3/8/8/8/8/3p4/8/4K3 w - - 0 1', white: { q: 1 } });
  check(noPawnCheckW.drop('W', 'q', 'a5').ok === true, '...while a pawn two ranks away (d3) is no check, so the same drop is legal');
  const pawnCheckB = czRoom({ fen: '4k3/3P4/8/8/8/8/8/4K3 b - - 0 1', black: { n: 1 } });
  check(pawnCheckB.drop('B', 'n', 'a5').ok === false, 'in check from a White pawn (d7 vs Ke8) no drop is legal for Black either');
  const dbl = czRoom({ fen: '4k3/8/8/8/8/3n4/8/r3K3 w - - 0 1', white: { q: 1 } });
  check(dbl.drop('W', 'q', 'b1').ok === false, 'in DOUBLE check no drop is legal');
}
{
  // Mate by drop, and mate a drop can answer.
  const mate = czRoom({ fen: '7k/6pp/8/8/8/8/8/4K3 w - - 0 1', white: { q: 1 } });
  const ack = mate.drop('W', 'q', 'f8');
  const over = mate.gameOvers();
  check(ack.ok === true && ack.san === 'Q@f8#', 'a queen dropped on f8 is checkmate: Q@f8#');
  check(over.length === 2 && over.every((e) => e.payload.reason === 'checkmate' && e.payload.winner === 'w'), '...both players get game_over {checkmate, winner: white}');

  const answerable = czRoom({ fen: '7k/6pp/8/8/8/8/8/4K3 w - - 0 1', white: { q: 1 }, black: { n: 1 } });
  const check1 = answerable.drop('W', 'q', 'f8');
  check(check1.ok === true && check1.san === 'Q@f8+' && answerable.gameOvers().length === 0, 'the same drop is only CHECK when Black holds a piece that can interpose (Q@f8+) — the game goes on');
  check(answerable.drop('B', 'n', 'g8').ok === true, '...and Black answers with a drop: N@g8');

  const stalemate = czRoom({ fen: '7k/8/5QK1/8/8/8/8/8 w - - 0 1' });
  stalemate.turn('W', 'f6', 'f7');
  const staleOver = stalemate.gameOvers();
  check(staleOver.length === 2 && staleOver.every((e) => e.payload.reason === 'stalemate' && e.payload.winner === null), 'stalemate with an empty reserve is a draw');
  const notStale = czRoom({ fen: '7k/8/5QK1/8/8/8/8/8 w - - 0 1', black: { p: 1 } });
  notStale.turn('W', 'f6', 'f7');
  check(notStale.gameOvers().length === 0 && notStale.drop('B', 'p', 'a5').ok === true, 'the same position is NOT stalemate when Black holds a pawn it can drop');

  // The fifty-move rule stays, and a drop resets the halfmove clock (found by mutation testing: the draw check could be deleted unnoticed).
  const fifty = czRoom({ fen: '4k3/8/8/8/8/8/8/R3K3 w - - 99 80' });
  fifty.turn('W', 'a1', 'a2');
  const fiftyOver = fifty.gameOvers();
  check(fiftyOver.length === 2 && fiftyOver.every((e) => e.payload.reason === 'draw' && e.payload.winner === null), 'the fifty-move rule draws a Crazyhouse game at halfmove clock 100');
  const reset = czRoom({ fen: '4k3/8/8/8/8/8/8/R3K3 w - - 99 80', white: { n: 1 } });
  check(reset.drop('W', 'n', 'c3').ok === true && reset.gameOvers().length === 0 && reset.room().engine.getFen().split(' ')[4] === '0', 'a drop resets the halfmove clock, so the same position is not drawn after a drop');
  const kk = czRoom({ fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1' });
  check(kk.turn('W', 'e1', 'd1').ok === true && kk.gameOvers().length === 0, 'king versus king is NOT an insufficient-material draw (a reserve may fill up)');
}
{
  // Promoted pieces: a captured promoted piece banks a PAWN.
  const g = czRoom({ fen: '7k/P7/8/8/8/8/r7/1R5K w - - 0 1' });
  check(g.turn('W', 'a7', 'a8', 'q').ok === true && g.state().promoted.join() === 'a8', 'a7-a8=Q: the queen on a8 is marked promoted');
  check(g.turn('B', 'a2', 'a8').ok === true, 'the rook takes it');
  check(g.state().reserve.b.p === 1 && g.state().reserve.b.q === 0 && g.state().promoted.length === 0, "...and Black's reserve gains a PAWN, not a queen; the mark is gone");
  // The mark travels with the piece (found by mutation testing: a stale mark was left behind), and any captured piece is banked as ITS type.
  const walker = czRoom({ fen: '7k/P7/8/8/8/8/8/K7 w - - 0 1' });
  walker.turn('W', 'a7', 'a8', 'q');
  walker.turn('B', 'h8', 'g7');
  walker.turn('W', 'a8', 'b8');
  check(walker.state().promoted.join() === 'b8', 'a promoted queen that moves takes its mark along (a8 -> b8) and leaves none behind');
  const knightTaken = czRoom({ fen: '4k3/8/8/3n4/8/8/8/3QK3 w - - 0 1' });
  knightTaken.turn('W', 'd1', 'd5');
  check(knightTaken.state().reserve.w.n === 1 && knightTaken.state().reserve.w.p === 0, 'a captured knight is banked as a KNIGHT (only a promoted piece is banked as a pawn)');
  // en passant banks the pawn too
  const ep = czRoom({ fen: '4k3/8/8/8/3pP3/8/8/4K3 b - e3 0 1' });
  check(ep.turn('B', 'd4', 'e3').ok === true && ep.state().reserve.b.p === 1, 'an en passant capture banks the captured pawn');
}
{
  // Castling rights are flags in the FEN: a captured rook loses its right, and a rook dropped back does not restore it.
  const cap = czRoom({ fen: '4k3/1b6/8/8/8/8/8/R3K2R b KQ - 0 1' });
  cap.turn('B', 'b7', 'h1');
  check(cap.room().engine.getFen().split(' ')[2] === 'Q', 'capturing the h1 rook removes the king-side right (chess.js flag)');
  const redrop = czRoom({ fen: '4k3/8/8/8/8/8/8/R3K3 w Q - 0 1', white: { r: 1 } });
  check(redrop.drop('W', 'r', 'h1').ok === true && redrop.turn('B', 'e8', 'd8').ok === true, 'White drops a rook on h1, Black moves');
  check(redrop.turn('W', 'e1', 'g1').ok === false && redrop.room().engine.getFen().split(' ')[2] === 'Q', '...castling king-side is STILL refused: the right is a flag, not a function of what stands on h1');
  check(redrop.turn('W', 'e1', 'c1').ok === true, '...while queen-side castling (right intact) works');
  // en passant never interacts with a drop
  const ep = czRoom({ fen: '4k3/8/8/8/3p4/8/8/4K3 w - - 0 1', white: { p: 1 } });
  ep.drop('W', 'p', 'e4');
  check(ep.turn('B', 'd4', 'e3').ok === false, 'a dropped pawn next to an enemy pawn gives no en passant capture');
}
{
  // Rejoin / spectate carry the reserves; the PGN keeps the drops.
  const g = czRoom();
  g.turn('W', 'e2', 'e4');
  g.turn('B', 'd7', 'd5');
  g.turn('W', 'e4', 'd5');
  g.turn('B', 'g8', 'f6');
  g.drop('W', 'p', 'e5');
  const rejoined = g.manager.rejoin('W2', { roomId: g.created.roomId, playerToken: g.created.whitePlayerToken });
  check(rejoined.ok && rejoined.state.isCrazyhouse === true && rejoined.state.crazyhouse.reserve.w.p === 0 && rejoined.state.moves.at(-1).drop === 'p', 'rejoin_game reports isCrazyhouse, the reserves, and the drop in the move list');
  const watched = g.manager.spectate('S', g.created.roomId);
  check(watched.ok && watched.state.isCrazyhouse === true && watched.state.crazyhouse.reserve.b.p === 0, 'spectate_game carries the state too');
  const pgn = buildPgn(g.room().initialFen, g.room().moves, '*', 'Crazyhouse');
  check(variantPgnTag(g.room()) === 'Crazyhouse' && variantPgnTag({ giveaway: false, atomic: false, duckChess: false, spellChess: false, horde: false, crazyhouse: false }) === undefined, 'a Crazyhouse room is saved with the Crazyhouse variant tag (a classic room with none)');
  check(pgn.includes('[Variant "Crazyhouse"]') && pgn.includes('3.P@e5'), 'the saved PGN is tagged [Variant "Crazyhouse"] and writes the drop as P@e5');
}

{
  // Gaps found by mutation testing: independent copies, and castling carrying a promoted rook (a promoted rook cannot hold castling
  // rights in a real game, so the position is built directly).
  const original = initialCrazyhouseState();
  original.reserve.w.n = 1;
  original.promoted = ['a8'];
  const copy = cloneCrazyhouseState(original);
  copy.promoted.push('h8');
  copy.reserve.w.n = 9;
  const moved = applyCrazyhouseMove(original, 'w', { from: 'b2', to: 'b3' });
  moved.promoted.push('c1');
  const dropped = applyCrazyhouseDrop(original, 'w', 'n');
  dropped.promoted.push('c1');
  check(original.promoted.join() === 'a8' && original.reserve.w.n === 1, 'cloneCrazyhouseState / applyCrazyhouseMove / applyCrazyhouseDrop return independent copies');
  const state = initialCrazyhouseState();
  state.promoted = ['h1'];
  const castle = new RoomChessEngine('4k3/8/8/8/8/8/8/4K2R w K - 0 1', { crazyhouse: true, crazyhouseState: state });
  check(castle.move('e1', 'g1') !== null && castle.getCrazyhouseState().promoted.join() === 'f1', 'castling carries a promoted rook along (h1 -> f1)');
  const queenSide = initialCrazyhouseState();
  queenSide.promoted = ['a1'];
  const castleLong = new RoomChessEngine('4k3/8/8/8/8/8/8/R3K3 w Q - 0 1', { crazyhouse: true, crazyhouseState: queenSide });
  check(castleLong.move('e1', 'c1') !== null && castleLong.getCrazyhouseState().promoted.join() === 'd1', '...and queen-side (a1 -> d1)');
  // A drop clears the opponent's stale en passant square.
  const epState = initialCrazyhouseState();
  epState.reserve.b.p = 1;
  const ep = new RoomChessEngine('4k3/8/8/8/3p4/8/4P3/4K3 w - - 0 1', { crazyhouse: true, crazyhouseState: epState });
  ep.move('e2', 'e4');
  const hadEp = ep.getFen().split(' ')[3] === 'e3';
  ep.drop('p', 'a5');
  check(hadEp && ep.getFen().split(' ')[3] === '-', "a drop clears an en passant square left by the opponent's double step");
}

// --- 3. Parity with the mobile app --------------------------------------------------------------------
console.log('\n=== 3. The server and mobile engines agree ===');
{
  const random = seeded(31337);
  const problems = [];
  const seen = { plies: 0, drops: 0, promotions: 0, promotedCaptures: 0, captures: 0, refusals: 0, ended: 0 };
  const squares = [];
  for (const f of 'abcdefgh') for (let r = 1; r <= 8; r++) squares.push(`${f}${r}`);
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  for (let game = 0; game < 12 && problems.length === 0; game++) {
    let fen = START;
    let state = initialCrazyhouseState();
    for (let ply = 0; ply < 120 && problems.length === 0; ply++) {
      const client = new ClientEngine(fen, { crazyhouse: true, crazyhouseState: state });
      const moves = getCrazyhouseMoves(client);
      const drops = client.getLegalDrops();
      const mover = client.getTurn();

      // Every turn the mobile engine offers must be accepted by the server engine, with the same position and state.
      const sample = [...moves, ...drops.map((d) => ({ drop: d.piece, from: d.square, to: d.square }))];
      for (const m of sample) {
        const server = new RoomChessEngine(fen, { crazyhouse: true, crazyhouseState: state });
        const clientAfter = new ClientEngine(fen, { crazyhouse: true, crazyhouseState: state });
        const serverTurn = m.drop ? server.drop(m.drop, m.to) : server.move(m.from, m.to, m.promotion);
        const clientTurn = m.drop ? clientAfter.drop(m.drop, m.to) : clientAfter.move(m.from, m.to, m.promotion);
        if (!serverTurn || !clientTurn) {
          problems.push(`ply ${ply}: the mobile engine offers ${m.drop ? `${m.drop}@${m.to}` : `${m.from}${m.to}${m.promotion ?? ''}`} but ${serverTurn ? 'it' : 'the server'} refuses it (${fen})`);
          break;
        }
        if (server.getFen() !== clientAfter.getFen() || !same(server.getCrazyhouseState(), clientAfter.getCrazyhouseState()) || serverTurn.san !== clientTurn.san) {
          problems.push(`ply ${ply}: ${m.drop ? `${m.drop}@${m.to}` : `${m.from}${m.to}`} gives different results (${server.getFen()} ${serverTurn.san} vs ${clientAfter.getFen()} ${clientTurn.san})`);
          break;
        }
      }
      if (problems.length > 0) break;

      // ...and sampled turns the mobile engine does NOT offer must be refused by the server as well.
      const offeredMoves = new Set(moves.map((m) => `${m.from}${m.to}`));
      const offeredDrops = new Set(drops.map((d) => `${d.piece}${d.square}`));
      for (let probe = 0; probe < 30; probe++) {
        const from = squares[Math.floor(random() * 64)];
        const to = squares[Math.floor(random() * 64)];
        if (from !== to && !offeredMoves.has(`${from}${to}`)) {
          if (new RoomChessEngine(fen, { crazyhouse: true, crazyhouseState: state }).move(from, to, 'q')) {
            problems.push(`ply ${ply}: the server accepts ${from}${to} which the mobile engine does not offer (${fen})`);
            break;
          }
          seen.refusals++;
        }
        const piece = RESERVE_PIECE_TYPES[Math.floor(random() * 5)];
        if (!offeredDrops.has(`${piece}${to}`)) {
          if (new RoomChessEngine(fen, { crazyhouse: true, crazyhouseState: state }).drop(piece, to)) {
            problems.push(`ply ${ply}: the server accepts ${piece}@${to} which the mobile engine does not offer (${fen})`);
            break;
          }
          seen.refusals++;
        }
      }
      if (problems.length > 0) break;

      const server = new RoomChessEngine(fen, { crazyhouse: true, crazyhouseState: state });
      if (server.isGameOver() !== client.isGameOver() || server.getStatus() !== client.getStatus()) {
        problems.push(`ply ${ply}: verdicts differ at ${fen}: server ${server.getStatus()}/${server.isGameOver()} mobile ${client.getStatus()}/${client.isGameOver()}`);
        break;
      }
      if (client.isGameOver() || sample.length === 0) {
        seen.ended++;
        break;
      }

      // Bias the walk: drop whenever possible 45% of the time, otherwise prefer captures and promotions.
      let pick;
      const capturing = moves.filter((m) => m.captured || m.promotion === 'q');
      if (drops.length > 0 && random() < 0.45) {
        const d = drops[Math.floor(random() * drops.length)];
        pick = { drop: d.piece, from: d.square, to: d.square };
      } else if (capturing.length > 0 && random() < 0.6) {
        pick = capturing[Math.floor(random() * capturing.length)];
      } else {
        const plain = moves.filter((m) => !m.promotion || m.promotion === 'q');
        pick = plain.length > 0 ? plain[Math.floor(random() * plain.length)] : sample[Math.floor(random() * sample.length)];
      }
      if (pick.drop) {
        client.drop(pick.drop, pick.to);
        seen.drops++;
      } else {
        if (pick.promotion) seen.promotions++;
        if (pick.captured) seen.captures++;
        if (pick.captured && state.promoted.includes(pick.to)) seen.promotedCaptures++;
        client.move(pick.from, pick.to, pick.promotion);
      }
      fen = client.getFen();
      state = client.getCrazyhouseState();
      seen.plies++;
    }
  }
  check(problems.length === 0, `server and mobile agree on every candidate of ${seen.plies} plies / 12 games${problems.length ? ` — ${problems.slice(0, 3).join(' | ')}` : ''}`);
  check(seen.refusals > 1500, `...and on ${seen.refusals} sampled turns that must be refused`);
  check(seen.drops > 100 && seen.captures > 100, `the random games really exercised drops (${seen.drops}) and captures (${seen.captures}); promotions ${seen.promotions}, promoted pieces captured ${seen.promotedCaptures}`);
}

console.log(`\nAll good — ${passed} checks passed.`);
process.exit(0);
