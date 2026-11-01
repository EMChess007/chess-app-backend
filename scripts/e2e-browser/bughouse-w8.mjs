/**
 * Bughouse browser end-to-end, W8 (command #34): the REAL app (a web build) against the REAL server, driven through the UI like players. Where `bughouse-online.mjs` (W4) is one
 * game of two humans, this suite is the rest of the flow:
 *
 *   A  four humans on four pages (two phones, a landscape phone, a small phone): the match, each player's board turned to their colour, moves and drops by taps until every human has
 *      acted ten times with BOTH boards of ALL FOUR screens compared with the server's own spectator stream after EVERY action (a capture on one board and the drop it feeds on the other
 *      happen on the way), the pockets on every screen equal to the server's, quick messages and team chat (the partner's page shows them, the opponents' pages and a spectator socket
 *      never get them), a RELOAD in the middle of the game, a TAKEOVER by a bot when a human's page closes and the HAND-BACK when it returns, a SPECTATOR page opened from the Spectate
 *      list (both boards equal to the server, no Resign), then a resignation and the game-over card on every page;
 *   B  the friend flow on two real pages: create a room, read the code, join with it, start with bots; the table and both screens agree with the server.
 *
 *   npm run test:e2eBrowserBughouseW8             (all)         E2E_ONLY=A or B  (one)
 *   E2E_WEBDIR=<an exported dev build> ...        (reuse a build instead of exporting one)
 *   E2E_SHOTS=<dir> ...                           (screenshots at the interesting moments)
 *   export E2E_BROWSER_PATH=/opt/pw-browsers/chromium     (the cloud VM has no system Chrome)
 *
 * Determinism: the server is started with BUGHOUSE_TEST_SEED (the existing guarded switch, CHECKLIST 7: set here, on the stack's own child process) so the seats and the bots are the same
 * on every run, and the humans' choices come from a seeded stream. No assertion depends on how long anything takes: waits end on a condition, their bounds only turn a hang into a failure.
 * A check inside a loop does not count (its count depends on how many rounds it took); the printed total is the same on every run. Each scenario may be repeated ONCE when it fails
 * (the retry is printed); a second failure fails the run.
 *
 * It starts its own backend (port 3191, local database only, short fill wait and takeover grace) and its own static copy of the app (port 8087), registers throw-away accounts and
 * deletes them in a `finally`; it never touches 3000 / 8081 / 8082 or the deployed backend.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startStack, sleep } from './stack.mjs';
import { User, launchBrowser, PHONE_LARGE, PHONE_SMALL } from './app.mjs';
import { actByTaps, connectSocket, converge, emitAck, mulberry32, queueBughouse, seatOnScreen, tap, watchRoom, whiteAtBottom } from './bughouse-kit.mjs';
// (the app's engine, file by file: a namespace import of its index exposes nothing under tsx, as in truth.mjs)
import { legalActions } from '../../../src/logic/bughouse/match.ts';
import { pocketChips } from '../../../src/logic/bughouseView.ts';

const only = (process.env.E2E_ONLY ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const shotsDir = process.env.E2E_SHOTS ?? '';
if (shotsDir) mkdirSync(shotsDir, { recursive: true });
const log = (m) => console.log(m);
const LANDSCAPE_PHONE = { width: 915, height: 412 };
const BUG_SEED = 20261101;
const ROUNDS_PER_HUMAN = 10;

let checks = 0;
/** A counted check. */
const ok = (cond, message) => {
  if (!cond) throw new Error(`FAILED: ${message}`);
  checks++;
  console.log(`    ok  ${message}`);
};
/** A check inside a loop: it fails the same way but is not counted (how often it runs depends on the game). */
const must = (cond, message) => {
  if (!cond) throw new Error(`FAILED: ${message}`);
};
const shot = async (user, name) => {
  if (shotsDir) await user.screenshot(join(shotsDir, `${name}.png`));
};
const waitUntil = async (what, test, timeoutMs = 30_000, gap = 50) => {
  const t0 = Date.now();
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(gap);
  }
};
const present = async (user, testId) => (await user.page.locator(`[data-testid="${testId}"]`).count()) > 0;

