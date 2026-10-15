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
 * exercise, and the rare rules are asserted to have been reached (see section 6) - "identical on random games" must never silently
 * mean "never got to castling". The hardest-to-stumble-into things are BUILT instead of hunted (sections 4 and 4b): castling, en
 * passant, every promotion, the ply caps, a forced stalemate with its exact scores, and the bot's stalemate and castling terms,
 * each tuned to sit mid-decision so a divergent constant flips seeded choices (see TESTING.md section 10).
 */
import assert from 'node:assert/strict';
import * as feBarrel from '../../src/logic/fourPlayer/index.ts';
import * as feSetup from '../../src/logic/fourPlayer/setup.ts';
import * as fePresentation from '../../src/logic/fourPlayer/presentation.ts';
import * as fePremove from '../../src/logic/fourPlayer/premove.ts';
import * as feAnnotations from '../../src/logic/fourPlayer/annotations.ts';
import * as BE from '../src/game/fourPlayer/index.ts';
import * as feWire from '../../src/logic/fourPlayerWire.ts';
import * as beWire from '../src/game/fourPlayerWire.ts';

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
const BEWire = unwrap(beWire);

/**
 * Developer / mutation-testing switch (CI never sets it): PARITY_ONLY_CONSTRUCTED=1 skips the random-game sections (2, 3, the hunt and the
 * coverage meter), so the hand-built sections (4, 4b) run ALONE. A planted divergence that the random games would catch first (and so
 * kill the run before the constructed tests are reached) can then be shown to be caught by the constructed test itself.
 */
const ONLY_CONSTRUCTED = process.env.PARITY_ONLY_CONSTRUCTED === '1';

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

/** 4 Player Giveaway has its OWN tally (section 4c), so adding it cannot shift the Chess coverage thresholds or shorten the Chess hunt. */
const giveawayCoverage = { ...JSON.parse(JSON.stringify(coverage)), kingCaptures: 0, endings: { cap: 0, outOfPieces: 0, stuck: 0, lastStanding: 0 } };
let tally = coverage;

