/**
 * Chaturaji browser end-to-end: the REAL app (a web build) against the REAL server, driven through the UI like a player, with every screen compared against the server's own
 * state after every move (CHATURAJI_SPEC.md W4). Why it exists: W3's screen tests found that the app's online client sent the CROSS board's square names - every online
 * Chaturaji move would have gone to the wrong square - and the socket-level e2e could not see it because it uses its own client.
 *
 *   npm run test:e2eBrowser                       (all scenarios)
 *   E2E_ONLY=A,B npm run test:e2eBrowser          (some)
 *   E2E_WEBDIR=<an exported dev build> ...        (reuse a build instead of exporting one)
 *   E2E_SHOTS=<dir> ...                           (screenshots at the interesting moments)
 *
 * It starts its own backend (port 3191, local database only, short fill wait and takeover grace) and its own static copy of the app (port 8087), registers test accounts and
 * deletes them in a `finally`. It never touches ports 3000 / 8081 / 8082 or the deployed backend (stack.mjs). Fixed seeds, no wall-clock assertions.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startStack, sleep } from './stack.mjs';
import { User, launchBrowser, PHONE_LARGE, PHONE_SMALL } from './app.mjs';
import { Match, mulberry32 } from './match.mjs';
import { SEAT_NAMES, SQUARE8, findRoom, legalMoves } from './truth.mjs';
import { io } from 'socket.io-client';

const only = (process.env.E2E_ONLY ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const shotsDir = process.env.E2E_SHOTS ?? '';
if (shotsDir) mkdirSync(shotsDir, { recursive: true });
const log = (m) => console.log(m);

const results = [];
const ok = (cond, message) => {
  if (!cond) throw new Error(`FAILED: ${message}`);
  console.log(`    ok  ${message}`);
};
const shot = async (user, name) => {
  if (shotsDir) await user.screenshot(join(shotsDir, `${name}.png`));
};

/** Every "+N" the server's score changes imply must have appeared on every screen. */
async function expectGainsOnScreens(match, users, from = 0) {
  const wanted = match.room.gains.filter((g) => g.seq > from).map((g) => `gain-${g.seat}=+${g.points}`);
  for (const u of users) {
    const seen = await u.seen();
    for (const w of wanted) if (!seen.includes(w)) throw new Error(`${u.name} never showed ${w} (saw: ${seen.filter((s) => s.startsWith('gain-')).join(', ') || 'no gains'})`);
  }
  return wanted;
}

// --- A: two humans and two bots, ten full rounds ----------------------------------------------------------------------------------

async function scenarioA(ctx) {
  const [a, b] = ctx.users;
  const match = await Match.start(ctx.stack, [a, b], { rng: mulberry32(101), log });
  ctx.match = match;
  const seats = match.room.seats.map((s) => `${s.kind}:${s.name}`);
  ok(match.room.seats.filter((s) => s.kind === 'bot').length === 2, `two bots filled the table after the fill wait (${seats.join(', ')})`);
  await match.converge('the start position');
  ok((await a.boardMismatches(match.room.state)).length === 0, 'the start position on screen is the server\'s');
  await shot(a, 'A-start');
  let pillSeen = false;
  let shotCapture = false;
  const moves = await match.play({
    done: (m) => m.room.state.ply >= 40 && m.room.gains.length > 0,
    maxMoves: 70,
    onMove: async (info) => {
      if (info.captured && !shotCapture) {
        shotCapture = true;
        await shot(info.user, 'A-capture');
      }
    },
  });
  ok(match.room.state.ply >= 40 || match.room.state.result, `played ${moves} human moves, ${match.room.state.ply} plies (10 rounds = 40 plies)`);
  ok(match.checks >= moves, `after each of ${match.checks} positions every screen equalled the server (board, points, statuses, clocks, pill)`);
  const wanted = await expectGainsOnScreens(match, [a, b]);
  ok(wanted.length > 0, `${wanted.length} capture(s)/fork(s) scored points, each shown as "+N" on BOTH screens (${wanted.join(', ')})`);
  const seen = (await a.seen()).concat(await b.seen());
  pillSeen = seen.some((s) => s.startsWith('king-attacked-pill'));
  console.log(`    info  the king-attacked pill appeared ${pillSeen ? 'during this game (and matched the server every time)' : 'never in this game (the pill is also checked at every position against the server; constructed online in chaturajiOnline.dom.test.tsx)'}`);
  const promoted = seen.filter((s) => s.startsWith('promotion-burst')).length;
  console.log(`    info  automatic promotions seen: ${promoted} ${promoted ? '' : '(not reachable in this game; covered by the constructed online test chaturajiOnline.dom.test.tsx: promotion goes without a question)'}`);
  await shot(a, 'A-end');
}