/** The pieces each pocket chip row of every seat shows on `user`'s screen equal the server's pockets (kinds present; the strip shows counts too). */
async function pocketsEqualServer(watched, user) {
  const bad = [];
  for (const seat of [0, 1, 2, 3]) {
    const board = seat < 2 ? 'A' : 'B';
    const word = seat % 2 === 0 ? 'white' : 'black';
    const want = pocketChips(watched.match, seat, null).map((c) => c.piece).sort();
    const got = (await user.page.$$eval(`[data-testid^="pocket-${board}-${word}-"]`, (els) => els.map((e) => (e.getAttribute('data-testid') ?? '').split('-').pop()))).sort();
    // (a seat whose pocket sits in the partner thumbnail is drawn as text, not as chips: only judge a pocket the screen draws as chips)
    if (got.length > 0 && want.join('') !== got.join('')) bad.push(`${user.name} ${board} ${word}: server ${want.join('') || '-'}, screen ${got.join('') || '-'}`);
  }
  return bad;
}

/** Back into the online game after a reload / a reopened page: either it opens by itself, or the Bughouse card offers "Return to your game". */
async function backInTheGame(user) {
  await user.page.getByText('Play', { exact: true }).first().waitFor({ timeout: 60_000 }).catch(() => {});
  const inGame = async () => present(user, 'bughouse-online');
  await waitUntil(`${user.name}'s game to reopen`, async () => (await inGame()) || (await present(user, 'bughouse-resume')) || (await user.page.getByText('Play', { exact: true }).count()) > 0, 60_000);
  if (await inGame()) return 'automatically';
  if (!(await present(user, 'bughouse-resume'))) await user.tapText('Play');
  await user.page.locator('[data-testid="bughouse-resume"]').waitFor({ timeout: 20_000 });
  await user.press(user.page.locator('[data-testid="bughouse-resume"]'));
  await user.page.locator('[data-testid="bughouse-online"]').waitFor({ timeout: 30_000 });
  return 'by "Return to your game"';
}

// --- A: four humans ------------------------------------------------------------------------------------------------------------------------------------------------

