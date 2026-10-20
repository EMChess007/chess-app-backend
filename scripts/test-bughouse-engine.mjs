/**
 * The generated SERVER copy of the Bughouse engine (src/game/bughouse, from the app's src/logic/bughouse by `npm run sync:bughouse`) against the app's own, in lockstep (BUGHOUSE_SPEC.md
 * W1): seeded random matches are fed, input by input, to BOTH; after every input the outcome (applied / flag / idle / rejected and why), the events and the complete match text must be
 * byte-identical. The mirror check proves the FILES are the same; this proves the COPY, running here on the backend's own dependencies (chess.js resolved from this repo), behaves the same.
 *
 *   npm run test:bughouse        (plain tsx, no server, no database; needs the app checked out at ../)
 *
 * The inputs come from chess.js itself (a few random own pieces, their legal moves) and from the pockets, plus hostile requests and time steps that now and then let a flag fall; the
 * engine's own legality is what is being compared, so nothing here depends on either copy's lists.
 */
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import * as appNamespace from '../../src/logic/bughouse/index.ts';
import * as server from '../src/game/bughouse/index.js';

// the app's files are CommonJS (the app has no "type": "module"), and a barrel of `export *` reaches an ES importer through `default`
const app = appNamespace.default ?? appNamespace;

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ✓ ${message}`);
}

function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const describeOutcome = (o) => JSON.stringify({ kind: o.kind, reason: o.reason, events: o.events, discarded: o.discarded });
const SEATS = [0, 1, 2, 3];
const place = (seat) => ({ board: seat < 2 ? 'A' : 'B', color: seat % 2 === 0 ? 'w' : 'b' });

function nextInput(rng, match) {
  const toMove = SEATS.filter((s) => match.verdicts[place(s).board].turn === place(s).color);
  const roll = rng();
  if (roll < 0.015) return null;
  const seat = roll < 0.9 && toMove.length > 0 ? toMove[Math.floor(rng() * toMove.length)] : Math.floor(rng() * 4);
  const p = place(seat);
  if (roll > 0.998) return { seat, action: { kind: 'resign' } };
  if (roll > 0.9) {
    const hostile = [
      { kind: 'move', board: p.board === 'A' ? 'B' : 'A', from: 'e2', to: 'e4' },
      { kind: 'drop', board: p.board, piece: 'q', square: 'e1' },
      { kind: 'move', board: p.board, from: 'a1', to: 'h8' },
      { kind: 'castle' },
    ];
    return { seat, action: hostile[Math.floor(rng() * hostile.length)] };
  }
  const pocket = match.pockets[seat];
  const held = ['p', 'n', 'b', 'r', 'q'].filter((t) => pocket[t] > 0);
  if (held.length > 0 && rng() < 0.45) {
    const piece = held[Math.floor(rng() * held.length)];
    const files = 'abcdefgh';
    return { seat, action: { kind: 'drop', board: p.board, piece, square: `${files[Math.floor(rng() * 8)]}${1 + Math.floor(rng() * 8)}` } };
  }
  const chess = new Chess(match.boards[p.board].fen);
  const own = [];
  for (const row of chess.board()) for (const cell of row) if (cell && cell.color === p.color) own.push(cell.square);
  for (let attempt = 0; attempt < 8; attempt++) {
    const moves = chess.moves({ square: own[Math.floor(rng() * own.length)], verbose: true });
    if (moves.length === 0) continue;
    const captures = moves.filter((mv) => mv.captured !== undefined);
    const pool = captures.length > 0 && rng() < 0.6 ? captures : moves;
    const mv = pool[Math.floor(rng() * pool.length)];
    return { seat, action: { kind: 'move', board: p.board, from: mv.from, to: mv.to, ...(mv.promotion ? { promotion: mv.promotion } : {}) } };
  }
  return null;
}

console.log('\n=== 1. The generated server copy and the app\'s engine run in lockstep ===');
{
  const MATCHES = 300;
  let steps = 0;
  let commits = 0;
  let captures = 0;
  let drops = 0;
  let flags = 0;
  let mates = 0;
  let stuck = 0;
  const differences = [];
  for (let i = 0; i < MATCHES && differences.length === 0; i++) {
    const rng = seeded(880000 + i * 31);
    const tc = app.BUGHOUSE_TIME_CONTROLS[Math.floor(rng() * app.BUGHOUSE_TIME_CONTROLS.length)];
    const room = Math.floor(rng() * 100);
    let a = app.createMatch({ timeControl: tc, roomNumber: room, startMs: 1000 });
    let b = server.createMatch({ timeControl: tc, roomNumber: room, startMs: 1000 });
    if (app.serializeMatch(a) !== server.serializeMatch(b)) differences.push(`match ${i}: the starts differ`);
    let now = 1000;
    for (let step = 0; step < 80 && a.result === null && differences.length === 0; step++) {
      now += rng() < 0.02 ? Math.floor(rng() * (tc.initialMs / 3)) : Math.floor(rng() * 900);
      const input = nextInput(rng, a);
      const oa = app.settle(a, input, now);
      const ob = server.settle(b, input, now);
      steps++;
      if (describeOutcome(oa) !== describeOutcome(ob)) differences.push(`match ${i} step ${step}: ${describeOutcome(oa)} vs ${describeOutcome(ob)}`);
      if (oa.kind === 'applied' || oa.kind === 'flag') {
        a = oa.match;
        b = ob.match;
        commits++;
        const first = oa.events[0];
        if (first.kind === 'drop') drops++;
        if (first.kind === 'move' && first.san.includes('x')) captures++;
        if (oa.kind === 'flag') flags++;
      }
      if (app.serializeMatch(a) !== server.serializeMatch(b)) differences.push(`match ${i} step ${step}: the match texts differ`);
      if (a.verdicts.A.status === 'stuck' || a.verdicts.B.status === 'stuck') stuck++;
      // the server copy reads the app's text back and the app reads the server's
      if (step % 10 === 0) {
        const text = app.serializeMatch(a);
        const backB = server.deserializeMatch(text);
        const backA = app.deserializeMatch(server.serializeMatch(b));
        if (!backB.ok || server.serializeMatch(backB.match) !== text || !backA.ok || app.serializeMatch(backA.match) !== text) differences.push(`match ${i} step ${step}: a snapshot does not cross over`);
        if (server.conservationProblems(b).length > 0) differences.push(`match ${i} step ${step}: ${server.conservationProblems(b)[0]}`);
      }
    }
    if (a.result !== null && 'winnerTeam' in a.result && a.result.reason === 'checkmate') mates++;
  }
  check(differences.length === 0, `the two copies agree on every input of ${MATCHES} seeded matches (${steps} inputs, ${commits} commits)${differences.length ? ` - ${differences[0]}` : ''}`);
  check(captures > 500 && drops > 300, `...and the sample really exercised captures (${captures}) and drops (${drops}); flags ${flags}, mates ${mates}, stuck positions ${stuck}`);
}

console.log('\n=== 2. The server copy on its own: the rules that matter most ===');
{
  const START = server.BOARD_START_FEN;
  const m0 = server.createMatch({ timeControl: { initialMs: 60000, incrementMs: 0 }, roomNumber: 0, startMs: 0 });
  check(server.serializeMatch(m0).includes(`"fen":"${START}"`) && m0.verdicts.A.status === 'playing', 'a new match starts from the standard position, White to move on both boards');
  const flagged = server.settle(m0, null, 60000);
  check(flagged.kind === 'flag' && flagged.match.result.reason === 'flag' && flagged.match.result.loserSeat === 0 && flagged.match.result.board === 'A', 'both White clocks fall at 60,000 ms: an even room number makes board A lose (the tie-break)');
  const odd = server.settle(server.createMatch({ timeControl: { initialMs: 60000, incrementMs: 0 }, roomNumber: 7, startMs: 0 }), null, 60000);
  check(odd.kind === 'flag' && odd.match.result.loserSeat === 2 && odd.match.result.board === 'B', '...and an odd one makes board B lose');
  const e4 = server.settle(m0, { seat: 0, action: { kind: 'move', board: 'A', from: 'e2', to: 'e4' } }, 1000);
  check(e4.kind === 'applied' && e4.match.seq === 1 && e4.match.clocks[1].runningSince === 1000 && e4.match.clocks[0].remainingMs === 59000, 'a move is committed: seq 1, the mover charged, the opponent\'s clock started');
  const wrong = server.settle(m0, { seat: 0, action: { kind: 'move', board: 'B', from: 'e2', to: 'e4' } }, 1000);
  check(wrong.kind === 'rejected' && wrong.reason === 'wrongBoard' && wrong.match === m0, 'a move naming the other board is refused and changes nothing');
  check(server.BUGHOUSE_TIME_CONTROLS.length === 6 && server.seatAt('B', 'b') === 3 && server.partnerOf(0) === 3 && server.partnerOf(1) === 2, 'the six time controls and the fixed seat map');
  check(!/draw/i.test(JSON.stringify(Object.keys(server))), 'no export of the server copy mentions a draw');
}

console.log(`\nAll good — ${passed} checks passed.`);
process.exit(0);
