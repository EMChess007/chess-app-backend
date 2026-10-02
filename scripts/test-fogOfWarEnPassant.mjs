// Regression test for a real bug found and fixed during this session: under Fog of War, a
// pseudo-legal en passant capture that exposes the capturing side's own king (normally illegal,
// explicitly allowed by this variant) could be shown to the player as an available move
// (getPseudoLegalMoves) and then silently fail the instant it was actually played
// (movePseudoLegal), because chess.js's own `.fen()` serializer omits the en-passant target
// square whenever the capture would expose the king — a check `_moves({legal:false})` does not
// apply — so a FRESH engine reconstructed from that FEN string (exactly what ChessBoard's
// handleSquarePress and the server's broadcasted fen both do) loses the information needed to
// regenerate the capture. Fixed via `.fen({ forceEnpassantSquare: true })` in both
// src/logic/ChessEngine.ts and backend/src/game/RoomChessEngine.ts's getFen(). This script
// exercises both twins directly — no live server needed, this is pure chess-logic coverage.
//
// Run as part of the standard test suite: `node scripts/test-fogOfWarEnPassant.mjs`.

import { ChessEngine } from '../../src/logic/ChessEngine.ts';
import { RoomChessEngine } from '../src/game/RoomChessEngine.ts';

let failures = 0;
function check(condition, label) {
  if (condition) {
    console.log(`  OK: ${label}`);
  } else {
    failures++;
    console.log(`  FAIL: ${label}`);
  }
}

// Hand-built: White pawn d5 can capture Black's just-double-stepped e-pawn en passant (dxe6).
// Doing so removes BOTH the d5 and e5 pawns, opening all of rank 5 to Black's rook on a5 against
// White's own king on h5 — a textbook en passant discovered-check position. Ordinary chess.js
// legality (and this app's normal move()) would refuse dxe6 here; Fog of War must allow it.
const KING_EXPOSING_EP_FEN = '4k3/8/8/r2Pp2K/8/8/8/8 w - e6 0 1';

function testEngine(name, EngineClass) {
  console.log(`\n=== ${name}: en passant capture that exposes the mover's own king ===`);

  const engine = new EngineClass(KING_EXPOSING_EP_FEN, { skipValidation: true });
  const shownAsAvailable = engine
    .getPseudoLegalMoves('w')
    .some((m) => m.from === 'd5' && m.to === 'e6');
  check(shownAsAvailable, 'dxe6 is offered by getPseudoLegalMoves (what the UI shows as a dot)');

  // Exactly the pattern ChessBoard.handleSquarePress (and the server's broadcasted fen) use: a
  // FRESH engine reconstructed from the current fen string, not the live, continuously-played one.
  const freshFen = engine.getFen();
  check(freshFen.split(' ')[3] === 'e6', 'getFen() preserves the ep-target square (e6), not "-"');

  const moveEngine = new EngineClass(freshFen, { skipValidation: true });
  const result = moveEngine.movePseudoLegal('d5', 'e6', undefined);
  check(result !== null && result.san === 'dxe6', 'movePseudoLegal on that fresh engine still accepts dxe6 (the actual regression)');
}

testEngine('Mobile app (src/logic/ChessEngine.ts)', ChessEngine);
testEngine('Server (backend/src/game/RoomChessEngine.ts)', RoomChessEngine);

// A small, fixed-seed (deterministic, non-flaky) randomized sweep as an extra net against this
// whole class of "shown as pseudo-legal, rejected once reconstructed from fen" bug recurring for
// some other move type — not just en passant. Same PRNG algorithm + seed every run.
function makeRng(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

console.log('\n=== Fixed-seed sweep: getPseudoLegalMoves vs movePseudoLegal across 6 games ===');
const rng = makeRng(20260205);
let totalChecked = 0;
let totalMismatches = 0;
const mismatchExamples = [];

for (let g = 0; g < 6; g++) {
  let engine = new ChessEngine(undefined, { skipValidation: true });
  for (let ply = 0; ply < 16; ply++) {
    const turn = engine.getTurn();
    const pseudo = engine.getPseudoLegalMoves(turn);
    if (pseudo.length === 0) break;

    const curFen = engine.getFen();
    for (const cand of pseudo) {
      totalChecked++;
      const probe = new ChessEngine(curFen, { skipValidation: true });
      const result = probe.movePseudoLegal(cand.from, cand.to, cand.promotion ?? 'q');
      if (!result) {
        totalMismatches++;
        if (mismatchExamples.length < 5) mismatchExamples.push({ fen: curFen, from: cand.from, to: cand.to, san: cand.san });
      }
    }

    const pick = pseudo[Math.floor(rng() * pseudo.length)];
    const moveEngine = new ChessEngine(curFen, { skipValidation: true });
    const applied = moveEngine.movePseudoLegal(pick.from, pick.to, pick.promotion ?? 'q');
    if (!applied) break;
    engine = moveEngine;
    if (applied.captured === 'k') break;
  }
}
check(totalChecked > 1000, `swept a meaningful number of candidates (${totalChecked})`);
check(totalMismatches === 0, `zero mismatches across ${totalChecked} candidates (found: ${totalMismatches})`);
if (mismatchExamples.length > 0) {
  console.log('  Examples:');
  for (const ex of mismatchExamples) console.log('   ', JSON.stringify(ex));
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