function countEvents(events) {
  for (const e of events) {
    if (e.kind === 'move') {
      tally.moves++;
      if (e.move.captured) tally.captures++;
      if (e.move.captured && FE.typeOf(e.move.captured) === FE.KING) tally.kingCaptures = (tally.kingCaptures ?? 0) + 1;
      const f = e.move.flags;
      if (f & FE.FLAG_DOUBLE_STEP) tally.doubleSteps++;
      if (f & FE.FLAG_CASTLE) tally.castles++;
      if (f & FE.FLAG_EN_PASSANT) tally.enPassant++;
      if (f & FE.FLAG_PROMOTION) tally.promotions['qrbn'[FE.PROMOTABLE_TYPES.indexOf(FE.promotionOf(e.move))]]++;
    } else if (e.kind === 'deadKingMove') tally.deadKingMoves++;
    else if (e.kind === 'frozen') tally.frozen++;
    else if (e.kind === 'eliminated') {
      if (e.reason === 'checkmate') tally.checkmates++;
      else if (e.reason === 'stalemate') tally.stalemates++;
      else if (e.reason === 'resign') tally.resigns++;
      else if (e.reason === 'timeout') tally.timeouts++;
    } else if (e.kind === 'gameOver') tally.endings[e.result.reason] = (tally.endings[e.result.reason] ?? 0) + 1;
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
  tally.games++;
  tally.plies += ls.fe.ply;
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
if (!ONLY_CONSTRUCTED) {
  const started = Date.now();
  for (let seed = 1; seed <= 14; seed++) playGame(seed, { style: 'human', maxPlies: 320, botEvery: 8 });
  ok(coverage.games === 14, `14 random-move games, ${coverage.plies} plies, identical at every ply (positions, legal moves, events, clocks, bots every 8th ply)`);
  console.log(`      (${Date.now() - started} ms)`);
}

console.log('\n=== 3. Bot-played full games, run to their natural end where possible ===');
if (!ONLY_CONSTRUCTED) {
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
  ls.lastEvents = a.events; // for scenarios that assert on exactly what happened, not just that both engines agree
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

console.log("\n=== 4b. A stalemate and the bot's castling bonus, BUILT (not left to the random hunt) ===");
/**
 * Runs `chooseBotMove` on BOTH engines for many seeded decisions (same seed per pair) and requires identical choices; returns how often
 * `isTarget` matched. A bonus or penalty of a fraction of a pawn changes a decision only when the noisy candidate scores are close, so
 * it shows up as a SHIFT IN FREQUENCY over many seeds - which is exactly what a parity test can pin: a divergent constant on one side
 * flips some of the pairs.
 */
function botSweep(label, build, elos, seedsPerElo, isTarget) {
  const ls = new Lockstep(label, build(FE), build(BE));
  const targetOf = (E, move) => isTarget(E, move);
  const result = { decisions: 0, hits: 0, byElo: {} };
  for (const elo of elos) {
    let hits = 0;
    for (let s = 1; s <= seedsPerElo; s++) {
      const seed = (s * 7919 + elo) >>> 0;
      const a = FE.chooseBotMove(ls.fe, elo, mulberry32(seed));
      const b = BE.chooseBotMove(ls.be, elo, mulberry32(seed));
      ls.same(`bot move (ELO ${elo}, seed ${s})`, a, b);
      if (a && targetOf(FE, a)) hits++;
    }
    result.byElo[elo] = hits;
    result.decisions += seedsPerElo;
    result.hits += hits;
    coverage.botComparisons += seedsPerElo;
  }
  return result;
}
const STALEMATE_BASE = ['rK@h1', 'rB@d6', 'bK@a4', 'yK@g14', 'gK@n7'];
{
  // 1. The RULE, scripted. Blue's king on a4 has three squares: a5 and b5 (a Red rook on rank 5 sweeps both) and b4 (the Red bishop on
  //    d6 covers it); a4 itself is on neither line, so Blue is NOT in check. Red plays Re8-e5 and Blue, to move, has no legal move:
  //    stalemate - the stalemated seat gets +20, every other active seat +10, and nobody is "credited".
  const started = coverage.stalemates;
  playGame(950, {
    style: 'human', maxPlies: 40, chaos: 0, botEvery: 2, label: 'stalemate by construction',
    build: (E) => E.stateFromPieces([...STALEMATE_BASE, 'rR@e8'], { turn: 0 }),
    prelude: (ls) => {
      assert.ok(FE.legalMoves(ls.fe, 1).length > 0, 'before Red moves, Blue still has king moves (the stalemate is created by the move)');
      scripted(ls, 0, 'e8', 'e5');
      const eliminated = ls.lastEvents.filter((e) => e.kind === 'eliminated');
      assert.equal(eliminated.length, 1, 'exactly one seat is eliminated by the move');
      assert.equal(eliminated[0].seat, 1, 'it is Blue');
      assert.equal(eliminated[0].reason, 'stalemate', 'for STALEMATE, not checkmate (Blue is not in check)');
      assert.equal(eliminated[0].credit, null, 'nobody is credited with a stalemate');
      assert.deepEqual([...eliminated[0].points], [10, 20, 10, 10], 'points: the stalemated seat +20, every OTHER active seat +10');
      assert.deepEqual([...ls.fe.score], [10, 20, 10, 10], 'and the scores are exactly that (no captures happened)');
      assert.equal(ls.fe.status[1], 'dead-king', 'Blue is out, its king keeps walking');
      assert.equal(ls.fe.result, null, 'the game goes on (three seats are still active)');
      assert.equal(ls.fe.turn, 2, 'and the turn passes to Yellow');
    },
  });
  ok(coverage.stalemates === started + 1, 'a stalemate FORCED by a constructed position: scores [10,20,10,10] asserted exactly, identical in both engines, then a random continuation incl. the dead king walking');
}
{
  // 2. The BOT'S stalemate term (-6: stalemating the next seat is bad for the mover). Same stalemate pattern, but the stalemating move
  //    (Rg8xg5) also captures a Yellow BISHOP: 5 capture points x 1.5 plus about +1.1 from the evaluation = about +8.6, so with the -6
  //    the move nets about +2.6 - level with the best of the ~35 other moves once their noise is added. That is deliberate: the
  //    constant has to sit MID-DECISION, so that a change in EITHER direction flips choices (an earlier version captured a knight, whose
  //    +5.5 left the move at -0.5: the scored choice then never took it, almost every "hit" was the bot's random-move branch, and a
  //    penalty made STRONGER went unnoticed). The bishop is on g5 so that ONLY the rook can take it - the Red bishop on d6 would
  //    otherwise offer a free capture and drown the effect.
  const build = (E) => E.stateFromPieces([...STALEMATE_BASE, 'rR@g8', 'yB@g5', 'yP@c7'], { turn: 0 });
  const g8 = FE.parseSquare('g8');
  const g5 = FE.parseSquare('g5');
  const sweep = botSweep('bot vs stalemating capture', build, [1000, 1100, 1200], 1500, (E, m) => m.from === g8 && m.to === g5);
  console.log(`      stalemating capture chosen ${sweep.hits}/${sweep.decisions} (by ELO: ${JSON.stringify(sweep.byElo)})`);
  ok(sweep.decisions === 4500, `the careful bot (ELO 1000-1200) chooses identically in both engines over ${sweep.decisions} seeded decisions where the best capture also stalemates the next seat`);
  // "Mid-decision" made precise. A decision is SCORED with probability botStrength(elo).bestChance and otherwise a uniformly random legal
  // move; so the hits that come from the scored branch are (hits - the random branch's expected share). That rate must be neither
  // "never" nor "always", or a change to the constant in one direction would go unnoticed.
  const moveCount = FE.legalMoves(FE.stateFromPieces([...STALEMATE_BASE, 'rR@g8', 'yB@g5', 'yP@c7'], { turn: 0 }), 0).length;
  const scored = [1000, 1100, 1200].reduce((n, elo) => n + 1500 * FE.botStrength(elo).bestChance, 0);
  const randomShare = [1000, 1100, 1200].reduce((n, elo) => n + (1500 * (1 - FE.botStrength(elo).bestChance)) / moveCount, 0);
  const scoredRate = (sweep.hits - randomShare) / scored;
  console.log(`      scored decisions ~${scored.toFixed(0)}, random-branch hits ~${randomShare.toFixed(0)} -> the scored choice takes the stalemating capture ${(100 * scoredRate).toFixed(1)}% of the time`);
  ok(scoredRate > 0.25 && scoredRate < 0.92, `...mid-decision: the scored choice takes it ${(100 * scoredRate).toFixed(0)}% of the time (not never, not always), so the -6 matters in BOTH directions`);
}
{
  // 3. The BOT'S castling nudge (+0.3 for careful and deep). Castling is one candidate among ~22 equal-value moves (king steps, rook
  //    moves), so the nudge shows only as a frequency shift - at low ELO, where the noise is large enough for it to matter.
  const build = (E) => E.stateFromPieces(['rK@h1', 'rR@d1', 'bK@a8', 'yK@g14', 'gK@n7'], { turn: 0 });
  const sweep = botSweep('bot castling nudge', build, [1000, 1100, 1250, 1500, 1800], 1500, (E, m) => (m.flags & E.FLAG_CASTLE) !== 0);
  console.log(`      castle chosen ${sweep.hits}/${sweep.decisions} (by ELO: ${JSON.stringify(sweep.byElo)})`);
  ok(sweep.decisions === 7500, `the careful and deep bots choose identically in both engines over ${sweep.decisions} seeded decisions with a castle available`);
  ok(sweep.hits >= 50 && sweep.hits < sweep.decisions * 0.5, `...and the nudge is in play: castling is chosen sometimes but nowhere near always (${sweep.hits} times, ${(100 * sweep.hits / sweep.decisions).toFixed(1)}%)`);
}

console.log('\n=== 5. Outcomes that are hard to build by hand: a bounded hunt over more seeds ===');
if (!ONLY_CONSTRUCTED) {
  // The hunt must find a stalemate ITSELF (random play stumbling into one is part of what is being checked): the scripted stalemate in
  // section 4b must not shorten it, or the random parity breadth would shrink as a side effect of adding a constructed test.
  const stalematesBefore = coverage.stalemates;
  const wanted = () => coverage.stalemates - stalematesBefore >= 1 && coverage.checkmates >= 6 && coverage.frozen >= 10 && coverage.timeouts >= 10 && coverage.resigns >= 10;
  let seed = 2000;
  const started = Date.now();
  while (!wanted() && seed < 2400) playGame(seed++, { style: seed % 3 === 0 ? 'bot' : 'human', maxPlies: 400, chaos: 0.01, initialSeconds: 300, botEvery: 20 });
  ok(wanted(), `stalemate/checkmate/frozen/timeout/resign were all reached (${seed - 2000} extra games, ${Date.now() - started} ms; the hunt itself found ${coverage.stalemates - stalematesBefore} stalemate(s)): stalemates ${coverage.stalemates}, checkmates ${coverage.checkmates}, frozen ${coverage.frozen}, timeouts ${coverage.timeouts}, resigns ${coverage.resigns}`);
}

console.log('\n=== 5b. 4 Player Giveaway: the same engine under the Giveaway rules, app vs mirror, in lockstep ===');
{
  tally = giveawayCoverage;
  const GA = (E) => E.GIVEAWAY_RULES;
  const gBuild = (pieces, options = {}) => (E) => E.stateFromPieces(pieces, { rules: GA(E), ...options });
  /** Resigns / flags `who` on BOTH engines at a scripted moment (an off-turn resignation is the case clockTick cannot produce). */
  function scriptedResign(ls, who, reason = 'resign') {
    const a = FE.resign(ls.fe, who, mulberry32(11), reason);
    const b = BE.resign(ls.be, who, mulberry32(11), reason);
    ls.same('events', a.events, b.events);
    countEvents(a.events);
    ls.fe = a.state;
    ls.be = b.state;
    ls.lastEvents = a.events;
    ls.states();
  }
  const GK = ['rK@h1', 'bK@a8', 'yK@g14', 'gK@n7'];
  const sqn = (name) => FE.parseSquare(name);

  // 1. Random full games from the start position: human-style moves with every promotion piece, resignations and flag falls (chaos), no bots
  //    (the Giveaway bot arrives in W2). A 400-ply cap keeps a game short; the lockstep compares position, legal moves, events and clocks every ply.
  const started = Date.now();
  for (let seed = 3001; seed <= 3030; seed++) {
    playGame(seed, { style: 'human', maxPlies: 400, botEvery: 0, chaos: 0.02, initialSeconds: 300, label: 'giveaway random', build: (E) => E.initialState({ ...GA(E), maxPlies: 400 }) });
  }
  ok(giveawayCoverage.games === 30, `30 random Giveaway games, ${giveawayCoverage.plies} plies, identical at every ply (positions, legal moves, events, clocks, snapshot round trips) - ${Date.now() - started} ms`);

  // 2. Built scenes: each rule scripted on both engines, asserted exactly, then a random continuation.
  playGame(3101, {
    style: 'human', maxPlies: 30, chaos: 0, botEvery: 0, label: 'giveaway forced capture hands Green the win',
    build: gBuild(['rK@h1', 'bK@a9', 'yR@g8', 'gP@m8'], { turn: 0 }),
    prelude: (ls) => {
      scripted(ls, 0, 'h1', 'h2');
      scripted(ls, 1, 'a9', 'a10');
      assert.deepEqual(FE.legalMoves(ls.fe, 2).map((m) => FE.moveLabel(m)), ['g8xm8'], 'Yellow\'s only legal move is the capture of Green\'s last pawn');
      scripted(ls, 2, 'g8', 'm8');
      assert.deepEqual(ls.fe.result, { winners: [3], reason: 'outOfPieces' }, 'Green lost its last piece, so Green wins at once');
    },
  });
  playGame(3102, {
    style: 'human', maxPlies: 30, chaos: 0, botEvery: 0, label: 'giveaway stuck seat wins',
    build: gBuild(['rP@g5', 'bP@f5', 'rK@h1', 'yK@g14', 'gK@n7'], { turn: 0 }),
    prelude: (ls) => {
      scripted(ls, 0, 'h1', 'h2');
      assert.deepEqual(ls.fe.result, { winners: [1], reason: 'stuck' }, 'Blue\'s pawn is blocked, so Blue wins when its turn arrives');
    },
  });
  playGame(3103, {
    style: 'human', maxPlies: 30, chaos: 0, botEvery: 0, label: 'giveaway last standing',
    build: gBuild(GK, { turn: 0 }),
    prelude: (ls) => {
      scripted(ls, 0, 'h1', 'h2');
      scriptedResign(ls, 1, 'timeout'); // Blue flags while to move -> Yellow
      assert.equal(ls.fe.turn, 2, 'the turn passed to Yellow');
      scriptedResign(ls, 0); // Red resigns off-turn
      scriptedResign(ls, 3, 'timeout'); // Green flags: Yellow is the last one standing
      assert.deepEqual(ls.fe.result, { winners: [2], reason: 'lastStanding' }, 'one active seat is left, so it wins');
    },
  });
  playGame(3104, {
    style: 'human', maxPlies: 30, chaos: 0, botEvery: 0, label: 'giveaway cap: fewest pieces, ties shared',
    build: gBuild(['rK@h1', 'rP@e3', 'bK@a8', 'bP@b9', 'yK@g14', 'yP@e12', 'yP@f12', 'gK@n7', 'gP@m6', 'gP@m5'], { ply: 5, rules: { ...FE.GIVEAWAY_RULES, maxPlies: 6 } }),
    prelude: (ls) => {
      scripted(ls, 0, 'h1', 'h2');
      assert.deepEqual(ls.fe.result, { winners: [0, 1], reason: 'cap' }, 'Red and Blue tie for the fewest pieces');
    },
  });
  playGame(3105, {
    style: 'human', maxPlies: 30, chaos: 0, botEvery: 0, label: 'giveaway en passant is the only (and forced) capture',
    build: gBuild(['yP@i13', 'gP@j11', ...GK], { turn: 2 }),
    prelude: (ls) => {
      scripted(ls, 2, 'i13', 'i11');
      assert.deepEqual(FE.legalMoves(ls.fe, 3).map((m) => FE.moveLabel(m)), ['j11xi12 e.p.'], 'Green must capture en passant');
      const capture = scripted(ls, 3, 'j11', 'i12');
      assert.ok(capture.flags & FE.FLAG_EN_PASSANT);
    },
  });
  for (const type of FE.PROMOTABLE_TYPES) {
    playGame(3110 + type, {
      style: 'human', maxPlies: 30, chaos: 0, botEvery: 0, label: `giveaway promotion by capture to type ${type}`,
      build: gBuild(['rP@e7', 'bR@f8', 'bP@b9', 'rK@h1', 'yK@g14', 'gK@n7'], { turn: 0 }),
      prelude: (ls) => {
        assert.equal(FE.legalMoves(ls.fe, 0).length, 4, 'only the four capturing promotions are legal (the quiet push is not)');
        const move = scripted(ls, 0, 'e7', 'f8', type);
        assert.ok(move.captured && FE.promotionOf(move) === type, 'a promotion that captures');
      },
    });
  }
  playGame(3120, {
    style: 'human', maxPlies: 30, chaos: 0, botEvery: 0, label: 'giveaway king capture and a wall',
    build: gBuild(['rR@d5', 'bK@d9', 'bP@b9', 'bN@e5', 'rK@h1', 'yK@g14', 'gK@n7'], { turn: 0 }),
    prelude: (ls) => {
      scripted(ls, 0, 'd5', 'd9'); // the rook takes Blue's king (the knight on e5 was a second capture option: the mover chooses)
      assert.equal(ls.fe.kings[1], -1, 'a captured king leaves `kings`');
      scriptedResign(ls, 1); // Blue resigns: its pawn and knight become walls
      assert.ok(FE.legalMoves(ls.fe, 0).every((m) => m.captured === 0), 'a wall is never a forced capture');
      assert.equal(FE.legalMoves(ls.fe, 0).some((m) => m.to === sqn('b9') || m.to === sqn('e5')), false, 'and never a destination (the Red rook on d9 stops before the wall on b9)');
    },
  });
  playGame(3121, {
    style: 'human', maxPlies: 30, chaos: 0, botEvery: 0, label: 'giveaway no castling with every right set',
    build: gBuild(['rK@h1', 'rR@d1', 'rR@k1', ...GK.slice(1)], { turn: 0, castling: 0xff }),
    prelude: (ls) => {
      assert.equal(FE.legalMoves(ls.fe, 0).some((m) => m.flags & FE.FLAG_CASTLE), false, 'no castling in Giveaway');
    },
  });

  // 3. Scenes added after the first mutation pass found the parity script blind to them (each was a divergence it did not notice).
  //    Both engines are asked for the legal moves of the seat that matters, not only for the resulting position.
  const sameLegal = (ls, seat, what) => ls.same(what, FE.legalMoves(ls.fe, seat), BE.legalMoves(ls.be, seat));
  playGame(3130, {
    style: 'human', maxPlies: 30, chaos: 0, botEvery: 0, label: 'giveaway en passant against a wall',
    build: gBuild(['yP@i13', 'gP@j11', ...GK], { turn: 2 }),
    prelude: (ls) => {
      scripted(ls, 2, 'i13', 'i11'); // Yellow double-steps; Green could take it en passant...
      scriptedResign(ls, 2); // ...but Yellow resigns first: its pawn is a wall
      sameLegal(ls, 3, 'legal moves of Green');
      assert.equal(FE.legalMoves(ls.fe, 3).some((m) => m.flags & FE.FLAG_EN_PASSANT), false, 'no en passant against a wall');
      assert.ok(ls.fe.ep !== null, 'the opportunity is still recorded (that is what makes the guard matter)');
    },
  });
  playGame(3131, {
    style: 'human', maxPlies: 30, chaos: 0, botEvery: 0, label: 'giveaway outOfPieces on the cap ply',
    build: gBuild(['rR@e5', 'gP@m5', 'rK@h1', 'bK@a8', 'yK@g14'], { turn: 0, ply: 9, rules: { ...FE.GIVEAWAY_RULES, maxPlies: 10 } }),
    prelude: (ls) => {
      scripted(ls, 0, 'e5', 'm5');
      assert.deepEqual(ls.fe.result, { winners: [3], reason: 'outOfPieces' }, 'the last-piece win beats the cap tie-break');
      assert.deepEqual(ls.lastEvents.map((e) => e.kind), ['move', 'gameOver'], 'and is announced exactly once');
    },
  });
  playGame(3132, {
    style: 'human', maxPlies: 30, chaos: 0, botEvery: 0, label: 'giveaway mover left stuck by a resignation',
    build: gBuild(['bP@e5', 'rP@f5', 'yN@f6', 'rK@h1', 'yK@g14', 'gK@n7'], { turn: 1 }),
    prelude: (ls) => {
      assert.deepEqual(FE.legalMoves(ls.fe, 1).map((m) => FE.moveLabel(m)), ['e5xf6'], 'the forced capture is Blue\'s only move');
      scriptedResign(ls, 2); // Yellow resigns: the knight becomes a wall, Blue (to move) has nothing left
      assert.deepEqual(ls.fe.result, { winners: [1], reason: 'stuck' }, 'the seat already to move is stuck, and wins');
    },
  });
  playGame(3133, {
    style: 'human', maxPlies: 30, chaos: 0, botEvery: 0, label: 'giveaway cap with an eliminated seat holding the fewest pieces',
    build: gBuild(['rK@h1', 'rP@e3', 'bK@a8', 'yK@g14', 'yP@e12', 'yP@f12', 'gK@n7', 'gP@m6', 'gP@m5'], { ply: 5, rules: { ...FE.GIVEAWAY_RULES, maxPlies: 6 }, status: ['active', 'frozen', 'active', 'active'] }),
    prelude: (ls) => {
      scripted(ls, 0, 'h1', 'h2');
      assert.deepEqual(ls.fe.result, { winners: [0], reason: 'cap' }, 'Blue holds the fewest pieces but is eliminated: Red wins the cap');
    },
  });
  playGame(3134, {
    style: 'human', maxPlies: 30, chaos: 0, botEvery: 0, label: 'giveaway hand-built position has no castling rights by default',
    build: gBuild(['rK@h1', 'rR@d1', 'rR@k1', ...GK.slice(1)], { turn: 0 }),
    prelude: (ls) => {
      assert.equal(ls.fe.castling, 0, 'the rights start empty although king and rooks are on their start squares');
      assert.equal(BE.stateFromPieces(['rK@h1', 'rR@d1', 'rR@k1', ...GK.slice(1)], { rules: BE.GIVEAWAY_RULES }).castling, 0, 'on the mirror too');
    },
  });

  // 4. The wire validators, behaviourally: the generated copy and the app source must answer every input identically (section 1 only compares that
  //    the exports exist). The battery includes the variant field.
  {
    const FEWire = unwrap(feWire);
    const inputs = [
      undefined, null, 0, 1, NaN, '', 'ffa', 'giveaway', 'Giveaway', ' ffa', 'chess', true, [], {}, ['giveaway'], { variant: 'giveaway' },
      { timeControl: { initialSeconds: 300, incrementSeconds: 0 } },
      { timeControl: { initialSeconds: 300, incrementSeconds: 0 }, variant: 'giveaway' },
      { timeControl: { initialSeconds: 300, incrementSeconds: 0 }, variant: 'ffa', timeControlLabel: 'Blitz' },
      { timeControl: { initialSeconds: 300, incrementSeconds: 0 }, variant: 'nope' },
      { timeControl: { initialSeconds: 300, incrementSeconds: 0 }, variant: null },
      { timeControl: { initialSeconds: 5, incrementSeconds: 0 }, variant: 'giveaway' },
      { roomId: 'r', from: 'e7', to: 'e8', promotion: 'n' },
      { roomId: 'r', from: 'e7', to: 'e8', promotion: 'k' },
    ];
    let compared = 0;
    for (const name of ['validateFourVariant', 'validateFourJoinQueue', 'validateFourTimeControl', 'validateFourMovePayload']) {
      for (const input of inputs) {
        assert.equal(JSON.stringify(FEWire[name](input)), JSON.stringify(BEWire[name](input)), `${name}(${JSON.stringify(input)}) differs between the app source and the backend copy`);
        compared++;
      }
    }
    for (const v of [{}, { variant: 'ffa' }, { variant: 'giveaway' }]) assert.equal(FEWire.fourVariantOf(v), BEWire.fourVariantOf(v));
    assert.deepEqual([...FEWire.FOUR_REASONS], [...BEWire.FOUR_REASONS]);
    assert.equal(FEWire.validateFourVariant(undefined).value, 'ffa');
    ok(compared === 4 * inputs.length, `the wire validators (variant, join, time control, move) answer ${compared} inputs identically in the app source and the backend copy; omitted variant = ffa; FOUR_REASONS equal`);
  }

  const g = giveawayCoverage;
  const reachedG = {
    'captures taken': g.captures >= 100,
    'king captured': g.kingCaptures >= 1,
    'en passant': g.enPassant >= 1,
    'promotion to q/r/b/n': Object.values(g.promotions).every((n) => n >= 1),
    resignation: g.resigns >= 1,
    'flag fall (timeout)': g.timeouts >= 1,
    'ends by outOfPieces': g.endings.outOfPieces >= 2,
    'ends by stuck': g.endings.stuck >= 1,
    'ends by lastStanding': g.endings.lastStanding >= 1,
    'ends by cap': g.endings.cap >= 1,
    'no points were ever scored and no seat ever walked': g.deadKingMoves === 0 && g.checkmates === 0 && g.stalemates === 0 && g.frozen === 0,
  };
  for (const [name, hit] of Object.entries(reachedG)) ok(hit, `giveaway exercised: ${name}`);
  console.log(`      ${g.games} Giveaway games, ${g.plies} plies, ${g.moves} moves; coverage ${JSON.stringify(g)}`);
  tally = coverage;
}

console.log('\n=== 6. The suite says what it covered - and fails if a rare rule was never reached ===');
if (!ONLY_CONSTRUCTED) {
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
