/**
 * Driving the REAL app in a real browser (Playwright over the system Chrome - no browser download): one browser context per user, so each has its own storage and its own
 * login. Everything a user does goes through the UI: log in, pick the game and the time control, tap squares, resign, reload. Nothing talks to the server over a socket from
 * here - that is truth.mjs's job (a spectator), and it is only ever read.
 */
import { chromium } from 'playwright-core';
import { sleep } from './stack.mjs';
import { SQUARE8, expectedPieceLabel } from './truth.mjs';

export const PHONE_SMALL = { width: 360, height: 640 };
export const PHONE_LARGE = { width: 412, height: 915 };

export async function launchBrowser() {
  return chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL || 'chrome', headless: process.env.E2E_HEADED !== '1' });
}

/** A user: a context (own storage), a page, and helpers bound to them. */
export class User {
  constructor(name, context, page, webUrl, touch = false) {
    this.name = name;
    this.context = context;
    this.page = page;
    this.webUrl = webUrl;
    this.account = null;
    this.touch = touch;
    /** What this page sent to the server and what it was told, counted by event name (filled by `watchSocket`). */
    this.socketLog = { sent: {}, received: {}, rewritten: 0 };
  }

  /** `touch`: an emulated phone (touch events, a mobile user agent): every tap is a real touch, not a mouse click. */
  static async open(browser, webUrl, name, viewport = PHONE_LARGE, { touch = false, socketWatch = null } = {}) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, ...(touch ? { hasTouch: true, isMobile: true } : {}) });
    // A recorder in every page: each time a "+N", the king-attacked pill or the promotion marker APPEARS it is logged, so a test can ask afterwards "did this screen ever
    // show +3 at seat 1?" without racing the 1.8 s the indicator stays.
    await context.addInitScript(() => {
      window.__seen = [];
      const interesting = /^(gain-\d|king-attacked-pill|promotion-burst)$/;
      const scan = (node) => {
        if (!(node instanceof Element)) return;
        for (const el of [node, ...node.querySelectorAll('[data-testid]')]) {
          const id = el.getAttribute('data-testid');
          if (id && interesting.test(id)) window.__seen.push(`${id}=${el.textContent}`);
        }
      };
      // A "+N" can also CHANGE in place: the hook keeps a seat's "+1" on screen while the next position (bots move fast) brings that seat a "+5", and React rewrites the text of
      // the same element. So text changes count as the indicator appearing too (read off the nearest element that has a test id).
      const last = {};
      const rescan = (record) => {
        record.addedNodes.forEach((node) => {
          scan(node);
          if (node instanceof Element) for (const el of [node, ...node.querySelectorAll('[data-testid]')]) last[el.getAttribute('data-testid')] = el.textContent;
        });
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        const owner = target?.closest('[data-testid]');
        const id = owner?.getAttribute('data-testid');
        if (owner && id && interesting.test(id) && last[id] !== owner.textContent) {
          last[id] = owner.textContent;
          window.__seen.push(`${id}=${owner.textContent}`);
        }
      };
      new MutationObserver((records) => records.forEach(rescan)).observe(document, { childList: true, subtree: true, characterData: true });
    });
    const user = new User(name, context, null, webUrl, touch);
    // Playwright wraps the page's WebSocket constructor with an init script, which only applies to documents loaded AFTER the route exists: it has to be installed before the first goto.
    if (socketWatch) await user.watchSocket(socketWatch);
    const page = await context.newPage();
    user.page = page;
    page.on('pageerror', (e) => (user.pageErrors ??= []).push(String(e)));
    await page.goto(webUrl);
    await page.getByText('Play', { exact: true }).first().waitFor({ timeout: 60_000 });
    return user;
  }

  text(label, options = {}) {
    return this.page.getByText(label, { exact: true, ...options });
  }

  /** A press on a locator: a touch tap on a touch user, a mouse click otherwise. */
  async press(locator) {
    if (this.touch) await locator.tap();
    else await locator.click();
  }

  async tapText(label) {
    await this.press(this.text(label).last());
  }

  /** Logs in through the Log In screen: Play -> Chaturaji online -> "Log in" in the dialog -> the form. */
  async login(account) {
    this.account = account;
    await this.tapText('Play');
    await this.press(this.page.getByLabel('Chaturaji online'));
    await this.tapText('Log in / Sign up');
    await this.page.getByPlaceholder('Email').fill(account.email);
    await this.page.getByPlaceholder('Password').fill(account.password);
    await this.press(this.text('Log In').last());
    await this.page.getByText('Log In', { exact: true }).first().waitFor({ state: 'detached', timeout: 20_000 });
  }

  /** From the main menu: Play -> the variant's Online button -> a time control (by its label, e.g. "10 min"). */
  async queue(variantLabel, timeControl) {
    await this.tapText('Play');
    const online = { chaturaji: 'Chaturaji online' }[variantLabel];
    if (online) await this.press(this.page.getByLabel(online));
    else {
      // the 4 Player cards have no aria-label on their Online buttons: the nearest ancestor of the card's title that holds an "Online" button is the card itself
      const card = this.page.locator(`xpath=//*[normalize-space(text())="${variantLabel}"]/ancestor::div[.//*[normalize-space(text())="Online"]][1]`).first();
      await this.press(card.getByText('Online', { exact: true }));
    }
    await this.tapText(timeControl);
  }

  /** The result card of a finished game: { scores: [n, n, n, n] (as shown), details: { seat: "9 points - 6 from play + 3 for 1 king left" }, text }. Null while there is none. */
  async resultCard() {
    return this.page.evaluate(() => {
      const card = document.querySelector('[data-testid="result-card"]');
      if (!card) return null;
      const scores = [0, 1, 2, 3].map((seat) => card.querySelector(`[data-testid="result-score-${seat}"]`)?.textContent ?? null);
      const details = {};
      for (let seat = 0; seat < 4; seat++) {
        const el = card.querySelector(`[data-testid="result-detail-${seat}"]`);
        if (el) details[seat] = el.textContent;
      }
      return { scores, details, text: card.innerText.replace(/\n/g, ' | ') };
    });
  }

  /** The board, square by square, as the screen labels it: { a1: "a1, Red boat", ... } - empty squares are just the name. */
  async board() {
    return this.page.$$eval('[aria-label]', (els) => {
      const out = {};
      for (const el of els) {
        const label = el.getAttribute('aria-label') ?? '';
        const m = /^([a-h][1-8])(,|$)/.exec(label);
        if (m) out[m[1]] = label;
      }
      return out;
    });
  }

  async hasBoard() {
    return (await this.page.getByLabel('Chaturaji board').count()) > 0;
  }

  /** Compares the screen with an engine state: every one of the 64 squares. Returns the list of squares that disagree. */
  async boardMismatches(state) {
    const cells = await this.board();
    const bad = [];
    for (let square = 0; square < 64; square++) {
      const name = SQUARE8.squareName(square);
      const want = expectedPieceLabel(state, square);
      const got = cells[name];
      if (got === undefined || !(got === want || got.startsWith(want + ','))) bad.push({ square: name, want, got });
    }
    return bad;
  }

  /** The seat cards' text, by seat: "Red | 3 | 9:21 | Ana (you) | +1". */
  async seatCards() {
    return this.page.$$eval('[data-testid^="seat-"]', (els) => els.filter((e) => /^seat-\d$/.test(e.getAttribute('data-testid') ?? '')).map((e) => e.innerText.replace(/\n/g, ' | ')));
  }

  async gains() {
    return this.page.$$eval('[data-testid^="gain-"]', (els) => els.map((e) => `${e.getAttribute('data-testid')}=${e.textContent}`));
  }

  async statusLine() {
    return this.page.evaluate(() => {
      const pill = document.querySelector('[data-testid="king-attacked-pill"]');
      if (pill) return pill.textContent;
      const hit = [...document.querySelectorAll('div,span')].filter((e) => e.childElementCount === 0).map((e) => e.textContent.trim()).find((t) => /^(Your move|Game over|Game abandoned)|to move|is thinking|is offline/.test(t));
      return hit ?? '';
    });
  }

  /** Taps a square with a real mouse click at its centre. The board is drawn as Red-at-the-bottom unless rotated; labels are by square, so this is by name. */
  async tapSquare(name) {
    const cell = this.page.locator(`[aria-label^="${name},"], [aria-label="${name}"]`).first();
    const box = await cell.boundingBox();
    if (!box) throw new Error(`${this.name}: square ${name} is not on screen`);
    if (this.touch) await this.page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    else await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(60);
  }

  /**
   * Sits between this page and the server: counts what the page SENDS by event name (`socketLog.sent`) and, when `rewriteMatchVariant` is given, rewrites the `variant` of the
   * `four_match_found` the server sends to the page - the way to show the page a server that answers with another game than the one asked for (D15). Installed by `open` (the
   * `socketWatch` option), before the page's first load.
   */
  async watchSocket({ rewriteMatchVariant } = {}) {
    await this.context.routeWebSocket('**/socket.io/**', (ws) => {
      this.socketLog.connections = (this.socketLog.connections ?? 0) + 1;
      const server = ws.connectToServer();
      ws.onMessage((message) => {
        if (typeof message === 'string' && message.startsWith('42')) {
          const m = /^42\d*\["([a-z_]+)"/.exec(message);
          if (m) this.socketLog.sent[m[1]] = (this.socketLog.sent[m[1]] ?? 0) + 1;
        }
        server.send(message);
      });
      server.onMessage((message) => {
        const got = typeof message === 'string' ? /^42\d*\["([a-z_]+)"/.exec(message) : null;
        if (got) this.socketLog.received[got[1]] = (this.socketLog.received[got[1]] ?? 0) + 1;
        if (rewriteMatchVariant && typeof message === 'string' && message.startsWith('42["four_match_found"')) {
          const body = JSON.parse(message.slice(2));
          body[1] = { ...body[1], variant: rewriteMatchVariant };
          this.socketLog.rewritten++;
          ws.send(`42${JSON.stringify(body)}`);
        } else ws.send(message);
      });
    });
  }

  async offeredSquares() {
    return this.page.$$eval('[aria-label*="can move here"]', (els) => els.map((e) => /^([a-h][1-8])/.exec(e.getAttribute('aria-label'))?.[1]).filter(Boolean).sort());
  }

  /** Leaves the game through the header's "‹ Menu" and its confirmation (the seat is kept for the grace period, then a bot takes it). */
  async leaveGame() {
    await this.text('‹ Menu').last().click();
    await this.tapText('Leave');
  }

  /** From the Play menu: the "Return to your game ›" link that appears under the card of the game that was left. */
  async returnToGame() {
    await this.page.getByText(/Return to your game/).first().click();
  }

  /** Resigns through the Resign button and its confirmation dialog. */
  async resign() {
    await this.tapText('Resign');
    await this.page.getByText('Resign', { exact: true }).last().click();
  }

  /** Opens the Spectate list from the Play menu and the first game under the Chaturaji header whose row names `playerName`. */
  async spectate(playerName) {
    await this.tapText('Play');
    await this.page.getByText(/Spectate a live game/).click();
    await this.page.getByText('Chaturaji', { exact: true }).first().waitFor({ timeout: 20_000 });
    await this.page.getByText(new RegExp(playerName)).first().click();
    await this.page.getByLabel('Chaturaji board').waitFor({ timeout: 30_000 });
  }

  /** A fresh page in the same browser context (same login and storage): "the user closed the tab and came back". */
  async reopen() {
    await this.page.close();
    this.page = await this.context.newPage();
    this.page.on('pageerror', (e) => (this.pageErrors ??= []).push(String(e)));
    await this.page.goto(this.webUrl);
  }

  /** How the screen fits the viewport: horizontal overflow, the board and the seat cards inside it, any clipped text in a card. */
  async layout() {
    return this.page.evaluate(() => {
      const inner = { w: window.innerWidth, h: window.innerHeight };
      const rect = (el) => {
        const r = el.getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) };
      };
      const board = document.querySelector('[aria-label="Chaturaji board"]');
      const cards = [...document.querySelectorAll('[data-testid^="seat-"]')].filter((e) => /^seat-\d$/.test(e.getAttribute('data-testid') ?? ''));
      // text cut off inside a card: a player name shortened with an ellipsis is by design ("shortened"); anything else - points, clock, a status - cut off is a problem ("clipped")
      const clipped = [];
      const shortened = [];
      for (const card of cards) {
        for (const el of card.querySelectorAll('*')) {
          if (el.childElementCount > 0 || el.scrollWidth <= el.clientWidth + 1) continue;
          const style = getComputedStyle(el);
          const entry = `${card.getAttribute('data-testid')}: "${el.textContent}"`;
          if (style.textOverflow === 'ellipsis') shortened.push(entry);
          else if (style.overflow !== 'visible') clipped.push(entry);
        }
      }
      return {
        shortened,
        inner,
        overflowX: document.documentElement.scrollWidth - inner.w,
        board: board ? rect(board) : null,
        cell: board ? Math.round(board.getBoundingClientRect().width / 8) : null,
        cards: cards.map(rect),
        clipped,
      };
    });
  }

  /** Everything the recorder has seen appear so far, in order. */
  async seen() {
    return this.page.evaluate(() => [...(window.__seen ?? [])]);
  }

  async screenshot(path) {
    await this.page.screenshot({ path });
  }

  async close() {
    await this.context.close();
  }
}
