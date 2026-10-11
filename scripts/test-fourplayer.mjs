/**
 * Behavioural parity: the app's 4 Player engine (the source of truth) and the backend's generated copy must behave IDENTICALLY.
 *
 *   npm run test:fourplayer        (tsx; no server, no database; needs the app checked out at ../)
 *
 * `sync-fourplayer.mjs --check` proves the two files are textually the same up to ".js"; this is the net behind it. It would still
 * catch a copy that is textually right but behaves differently (a generator bug, a runtime difference, someone editing the wrong
 * side of a half-applied change), and it proves the property the online mode actually relies on: the server and a client that feed
 * the SAME sequence of actions to their own engine end in the SAME position, clocks and events.
 *
 * HOW: seeded random full games are played through BOTH engines in lockstep. At every ply the two must agree on the serialized
 * position, the legal-move list, the events (as JSON), the clocks, and on what the bots would play (same seed per call). Actions
 * mimic the server's commit(): charge elapsed time (clockTick), then apply a human-style move (findLegalMove with a random promotion
 * piece), a bot move, a resignation or a flag fall, then add the increment. A coverage meter makes the suite say what it did NOT
 * exercise, and the rare rules are asserted to have been reached (see section 5) - "identical on random games" must never silently
 * mean "never got to castling".
 */
import assert from 'node:assert/strict';
import * as feBarrel from '../../src/logic/fourPlayer/index.ts';
import * as feSetup from '../../src/logic/fourPlayer/setup.ts';
import * as fePresentation from '../../src/logic/fourPlayer/presentation.ts';
import * as fePremove from '../../src/logic/fourPlayer/premove.ts';
import * as feAnnotations from '../../src/logic/fourPlayer/annotations.ts';
import * as BE from '../src/game/fourPlayer/index.ts';

// The app's package is not "type": "module", so tsx loads its files as CommonJS: a namespace import of its `export *` barrel exposes
// the real exports only under `.default` (the backend's own files are genuine ES modules and need no unwrapping).
const unwrap = (ns) => {
  const out = { ...(ns.default && typeof ns.default === 'object' ? ns.default : {}), ...ns };
  delete out.default;
  delete out['module.exports'];
  return out;
};
const FE = unwrap(feBarrel);
const FESetup = unwrap(feSetup);
const FEPresentation = unwrap(fePresentation);
const FEPremove = unwrap(fePremove);
const FEAnnotations = unwrap(feAnnotations);

