#!/usr/bin/env node
/**
 * "Rejoin after the game ended" server-side regression suite - no running server needed. Run with tsx:
 *   npx tsx scripts/test-rejoin-finished.mjs      (or: npm run test:rejoinFinished)
 *
 * THE BUG: a player whose connection dropped while the game ended (checkmate, flag, resignation, or the very abandonment their absence
 * caused) reconnected to a room that no longer existed. rejoin_game answered "game not found", and the client sat on "Reconnecting..."
 * for ever. Now RoomManager keeps each finished room's RESULT for FINISHED_RETENTION_MS and rejoin hands it to anyone holding one of
 * that room's two player tokens.
 *
 *  1. THE RESULT: after resignation / checkmate / flag / agreed draw / abandonment, rejoin with either token returns
 *     { ok: false, finished: true, gameOver } - a REFUSAL that carries the result (see RejoinFinishedAck for why it is not ok: true) -
 *     with the same reason and winner the players were sent.
 *  2. NOTHING LEAKS OR ATTACHES: a wrong or missing token, another room's token and an unknown room all get "not found"; a socket that
 *     rejoined a finished game is not seated (cannot move, resign, offer a draw) and the old opponent is not told anyone reconnected.
 *  3. RETENTION: available through exactly FINISHED_RETENTION_MS, gone one millisecond later; the periodic sweep (not just a manual call)
 *     empties the store; many finished rooms do not accumulate.
 *  4. CONTROL: rejoining a game still in progress is unchanged (state, no `finished`), so the checks above can fail.
 *  5. OLD CLIENTS: app builds from before this existed only read ok / state (`if (ack.ok) ack.state.fen`). A finished-game answer must
 *     never look like a success to them, or they would throw inside the socket callback (a crash) instead of just staying on
 *     "Reconnecting..." as they always did.
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { FINISHED_RETENTION_MS, RoomManager } from '../src/game/rooms.ts';

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ok  ${message}`);
}

// Fake timers for setTimeout / setInterval / Date: the 45 s abandonment grace and the 5 minute retention then run instantly and
// deterministically, and Date.now() (used for finishedAt) moves with them.
mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });

function stubIo() {
  const events = [];
  return { events, to: (id) => ({ emit: (event, payload) => events.push({ id, event, payload }) }) };
}
function newRoom(timeControl = { initialSeconds: 60, incrementSeconds: 0 }) {
  const io = stubIo();
  const manager = new RoomManager(io);
  const created = manager.createRoom({
    white: { socketId: 'W', userId: null },
    black: { socketId: 'B', userId: null },
    timeControl,
    chess960: false,
    kingOfTheHill: false,
    threeCheck: false,
    setupChess: false,
    fogOfWar: false,
    giveaway: false,
    atomic: false,
    duckChess: false,
  });
  const move = (who, from, to, promotion) => manager.applyMove(who, { roomId: created.roomId, from, to, promotion });
  const rejoin = (socketId, token) => manager.rejoin(socketId, { roomId: created.roomId, playerToken: token });
  return { io, manager, created, move, rejoin };
}
const gameOvers = (io, id) => io.events.filter((e) => e.event === 'game_over' && e.id === id).map((e) => e.payload);

console.log('\n=== 1. A late rejoin gets the result, whichever way the game ended ===');
{
  // resignation
  const { io, manager, created, rejoin } = newRoom();
  check(manager.resign('W', created.roomId).ok, 'White resigns');
  const sent = gameOvers(io, 'B')[0];
  const w = rejoin('W2', created.whitePlayerToken);
  const b = rejoin('B2', created.blackPlayerToken);
  check(w.ok === false && w.finished === true && w.state === undefined, 'resignation: White (reconnecting later) gets { ok: false, finished: true, gameOver } and no live state');
  check(w.gameOver.reason === 'resignation' && w.gameOver.winner === 'b', "...with the reason and winner Black was sent ('resignation', 'b')");
  check(b.ok === false && b.finished === true && JSON.stringify(b.gameOver) === JSON.stringify(sent), "Black's token gets the very same payload the live game_over carried");
}
{
  // checkmate (fool's mate): Black mates
  const { io, created, move, rejoin } = newRoom();
  for (const [who, from, to] of [['W', 'f2', 'f3'], ['B', 'e7', 'e5'], ['W', 'g2', 'g4'], ['B', 'd8', 'h4']]) check(move(who, from, to).ok, `${who} plays ${from}${to}`);
  const r = rejoin('W2', created.whitePlayerToken);
  check(r.ok === false && r.finished === true && r.gameOver.reason === 'checkmate' && r.gameOver.winner === 'b', 'checkmate: the mated player learns they lost to checkmate');
  check(JSON.stringify(r.gameOver) === JSON.stringify(gameOvers(io, 'W')[0]), '...identical to what the live game_over said');
}
{
  // flag fall: White to move, 60 s clock
  const { created, rejoin } = newRoom({ initialSeconds: 60, incrementSeconds: 0 });
  mock.timers.tick(60_000);
  const r = rejoin('W2', created.whitePlayerToken);
  check(r.ok === false && r.finished === true && r.gameOver.reason === 'timeout' && r.gameOver.winner === 'b', 'flag: White (on move, clock expired) learns they lost on time');
}
{
  // agreed draw
  const { manager, created, rejoin } = newRoom();
  check(manager.offerDraw('W', created.roomId).ok && manager.respondToDraw('B', created.roomId, true).ok, 'a draw is offered and accepted');
  const r = rejoin('B2', created.blackPlayerToken);
  check(r.ok === false && r.finished === true && r.gameOver.reason === 'draw' && r.gameOver.winner === null, 'draw: winner is null');
}
{
  // THE motivating case: the player is offline when abandonment ends the game, then comes back
  const { io, manager, created, rejoin } = newRoom();
  manager.handleDisconnect('W');
  check(io.events.some((e) => e.id === 'B' && e.event === 'opponent_disconnected'), 'White disconnects; Black is told');
  mock.timers.tick(45_000);
  check(gameOvers(io, 'B')[0]?.reason === 'abandonment' && gameOvers(io, 'B')[0]?.winner === 'b', 'after the 45 s grace Black wins by abandonment');
  const r = rejoin('W2', created.whitePlayerToken);
  check(r.ok === false && r.finished === true && r.gameOver.reason === 'abandonment' && r.gameOver.winner === 'b', 'White reconnects afterwards and is told they lost by abandonment (not "game not found")');
}

console.log('\n=== 2. Nothing leaks, nothing attaches ===');
{
  const a = newRoom();
  const b = newRoom();
  a.manager.resign('W', a.created.roomId);
  b.manager.resign('W', b.created.roomId);
  const notFound = 'The game was not found or has already ended.';
  const leaks = (r) => r.finished !== undefined || r.gameOver !== undefined || r.state !== undefined;
  const wrong = a.rejoin('X', 'not-a-token');
  check(wrong.ok === false && wrong.error === notFound && !leaks(wrong), 'a wrong token gets "not found" and no result (a bare roomId reveals nothing)');
  const missing = a.rejoin('X', undefined);
  check(missing.ok === false && !leaks(missing), 'a missing token gets "not found" and no result');
  const foreign = a.rejoin('X', b.created.whitePlayerToken);
  check(foreign.ok === false && !leaks(foreign), "ANOTHER finished room's token does not open this room's result");
  const unknown = a.manager.rejoin('X', { roomId: 'no-such-room', playerToken: a.created.whitePlayerToken });
  check(unknown.ok === false && !leaks(unknown), 'an unknown room id gets "not found" and no result');

  a.io.events.length = 0;
  const ok = a.rejoin('W2', a.created.whitePlayerToken);
  check(ok.finished === true && ok.gameOver.reason === 'resignation', 'control: the right token does work');
  check(!a.manager.socketToRoom.has('W2') && !a.manager.socketToSpectatingRoom.has('W2'), 'the rejoining socket is registered NOWHERE (no seat, no spectator entry to leak)');
  check(!a.move('W2', 'e2', 'e4').ok, 'the rejoining socket is NOT seated: it cannot move');
  check(!a.manager.resign('W2', a.created.roomId).ok && !a.manager.offerDraw('W2', a.created.roomId).ok, '...cannot resign or offer a draw either');
  check(!a.io.events.some((e) => e.event === 'opponent_reconnected'), "...and the opponent is not told anyone reconnected");
  check(a.io.events.length === 0, 'a late rejoin emits nothing at all (the result travels in the ack)');
}

console.log('\n=== 3. Retention ===');
{
  const { manager, created, rejoin } = newRoom();
  manager.resign('W', created.roomId);
  mock.timers.tick(FINISHED_RETENTION_MS);
  check(rejoin('W2', created.whitePlayerToken).finished === true, `still available at exactly ${FINISHED_RETENTION_MS / 1000}s`);
  mock.timers.tick(1);
  const late = rejoin('W3', created.whitePlayerToken);
  check(late.ok === false && late.finished === undefined && late.error === 'The game was not found or has already ended.', 'one millisecond later it is gone: "not found" (the client then shows "no longer available")');
}
{
  const { manager, created } = newRoom();
  manager.resign('W', created.roomId);
  check(manager.finishedRooms.size === 1, 'a finished room leaves one record');
  mock.timers.tick(FINISHED_RETENTION_MS + 61_000); // past retention AND past one sweep interval
  check(manager.finishedRooms.size === 0, 'the periodic sweep (nobody called it) removed the record');
}
{
  const manager = new RoomManager(stubIo());
  const mk = (i) => manager.createRoom({ white: { socketId: `W${i}`, userId: null }, black: { socketId: `B${i}`, userId: null }, timeControl: { initialSeconds: 60, incrementSeconds: 0 }, chess960: false, kingOfTheHill: false, threeCheck: false, setupChess: false, fogOfWar: false, giveaway: false, atomic: false, duckChess: false });
  for (let i = 0; i < 50; i++) manager.resign(`W${i}`, mk(i).roomId);
  check(manager.finishedRooms.size === 50, '50 finished games leave 50 small records');
  check(manager.sweepFinishedRooms(Date.now()) === 0, 'a sweep right away removes none of them');
  check(manager.sweepFinishedRooms(Date.now() + FINISHED_RETENTION_MS + 1) === 50 && manager.finishedRooms.size === 0, 'a sweep after the retention removes all 50');
}

console.log('\n=== 4. Control: a game still in progress rejoins exactly as before ===');
{
  const { created, rejoin, move } = newRoom();
  move('W', 'e2', 'e4');
  const r = rejoin('W2', created.whitePlayerToken);
  check(r.ok && r.finished === undefined && r.gameOver === undefined, 'no `finished` / `gameOver` on a live rejoin');
  check(r.state.color === 'w' && r.state.turn === 'b' && r.state.moves.length === 1, '...it carries the live state (colour, turn, move list)');
  check(!rejoin('W2', 'bad-token').ok, 'and an invalid token on a live room is still refused');
}

console.log('\n=== 5. Old clients (released app builds) are not broken by a finished-game answer ===');
{
  // Exactly what OnlineGameScreen did before this change: it only knows ok / error / state.
  const legacyClientHandler = (ack) => {
    if (ack.ok) return `resumed at ${ack.state.fen}`; // would throw TypeError if ok were true without a state
    return `refused: ${ack.error}`;
  };
  const { manager, created } = newRoom();
  manager.resign('W', created.roomId);
  const ack = manager.rejoin('W2', { roomId: created.roomId, playerToken: created.whitePlayerToken });
  let outcome;
  try {
    outcome = legacyClientHandler(ack);
  } catch (err) {
    outcome = `THREW ${err.message}`;
  }
  check(ack.finished === true && ack.ok === false, 'a late rejoin is answered as a refusal (ok: false) that carries the result');
  check(!outcome.startsWith('THREW') && outcome.startsWith('refused'), `a pre-fix client handles it without throwing (it sees: "${outcome}") - same as it always did`);
  const live = newRoom();
  const liveAck = live.manager.rejoin('W2', { roomId: live.created.roomId, playerToken: live.created.whitePlayerToken });
  check(legacyClientHandler(liveAck).startsWith('resumed'), 'and a live rejoin still resumes for it (control)');
}

console.log('\n=== 6. The record is made before anything else in endGame can fail ===');
{
  // An emit to a socket that is going away can throw. endGame has already flipped the room to 'finished' by then, so a rejoin can no
  // longer reach it - the record has to exist regardless, or the player is back to "game not found".
  const io = stubIo();
  io.to = (id) => ({
    emit: (event, payload) => {
      if (id === 'B' && event === 'game_over') throw new Error('socket went away');
      io.events.push({ id, event, payload });
    },
  });
  const manager = new RoomManager(io);
  const created = manager.createRoom({
    white: { socketId: 'W', userId: null },
    black: { socketId: 'B', userId: null },
    timeControl: { initialSeconds: 60, incrementSeconds: 0 },
    chess960: false, kingOfTheHill: false, threeCheck: false, setupChess: false, fogOfWar: false, giveaway: false, atomic: false, duckChess: false,
  });
  let threw = false;
  try {
    manager.resign('W', created.roomId);
  } catch {
    threw = true;
  }
  check(threw, 'precondition: the emit to Black really threw inside endGame');
  const r = manager.rejoin('W2', { roomId: created.roomId, playerToken: created.whitePlayerToken });
  check(r.ok === false && r.finished === true && r.gameOver.reason === 'resignation' && r.gameOver.winner === 'b', 'the late rejoin still gets the result even though endGame threw part-way');
}

console.log('\n=== 7. The sweep interval is unref()d: a real process must be able to exit on its own ===');
{
  // A mock timer cannot show this, so use a real process. If the 60 s interval kept the event loop alive, it would never exit by itself
  // and the timeout would kill it (status null).
  const { spawnSync } = await import('node:child_process');
  const code = "import('./src/game/rooms.ts').then(({ RoomManager }) => { new RoomManager({ to: () => ({ emit() {} }) }); console.log('constructed'); });";
  const started = Number(process.hrtime.bigint() / 1_000_000n);
  const res = spawnSync(process.execPath, ['--import', 'tsx', '-e', code], { cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), encoding: 'utf8', timeout: 25_000 });
  const took = Number(process.hrtime.bigint() / 1_000_000n) - started;
  check(res.status === 0 && res.stdout.includes('constructed'), `the process constructed a RoomManager and exited by itself (status ${res.status}, ${took} ms${res.error ? `, ${res.error.code}` : ''})`);
}

mock.timers.reset();
console.log(`\nAll ${passed} checks passed.`);
process.exit(0);
