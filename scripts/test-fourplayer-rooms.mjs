/**
 * 4 Player Chess ONLINE - the room manager (src/game/fourPlayerRooms.ts, workstream W2).
 *
 *   npm run test:fourplayerRooms        (tsx; no server, no database; stub sockets + Node fake timers + Date)
 *
 * The manager is driven exactly the way W4's socket handlers will drive it (`makeMove(socketId, payload)` ...), with a stub `io` that
 * records every emit. Fake timers make the clocks deterministic (a flag fall, a 999 ms vs 1000 ms boundary, an off-turn resignation that
 * must charge the seat on move). What is guarded, in order: creation and token privacy; every refusal leaving the room untouched; the
 * clocks; resign; the end of a game and the finished-result retention; rejoin / disconnect; chat; spectating; the rate limits; hostile
 * input; the "commit is the only mutator" property (at source level); and seeded random full games checked move by move against an
 * independent replay on the engine. Bots and takeover are W3, the queue and socket handlers W4 - not here.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mock } from 'node:test';
import { spawnSync } from 'node:child_process';
import { FourRoomManager } from '../src/game/fourPlayerRooms.ts';
import { KINGS, TC, UUID, eventsOf, mulberry32, newGame, startFakeTimers, stubIo } from './fourplayer-test-kit.mjs';
import { FOUR_ACTIVE_GAMES_LIST_MAX, FOUR_CHAT_MIN_INTERVAL_MS, FOUR_FINISHED_RETENTION_MS, FOUR_FINISHED_SWEEP_INTERVAL_MS, FOUR_MAX_SPECTATORS_PER_ROOM, FOUR_MOVE_RATE_LIMIT } from '../src/game/fourPlayerConfig.ts';
import { FINISHED_RETENTION_MS as TWO_PLAYER_RETENTION_MS } from '../src/game/rooms.ts';
import * as E from '../src/game/fourPlayer/index.ts';

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ok  ${message}`);
}

const { liveTimeouts } = startFakeTimers(); // fake timers + a count of the timeouts still pending (see the kit)

console.log('\n=== 0. The configured numbers are the decided ones (pinned as literals: the boundary tests below follow the constants) ===');
{
  check(FOUR_FINISHED_RETENTION_MS === 300_000 && FOUR_FINISHED_SWEEP_INTERVAL_MS === 60_000, 'finished results are kept 300 s, swept every 60 s');
  check(FOUR_CHAT_MIN_INTERVAL_MS === 1000, 'one chat message per seat per 1000 ms');
  check(FOUR_MOVE_RATE_LIMIT.max === 10 && FOUR_MOVE_RATE_LIMIT.windowMs === 1000, 'at most 10 move calls per seat per 1000 ms');
}

console.log('\n=== 0b. Timers: one per active room, none after the game ===');
{
  const base = liveTimeouts.size;
  const g = newGame();
  check(liveTimeouts.size === base + 1, 'a new room owns exactly one pending timer (the seat on move\'s clock)');
  for (let i = 0; i < 8; i++) g.playFirst();
  check(liveTimeouts.size === base + 1, '...and still exactly one after eight moves (each commit replaces it, none pile up)');
  g.resign(1);
  g.resign(2);
  check(liveTimeouts.size === base + 1, '...and after resignations');
  const room = g.room();
  g.resign(3);
  check(g.mgr.rooms.has(g.id) === false && liveTimeouts.size === base && room.clockTimer === null, 'the moment the game ends its timer is cancelled: no pending timer is left holding the room');
  const h = newGame({ tc: { initialSeconds: 60, incrementSeconds: 0 } });
  mock.timers.tick(60_000);
  mock.timers.tick(60_000);
  check(liveTimeouts.size === base + 1, 'after flag falls the room still has exactly one timer (for the seat now on move)');
  mock.timers.tick(60_000);
  check(h.mgr.rooms.has(h.id) === false && liveTimeouts.size === base, 'a game that ends by the third flag fall leaves no timer either');
  const a = newGame();
  const b = newGame();
  check(liveTimeouts.size === base + 2, 'two rooms: two timers');
  a.resign(0);
  a.resign(1);
  a.resign(2);
  check(liveTimeouts.size === base + 1 && b.mgr.rooms.has(b.id), "ending one game cancels only ITS timer: the other game's is still pending");
}

console.log('\n=== 1. Creating a room: who learns what ===');
{
  const g = newGame({ names: ['Ann', 'Ben', 'Cy', 'Di'], label: '10 min' });
  const found = eventsOf(g.io, 'four_match_found');
  check(found.length === 4 && [0, 1, 2, 3].every((i) => found.some((e) => e.id === `S${i}`)), 'every human gets exactly one four_match_found');
  check(found.every((e) => e.payload.seq === 0 && e.payload.roomId === g.id && e.payload.timeControlLabel === '10 min'), '...at seq 0, for this room');
  check(found.every((e) => e.payload.seat === Number(e.id[1])), "...each carrying THEIR OWN seat (the socket's, not a neighbour's)");
  check(found.every((e) => UUID.test(e.payload.playerToken)) && new Set(found.map((e) => e.payload.playerToken)).size === 4, '...and their own token: four distinct UUIDs');
  check(found.every((e, i) => e.payload.playerToken === g.tokens[Number(e.id[1])]), '...equal to the tokens createRoom returned');
  check(found[0].payload.state === E.serialize(E.initialState()), 'the snapshot is the standard start position, Red to move');
  check(JSON.stringify(found[0].payload.clocksMs) === '[600000,600000,600000,600000]', 'all four clocks start at the full time');
  check(found[0].payload.seats.map((s) => s.name).join() === 'Ann,Ben,Cy,Di' && found[0].payload.seats.every((s) => s.kind === 'human' && s.connected), 'the seat list carries names, kinds and connection state');
  check(found.every((e) => JSON.stringify(e.payload.seats).indexOf('playerToken') < 0 && JSON.stringify(e.payload.seats).indexOf('socketId') < 0), '...and never a token or a socket id');
  // privacy: a token may appear ONLY in its own seat's match_found
  let leaks = 0;
  for (const e of g.io.events) for (const [seat, token] of g.tokens.entries()) if (JSON.stringify(e.payload).includes(token) && !(e.event === 'four_match_found' && e.id === `S${seat}`)) leaks++;
  check(leaks === 0, "no token appears anywhere except in its owner's own four_match_found");
  check(g.io.events.length === 4, 'and nothing else was sent');
}
{
  const g = newGame({ bots: 2 });
  check(eventsOf(g.io, 'four_match_found').length === 2, 'a room with two bot seats: match_found goes to the two humans only');
  check(g.tokens[2] === null && g.tokens[3] === null && g.tokens[0] && g.tokens[1], '...and bots have no token');
  const seats = eventsOf(g.io, 'four_match_found')[0].payload.seats;
  check(seats[2].kind === 'bot' && seats[2].botReason === 'fill' && seats[2].elo === 1200 && seats[2].connected === true && seats[2].name === 'Bot', 'a bot seat is described as such (reason, elo, always connected)');
}
{
  const io = stubIo();
  const mgr = new FourRoomManager(io);
  const human = (id) => ({ kind: 'human', socketId: id, name: id });
  const bot = { kind: 'bot', socketId: null, name: 'Bot', elo: 1200 };
  const throwsMsg = (fn, re, message) => {
    assert.throws(fn, re, message);
    passed++;
    console.log(`  ok  ${message}`);
  };
  throwsMsg(() => mgr.createRoom({ seats: [human('a'), human('b'), human('c'), human('d')], timeControl: { initialSeconds: 59, incrementSeconds: 0 } }), /createRoom/, 'a time control below the live range is refused');
  throwsMsg(() => mgr.createRoom({ seats: [human('a'), human('b'), human('c'), human('d')], timeControl: { initialSeconds: 0, incrementSeconds: 0 } }), /createRoom/, '"No time limit" is refused (the clock is the only idle guard)');
  throwsMsg(() => mgr.createRoom({ seats: [human('a'), human('b'), human('c')], timeControl: TC }), /four seats/, 'three seats are refused');
  throwsMsg(() => mgr.createRoom({ seats: [bot, bot, bot, bot], timeControl: TC }), /human/, 'a room with no human is refused');
  throwsMsg(() => mgr.createRoom({ seats: [human('a'), human('a'), bot, bot], timeControl: TC }), /own socket/, 'one socket in two seats is refused');
  throwsMsg(() => mgr.createRoom({ seats: [human(null), human('b'), bot, bot], timeControl: TC }), /own socket/, 'a human seat without a socket is refused');
  const ok1 = mgr.createRoom({ seats: [human('a'), human('b'), bot, bot], timeControl: TC });
  check(typeof ok1.roomId === 'string', 'a valid room is created after the refusals (they left nothing behind)');
  throwsMsg(() => mgr.createRoom({ seats: [human('a'), human('c'), bot, bot], timeControl: TC }), /already seated/, 'a socket that is already seated in a game cannot be seated again');
  const long = mgr.createRoom({ seats: [{ kind: 'human', socketId: 'z', name: 'x'.repeat(100) }, human('y'), bot, bot], timeControl: TC });
  const longName = io.events.filter((e) => e.event === 'four_match_found' && e.id === 'z')[0].payload.seats[0].name;
  check(longName.length === 40 && long.roomId, 'a display name is cut to 40 characters');
}

console.log('\n=== 2. Moves: the happy path, and who is told ===');
{
  const g = newGame();
  const spectator = g.mgr.spectate('SP', { roomId: g.id });
  check(spectator.ok === true, 'a spectator joins');
  g.clear();
  const { from, to } = g.firstMove(0);
  const ack = g.mv(0, from, to);
  check(ack.ok === true && ack.seq === 1, 'Red plays a legal move: ack { ok, seq: 1 }');
  const states = eventsOf(g.io, 'four_state');
  check(states.length === 5 && ['S0', 'S1', 'S2', 'S3', 'SP'].every((id) => states.some((e) => e.id === id)), 'four_state goes to all four seats AND the spectator');
  check(states.every((e) => e.payload === states[0].payload), '...the very same payload to each (nobody gets a different view)');
  const p = states[0].payload;
  check(p.seq === 1 && p.roomId === g.id && p.actor === 'human' && p.move.seat === 0 && p.move.from === from && p.move.to === to && typeof p.move.label === 'string', 'payload: seq 1, actor human, the move with its seat, squares and label');
  check(p.events.length >= 1 && p.events[0].kind === 'move' && p.events[0].seat === 0, '...the engine events (a move event first)');
  check(p.state === g.fp() && E.deserialize(p.state).turn === 1, '...and the snapshot is the room\'s position, now Blue to move');
  check(JSON.stringify(p.clocksMs) === '[600000,600000,600000,600000]', '...with the clocks (no time passed in this test)');
  check(g.room().log.length === 1 && g.room().log[0].seat === 0, 'the move list got one entry');
  check(g.mgr.rooms.get(g.id).seq === 1, 'seq advanced by exactly 1');
  // each seat in turn
  for (let i = 1; i < 4; i++) check(g.playFirst().ok === true, `seat ${i} moves in turn`);
  check(g.seq() === 4 && g.state().turn === 0, 'after four moves: seq 4, Red to move again');
  const seqs = eventsOf(g.io, 'four_state', 'S2').map((e) => e.payload.seq);
  check(seqs.join() === '1,2,3,4', 'a seat receives seq 1,2,3,4 with no gap and no repeat');
}
{
  const g = newGame();
  g.stopTimer();
  const before = { fp: g.fp(), seq: g.seq(), sent: g.io.events.length };
  const untouched = (what) => {
    assert.equal(g.fp(), before.fp, `${what}: position changed`);
    assert.equal(g.seq(), before.seq, `${what}: seq changed`);
    assert.equal(g.io.events.length, before.sent, `${what}: something was sent`);
  };
  const refuse = (what, ack, re) => {
    assert.equal(ack.ok, false, `${what}: expected a refusal, got ${JSON.stringify(ack)}`);
    assert.match(ack.error, re, `${what}: wrong message "${ack.error}"`);
    untouched(what);
    passed++;
    console.log(`  ok  ${what}: refused (${ack.error}) and the room is untouched`);
  };
  const red = g.firstMove(0);
  refuse('a move out of turn', g.mv(1, 'b5', 'd5'), /Not your turn/);
  refuse('an illegal destination', g.mv(0, 'e2', 'e6'), /Illegal move/);
  refuse('moving another seat\'s piece (a Blue pawn, as Red)', g.mv(0, 'b5', 'd5'), /Illegal move/);
  refuse('moving from an empty square', g.mv(0, 'e8', 'e9'), /Illegal move/);
  refuse('a square off the cut corner (a1)', g.mv(0, 'a1', 'a2'), /Invalid move/);
  refuse('a non-canonical square (e02)', g.mv(0, 'e02', 'e4'), /Invalid move/);
  refuse('a promotion piece that does not exist', g.mv(0, red.from, red.to, 'k'), /Invalid promotion/);
  refuse('a room the socket is not in', g.mgr.makeMove('S0', { roomId: 'not-this-room', from: red.from, to: red.to }), /No active game/);
  refuse('a socket that is not seated anywhere', g.mgr.makeMove('STRANGER', { roomId: g.id, from: red.from, to: red.to }), /No active game/);
  g.mgr.spectate('SP', { roomId: g.id });
  const afterSpectate = g.io.events.length;
  before.sent = afterSpectate;
  refuse('a spectator trying to move', g.mgr.makeMove('SP', { roomId: g.id, from: red.from, to: red.to }), /No active game/);
  refuse('a payload that is not an object', g.mgr.makeMove('S0', 'e2e4'), /Invalid move/);
  refuse('a missing payload', g.mgr.makeMove('S0', undefined), /Invalid move/);
  const forged = g.mgr.makeMove('S0', { roomId: g.id, from: red.from, to: red.to, seat: 2 });
  check(forged.ok === true && g.state().turn === 1 && E.seatOf(g.state().cells[E.parseSquare(red.to)]) === 0, 'a "seat" smuggled into the payload is ignored: the move is made as the SOCKET\'S seat (Red)');
}
{
  // Promotions and special moves resolve through the manager exactly as the engine says (white-box set-up, real manager calls).
  const promote = (letter) => {
    const g = newGame();
    g.setPosition([...KINGS, 'rP@e7'], { turn: 0 });
    g.stopTimer();
    const ack = g.mv(0, 'e7', 'e8', letter);
    return { g, ack, piece: E.typeOf(g.state().cells[E.parseSquare('e8')]) };
  };
  for (const [letter, type] of [['q', E.PROMOTED_QUEEN], ['r', E.PROMOTED_ROOK], ['b', E.PROMOTED_BISHOP], ['n', E.PROMOTED_KNIGHT]]) {
    const r = promote(letter);
    check(r.ack.ok && r.piece === type, `promotion to "${letter}" puts the promoted ${letter} on e8`);
  }
  const noLetter = promote(undefined);
  check(noLetter.ack.ok && noLetter.piece === E.PROMOTED_QUEEN, 'a promotion without a piece letter defaults to the queen (the engine\'s default)');
  const p = promote('r');
  check(eventsOf(p.g.io, 'four_state').at(-1).payload.move.promotion === 'r', 'the published move records the promotion piece');
  const ignored = (() => {
    const g = newGame();
    return g.mv(0, g.firstMove(0).from, g.firstMove(0).to, 'n');
  })();
  check(ignored.ok === true, 'a promotion letter on a move that is not a promotion is harmless');
  const castle = newGame();
  castle.setPosition([...KINGS, 'rR@d1', 'rR@k1', 'bR@a4', 'bR@a11', 'yR@d14', 'yR@k14', 'gR@n4', 'gR@n11'], { turn: 0 });
  castle.stopTimer();
  check(castle.mv(0, 'h1', 'f1').ok && E.typeOf(castle.state().cells[E.parseSquare('g1')]) === E.ROOK, 'castling (king two squares towards the rook) works through the manager');
  const ep = newGame();
  ep.setPosition([...KINGS, 'rP@e2', 'bP@d4'], { turn: 0 });
  ep.stopTimer();
  check(ep.mv(0, 'e2', 'e4').ok && ep.mv(1, 'd4', 'e3').ok && ep.state().cells[E.parseSquare('e4')] === E.EMPTY, 'en passant across axes (Red double step, Blue captures onto e3) works through the manager');
}

console.log('\n=== 3. The clocks ===');
{
  const g = newGame({ tc: { initialSeconds: 600, incrementSeconds: 0 } });
  mock.timers.tick(7500);
  g.playFirst();
  const clocks = eventsOf(g.io, 'four_state').at(-1).payload.clocksMs;
  check(JSON.stringify(clocks) === '[592500,600000,600000,600000]', 'Red thinks for 7.5 s: exactly 7.5 s is charged to Red and to nobody else');
}
{
  const g = newGame({ tc: { initialSeconds: 300, incrementSeconds: 5 } });
  mock.timers.tick(2000);
  g.playFirst();
  check(JSON.stringify(eventsOf(g.io, 'four_state').at(-1).payload.clocksMs) === '[303000,300000,300000,300000]', 'a 5 s increment is added AFTER the move: 300 - 2 + 5 = 303 s');
  mock.timers.tick(1000);
  g.playFirst();
  g.playFirst();
  g.playFirst();
  mock.timers.tick(4000);
  g.playFirst(); // Red again
  check(eventsOf(g.io, 'four_state').at(-1).payload.clocksMs[0] === (303 - 4 + 5) * 1000, "...and each seat's turn is timed from ITS OWN start (Red's second turn took 4 s)");
}
{
  // The seat on move runs out of time with nobody doing anything: the timer fires and the engine eliminates it.
  const g = newGame({ tc: { initialSeconds: 60, incrementSeconds: 0 } });
  g.clear();
  mock.timers.tick(59_999);
  check(eventsOf(g.io, 'four_state').length === 0, 'at 59.999 s nothing has happened');
  mock.timers.tick(1);
  const s = eventsOf(g.io, 'four_state', 'S1');
  check(s.length === 1 && s[0].payload.actor === 'clock' && s[0].payload.move === null && s[0].payload.seq === 1, 'at 60 s the timer fires: one four_state, actor "clock", no move, seq 1');
  const eliminated = s[0].payload.events.filter((e) => e.kind === 'eliminated');
  check(eliminated.length === 1 && eliminated[0].seat === 0 && eliminated[0].reason === 'timeout' && eliminated[0].points.every((p) => p === 0), '...the engine eliminated Red for TIME (no points to anyone)');
  check(g.state().status[0] === 'dead-king' && g.state().turn === 1 && s[0].payload.clocksMs[0] === 0, '...Red is out with 0 on its clock and Blue is on move');
  g.clear();
  mock.timers.tick(59_999);
  check(eventsOf(g.io, 'four_state').length === 0, "Blue's 60 s run from ITS turn start (the timer was re-armed), not from the beginning");
  mock.timers.tick(1);
  check(eventsOf(g.io, 'four_state', 'S0').length === 1 && g.state().status[1] === 'dead-king', 'Blue flags at exactly 60 s of its own time');
  mock.timers.tick(60_000);
  const over = eventsOf(g.io, 'four_game_over', 'S3');
  check(over.length === 1 && over[0].payload.reason === 'elimination' && g.mgr.rooms.has(g.id) === false, 'the third flag fall leaves one seat: the game is over by elimination and the room is gone');
  check(JSON.stringify(over[0].payload.winners) === '[0,1,2,3]' && JSON.stringify(over[0].payload.scores) === '[0,0,0,0]', '...with no points scored, the engine\'s rule is that equal top scores share the win');
}
{
  // A timer that wakes a hair EARLY (timers are allowed to) must still flag the seat: the timer spends the whole remaining time.
  const g = newGame({ tc: { initialSeconds: 60, incrementSeconds: 0 } });
  g.stopTimer();
  mock.timers.tick(59_999);
  g.clear();
  g.mgr.onClockTimer(g.room());
  const s = eventsOf(g.io, 'four_state', 'S1');
  check(s.length === 1 && s[0].payload.actor === 'clock' && g.state().status[0] === 'dead-king', 'a timer that wakes 1 ms early still flags the seat (the timer charges the seat\'s whole remaining time)');
}
{
  // A move cancels the previous seat's timer. If it did not, that stale timer would later flag a seat that has not used its time.
  const g = newGame({ tc: { initialSeconds: 60, incrementSeconds: 0 } });
  mock.timers.tick(10_000);
  g.playFirst(); // Red moves at t = 10 s; Blue's 60 s run from here (to t = 70 s)
  g.clear();
  mock.timers.tick(50_000); // t = 60 s: Red's ORIGINAL timer would fire now
  check(g.io.events.length === 0 && g.state().status[1] === 'active', "Red's old timer was cancelled by its move: at t = 60 s nothing happens to Blue, who has 10 s left");
  mock.timers.tick(10_000);
  check(eventsOf(g.io, 'four_state', 'S0').length === 1 && g.state().status[1] === 'dead-king', "...and Blue flags at t = 70 s, 60 s after ITS turn began");
}
{
  // A move that ARRIVES after the clock ran out (the timer was late) is void; what everyone sees is the flag fall.
  const g = newGame({ tc: { initialSeconds: 60, incrementSeconds: 0 } });
  g.stopTimer();
  mock.timers.tick(61_000);
  g.clear();
  const { from, to } = g.firstMove(0);
  const ack = g.mv(0, from, to);
  check(ack.ok === false && /time ran out/.test(ack.error), 'a move arriving after the flag fell is refused ("Your time ran out.")');
  const s = eventsOf(g.io, 'four_state', 'S2');
  check(s.length === 1 && s[0].payload.actor === 'clock' && s[0].payload.move === null && g.state().status[0] === 'dead-king' && g.seq() === 1, '...and the server publishes the timeout elimination instead (actor "clock", seq 1)');
  check(g.state().cells[E.parseSquare(from)] !== E.EMPTY, '...the late move was NOT played');
}
{
  // Resigning off turn: the seat on move is charged for the time it has used (found while writing W2: an early version refunded it).
  const g = newGame();
  mock.timers.tick(20_000);
  g.clear();
  check(g.resign(2).ok === true, 'Yellow resigns while Red is on move, 20 s into Red\'s turn');
  const p = eventsOf(g.io, 'four_state', 'S0')[0].payload;
  check(p.actor === 'resign' && p.move === null && p.clocksMs[0] === 580_000, "Red's clock shows 580 s: the 20 s it has spent were charged, not refunded");
  check(g.state().status[2] === 'dead-king' && g.state().turn === 0, '...Yellow is out and it is still Red\'s turn');
  mock.timers.tick(5_000);
  g.playFirst();
  check(eventsOf(g.io, 'four_state').at(-1).payload.clocksMs[0] === 575_000, "...and Red's turn clock was NOT reset by the resignation: 20 s + 5 s = 25 s in total (600 - 25 = 575)");
}
{
  const g = newGame({ tc: { initialSeconds: 60, incrementSeconds: 0 } });
  g.stopTimer();
  mock.timers.tick(61_000);
  g.clear();
  check(g.resign(1).ok === true, 'Blue resigns after Red\'s clock has already run out (the timer was late)');
  const states = eventsOf(g.io, 'four_state', 'S3').map((e) => e.payload);
  check(states.length === 2 && states[0].actor === 'clock' && states[1].actor === 'resign' && states[1].seq === 2, '...two states are published, in order: the flag fall (seq 1), then the resignation (seq 2)');
  check(g.state().status[0] === 'dead-king' && g.state().status[1] === 'dead-king' && g.state().turn === 2, '...Red (time) and Blue (resigned) are out; Yellow is on move');
}
{
  const g = newGame({ tc: { initialSeconds: 60, incrementSeconds: 0 } });
  g.stopTimer();
  mock.timers.tick(61_000);
  g.clear();
  check(g.resign(0).ok === true && eventsOf(g.io, 'four_state', 'S1').length === 1 && g.seq() === 1, 'a seat that resigns after ITS OWN clock already ran out is simply out (one state: the flag fall)');
}
{
  // A dead king walks by itself when its turn comes round: instant, free, and published as part of the move that preceded it.
  const g = newGame({ tc: { initialSeconds: 600, incrementSeconds: 0 }, rng: mulberry32(3) });
  g.setPosition([...KINGS, 'rP@e2', 'bP@b5', 'yP@e13', 'gP@m5'], { turn: 0 }); // Red's king (h1) has free squares
  g.stopTimer();
  g.resign(0);
  g.playFirst(1);
  g.playFirst(2);
  mock.timers.tick(4000); // Green thinks for 4 s, then moves; Red's dead king then walks
  g.playFirst(3);
  const last = eventsOf(g.io, 'four_state').at(-1).payload;
  const walk = last.events.find((e) => e.kind === 'deadKingMove');
  check(walk && walk.seat === 0, "an eliminated seat's dead king walks by itself when its turn comes (in the same four_state as the move before it)");
  check(last.clocksMs[0] === 600_000 && last.clocksMs[3] === 596_000, "...that walk costs nobody time: only Green's own 4 s were charged, and the eliminated seat's clock is untouched");
  check(g.state().turn === 1 && g.seq() === 4, '...and the turn goes on to Blue');
}
{
  // ...and a king with no square to go to (the start position: boxed in by its own pieces) freezes instead.
  const g = newGame({ tc: { initialSeconds: 600, incrementSeconds: 0 } });
  g.resign(0);
  g.playFirst(1);
  g.playFirst(2);
  g.playFirst(3);
  check(eventsOf(g.io, 'four_state').at(-1).payload.events.some((e) => e.kind === 'frozen' && e.seat === 0), 'a dead king with no legal move freezes (and is skipped from then on)');
}

console.log('\n=== 4. Resignation and the end of a game ===');
{
  const g = newGame();
  check(g.resign(1).ok === true && g.state().status[1] === 'dead-king' && g.state().turn === 0, 'Blue resigns off turn: it is out, Red is still on move');
  const again = g.resign(1);
  check(again.ok === false && /already out/.test(again.error), 'resigning twice is refused');
  const move = g.mv(1, 'b5', 'd5');
  check(move.ok === false && /out of this game/.test(move.error), 'an eliminated seat cannot move');
  check(g.resign(0).ok === true && g.state().turn === 2, 'Red resigns ON turn: the turn passes (Blue is out, so to Yellow)');
  g.clear();
  const final = g.resign(2);
  check(final.ok === true && g.mgr.rooms.has(g.id) === false, 'the third resignation leaves one active seat: the game ends and the room is removed');
  const over = eventsOf(g.io, 'four_game_over');
  check(over.length === 4 && over.every((e) => e.payload.reason === 'elimination' && e.payload.roomId === g.id), 'four_game_over reaches every seat (also the three seats that were already out)');
  check(over[0].payload.state === eventsOf(g.io, 'four_state').at(-1).payload.state && over[0].payload.state.endsWith(':elimination'), '...with the final snapshot, which records the result');
  check(eventsOf(g.io, 'four_state').at(-1).payload.actor === 'resign', 'the last four_state (the resignation) is published BEFORE the game over');
  const order = g.io.events.map((e) => e.event);
  check(order.lastIndexOf('four_state') < order.indexOf('four_game_over'), '...every four_state precedes every four_game_over');
  check(g.mgr.socketToSeat.size === 0 && g.mgr.socketToSpectating.size === 0, 'all sockets are released when the game ends');
  const late = g.mv(3, 'm5', 'k5');
  check(late.ok === false && /No active game/.test(late.error), 'a move in a finished game is refused');
  const sent = g.io.events.length;
  mock.timers.tick(3_600_000);
  check(g.io.events.length === sent, 'no timer fires after the game is over (an hour later nothing has been sent)');
}
{
  // A winner by points: Red captures, so it holds the highest score when the others resign.
  const g = newGame();
  g.setPosition([...KINGS, 'rR@e8', 'yN@e5'], { turn: 0 });
  g.stopTimer();
  check(g.mv(0, 'e8', 'e5').ok === true && g.state().score[0] === 3, 'Red captures a knight: 3 points');
  g.resign(1);
  g.resign(2);
  check(g.mgr.rooms.has(g.id), 'two resignations leave Red and Green active: the game goes on');
  g.resign(3);
  const over = eventsOf(g.io, 'four_game_over', 'S0');
  check(over.length === 1 && JSON.stringify(over[0].payload.winners) === '[0]' && over[0].payload.scores[0] === 3, 'the third resignation ends it, and the winner is the highest scorer (Red, with 3 points)');
  // The same ending with the points on the OTHER side: the last seat standing does not win if someone else scored more.
  const h = newGame();
  h.setPosition([...KINGS, 'rR@e8', 'yN@e5'], { turn: 0 });
  h.stopTimer();
  h.mv(0, 'e8', 'e5');
  h.resign(0);
  h.resign(2);
  h.resign(3);
  const overH = eventsOf(h.io, 'four_game_over', 'S1');
  check(overH.length === 1 && JSON.stringify(overH[0].payload.winners) === '[0]', 'Blue is the last seat standing but Red (who resigned) still has the most points: Red wins - the engine scores by points, not survival');
}
{
  // Nothing below may lose the result: a socket that throws on send does not stop the funnel or the record.
  const g = newGame();
  const realError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  g.io.failing.add('S1');
  g.clear();
  const ack = g.playFirst(0);
  check(ack.ok === true && g.seq() === 1 && eventsOf(g.io, 'four_state').length === 3, 'a seat whose socket throws on send does not stop the commit: seq advances and the other three still get the state');
  g.resign(1);
  g.resign(2);
  g.resign(3);
  const over = eventsOf(g.io, 'four_game_over');
  check(over.length === 3 && g.mgr.rooms.has(g.id) === false, '...nor the end of the game: the three working sockets get four_game_over and the room is removed');
  const late = g.mgr.rejoin('S1b', { roomId: g.id, playerToken: g.tokens[1] });
  check(late.ok === true && late.finished === true && late.gameOver.reason === 'elimination', '...and the failed seat can still learn the result by rejoining (the record was written before any send)');
  console.error = realError;
  check(logged.length >= 5 && logged.every((l) => /failed to send/.test(l) && /S1/.test(l)), `...each failure was logged with its recipient (${logged.length} lines), not swallowed silently`);
}

console.log('\n=== 5. Rejoining ===');
{
  const g = newGame();
  mock.timers.tick(3000);
  g.playFirst(); // Red moves after 3 s; Blue now on move
  mock.timers.tick(2000);
  g.clear();
  const ack = g.mgr.rejoin('S2new', { roomId: g.id, playerToken: g.tokens[2] });
  check(ack.ok === true && ack.state.seat === 2 && ack.state.roomId === g.id && ack.state.seq === 1, 'rejoin with Yellow\'s token on a new socket: ok, seat 2, the current seq');
  check(ack.state.state === g.fp() && ack.state.log.length === 1 && ack.state.seats.length === 4, '...the live snapshot, the move list and the seats');
  check(JSON.stringify(ack.state.clocksMs) === '[597000,598000,600000,600000]', "...clocks AS OF NOW: Blue (on move) has already spent 2 s of its turn, so a client counts down from the right figure");
  const seatUpdates = eventsOf(g.io, 'four_seat_update');
  check(seatUpdates.length === 4 && ['S0', 'S1', 'S2new', 'S3'].every((id) => seatUpdates.some((e) => e.id === id)), 'every seat that has a socket (including the rejoiner, excluding the replaced one) is told the seat list changed');
  g.clear();
  const move = g.mgr.makeMove('S2', { roomId: g.id, from: 'e13', to: 'e11' });
  check(move.ok === false && /No active game/.test(move.error), 'the OLD socket no longer owns the seat: it cannot act for Yellow');
  g.mgr.handleDisconnect('S2'); // the old connection finally dies
  check(g.room().seats[2].connected === true && g.room().seats[2].socketId === 'S2new', "...and its late disconnect does not disconnect Yellow (a newer connection replaced it)");
  g.playFirst(1);
  check(g.mgr.makeMove('S2new', { roomId: g.id, from: g.firstMove(2).from, to: g.firstMove(2).to }).ok === true, 'the NEW socket plays Yellow\'s move');
}
{
  const g = newGame();
  const bad = (payload, re, what) => {
    const ack = g.mgr.rejoin('X', payload);
    assert.equal(ack.ok, false, what);
    assert.match(ack.error, re, what);
    passed++;
    console.log(`  ok  ${what}`);
  };
  bad({ roomId: g.id, playerToken: 'not-a-token' }, /Invalid playerToken/, 'a wrong token on a live room is refused');
  bad({ roomId: 'no-such-room', playerToken: g.tokens[0] }, /not found/, 'an unknown room is "not found"');
  bad({ roomId: g.id }, /Invalid request/, 'a missing token is refused');
  bad(null, /Invalid request/, 'a null payload is refused (and does not throw)');
  bad('x', /Invalid request/, 'a string payload is refused');
  const a = g.mgr.rejoin('Y', { roomId: g.id, playerToken: g.tokens[0] });
  check(a.ok && a.state.seat === 0, "a token opens ITS OWN seat (Red's token gives seat 0, whoever asks)");
  const b = g.mgr.rejoin('Z', { roomId: g.id, playerToken: g.tokens[3] });
  check(b.ok && b.state.seat === 3, '...and another seat\'s token gives that seat, never Red');
  const other = newGame();
  const crossed = g.mgr.rejoin('W', { roomId: g.id, playerToken: other.tokens[0] });
  check(crossed.ok === false && /Invalid playerToken/.test(crossed.error), "a token from ANOTHER game opens nothing here");
}
{
  // One socket cannot be seated twice, and a spectator who takes a seat stops spectating.
  const g1 = newGame();
  const mgr = g1.mgr;
  mgr.createRoom({ seats: [{ kind: 'human', socketId: 'T0', name: 'a' }, { kind: 'human', socketId: 'T1', name: 'b' }, { kind: 'bot', socketId: null, name: 'Bot', elo: 1200 }, { kind: 'bot', socketId: null, name: 'Bot', elo: 1200 }], timeControl: TC });
  const clash = mgr.rejoin('T0', { roomId: g1.id, playerToken: g1.tokens[0] });
  check(clash.ok === false && /another game/.test(clash.error), "a socket already seated in a game cannot also take a seat in a different one");
  mgr.spectate('SPX', { roomId: g1.id });
  const take = mgr.rejoin('SPX', { roomId: g1.id, playerToken: g1.tokens[0] });
  check(take.ok === true && !g1.room().spectators.has('SPX') && mgr.socketToSpectating.has('SPX') === false, 'a spectator that takes a seat with a token stops spectating');
}
{
  // Finished games: the result stays available for the retention, to token holders only.
  const g = newGame();
  g.resign(0);
  g.resign(1);
  g.resign(2);
  const probe = (socket, token) => g.mgr.rejoin(socket, { roomId: g.id, playerToken: token });
  const r = probe('L0', g.tokens[0]);
  check(r.ok === true && r.finished === true && r.gameOver.reason === 'elimination' && r.gameOver.roomId === g.id, 'a late rejoin on a finished game answers { ok, finished, gameOver } instead of "not found"');
  check(probe('L3', g.tokens[3]).finished === true, '...for every seat\'s token, including the winner\'s');
  const wrong = probe('LX', 'x'.repeat(36));
  check(wrong.ok === false && wrong.finished === undefined && wrong.gameOver === undefined, 'a wrong token learns NOTHING about the result');
  const noRoom = g.mgr.rejoin('LY', { roomId: 'unknown', playerToken: g.tokens[0] });
  check(noRoom.ok === false && noRoom.gameOver === undefined, 'an unknown room likewise');
  check(g.mgr.socketToSeat.has('L0') === false, 'the late socket is not seated anywhere (nothing left to take part in)');
  mock.timers.tick(FOUR_FINISHED_RETENTION_MS);
  check(probe('L0', g.tokens[0]).finished === true, `still available at exactly ${FOUR_FINISHED_RETENTION_MS / 1000} s`);
  mock.timers.tick(1);
  const gone = probe('L0', g.tokens[0]);
  check(gone.ok === false && /not found/.test(gone.error), 'one millisecond later it is gone');
  const h = newGame();
  h.resign(0);
  h.resign(1);
  h.resign(2);
  check(h.mgr.finishedRooms.size >= 1, 'a finished game leaves a record');
  mock.timers.tick(FOUR_FINISHED_RETENTION_MS + FOUR_FINISHED_SWEEP_INTERVAL_MS + 1000);
  check(h.mgr.finishedRooms.size === 0, 'the periodic sweep (nobody calling it) removed the records');
  check(h.mgr.sweepFinishedRooms(Date.now()) === 0, 'a sweep with nothing to remove removes nothing');
}
{
  check(FOUR_FINISHED_RETENTION_MS === TWO_PLAYER_RETENTION_MS, "the 4-player retention equals the 2-player server's FINISHED_RETENTION_MS (they must not drift apart)");
  // The sweep interval must be unref()'d: a real process that constructs a manager must be able to exit on its own.
  const code = "import('./src/game/fourPlayerRooms.ts').then(({ FourRoomManager }) => { new FourRoomManager({ to: () => ({ emit() {} }) }); console.log('constructed'); });";
  const res = spawnSync(process.execPath, ['--import', 'tsx', '-e', code], { cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), encoding: 'utf8', timeout: 25_000 });
  check(res.status === 0 && res.stdout.includes('constructed'), `the sweep interval is unref()d: a process constructing a manager exits by itself (status ${res.status}${res.error ? `, ${res.error.code}` : ''})`);
}

console.log('\n=== 6. Disconnects ===');
{
  const g = newGame({ tc: { initialSeconds: 60, incrementSeconds: 0 } });
  g.mgr.spectate('SP', { roomId: g.id });
  g.clear();
  g.mgr.handleDisconnect('S1');
  const updates = eventsOf(g.io, 'four_seat_update');
  check(updates.length === 4 && !updates.some((e) => e.id === 'S1') && ['S0', 'S2', 'S3', 'SP'].every((id) => updates.some((e) => e.id === id)), 'a disconnect tells everyone EXCEPT the disconnected socket (seats and spectators)');
  check(updates[0].payload.seats[1].connected === false && updates[0].payload.seats[0].connected === true, '...Blue is shown as not connected');
  check(g.room().seats[1].socketId === null && g.mgr.socketToSeat.has('S1') === false, 'the seat keeps its identity but has no socket');
  const mv = g.mgr.makeMove('S1', { roomId: g.id, from: 'b5', to: 'd5' });
  check(mv.ok === false, 'the dead socket cannot act');
  g.playFirst(0);
  g.clear();
  mock.timers.tick(60_000); // Blue (disconnected) is on move and runs out of time like anyone
  check(eventsOf(g.io, 'four_state', 'S0').length === 1 && g.state().status[1] === 'dead-king', "a disconnected seat's clock keeps running: it flags and is eliminated like anyone");
}
{
  const g = newGame();
  g.mgr.handleDisconnect('S2');
  g.clear();
  const back = g.mgr.rejoin('S2b', { roomId: g.id, playerToken: g.tokens[2] });
  const updates = eventsOf(g.io, 'four_seat_update');
  check(back.ok && updates.length === 4 && updates[0].payload.seats[2].connected === true, 'rejoining shows the seat connected again to everyone (including the rejoiner)');
  g.mgr.handleDisconnect('NOBODY');
  g.mgr.spectate('SP', { roomId: g.id });
  g.mgr.handleDisconnect('SP');
  check(g.room().spectators.size === 0 && g.mgr.socketToSpectating.size === 0, 'a spectator that disconnects is removed; an unknown socket is a harmless no-op');
}

console.log('\n=== 7. Chat ===');
{
  const g = newGame({ names: ['Ann', 'Ben', 'Cy', 'Di'] });
  g.mgr.spectate('SP', { roomId: g.id });
  g.clear();
  const ack = g.mgr.sendChat('S1', { roomId: g.id, text: '  hello all  ' });
  const chats = eventsOf(g.io, 'four_chat_message');
  check(ack.ok === true && chats.length === 4 && ['S0', 'S2', 'S3', 'SP'].every((id) => chats.some((e) => e.id === id)), 'a message goes to the other three seats and the spectator');
  check(!chats.some((e) => e.id === 'S1'), '...and is NOT echoed to its sender');
  check(chats[0].payload.fromSeat === 1 && chats[0].payload.name === 'Ben' && chats[0].payload.text === 'hello all' && typeof chats[0].payload.sentAt === 'number', '...trimmed, with the sender\'s seat and name (never a token or id)');
  check(g.mgr.sendChat('S1', { roomId: g.id, text: 'again' }).ok === false, 'a second message within the minimum interval is refused');
  mock.timers.tick(FOUR_CHAT_MIN_INTERVAL_MS - 1);
  check(g.mgr.sendChat('S1', { roomId: g.id, text: 'again' }).ok === false, '...still refused 1 ms before the interval is up');
  mock.timers.tick(1);
  check(g.mgr.sendChat('S1', { roomId: g.id, text: 'again' }).ok === true, '...and allowed exactly when it is');
  check(g.mgr.sendChat('S0', { roomId: g.id, text: 'other seats are not slowed by Ben' }).ok === true, 'the limit is per seat');
  mock.timers.tick(2000);
  g.clear();
  g.mgr.sendChat('S2', { roomId: g.id, text: 'x'.repeat(900) });
  check(eventsOf(g.io, 'four_chat_message')[0].payload.text.length === 500, 'a long message is cut to 500 characters, not refused');
  mock.timers.tick(2000);
  const bad = (payload, re, what) => {
    const r = g.mgr.sendChat('S3', payload);
    assert.equal(r.ok, false, what);
    assert.match(r.error, re, what);
    passed++;
    console.log(`  ok  ${what}`);
  };
  bad({ roomId: g.id, text: '   ' }, /empty/, 'an empty message is refused');
  bad({ roomId: g.id, text: 42 }, /empty/, 'a non-text message is refused');
  bad({ roomId: g.id }, /empty/, 'a missing text is refused');
  bad({ roomId: 'other', text: 'hi' }, /No active game/, 'chat to a room the socket is not in is refused');
  const sp = g.mgr.sendChat('SP', { roomId: g.id, text: 'can I talk?' });
  check(sp.ok === false && /No active game/.test(sp.error), 'a spectator cannot send');
  g.resign(3);
  mock.timers.tick(2000);
  check(g.mgr.sendChat('S3', { roomId: g.id, text: 'gg' }).ok === true, 'an eliminated seat can still chat (it is watching the rest)');
  g.resign(0);
  g.resign(1);
  const afterEnd = g.mgr.sendChat('S2', { roomId: g.id, text: 'late' });
  check(afterEnd.ok === false, 'no chat once the game is over');
}

console.log('\n=== 8. Spectating ===');
{
  const g = newGame({ names: ['Ann', 'Ben', 'Cy', 'Di'] });
  g.playFirst();
  mock.timers.tick(1500);
  const ack = g.mgr.spectate('SP', { roomId: g.id });
  check(ack.ok === true && ack.state.roomId === g.id && ack.state.seq === 1 && ack.state.state === g.fp() && ack.state.log.length === 1, 'spectating returns the whole room state: snapshot, seq, move list');
  check(ack.state.seat === undefined && JSON.stringify(ack).indexOf(g.tokens[0]) < 0 && JSON.stringify(ack).indexOf('S0') < 0, '...with no seat, no token and no socket id');
  check(JSON.stringify(ack.state.clocksMs) === '[600000,598500,600000,600000]', '...and live clocks');
  g.clear();
  g.playFirst();
  g.mgr.sendChat('S0', { roomId: g.id, text: 'hi' });
  g.mgr.handleDisconnect('S3');
  check(['four_state', 'four_chat_message', 'four_seat_update'].every((ev) => eventsOf(g.io, ev, 'SP').length === 1), 'a spectator receives every four_state, chat message and seat update');
  const forbidden = g.mgr.makeMove('SP', { roomId: g.id, from: 'e2', to: 'e4' });
  check(forbidden.ok === false, 'and cannot move');
  const player = g.mgr.spectate('S0', { roomId: g.id });
  check(player.ok === false && /playing/.test(player.error), 'a player cannot spectate (its own game or any)');
  const unknown = g.mgr.spectate('SP2', { roomId: 'nope' });
  check(unknown.ok === false && /not found/.test(unknown.error), 'spectating an unknown game is refused');
  const bad = g.mgr.spectate('SP2', null);
  check(bad.ok === false, '...as is a null payload');
  g.mgr.stopSpectating('SP');
  g.clear();
  g.playFirst();
  check(eventsOf(g.io, 'four_state', 'SP').length === 0, 'after stopSpectating nothing more is sent to it');
  // two games: a spectator watches one at a time
  g.mgr.spectate('SP3', { roomId: g.id });
  const second = g.mgr.createRoom({ seats: [{ kind: 'human', socketId: 'U0', name: 'u0' }, { kind: 'human', socketId: 'U1', name: 'u1' }, { kind: 'bot', socketId: null, name: 'B', elo: 1200 }, { kind: 'bot', socketId: null, name: 'B', elo: 1200 }], timeControl: TC });
  g.mgr.spectate('SP3', { roomId: second.roomId });
  check(!g.room().spectators.has('SP3') && g.mgr.rooms.get(second.roomId).spectators.has('SP3'), 'a spectator watches one game at a time: starting another leaves the first');
}
{
  const g = newGame({ names: ['Ann', 'Ben', 'Cy', 'Di'] });
  const second = g.mgr.createRoom({ seats: [{ kind: 'human', socketId: 'U0', name: 'Uno' }, { kind: 'human', socketId: 'U1', name: 'Dos' }, { kind: 'bot', socketId: null, name: 'Robo', elo: 1200 }, { kind: 'bot', socketId: null, name: 'Robo', elo: 1200 }], timeControl: { initialSeconds: 180, incrementSeconds: 2 }, timeControlLabel: '3 | 2' });
  const list = g.mgr.listActiveGames();
  check(list.length === 2 && list.some((x) => x.roomId === g.id) && list.some((x) => x.roomId === second.roomId), 'the active-games list has every game in progress');
  const text = JSON.stringify(list);
  check(!g.tokens.some((t) => text.includes(t)) && !['S0', 'S1', 'S2', 'S3', 'U0', 'U1'].some((id) => text.includes(`"${id}"`)) && !/socket/i.test(text), '...with no token and no socket id anywhere in it');
  const entry = list.find((x) => x.roomId === second.roomId);
  check(entry.timeControlLabel === '3 | 2' && entry.seats.map((s) => `${s.name}:${s.kind}`).join() === 'Uno:human,Dos:human,Robo:bot,Robo:bot', '...each with its label and its four seats (name and kind)');
  g.resign(0);
  g.resign(1);
  g.resign(2);
  check(g.mgr.listActiveGames().length === 1, 'a finished game drops out of the list');
}

console.log('\n=== 8b. The spectator cap and the active-games list (W4) ===');
{
  check(FOUR_MAX_SPECTATORS_PER_ROOM === 50 && FOUR_ACTIVE_GAMES_LIST_MAX === 100, 'a room holds at most 50 spectators and the list at most 100 games');
  const g = newGame();
  const room = g.room();
  for (let i = 0; i < 50; i++) assert.ok(g.mgr.spectate(`SPC${i}`, { roomId: g.id }).ok, `spectator ${i} is accepted`);
  check(room.spectators.size === 50, 'fifty spectators are accepted');
  const over = g.mgr.spectate('SPC50', { roomId: g.id });
  check(over.ok === false && /too many spectators/.test(over.error) && room.spectators.size === 50 && !g.mgr.socketToSpectating.has('SPC50'), 'the 51st is refused with a message and is not registered anywhere');
  check(g.mgr.spectate('SPC0', { roomId: g.id }).ok === true && room.spectators.size === 50, 'a spectator already watching this room is never refused by the cap (asking again is idempotent)');
  g.mgr.stopSpectating('SPC1');
  check(g.mgr.spectate('SPC50', { roomId: g.id }).ok === true && room.spectators.size === 50, 'as soon as one leaves, the next is accepted');
  // a refused request must not make the socket lose the game it was already watching
  const other = g.mgr.createRoom({ seats: [{ kind: 'human', socketId: 'OT0', name: 'o0' }, { kind: 'human', socketId: 'OT1', name: 'o1' }, { kind: 'bot', socketId: null, name: 'B', elo: 1200 }, { kind: 'bot', socketId: null, name: 'B', elo: 1200 }], timeControl: TC });
  const otherRoom = g.mgr.rooms.get(other.roomId);
  check(g.mgr.spectate('SPY', { roomId: other.roomId }).ok === true && otherRoom.spectators.has('SPY'), 'a spectator watches another game');
  const refused = g.mgr.spectate('SPY', { roomId: g.id });
  check(refused.ok === false && otherRoom.spectators.has('SPY') && g.mgr.socketToSpectating.get('SPY') === other.roomId, 'a refused request (the full room) leaves it watching the game it was already watching');
  clearTimeout(otherRoom.clockTimer);
  otherRoom.clockTimer = null;
}
{
  const mgr = new FourRoomManager(stubIo());
  const created = [];
  for (let i = 0; i < 105; i++) {
    created.push(mgr.createRoom({ seats: [{ kind: 'human', socketId: `LA${i}`, name: `a${i}` }, { kind: 'human', socketId: `LB${i}`, name: `b${i}` }, { kind: 'bot', socketId: null, name: 'Bot', elo: 1200 }, { kind: 'bot', socketId: null, name: 'Bot', elo: 1200 }], timeControl: TC, timeControlLabel: `room ${i}` }).roomId);
  }
  const list = mgr.listActiveGames();
  check(list.length === 100, '105 games in progress: the list has the 100 allowed');
  check(list[0].roomId === created[104] && list[0].timeControlLabel === 'room 104' && list.at(-1).roomId === created[5], 'newest first: the last game created leads, and the five OLDEST are the ones left out');
  check(list.every((entry, i) => i === 0 || Number(list[i - 1].timeControlLabel.slice(5)) === Number(entry.timeControlLabel.slice(5)) + 1), '...strictly newest to oldest, with no gap or repeat');
  for (const room of mgr.rooms.values()) {
    clearTimeout(room.clockTimer);
    room.clockTimer = null;
  }
}

console.log('\n=== 9. Rate limits ===');
{
  const g = newGame();
  g.stopTimer();
  const results = [];
  for (let i = 0; i < FOUR_MOVE_RATE_LIMIT.max + 1; i++) results.push(g.mv(1, 'b5', 'd5')); // Blue spams while it is Red's turn
  check(results.slice(0, FOUR_MOVE_RATE_LIMIT.max).every((r) => /Not your turn/.test(r.error)) && /slow down/.test(results.at(-1).error), `${FOUR_MOVE_RATE_LIMIT.max} calls in a second are answered normally (here: refused as out of turn); the next is rate-limited - illegal attempts count`);
  check(g.mv(0, g.firstMove(0).from, g.firstMove(0).to).ok === true, "the limit is per seat: Red's own move is not affected by Blue's spam");
  mock.timers.tick(FOUR_MOVE_RATE_LIMIT.windowMs - 1);
  check(/slow down/.test(g.mv(1, 'b5', 'd5').error), '999 ms later Blue is still limited');
  mock.timers.tick(1);
  const after = g.mv(1, g.firstMove(1).from, g.firstMove(1).to);
  check(after.ok === true, 'at exactly 1000 ms the window has passed and Blue can move');
}

console.log('\n=== 10. Hostile input never throws and never changes a game ===');
{
  const g = newGame();
  g.stopTimer();
  const fp = g.fp();
  const seq = g.seq();
  const sent = g.io.events.length;
  const hostile = [undefined, null, 0, -1, NaN, Infinity, '', 'x', '__proto__', true, [], [[]], {}, { roomId: {} }, { roomId: g.id, from: {}, to: [] }, { roomId: g.id, from: 'e2', to: 'e4', promotion: {} }, { roomId: g.id, text: Symbol('x') }, JSON.parse('{"__proto__":{"roomId":"x"}}'), { get roomId() { throw new Error('boom'); } }];
  let calls = 0;
  for (const payload of hostile) {
    for (const call of [
      () => g.mgr.makeMove('S0', payload),
      () => g.mgr.makeMove(payload, payload),
      () => g.mgr.resign('STRANGER', payload),
      () => g.mgr.rejoin('H', payload),
      () => g.mgr.sendChat('S0', payload),
      () => g.mgr.spectate('H', payload),
    ]) {
      try {
        const r = call();
        assert.ok(r === undefined || typeof r.ok === 'boolean', 'an ack is returned');
      } catch (err) {
        if (!(err.message === 'boom')) assert.fail(`threw on ${String(payload)}: ${err.message}`);
      }
      calls++;
    }
  }
  assert.equal(g.fp(), fp);
  assert.equal(g.seq(), seq);
  check(calls === hostile.length * 6, `${calls} hostile calls across six entry points: none changed the game (a getter that throws is the caller's own object, not wire input)`);
  check(g.io.events.length === sent, 'and nothing at all was published');
}

console.log('\n=== 11. commit() is the only thing that changes a game (source-level pin) ===');
{
  const src = fs.readFileSync(new URL('../src/game/fourPlayerRooms.ts', import.meta.url), 'utf8').split('\r\n').join('\n');
  const start = src.indexOf('  private commit(room: FourRoom, step: CommitStep): void {');
  check(start > 0, 'the funnel exists as private commit()');
  let depth = 0;
  let end = start;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}' && --depth === 0) {
      end = i;
      break;
    }
  }
  const body = src.slice(start, end + 1);
  const outside = src.slice(0, start) + src.slice(end + 1);
  const mutation = /\broom\.(state|clock|seq|turnStartedAt)\s*(=(?!=)|\+\+|--|\+=|-=)|\+\+\s*room\.seq/g;
  const inside = body.match(mutation) ?? [];
  const elsewhere = outside.match(mutation) ?? [];
  check(['room.state =', 'room.clock =', 'room.turnStartedAt =', 'room.seq++'].every((s) => body.includes(s)), 'commit() assigns the position, the clocks, the turn timer base and seq');
  check(inside.length === 4 && elsewhere.length === 0, `no other code assigns room.state / clock / seq / turnStartedAt (inside commit: ${inside.length}, anywhere else: ${elsewhere.length})`);
  check((outside.match(/this\.io\.to\(/g) ?? []).length === 1, 'every send goes through the one emit() helper (a failing socket cannot abort a funnel)');
  check(/private finish\([\s\S]{0,200}status = 'finished';[\s\S]{0,400}this\.finishedRooms\.set\([\s\S]{0,700}this\.broadcast\(room, 'four_game_over'/.test(src), 'finish() records the result BEFORE it sends anything');
  check((src.match(/'four_game_over'/g) ?? []).length === 1, 'four_game_over is sent from exactly ONE place, so no way of ending a game can skip the record-first rule');
}

console.log('\n=== 12. Random full games, move by move against an independent engine replay ===');
{
  let games = 0;
  let plies = 0;
  let finished = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const seatRng = 90_000 + seed;
    const g = newGame({ rng: mulberry32(seatRng), tc: { initialSeconds: 3600, incrementSeconds: 0 } });
    g.mgr.spectate('SP', { roomId: g.id });
    const script = mulberry32(seed);
    const refRng = mulberry32(seatRng);
    let ref = E.initialState();
    let publishedSeq = 0;
    for (let step = 0; step < 700 && g.mgr.rooms.has(g.id); step++) {
      const seat = ref.turn;
      const roll = script();
      if (roll < 0.012) {
        const active = E.activeSeats(ref);
        const who = active[Math.floor(script() * active.length)];
        const ack = g.resign(who);
        assert.equal(ack.ok, true, `[seed ${seed}] resign ack`);
        ref = E.resign(ref, who, refRng, 'resign').state;
      } else {
        const moves = E.legalMoves(ref, seat);
        const move = moves[Math.floor(script() * moves.length)];
        const letter = move.flags & E.FLAG_PROMOTION ? 'qrbn'[E.PROMOTABLE_TYPES.indexOf(E.promotionOf(move))] : undefined;
        const ack = g.mv(seat, E.squareName(move.from), E.squareName(move.to), letter);
        assert.equal(ack.ok, true, `[seed ${seed}] move ack: ${JSON.stringify(ack)}`);
        ref = E.playMove(ref, move, refRng).state;
      }
      publishedSeq++;
      plies++;
      const stateText = E.serialize(ref);
      const last = eventsOf(g.io, 'four_state').at(-1).payload;
      assert.equal(last.state, stateText, `[seed ${seed}, step ${step}] the published position differs from the independent replay`);
      assert.equal(last.seq, publishedSeq, `[seed ${seed}] seq is contiguous`);
      mock.timers.tick(Math.floor(script() * 3000));
    }
    // every seat and the spectator saw the same states, in order, with no gap
    const perSocket = (id) => eventsOf(g.io, 'four_state', id).map((e) => e.payload);
    const reference = perSocket('S0');
    for (const id of ['S1', 'S2', 'S3', 'SP']) {
      const mine = perSocket(id);
      assert.equal(mine.length, reference.length, `[seed ${seed}] ${id} received the same number of states`);
      mine.forEach((p, i) => assert.equal(p, reference[i], `[seed ${seed}] ${id} state ${i} is the same payload`));
    }
    assert.deepEqual(reference.map((p) => p.seq), reference.map((_, i) => i + 1), `[seed ${seed}] seq runs 1..N with no gap or repeat`);
    if (ref.result) {
      finished++;
      const over = eventsOf(g.io, 'four_game_over', 'S0');
      assert.equal(over.length, 1, `[seed ${seed}] exactly one game over`);
      assert.deepEqual(over[0].payload.winners, ref.result.winners, `[seed ${seed}] winners match the replay`);
      assert.deepEqual(over[0].payload.scores, [...ref.score], `[seed ${seed}] scores match the replay`);
      assert.equal(over[0].payload.reason, ref.result.reason, `[seed ${seed}] reason matches the replay`);
      assert.equal(g.mgr.rooms.has(g.id), false, `[seed ${seed}] finished room removed`);
    }
    games++;
  }
  check(games === 10 && plies > 1000, `${games} seeded games (${plies} actions, ${finished} played to a result): every published position equals the independent replay's, seq is contiguous, all four seats and the spectator see identical payloads, and each result matches`);
}

console.log('\n=== 13. Two games at once do not touch each other ===');
{
  const a = newGame();
  const mgr = a.mgr;
  const b = mgr.createRoom({ seats: [{ kind: 'human', socketId: 'B0', name: 'b0' }, { kind: 'human', socketId: 'B1', name: 'b1' }, { kind: 'bot', socketId: null, name: 'x', elo: 1200 }, { kind: 'bot', socketId: null, name: 'x', elo: 1200 }], timeControl: { initialSeconds: 60, incrementSeconds: 0 } });
  const roomB = () => mgr.rooms.get(b.roomId);
  const fpA = a.fp();
  const moveB = mgr.makeMove('B0', { roomId: b.roomId, from: 'e2', to: 'e4' });
  check(moveB.ok === true && a.fp() === fpA && a.seq() === 0 && roomB().seq === 1, 'a move in one game changes only that game');
  // B0 sits at seat 0 in game B. In game A it is ALSO Red's (seat 0's) turn - so if the seat were taken from the socket without checking
  // WHICH room the socket is in, B0 could play Red's move in game A.
  const redInA = a.firstMove(0);
  const fpBefore = a.fp();
  const cross = mgr.makeMove('B0', { roomId: a.id, from: redInA.from, to: redInA.to });
  check(cross.ok === false && /No active game/.test(cross.error) && a.fp() === fpBefore, 'a socket seated at seat 0 in game B cannot play seat 0\'s move in game A, even with the right room id');
  check(mgr.resign('B0', { roomId: a.id }).ok === false && a.state().status[0] === 'active', '...nor resign Red there');
  check(mgr.sendChat('B0', { roomId: a.id, text: 'hi' }).ok === false, '...nor chat there');
  a.stopTimer();
  mock.timers.tick(61_000);
  check(roomB().state.status[1] === 'dead-king' || roomB().state.status[0] === 'dead-king', "game B's 60 s clocks fire on their own schedule...");
  check(a.room().state.status.every((s) => s === 'active'), "...while game A (10 minutes) is untouched");
}

console.log('\n=== 14. Cost ===');
{
  const g = newGame({ rng: mulberry32(5), tc: { initialSeconds: 3600, incrementSeconds: 0 } });
  const script = mulberry32(11);
  let n = 0;
  let worst = 0;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 1000 && g.mgr.rooms.has(g.id); i++) {
    const moves = E.legalMoves(g.state(), g.state().turn);
    const m = moves[Math.floor(script() * moves.length)];
    const s = process.hrtime.bigint();
    const ack = g.mv(g.state().turn, E.squareName(m.from), E.squareName(m.to), m.flags & E.FLAG_PROMOTION ? 'q' : undefined);
    const took = Number(process.hrtime.bigint() - s) / 1e6;
    worst = Math.max(worst, took);
    assert.ok(ack.ok);
    n++;
    mock.timers.tick(100);
  }
  const total = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`      ${n} moves with 4 stub sockets: mean ${(total / n).toFixed(3)} ms per move, worst ${worst.toFixed(2)} ms`);
  check(n >= 900 && total / n < 5 && worst < 100, 'a move (legality check, engine, serialize, four broadcasts) costs well under 5 ms on average and never blocks the loop for long');
}

console.log('\n=== 9. The starting snapshot is ONE snapshot (found by the first real-socket run, W6) ===');
{
  // Every other test here freezes Date, so a clock read once per recipient and a clock read once look the same. Make time MOVE on every read:
  // if createRoom reads the clock inside its per-recipient loop, each player's starting clocks differ.
  const realNow = Date.now;
  let t = 1_700_000_000_000;
  Date.now = () => (t += 1);
  let g;
  try {
    g = newGame({ names: ['Ann', 'Ben', 'Cy', 'Di'] });
  } finally {
    Date.now = realNow;
  }
  const found = eventsOf(g.io, 'four_match_found').map((e) => e.payload);
  check(found.length === 4, 'four players were each sent a four_match_found');
  check(new Set(found.map((p) => JSON.stringify(p.clocksMs))).size === 1, 'all four starting clocks are identical even when the wall clock advances on every read');
  check(new Set(found.map((p) => JSON.stringify(p.seats))).size === 1 && new Set(found.map((p) => p.state)).size === 1, '...and so are the seats and the position');
  check(found.every((p) => p.seq === 0) && new Set(found.map((p) => p.playerToken)).size === 4, '...while each player still gets their own token and seat number');
  const live = g.mgr.rejoin(g.sockets[0] + '.x', { roomId: g.id, playerToken: g.tokens[0] });
  check(live.ok === true && live.state.clocksMs.length === 4, '(a rejoin answer, unlike a broadcast, is a fresh reading taken when it is asked for - that is intended)');
}

console.log('\n=== 10. Chaturaji in a room: the 8 x 8 board on the wire, squares named on THAT board (Chaturaji W1) ===');
{
  const CJ = E.CHATURAJI_RULES;
  const g = newGame({ variant: 'chaturaji', names: ['Ann', 'Ben', 'Cy', 'Di'] });
  const found = eventsOf(g.io, 'four_match_found').map((e) => e.payload);
  check(found.length === 4 && found.every((p) => p.variant === 'chaturaji'), 'every four_match_found names the game: variant "chaturaji" (the echo a client checks)');
  check(new Set(found.map((p) => p.state)).size === 1 && found[0].state === E.serialize(E.initialState(CJ)) && found[0].state.split(' ')[0].split('/').length === 8, '...with the 8-row Chaturaji start snapshot');
  check(E.deserialize(found[0].state, CJ).turn === 0, 'Red is to move');

  const ok = g.mv(0, 'a2', 'a3');
  check(ok.ok === true && ok.seq === 1, `Red plays a2-a3 (squares are the 8 x 8 board's): accepted (${JSON.stringify(ok)})`);
  const p = eventsOf(g.io, 'four_state').at(-1).payload;
  check(p.move.from === 'a2' && p.move.to === 'a3' && p.move.label === 'a2-a3' && p.log?.text !== 'x', '...and the move is described on that board: from a2, to a3, label "a2-a3"');
  check(E.deserialize(p.state, CJ).turn === 1 && E.listPieces(E.deserialize(p.state, CJ)).includes('rP@a3'), '...Blue is to move and the pawn stands on a3 in the snapshot');
  check(g.mv(1, 'b5', 'd5').error === 'Illegal move.', 'a pawn double step is refused (there is none in Chaturaji)');
  check(g.mv(1, 'a9', 'a8').error === 'Invalid move.' && g.mv(1, 'i1', 'a1').error === 'Invalid move.', '...and squares off the 8 x 8 board (rank 9, file i) are refused by the payload check, against THIS room\'s board - not misread as cross-board squares');
  check(g.mv(1, 'a1', 'a2').error === 'Illegal move.', '...while a1 / a2 (cut corners on the cross board, playable here) are valid squares: refused only because they are not Blue\'s');
  check(g.mv(1, 'b5', 'c5').ok === true, '...while a legal Blue step is accepted');

  // a promotion with no piece named is the boat; asking for a queen is illegal here
  const h = newGame({ variant: 'chaturaji' });
  h.setPosition(['rK@a1', 'bK@a8', 'yK@h8', 'gK@h1', 'rP@c7'], { rules: CJ, turn: 0 });
  check(h.mv(0, 'c7', 'c8', 'q').error === 'Illegal move.', 'a promotion to a queen is refused');
  const promo = h.mv(0, 'c7', 'c8');
  const pp = eventsOf(h.io, 'four_state').at(-1).payload;
  check(promo.ok === true && pp.move.promotion === 'r' && pp.move.label === 'c7-c8=R' && E.listPieces(E.deserialize(pp.state, CJ)).includes('rT@c8'), 'a promotion with no piece named is accepted as the boat (a promoted rook), reported as "=R"');

  // a king capture is eliminated, announced and scored through the room; the end of the game carries the score
  const k = newGame({ variant: 'chaturaji' });
  k.setPosition(['rK@a1', 'rR@d4', 'bK@d8', 'yK@h8', 'gK@h1'], { rules: CJ, turn: 0 });
  check(k.mv(0, 'd4', 'd8').ok === true, 'Red captures Blue\'s king');
  const kp = eventsOf(k.io, 'four_state').at(-1).payload;
  check(kp.events.some((e) => e.kind === 'eliminated' && e.seat === 1 && e.reason === 'kingCaptured' && e.credit === 0), '...the eliminated event reaches everyone (reason kingCaptured, credit Red)');
  const after = E.deserialize(kp.state, CJ);
  check(after.score[0] === 3 && after.status[1] === 'frozen' && after.turn === 2, '...Red has 3, Blue is out and the turn passed to Yellow');

  const e = newGame({ variant: 'chaturaji' });
  e.setPosition(['rK@a1', 'rR@d4', 'gK@d8'], { rules: CJ, turn: 0, status: ['active', 'frozen', 'frozen', 'active'], score: [0, 0, 20, 0] });
  check(e.mv(0, 'd4', 'd8').ok === true, 'the last king falls');
  const over = eventsOf(e.io, 'four_game_over').at(-1)?.payload;
  check(!!over && over.reason === 'elimination' && JSON.stringify(over.winners) === '[2]' && JSON.stringify(over.scores) === '[3,0,20,0]', '...the game ends: the highest score (Yellow, 20) wins, not the survivor (Red, 3); the scores are points');
}

mock.timers.reset();
console.log(`\nAll ${passed} checks passed.`);
process.exit(0);
