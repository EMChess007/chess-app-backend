/**
 * 4 Player GIVEAWAY on the server (workstream W2; FOUR_PLAYER_GIVEAWAY_SPEC.md sections 3.4, 6 and 7): the `variant` plumbing through the room manager,
 * the matchmaker and the socket handlers, and the Giveaway bot over whole games - all in-process (stub io / fake sockets / Node fake timers; no server,
 * no database).
 *
 *   npm run test:fourplayerGiveaway        (tsx)
 *
 * Guarded here: (1) a room has exactly one variant, announced in every payload that describes it (match found, spectate, rejoin, the active-games list) and
 * 4 Player Chess traffic is unchanged; (2) the server enforces the mandatory capture itself; (3) every Giveaway ending (outOfPieces, stuck, lastStanding,
 * cap, flag fall, abandoned) reaches `four_game_over` with `scores` = PIECES LEFT; (4) the default bot of a room follows its variant, plays whole games with
 * no fault, and a takeover bot respects the forced capture; (5) lobbies are keyed by time control AND variant and can never mix; (6) the handlers accept an
 * optional variant, refuse an unknown one, and treat an old client's payload (no variant) as 4 Player Chess.
 */
import './fourplayer-test-env.mjs';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { registerFourPlayerHandlers } from '../src/game/fourPlayerHandlers.ts';
import { FourPlayerMatchmaker } from '../src/game/fourPlayerMatchmaking.ts';
import { FourRoomManager } from '../src/game/fourPlayerRooms.ts';
import * as E from '../src/game/fourPlayer/index.ts';
import { disposeAll, eventsOf, mulberry32, newGame, startFakeTimers, stubIo } from './fourplayer-test-kit.mjs';

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ok  ${message}`);
}
const { liveTimeouts } = startFakeTimers();
const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

const GA = E.GIVEAWAY_RULES;
const gpos = (g, pieces, options = {}) => g.setPosition(pieces, { rules: GA, ...options });
const KINGS = ['rK@h1', 'bK@a8', 'yK@g14', 'gK@n7'];
const overOf = (g, id = 'S0') => eventsOf(g.io, 'four_game_over', id).at(-1)?.payload;
const gameOvers = (g) => [0, 1, 2, 3].map((i) => eventsOf(g.io, 'four_game_over', `S${i}`).length);

console.log('\n=== 1. A room has one variant, and says so everywhere ===');
{
  const chess = newGame();
  const matchFound = [0, 1, 2, 3].map((i) => eventsOf(chess.io, 'four_match_found', `S${i}`)[0].payload);
  check(matchFound.every((p) => p.variant === 'ffa'), 'a room created without a variant is 4 Player Chess, and says `variant: "ffa"` to all four players');
  check(chess.room().variant === 'ffa' && E.serialize(E.initialState()) === matchFound[0].state, '...starting from the unchanged Chess snapshot');
  check(chess.mgr.listActiveGames()[0].variant === 'ffa', '...and the active-games list row says "ffa"');
  const spectate = chess.mgr.spectate('SPEC', { roomId: chess.id });
  check(spectate.ok && spectate.state.variant === 'ffa', '...as does a spectator\'s room state');
  const rejoin = chess.rejoin(1);
  check(rejoin.ok && rejoin.state.variant === 'ffa', '...and a rejoin answer');
  disposeAll();

  const giveaway = newGame({ variant: 'giveaway' });
  const found = [0, 1, 2, 3].map((i) => eventsOf(giveaway.io, 'four_match_found', `S${i}`)[0].payload);
  check(found.every((p) => p.variant === 'giveaway'), 'a Giveaway room announces `variant: "giveaway"` to all four players');
  const start = E.deserialize(found[0].state, GA);
  check(E.serialize(start) === E.serialize(E.initialState(GA)) && found[0].state.split(' ')[4] === '0', '...with the Giveaway start snapshot (no castling rights; the text format is the Chess one)');
  check(giveaway.room().state.rules.mode === 'giveaway' && giveaway.room().variant === 'giveaway', '...and the room plays under the Giveaway rules');
  check(giveaway.mgr.listActiveGames()[0].variant === 'giveaway', 'the active-games list tags it "giveaway"');
  const spec2 = giveaway.mgr.spectate('SPEC', { roomId: giveaway.id });
  check(spec2.ok && spec2.state.variant === 'giveaway', 'a spectator\'s room state carries the variant');
  const back = giveaway.rejoin(2);
  check(back.ok && back.state.variant === 'giveaway' && back.state.seat === 2, 'a rejoin answer carries the variant');
  disposeAll();

  const mgr = new FourRoomManager(stubIo());
  const seats = [0, 1, 2, 3].map((i) => ({ kind: 'human', socketId: `X${i}`, name: `P${i}` }));
  for (const variant of ['bughouse', 'Giveaway', '', null, 3]) {
    assert.throws(() => mgr.createRoom({ seats, timeControl: { initialSeconds: 600, incrementSeconds: 0 }, variant }), /createRoom: Unknown game mode/);
  }
  passed++;
  console.log('  ok  createRoom refuses an unknown variant (a programming error), including null and "" - it never falls back to Chess quietly');
  check(mgr.rooms.size === 0, '...and creates nothing when it does');
}

console.log('\n=== 2. The server enforces the mandatory capture itself ===');
{
  const g = newGame({ variant: 'giveaway' });
  gpos(g, ['rR@d5', 'bP@d9', ...KINGS], { turn: 0 });
  g.clear();
  const seq = g.seq();
  const quiet = g.mv(0, 'h1', 'h2');
  check(quiet.ok === false && quiet.error === 'Illegal move.' && g.seq() === seq && eventsOf(g.io, 'four_state').length === 0, 'a quiet move while a capture exists is refused ("Illegal move."), the room is untouched and nothing is sent');
  const rookQuiet = g.mv(0, 'd5', 'd4');
  check(rookQuiet.ok === false && g.seq() === seq, '...even the capturing piece\'s own quiet move');
  const capture = g.mv(0, 'd5', 'd9');
  const states = eventsOf(g.io, 'four_state');
  check(capture.ok === true && g.seq() === seq + 1 && states.length === 4, 'the capture is accepted: one four_state to each of the four players');
  check(states[0].payload.move.label === 'd5xd9' && states[0].payload.state === g.fp() && g.state().turn === 1, '...labelled d5xd9, the snapshot is the room\'s, and the turn passes to Blue');
  disposeAll();

  const chess = newGame();
  chess.setPosition(['rR@d5', 'bP@d9', ...KINGS], { turn: 0 });
  check(chess.mv(0, 'h1', 'h2').ok === true, 'the same position in a 4 Player Chess room: the quiet move is fine (captures are optional there)');
  disposeAll();
}

console.log('\n=== 3. Every Giveaway ending reaches four_game_over (scores = pieces left) ===');
{
  const base = liveTimeouts.size;
  // outOfPieces
  let g = newGame({ variant: 'giveaway' });
  gpos(g, ['rR@e5', 'gP@m5', 'rK@h1', 'bK@a8', 'yK@g14'], { turn: 0 });
  check(g.mv(0, 'e5', 'm5').ok, 'Red takes Green\'s last piece');
  let over = overOf(g);
  check(over.reason === 'outOfPieces' && over.winners.join() === '3' && over.scores.join() === '2,1,1,0', '...four_game_over: reason outOfPieces, Green wins, scores = pieces left [2,1,1,0]');
  check(gameOvers(g).every((n) => n === 1) && g.mgr.rooms.size === 0 && liveTimeouts.size === base, '...exactly one to each player, the room is gone and it left no timer behind');
  check(E.deserialize(over.state, GA).result?.reason === 'outOfPieces', '...and the payload\'s snapshot carries the result');
  const finished = g.rejoin(3);
  check(finished.ok === true && finished.finished === true && finished.gameOver.reason === 'outOfPieces' && finished.gameOver.scores.join() === '2,1,1,0', 'a late rejoin gets the same result (finished-room retention)');
  disposeAll();

  // stuck
  g = newGame({ variant: 'giveaway' });
  gpos(g, ['rP@g5', 'bP@f5', 'rK@h1', 'yK@g14', 'gK@n7'], { turn: 0 });
  check(g.mv(0, 'h1', 'h2').ok, 'Red makes a quiet move; Blue\'s only pawn is blocked');
  over = overOf(g);
  check(over.reason === 'stuck' && over.winners.join() === '1' && over.scores.join() === '2,1,1,1', '...four_game_over: reason stuck, Blue wins, scores [2,1,1,1]');
  disposeAll();

  // last standing, by resignations (one of them off-turn)
  g = newGame({ variant: 'giveaway' });
  gpos(g, KINGS, { turn: 0 });
  g.clear();
  check(g.resign(1).ok, 'Blue resigns off-turn');
  const resignState = eventsOf(g.io, 'four_state')[0].payload;
  check(resignState.actor === 'resign' && resignState.events.some((e) => e.kind === 'eliminated' && e.seat === 1 && e.reason === 'resign' && e.credit === null), '...a four_state (actor resign) with the eliminated event, no credit');
  check(E.deserialize(resignState.state, GA).status.join() === 'active,frozen,active,active' && g.state().turn === 0, '...Blue is frozen (its pieces are walls), the turn is still Red\'s');
  check(g.mv(1, 'a8', 'a9').ok === false, '...and Blue can no longer move');
  g.resign(2);
  check(overOf(g) === undefined, 'a second resignation: the game goes on');
  g.resign(3);
  over = overOf(g);
  check(over.reason === 'lastStanding' && over.winners.join() === '0' && over.scores.join() === '1,1,1,1', 'the third leaves Red alone: four_game_over lastStanding, Red wins, scores [1,1,1,1]');
  disposeAll();

  // the cap
  g = newGame({ variant: 'giveaway' });
  gpos(g, ['rK@h1', 'rP@e3', 'bK@a8', 'yK@g14', 'gK@n7'], { turn: 0, ply: 999 });
  g.mv(0, 'h1', 'h2');
  over = overOf(g);
  check(over.reason === 'cap' && over.winners.join() === '1,2,3' && over.scores.join() === '2,1,1,1', 'the ply cap: the seats with the FEWEST pieces share the win (Blue, Yellow, Green), scores [2,1,1,1]');
  disposeAll();

  // a flag fall
  g = newGame({ variant: 'giveaway', tc: { initialSeconds: 60, incrementSeconds: 0 } });
  g.clear();
  mock.timers.tick(60_001);
  const flag = eventsOf(g.io, 'four_state', 'S1')[0]?.payload;
  check(flag && flag.actor === 'clock' && flag.events.some((e) => e.kind === 'eliminated' && e.seat === 0 && e.reason === 'timeout'), 'Red\'s clock runs out: a four_state (actor clock) eliminates Red with reason timeout');
  check(g.state().status[0] === 'frozen' && g.state().turn === 1 && g.state().result === null && E.piecesLeft(g.state().cells)[0] === 16, '...Red is frozen, its 16 pieces stay as walls, the game goes on with Blue');
  disposeAll();

  // abandoned
  g = newGame({ variant: 'giveaway' });
  for (const seat of [0, 1, 2, 3]) g.disconnect(seat);
  mock.timers.tick(60_000); // past the 45 s all-gone countdown (nobody is connected to be told, so the result is read back through a rejoin)
  const ended = g.rejoin(0);
  over = ended.ok && ended.finished ? ended.gameOver : undefined;
  check(over && over.reason === 'abandoned' && over.winners.length === 0 && over.scores.join() === '16,16,16,16', 'every human gone: the game ends `abandoned`, no winners, scores (pieces left) [16,16,16,16]');
  disposeAll();
}

console.log('\n=== 4. The bots of a Giveaway room ===');
{
  const g0 = newGame({ variant: 'giveaway', bots: 3 });
  check(g0.mgr.chooseBot === E.chooseBotMoveFor, 'the room manager\'s DEFAULT bot chooser is the rules-dispatching one (so a Giveaway room can never get the Chess bot)');
  disposeAll();

  const errors = mock.method(console, 'error', () => {});
  const tally = new Map();
  let totalPlies = 0;
  const GAMES = 12;
  for (let seed = 1; seed <= GAMES; seed++) {
    const g = newGame({ variant: 'giveaway', bots: 3, elos: [null, 600 + seed * 150, 1200, 1700], rng: mulberry32(seed), botRng: mulberry32(seed * 3) });
    g.resign(0); // the only human leaves the game: three bots play it out, fast-forwarded
    for (let i = 0; i < 20_000 && g.mgr.rooms.has(g.id); i++) mock.timers.tick(1);
    const over = overOf(g);
    check(!g.mgr.rooms.has(g.id) && over, `game ${seed}: three Giveaway bots played the game to an end`);
    tally.set(over.reason, (tally.get(over.reason) ?? 0) + 1);
    const snapshots = eventsOf(g.io, 'four_state', 'S0').map((e) => E.deserialize(e.payload.state, GA));
    totalPlies += snapshots.length;
    assert.ok(snapshots.every((s) => s.score.every((v) => v === 0) && s.castling === 0), `game ${seed}: no points, no castling rights in any snapshot`);
    assert.ok(snapshots.every((s) => s.status[0] === 'frozen'), `game ${seed}: Red stays frozen throughout`);
    passed++;
    disposeAll();
  }
  check(errors.mock.calls.length === 0, `no bot ever returned a fault or an illegal move over ${GAMES} games (${totalPlies} published states): console.error was never called`);
  check([...tally.keys()].every((r) => ['outOfPieces', 'stuck', 'cap'].includes(r)), `every ending is a Giveaway rule ending (${JSON.stringify(Object.fromEntries(tally))})`);
  errors.mock.restore();

  // a takeover bot respects the forced capture
  const t = newGame({ variant: 'giveaway', graceMs: 1000, botRng: mulberry32(9) });
  gpos(t, ['yR@d12', 'rP@d9', 'rK@h1', 'bK@a8', 'yK@g14', 'gK@n7'], { turn: 2 });
  t.disconnect(2);
  t.clear();
  mock.timers.tick(1000);
  check(t.room().seats[2].controller === 'bot' && t.room().seats[2].botReason === 'takeover', 'Yellow\'s human is gone for the grace period: a bot takes the seat');
  mock.timers.tick(30_000);
  const taken = eventsOf(t.io, 'four_state', 'S0').find((e) => e.payload.actor === 'bot')?.payload;
  check(taken && taken.move.label === 'd12xd9' && taken.move.seat === 2, 'the takeover bot, on a position where Yellow must capture, plays the capture (d12xd9)');
  const retake = t.rejoin(2);
  check(retake.ok === true && retake.state.variant === 'giveaway' && t.room().seats[2].controller === 'human', 'the human retakes the seat; the answer still says giveaway');
  disposeAll();

  // 4 Player Chess bots still play with the default chooser (no fault) and under Chess rules
  const errors2 = mock.method(console, 'error', () => {});
  const c = newGame({ bots: 3, elos: [null, 1200, 1200, 1200], rng: mulberry32(4), botRng: mulberry32(5) });
  c.resign(0);
  for (let i = 0; i < 4000 && c.mgr.rooms.has(c.id); i++) mock.timers.tick(1);
  const chessOver = overOf(c);
  const chessStates = eventsOf(c.io, 'four_state', 'S0').map((e) => E.deserialize(e.payload.state));
  check(chessOver && ['elimination', 'cap', 'deadPosition'].includes(chessOver.reason) && chessStates.length > 40 && errors2.mock.calls.length === 0, `a 4 Player Chess room with the same default chooser still plays a whole game under Chess rules with no fault (${chessStates.length} states, ended ${chessOver?.reason})`);
  check(chessStates.some((st) => st.score.some((v) => v > 0)) && chessOver.scores.join() === chessStates.at(-1).score.join(), '...points were scored, and the game-over scores are the POINTS (unchanged for Chess)');
  errors2.mock.restore();
  disposeAll();
}



console.log('\n=== 5. The matchmaker: lobbies are keyed by time control AND variant ===');
{
  const started = [];
  const notes = [];
  const mm = new FourPlayerMatchmaker({ startGame: (...args) => started.push(args), notify: (id, update) => notes.push({ id, update }), fillWaitMs: 1000, randomInt: () => 0 });
  const TC = { initialSeconds: 300, incrementSeconds: 0 };
  const join = (id, variant) => mm.join({ socketId: id, userId: null, name: id, timeControl: TC, ...(variant === undefined ? {} : { variant }) });
  check(join('A', 'giveaway').ok && join('B').ok, 'a Giveaway player and a Chess player (no variant) join the same time control');
  check(mm.lobbySize(TC, 'giveaway') === 1 && mm.lobbySize(TC) === 1 && mm.lobbySize(TC, 'ffa') === 1 && mm.size() === 2, '...they sit in two different lobbies of one each (the default lobbySize is the Chess one)');
  check(notes.every((n) => n.update.queued === 1 && n.update.fillInMs === null), '...each is told "1 queued, no timer" - neither sees the other');
  mock.timers.tick(5000);
  check(started.length === 0, 'no timer runs and nothing starts, however long they wait (a lobby needs two of its own kind)');
  check(join('C', 'giveaway').ok, 'a second Giveaway player joins');
  check(mm.lobbySize(TC, 'giveaway') === 2 && mm.lobbySize(TC, 'ffa') === 1 && mm.lobbySize(TC) === 1, '...the Giveaway lobby has two, the Chess lobby still one (and `lobbySize(tc)` with no variant means the Chess one)');
  mock.timers.tick(1000);
  check(started.length === 1 && started[0][3] === 'giveaway' && started[0][0].filter((s) => s.kind === 'human').length === 2 && started[0][0].filter((s) => s.kind === 'bot').length === 2, 'the fill timer of the Giveaway lobby starts a GIVEAWAY game (variant passed to startGame) with its two humans and two bots');
  check(mm.lobbySize(TC, 'giveaway') === 0 && mm.lobbySize(TC, 'ffa') === 1 && mm.isQueued('B') && !mm.isQueued('A'), '...the Chess player is still waiting');
  join('D'); // a second Chess player
  mock.timers.tick(1000);
  check(started.length === 2 && started[1][3] === 'ffa', 'the Chess lobby\'s own timer starts a Chess game (variant "ffa")');
  for (const id of ['E', 'F', 'G', 'H']) join(id, 'giveaway');
  check(started.length === 3 && started[2][3] === 'giveaway' && started[2][0].every((s) => s.kind === 'human'), 'four Giveaway players start at once, all human');
  const bad = [];
  for (const variant of ['bughouse', 'Giveaway', '', null, 5, {}, []]) bad.push(mm.join({ socketId: 'Z', userId: null, name: 'Z', timeControl: TC, variant }));
  check(bad.every((r) => r.ok === false && r.error === 'Unknown game mode.') && !mm.isQueued('Z'), 'an unknown variant is refused with an error and never queued (including null and "")');
  const none = mm.join({ socketId: 'Y', userId: null, name: 'Y', timeControl: TC, variant: undefined });
  check(none.ok === true && mm.lobbySize(TC, 'ffa') === 1, 'an explicitly undefined variant is 4 Player Chess');
  mm.leave('Y');
}

console.log('\n=== 6. The handlers: an optional variant on four_join_queue ===');
{
  const connectionListeners = [];
  const events = [];
  const io = {
    events,
    on: (e, cb) => e === 'connection' && connectionListeners.push(cb),
    to: (id) => ({ emit: (event, payload) => events.push({ id, event, payload }) }),
  };
  const socket = (id) => {
    const listeners = new Map();
    const s = {
      id,
      connected: true,
      handshake: { auth: {} },
      on: (e, cb) => listeners.set(e, cb),
      async call(event, payload) {
        const replies = [];
        listeners.get(event)(payload, (r) => replies.push(r));
        for (let i = 0; i < 6; i++) await Promise.resolve();
        return replies;
      },
      disconnect() {
        s.connected = false;
        listeners.get('disconnect')?.();
      },
    };
    for (const cb of connectionListeners) cb(s);
    return s;
  };
  const { rooms, matchmaker } = registerFourPlayerHandlers(io, { matchmakerOptions: { fillWaitMs: 1000, randomInt: () => 0 }, roomOptions: { rng: mulberry32(1), botRng: mulberry32(2) } });
  const TC = { initialSeconds: 600, incrementSeconds: 0 };
  const [a, b, c, d, e] = ['A', 'B', 'C', 'D', 'E'].map(socket);
  const ra = await a.call('four_join_queue', { timeControl: TC, variant: 'giveaway' });
  const rb = await b.call('four_join_queue', { timeControl: TC, variant: 'giveaway' });
  check(ra[0].ok && rb[0].ok && matchmaker.lobbySize(TC, 'giveaway') === 2, 'two clients join with variant "giveaway": ack ok, queued together');
  const rc = await c.call('four_join_queue', { timeControl: TC }); // an OLD client
  const rd = await d.call('four_join_queue', { timeControl: TC });
  check(rc[0].ok && rd[0].ok && matchmaker.lobbySize(TC, 'ffa') === 2 && matchmaker.lobbySize(TC, 'giveaway') === 2, 'two OLD clients (no variant field at all) join the same time control: a separate Chess lobby');
  mock.timers.tick(1000);
  const foundOf = (id) => events.filter((x) => x.id === id && x.event === 'four_match_found').map((x) => x.payload);
  check(foundOf('A')[0]?.variant === 'giveaway' && foundOf('B')[0]?.variant === 'giveaway' && foundOf('A')[0].roomId === foundOf('B')[0].roomId, 'A and B are matched into one room whose four_match_found says "giveaway"');
  check(foundOf('C')[0]?.variant === 'ffa' && foundOf('D')[0]?.variant === 'ffa' && foundOf('C')[0].roomId !== foundOf('A')[0].roomId, 'C and D (old clients) are matched into a DIFFERENT room, which says "ffa"');
  check(E.deserialize(foundOf('A')[0].state, GA).castling === 0 && E.deserialize(foundOf('C')[0].state).castling !== 0, '...the Giveaway room starts with no castling rights, the Chess room with all of them');
  check(rooms.listActiveGames().map((g) => g.variant).sort().join() === 'ffa,giveaway', 'the active-games list shows one of each variant');
  const bad = [];
  for (const variant of ['Giveaway', 'chess', '', null, 7, {}, []]) bad.push((await e.call('four_join_queue', { timeControl: TC, variant }))[0]);
  check(bad.every((r) => r.ok === false && r.error === 'Unknown game mode.') && !matchmaker.isQueued('E'), 'an unknown variant is refused by the validator with its own message, and the socket is not queued');
  const explicit = await e.call('four_join_queue', { timeControl: TC, variant: 'ffa' });
  check(explicit[0].ok && matchmaker.lobbySize(TC, 'ffa') === 1, 'an explicit "ffa" queues for 4 Player Chess');
  const a2 = (await a.call('four_join_queue', { timeControl: TC, variant: 'giveaway' }))[0];
  check(a2.ok === false && /already in a game/.test(a2.error), 'a socket already seated in a Giveaway game cannot queue again');
  check(unhandled.length === 0, 'no unhandled rejection anywhere');
}

console.log(`\nAll ${passed} checks passed.`);
process.exit(0);