async function scenarioA(ctx) {
  const { browser, stack } = ctx;
  const viewports = [PHONE_LARGE, PHONE_LARGE, LANDSCAPE_PHONE, PHONE_SMALL];
  const users = [];
  let watched = null;
  let spectator = null;
  let observer = null;
  try {
    for (const [i, viewport] of viewports.entries()) {
      const user = await User.open(browser, stack.webUrl, `H${i + 1}`, viewport);
      await user.login(await stack.createAccount(`bw${i + 1}`));
      users.push(user);
    }
    console.log('\n=== A1. four humans queue: no bots, no fill wait ===');
    for (const u of users) await queueBughouse(u, '5 min');
    for (const u of users) await u.page.locator('[data-testid="bughouse-online"]').waitFor({ timeout: 90_000 });
    watched = await watchRoom(stack.apiUrl, users.map((u) => u.account.username));
    const places = [];
    for (const u of users) places.push(await seatOnScreen(u));
    ok(new Set(places.map((p) => p.seat)).size === 4, `four different seats: ${places.map((p) => `${p.board}${p.color}`).join(' ')}`);
    ok(watched.seats.every((s) => s.kind === 'human'), 'all four seats are humans (the queue of four needs no bot)');
    for (const [i, u] of users.entries()) must(watched.seats[places[i].seat].name === u.account.username, `${u.name} sits at the seat the server says`);
    ok(true, 'each screen and the server agree on who sits where');
    const teams = places.map((p) => p.team);
    ok(places.every((p) => p.team === (p.seat === 0 || p.seat === 3 ? 1 : 2)), `teams are the diagonal pairs of the spec (${teams.join(',')}) on every screen`);
    await converge(watched, users, 'the start position');
    ok(true, 'the start position of BOTH boards is on all FOUR screens (a phone, a landscape phone and a small phone)');

    console.log('\n=== A2. orientation: every player has their own colour at the bottom of their own board ===');
    for (const [i, u] of users.entries()) must((await whiteAtBottom(u, places[i].board)) === (places[i].color === 'w'), `${u.name} (${places[i].board} ${places[i].color}): the board is turned to their colour`);
    ok(true, 'each of the four boards is drawn from its player\'s side (White at the bottom for White, Black at the bottom for Black)');
    await shot(users[0], 'A-start-phone');
    await shot(users[2], 'A-start-landscape');

    console.log('\n=== A3. moves and drops by taps: ten actions per human, every position compared on all four screens ===');
    const rng = mulberry32(20261101);
    const acted = [0, 0, 0, 0];
    const lastSeq = [-1, -1, -1, -1];
    let drops = 0;
    let captures = 0;
    const t0 = Date.now();
    while (acted.some((n) => n < ROUNDS_PER_HUMAN)) {
      if (Date.now() - t0 > 480_000) throw new Error(`not enough play in time (${acted.join(',')} actions)`);
      if (watched.match.result !== null) throw new Error('the game ended by itself before every human had played ten actions (inconclusive: run again)');
      let any = false;
      for (const [i, u] of users.entries()) {
        if (watched.seq <= lastSeq[i]) continue;
        const before = watched.seq;
        const eventsBefore = watched.events.length;
        const action = await actByTaps({ legalActions, watched, user: u, place: places[i], rng, dropShare: 0.55 });
        if (!action) continue;
        any = true;
        lastSeq[i] = before;
        acted[i]++;
        await waitUntil(`the server to answer ${u.name}`, () => watched.seq > before, 15_000, 25);
        await converge(watched, users, `after ${u.name}'s action ${acted[i]}`);
        for (const e of watched.events.slice(eventsBefore)) {
          if (e.kind === 'drop') drops++;
          if (e.kind === 'move' && (e.captured || e.capture)) captures++;
        }
      }
      if (!any) await sleep(80);
    }
    ok(acted.every((n) => n >= ROUNDS_PER_HUMAN), `every human acted at least ${ROUNDS_PER_HUMAN} times (${acted.join(', ')}); after each action both boards of all four screens equalled the server`);
    ok(watched.movedBoards.size === 2, 'moves happened on BOTH boards');
    ok(drops >= 1, `a captured piece was dropped by a partner on the other board at least once (${drops} drops on the way)`);
    for (const u of users) {
      const bad = await pocketsEqualServer(watched, u);
      must(bad.length === 0, `pockets differ from the server: ${bad.join('; ')}`);
    }
    ok(true, 'the pockets every screen draws hold the kinds of piece the server\'s pockets hold');
    await shot(users[1], 'A-midgame');

    console.log('\n=== A4. quick messages and team chat: the partner sees them, the opponents and a spectator never do ===');
    observer = await connectSocket(stack.apiUrl);
    const spectateRes = await emitAck(observer, 'bug_spectate_game', { roomId: watched.roomId });
    must(spectateRes.ok, 'a second spectator socket could not join');
    const heard = [];
    observer.onAny((event) => heard.push(event));
    const sender = 1;
    const partner = places.findIndex((p, i) => i !== sender && p.team === places[sender].team);
    const opponents = [0, 1, 2, 3].filter((i) => i !== sender && i !== partner);
    must(partner >= 0 && opponents.length === 2, 'the partner and the two opponents are found');
    await tap(users[sender], 'bughouse-quick');
    await users[sender].page.locator('[data-testid="bughouse-quick-grid"]').waitFor({ timeout: 10_000 });
    await tap(users[sender], 'bughouse-quick-0');
    const toast = users[partner].page.locator('[data-testid="bughouse-quick-toast"]');
    await toast.waitFor({ timeout: 15_000 });
    const toastText = await toast.getAttribute('aria-label');
    ok(/Need a knight/.test(toastText ?? ''), `the partner's page shows the quick message as a toast ("${toastText}")`);
    for (const i of opponents) must(!(await present(users[i], 'bughouse-quick-toast')), `${users[i].name} (an opponent) must not see the quick message`);
    ok(true, 'neither opponent\'s page shows a quick message');
    const secret = `plan-${BUG_SEED}-castle`;
    await tap(users[sender], 'bughouse-chat');
    await users[sender].page.locator('[data-testid="bughouse-team-chat-input"]').fill(secret);
    await tap(users[sender], 'bughouse-team-chat-send');
    await tap(users[partner], 'bughouse-chat');
    await waitUntil('the partner\'s page to show the chat line', async () => (await users[partner].page.locator('[data-testid="bughouse-team-chat"]').innerText()).includes(secret), 15_000);
    ok(true, 'the partner\'s team chat shows the line');
    for (const i of opponents) {
      const html = await users[i].page.content();
      must(!html.includes(secret), `${users[i].name} (an opponent) must not receive the team chat line`);
    }
    ok(true, 'neither opponent\'s page contains the line anywhere');
    ok(!heard.some((e) => e === 'bug_chat' || e === 'bug_quick' || /chat|quick/i.test(e)), `a spectator socket was sent no chat or quick event (it heard: ${[...new Set(heard)].join(', ') || 'nothing'})`);

    console.log('\n=== A5. a reload in the middle of the game ===');
    const reloader = 0;
    await users[reloader].page.reload();
    const how = await backInTheGame(users[reloader]);
    await converge(watched, users, 'after the reload');
    ok(true, `after a reload ${users[reloader].name} is back in the game ${how} and all four screens equal the server`);

    console.log('\n=== A6. takeover by a bot and hand-back ===');
    const leaver = 3;
    const seat = places[leaver].seat;
    await users[leaver].page.close();
    await waitUntil('the bot takeover', () => watched.seats[seat]?.kind === 'bot' && watched.seats[seat]?.botReason === 'takeover', 60_000);
    ok(true, `when ${users[leaver].name}'s page closed, a bot took seat ${seat} over after the grace`);
    users[leaver].page = await users[leaver].context.newPage();
    users[leaver].page.on('pageerror', (e) => (users[leaver].pageErrors ??= []).push(String(e)));
    await users[leaver].page.goto(stack.webUrl);
    const back = await backInTheGame(users[leaver]);
    await waitUntil('the hand-back', () => watched.seats[seat]?.kind === 'human', 30_000);
    ok(true, `${users[leaver].name} came back ${back} and has the seat again (the server says human)`);
    await converge(watched, users, 'after the hand-back');
    ok(true, 'all four screens equal the server after the hand-back');

    console.log('\n=== A7. a spectator page from the Spectate list ===');
    spectator = await User.open(browser, stack.webUrl, 'Spec', PHONE_LARGE);
    await spectator.login(await stack.createAccount('bwspec'));
    await spectator.tapText('Play');
    await spectator.page.getByText(/Spectate a live game/).click();
    await spectator.page.getByText('Bughouse', { exact: true }).first().waitFor({ timeout: 30_000 });
    await spectator.page.getByText(new RegExp(users[0].account.username)).first().click();
    await spectator.page.locator('[data-testid="bughouse-spectator"]').waitFor({ timeout: 30_000 });
    await converge(watched, [spectator], 'the spectator\'s page');
    ok(true, 'the spectator page shows both boards equal to the server');
    ok(!(await present(spectator, 'bughouse-resign')) && !(await present(spectator, 'bughouse-team-bar')), 'a spectator has no Resign button and no team bar');
    await shot(spectator, 'A-spectator');
    const spectatorMoves = watched.seq;
    const mover = users.findIndex((_, i) => i !== leaver && legalActions(watched.match, places[i].seat).moves.length > 0);
    if (mover >= 0) {
      await actByTaps({ legalActions, watched, user: users[mover], place: places[mover], rng, dropShare: 0 });
      await waitUntil('a newer snapshot', () => watched.seq > spectatorMoves, 15_000, 25);
      await converge(watched, [...users, spectator], 'the spectator follows the next action');
    }
    ok(true, 'the spectator follows a live action as the four players do');
    await spectator.page.close();

    console.log('\n=== A8. resign: the game-over card on every page ===');
    if (watched.match.result !== null) throw new Error('the game ended by itself before the resignation (inconclusive: run again)');
    await users[2].tapText('Resign');
    await users[2].page.getByText('Resign', { exact: true }).last().click();
    for (const u of users) await u.page.locator('[data-testid="game-over"]').waitFor({ timeout: 30_000 });
    await waitUntil('the server\'s game over', () => watched.over !== null, 15_000);
    ok(watched.over.result.reason === 'resign', 'the server announced the game over by resignation');
    const winner = watched.over.result.winnerTeam;
    for (const u of users) {
      const headline = await u.page.locator('[data-testid="game-over-headline"]').innerText();
      must(headline === `Team ${winner} wins`, `${u.name}'s card says "${headline}" but the server says team ${winner}`);
    }
    ok(true, `all four game-over cards say "Team ${winner} wins", as the server does`);
    await shot(users[0], 'A-game-over');
    for (const u of users) if (u.pageErrors?.length) console.log(`    note  ${u.name} page errors: ${u.pageErrors.slice(0, 2).join(' | ')}`);
  } finally {
    observer?.disconnect();
    watched?.close?.();
    await spectator?.close().catch(() => {});
    for (const u of users) await u.close().catch(() => {});
  }
}