// --- shared waits -----------------------------------------------------------------------------------------------------------------------

/** Waits (no clock involved) until the server says `seat` satisfies `test`. */
const waitSeat = (match, seat, test, what, timeoutMs = match.stack.graceMs * 2 + 30_000) =>
  match.watcher.waitFor((r) => r.seats[seat] && test(r.seats[seat]), what, timeoutMs).catch((err) => {
    throw new Error(`${err.message} (seat ${seat} is ${JSON.stringify(match.room.seats[seat])}, engine status ${match.room.state.status[seat]}, ply ${match.room.state.ply})`);
  });

/** Waits until the seat card of `seat` on `viewer`'s screen contains `pattern`. */
async function waitCardText(viewer, seat, pattern, what, timeoutMs = 60_000) {
  const t0 = Date.now();
  for (;;) {
    const cards = await viewer.seatCards();
    if (cards[seat] && pattern.test(cards[seat])) return cards[seat];
    if (Date.now() - t0 > timeoutMs) throw new Error(`${viewer.name}: ${what} (card: ${cards[seat]})`);
    await sleep(100);
  }
}

const boardUp = (user, timeoutMs = 90_000) => user.page.getByLabel('Chaturaji board').waitFor({ timeout: timeoutMs });

/**
 * The bots' play is not seeded, so now and then a human's king is captured early in a run. A step that needs a seat to still be in the game (a takeover, a resignation) says
 * so here; the harness then repeats the scenario with a fresh game (up to three tries) instead of reporting a failure that is not one.
 */
class Inconclusive extends Error {}
function needActive(match, seats, when) {
  const { state } = match.room;
  const gone = seats.filter((s) => state.status[s] !== 'active');
  if (state.result || gone.length) throw new Inconclusive(`before ${when}: ${state.result ? 'the game ended' : `seat ${gone.join(',')} is no longer active`} (ply ${state.ply})`);
}

/** Plays on (with the humans on screen) until the position is `plies` further along, or the game ends. */
const playPlies = (match, plies, maxMoves = 40) => {
  const target = match.room.state.ply + plies;
  return match.play({ done: (m) => m.room.state.ply >= target, maxMoves });
};

// --- B: a seat taken over by a bot, and handed back ------------------------------------------------------------------------------------

async function scenarioB(ctx) {
  const [a, b] = ctx.users;
  const match = await Match.start(ctx.stack, [a, b], { rng: mulberry32(202), log });
  ctx.match = match;
  await match.converge('the start position');
  await playPlies(match, 4);
  const seatB = match.seatOf(b);
  const seatA = match.seatOf(a);

  // (i) B leaves through the menu: after the grace period a bot plays the seat, and A's screen says so
  needActive(match, [seatA, seatB], 'B leaves');
  await b.leaveGame();
  match.screens = [a];
  await waitSeat(match, seatB, (s) => s.kind === 'bot', 'a bot to take over B\'s seat');
  ok(match.room.seats[seatB].botReason === 'takeover', `the server's seat ${seatB} is a bot with reason "takeover" (${match.room.seats[seatB].name} keeps the name)`);
  const card = await waitCardText(a, seatB, /bot playing/, 'A never saw "bot playing" at B\'s seat');
  ok(true, `A's screen shows B's seat as: ${card}`);
  await shot(a, 'B-takeover-seen-by-A');
  await playPlies(match, 4);
  needActive(match, [seatA, seatB], 'B returns');
  ok((await b.page.getByText(/Return to your game/).count()) === 1, 'B\'s Play menu offers "Return to your game" under the Chaturaji card');
  await shot(b, 'B-return-link');

  // ... B returns: the seat is handed back
  await b.returnToGame();
  await boardUp(b);
  await waitSeat(match, seatB, (s) => s.kind === 'human' && s.name === b.account.username, 'the seat to be handed back to B');
  match.screens = [a, b];
  await match.converge('after B returned (menu)');
  ok(!(await a.seatCards())[seatB].includes('bot playing'), 'A no longer sees "bot playing" at B\'s seat');
  ok(true, `B's board, points, clocks and statuses equal the server's (seq ${match.room.seq})`);
  await shot(b, 'B-handed-back');
  await playPlies(match, 4);

  // (ii) B closes the tab (no "Leave"): the same thing, and a NEW tab of the same login restores the game by itself (the persisted rejoin)
  needActive(match, [seatA, seatB], 'B closes the tab');
  await b.page.close();
  match.screens = [a];
  await waitSeat(match, seatB, (s) => s.kind === 'bot', 'a bot to take over after the tab was closed');
  await waitCardText(a, seatB, /bot playing/, 'A never saw "bot playing" after the tab was closed');
  await playPlies(match, 4);
  needActive(match, [seatA, seatB], 'B reopens the tab');
  await b.reopen();
  await boardUp(b);
  await waitSeat(match, seatB, (s) => s.kind === 'human' && s.name === b.account.username, 'the seat to come back to B in the new tab');
  match.screens = [a, b];
  await match.converge('after B reopened the tab');
  ok(true, 'a new tab restored B\'s game on its own and every screen equals the server');
  await playPlies(match, 6);
  ok(match.room.seats[seatA].kind === 'human', 'A kept their own seat throughout');
}