let passed = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ok  ${message}`);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Everything observable about a state, as one comparable string. */
const fingerprint = (E, state) =>
  [E.serialize(state), Array.from(state.cells).join(','), state.kings.join(','), state.status.join(','), state.score.join(','), state.castling, JSON.stringify(state.ep), state.ply, JSON.stringify(state.result), JSON.stringify(state.rules)].join('|');

const coverage = {
  plies: 0,
  games: 0,
  moves: 0,
  captures: 0,
  doubleSteps: 0,
  castles: 0,
  enPassant: 0,
  promotions: { q: 0, r: 0, b: 0, n: 0 },
  deadKingMoves: 0,
  frozen: 0,
  checkmates: 0,
  stalemates: 0,
  resigns: 0,
  timeouts: 0,
  endings: { elimination: 0, cap: 0, deadPosition: 0 },
  botComparisons: 0,
  deepBotComparisons: 0,
};

function countEvents(events) {
  for (const e of events) {
    if (e.kind === 'move') {
      coverage.moves++;
      if (e.move.captured) coverage.captures++;
      const f = e.move.flags;
      if (f & FE.FLAG_DOUBLE_STEP) coverage.doubleSteps++;
      if (f & FE.FLAG_CASTLE) coverage.castles++;
      if (f & FE.FLAG_EN_PASSANT) coverage.enPassant++;
      if (f & FE.FLAG_PROMOTION) coverage.promotions['qrbn'[FE.PROMOTABLE_TYPES.indexOf(FE.promotionOf(e.move))]]++;
    } else if (e.kind === 'deadKingMove') coverage.deadKingMoves++;
    else if (e.kind === 'frozen') coverage.frozen++;
    else if (e.kind === 'eliminated') {
      if (e.reason === 'checkmate') coverage.checkmates++;
      else if (e.reason === 'stalemate') coverage.stalemates++;
      else if (e.reason === 'resign') coverage.resigns++;
      else if (e.reason === 'timeout') coverage.timeouts++;
    } else if (e.kind === 'gameOver') coverage.endings[e.result.reason]++;
  }
}

/** Two engines, one position each, plus an optional pair of clocks - compared after every step. */
class Lockstep {
  constructor(label, fe, be, clock = null) {
    this.label = label;
    this.fe = fe;
    this.be = be;
    this.clock = clock;
  }
  same(what, a, b) {
    const sa = typeof a === 'string' ? a : JSON.stringify(a);
    const sb = typeof b === 'string' ? b : JSON.stringify(b);
    if (sa !== sb) assert.fail(`[${this.label}, ply ${this.fe.ply}] ${what} differ between the app engine and the backend mirror\n  app:     ${sa}\n  backend: ${sb}`);
  }
  states() {
    this.same('position', fingerprint(FE, this.fe), fingerprint(BE, this.be));
    if (this.clock) this.same('clocks', this.clock.fe, this.clock.be);
  }
}

const ELOS_EVERY_PLY = [1200, 1700];
const ELOS_DEEP = [1800, 3000];

/** The bots, given identically seeded RNGs, must pick the same move (and the evaluator must score identically). */
function compareBots(ls, seedBase, elos, deep = false) {
  for (const elo of elos) {
    const seed = (seedBase * 7919 + elo) >>> 0;
    ls.same(`bot move at ELO ${elo}`, FE.chooseBotMove(ls.fe, elo, mulberry32(seed)), BE.chooseBotMove(ls.be, elo, mulberry32(seed)));
    coverage.botComparisons++;
    if (deep) coverage.deepBotComparisons++;
  }
  for (const seat of FE.SEATS) ls.same(`evaluate(seat ${seat})`, String(FE.evaluate(ls.fe, seat)), String(BE.evaluate(ls.be, seat)));
}

/** Compares everything a position exposes that is not a plain field. */
function compareQueries(ls, seat) {
  ls.same('legal moves', FE.legalMoves(ls.fe, seat), BE.legalMoves(ls.be, seat));
  ls.same('isInCheck', FE.isInCheck(ls.fe, seat), BE.isInCheck(ls.be, seat));
  ls.same('isDeadPosition', FE.isDeadPosition(ls.fe), BE.isDeadPosition(ls.be));
  ls.same('currentMoves', FE.currentMoves(ls.fe), BE.currentMoves(ls.be));
  ls.same('activeSeats', FE.activeSeats(ls.fe), BE.activeSeats(ls.be));
}

/** `chaos` = per-turn probability of an interruption (40% of them a resignation, the rest a flag fall); 0 plays the game to its natural end. */
function playGame(seed, { style, maxPlies, initialSeconds = 120, incrementSeconds = 2, botEvery = 1, deepEvery = 0, chaos = 0.03, label = '', build = (E) => E.initialState(), prelude = null }) {
  const script = mulberry32(seed);
  const ls = new Lockstep(`${label ? `${label}, ` : ''}seed ${seed}/${style}`, build(FE), build(BE), {
    fe: FE.createClock(initialSeconds, incrementSeconds, true),
    be: BE.createClock(initialSeconds, incrementSeconds, true),
  });
  ls.states();
  if (prelude) prelude(ls); // scripted opening moves (a castle, a double step...) before the random continuation takes over
  let step = 0;
  while (!ls.fe.result && ls.fe.ply < maxPlies) {
    step++;
    const seat = ls.fe.turn;
    const feMoves = FE.legalMoves(ls.fe, seat);
    compareQueries(ls, seat);
    if (step % botEvery === 0) compareBots(ls, seed * 1000 + step, ELOS_EVERY_PLY);
    if (deepEvery && step % deepEvery === 0) compareBots(ls, seed * 1000 + step, ELOS_DEEP, true);

    const r = script();
    const rngSeed = (seed * 31 + step) >>> 0;
    let a;
    let b;
    let aClock = ls.clock.fe;
    let bClock = ls.clock.be;
    if (r < chaos * 0.4) {
      // a resignation: the seat to move, or any other active seat
      const active = FE.activeSeats(ls.fe);
      const who = script() < 0.5 ? seat : active[Math.floor(script() * active.length)];
      a = FE.resign(ls.fe, who, mulberry32(rngSeed), 'resign');
      b = BE.resign(ls.be, who, mulberry32(rngSeed), 'resign');
    } else if (r < chaos) {
      // a flag fall: the seat to move is charged more than it has left
      const elapsed = ls.clock.fe.seconds[seat] + 0.25;
      a = FE.clockTick(ls.fe, ls.clock.fe, elapsed, mulberry32(rngSeed));
      b = BE.clockTick(ls.be, ls.clock.be, elapsed, mulberry32(rngSeed));
      aClock = a.clock;
      bClock = b.clock;
    } else {
      // an ordinary turn, as commit() does it: charge elapsed, then (if the mover survived the clock) move, then add the increment
      const elapsed = Math.round(script() * 400) / 100;
      const ta = FE.clockTick(ls.fe, ls.clock.fe, elapsed, mulberry32(rngSeed));
      const tb = BE.clockTick(ls.be, ls.clock.be, elapsed, mulberry32(rngSeed));
      ls.same('clockTick events', ta.events, tb.events);
      ls.same('clockTick clock', ta.clock, tb.clock);
      if (ta.events.length > 0) {
        a = ta;
        b = tb;
        aClock = ta.clock;
        bClock = tb.clock;
      } else {
        let feMove;
        let beMove;
        if (style === 'bot') {
          feMove = FE.chooseBotMove(ta.state, 1200, mulberry32(rngSeed));
          beMove = BE.chooseBotMove(tb.state, 1200, mulberry32(rngSeed));
        } else {
          const pick = feMoves[Math.floor(script() * feMoves.length)];
          const promotionType = FE.PROMOTABLE_TYPES[Math.floor(script() * 4)];
          feMove = FE.findLegalMove(ta.state, seat, pick.from, pick.to, promotionType);
          beMove = BE.findLegalMove(tb.state, seat, pick.from, pick.to, promotionType);
        }
        ls.same('chosen move', feMove, beMove);
        assert.ok(feMove, `[${ls.label}] a seat on move has a move (it has ${feMoves.length} legal moves)`);
        a = FE.playMove(ta.state, feMove, mulberry32(rngSeed));
        b = BE.playMove(tb.state, beMove, mulberry32(rngSeed));
        aClock = FE.addIncrement(ta.clock, seat, a.state);
        bClock = BE.addIncrement(tb.clock, seat, b.state);
      }
    }
    ls.same('events', a.events, b.events);
    countEvents(a.events);
    ls.fe = a.state;
    ls.be = b.state;
    ls.clock = { fe: aClock, be: bClock };
    ls.states();
    // the serialization round trip is the wire format: both engines must rebuild the very same position from it, from either side's text
    const text = FE.serialize(ls.fe);
    ls.same('serialize', text, BE.serialize(ls.be));
    ls.same('deserialize round trip', fingerprint(FE, FE.deserialize(text)), fingerprint(BE, BE.deserialize(text)));
    ls.same('cross-engine deserialize', fingerprint(FE, FE.deserialize(text)), fingerprint(FE, BE.deserialize(text)));
  }
  coverage.games++;
  coverage.plies += ls.fe.ply;
  return ls;
}

console.log('\n=== 1. The public surface is the same ===');
{
  const beKeys = Object.keys(BE);
  const missing = beKeys.filter((k) => !(k in FE));
  ok(missing.length === 0, `every export of the backend mirror exists in the app engine (${beKeys.length} exports; missing: ${missing.join(', ') || 'none'})`);
  // What the app has that the server does not must be EXACTLY the client-only modules' exports - derived, not guessed.
  const clientOnlyKeys = new Set();
  for (const mod of [FESetup, FEPresentation, FEPremove, FEAnnotations]) for (const k of Object.keys(mod)) clientOnlyKeys.add(k);
  const feOnly = Object.keys(FE).filter((k) => !beKeys.includes(k));
  ok(feOnly.length > 0 && feOnly.every((k) => clientOnlyKeys.has(k)), `the ${feOnly.length} app-only exports all come from the client-only modules (setup, presentation, premove, annotations)`);
  ok(feOnly.length === clientOnlyKeys.size, 'and every export of those client-only modules is absent from the server barrel (nothing client-only leaked)');
  let valuesChecked = 0;
  let functionsChecked = 0;
  for (const key of beKeys) {
    if (typeof BE[key] === 'function') {
      assert.equal(typeof FE[key], 'function', `${key} is a function on both sides`);
      functionsChecked++;
    } else {
      assert.deepEqual(BE[key], FE[key], `constant/table ${key} differs`);
      valuesChecked++;
    }
  }
  ok(functionsChecked > 30 && valuesChecked > 30, `${functionsChecked} functions exist on both sides and ${valuesChecked} constants/tables (typed arrays, maps, rules) are deep-equal`);
}

console.log('\n=== 2. Random full games in lockstep (human-style moves with every promotion piece, resigns, flag falls) ===');
{
  const started = Date.now();
  for (let seed = 1; seed <= 14; seed++) playGame(seed, { style: 'human', maxPlies: 320, botEvery: 8 });
  ok(coverage.games === 14, `14 random-move games, ${coverage.plies} plies, identical at every ply (positions, legal moves, events, clocks, bots every 8th ply)`);
  console.log(`      (${Date.now() - started} ms)`);
}

console.log('\n=== 3. Bot-played full games, run to their natural end where possible ===');
{
  const started = Date.now();
  const before = coverage.plies;
  const endedBy = [];
  for (let seed = 101; seed <= 106; seed++) {
    // chaos 0 and a generous clock: nobody resigns or flags, so the game runs to the engine's own end (or the 1000-ply cap)
    const ls = playGame(seed, { style: 'bot', maxPlies: 1000, initialSeconds: 3600, incrementSeconds: 5, botEvery: 10, deepEvery: 60, chaos: 0 });
    assert.ok(ls.fe.result || ls.fe.ply >= 1000, 'a bot game ends or reaches the cap');
    endedBy.push(`${ls.fe.ply}${ls.fe.result ? `:${ls.fe.result.reason}` : ':unfinished'}`);
  }
  ok(coverage.plies - before > 1500, `6 undisturbed bot games (${coverage.plies - before} plies; ended ${endedBy.join(', ')}) identical at every ply`);
  ok(coverage.deepBotComparisons > 0, `the deep-tier bots (1800, 3000) were compared too (${coverage.deepBotComparisons} decisions) although the server never uses them`);
  console.log(`      (${Date.now() - started} ms)`);
}

console.log('\n=== 4. Rare rules, on hand-built positions: scripted moves, then a random continuation ===');
const sq = (name) => FE.parseSquare(name);
/** Plays one SCRIPTED move on both engines; returns the (frontend) move so the caller can assert what kind of move it was. */
function scripted(ls, seat, from, to, promotionType) {
  const fm = FE.findLegalMove(ls.fe, seat, sq(from), sq(to), promotionType);
  const bm = BE.findLegalMove(ls.be, seat, BE.parseSquare(from), BE.parseSquare(to), promotionType);
  ls.same(`legal move ${from}-${to}`, fm, bm);
  assert.ok(fm, `[${ls.label}] ${from}-${to} must be legal for seat ${seat} (it is not - the scenario's geometry is wrong)`);
  const a = FE.playMove(ls.fe, fm, mulberry32(7));
  const b = BE.playMove(ls.be, bm, mulberry32(7));
  ls.same('events', a.events, b.events);
  countEvents(a.events);
  ls.fe = a.state;
  ls.be = b.state;
  ls.states();
  return fm;
}
const KINGS = ['rK@h1', 'bK@a8', 'yK@g14', 'gK@n7'];
const ROOKS_AT_HOME = ['rR@d1', 'rR@k1', 'bR@a4', 'bR@a11', 'yR@d14', 'yR@k14', 'gR@n4', 'gR@n11'];
{
  let castles = 0;
  for (const seat of FE.SEATS) {
    for (const side of [0, 1]) {
      const geometry = FE.CASTLES[seat][side];
      const started = coverage.castles;
      playGame(500 + seat * 2 + side, {
        style: 'human', maxPlies: 40, chaos: 0, botEvery: 5, label: `castle seat ${seat} side ${side}`,
        build: (E) => E.stateFromPieces([...KINGS, ...ROOKS_AT_HOME], { turn: seat }),
        prelude: (ls) => {
          const move = scripted(ls, seat, FE.squareName(FE.KING_START_SQUARE[seat]), FE.squareName(geometry.kingTo));
          assert.ok(move.flags & FE.FLAG_CASTLE, 'the king move two squares towards the rook is a castle');
          assert.equal(ls.fe.cells[geometry.rookTo], FE.pieceCode(seat, FE.ROOK), 'the rook landed on the square the king crossed');
        },
      });
      assert.equal(coverage.castles - started >= 1, true);
      castles++;
    }
  }
  ok(castles === 8, 'castling for each of the 4 seats, both sides: identical (king and rook placement, rights cleared, events), then 40 random plies each');
}
{
  // En passant, in all three relationships between the double-stepping pawn's axis and the capturer's: a Red pawn double-steps e2-e4
  // (passing e3) and a pawn of every other seat captures onto e3.
  const cases = [
    ['Blue (perpendicular)', 1, ['bP@d4']],
    ['Yellow (opposing)', 2, ['yP@f4']],
    ['Green (perpendicular, other side)', 3, ['gP@f2']],
  ];
  for (const [name, seat, extra] of cases) {
    const started = coverage.enPassant;
    playGame(600 + seat, {
      style: 'human', maxPlies: 30, chaos: 0, botEvery: 5, label: `en passant ${name}`,
      build: (E) => E.stateFromPieces([...KINGS, 'rP@e2', ...extra], { turn: 0 }),
      prelude: (ls) => {
        scripted(ls, 0, 'e2', 'e4');
        assert.ok(ls.fe.ep && FE.squareName(ls.fe.ep.passed) === 'e3', 'the double step recorded e3 as the passed square');
        const capture = scripted(ls, seat, FE.squareName(FE.legalMoves(ls.fe, seat).find((m) => m.flags & FE.FLAG_EN_PASSANT).from), 'e3');
        assert.ok(capture.flags & FE.FLAG_EN_PASSANT, `${name}: capturing onto e3 is an en passant capture`);
        assert.equal(ls.fe.cells[sq('e4')], FE.EMPTY, 'the captured pawn (on e4, not on e3) is gone');
      },
    });
    assert.ok(coverage.enPassant - started >= 1);
  }
  ok(coverage.enPassant >= 3, `en passant by a perpendicular, an opposing and the other perpendicular seat: identical (${coverage.enPassant} captures)`);
}
{
  // Every promotion piece for every seat. Each pawn stands one step from its seat's promotion line (forward coordinate 7 of 0..13).
  const steps = [
    [0, 'e7', 'e8'],
    [1, 'g6', 'h6'],
    [2, 'e8', 'e7'],
    [3, 'h6', 'g6'],
  ];
  const letter = ['r', 'b', 'y', 'g'];
  let count = 0;
  for (const [seat, from, to] of steps) {
    for (const type of FE.PROMOTABLE_TYPES) {
      playGame(700 + seat * 4 + type, {
        style: 'human', maxPlies: 12, chaos: 0, botEvery: 4, label: `promote seat ${seat} to type ${type}`,
        build: (E) => E.stateFromPieces([...KINGS, `${letter[seat]}P@${from}`], { turn: seat }),
        prelude: (ls) => {
          const move = scripted(ls, seat, from, to, type);
          assert.ok(move.flags & FE.FLAG_PROMOTION && FE.promotionOf(move) === type, 'the legal move found for this piece is a promotion to exactly it');
          assert.equal(FE.typeOf(ls.fe.cells[sq(to)]), FE.PROMOTED_TYPE_OF[type], 'the board shows the promoted piece type');
        },
      });
      count++;
    }
  }
  ok(count === 16 && Object.values(coverage.promotions).every((n) => n >= 4), `all four promotion pieces for all four seats: identical (${JSON.stringify(coverage.promotions)})`);
}
{
  // A tuned ply cap, and the hard 5000-ply ceiling that no rules object can raise.
  const before = coverage.endings.cap;
  playGame(800, { style: 'bot', maxPlies: 500, chaos: 0, initialSeconds: 3600, botEvery: 3, label: 'cap at 25 plies', build: (E) => E.initialState({ ...E.FFA_RULES, maxPlies: 25 }) });
  ok(coverage.endings.cap === before + 1, 'a game with rules.maxPlies = 25 ends by "cap" at the same ply in both engines');
  playGame(801, {
    style: 'human', maxPlies: 6000, chaos: 0, initialSeconds: 3600, botEvery: 1, label: 'hard cap',
    build: (E) => E.stateFromPieces([...KINGS, 'rR@d1', 'bR@a4', 'yR@d14', 'gR@n4'], { ply: 4994, rules: { ...E.FFA_RULES, maxPlies: 1_000_000 } }),
  });
  ok(coverage.endings.cap === before + 2, `rules.maxPlies = 1 000 000 is still ended by HARD_MAX_PLIES (${FE.HARD_MAX_PLIES}) in both engines`);
}

