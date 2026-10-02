// Regression test for a real perf bug found and fixed during this session: getPseudoLegalMoves
// and movePseudoLegal used to wrap EVERY scanned pseudo-legal candidate in a full chess.js `Move`
// object just to read from/to/promotion — that wrapper's constructor eagerly computes `.san` (a
// complete _moves({legal:true}) regeneration for disambiguation) plus two `.fen()` calls (one via
// an actual make+undo), none of which any caller here ever reads. Measured directly: this made a
// single movePseudoLegal call ~10x more expensive than chess.js's own fully-validated `.move()`,
// worst for pieces with many reachable squares — exactly what runs on every tap/selection in Fog
// of War. Fixed by reading from/to/promotion straight off the raw internal move instead. This
// test asserts the fix holds (average well under chess.js's own baseline), not just that moves
// still work — a correctness-only test wouldn't catch this regressing back in.
//
// Run as part of the standard test suite: `node scripts/test-fogOfWarPerformance.mjs` (needs tsx
// — see package.json's test:fogOfWarPerformance script).

import { ChessEngine } from '../../src/logic/ChessEngine.ts';

let failures = 0;
function check(condition, label) {
  if (condition) {
    console.log(`  OK: ${label}`);
  } else {
    failures++;
    console.log(`  FAIL: ${label}`);
  }
}

function randInt(n) {
  return Math.floor(Math.random() * n);
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function profile(fogOfWar) {
  const times = [];
  for (let g = 0; g < 30; g++) {
    let engine = new ChessEngine(undefined, { skipValidation: fogOfWar });
    for (let ply = 0; ply < 40; ply++) {
      const turn = engine.getTurn();
      const pool = fogOfWar
        ? engine.getPseudoLegalMoves(turn)
        : (() => {
            const all = [];
            for (const row of engine.getBoard()) {
              for (const sq of row) {
                if (sq.piece?.color === turn) {
                  for (const to of engine.getLegalMoves(sq.square)) all.push({ from: sq.square, to });
                }
              }
            }
            return all;
          })();
      if (pool.length === 0) break;
      const pick = pool[randInt(pool.length)];
      const fenBefore = engine.getFen();
      const moveEngine = new ChessEngine(fenBefore, { skipValidation: fogOfWar });

      const t0 = process.hrtime.bigint();
      const applied = fogOfWar
        ? moveEngine.movePseudoLegal(pick.from, pick.to, pick.promotion ?? 'q')
        : moveEngine.move(pick.from, pick.to, 'q');
      const t1 = process.hrtime.bigint();

      if (!applied) break;
      times.push(Number(t1 - t0) / 1000);
      engine = moveEngine;
      if (applied.captured === 'k') break;
    }
  }
  return times;
}

console.log('\n=== Fog of War movePseudoLegal performance ===');
const normalTimes = profile(false);
const fogTimes = profile(true);
const normalMedian = median(normalTimes);
const fogMedian = median(fogTimes);

console.log(`  Normal move() median: ${normalMedian.toFixed(1)}us (n=${normalTimes.length})`);
console.log(`  Fog movePseudoLegal median: ${fogMedian.toFixed(1)}us (n=${fogTimes.length})`);
console.log(`  Ratio: ${(fogMedian / normalMedian).toFixed(2)}x`);

check(normalTimes.length > 500 && fogTimes.length > 500, 'swept a meaningful number of moves in both paths');
// Generous bound (the fix brought this to roughly parity with, or faster than, move() — movePseudoLegal
// skips chess.js's own king-safety filtering entirely) — well short of the ~10x blowup the
// per-candidate-wrapper bug caused, which would fail this easily.
check(fogMedian < normalMedian * 3, `movePseudoLegal median (${fogMedian.toFixed(1)}us) stays within 3x of move()'s (${normalMedian.toFixed(1)}us) — catches the per-candidate-wrapper regression`);

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