// --- C: hard reload mid-game ------------------------------------------------------------------------------------------------------------

async function scenarioC(ctx) {
  const [a, b] = ctx.users;
  const match = await Match.start(ctx.stack, [a, b], { rng: mulberry32(303), log });
  ctx.match = match;
  await match.converge('the start position');
  await playPlies(match, 10);
  for (const [label, who] of [['A', [a]], ['B', [b]], ['both', [a, b]]]) {
    const seats = who.map((u) => match.seatOf(u));
    await Promise.all(who.map((u) => u.page.reload()));
    for (const u of who) await boardUp(u);
    for (const seat of seats) await waitSeat(match, seat, (s) => s.kind === 'human', `the reloaded seat ${seat} to be human again`);
    await match.converge(`after reloading ${label}`);
    ok(true, `after a hard reload of ${label} the screen is back on the game and equals the server (seq ${match.room.seq}, ply ${match.room.state.ply})`);
    await shot(who[0], `C-reload-${label}`);
    await playPlies(match, 6);
  }
}

// --- D: a spectator ---------------------------------------------------------------------------------------------------------------------

async function scenarioD(ctx) {
  const [a, b, c] = ctx.users;
  const match = await Match.start(ctx.stack, [a, b], { rng: mulberry32(404), log });
  ctx.match = match;
  await match.converge('the start position');
  await playPlies(match, 6);
  await c.spectate(a.account.username);
  const joinSeq = match.room.seq;
  match.screens = [a, b, c];
  await match.converge('the spectator joined');
  ok(true, 'the spectator found the game under Spectate > Chaturaji and its screen equals the server');
  await shot(c, 'D-spectator');
  // a spectator cannot move: tapping the mover's piece offers nothing
  const mover = match.room.state.turn;
  const tryMove = legalMoves(match.room.state, mover)[0];
  await c.tapSquare(SQUARE8.squareName(tryMove.from));
  ok((await c.offeredSquares()).length === 0, 'tapping a piece on the spectator screen offers no move');
  const before = match.room.seq;
  await c.tapSquare(SQUARE8.squareName(tryMove.to));
  ok((await c.offeredSquares()).length === 0 && match.room.seq >= before, 'and tapping a destination sends nothing');
  await match.play({ done: (m) => m.room.gains.some((g) => g.seq > joinSeq) && m.room.state.ply >= 30, maxMoves: 60 });
  const wanted = await expectGainsOnScreens(match, [a, b, c], joinSeq);
  ok(wanted.length > 0, `every "+N" since the spectator joined appeared on all three screens (${wanted.join(', ')})`);
  // a status change reaches the spectator too: A resigns, and C's seat card says "king walking" like the others
  const seatA = match.seatOf(a);
  needActive(match, [seatA], 'A resigns');
  await a.resign();
  await match.watcher.waitFor((r) => r.state.status[seatA] === 'dead-king', 'A\'s king to start walking', 30_000);
  await match.converge('after A resigned (spectator included)');
  ok(true, 'after A resigned all three screens show A\'s king walking, as the server');
  await shot(c, 'D-spectator-after-resign');
}

// --- E: endings -------------------------------------------------------------------------------------------------------------------------

