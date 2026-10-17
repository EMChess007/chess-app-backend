#!/usr/bin/env node
/**
 * Fog of War notation — server-side regression suite, no running server needed. Run with tsx:
 *   npx tsx scripts/test-fogOfWarNotation.mjs      (or: npm run test:fogOfWarNotation)
 *
 * THE RULE (chess.com): in Fog of War players are never notified of a check. chess.js writes '+'/'#' into every SAN, computed on
 * the TRUE board, so a discovered check by a piece the victim cannot see used to reach them as "Nc3+" (found while auditing the
 * castling fix, Command #5). movePseudoLegal now returns `san` without the marker and the real notation as `trueSan`; the server
 * hands `trueSan` only to spectators (who see the whole board) and to the finished game's saved PGN.
 *
 * Layers:
 *  1. NO DRIFT: backend/src/game/fogOfWarNotation.ts is byte-identical to the app's src/logic/fogOfWarNotation.ts.
 *  2. PARITY: random Fog of War games through both engines agree on san AND trueSan, and no san carries a marker.
 *  3. THE REPRO through RoomManager.applyMove: 4k3/6b1/8/8/4N3/8/8/4R1K1, White plays Ne4-c3 (a discovered check from the hidden
 *     rook e1) -> the mover's ack and Black's opponent_move say "Nc3"; a spectator's spectator_move and a spectator who joins
 *     later see "Nc3+"; a rejoining player's history says "Nc3"; the saved PGN is built from the real notation.
 *  4. PROPERTY: random Fog of War games through RoomManager with two players and a spectator — NO payload addressed to a player
 *     (acks, opponent_move, rejoin state) ever contains a '+'/'#' notation or a `trueSan` field while the game is live; the
 *     spectator does see the markers (so the property is not vacuous).
 *  5. THE PAWN-CAPTURE PROBE (point (a) of the castling report): a pawn capture onto a fogged empty square is refused with
 *     exactly the same answer as any other malformed move, and the official app's generator never offers it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ChessEngine as ClientEngine } from '../../src/logic/ChessEngine.ts';
import { RoomChessEngine } from '../src/game/RoomChessEngine.ts';
import { RoomManager } from '../src/game/rooms.ts';
import { buildPgn } from '../src/game/pgn.ts';
import { buildRedactedFen } from '../src/game/fogOfWar.ts';

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ✓ ${message}`);
}
const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);
const MARKER = /[+#]$/;

function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- 1. No drift -----------------------------------------------------------------------------------
console.log('\n=== 1. The notation helper is a verbatim copy of the mobile one ===');
{
  const read = (path) => readFileSync(path, 'utf8').split(CRLF).join(LF);
  const mobile = read(new URL('../../src/logic/fogOfWarNotation.ts', import.meta.url));
  const server = read(new URL('../src/game/fogOfWarNotation.ts', import.meta.url));
  check(mobile.length > 800, 'the helper was found in both repos');
  check(mobile === server, 'backend/src/game/fogOfWarNotation.ts and src/logic/fogOfWarNotation.ts are identical (edit BOTH together)');
}

// --- 2. Engine parity ------------------------------------------------------------------------------
console.log('\n=== 2. Both engines hide the marker the same way ===');
{
  const REPRO = '4k3/6b1/8/8/4N3/8/8/4R1K1 w - - 0 1';
  for (const [name, make] of [
    ['mobile ChessEngine', (fen) => new ClientEngine(fen, { skipValidation: true })],
    ['server RoomChessEngine', (fen) => new RoomChessEngine(fen)],
  ]) {
    const move = make(REPRO).movePseudoLegal('e4', 'c3');
    check(move.san === 'Nc3' && move.trueSan === 'Nc3+', `${name}: the repro move is "Nc3" with trueSan "Nc3+"`);
    check(make('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1').movePseudoLegal('a1', 'a8').trueSan === 'Ra8#', `${name}: a checkmate is hidden too`);
    const quiet = make('4k3/8/8/8/8/8/8/R3K3 w Q - 0 1').movePseudoLegal('a1', 'a2');
    check(quiet.san === 'Ra2' && !('trueSan' in quiet), `${name}: a quiet move has no trueSan`);
  }
  const spell = new RoomChessEngine('4k3/8/8/8/8/8/8/R3K3 w Q - 0 1', { spellChess: true, freezeEscapeActive: true });
  check(spell.move('a1', 'a8')?.san === 'Ra8+', 'Spell Chess (its freeze-escape move uses the pseudo-legal path) keeps its check notation on the server');
  const rng = seeded(171);
  let plies = 0;
  let marked = 0;
  let mismatches = 0;
  for (let g = 0; g < 150; g++) {
    const a = new ClientEngine(undefined, { skipValidation: true });
    const b = new RoomChessEngine();
    for (let ply = 0; ply < 70; ply++) {
      const moves = a.getPseudoLegalMoves(a.getTurn());
      if (moves.length === 0) break;
      const pick = moves[Math.floor(rng() * moves.length)];
      const ma = a.movePseudoLegal(pick.from, pick.to, pick.promotion);
      const mb = b.movePseudoLegal(pick.from, pick.to, pick.promotion);
      plies++;
      if (!ma || !mb || ma.san !== mb.san || ma.trueSan !== mb.trueSan || MARKER.test(ma.san) || MARKER.test(mb.san)) mismatches++;
      if (ma?.trueSan) marked++;
      if (ma?.captured === 'k') break;
    }
  }
  check(plies > 3000 && marked > 100, `${plies} random plies replayed, ${marked} of them with a check marker (so the check is not vacuous)`);
  check(mismatches === 0, 'both engines agree on san and trueSan every ply, and no san carries a marker');
}

// --- shared room helpers ---------------------------------------------------------------------------
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
/** Every { key, value } pair anywhere inside `payload` whose key is `san` or `trueSan`. */
function notations(payload, out = []) {
  if (Array.isArray(payload)) payload.forEach((p) => notations(p, out));
  else if (payload && typeof payload === 'object') {
    for (const [k, v] of Object.entries(payload)) {
      if (k === 'san' || k === 'trueSan') out.push({ key: k, value: v });
      else notations(v, out);
    }
  }
  return out;
}
const leaks = (payload) => notations(payload).filter((n) => n.key === 'trueSan' || (typeof n.value === 'string' && MARKER.test(n.value)));

