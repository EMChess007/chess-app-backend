// Ground-truth checks for getPseudoLegalMoves/getVisibleSquares — the shared reach/visibility
// primitive both the incremental and full-replay redaction paths are built on. Earlier tests only
// ever compared those two paths against EACH OTHER; a bug baked into the primitive itself (wrong
// pawn reach, sliding pieces not stopping at a blocker, pins or check incorrectly restricting
// pseudo-legal reach) would pass both of those silently. These check actual chess.js output
// against hand-verified positions instead — real ground truth, not cross-implementation
// agreement. Investigated and NOT found to be the source of any reported leak; kept permanently
// since this primitive is exactly the kind of thing a future refactor could quietly break.
//
// Run as part of the standard test suite: `node scripts/test-fogOfWarVisibilityGroundTruth.mjs`
// (needs tsx — see package.json's test:fogOfWarVisibilityGroundTruth script).

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

function reachFrom(fen, square, color) {
  const engine = new ChessEngine(fen, { skipValidation: true });
  return engine
    .getPseudoLegalMoves(color ?? engine.getTurn())
    .filter((m) => m.from === square)
    .map((m) => m.to)
    .sort();
}

function visible(fen, color) {
  const engine = new ChessEngine(fen, { skipValidation: true });
  const set = new Set();
  for (const row of engine.getBoard()) {
    for (const sq of row) {
      if (sq.piece?.color === color) set.add(sq.square);
    }
  }
  for (const m of engine.getPseudoLegalMoves(color)) set.add(m.to);
  return set;
}

console.log('\n=== Ground-truth visibility/reach checks (vs hand-verified chess rules, not cross-impl comparison) ===');

// --- Pawns ---------------------------------------------------------------
console.log('\n-- Pawns --');
{
  // White pawn e2, both e3/e4 empty, d3/f3 empty (no capture targets).
  const fen = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1';
  const r = reachFrom(fen, 'e2', 'w');
  check(JSON.stringify(r) === JSON.stringify(['e3', 'e4']), `unblocked e2 pawn reaches exactly e3+e4 (got ${r})`);
}
{
  // e3 occupied (by anyone) -> e2 pawn cannot reach e3 OR e4 (path blocked).
  const fen = '4k3/8/8/8/8/4n3/4P3/4K3 w - - 0 1';
  const r = reachFrom(fen, 'e2', 'w');
  check(r.length === 0, `e2 pawn with e3 blocked reaches nothing (got ${r})`);
}
{
  // d3 has a black piece -> e2 pawn should see d3 (capture) but NOT f3 (empty, no capture).
  const fen = '4k3/8/8/8/8/3n4/4P3/4K3 w - - 0 1';
  const r = reachFrom(fen, 'e2', 'w');
  check(JSON.stringify(r) === JSON.stringify(['d3', 'e3', 'e4']), `e2 pawn with enemy on d3 reaches d3+e3+e4, not f3 (got ${r})`);
}
{
  // Diagonal squares empty, no ep -> no diagonal reach at all.
  const fen = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1';
  const r = reachFrom(fen, 'e2', 'w');
  check(!r.includes('d3') && !r.includes('f3'), `e2 pawn does not falsely reach empty diagonal squares (got ${r})`);
}
{
  // En passant: black pawn just double-stepped d7-d5, white pawn on e5 can capture en passant to d6.
  const fen = 'rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3';
  const r = reachFrom(fen, 'e5', 'w');
  check(r.includes('d6'), `e5 pawn's reach includes the en passant target d6 (got ${r})`);
}