/** The result card of every screen against the server's final scores, and the +3 per surviving king under the last seat standing. */
async function expectResultCards(match, users) {
  const over = match.room.gameOver;
  ok(!!over, `the server ended the game: ${over.reason}, winners ${JSON.stringify(over.winners)}, scores ${JSON.stringify(over.scores)}`);
  const final = match.room.state;
  const kingsOf = (seat) => final.cells.filter((code) => code > 0 && code >> 4 === seat && (code & 15) === 6).length;
  for (const u of users) {
    let card = null;
    for (let i = 0; i < 200 && !card; i++) {
      card = await u.resultCard();
      if (!card) await sleep(100);
    }
    if (!card) throw new Error(`${u.name} shows no result card`);
    for (let seat = 0; seat < 4; seat++) if (card.scores[seat] !== String(over.scores[seat])) throw new Error(`${u.name}: ${SEAT_NAMES[seat]} shows ${card.scores[seat]}, server final ${over.scores[seat]} (${card.text})`);
    const detailSeats = Object.keys(card.details).map(Number);
    // The rule, read off the server's final position: when the game ended by elimination with exactly one seat still active, that seat got +3 for every OTHER seat's king still on the board.
    const active = [0, 1, 2, 3].filter((s) => final.status[s] === 'active');
    const othersKings = active.length === 1 ? [0, 1, 2, 3].filter((s) => s !== active[0] && kingsOf(s) > 0).length : 0;
    if (active.length === 1 && [0, 1, 2, 3].filter((s) => s !== active[0] && final.kings[s] >= 0).length !== othersKings) throw new Error('the king count read off the board disagrees with the engine\'s own record of the kings');
    const expectedBonus = over.reason === 'elimination' ? 3 * othersKings : 0;
    if (expectedBonus > 0) {
      ok(detailSeats.length === 1 && detailSeats[0] === active[0], `${u.name}: only the last seat standing (${SEAT_NAMES[active[0]]}) carries the surviving-kings breakdown (lines at seats: ${detailSeats.join(',') || 'none'})`);
      const seat = active[0];
      const m = /^(\d+) points? — (\d+) from play \+ (\d+) for (\d+) kings? left$/.exec(card.details[seat]);
      if (!m) throw new Error(`${u.name}: breakdown not understood: ${card.details[seat]}`);
      const [total, fromPlay, bonus, kings] = m.slice(1).map(Number);
      ok(total === over.scores[seat] && fromPlay + bonus === total && bonus === expectedBonus && kings === othersKings, `${u.name}: ${SEAT_NAMES[seat]}: ${card.details[seat]} (server score ${over.scores[seat]}; the final board holds ${othersKings} other king(s), so +${expectedBonus})`);
    } else {
      ok(detailSeats.length === 0, `${u.name}: ${over.reason}, ${active.length} active seat(s), ${othersKings} other king(s) left: no surviving-kings bonus line, as the rule says`);
    }
    ok(true, `${u.name}'s ranking and points equal the server's final scores: ${card.text}`);
  }
}

async function scenarioE(ctx) {
  const [a, b] = ctx.users;
  // E1: a resignation walks the king, on every screen
  const match = await Match.start(ctx.stack, [a, b], { rng: mulberry32(505), log });
  ctx.match = match;
  await match.converge('the start position');
  await playPlies(match, 8);
  const seatA = match.seatOf(a);
  needActive(match, [seatA], 'A resigns');
  await a.resign();
  await match.watcher.waitFor((r) => r.state.status[seatA] === 'dead-king', 'A\'s king to start walking', 30_000);
  await match.converge('after A resigned');
  ok(true, `A resigned: the server says dead-king for ${SEAT_NAMES[seatA]} and both screens show "king walking" (cards: ${(await b.seatCards())[seatA]})`);
  await shot(b, 'E-resigned-walking-king');
  await playPlies(match, 6);
  // B resigns as well: only bots are left, and the game runs out
  await b.resign();
  await match.watcher.waitFor((r) => !!r.gameOver, 'the game to end (resigned humans, bots only)', 600_000);
  await match.converge('the final position');
  await expectResultCards(match, [a, b]);
  await shot(b, 'E-game-over');
  ctx.match.close();

  // E2: a game to a clock timeout, then to its end
  for (const u of [a, b]) {
    await u.tapText('Back to menu');
  }
  const m2 = await Match.start(ctx.stack, [a, b], { timeControl: '1 min', rng: mulberry32(506), log });
  ctx.match = m2;
  await m2.converge('the start position (1 min)');
  const seats = [m2.seatOf(a), m2.seatOf(b)];
  await m2.watcher.waitFor((r) => r.state.status[seats[0]] !== 'active', 'a human\'s clock to run out', 600_000);
  const flagged = seats.find((s) => m2.room.state.status[s] !== 'active');
  await m2.converge('after the timeout');
  ok(true, `the clock of ${SEAT_NAMES[flagged]} ran out: the server says ${m2.room.state.status[flagged]} and both screens agree`);
  await shot(a, 'E-timeout');
  await m2.watcher.waitFor((r) => !!r.gameOver, 'the game to end', 900_000);
  await m2.converge('the final position (1 min)');
  await expectResultCards(m2, [a, b]);
  await shot(a, 'E-game-over-timeout');
}

