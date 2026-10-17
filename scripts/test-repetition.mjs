#!/usr/bin/env node
/**
 * Threefold repetition - server-side regression suite, no running server needed. Run with tsx:
 *   npx tsx scripts/test-repetition.mjs      (or: npm run test:repetition)
 *
 * THE RULE (chess.com ends a game automatically as a draw): the same position three times, not necessarily in a row, same side to
 * move. A position = placement + side to move + castling rights + en passant square (only when a capture is available) + the variant's
 * hidden state (Three-Check counters, Crazyhouse pockets and promoted pieces, the duck square, the whole Spell Chess state). One rule for
 * every two-player mode; the room keeps the list of position keys (rooms.ts), the app derives the same list from its history
 * (src/logic/repetitionHistory.ts). The end is reported as reason 'repetition' (a draw, no winner).
 *
 * Layers:
 *  1. NO DRIFT: backend/src/game/repetition.ts is byte-identical to the app's src/logic/repetition.ts.
 *  2. THE KEY: what counts as the same position and what does not (castling, en passant, side to move, check counters, pockets,
 *     promoted pieces, the duck, Spell Chess charges / cooldowns / frozen squares / jump).
 *  3. EVERY MODE through RoomManager.applyMove: the Nf3 Nf6 Ng1 Ng8 shuffle ends the game on the third occurrence - and not before -
 *     in Classic, Chess960, King of the Hill, Three-Check, Setup Chess, Fog of War, Giveaway, Atomic, Duck, Horde, Crazyhouse and Spell.
 *  4. LOOK-ALIKES that must NOT end the game: lost castling rights, a duck that keeps moving, a cast Spell.
 *  5. REJOIN mid-repetition: the list lives in the room, so a reconnect between the second and third occurrence changes nothing.
 *  6. PARITY: the server's list and the app's historyRepetitionKeys(...) agree ply by ply in every mode (scripted shuffles and random
 *     repetition-prone games), and the app says "draw" at exactly the ply the server ended the game.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { historyRepetitionKeys, isRepetitionDraw } from '../../src/logic/repetitionHistory.ts';
import { initialSpellChessState } from '../../src/logic/spellChess.ts';
import { ChessEngine as ClientEngine } from '../../src/logic/ChessEngine.ts';
import { isThreefoldRepetition, repetitionCount, repetitionExtra, repetitionKey } from '../src/game/repetition.ts';
import { START_FEN } from '../src/game/RoomChessEngine.ts';
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
console.log('\n=== 1. The repetition module is a verbatim copy of the mobile one ===');
{
  const read = (path) => readFileSync(path, 'utf8').split(CRLF).join(LF);
  const mobile = read(new URL('../../src/logic/repetition.ts', import.meta.url));
  const server = read(new URL('../src/game/repetition.ts', import.meta.url));
  check(mobile.length > 2500, 'the module was found in both repos');
  check(mobile === server, 'backend/src/game/repetition.ts and src/logic/repetition.ts are identical (edit BOTH together)');
}

// --- 2. The key ------------------------------------------------------------------------------------
console.log('\n=== 2. What is "the same position" ===');
{
  const key = (fen, extra) => repetitionKey(fen, extra);
  const base = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1';
  check(key(base) === key(base.replace(' 0 1', ' 17 42')), 'the move clocks are not part of a position');
  check(key(base) !== key(base.replace(' w ', ' b ')), 'the side to move is');
  check(key(base) !== key(base.replace('KQkq', 'Qkq')) && key(base) !== key(base.replace('KQkq', '-')), 'the castling rights are');
  // en passant: only when a capture is actually available
  const noCapturer = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
  check(key(noCapturer) === key(noCapturer.replace(' e3 ', ' - ')), 'an en passant square nobody can capture on is NOT part of the position');
  const withCapturer = 'rnbqkbnr/ppp1pppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
  check(key(withCapturer) !== key(withCapturer.replace(' e3 ', ' - ')), '...but one a pawn can capture on is');
  const whiteCaptures = 'rnbqkbnr/pppp1ppp/8/3Pp3/8/8/PPP1PPPP/RNBQKBNR w KQkq e6 0 1';
  check(key(whiteCaptures) !== key(whiteCaptures.replace(' e6 ', ' - ')), '...for White too (a pawn on d5 beside e5)');
  // variant state
  const plain = key(START_FEN);
  check(key(START_FEN, { checks: { w: 0, b: 0 } }) !== plain && key(START_FEN, { checks: { w: 1, b: 0 } }) !== key(START_FEN, { checks: { w: 0, b: 1 } }), 'Three-Check: the check counters are part of the position (and who delivered them)');
  const pockets = (w, b, promoted = []) => ({ reserve: { w, b }, promoted });
  const none = { q: 0, r: 0, b: 0, n: 0, p: 0 };
  check(key(START_FEN, { crazyhouse: pockets({ ...none, p: 1 }, none) }) !== key(START_FEN, { crazyhouse: pockets(none, none) }), 'Crazyhouse: a piece in a pocket is part of the position');
  check(key(START_FEN, { crazyhouse: pockets({ ...none, p: 1 }, none) }) !== key(START_FEN, { crazyhouse: pockets(none, { ...none, p: 1 }) }), '...whose pocket it is in matters');
  check(key(START_FEN, { crazyhouse: pockets(none, none, ['c8']) }) !== key(START_FEN, { crazyhouse: pockets(none, none) }), '...and so is a promoted piece (it reverts to a pawn when captured)');
  check(key(START_FEN, { crazyhouse: pockets(none, none, ['a1', 'c8']) }) === key(START_FEN, { crazyhouse: pockets(none, none, ['c8', 'a1']) }), '...but the ORDER the promoted squares were collected in is not');
  check(key(START_FEN, { duck: 'a3' }) !== key(START_FEN, { duck: 'a4' }) && key(START_FEN, { duck: null }) !== key(START_FEN, { duck: 'a3' }), 'Duck: the duck square is part of the position');
  const spell = initialSpellChessState();
  const spent = { ...spell, w: { ...spell.w, charges: { ...spell.w.charges, freeze: spell.w.charges.freeze - 1 } } };
  const cooling = { ...spell, w: { ...spell.w, cooldowns: { ...spell.w.cooldowns, jump: 3 } } };
  const frozen = { ...spell, pendingFreeze: { squares: ['e4', 'd4'], restricts: 'b' } };
  const frozenOtherOrder = { ...spell, pendingFreeze: { squares: ['d4', 'e4'], restricts: 'b' } };
  const jumping = { ...spell, pendingJump: { square: 'c3', pliesLeft: 2 } };
  const sp = (s) => key(START_FEN, { spell: s });
  check(sp(spell) !== sp(spent), 'Spell Chess: the charges are part of the position');
  check(sp(spell) !== sp(cooling), '...the cooldowns');
  check(sp(spell) !== sp(frozen) && sp(frozen) === sp(frozenOtherOrder), '...the frozen squares (as a set)');
  check(sp(spell) !== sp(jumping), '...and a pending jump');
  check(repetitionExtra(undefined) === '' && key(START_FEN, {}) === plain, 'the plain modes add nothing');
  // counting
  const A = 'a';
  const B = 'b';
  check(repetitionCount([A, B, A, B, A]) === 3 && isThreefoldRepetition([A, B, A, B, A]), 'counting steps through the same side to move');
  check(!isThreefoldRepetition([A, B, A, B]) && !isThreefoldRepetition([]), 'two occurrences are not enough; an empty list is not a draw');
  check(repetitionCount(['x', 'o', 'x', 'p', 'x']) === 3 && repetitionCount(['x', 'x', 'x']) === 2, 'only every second entry (the same side to move) is compared');
}

// --- shared room helpers ---------------------------------------------------------------------------
const FLAGS = { chess960: false, kingOfTheHill: false, threeCheck: false, setupChess: false, fogOfWar: false, giveaway: false, atomic: false, duckChess: false, spellChess: false, horde: false, crazyhouse: false };
function stubIo() {
  const events = [];
  return { events, to: (id) => ({ emit: (event, payload) => events.push({ id, event, payload }) }) };
}
function newRoom(flags = {}, initialFen) {
  const io = stubIo();
  const manager = new RoomManager(io);
  const created = manager.createRoom({
    white: { socketId: 'W', userId: null },
    black: { socketId: 'B', userId: null },
    timeControl: { initialSeconds: 0, incrementSeconds: 0 },
    ...FLAGS,
    ...flags,
    initialFen,
  });
  const room = manager.rooms.get(created.roomId);
  const state = { ply: 0 };
  const sockets = { w: 'W', b: 'B' }; // a rejoin gives a player a new socket
  const gameOver = () => io.events.find((e) => e.event === 'game_over')?.payload ?? null;
  /** Plays one ply for whoever is to move; `extra` carries duckTo / spell. */
  const play = (from, to, extra = {}) => {
    const who = sockets[room.engine.getTurn()];
    const ack = manager.applyMove(who, { roomId: created.roomId, from, to, ...extra });
    if (ack.ok) state.ply++;
    return ack;
  };
  return { io, manager, created, room, state, sockets, play, gameOver };
}
const SHUFFLE = [['g1', 'f3'], ['g8', 'f6'], ['f3', 'g1'], ['f6', 'g8']];