// --- 3. The repro through the authority ------------------------------------------------------------
console.log('\n=== 3. Ne4-c3 (a discovered check from a hidden rook) through RoomManager.applyMove ===');
{
  const REPRO = '4k3/6b1/8/8/4N3/8/8/4R1K1 w - - 0 1';
  const { io, manager, created, move } = fogRoom(REPRO);
  check(!created.blackView.fen.includes('R'), "Black's redacted view has no white rook (the checking piece is hidden)");
  const watcher = manager.spectate('S', created.roomId);
  check(watcher.ok === true, 'a spectator joins');
  const ack = move('W', 'e4', 'c3');
  check(ack.ok === true && ack.san === 'Nc3', "the mover's ack says \"Nc3\"");
  const toBlack = io.events.find((e) => e.id === 'B' && e.event === 'opponent_move');
  check(toBlack.payload.san === 'Nc3' && toBlack.payload.to === 'c3', 'Black (who can see c3) receives \"Nc3\" - NOT \"Nc3+\"');
  const toSpectator = io.events.find((e) => e.id === 'S' && e.event === 'spectator_move');
  check(toSpectator.payload.san === 'Nc3+', 'the spectator, who sees the whole board, receives the real "Nc3+"');
  const late = manager.spectate('S2', created.roomId);
  check(late.state.moves[0].san === 'Nc3+' && !('trueSan' in late.state.moves[0]), 'a spectator who joins later sees "Nc3+" in the history (no trueSan field)');
  const rejoinBlack = manager.rejoin('B2', { roomId: created.roomId, playerToken: created.blackPlayerToken });
  check(rejoinBlack.ok === true && leaks(rejoinBlack).length === 0, "Black's rejoin state (the redacted move list) carries no marker and no trueSan");
  check(rejoinBlack.state.moves[0].san === 'Nc3', '...it says "Nc3"');
  const rejoinWhite = manager.rejoin('W2', { roomId: created.roomId, playerToken: created.whitePlayerToken });
  check(rejoinWhite.ok === true && leaks(rejoinWhite).length === 0 && rejoinWhite.state.moves[0].san === 'Nc3', "White's rejoin state says \"Nc3\" too");
  check(leaks(io.events.filter((e) => e.id === 'W' || e.id === 'B').map((e) => e.payload)).length === 0, 'nothing else addressed to a player carries a marker or trueSan');
  // the saved PGN is built from the real notation (the game is over by then)
  const pgn = buildPgn(REPRO, [{ from: 'e4', to: 'c3', san: 'Nc3+' }], '1-0', undefined);
  check(/Nc3\+/.test(pgn), 'buildPgn keeps whatever notation it is given (rooms.ts feeds it the real one)');
  const source = readFileSync(new URL('../src/game/rooms.ts', import.meta.url), 'utf8').split(CRLF).join(LF);
  check(source.includes('buildPgn(room.initialFen, withTrueNotation(room.moves), result, variantPgnTag(room))'), 'persistGameResult builds the PGN from withTrueNotation(room.moves)');
  check(source.includes('san: result.trueSan ?? result.san,'), 'spectator_move is built from trueSan');
  check(source.includes('moves: withTrueNotation(room.moves),'), 'the spectate state is built from withTrueNotation');
}

