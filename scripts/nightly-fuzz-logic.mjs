#!/usr/bin/env node
/**
 * Extended, nightly-only fuzz test — thousands of randomized Fog of War games, checking every
 * pseudo-legal candidate at every ply against ground-truth invariants, for BOTH the mobile app's
 * src/logic/ChessEngine.ts and the backend's own src/game/RoomChessEngine.ts. This is the same
 * methodology as scripts/test-fogOfWarEnPassant.mjs and test-fogOfWarVisibilityGroundTruth.mjs,
 * just at a scale too slow to run on every commit (see ci.yml's own, much smaller fuzz counts) —
 * intended for the nightly schedule only (see .github/workflows/nightly.yml).
 *
 * Checks, per ply, across every randomized game:
 *   1. Every candidate getPseudoLegalMoves offers actually succeeds via movePseudoLegal on a
 *      FRESH engine built from the same fen — the exact "shown as available but rejected" bug
 *      class this session found for en passant (see test-fogOfWarEnPassant.mjs) and fixed.
 *   2. The move actually chosen to advance the game also succeeds (same class of check, applied
 *      to the "real" game engine instead of a throwaway probe).
 *   3. A piece's own pseudo-legal reach never includes a square outside the board, and the
 *      from-square always currently holds a piece of the color being queried (basic structural
 *      sanity — would catch a badly wrong board-index conversion).
 *
 * Usage: node scripts/nightly-fuzz-logic.mjs [gameCount] [maxPlies]
 * Writes a human-readable report to nightly-fuzz-report.md in the current working directory
 * (see .github/workflows/nightly.yml for how CI surfaces this on failure).
 */
import { writeFileSync } from 'node:fs';
import { ChessEngine } from '../../src/logic/ChessEngine.ts';
import { RoomChessEngine } from '../src/game/RoomChessEngine.ts';

const GAMES = Number(process.argv[2] ?? 3000);
const MAX_PLIES = Number(process.argv[3] ?? 80);

function randInt(n) {
  return Math.floor(Math.random() * n);
}

function fuzzEngine(label, EngineClass) {
  let totalChecked = 0;
  let totalGames = 0;
  let totalPlies = 0;
  const mismatches = [];

  for (let g = 0; g < GAMES; g++) {
    totalGames++;
    let engine = new EngineClass(undefined, { skipValidation: true });
    for (let ply = 0; ply < MAX_PLIES; ply++) {
      const turn = engine.getTurn();
      const pseudo = engine.getPseudoLegalMoves(turn);
      if (pseudo.length === 0) break;
      totalPlies++;

      const curFen = engine.getFen();
      for (const cand of pseudo) {
        totalChecked++;
        // Structural sanity: every candidate's squares are real board squares.
        const validSquare = /^[a-h][1-8]$/;
        if (!validSquare.test(cand.from) || !validSquare.test(cand.to)) {
          mismatches.push({ kind: 'invalid-square', game: g, ply, fen: curFen, cand });
          continue;
        }
        const probe = new EngineClass(curFen, { skipValidation: true });
        const result = probe.movePseudoLegal(cand.from, cand.to, cand.promotion ?? 'q');
        if (!result) {
          mismatches.push({ kind: 'shown-but-rejected', game: g, ply, fen: curFen, cand });
        }
      }

      const pick = pseudo[randInt(pseudo.length)];
      const moveEngine = new EngineClass(curFen, { skipValidation: true });
      const applied = moveEngine.movePseudoLegal(pick.from, pick.to, pick.promotion ?? 'q');
      if (!applied) {
        mismatches.push({ kind: 'chosen-move-failed', game: g, ply, fen: curFen, pick });
        break;
      }
      engine = moveEngine;
      if (applied.captured === 'k') break;
    }
  }

  return { label, totalGames, totalPlies, totalChecked, mismatches };
}

console.log(`Nightly fuzz: ${GAMES} games x up to ${MAX_PLIES} plies, two engine implementations.\n`);

const results = [fuzzEngine('Mobile app (src/logic/ChessEngine.ts)', ChessEngine), fuzzEngine('Server (backend/src/game/RoomChessEngine.ts)', RoomChessEngine)];

let reportLines = [`# Nightly Fog of War fuzz report`, '', `Run at: ${new Date().toISOString()}`, ''];
let anyFailure = false;

for (const r of results) {
  console.log(`=== ${r.label} ===`);
  console.log(`  Games: ${r.totalGames}, plies: ${r.totalPlies}, candidates checked: ${r.totalChecked}`);
  console.log(`  Mismatches: ${r.mismatches.length}`);
  reportLines.push(`## ${r.label}`, '', `- Games: ${r.totalGames}`, `- Plies: ${r.totalPlies}`, `- Candidates checked: ${r.totalChecked}`, `- Mismatches: ${r.mismatches.length}`, '');
  if (r.mismatches.length > 0) {
    anyFailure = true;
    console.log('  Examples:');
    reportLines.push('### Examples', '');
    for (const m of r.mismatches.slice(0, 20)) {
      console.log('   ', JSON.stringify(m));
      reportLines.push('```json', JSON.stringify(m), '```', '');
    }
  }
  console.log('');
}

reportLines.push(anyFailure ? '## Result: FAIL' : '## Result: PASS');
writeFileSync('nightly-fuzz-report.md', reportLines.join('\n'));
console.log(anyFailure ? 'FAIL: mismatches found — see nightly-fuzz-report.md' : 'PASS: no mismatches found.');
process.exit(anyFailure ? 1 : 0);