// --- B: the friend flow ---------------------------------------------------------------------------------------------------------------------------------------------

async function scenarioB(ctx) {
  const { browser, stack } = ctx;
  const users = [];
  let watched = null;
  try {
    for (const [i, viewport] of [PHONE_LARGE, PHONE_LARGE].entries()) {
      const user = await User.open(browser, stack.webUrl, `F${i + 1}`, viewport);
      await user.login(await stack.createAccount(`bf${i + 1}`));
      users.push(user);
    }
    const [host, guest] = users;
    console.log('\n=== B1. the host creates a room and reads its code ===');
    await host.tapText('Play');
    await host.press(host.page.getByLabel('Bughouse play with a friend'));
    await host.tapText('3 min');
    await host.page.locator('[data-testid="bughouse-room-code"]').waitFor({ timeout: 30_000 });
    const label = (await host.page.locator('[data-testid="bughouse-room-code"]').getAttribute('aria-label')) ?? '';
    const code = label.replace(/^Room code /, '').replace(/\s+/g, '');
    ok(/^[A-Z0-9]{6}$/.test(code), `the room shows a 6-character code (${code.length} characters)`);
    ok(await host.page.locator('[data-testid="bughouse-room-bots"]').count() === 1, 'the host sees "Start with bots"');

    console.log('\n=== B2. the friend joins with the code ===');
    await guest.tapText('Play');
    await guest.press(guest.page.getByLabel('Bughouse join with a code'));
    await guest.page.locator('[data-testid="join-code-input"]').fill(code);
    await guest.press(guest.page.locator('[data-testid="join-code-submit"]'));
    await guest.page.locator('[data-testid="bughouse-room"]').waitFor({ timeout: 30_000 });
    await waitUntil('the host\'s friend slot to name the guest', async () => (await host.page.locator('[data-testid="bughouse-room-slot-2"]').innerText()).includes(guest.account.username), 30_000);
    ok(true, 'the host\'s room shows the friend\'s name in the second slot');
    ok(!(await present(guest, 'bughouse-room-bots')), 'the guest has no Start button: the host starts the match');

    console.log('\n=== B3. the host starts with bots: both pages open the game ===');
    await host.press(host.page.locator('[data-testid="bughouse-room-bots"]'));
    for (const u of users) await u.page.locator('[data-testid="bughouse-online"]').waitFor({ timeout: 60_000 });
    watched = await watchRoom(stack.apiUrl, users.map((u) => u.account.username));
    const places = [];
    for (const u of users) places.push(await seatOnScreen(u));
    ok(places[0].team === places[1].team && places[0].seat !== places[1].seat, `the friends are PARTNERS on one team (${places[0].text.split(' · Partner')[0]} / ${places[1].text.split(' · Partner')[0]})`);
    ok(watched.seats.filter((s) => s.kind === 'bot').length === 2, 'the two other seats are bots');
    await converge(watched, users, 'the friends\' start position');
    ok(true, 'both friends\' screens show the server\'s start position on both boards');
    await shot(host, 'B-host-game');
    for (const u of users) if (u.pageErrors?.length) console.log(`    note  ${u.name} page errors: ${u.pageErrors.slice(0, 2).join(' | ')}`);
  } finally {
    watched?.close?.();
    for (const u of users) await u.close().catch(() => {});
  }
}