/** Plays the shuffle `cycles` times; returns the ply at which the game ended (or null) and what it ended with. */
function runShuffle(r, cycles, extraFor = () => ({}), shuffle = SHUFFLE) {
  for (let c = 0; c < cycles; c++) {
    for (const [from, to] of shuffle) {
      if (r.gameOver()) return { endedAt: r.state.ply, over: r.gameOver() };
      const ack = r.play(from, to, extraFor(r.state.ply));
      assert.ok(ack.ok, `ply ${r.state.ply + 1} ${from}${to} refused: ${ack.error}`);
    }
  }
  const over = r.gameOver();
  return { endedAt: over ? r.state.ply : null, over };
}

// --- 3. Every mode ----------------------------------------------------------------------------------
console.log('\n=== 3. Nf3 Nf6 Ng1 Ng8 x3 ends the game in every two-player mode (and not before) ===');
const HORDE_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/8/6N1 w kq - 0 1';
const MODES = [
  ['Classic', {}, undefined],
  ['Chess960', { chess960: true }, START_FEN],
  ['King of the Hill', { kingOfTheHill: true }, undefined],
  ['Three-Check', { threeCheck: true }, undefined],
  ['Setup Chess', { setupChess: true }, START_FEN],
  ['Fog of War', { fogOfWar: true }, undefined],
  ['Giveaway', { giveaway: true }, undefined],
  ['Atomic', { atomic: true }, undefined],
  ['Horde', { horde: true }, HORDE_FEN],
  ['Crazyhouse', { crazyhouse: true }, undefined],
  ['Spell Chess', { spellChess: true }, undefined],
];
for (const [name, flags, fen] of MODES) {
  const r = newRoom(flags, fen);
  const before = runShuffle(r, 1, undefined, SHUFFLE); // plies 1-4: only the second occurrence of the start position (ply 4)
  check(before.over === null, `${name}: no draw after the second occurrence (ply 4)`);
  for (const [from, to] of SHUFFLE.slice(0, 3)) r.play(from, to);
  check(r.gameOver() === null && r.state.ply === 7, `${name}: still playing at ply 7`);
  r.play('f6', 'g8');
  const over = r.gameOver();
  check(over && over.reason === 'repetition' && over.winner === null && r.state.ply === 8, `${name}: the third occurrence (ply 8) ends the game as a draw by 'repetition'`);
}
{
  // Duck Chess: the duck must move every turn and does not stand anywhere before the first move, so the START position never comes back
  // - the first position that does is the one after ply 1 (knight out, duck on a3), at plies 1, 5 and 9. A duck that does NOT cycle
  // (below) never repeats at all.
  const r = newRoom({ duckChess: true });
  const ducks = ['a3', 'a6'];
  const res = runShuffle(r, 3, (ply) => ({ duckTo: ducks[ply % 2] }));
  check(res.over && res.over.reason === 'repetition' && res.endedAt === 9, 'Duck Chess: the duck is part of the position - the third occurrence of the position after ply 1 comes at ply 9, not 8');
  const walking = newRoom({ duckChess: true });
  const squares = ['a3', 'b3', 'c3', 'd3', 'a6', 'b6', 'c6', 'd6', 'h3', 'h6', 'g3', 'g6', 'a4', 'b4', 'c4', 'd4'];
  const res2 = runShuffle(walking, 3, (ply) => ({ duckTo: squares[ply % squares.length] }));
  check(res2.over === null && walking.state.ply === 12, 'Duck Chess: with the duck on a different square every time the same placement is never the same position - no draw in 12 plies');
}