// --- 4. Property over random games ------------------------------------------------------------------
console.log('\n=== 4. Property: no payload addressed to a player ever carries a check marker while the game is live ===');
{
  const rng = seeded(4242);
  let games = 0;
  let plies = 0;
  let spectatorMarked = 0;
  let playerLeaks = 0;
  let rejoinChecks = 0;
  for (let g = 0; g < 250; g++) {
    const { io, manager, created, move } = fogRoom(undefined);
    manager.spectate('S', created.roomId);
    const engine = new RoomChessEngine();
    games++;
    let over = false;
    for (let ply = 0; ply < 90 && !over; ply++) {
      const turn = engine.getTurn();
      const moves = engine.getPseudoLegalMoves(turn);
      if (moves.length === 0) break;
      const pick = moves[Math.floor(rng() * moves.length)];
      const ack = move(turn === 'w' ? 'W' : 'B', pick.from, pick.to, pick.promotion);
      if (!ack.ok) break;
      const applied = engine.movePseudoLegal(pick.from, pick.to, pick.promotion);
      plies++;
      if (leaks(ack).length) playerLeaks++;
      over = applied.captured === 'k';
      if (ply % 15 === 14 && !over) {
        // a player reconnecting mid-game is shown the redacted history too
        const r = manager.rejoin(turn === 'w' ? 'W' : 'B', { roomId: created.roomId, playerToken: turn === 'w' ? created.whitePlayerToken : created.blackPlayerToken });
        if (r.ok) {
          rejoinChecks++;
          if (leaks(r).length) playerLeaks++;
        }
      }
    }
    for (const e of io.events) {
      if (e.id === 'W' || e.id === 'B') {
        if (leaks(e.payload).length) playerLeaks++;
      } else if (e.event === 'spectator_move' && MARKER.test(e.payload.san)) spectatorMarked++;
    }
  }
  check(plies > 3000, `${games} games, ${plies} plies through the server`);
  check(spectatorMarked > 100, `spectators received ${spectatorMarked} real "+"/"#" notations (the property is not vacuous)`);
  check(rejoinChecks > 50, `${rejoinChecks} mid-game rejoins were scanned as well`);
  check(playerLeaks === 0, 'not one payload addressed to a player contained a "+"/"#" notation or a trueSan field');
}