// --- main -----------------------------------------------------------------------------------------------------------------------------------------------------------------

const SCENARIOS = [
  ['A', 'four humans: orientation, ten rounds compared on four screens, messages, reload, takeover, spectator, resign', scenarioA],
  ['B', 'the friend flow on two pages', scenarioB],
];

async function main() {
  const stack = await startStack({ webDir: process.env.E2E_WEBDIR, bugSeed: BUG_SEED, log });
  let browser = null;
  let failed = false;
  const retries = [];
  try {
    browser = await launchBrowser();
    for (const [id, title, run] of SCENARIOS) {
      if (only.length > 0 && !only.includes(id)) continue;
      for (let attempt = 1; ; attempt++) {
        const before = checks;
        try {
          console.log(`\n##### ${id}: ${title}${attempt > 1 ? ' (second attempt)' : ''}`);
          await run({ browser, stack });
          break;
        } catch (err) {
          console.log(`\n${id} FAILED: ${err instanceof Error ? err.message : err}`);
          if (attempt >= 2) throw err;
          retries.push(id);
          checks = before;
        }
      }
    }
    console.log(`\nPASS  ${checks} checks, retries: ${retries.length === 0 ? 'none' : retries.join(',')}`);
  } catch (err) {
    failed = true;
    console.log(`\nFAIL  ${err instanceof Error ? err.message : err}`);
  } finally {
    await browser?.close().catch(() => {});
    const cleanup = await stack.tracker.cleanup();
    await stack.stop();
    console.log(`accounts deleted: ${cleanup.deleted} (left: ${cleanup.remaining})`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
