/**
 * Bughouse ONLINE - team chat (`bug_chat`, Q1) and quick messages (`bug_quick`, B14 / Q7 / HP10): who receives what, and the limits (src/game/bughouseRooms.ts, workstream W2).
 *
 *   npm run test:bughouseMessages        (tsx; no server, no database; an injected clock - the limits are checked to the millisecond)
 *
 * THE ISOLATION PROOF. The stub `io` records EVERY event sent to EVERY socket in the order it was sent. Each scenario sends a message and then inspects ALL of them: the only events that
 * exist anywhere are the ones the partner (and, for chat, the sender's own echo) received - an opponent, a spectator or a stranger has no event of any kind. The recipients are computed by the
 * server from the seat map: a payload that names recipients is ignored.
 */
import assert from 'node:assert/strict';
import { BUG_CHAT_MIN_INTERVAL_MS, BUG_QUICK_DUPLICATE_MS, BUG_QUICK_MIN_INTERVAL_MS, BUG_QUICK_WINDOW_MAX, BUG_QUICK_WINDOW_MS } from '../src/game/bughouseConfig.ts';
import * as E from '../src/game/bughouse/index.ts';
import { disposeAll, eventsOf, newGame } from './bughouse-test-kit.mjs';

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ok  ${message}`);
}
const same = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message);
  passed++;
  console.log(`  ok  ${message}`);
};

/** Every socket that may exist in these scenarios, so "nobody else" is a statement about all of them. */
const ALL_SOCKETS = ['S0', 'S1', 'S2', 'S3', 'S3.1', 'W1', 'W2', 'X9'];
const PARTNER = { 0: 3, 1: 2, 2: 1, 3: 0 };
const sockets = (g) => [...new Set(g.io.events.map((e) => e.id))].sort();

/** A room with four humans, two spectators and a stranger socket that sits nowhere. */
function table(options = {}) {
  const g = newGame(options);
  g.mgr.spectate('W1', { roomId: g.id });
  g.mgr.spectate('W2', { roomId: g.id });
  g.clear();
  return g;
}

console.log('\n=== 0. The numbers ===');
{
  check(BUG_CHAT_MIN_INTERVAL_MS === 1000, 'a seat may send one chat line per second');
  check(BUG_QUICK_MIN_INTERVAL_MS === 1500 && BUG_QUICK_WINDOW_MS === 10_000 && BUG_QUICK_WINDOW_MAX === 8 && BUG_QUICK_DUPLICATE_MS === 1000, 'quick messages: 1 per 1.5 s, 8 per 10 s, the same code not within 1 s');
  check(E.BUG_QUICK_CODE_COUNT === 10 && E.BUG_CHAT_MAX_LENGTH === 500, 'ten codes (0-9); a chat line is cut at 500 characters');
}

console.log('\n=== 1. Team chat reaches the sender (echo) and the partner - and nobody else ===');
for (const seat of [0, 1, 2, 3]) {
  const g = table();
  const ack = g.chat(seat, `hello from ${seat}`);
  const partner = PARTNER[seat];
  check(ack.ok === true && ack.delivered === true, `seat ${seat} sends a line: ok, delivered`);
  same(sockets(g), [`S${seat}`, `S${partner}`].sort(), `seat ${seat}: the only sockets that received ANYTHING are the sender and its partner (seat ${partner})`);
  same(g.io.events.map((e) => e.event), ['bug_chat_from', 'bug_chat_from'], '...one bug_chat_from each, no other event of any kind');
  same(eventsOf(g.io, 'bug_chat_from', `S${partner}`)[0].payload, { seat, name: `P${seat}`, text: `hello from ${seat}` }, '...the partner receives { seat, name, text } and nothing more');
  same(eventsOf(g.io, 'bug_chat_from', `S${seat}`)[0].payload, eventsOf(g.io, 'bug_chat_from', `S${partner}`)[0].payload, '...and the sender\'s echo is the same line');
  disposeAll();
}

console.log('\n=== 2. A payload that names recipients changes nothing ===');
{
  const g = table();
  const ack = g.chat(0, 'secret', { recipients: [1, 2], to: 'S1', toSeat: 1, seat: 2, from: 3, room: 'x', broadcast: true, spectators: true, partner: 1 });
  check(ack.ok === true, 'the extra fields do not make the request invalid');
  same(sockets(g), ['S0', 'S3'], '...and the line still goes to seat 0 and its partner (seat 3) only');
  same(eventsOf(g.io, 'bug_chat_from', 'S3')[0].payload, { seat: 0, name: 'P0', text: 'secret' }, '...as seat 0, whatever the payload said');
  disposeAll();
}

console.log('\n=== 3. Spectators and strangers cannot send; nothing is delivered ===');
{
  const g = table();
  for (const socket of ['W1', 'X9']) {
    const chat = g.mgr.sendChat(socket, { roomId: g.id, text: 'let me in' });
    const quick = g.mgr.sendQuick(socket, { roomId: g.id, code: 3 });
    check(chat.ok === false && chat.reason === 'noGame' && quick.ok === false && quick.reason === 'noGame', `${socket}: chat and quick message are refused with noGame`);
  }
  check(g.io.events.length === 0, 'nothing was delivered to anyone');
  disposeAll();
}

console.log('\n=== 4. Content: trimmed, cut at 500, empty and non-text refused ===');
{
  const g = table();
  g.chat(0, '   padded   ');
  same(eventsOf(g.io, 'bug_chat_from', 'S3')[0].payload.text, 'padded', 'a line is trimmed');
  g.clock.jump(1000);
  g.chat(0, 'x'.repeat(501));
  check(eventsOf(g.io, 'bug_chat_from', 'S3')[1].payload.text === 'x'.repeat(500), 'a line over 500 characters is cut to 500 (like the other chats), not refused');
  g.clock.jump(1000);
  g.clear();
  for (const bad of ['', '   ', '\n\t', undefined, null, 5, {}, [], true]) {
    const ack = g.mgr.sendChat('S0', { roomId: g.id, text: bad });
    assert.ok(ack.ok === false && ack.reason === 'invalidRequest', `text ${JSON.stringify(bad)} must be refused`);
  }
  passed++;
  console.log('  ok  empty, blank and non-string text is refused (invalidRequest) and delivers nothing');
  check(g.io.events.length === 0, '...nothing was sent');
  disposeAll();
}

console.log('\n=== 5. A bot partner: not delivered, the sender is told, nothing is counted ===');
{
  const g = table({ kinds: ['human', 'human', 'human', 'bot'] });
  const chat = g.chat(0, 'hi bot');
  const quick = g.quick(0, 4);
  check(chat.ok === false && chat.reason === 'partnerIsBot' && quick.ok === false && quick.reason === 'partnerIsBot', 'seat 0\'s partner (seat 3) is a bot: both are refused with partnerIsBot (the sender is told)');
  check(g.io.events.length === 0, '...and not even the sender got an echo; nobody received anything');
  const other = g.chat(1, 'hi partner');
  check(other.ok === true && sockets(g).join() === 'S1,S2', 'a pair whose partner is human is not affected');
  disposeAll();
}
{
  // a refusal for a bot partner uses no rate budget: when the partner turns human the same instant works
  const g = table();
  g.disconnect(3);
  g.clock.advance(45000); // seat 3 is a bot now
  check(g.chat(0, 'anyone there').reason === 'partnerIsBot' && g.quick(0, 1).reason === 'partnerIsBot', 'a taken-over partner is a bot: refused, told');
  const ack = g.rejoin(3);
  check(ack.ok === true, 'the human returns on a new socket (S3.1)');
  g.clear(); // (the seat update of the rejoin went to everyone, as it should; what follows is only the messages)
  const chat = g.chat(0, 'welcome back');
  const quick = g.quick(0, 1);
  check(chat.ok === true && chat.delivered === true && quick.ok === true && quick.delivered === true, 'seat 0 can chat and send a quick message at the very same instant: the refusals above used up nothing');
  same(sockets(g), ['S0', 'S3.1'], 'the line went to the sender and the NEW socket only, not the old S3, an opponent or a spectator');
  check(eventsOf(g.io, 'bug_chat_from', 'S3').length === 0 && eventsOf(g.io, 'bug_quick_from', 'S3').length === 0, '...nothing reached the replaced socket');
  disposeAll();
}

console.log('\n=== 6. A partner who is human but not connected: the line is gone, the sender is told ===');
{
  const g = table();
  g.disconnect(3);
  g.clear();
  const chat = g.chat(0, 'are you there');
  const quick = g.quick(0, 2);
  check(chat.ok === true && chat.delivered === false && quick.ok === true && quick.delivered === false, 'delivered:false for both (nothing is stored for later)');
  same(sockets(g), ['S0'], '...only the sender\'s echo of the chat line exists, no other event anywhere');
  disposeAll();
}

console.log('\n=== 7. Quick messages: partner only, no echo, the code and nothing else ===');
for (const seat of [0, 1, 2, 3]) {
  const g = table();
  const ack = g.quick(seat, 7, { text: 'free text', recipients: [0, 1, 2, 3], to: 'S0' });
  const partner = PARTNER[seat];
  check(ack.ok === true && ack.delivered === true, `seat ${seat} sends code 7: ok, delivered`);
  same(sockets(g), [`S${partner}`], `seat ${seat}: ONLY seat ${partner} (its partner) has any event - no echo to the sender, nothing for opponents, spectators or strangers`);
  same(g.io.events.map((e) => [e.event, e.payload]), [['bug_quick_from', { seat, code: 7 }]], '...one bug_quick_from carrying exactly { seat, code }');
  disposeAll();
}

console.log('\n=== 8. Quick message codes: 0-9 only ===');
{
  const g = table();
  const accepted = [];
  for (let code = 0; code <= 9; code++) {
    g.clock.jump(1500);
    accepted.push(g.quick(0, code).ok);
  }
  check(accepted.every(Boolean), 'all ten codes 0..9 are accepted');
  same(eventsOf(g.io, 'bug_quick_from', 'S3').map((e) => e.payload.code), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], '...and arrive as sent, in order');
  g.clear();
  g.clock.jump(1500);
  for (const bad of [-1, 10, 99, 1.5, NaN, Infinity, '3', '', 'hello', null, undefined, true, [], {}, [3]]) {
    const ack = g.mgr.sendQuick('S0', { roomId: g.id, code: bad });
    assert.ok(ack.ok === false && ack.reason === 'invalidRequest', `code ${JSON.stringify(bad)} must be refused`);
  }
  passed++;
  console.log('  ok  -1, 10, fractions, NaN, Infinity, numeric strings, text and everything else is refused (invalidRequest)');
  check(g.io.events.length === 0, '...nothing was delivered');
  disposeAll();
}

console.log('\n=== 9. The chat limit: one line per second per seat, exact ===');
{
  const g = table();
  check(g.chat(0, 'one').ok === true, 'a line at t = 0');
  g.clock.jump(999);
  const early = g.chat(0, 'two');
  check(early.ok === false && early.reason === 'rateLimited', '999 ms later the next line is refused (rateLimited)');
  g.clock.jump(1);
  check(g.chat(0, 'three').ok === true, 'at exactly 1000 ms it is accepted: the refused attempt did not move the window');
  g.clock.jump(999);
  check(g.chat(0, 'four').ok === false, 'and 999 ms after THAT it is refused again');
  check(g.chat(1, 'other seat').ok === true, 'the limit is per seat: seat 1 is not affected');
  same(eventsOf(g.io, 'bug_chat_from', 'S3').map((e) => e.payload.text), ['one', 'three'], 'only the accepted lines were delivered');
  disposeAll();
}

console.log('\n=== 10. The quick-message limits: 1 per 1.5 s, the same code not within 1 s, exact ===');
{
  const g = table();
  check(g.quick(0, 3).ok === true, 'a message at t = 0');
  g.clock.jump(1499);
  const early = g.quick(0, 4);
  check(early.ok === false && early.reason === 'rateLimited', '1499 ms later a DIFFERENT code is refused (rateLimited)');
  const g2 = table();
  g2.quick(0, 3);
  g2.clock.jump(500);
  const different = g2.quick(0, 4);
  check(different.ok === false && different.reason === 'rateLimited', '500 ms later a DIFFERENT code is rateLimited, not a duplicate (a duplicate is the SAME code)');
  g.clock.jump(1);
  check(g.quick(0, 4).ok === true, 'at exactly 1500 ms it is accepted (the refused attempt counted for nothing)');
  disposeAll();
}
{
  const g = table();
  g.quick(0, 5);
  g.clock.jump(999);
  const dup = g.quick(0, 5);
  check(dup.ok === false && dup.reason === 'duplicate', 'the same code 999 ms later is a duplicate');
  g.clock.jump(1);
  const slow = g.quick(0, 5);
  check(slow.ok === false && slow.reason === 'rateLimited', 'at exactly 1000 ms it is no longer a duplicate - but the 1.5 s interval still refuses it (rateLimited)');
  g.clock.jump(500);
  check(g.quick(0, 5).ok === true, 'at 1500 ms the same code is accepted');
  check(g.quick(1, 5).ok === true, 'seat 1 (another pair) is not affected by seat 0\'s limits');
  same(eventsOf(g.io, 'bug_quick_from', 'S3').map((e) => e.payload.code), [5, 5], 'only the two accepted messages reached seat 3');
  disposeAll();
}
{
  // the 8-per-10-seconds window: with messages 1.5 s apart at most 7 fit in 10 s, so the window cannot be what refuses a well-behaved sender - proven here, and the window's own
  // check is exercised on a seat whose log is filled directly (white-box).
  let most = 0;
  for (let first = 0; first < 1500; first += 100) {
    let n = 0;
    for (let t = first; t < first + BUG_QUICK_WINDOW_MS; t += BUG_QUICK_MIN_INTERVAL_MS) n++;
    most = Math.max(most, n);
  }
  check(most === 7 && most < BUG_QUICK_WINDOW_MAX, 'messages 1.5 s apart: at most 7 fit in any 10 s, so the 8-per-10-s limit is a second line of defence behind the 1.5 s interval');
  const g = table();
  const now = g.clock.now();
  g.room().seats[0].quickLog = Array.from({ length: 8 }, (_, i) => ({ at: now - 9999 + i, code: 1 }));
  g.clock.jump(0);
  const full = g.quick(0, 2);
  check(full.ok === false && full.reason === 'rateLimited' && g.io.events.length === 0, 'with 8 accepted messages inside the last 10 s the window refuses the ninth (rateLimited)');
  g.room().seats[0].quickLog = Array.from({ length: 8 }, () => ({ at: now - 10000, code: 1 }));
  const aged = g.quick(0, 2);
  check(aged.ok === true, 'messages exactly 10 s old are out of the window');
  disposeAll();
}

console.log('\n=== 11. Takeover mid-conversation, and nothing is kept for later ===');
{
  const g = table();
  g.chat(0, 'before');
  g.clock.jump(1000);
  g.disconnect(3);
  g.clock.advance(45000);
  check(g.chat(0, 'during').reason === 'partnerIsBot', 'seat 3 was taken over: the next line is refused');
  g.rejoin(3);
  g.clear();
  g.clock.jump(1000);
  check(g.chat(0, 'after').ok === true && sockets(g).join() === 'S0,S3.1', 'seat 3 is back: chat works, to the new socket');
  const rejoin = g.mgr.rejoin('Z', { roomId: g.id, playerToken: g.tokens[1] });
  const spectate = g.mgr.spectate('W3', { roomId: g.id });
  const dump = JSON.stringify([rejoin, spectate]);
  check(!['before', 'during', 'after', 'welcome'].some((word) => dump.includes(word)), 'a rejoin answer and a spectate answer carry no chat history (nothing is stored)');
  disposeAll();
}

console.log('\n=== 12. Chat and quick messages never go through the shared broadcast ===');
{
  const g = table();
  g.mv(0, 'A', 'e2', 'e4');
  g.clear();
  g.clock.jump(1500);
  g.chat(0, 'x');
  g.quick(0, 1);
  const everyone = ALL_SOCKETS.filter((id) => eventsOf(g.io, 'bug_state', id).length > 0 || eventsOf(g.io, 'bug_seat_update', id).length > 0);
  check(everyone.length === 0, 'sending a message publishes no state and no seat update to anyone');
  disposeAll();
}

console.log(`\nALL ${passed} CHECKS PASSED`);