// --- 4. Look-alikes ---------------------------------------------------------------------------------
console.log('\n=== 4. Positions that only LOOK identical do not count ===');
{
  // castling rights: the kings walk out and back, so the placement repeats but the rights are gone
  const r = newRoom({}, 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  const walk = [['e1', 'e2'], ['e8', 'e7'], ['e2', 'e1'], ['e7', 'e8']];
  let res = runShuffle(r, 2, undefined, walk);
  check(res.over === null && r.state.ply === 8, 'castling: the start placement came back at ply 4 and 8, but without the rights it is a different position - no draw at ply 8');
  res = runShuffle(r, 1, undefined, walk);
  check(res.over && res.over.reason === 'repetition' && r.state.ply === 10, '...the first position with BOTH rights gone is the one after ply 2 (it comes back at plies 6 and 10), so the draw is at ply 10');
}
{
  // Spell Chess: a cast changes charges / cooldowns / the pending freeze for several plies
  const r = newRoom({ spellChess: true });
  const first = r.play('g1', 'f3', { spell: { type: 'freeze', center: 'e5' } });
  check(first.ok === true, 'Spell Chess: White casts Freeze on ply 1');
  const rest = [['g8', 'f6'], ['f3', 'g1'], ['f6', 'g8']];
  for (const [f, t] of rest) assert.ok(r.play(f, t).ok);
  for (let c = 0; c < 1; c++) for (const [f, t] of SHUFFLE) assert.ok(r.play(f, t).ok);
  check(r.gameOver() === null && r.state.ply === 8, 'Spell Chess: the same placement at ply 4 and 8, but the spell state differs (the freeze was spent) - no draw at ply 8');
}

// --- 5. Rejoin mid-repetition ----------------------------------------------------------------------
console.log('\n=== 5. A reconnect between the second and third occurrence changes nothing ===');
{
  for (const [name, flags, fen] of [['Classic', {}, undefined], ['Fog of War', { fogOfWar: true }, undefined], ['Crazyhouse', { crazyhouse: true }, undefined]]) {
    const r = newRoom(flags, fen);
    runShuffle(r, 1);
    for (const [from, to] of SHUFFLE.slice(0, 2)) r.play(from, to);
    const rb = r.manager.rejoin('B2', { roomId: r.created.roomId, playerToken: r.created.blackPlayerToken });
    const rw = r.manager.rejoin('W2', { roomId: r.created.roomId, playerToken: r.created.whitePlayerToken });
    check(rb.ok === true && rw.ok === true, `${name}: both players rejoin at ply 6`);
    r.sockets.w = 'W2';
    r.sockets.b = 'B2';
    assert.ok(r.play('f3', 'g1').ok, 'ply 7 from the new socket');
    check(r.gameOver() === null, `${name}: ply 7 - still playing after the reconnects`);
    assert.ok(r.play('f6', 'g8').ok, 'ply 8 from the new socket');
    check(r.gameOver()?.reason === 'repetition', `${name}: ply 8 - the repetition draw still fires (the list lives in the room)`);
  }
}

// --- 6. Parity with the app --------------------------------------------------------------------------
console.log('\n=== 6. The server list and the app derive the same keys, ply by ply ===');
function snapshotEntry(room, san) {
  return {
    move: { from: '', to: '', san },
    fenBefore: '',
    fenAfter: room.engine.getFen(),
    ...(room.duckChess ? { duckSquare: room.duckSquare } : {}),
    ...(room.spellChess ? { spellState: JSON.parse(JSON.stringify(room.spellState)) } : {}),
    ...(room.crazyhouse ? { crazyhouse: JSON.parse(JSON.stringify(room.engine.getCrazyhouseState())) } : {}),
  };
}
{
  const variantOf = (room) => ({ threeCheck: room.threeCheck, crazyhouse: room.crazyhouse, duckChess: room.duckChess, spellChess: room.spellChess });
  let compared = 0;
  let disagreements = 0;
  for (const [name, flags, fen] of [...MODES, ['Duck Chess', { duckChess: true }, undefined]]) {
    const r = newRoom(flags, fen);
    const entries = [];
    const ducks = ['a3', 'a6'];
    let ply = 0;
    while (!r.gameOver() && ply < 20) {
      const [from, to] = SHUFFLE[ply % 4];
      const ack = r.play(from, to, flags.duckChess ? { duckTo: ducks[ply % 2] } : {});
      assert.ok(ack.ok, `${name} ply ${ply + 1} refused: ${ack.error}`);
      ply++;
      entries.push(snapshotEntry(r.room, ack.san));
      const mine = historyRepetitionKeys(r.room.initialFen, entries, variantOf(r.room));
      compared++;
      if (JSON.stringify(mine) !== JSON.stringify(r.room.repetitionKeys)) disagreements++;
      const appSaysDraw = isRepetitionDraw(r.room.initialFen, entries, variantOf(r.room));
      if (appSaysDraw !== (r.gameOver() !== null)) disagreements++;
    }
    check(r.gameOver()?.reason === 'repetition', `${name}: the game ended by repetition and the app derived the same keys at all ${ply} plies`);
  }
  check(disagreements === 0, `${compared} plies compared: the server's keys equal the app's historyRepetitionKeys, and the app says "draw" exactly when the server ended the game`);
}
{
  // Random repetition-prone games: both sides prefer to undo their last move; compare the lists every ply.
  const rng = seeded(171);
  let plies = 0;
  let ended = 0;
  let disagreements = 0;
  for (const [name, flags, fen] of [['Classic', {}, undefined], ['Three-Check', { threeCheck: true }, undefined], ['Fog of War', { fogOfWar: true }, undefined], ['Crazyhouse', { crazyhouse: true }, undefined]]) {
    for (let g = 0; g < 60; g++) {
      const r = newRoom(flags, fen);
      const entries = [];
      const last = { w: null, b: null };
      for (let ply = 0; ply < 90 && !r.gameOver(); ply++) {
        const turn = r.room.engine.getTurn();
        const client = new ClientEngine(r.room.engine.getFen(), { skipValidation: true, crazyhouse: flags.crazyhouse, crazyhouseState: flags.crazyhouse ? r.room.engine.getCrazyhouseState() : undefined });
        const moves = [];
        for (const row of client.getBoard()) for (const sq of row) if (sq.piece?.color === turn) for (const to of flags.fogOfWar ? client.getPseudoLegalMoves(turn).filter((m) => m.from === sq.square).map((m) => m.to) : client.getLegalMoves(sq.square)) moves.push({ from: sq.square, to });
        if (moves.length === 0) break;
        const undo = last[turn] && moves.find((m) => m.from === last[turn].to && m.to === last[turn].from);
        const pick = undo && rng() < 0.85 ? undo : moves[Math.floor(rng() * moves.length)];
        const ack = r.play(pick.from, pick.to);
        if (!ack.ok) break;
        last[turn] = pick;
        plies++;
        entries.push(snapshotEntry(r.room, ack.san));
        const variant = { threeCheck: r.room.threeCheck, crazyhouse: r.room.crazyhouse };
        if (JSON.stringify(historyRepetitionKeys(r.room.initialFen, entries, variant)) !== JSON.stringify(r.room.repetitionKeys)) disagreements++;
        if (isRepetitionDraw(r.room.initialFen, entries, variant) !== (r.gameOver()?.reason === 'repetition')) disagreements++;
      }
      if (r.gameOver()?.reason === 'repetition') ended++;
    }
    void name;
  }
  check(plies > 3000, `${plies} random plies played across four modes`);
  check(ended > 20, `${ended} of those games really ended by repetition`);
  check(disagreements === 0, 'the server list and the app derivation agreed at every ply, and the app flagged the draw whenever the server did');
}

console.log(`\nAll ${passed} checks passed.`);
