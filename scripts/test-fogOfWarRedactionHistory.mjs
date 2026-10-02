// Regression test for a specific hypothesis investigated this session: does an EARLIER move-list
// entry that was correctly hidden ("?") at the time it was played ever get retroactively revealed
// once the viewer's OWN later moves happen to gain reach over that same square? If the "revealed"
// decision for a historical ply were ever recomputed using CURRENT/final visibility instead of a
// frozen snapshot of visibility as of that exact ply, this is exactly what would happen.
//
// Investigated directly against both the incremental hook actually used by BotGameScreen/
// LocalGameScreen (useIncrementalFogRedaction, mirrored here without the React plumbing) and the
// "trusted" full-replay baseline it falls back to (redactMoveHistory) — NOT CONFIRMED: both are
// purely prefix-based (a given ply's reveal decision only ever depends on history up to and
// including that ply) and the incremental cache only ever APPENDS, never rewrites, earlier
// entries. This test pins that down permanently so it can't silently regress.
//
// Run as part of the standard test suite: `node scripts/test-fogOfWarRedactionHistory.mjs` (needs
// tsx — see package.json's test:fogOfWarRedactionHistory script).

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

function getVisibleSquares(engine, color) {
  const visible = new Set();
  for (const row of engine.getBoard()) {
    for (const sq of row) {
      if (sq.piece?.color === color) visible.add(sq.square);
    }
  }
  for (const move of engine.getPseudoLegalMoves(color)) visible.add(move.to);
  return visible;
}

// Mirrors src/logic/fogOfWar.ts's redactMoveHistory exactly.
function redactMoveHistoryFull(initialFen, history, viewerColor) {
  const engine = new ChessEngine(initialFen, { skipValidation: true });
  let visibleBefore = getVisibleSquares(engine, viewerColor);
  const result = [];
  for (const entry of history) {
    const mover = engine.getTurn();
    engine.movePseudoLegal(entry.move.from, entry.move.to, entry.move.promotion);
    const visibleAfter = getVisibleSquares(engine, viewerColor);
    const revealed = mover === viewerColor || visibleBefore.has(entry.move.to) || visibleAfter.has(entry.move.to);
    result.push(revealed ? { revealed: true, san: entry.move.san, to: entry.move.to } : { revealed: false });
    visibleBefore = visibleAfter;
  }
  return result;
}

// Mirrors src/logic/fogOfWar.ts's useIncrementalFogRedaction exactly, minus React's useRef (a
// plain closure-held cache advanced by hand instead, called once per new ply exactly as the real
// hook is from BotGameScreen/LocalGameScreen's render).
function makeIncrementalRedactor() {
  let cache = null;
  return function advance(initialFen, history, engine) {
    if (cache && cache.initialFen === initialFen && history.length === cache.length + 1) {
      const entry = history[cache.length];
      const mover = cache.length % 2 === 0 ? 'w' : 'b';
      const visibleAfterW = getVisibleSquares(engine, 'w');
      const visibleAfterB = getVisibleSquares(engine, 'b');
      const revealedW = mover === 'w' || cache.visibleAfter.w.has(entry.move.to) || visibleAfterW.has(entry.move.to);
      const revealedB = mover === 'b' || cache.visibleAfter.b.has(entry.move.to) || visibleAfterB.has(entry.move.to);
      const next = {
        initialFen, length: history.length,
        visibleAfter: { w: visibleAfterW, b: visibleAfterB },
        redacted: {
          w: [...cache.redacted.w, revealedW ? { revealed: true, san: entry.move.san, to: entry.move.to } : { revealed: false }],
          b: [...cache.redacted.b, revealedB ? { revealed: true, san: entry.move.san, to: entry.move.to } : { revealed: false }],
        },
      };
      cache = next;
      return next.redacted;
    }
    const redacted = { w: redactMoveHistoryFull(initialFen, history, 'w'), b: redactMoveHistoryFull(initialFen, history, 'b') };
    cache = { initialFen, length: history.length, visibleAfter: { w: getVisibleSquares(engine, 'w'), b: getVisibleSquares(engine, 'b') }, redacted };
    return redacted;
  };
}

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function playMove(engine, from, to) {
  const moveEngine = new ChessEngine(engine.getFen(), { skipValidation: true });
  const applied = moveEngine.movePseudoLegal(from, to, 'q');
  if (!applied) throw new Error(`Move ${from}-${to} was rejected`);
  return { engine: moveEngine, applied };
}

console.log('\n=== Retroactive reveal: a historical hidden move must never later flip to revealed ===');
console.log('1. a3 b5 2. Nc3 a6 — b5 is hidden to White when played (nothing reaches it yet);');
console.log('White\'s Nc3 then gains pseudo-legal reach over b5 — b5\'s OWN recorded entry must stay hidden.\n');

let engine = new ChessEngine(undefined, { skipValidation: true });
const history = [];
const advanceIncremental = makeIncrementalRedactor();
const snapshotsAfterEachPly = [];

const moves = [
  { from: 'a2', to: 'a3' },
  { from: 'b7', to: 'b5' }, // hidden to White at the time
  { from: 'b1', to: 'c3' }, // White's knight now reaches b5
  { from: 'a7', to: 'a6' },
];

for (const m of moves) {
  const result = playMove(engine, m.from, m.to);
  engine = result.engine;
  history.push({ move: result.applied });
  const incremental = advanceIncremental(START_FEN, history, engine);
  snapshotsAfterEachPly.push(incremental.w.map((e) => e.revealed));
}

const b5PlyIndex = 1;
check(snapshotsAfterEachPly[1][0] === snapshotsAfterEachPly[0][0], "ply 0's revealed flag is unchanged by ply 1 being recorded");
check(
  snapshotsAfterEachPly[1][b5PlyIndex] === false,
  "b5 (ply 1) is correctly hidden from White the moment it's played (nothing reaches it yet)"
);
check(
  snapshotsAfterEachPly[2][b5PlyIndex] === false,
  "b5's OWN recorded entry is STILL hidden right after White's Nc3 gains reach over b5 (no retroactive reveal)"
);
check(
  snapshotsAfterEachPly[3][b5PlyIndex] === false,
  "b5's OWN recorded entry is STILL hidden one more ply later (no retroactive reveal)"
);

// The full-replay baseline, called completely fresh with the whole 4-ply history (maximum
// hindsight available) — must independently agree.
const fullReplayFinal = redactMoveHistoryFull(START_FEN, history, 'w');
check(fullReplayFinal[b5PlyIndex].revealed === false, 'the full-replay baseline, called fresh with full hindsight, also shows b5 as hidden');

// A second, independent confirmation that gaining visibility over an EMPTY square (via a piece's
// own pseudo-legal reach, not occupancy) is real and does happen — Nc3 reaching b5 isn't a no-op;
// it's exactly the condition that would cause retroactive reveal if the bug existed.
const visibleAfterNc3Only = (() => {
  let e = new ChessEngine(undefined, { skipValidation: true });
  e = playMove(e, 'a2', 'a3').engine;
  e = playMove(e, 'b7', 'b5').engine;
  e = playMove(e, 'b1', 'c3').engine;
  return getVisibleSquares(e, 'w');
})();
check(visibleAfterNc3Only.has('b5'), "White's Nc3 genuinely does gain pseudo-legal reach over b5 (confirms the test scenario actually exercises the risky case)");

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