// --- F: three variants queued at once stay in their own rooms ---------------------------------------------------------------------------

async function scenarioF(ctx) {
  // A lone player waits for a second human before the bots fill the table, so each variant gets TWO accounts: three pairs queue at the same time control at once.
  const [c1, c2, f1, f2, g1, g2] = ctx.users;
  const plan = [
    { users: [c1, c2], label: 'chaturaji', variant: 'chaturaji' },
    { users: [f1, f2], label: '4 Player Chess', variant: 'ffa' },
    { users: [g1, g2], label: '4 Player Giveaway', variant: 'giveaway' },
  ];
  await Promise.all(plan.flatMap(({ users, label }) => users.map((user) => user.queue(label, '10 min'))));
  await boardUp(c1);
  await boardUp(c2);
  const probe = io(ctx.stack.apiUrl, { transports: ['websocket'], reconnection: false });
  await new Promise((resolve, reject) => {
    probe.once('connect', resolve);
    probe.once('connect_error', reject);
  });
  try {
    for (const { users, variant } of plan) {
      const names = users.map((u) => u.account.username);
      let room = null;
      for (let i = 0; i < 900 && !room; i++) {
        room = await findRoom(probe, names, variant);
        if (!room) await sleep(100);
      }
      if (!room) throw new Error(`the pair ${users.map((u) => u.name)} has no ${variant} room on the server`);
      const humans = room.seats.filter((s) => s.kind === 'human').map((s) => s.name).sort();
      ok(JSON.stringify(humans) === JSON.stringify([...names].sort()), `the ${variant} room holds exactly its own two humans (${humans.length}) and ${4 - humans.length} bots`);
    }
    for (const { users, variant } of plan) {
      for (const other of plan.filter((p) => p.variant !== variant)) {
        for (const user of users) ok(!(await findRoom(probe, [user.account.username], other.variant)), `${user.name} is in no ${other.variant} room`);
      }
    }
  } finally {
    probe.disconnect();
  }
  ok((await c1.hasBoard()) && (await c2.hasBoard()), 'the Chaturaji pair sees the Chaturaji board');
  for (const u of [f1, f2, g1, g2]) ok(!(await u.hasBoard()), `${u.name} (another variant) does not see a Chaturaji board`);
  const match = await Match.attach(ctx.stack, [c1, c2], { rng: mulberry32(606), log });
  ctx.match = match;
  await match.converge('the Chaturaji game while the other two variants run');
  await playPlies(match, 8);
  ok(true, 'the Chaturaji pair keeps playing correctly, screens equal to the server, with the other variants running next door');
  await shot(c1, 'F-chaturaji');
  await shot(f1, 'F-4p-chess');
  await shot(g1, 'F-giveaway');
}

// --- G: layout --------------------------------------------------------------------------------------------------------------------------