console.log('\n=== 5. Outcomes that are hard to build by hand: a bounded hunt over more seeds ===');
{
  const wanted = () => coverage.stalemates >= 2 && coverage.checkmates >= 6 && coverage.frozen >= 10 && coverage.timeouts >= 10 && coverage.resigns >= 10;
  let seed = 2000;
  const started = Date.now();
  while (!wanted() && seed < 2400) playGame(seed++, { style: seed % 3 === 0 ? 'bot' : 'human', maxPlies: 400, chaos: 0.01, initialSeconds: 300, botEvery: 20 });
  ok(wanted(), `stalemate/checkmate/frozen/timeout/resign were all reached (${seed - 2000} extra games, ${Date.now() - started} ms): stalemates ${coverage.stalemates}, checkmates ${coverage.checkmates}, frozen ${coverage.frozen}, timeouts ${coverage.timeouts}, resigns ${coverage.resigns}`);
}

console.log('\n=== 6. The suite says what it covered - and fails if a rare rule was never reached ===');
{
  const c = coverage;
  const reached = {
    castling: c.castles >= 8,
    'en passant': c.enPassant >= 3,
    'promotion to q/r/b/n': Object.values(c.promotions).every((n) => n >= 4),
    'double step': c.doubleSteps >= 50,
    capture: c.captures >= 200,
    'dead-king walks': c.deadKingMoves >= 100,
    'frozen king': c.frozen >= 1,
    checkmate: c.checkmates >= 1,
    stalemate: c.stalemates >= 1,
    resignation: c.resigns >= 1,
    'flag fall (timeout)': c.timeouts >= 1,
    'game ends by elimination': c.endings.elimination >= 1,
    'game ends by dead position': c.endings.deadPosition >= 1,
    'game ends by ply cap': c.endings.cap >= 2,
    'bots compared at 1200/1700': c.botComparisons >= 500,
    'deep bots compared': c.deepBotComparisons >= 50,
  };
  for (const [name, hit] of Object.entries(reached)) ok(hit, `exercised: ${name}`);
  console.log(`      ${c.games} games, ${c.plies} plies, ${c.moves} moves; coverage ${JSON.stringify(c)}`);
}

console.log(`\nAll ${passed} checks passed.`);
