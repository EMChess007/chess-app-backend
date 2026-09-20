// Ported from the mobile app's src/logic/chess960.ts — the two projects are separate npm
// packages (no shared module boundary between them), so this is a deliberate, faithful copy
// rather than an import. Keep in sync by hand if the generation algorithm ever changes.

export const CHESS960_PAWN_RANK_WHITE = 'PPPPPPPP';
export const CHESS960_PAWN_RANK_BLACK = 'pppppppp';

function randomInt(max: number, rng: () => number): number {
  return Math.floor(rng() * max);
}

function emptyFiles(backRank: (string | null)[]): number[] {
  const files: number[] = [];
  for (let i = 0; i < 8; i++) {
    if (backRank[i] === null) files.push(i);
  }
  return files;
}

/**
 * Generates one of the 960 valid Chess960 (Fischer Random) starting positions and returns it
 * as a full FEN string, ready to load into chess.js.
 *
 * Rules enforced:
 * - Bishops on opposite-colored squares
 * - King between the two rooks
 * - Setup is mirrored for both colors
 */
export function generateChess960Position(rng: () => number = Math.random): string {
  const backRank: (string | null)[] = new Array(8).fill(null);

  const evenFiles = [0, 2, 4, 6];
  const oddFiles = [1, 3, 5, 7];
  const bishop1 = evenFiles[randomInt(evenFiles.length, rng)];
  const bishop2 = oddFiles[randomInt(oddFiles.length, rng)];
  backRank[bishop1] = 'B';
  backRank[bishop2] = 'B';

  let empty = emptyFiles(backRank);
  const queenFile = empty[randomInt(empty.length, rng)];
  backRank[queenFile] = 'Q';

  empty = emptyFiles(backRank);
  const knight1Pos = randomInt(empty.length, rng);
  const knight1File = empty[knight1Pos];
  empty.splice(knight1Pos, 1);
  const knight2File = empty[randomInt(empty.length, rng)];
  backRank[knight1File] = 'N';
  backRank[knight2File] = 'N';

  empty = emptyFiles(backRank).sort((a, b) => a - b);
  const [rookQueensideFile, kingFile, rookKingsideFile] = empty;
  backRank[rookQueensideFile] = 'R';
  backRank[kingFile] = 'K';
  backRank[rookKingsideFile] = 'R';

  const whiteBackRank = backRank.join('');
  const blackBackRank = whiteBackRank.toLowerCase();

  return `${blackBackRank}/${CHESS960_PAWN_RANK_BLACK}/8/8/8/8/${CHESS960_PAWN_RANK_WHITE}/${whiteBackRank} w KQkq - 0 1`;
}

/** Expands a single FEN rank (e.g. "b2Q1RKR") into an 8-character array, '.' for empty squares. */
export function expandFenRank(rank: string): string[] {
  const out: string[] = [];
  for (const ch of rank) {
    if (/[1-8]/.test(ch)) {
      for (let i = 0; i < Number(ch); i++) out.push('.');
    } else {
      out.push(ch);
    }
  }
  return out;
}

/** Collapses an 8-character rank array (as produced by expandFenRank) back into FEN rank notation. */
export function collapseFenRank(squares: string[]): string {
  let result = '';
  let emptyCount = 0;
  for (const sq of squares) {
    if (sq === '.') {
      emptyCount++;
    } else {
      if (emptyCount > 0) {
        result += emptyCount;
        emptyCount = 0;
      }
      result += sq;
    }
  }
  if (emptyCount > 0) result += emptyCount;
  return result;
}

export interface Chess960BackRankFiles {
  kingFile: number;
  queenRookFile: number;
  kingRookFile: number;
}

/**
 * Derives the original king/rook files from a Chess960 starting FEN's white back rank
 * (the setup is mirrored, so the same files apply to black). Falls back to the classical
 * e/a/h files if the back rank doesn't look like a valid Chess960 setup.
 */
export function getChess960BackRankFiles(startFen: string): Chess960BackRankFiles {
  const placement = startFen.split(' ')[0];
  const ranks = placement.split('/');
  const whiteBackRank = expandFenRank(ranks[7] ?? '');

  const kingFile = whiteBackRank.indexOf('K');
  const rookFiles: number[] = [];
  whiteBackRank.forEach((piece, file) => {
    if (piece === 'R') rookFiles.push(file);
  });

  if (kingFile === -1 || rookFiles.length !== 2) {
    return { kingFile: 4, queenRookFile: 0, kingRookFile: 7 };
  }

  rookFiles.sort((a, b) => a - b);
  const [queenRookFile, kingRookFile] = rookFiles;
  return { kingFile, queenRookFile, kingRookFile };
}
