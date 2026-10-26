/**
 * Bughouse ONLINE - the bot AS THE SERVER RUNS IT (src/game/bughouse/bot.ts, GENERATED from the app's src/logic/bughouse/bot.ts; BUGHOUSE_SPEC.md HP4, workstream W2).
 *
 *   npm run test:bughouseBot        (plain tsx, no server, no database; needs the app checked out at ../)
 *
 * The app has its own bot tests (bughouseBot.test.ts: mates, traps, promotion, determinism). This script proves the COPY: on the backend's own dependencies the generated bot is legal
 * on thousands of seeded decisions (checked against the engine's own legal lists), makes exactly the choice the app's bot makes for the same position and seed (client / mirror parity),
 * ends whole matches with the conservation invariant intact, and stays inside the decision budget at EVERY ELO tier (p50 / p99 / max printed; p99 asserted under 25 ms, best of 3
 * per decision so a busy machine's hiccup is not charged to the bot).
 */
import assert from 'node:assert/strict';
import * as appNamespace from '../../src/logic/bughouse/index.ts';
import * as server from '../src/game/bughouse/index.js';

const app = appNamespace.default ?? appNamespace;

let passed = 0;
function check(condition, message) {
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

const TIERS = [400, 800, 1200, 1700, 2000, 2400, 3000];
const hr = () => Number(process.hrtime.bigint()) / 1e6;
const keyOf = (a) => (a === null ? 'none' : a.kind === 'move' ? `m:${a.board}:${a.from}${a.to}${a.promotion ?? ''}` : a.kind === 'drop' ? `d:${a.board}:${a.piece}@${a.square}` : a.kind);

/** One seeded bot match on the SERVER engine; `visit(match, seat, action, elo)` sees every decision before it is applied. */
function playMatch(seed, elos, timeControl, maxCommits, visit, repeat = 1) {
  const rng = mulberry32(seed);
  let match = server.createMatch({ timeControl, roomNumber: seed, startMs: 0 });
  let now = 0;
  let refused = 0;
  const costs = [];
  for (let guard = 0; match.result === null && guard < maxCommits * 3; guard++) {
    const toMove = [0, 1, 2, 3].filter((s) => match.verdicts[server.seatPlace(s).board].turn === server.seatPlace(s).color);
    const seat = toMove[Math.floor(rng() * toMove.length)];
    now += 1000 + Math.floor(rng() * 2000);
    const decisionSeed = (seed * 1000003 + guard) >>> 0;
    let action = null;
    let best = Infinity;
    for (let run = 0; run < repeat; run++) {
      const started = hr();
      action = server.chooseBughouseAction(match, seat, elos[seat], mulberry32(decisionSeed));
      best = Math.min(best, hr() - started);
    }
    costs.push(best);
    visit?.(match, seat, action, elos[seat], decisionSeed);
    const outcome = server.settle(match, action === null ? null : { seat, action }, now);
    if (outcome.kind === 'rejected') refused++;
    else match = outcome.match;
    if (match.seq >= maxCommits) break;
  }
  return { match, refused, costs, conservation: server.conservationProblems(match) };
}

console.log('\n=== 1. The generated copy is the app\'s bot ===');
{
  check(typeof server.chooseBughouseAction === 'function' && typeof server.firstLegalAction === 'function', 'the server copy exports the bot');
  check(server.BUGHOUSE_BOT_LOOKAHEAD === 5 && server.BUGHOUSE_BOT_MAX_DROP_CANDIDATES === 12 && server.BUGHOUSE_BOT_DROP_PROBES === 3 && server.BUGHOUSE_BOT_RESCUE_BATCHES === 2, 'the caps are the ones the budget was measured with (5, 12, 3, 2)');
}

console.log('\n=== 2. Legal on every decision, and the same decision as the app\'s bot ===');
{
  let decisions = 0;
  let drops = 0;
  let refused = 0;
  let mismatches = 0;
  for (const [i, elo] of TIERS.entries()) {
    for (let seed = 1; seed <= 6; seed++) {
      const result = playMatch(
        50 * (i + 1) + seed,
        [elo, elo, elo, elo],
        { initialMs: 60000, incrementMs: 0 },
        70,
        (match, seat, action, strength, decisionSeed) => {
          decisions++;
          const legal = server.legalActions(match, seat);
          if (action === null) {
            assert.equal(legal.moves.length + legal.drops.length, 0, 'a null answer means the seat really cannot act');
            return;
          }
          const keys = new Set([...legal.moves.map((m) => `m:${action.board}:${m.from}${m.to}${m.promotion ?? ''}`), ...legal.drops.map((d) => `d:${action.board}:${d.piece}@${d.square}`)]);
          assert.ok(keys.has(keyOf(action)), `illegal bot action ${keyOf(action)} for seat ${seat} at seq ${match.seq}`);
          if (action.kind === 'drop') drops++;
          // the app's bot on the same position (read back through the app's own deserializer) and the same seed
          const appMatch = app.deserializeMatch(server.serializeMatch(match));
          if (appMatch.ok) {
            const theirs = app.chooseBughouseAction(appMatch.match, seat, strength, mulberry32(decisionSeed));
            if (keyOf(theirs) !== keyOf(action)) mismatches++;
          } else mismatches++;
        },
      );
      refused += result.refused;
      assert.deepEqual(result.conservation, [], 'conservation');
    }
  }
  check(decisions >= 1500 && drops >= 50, `${decisions} seeded decisions (${drops} drops) are all in the engine's legal lists`);
  check(refused === 0, 'the match never refused a bot action');
  check(mismatches === 0, 'the app\'s bot and the server\'s copy make the same choice for the same position, strength and seed on every one of them');
}

console.log('\n=== 3. Whole matches end ===');
{
  const ends = {};
  let refused = 0;
  let commits = 0;
  for (let seed = 1; seed <= 24; seed++) {
    const tier = [TIERS[seed % 7], TIERS[(seed + 2) % 7], TIERS[(seed + 4) % 7], TIERS[(seed + 6) % 7]];
    const result = playMatch(9000 + seed, tier, server.BUGHOUSE_TIME_CONTROLS[seed % 6], 3000);
    assert.ok(result.match.result !== null, `match ${seed} did not end`);
    assert.deepEqual(result.conservation, [], `match ${seed} conservation`);
    refused += result.refused;
    commits += result.match.seq;
    const r = result.match.result;
    if ('winnerTeam' in r) ends[r.reason] = (ends[r.reason] ?? 0) + 1;
  }
  check(refused === 0 && commits > 1000, `24 matches with mixed strengths all terminate on their own (${commits} commits, ends ${JSON.stringify(ends)}), conservation intact, nothing refused`);
}

console.log('\n=== 4. The decision budget at every tier (best of 3 per decision) ===');
{
  playMatch(999, [3000, 3000, 3000, 3000], { initialMs: 60000, incrementMs: 0 }, 200); // warm-up
  const rows = [];
  for (const elo of TIERS) {
    const samples = [];
    for (let seed = 1; seed <= 10; seed++) samples.push(...playMatch(7000 + seed, [elo, elo, elo, elo], { initialMs: 60000, incrementMs: 0 }, 400, undefined, 3).costs);
    samples.sort((a, b) => a - b);
    const p = (q) => samples[Math.floor(samples.length * q)];
    rows.push(`ELO ${String(elo).padStart(4)}: n=${samples.length} p50 ${p(0.5).toFixed(2)} ms  p99 ${p(0.99).toFixed(2)} ms  max ${samples[samples.length - 1].toFixed(2)} ms`);
    assert.ok(p(0.99) < 25, `p99 at ELO ${elo} is ${p(0.99).toFixed(2)} ms`);
  }
  passed++;
  console.log(rows.map((r) => `        ${r}`).join('\n'));
  console.log('  ok  p99 is under the 25 ms budget at every one of the seven tiers');
}

console.log(`\nALL ${passed} CHECKS PASSED`);
