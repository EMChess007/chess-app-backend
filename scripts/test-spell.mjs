#!/usr/bin/env node
/**
 * Spell Chess server-side regression suite — no running server needed. Run with tsx:
 *   npx tsx scripts/test-spell.mjs      (or: npm run test:spell)
 *
 *  1. NO DRIFT: the shared rules block of backend/src/game/spellChess.ts must be byte-identical to the mobile app's
 *     src/logic/spellChess.ts (hand-mirrored — there is no shared module).
 *  2. THE AUTHORITY: RoomManager.applyMove (driven with a stub socket server, no network) validates a spell turn as ONE
 *     unit — the cast, then the move. The Freeze rules regressions live here:
 *       - a Freeze lasts for the victim's very next move and not one ply less or more;
 *       - a FROZEN player who casts their own Freeze is still frozen that turn (the server used to read the frozen
 *         squares after the cast, which had just overwritten them, and let the frozen piece move);
 *       - freezing every piece that gives check lets the mover escape check with any move (the server used to pass the
 *         wrong zone to the waiver and refuse it);
 *       - castling is refused when the rook it would move is frozen.
 *  3. PARITY with the mobile app: random Spell Chess games are replayed through BOTH engines, each driven by its own
 *     spellTurnContext; every candidate the mobile engine offers must be accepted by the server engine, and every
 *     frozen-origin or frozen-rook castle must be refused by both.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ChessEngine as ClientEngine } from '../../src/logic/ChessEngine.ts';
import { afterSpellChessMove as clientAfter, canCastFreeze as clientCanFreeze, canCastJump as clientCanJump, checkIsWaivedByFreeze as clientWaiver, initialSpellChessState as clientInitial, spellTurnContext as clientContext } from '../../src/logic/spellChess.ts';
import { RoomChessEngine, START_FEN } from '../src/game/RoomChessEngine.ts';
import { RoomManager } from '../src/game/rooms.ts';
import { afterSpellChessMove, canCastFreeze, canCastJump, castlingRookOrigin, checkIsWaivedByFreeze, frozenSquaresFor, getFreezeZoneSquares, initialSpellChessState, spellTurnContext } from '../src/game/spellChess.ts';

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ✓ ${message}`);
}
const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);
const sorted = (xs) => [...xs].sort().join();

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
  const mobile = block(new URL('../../src/logic/spellChess.ts', import.meta.url));
  const server = block(new URL('../src/game/spellChess.ts', import.meta.url));
  check(mobile.length > 3000, 'the shared rules block was found in both files');
  check(mobile.includes('export function spellTurnContext') && mobile.includes('export function castlingRookOrigin'), '...and it contains spellTurnContext and castlingRookOrigin');
  check(mobile === server, 'backend/src/game/spellChess.ts and src/logic/spellChess.ts have identical rules (edit BOTH together)');
}

// --- 2. The authority: RoomManager.applyMove ---------------------------------------------------------
console.log('\n=== 2. RoomManager validates Spell Chess turns ===');
function stubIo() {
  const events = [];
  return { events, to: (id) => ({ emit: (event, payload) => events.push({ id, event, payload }) }) };
}
function spellRoom(initialFen) {
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
    spellChess: true,
    initialFen,
  });
  const turn = (who, from, to, spell) => manager.applyMove(who, { roomId: created.roomId, from, to, ...(spell ? { spell } : {}) });
  const state = () => manager.rooms.get(created.roomId).spellState;
  return { io, manager, roomId: created.roomId, turn, state };
}
{
  // A Freeze lasts for the victim's very next move — not one ply less, not one more.
  const { turn, state } = spellRoom();
  check(turn('W', 'e2', 'e4', { type: 'freeze', center: 'e7' }).ok === true, 'White casts Freeze on the zone around e7 and plays e4');
  check(sorted(frozenSquaresFor(state(), 'b')) === sorted(getFreezeZoneSquares('e7')), "the freeze is on the room's state for Black's very next turn (it survived White's own move)");
  check(turn('B', 'e7', 'e5').ok === false, 'Black cannot move the frozen pawn e7-e5');
  check(turn('B', 'd8', 'f6').ok === false && turn('B', 'f8', 'e7').ok === false, '...nor the frozen queen or bishop');
  check(turn('B', 'g8', 'f6').ok === true, 'a piece outside the zone (Ng8-f6) moves fine');
  check(state().pendingFreeze === null, "the freeze is spent the moment Black has moved — it does not linger");
  check(turn('W', 'g1', 'f3').ok === true && turn('B', 'e7', 'e5').ok === true, 'a turn later the same pawn moves freely (e7-e5)');
}
{
  // THE bug: a frozen mover who casts their own Freeze stays frozen.
  const { turn, state } = spellRoom();
  turn('W', 'e2', 'e4', { type: 'freeze', center: 'e7' });
  const refused = turn('B', 'e7', 'e5', { type: 'freeze', center: 'a4' });
  check(refused.ok === false, 'Black is frozen AND casts Freeze of their own — the frozen pawn e7-e5 is still refused');
  check(state().b.charges.freeze === 5, '...and the refused turn left the room untouched (no charge spent, nothing recorded)');
  const ok = turn('B', 'g8', 'f6', { type: 'freeze', center: 'a4' });
  check(ok.ok === true, 'the same cast with a legal move (Ng8-f6) is accepted');
  check(sorted(frozenSquaresFor(state(), 'w')) === sorted(getFreezeZoneSquares('a4')), "Black's own freeze now restricts White's next turn");
  check(frozenSquaresFor(state(), 'b').length === 0, "...and the freeze that restricted Black is spent");
}
{
  // The defensive Freeze: every checking piece inside the zone cast THIS turn waives the "must resolve check" rule.
  const fen = '4r1k1/8/8/8/8/8/P7/4K3 w - - 0 1';
  const plain = spellRoom(fen);
  check(plain.turn('W', 'a2', 'a3').ok === false, 'in check from Re8, a move that ignores the check is refused');
  const freeze = spellRoom(fen);
  check(freeze.turn('W', 'a2', 'a3', { type: 'freeze', center: 'e8' }).ok === true, '...but freezing the only checking piece lets White play ANY move that turn (it used to be refused)');
  check(frozenSquaresFor(freeze.state(), 'b').includes('e8'), "the checking rook stays frozen for Black's reply");
  const partial = spellRoom('3rr1k1/8/8/8/8/8/P7/4K3 w - - 0 1'); // two attackers? only e8 checks; d8 does not
  check(partial.turn('W', 'a2', 'a3', { type: 'freeze', center: 'a8' }).ok === false, 'a Freeze that does NOT cover the checking piece waives nothing');
}
{
  // Castling moves the rook, so a frozen rook forbids it.
  const fen = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1';
  const a = spellRoom(fen);
  a.turn('W', 'a2', 'a3', { type: 'freeze', center: 'h8' });
  check(a.turn('B', 'e8', 'g8').ok === false, 'with the h8 rook frozen, Black cannot castle king-side');
  check(a.turn('B', 'e8', 'c8').ok === true, '...but can still castle queen-side (that rook is free)');
  const b = spellRoom(fen);
  b.turn('W', 'a2', 'a3', { type: 'freeze', center: 'e8' });
  check(b.turn('B', 'e8', 'g8').ok === false && b.turn('B', 'e8', 'c8').ok === false, 'a frozen KING cannot castle either way');
  const c = spellRoom(fen);
  c.turn('W', 'a2', 'a3');
  check(c.turn('B', 'e8', 'g8').ok === true, 'with nothing frozen, castling is untouched');
}
check(castlingRookOrigin('e1', 'g1', 'k') === 'h1' && castlingRookOrigin('e8', 'c8', 'k') === 'a8' && castlingRookOrigin('e1', 'f1', 'k') === null, 'castlingRookOrigin names the right rook and ignores ordinary king steps');

// --- 3. Parity with the mobile app --------------------------------------------------------------------
console.log('\n=== 3. The server and mobile engines agree ===');
{
  const random = seeded(31337);
  const problems = [];
  const seen = { plies: 0, restricted: 0, castleRefusals: 0, frozenRefusals: 0 };
  for (let g = 0; g < 6; g++) {
    let fen = g % 2 === 0 ? START_FEN : 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1';
    let serverState = initialSpellChessState();
    let clientState = clientInitial();
    for (let ply = 0; ply < 40 && problems.length === 0; ply++) {
      const probe = new ClientEngine(fen, { skipValidation: true });
      const mover = probe.getTurn();
      let cast = null;
      if (random() < 0.55) {
        if (canCastFreeze(serverState, mover) && clientCanFreeze(clientState, mover) && (random() < 0.75 || !canCastJump(serverState, mover))) {
          cast = { type: 'freeze', center: 'abcdefgh'[Math.floor(random() * 8)] + (1 + Math.floor(random() * 8)) };
        } else if (canCastJump(serverState, mover) && clientCanJump(clientState, mover)) {
          const occupied = probe.getBoard().flat().filter((s) => s.piece);
          cast = { type: 'jump', square: occupied[Math.floor(random() * occupied.length)].square };
        }
      }
      const s = spellTurnContext(serverState, mover, cast);
      const c = clientContext(clientState, mover, cast);
      if (sorted(s.frozenSquares) !== sorted(c.frozenSquares) || s.jumpSquare !== c.jumpSquare || sorted(s.freezeZone ?? []) !== sorted(c.freezeZone ?? [])) {
        problems.push(`ply ${ply}: turn contexts differ (${sorted(s.frozenSquares)} vs ${sorted(c.frozenSquares)})`);
        break;
      }
      if (s.frozenSquares.length > 0) seen.restricted++;
      const sEscape = s.freezeZone ? checkIsWaivedByFreeze(new RoomChessEngine(fen, { spellChess: true }), mover, s.freezeZone) : false;
      const cEscape = c.freezeZone ? clientWaiver(probe, mover, c.freezeZone) : false;
      if (sEscape !== cEscape) {
        problems.push(`ply ${ply}: the check waiver differs (${sEscape} vs ${cEscape})`);
        break;
      }
      const mkServer = () => new RoomChessEngine(fen, { spellChess: true, frozenSquares: s.frozenSquares, jumpSquare: s.jumpSquare, freezeEscapeActive: sEscape });
      const client = new ClientEngine(fen, { skipValidation: true, spellChess: true, frozenSquares: c.frozenSquares, jumpSquare: c.jumpSquare, freezeEscapeActive: cEscape });

      const candidates = [];
      for (const sq of client.getBoard().flat()) {
        if (sq.piece?.color !== mover) continue;
        for (const to of client.getLegalMoves(sq.square)) candidates.push({ from: sq.square, to });
      }
      for (const m of candidates) {
        if (!mkServer().move(m.from, m.to, 'q')) {
          problems.push(`ply ${ply}: the mobile engine offers ${m.from}${m.to} but the server refuses it (${fen}, frozen ${s.frozenSquares})`);
          break;
        }
      }
      // Frozen origins and frozen-rook castles: refused by BOTH.
      const plain = new ClientEngine(fen, { skipValidation: true });
      for (const sq of plain.getBoard().flat()) {
        if (sq.piece?.color !== mover) continue;
        for (const to of plain.getLegalMoves(sq.square)) {
          const rook = sq.piece.type === 'k' ? castlingRookOrigin(sq.square, to, 'k') : null;
          const mustBeRefused = s.frozenSquares.includes(sq.square) || (rook !== null && s.frozenSquares.includes(rook));
          if (!mustBeRefused) continue;
          const serverMove = mkServer().move(sq.square, to, 'q');
          const clientMove = new ClientEngine(fen, { skipValidation: true, spellChess: true, frozenSquares: c.frozenSquares, jumpSquare: c.jumpSquare, freezeEscapeActive: cEscape }).move(sq.square, to, 'q');
          if (serverMove || clientMove) problems.push(`ply ${ply}: ${sq.square}${to} must be refused while frozen (server ${!!serverMove}, mobile ${!!clientMove})`);
          if (rook !== null && !s.frozenSquares.includes(sq.square)) seen.castleRefusals++;
          else seen.frozenRefusals++;
        }
      }
      if (problems.length > 0 || candidates.length === 0) break;
      const pick = candidates[Math.floor(random() * candidates.length)];
      const applied = mkServer().move(pick.from, pick.to, 'q');
      const afterEngine = mkServer();
      afterEngine.move(pick.from, pick.to, 'q');
      const clientAfterEngine = new ClientEngine(fen, { skipValidation: true, spellChess: true, frozenSquares: c.frozenSquares, jumpSquare: c.jumpSquare, freezeEscapeActive: cEscape });
      clientAfterEngine.move(pick.from, pick.to, 'q');
      if (afterEngine.getFen() !== clientAfterEngine.getFen()) {
        problems.push(`ply ${ply}: ${pick.from}${pick.to} gives different positions (${afterEngine.getFen()} vs ${clientAfterEngine.getFen()})`);
        break;
      }
      serverState = afterSpellChessMove(s.stateAfterCast, mover);
      clientState = clientAfter(c.stateAfterCast, mover);
      fen = afterEngine.getFen();
      seen.plies++;
      if (applied?.captured === 'k') break;
    }
  }
  check(problems.length === 0, `server and mobile agree on ${seen.plies} plies${problems.length ? ` — ${problems.slice(0, 3).join(' | ')}` : ''}`);
  check(seen.restricted > 10, `the random games really had restricted turns (${seen.restricted})`);
  check(seen.frozenRefusals > 10, `...and frozen-origin moves that both engines refused (${seen.frozenRefusals})`);
}

console.log(`\nAll good — ${passed} checks passed.`);
process.exit(0);