// --- Sliding pieces: rook/bishop/queen stop at first blocker, inclusive --
console.log('\n-- Sliding pieces (stop at first blocker, inclusive) --');
{
  // Rook a1, own KNIGHT on a4 (not a pawn — a pawn blocker would itself reach a5 by its own
  // forward push, confounding the test) -> getPseudoLegalMoves (actual MOVE targets) correctly
  // stops at a3 (a4 itself is occupied by a friendly piece, so it's not a move target at all — a
  // basic movement rule, not a legality filter) — but a4 is still VISIBLE, via getVisibleSquares'
  // separate "own pieces' own squares" clause, not via reach. a5 must NOT be visible (nothing
  // reaches it: the rook is blocked at a4, and a knight on a4 doesn't reach a5 itself).
  const fen = '4k3/8/8/8/N7/8/8/R3K3 w - - 0 1';
  const r = reachFrom(fen, 'a1', 'w');
  check(r.includes('a2') && r.includes('a3') && !r.includes('a4') && !r.includes('a5'), `rook a1 vs own blocker on a4: MOVE reach stops at a3, a4 excluded (own piece), nothing beyond (got ${r})`);
  const v = visible(fen, 'w');
  check(v.has('a4') && !v.has('a5'), `...but a4 itself is still VISIBLE (own piece's own square), a5+ is not (got a4=${v.has('a4')}, a5=${v.has('a5')})`);
}
{
  // Rook a1, enemy pawn a4 -> sees a2,a3,a4 (can capture there), not a5+.
  const fen = '4k3/8/8/8/p7/8/8/R3K3 w - - 0 1';
  const r = reachFrom(fen, 'a1', 'w');
  check(r.includes('a2') && r.includes('a3') && r.includes('a4') && !r.includes('a5'), `rook a1 vs enemy blocker on a4: sees up to and including a4, not beyond (got ${r})`);
}
{
  // Bishop c1, enemy piece on f4 along the diagonal -> sees d2,e3,f4, not g5/h6.
  const fen = '4k3/8/8/8/5p2/8/8/2B1K3 w - - 0 1';
  const r = reachFrom(fen, 'c1', 'w');
  check(r.includes('d2') && r.includes('e3') && r.includes('f4') && !r.includes('g5') && !r.includes('h6'), `bishop c1 vs blocker on f4: sees up to and including f4, not beyond (got ${r})`);
}
{
  // Queen d1, own KNIGHT on d4 (not a pawn, for the same reason as the rook test above) -> move
  // reach stops at d3 (d4 occupied by own piece, excluded as a move target), but d4 is still
  // visible via the own-piece clause; d5 must NOT be visible (the knight on d4 doesn't reach d5).
  const fen = '4k3/8/8/8/3N4/8/8/3QK3 w - - 0 1';
  const r = reachFrom(fen, 'd1', 'w');
  check(r.includes('d2') && r.includes('d3') && !r.includes('d4') && !r.includes('d5'), `queen d1 vs own blocker on d4: MOVE reach stops at d3, d4 excluded (own piece), nothing beyond (got ${r})`);
  const v = visible(fen, 'w');
  check(v.has('d4') && !v.has('d5'), `...but d4 itself is still VISIBLE (own piece's own square), d5+ is not (got d4=${v.has('d4')}, d5=${v.has('d5')})`);
}

// --- Pinned pieces: still show full reach (visibility != legality) ------
console.log('\n-- Pinned pieces --');
{
  // White king e1, white bishop e2, black rook e8 -- bishop pinned along the e-file.
  // Its pseudo-legal diagonal reach must be its FULL diagonal, unrestricted by the pin.
  const fen = '4r3/8/8/8/8/8/4B3/4K3 w - - 0 1';
  const r = reachFrom(fen, 'e2', 'w');
  const expectedDiagonals = ['d1', 'f1', 'd3', 'c4', 'b5', 'a6', 'f3', 'g4', 'h5'];
  const hasAllDiagonals = expectedDiagonals.every((sq) => r.includes(sq));
  check(hasAllDiagonals, `pinned bishop on e2 still shows its full unrestricted diagonal reach (got ${r})`);
}
{
  // Same idea with a knight actually pinned (can't move AT ALL legally) -- pseudo-legal reach
  // must still show its normal L-shaped squares.
  const fen = '4r3/8/8/8/8/8/4N3/4K3 w - - 0 1';
  const r = reachFrom(fen, 'e2', 'w');
  const expectedKnightSquares = ['c1', 'c3', 'd4', 'f4', 'g1', 'g3'];
  const hasAll = expectedKnightSquares.every((sq) => r.includes(sq));
  check(hasAll, `pinned knight on e2 still shows its full unrestricted L-shaped reach (got ${r})`);
}

// --- King in check must not restrict OTHER pieces' pseudo-legal reach ---
console.log('\n-- King in check does not restrict other pieces --');
{
  // White king e4 in check from a knight on d2. A completely unrelated white rook on a1 (clear
  // file and clear rank — the king is off both) should still show its FULL, unobstructed reach —
  // not restricted to "block/capture the checking piece", which is what LEGAL move filtering
  // (not pseudo-legal) would do.
  const fen = '4k3/8/8/8/4K3/8/3n4/R7 w - - 0 1';
  const engine = new ChessEngine(fen, { skipValidation: true });
  check(engine.getStatus() === 'check', 'sanity: White king is actually in check in this position');
  const r = reachFrom(fen, 'a1', 'w');
  check(
    r.includes('a2') && r.includes('a8') && r.includes('h1') && r.includes('b1'),
    `rook a1's full reach is untouched while king is in check elsewhere (got ${r})`
  );
}
{
  // Also check via getVisibleSquares directly (the actual function screens use).
  const fen = '4k3/8/8/8/4K3/8/3n4/R7 w - - 0 1';
  const v = visible(fen, 'w');
  check(v.has('a8') && v.has('h1'), `getVisibleSquares also shows the rook's full reach despite check (visible has a8/h1: ${v.has('a8')}/${v.has('h1')})`);
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