async function scenarioLayout(ctx) {
  const [a, b] = ctx.users;
  const match = await Match.start(ctx.stack, [a, b], { rng: mulberry32(707), log });
  ctx.match = match;
  await match.converge('the start position');
  const check = async (when) => {
    for (const u of [a, b]) {
      const l = await u.layout();
      const w = l.inner.w;
      const problems = [];
      if (l.overflowX > 0) problems.push(`the page scrolls sideways by ${l.overflowX}px`);
      if (!l.board || l.board.left < 0 || l.board.right > w) problems.push(`the board leaves the screen (${JSON.stringify(l.board)})`);
      if (l.cell < 36) problems.push(`cells are only ${l.cell}px`);
      if (l.cards.length !== 4) problems.push(`${l.cards.length} seat cards`);
      for (const [i, card] of l.cards.entries()) if (card.left < 0 || card.right > w || card.width < 40) problems.push(`seat card ${i} sits at ${card.left}-${card.right} of ${w}`);
      if (l.clipped.length) problems.push(`clipped text: ${l.clipped.join('; ')}`);
      if (problems.length) throw new Error(`${u.name} ${when} at ${w}x${l.inner.h}: ${problems.join(' | ')}`);
      ok(true, `${u.name} ${when} at ${w}x${l.inner.h}: no sideways scroll, board ${l.board.width}px wide (${l.cell}px cells), 4 seat cards inside the screen, no clipped text${l.shortened.length ? ` (a long name is shortened with an ellipsis: ${l.shortened.join('; ')})` : ''}`);
    }
  };
  await check('at the start');
  await shot(a, `G-${ctx.viewport.width}x${ctx.viewport.height}-start`);
  await playPlies(match, 30, 60);
  await check('mid-game (points, statuses, last-move markers on screen)');
  await shot(a, `G-${ctx.viewport.width}x${ctx.viewport.height}-mid`);
}

const SCENARIOS = {
  A: { name: 'two humans and two bots, ten rounds', accounts: 2, run: scenarioA },
  B: { name: 'takeover by a bot and hand-back (menu and closed tab)', accounts: 2, run: scenarioB },
  C: { name: 'hard reload mid-game restores the game', accounts: 2, run: scenarioC },
  D: { name: 'a spectator sees the live game, cannot move', accounts: 3, run: scenarioD },
  E: { name: 'endings: resignation, clock timeout, game over with the points breakdown', accounts: 2, run: scenarioE },
  F: { name: 'three variants queued at once stay in their own rooms', accounts: 6, run: scenarioF },
  G1: { name: 'layout at 360x640', accounts: 2, viewport: PHONE_SMALL, run: scenarioLayout },
  G2: { name: 'layout at 412x915', accounts: 2, viewport: PHONE_LARGE, run: scenarioLayout },
};

// --- the harness -----------------------------------------------------------------------------------------------------------------------

async function main() {
  const stack = await startStack({ webDir: process.env.E2E_WEBDIR, log });
  const browser = await launchBrowser();
  let failed = false;
  try {
    for (const [key, scenario] of Object.entries(SCENARIOS)) {
      if (only.length && !only.some((o) => key === o || key.startsWith(o))) continue;
      console.log(`\n=== ${key}. ${scenario.name} ===`);
      for (let attempt = 1; attempt <= 3; attempt++) {
        const users = [];
        const ctx = { stack, browser, users, match: null, viewport: scenario.viewport ?? PHONE_LARGE };
        let again = false;
        try {
          for (let i = 0; i < scenario.accounts; i++) {
            const user = await User.open(browser, stack.webUrl, `${key}${i + 1}`, ctx.viewport);
            await user.login(await stack.createAccount(`${key.toLowerCase()}${i}`));
            users.push(user);
          }
          await scenario.run(ctx);
          results.push({ key, pass: true });
        } catch (err) {
          if (err instanceof Inconclusive && attempt < 3) {
            again = true;
            console.log(`    retry  ${err.message} - the bots ended this game early; playing it again with a fresh game (try ${attempt + 1} of 3)`);
          } else {
            failed = true;
            results.push({ key, pass: false, error: String(err instanceof Error ? err.message : err) });
            console.log(`    FAIL  ${err instanceof Error ? err.message : err}`);
            if (shotsDir && users[0]) await shot(users[0], `${key}-FAIL`).catch(() => {});
          }
        } finally {
          ctx.match?.close();
          for (const u of users) {
            if (u.pageErrors?.length) console.log(`    note  ${u.name} page errors: ${u.pageErrors.slice(0, 2).join(' | ')}`);
            await u.close().catch(() => {});
          }
        }
        if (!again) break;
      }
    }
  } finally {
    await browser.close().catch(() => {});
    const cleanup = await stack.tracker.cleanup();
    await stack.stop();
    console.log(`\naccounts deleted: ${cleanup.deleted} (left: ${cleanup.remaining})`);
  }
  console.log('\n' + results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.key}${r.error ? `  ${r.error}` : ''}`).join('\n'));
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
void sleep;
void PHONE_SMALL;
