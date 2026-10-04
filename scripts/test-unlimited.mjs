#!/usr/bin/env node
/**
 * "No time limit" (live-only, no clock) server-side regression suite — no running server needed. Run with tsx:
 *   npx tsx scripts/test-unlimited.mjs      (or: npm run test:unlimited)
 *
 *  1. VALIDATION: the time control a client may send for queue / challenge / tournament — finite numbers only,
 *     and an unlimited control ({initialSeconds: 0}) must have no increment.
 *  2. THE CLOCK: an unlimited room never ticks, never gains an increment and never schedules a timeout, so the
 *     sentinel clock the clients hide stays exactly the same in every payload (move acks, opponent_move, rejoin).
 *     A timed room right next to it still counts down (the control that proves the check above can fail).
 *  3. PAIRING: unlimited pairs only with unlimited (exact match), same as every other time control.
 *  4. LIVE-ONLY: a disconnected player in an unlimited game is still on the abandonment clock — this is NOT
 *     Daily/correspondence play (that is a separate, unbuilt feature).
 */
import assert from 'node:assert/strict';
import { Matchmaker } from '../src/game/matchmaking.ts';
import { RoomManager, isUnlimitedTimeControl } from '../src/game/rooms.ts';
import { isValidTimeControl } from '../src/game/socketHandlers.ts';

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ✓ ${message}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log('\n=== 1. Time control validation ===');
check(isValidTimeControl({ initialSeconds: 0, incrementSeconds: 0 }), 'No time limit ({0, 0}) is accepted');
check(isValidTimeControl({ initialSeconds: 300, incrementSeconds: 2 }), 'a normal timed control is still accepted');
check(!isValidTimeControl({ initialSeconds: 0, incrementSeconds: 5 }), 'an unlimited control with an increment is refused');
check(!isValidTimeControl({ initialSeconds: -1, incrementSeconds: 0 }), 'a negative time is refused');
check(!isValidTimeControl({ initialSeconds: Infinity, incrementSeconds: 0 }), 'an infinite time is refused (setTimeout(Infinity) would fire at once)');
check(!isValidTimeControl({ initialSeconds: 60, incrementSeconds: NaN }) && !isValidTimeControl({ initialSeconds: NaN, incrementSeconds: 0 }), 'NaN is refused');
check(!isValidTimeControl(null) && !isValidTimeControl({ initialSeconds: '0', incrementSeconds: 0 }), 'non-objects and string numbers are refused');
check(isUnlimitedTimeControl({ initialSeconds: 0, incrementSeconds: 0 }) && !isUnlimitedTimeControl({ initialSeconds: 60, incrementSeconds: 0 }), 'isUnlimitedTimeControl tells them apart');

function stubIo() {
  const events = [];
  return { events, to: (id) => ({ emit: (event, payload) => events.push({ id, event, payload }) }) };
}
function newRoom(timeControl) {
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
  const move = (who, from, to) => manager.applyMove(who, { roomId: created.roomId, from, to });
  return { io, manager, created, move };
}

console.log('\n=== 2. The clock of an unlimited game never moves ===');
{
  const { io, manager, created, move } = newRoom({ initialSeconds: 0, incrementSeconds: 0 });
  const start = created.whiteMs;
  check(start === Number.MAX_SAFE_INTEGER && created.blackMs === start, 'both clocks start at the unlimited sentinel');
  const room = manager.rooms.get(created.roomId);
  check(room.clockTimer === null, 'no timeout timer was scheduled at creation');
  await sleep(120);
  const a = move('W', 'e2', 'e4');
  check(a.ok && a.whiteMs === start && a.blackMs === start, "White's move ack carries the untouched clocks (120 ms really elapsed)");
  check(room.clockTimer === null, 'still no timeout timer after a move');
  await sleep(120);
  const b = move('B', 'e7', 'e5');
  check(b.ok && b.whiteMs === start && b.blackMs === start, "Black's move ack carries the untouched clocks too");
  const opponentMove = io.events.filter((e) => e.event === 'opponent_move');
  check(opponentMove.length === 2 && opponentMove.every((e) => e.payload.whiteMs === start && e.payload.blackMs === start), 'every opponent_move payload carries the untouched clocks');
  const rejoin = manager.rejoin('W2', { roomId: created.roomId, playerToken: created.whitePlayerToken });
  check(rejoin.ok && rejoin.state.whiteMs === start && rejoin.state.blackMs === start, 'a rejoin sends the untouched clocks and the unlimited time control');
  check(rejoin.state.timeControl.initialSeconds === 0, '...with timeControl.initialSeconds 0, which is how the clients know to hide the clock');
}
{
  const { manager, created, move } = newRoom({ initialSeconds: 300, incrementSeconds: 0 });
  await sleep(120);
  const a = move('W', 'e2', 'e4');
  check(a.ok && a.whiteMs < 300_000 && a.whiteMs > 299_000, 'CONTROL: a 5-minute room does count down (so the unlimited checks above can fail)');
  check(manager.rooms.get(created.roomId).clockTimer !== null, 'CONTROL: ...and does schedule a timeout');
  manager.dispose?.();
}

console.log('\n=== 3. Pairing ===');
{
  const entry = (socketId, initialSeconds, incrementSeconds = 0) => ({
    socketId,
    userId: null,
    timeControl: { initialSeconds, incrementSeconds },
    isChess960: false,
    isKingOfTheHill: false,
    isThreeCheck: false,
    isSetupChess: false,
    isFogOfWar: false,
    isGiveaway: false,
    isAtomic: false,
    isDuckChess: false,
    queuedAt: Date.now(),
  });
  const mm = new Matchmaker();
  check(mm.join(entry('a', 0)) === null, 'the first unlimited player waits');
  check(mm.join(entry('b', 300)) === null, 'a 5-minute player does NOT pair with the unlimited one');
  const paired = mm.join(entry('c', 0));
  check(paired?.socketId === 'a', 'a second unlimited player pairs with the first');
  check(mm.size() === 1, 'the 5-minute player is still waiting');
}

console.log('\n=== 4. Live-only: abandonment still applies ===');
{
  const { io, manager, created } = newRoom({ initialSeconds: 0, incrementSeconds: 0 });
  manager.handleDisconnect('W');
  const room = manager.rooms.get(created.roomId);
  check(room.players.w.abandonTimer !== null, 'a disconnected player in an unlimited game is on the abandonment timer');
  check(io.events.some((e) => e.id === 'B' && e.event === 'opponent_disconnected'), '...and the opponent is told');
  manager.dispose?.();
}

console.log(`\nAll good — ${passed} checks passed.`);
process.exit(0);