// --- 5. The pawn-capture probe ----------------------------------------------------------------------
console.log('\n=== 5. A pawn capture onto a fogged empty square looks like any other malformed move ===');
{
  // White pawn b2; nothing on a3/c3. A modified client probes b2xa3 / b2xc3 hoping to learn whether a hidden piece stands there.
  const FEN = '4k3/8/8/8/8/8/1P6/4K3 w - - 0 1';
  const { move } = fogRoom(FEN);
  const probe = move('W', 'b2', 'a3');
  const garbage = [move('W', 'b2', 'b6'), move('W', 'a8', 'a1'), move('W', 'e1', 'e5'), move('W', 'zz', 'a1'), move('W', 'b2', 'b2')];
  check(probe.ok === false && probe.error === 'Invalid move.', 'the probe is refused with "Invalid move."');
  check(garbage.every((r) => r.ok === false && r.error === 'Invalid move.'), 'so is every other malformed move - the very same text');
  check(JSON.stringify(Object.keys(probe).sort()) === JSON.stringify(Object.keys(garbage[0]).sort()), 'the refusals have exactly the same shape');
  // timing is reported, not asserted (a CI runner is too noisy): both go through the same movePseudoLegal scan
  const time = (f) => {
    const t = process.hrtime.bigint();
    for (let i = 0; i < 400; i++) f();
    return Number(process.hrtime.bigint() - t) / 400 / 1000;
  };
  const { move: m2 } = fogRoom(FEN);
  console.log(`    (median-ish per refusal: pawn probe ${time(() => m2('W', 'b2', 'a3')).toFixed(1)}us, malformed ${time(() => m2('W', 'b2', 'b6')).toFixed(1)}us)`);
  // ...and the same probe that DOES hit a piece is not a probe at all: it is a real capture and costs the turn.
  const { move: m3 } = fogRoom('4k3/8/8/8/8/n7/1P6/4K3 w - - 0 1');
  const hit = m3('W', 'b2', 'a3');
  check(hit.ok === true && hit.san === 'bxa3', 'a diagonal move onto a hidden enemy piece is simply a legal capture (it costs the turn)');
  // The official app never produces the probe: its generator only offers a pawn capture onto a square showing an enemy piece.
  const rng = seeded(99);
  let offeredCaptures = 0;
  let refused = 0;
  for (let i = 0; i < 3000; i++) {
    const engine = new RoomChessEngine();
    // a random middlegame: play random moves (a position after a king capture is not a live game: skip it)
    let ended = false;
    for (let ply = 0; ply < 10 + Math.floor(rng() * 40) && !ended; ply++) {
      const ms = engine.getPseudoLegalMoves(engine.getTurn());
      if (!ms.length) break;
      const p = ms[Math.floor(rng() * ms.length)];
      ended = engine.movePseudoLegal(p.from, p.to, p.promotion)?.captured === 'k';
    }
    if (ended) continue;
    const color = engine.getTurn();
    const view = new ClientEngine(buildRedactedFen(engine, color), { skipValidation: true });
    for (const m of view.getPseudoLegalMoves(color)) {
      if (view.getPieceAt(m.from)?.type !== 'p' || m.from[0] === m.to[0]) continue;
      offeredCaptures++;
      if (!new RoomChessEngine(engine.getFen()).movePseudoLegal(m.from, m.to, m.promotion)) refused++;
    }
  }
  check(offeredCaptures > 500, `${offeredCaptures} pawn captures offered by the app's own generator over 3000 random positions`);
  check(refused === 0, 'the server accepted every one of them - the app can never send the refused probe by itself');
}

console.log(`\nAll ${passed} checks passed.`);
