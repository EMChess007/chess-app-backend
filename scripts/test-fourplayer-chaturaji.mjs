/**
 * CHATURAJI on the server (workstream W2; CHATURAJI_SPEC.md sections 6, 7 and 9): the 4-seat room manager running a Chaturaji game - the Chaturaji bot over
 * whole games, bots filling seats, takeover and hand-back, every ending reaching `four_game_over` with POINTS, the dead-king walk after a resignation or a
 * flag fall, and the matchmaker / handlers keeping the Chaturaji queue apart - all in-process (stub io / fake sockets / Node fake timers; no server, no
 * database). The real-socket counterpart is scenario 18 of test-fourplayer-online.mjs.
 *
 *   npm run test:fourplayerChaturaji        (tsx)
 *
 * Guarded here: (1) a Chaturaji room announces its variant everywhere and the other variants' traffic is unchanged; (2) the server applies Capture the King -
 * a move that leaves your own king attacked is accepted, a king capture eliminates and scores; (3) every ending (last king, ply cap, flag fall, no legal move,
 * resignation, abandoned) reaches `four_game_over` with the scores as POINTS, and a resigned / timed-out seat's king walks on; (4) the default bot of a room
 * follows its variant, plays whole games with no fault, a takeover bot takes a king it can take, and the human gets the seat back; (5) lobbies are keyed by
 * time control AND variant and three variants can never mix; (6) the handlers accept `variant: "chaturaji"` and echo it.
 */
import './fourplayer-test-env.mjs';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { registerFourPlayerHandlers } from '../src/game/fourPlayerHandlers.ts';
import { FourPlayerMatchmaker } from '../src/game/fourPlayerMatchmaking.ts';
import * as E from '../src/game/fourPlayer/index.ts';
import { disposeAll, eventsOf, mulberry32, newGame, startFakeTimers } from './fourplayer-test-kit.mjs';

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ok  ${message}`);
}
const { liveTimeouts } = startFakeTimers();
const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

const CJ = E.CHATURAJI_RULES;
const GEO = E.geometryOf(CJ); // the 8 x 8 board's square names (E.squareName is the 14 x 14 cross board's)
const cpos = (g, pieces, options = {}) => g.setPosition(pieces, { rules: CJ, ...options });
const KINGS = ['rK@a1', 'bK@a8', 'yK@h8', 'gK@h1'];
const overOf = (g, id = 'S0') => eventsOf(g.io, 'four_game_over', id).at(-1)?.payload;
const lastState = (g, id = 'S0') => eventsOf(g.io, 'four_state', id).at(-1)?.payload;
const decode = (snapshot) => E.deserialize(snapshot, CJ);

console.log('\n=== 1. A Chaturaji room announces its variant everywhere ===');
{
  const g = newGame({ variant: 'chaturaji', names: ['Ann', 'Ben', 'Cy', 'Di'] });
  const found = eventsOf(g.io, 'four_match_found').map((e) => e.payload);
  check(found.length === 4 && found.every((p) => p.variant === 'chaturaji'), 'four_match_found says variant "chaturaji" to all four players');
  check(g.room().variant === 'chaturaji' && E.variantOfRules(g.room().state.rules) === 'chaturaji', '...and the room plays under the Chaturaji rules');
  check(g.mgr.listActiveGames()[0].variant === 'chaturaji', 'the active-games list tags it "chaturaji"');
  const spectate = g.mgr.spectate('SP', { roomId: g.id });
  check(spectate.ok && spectate.state.variant === 'chaturaji' && spectate.state.state.split(' ')[0].split('/').length === 8, 'a spectator gets the variant and the 8-row board');
  const back = g.rejoin(1);
  check(back.ok && back.state.variant === 'chaturaji' && back.state.seat === 1, 'a rejoin answer carries the variant');
  const chess = newGame({});
  check(eventsOf(chess.io, 'four_match_found')[0].payload.variant === 'ffa' && chess.room().state.rules.mode === 'ffa' && chess.mgr.listActiveGames()[0].variant === 'ffa', 'a room created without a variant is still 4 Player Chess');
  disposeAll();
}

console.log('\n=== 2. The server applies Capture the King ===');
{
  // Red's king is attacked by Blue's rook, and Red ignores it: that is a legal move here (no check, no mate)
  let g = newGame({ variant: 'chaturaji' });
  cpos(g, ['rK@a1', 'rP@e2', 'bR@a8', 'bK@h8', 'yK@h7', 'gK@h1'], { turn: 0 });
  check(g.mv(0, 'e2', 'e3').ok === true, 'Red\'s king stands attacked and Red plays an unrelated pawn move: accepted (a check needs no answer)');
  check(g.mv(1, 'a8', 'a1').ok === true, 'Blue then captures Red\'s king');
  const st = lastState(g);
  check(st.events.some((e) => e.kind === 'eliminated' && e.seat === 0 && e.reason === 'kingCaptured' && e.credit === 1), '...four_state carries the elimination (reason kingCaptured, credit Blue)');
  const after = decode(st.state);
  check(after.score[1] === 3 && after.status[0] === 'frozen' && after.turn === 2, '...Blue scores 3, Red is out and the turn goes on to Yellow');
  check(g.mv(0, 'e3', 'e4').ok === false, '...and Red can no longer move');
  disposeAll();

  // a king may even walk into an attack
  g = newGame({ variant: 'chaturaji' });
  cpos(g, ['rK@a1', 'bR@b8', 'bK@h8', 'yK@h7', 'gK@h1'], { turn: 0 });
  check(g.mv(0, 'a1', 'b1').ok === true, 'a king may step onto a square a rook attacks (nothing checks it)');
  disposeAll();

  // a resignation is not a capture: the king stays on the board and walks
  g = newGame({ variant: 'chaturaji' });
  cpos(g, KINGS, { turn: 0 });
  g.clear();
  check(g.resign(1).ok === true, 'Blue resigns off-turn');
  const resign = lastState(g);
  check(resign.actor === 'resign' && resign.events.some((e) => e.kind === 'eliminated' && e.seat === 1 && e.reason === 'resign' && e.credit === null), '...a four_state (actor resign), no credit');
  check(decode(resign.state).status[1] === 'dead-king' && E.listPieces(decode(resign.state)).includes('bK@a8'), '...Blue is a dead king: the king is still on the board');
  g.mv(0, 'a1', 'a2');
  g.mv(2, 'h8', 'g8');
  g.mv(3, 'h1', 'g1');
  const walk = eventsOf(g.io, 'four_state', 'S0').flatMap((e) => e.payload.events).filter((e) => e.kind === 'deadKingMove' && e.seat === 1);
  const walked = decode(lastState(g).state);
  check(walk.length === 1 && walk[0].move.captured === 0 && !E.listPieces(walked).includes('bK@a8') && E.listPieces(walked).filter((p) => p.startsWith('bK@')).length === 1, 'after Red\'s next move Blue\'s dead king has taken one step off a8 (a deadKingMove event, still exactly one Blue king)');
  disposeAll();
}

console.log('\n=== 3. Every ending reaches four_game_over with points ===');
{
  const base = liveTimeouts.size;
  // the last king falls: the highest score wins, and the last seat gets +3 per king still on the board
  let g = newGame({ variant: 'chaturaji' });
  cpos(g, ['rK@a1', 'rR@d4', 'bK@a8', 'yK@h8', 'gK@d8'], { turn: 0, status: ['active', 'dead-king', 'dead-king', 'active'] });
  const reference = E.playMove(g.state(), E.legalMoves(g.state(), 0).find((m) => GEO.squareName(m.from) === 'd4' && GEO.squareName(m.to) === 'd8'), () => 0).state;
  check(g.mv(0, 'd4', 'd8').ok === true, 'Red takes the last active rival\'s king while two dead kings stay on the board');
  let over = overOf(g);
  check(over && over.reason === 'elimination' && over.scores.join() === [...reference.score].join() && over.winners.join() === reference.result.winners.join(), `four_game_over: elimination, scores ${JSON.stringify(over?.scores)} equal the engine's own result`);
  check(over.scores[0] === 9 && over.winners.join() === '0', '...Red: 3 for the king + 3 for each of the two kings left on the board = 9, and wins');
  check([0, 1, 2, 3].every((i) => eventsOf(g.io, 'four_game_over', `S${i}`).length === 1) && g.mgr.rooms.size === 0 && liveTimeouts.size === base, '...exactly one to each player, the room is gone and left no timer behind');
  check(decode(over.state).result?.reason === 'elimination', '...and the snapshot carries the result');
  const late = g.rejoin(2);
  check(late.ok && late.finished && late.gameOver.scores.join() === over.scores.join(), 'a late rejoin gets the same result (finished-room retention)');
  disposeAll();

  // the ply cap
  g = newGame({ variant: 'chaturaji' });
  cpos(g, [...KINGS, 'rP@e3'], { turn: 0, ply: 999, score: [1, 4, 2, 4] });
  g.mv(0, 'a1', 'a2');
  over = overOf(g);
  check(over && over.reason === 'cap' && over.winners.join() === '1,3' && over.scores.join() === '1,4,2,4', 'the ply cap: the highest score wins, a tie is shared (Blue and Green), scores are the points [1,4,2,4]');
  disposeAll();

  // a flag fall: the dead king walks
  g = newGame({ variant: 'chaturaji', tc: { initialSeconds: 60, incrementSeconds: 0 } });
  g.clear();
  mock.timers.tick(60_001);
  const flag = eventsOf(g.io, 'four_state', 'S1')[0]?.payload;
  check(flag && flag.actor === 'clock' && flag.events.some((e) => e.kind === 'eliminated' && e.seat === 0 && e.reason === 'timeout'), 'Red\'s clock runs out: a four_state (actor clock) eliminates Red with reason timeout');
  check(g.state().status[0] === 'dead-king' && g.state().turn === 1 && g.state().result === null, '...Red is a dead king and the game goes on with Blue');
  disposeAll();

  // a seat with no legal move is eliminated, without points
  g = newGame({ variant: 'chaturaji' });
  cpos(g, ['bK@h1', 'bP@g1', 'bP@g2', 'bP@h2', 'rK@a1', 'rN@f2', 'yK@h8', 'gK@a8'], { turn: 0 });
  g.clear();
  g.mv(0, 'a1', 'a2');
  const stuck = lastState(g);
  check(stuck.events.some((e) => e.kind === 'eliminated' && e.seat === 1 && e.reason === 'stalemate' && e.credit === null), 'Blue\'s king is attacked and boxed in by its own pawns: no legal move, eliminated as "stalemate", no credit');
  check(decode(stuck.state).score.join() === '0,0,0,0' && decode(stuck.state).turn === 2, '...nobody scores and the turn passes to Yellow');
  disposeAll();

  // resignations: a game of dead kings runs to the end (the cap or a king capture), never stalls
  g = newGame({ variant: 'chaturaji' });
  cpos(g, KINGS, { turn: 0 });
  g.resign(1);
  g.resign(2);
  check(overOf(g) === undefined && g.state().result === null, 'two resignations: the game goes on');
  g.resign(3);
  over = overOf(g);
  check(over && over.reason === 'elimination' && over.winners.join() === '0' && over.scores.join() === '9,0,0,0', 'the third leaves Red alone: elimination, Red wins; +3 for each of the three dead kings still on the board = [9,0,0,0]');
  disposeAll();

  // everyone gone
  g = newGame({ variant: 'chaturaji' });
  for (const seat of [0, 1, 2, 3]) g.disconnect(seat);
  mock.timers.tick(60_000);
  const ended = g.rejoin(0);
  over = ended.ok && ended.finished ? ended.gameOver : undefined;
  check(over && over.reason === 'abandoned' && over.winners.length === 0 && over.scores.join() === '0,0,0,0', 'every human gone: abandoned, no winners, scores (points) [0,0,0,0]');
  disposeAll();
}

console.log('\n=== 4. The bots of a Chaturaji room ===');
{
  const g0 = newGame({ variant: 'chaturaji', bots: 3 });
  check(g0.mgr.chooseBot === E.chooseBotMoveFor, 'the room manager\'s DEFAULT bot chooser is the rules-dispatching one (a Chaturaji room can never get the Chess bot)');
  // ...and what it does with a Chaturaji position is the Chaturaji bot's move at every ply of a seeded game, where the Chess bot would have played something else somewhere
  {
    let state = E.initialState(CJ);
    let differs = 0;
    const draw = (ply) => mulberry32(ply * 7 + 1);
    for (let ply = 0; ply < 80 && !state.result; ply++) {
      const mine = E.chooseChaturajiBotMove(state, 1500, draw(ply));
      const routed = g0.mgr.chooseBot(state, 1500, draw(ply));
      assert.deepEqual(routed, mine, `ply ${ply}: the room's chooser plays the Chaturaji bot's move`);
      if (JSON.stringify(E.chooseBotMove(state, 1500, draw(ply))) !== JSON.stringify(mine)) differs++;
      state = E.playMove(state, mine, () => 0).state;
    }
    passed++;
    // the other two games keep their own bots through the same chooser
    for (const [name, start, bot] of [['4 Player Chess', E.initialState(), E.chooseBotMove], ['4 Player Giveaway', E.initialState(E.GIVEAWAY_RULES), E.chooseGiveawayFourBotMove]]) {
      let position = start;
      let apart = 0;
      for (let ply = 0; ply < 40 && !position.result; ply++) {
        const own = bot(position, 1500, draw(ply));
        assert.deepEqual(g0.mgr.chooseBot(position, 1500, draw(ply)), own, `${name} ply ${ply}: the room's chooser plays that game's own bot`);
        if (JSON.stringify(E.chooseChaturajiBotMove(position, 1500, draw(ply))) !== JSON.stringify(own)) apart++;
        position = E.playMove(position, own, () => 0).state;
      }
      assert.ok(apart > 0, `${name}: the Chaturaji bot would have played differently somewhere`);
      passed += 2;
      console.log(`  ok  the room's chooser plays ${name}'s own bot at every ply of a 40-ply game (the Chaturaji bot would differ ${apart} times: not vacuous)`);
    }
    check(differs > 0,`...along 80 plies of a seeded game (the Chess bot would have chosen differently ${differs} times: the check is not vacuous)`);
  }
  disposeAll();

  const errors = mock.method(console, 'error', () => {});
  const tally = new Map();
  let totalPlies = 0;
  let kingCaptures = 0;
  const GAMES = 12;
  for (let seed = 1; seed <= GAMES; seed++) {
    const g = newGame({ variant: 'chaturaji', bots: 3, elos: [null, 600 + seed * 150, 1200, 1700], rng: mulberry32(seed), botRng: mulberry32(seed * 3) });
    g.resign(0); // the only human leaves: three bots play it out, fast-forwarded
    for (let i = 0; i < 40_000 && g.mgr.rooms.has(g.id); i++) mock.timers.tick(1);
    const over = overOf(g);
    check(!g.mgr.rooms.has(g.id) && over, `game ${seed}: three Chaturaji bots (and a dead king) played the game to an end`);
    tally.set(over.reason, (tally.get(over.reason) ?? 0) + 1);
    const states = eventsOf(g.io, 'four_state', 'S0').map((e) => e.payload);
    const snapshots = states.map((p) => decode(p.state));
    totalPlies += snapshots.length;
    kingCaptures += states.flatMap((p) => p.events).filter((e) => e.kind === 'eliminated' && e.reason === 'kingCaptured').length;
    assert.ok(snapshots.every((s) => s.castling === 0), `game ${seed}: no castling rights in any snapshot`);
    assert.ok(states.filter((p) => p.move).every((p) => /^[a-h][1-8]$/.test(p.move.from) && /^[a-h][1-8]$/.test(p.move.to)), `game ${seed}: every move is on the 8 x 8 board`);
    assert.deepEqual(over.scores, [...snapshots.at(-1).score], `game ${seed}: the game-over scores are the final points`);
    passed += 3;
    disposeAll();
  }
  check(errors.mock.calls.length === 0, `no bot ever returned a fault or an illegal move over ${GAMES} games (${totalPlies} published states): console.error was never called`);
  check([...tally.keys()].every((r) => ['elimination', 'cap'].includes(r)) && kingCaptures > 0, `every ending is a Chaturaji ending, and kings were captured (${JSON.stringify(Object.fromEntries(tally))}, ${kingCaptures} king captures)`);
  errors.mock.restore();

  // a takeover bot takes the king it can take, and the human gets the seat back
  const t = newGame({ variant: 'chaturaji', graceMs: 1000, botRng: () => 0 });
  cpos(t, ['yR@e5', 'rK@e1', 'bK@a8', 'yK@h8', 'gK@h1'], { turn: 2 });
  t.disconnect(2);
  t.clear();
  mock.timers.tick(1000);
  check(t.room().seats[2].controller === 'bot' && t.room().seats[2].botReason === 'takeover', 'Yellow\'s human is gone for the grace period: a bot takes the seat');
  mock.timers.tick(30_000);
  const taken = eventsOf(t.io, 'four_state', 'S0').find((e) => e.payload.actor === 'bot')?.payload;
  check(taken && taken.move.seat === 2 && taken.move.label === 'e5xe1', 'the takeover bot plays the king capture (e5xe1)');
  check(taken.events.some((e) => e.kind === 'eliminated' && e.seat === 0 && e.reason === 'kingCaptured' && e.credit === 2), '...Red is eliminated with credit to Yellow');
  const retake = t.rejoin(2);
  check(retake.ok === true && retake.state.variant === 'chaturaji' && t.room().seats[2].controller === 'human', 'the human retakes the seat; the answer still says chaturaji');
  check(decode(retake.state.state).score[2] === 3, '...and the 3 points the bot scored are Yellow\'s');
  const handedBack = retake.state.seats[2];
  check(handedBack.kind === 'human' && handedBack.connected === true && !('botReason' in handedBack) && !('elo' in handedBack), '...and the seat list says so: a human seat carries no botReason and no elo any more');
  const lastUpdate = t.lastSeats('S0')[2];
  check(lastUpdate.kind === 'human' && !('botReason' in lastUpdate) && !('elo' in lastUpdate), '...in the broadcast to the other seats too');
  disposeAll();

  // a bot fill: after the fill timer, the bot seats of a Chaturaji lobby play legal Chaturaji moves
  const f = newGame({ variant: 'chaturaji', bots: 2, elos: [null, null, 1000, 1500], rng: mulberry32(7), botRng: mulberry32(8) });
  const errors2 = mock.method(console, 'error', () => {});
  const before = f.seq();
  for (let i = 0; i < 12; i++) {
    const seat = f.state().turn;
    if (f.room().seats[seat].controller === 'human') {
      const first = E.legalMoves(f.state(), seat)[0]; // (g.playFirst names squares on the cross board)
      const m = f.mv(seat, GEO.squareName(first.from), GEO.squareName(first.to));
      assert.ok(m.ok, `human move ${i} accepted`);
    } else mock.timers.tick(2000);
  }
  check(f.seq() - before >= 12 && errors2.mock.calls.length === 0 && eventsOf(f.io, 'four_state', 'S0').filter((e) => e.payload.actor === 'bot').length >= 4, `two bots filling seats play along with two humans for ${f.seq() - before} plies, no fault`);
  errors2.mock.restore();
  disposeAll();

  // the other variants' bots still use their own bot (the dispatch table is not a Chaturaji special case)
  const c = newGame({ bots: 3, elos: [null, 1200, 1200, 1200], rng: mulberry32(4), botRng: mulberry32(5) });
  const errors3 = mock.method(console, 'error', () => {});
  c.resign(0);
  for (let i = 0; i < 4000 && c.mgr.rooms.has(c.id); i++) mock.timers.tick(1);
  const chessOver = overOf(c);
  const chessStates = eventsOf(c.io, 'four_state', 'S0').map((e) => E.deserialize(e.payload.state));
  check(chessOver && ['elimination', 'cap', 'deadPosition'].includes(chessOver.reason) && chessStates.length > 40 && errors3.mock.calls.length === 0, `a 4 Player Chess room still plays a whole game with the same default chooser under Chess rules (${chessStates.length} states, ended ${chessOver?.reason})`);
  errors3.mock.restore();
  disposeAll();
}

console.log('\n=== 5. The matchmaker: the Chaturaji queue is its own ===');
{
  const started = [];
  const notes = [];
  const mm = new FourPlayerMatchmaker({ startGame: (...args) => started.push(args), notify: (id, update) => notes.push({ id, update }), fillWaitMs: 1000, randomInt: () => 0 });
  const TC = { initialSeconds: 300, incrementSeconds: 0 };
  const join = (id, variant) => mm.join({ socketId: id, userId: null, name: id, timeControl: TC, ...(variant === undefined ? {} : { variant }) });
  check(join('A', 'chaturaji').ok && join('B', 'giveaway').ok && join('C').ok, 'a Chaturaji, a Giveaway and a Chess player join the same time control');
  check(mm.lobbySize(TC, 'chaturaji') === 1 && mm.lobbySize(TC, 'giveaway') === 1 && mm.lobbySize(TC, 'ffa') === 1 && mm.size() === 3, '...three lobbies of one each');
  check(notes.every((n) => n.update.queued === 1 && n.update.fillInMs === null), '...each is told "1 queued, no timer": none sees another');
  mock.timers.tick(5000);
  check(started.length === 0, 'nothing starts, however long they wait (a lobby needs two of its own kind)');
  check(join('D', 'chaturaji').ok && mm.lobbySize(TC, 'chaturaji') === 2 && mm.lobbySize(TC, 'giveaway') === 1 && mm.lobbySize(TC, 'ffa') === 1, 'a second Chaturaji player joins their own lobby only');
  mock.timers.tick(1000);
  check(started.length === 1 && started[0][3] === 'chaturaji' && started[0][0].filter((s) => s.kind === 'human').length === 2 && started[0][0].filter((s) => s.kind === 'bot').length === 2, 'the fill timer starts a CHATURAJI game (variant passed to startGame) with its two humans and two bots');
  check(mm.isQueued('B') && mm.isQueued('C') && !mm.isQueued('A') && !mm.isQueued('D'), '...the Giveaway and Chess players are still waiting');
  for (const id of ['E', 'F', 'G', 'H']) join(id, 'chaturaji');
  check(started.length === 2 && started[1][3] === 'chaturaji' && started[1][0].every((s) => s.kind === 'human'), 'four Chaturaji players start at once, all human');
  const other = new FourPlayerMatchmaker({ startGame: (...args) => started.push(args), notify: () => {}, fillWaitMs: 1000, randomInt: () => 0 });
  const TC2 = { initialSeconds: 600, incrementSeconds: 5 };
  other.join({ socketId: 'P', userId: null, name: 'P', timeControl: TC, variant: 'chaturaji' });
  other.join({ socketId: 'Q', userId: null, name: 'Q', timeControl: TC2, variant: 'chaturaji' });
  check(other.lobbySize(TC, 'chaturaji') === 1 && other.lobbySize(TC2, 'chaturaji') === 1, 'two time controls make two Chaturaji lobbies');
  const bad = [];
  for (const variant of ['Chaturaji', 'chess', '', null, 5, {}]) bad.push(mm.join({ socketId: 'Z', userId: null, name: 'Z', timeControl: TC, variant }));
  check(bad.every((r) => r.ok === false && r.error === 'Unknown game mode.') && !mm.isQueued('Z'), 'a mis-spelt variant is refused and never queued');
}

console.log('\n=== 6. The handlers: variant "chaturaji" on four_join_queue ===');
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
  const ra = await a.call('four_join_queue', { timeControl: TC, variant: 'chaturaji' });
  const rb = await b.call('four_join_queue', { timeControl: TC, variant: 'chaturaji' });
  check(ra[0].ok && rb[0].ok && matchmaker.lobbySize(TC, 'chaturaji') === 2, 'two clients join with variant "chaturaji": ack ok, queued together');
  const rc = await c.call('four_join_queue', { timeControl: TC, variant: 'giveaway' });
  const rd = await d.call('four_join_queue', { timeControl: TC });
  check(rc[0].ok && rd[0].ok && matchmaker.lobbySize(TC, 'giveaway') === 1 && matchmaker.lobbySize(TC, 'ffa') === 1 && matchmaker.lobbySize(TC, 'chaturaji') === 2, 'a Giveaway client and an old client (no variant) wait in their own lobbies');
  mock.timers.tick(1000);
  const foundOf = (id) => events.filter((x) => x.id === id && x.event === 'four_match_found').map((x) => x.payload);
  check(foundOf('A')[0]?.variant === 'chaturaji' && foundOf('B')[0]?.variant === 'chaturaji' && foundOf('A')[0].roomId === foundOf('B')[0].roomId, 'A and B are matched into one room whose four_match_found says "chaturaji"');
  check(foundOf('A')[0].state.split(' ')[0].split('/').length === 8 && foundOf('A')[0].seats.filter((s) => s.kind === 'bot').length === 2, '...with the 8-row snapshot and two bot seats filling the table');
  check(foundOf('C').length === 0 && foundOf('D').length === 0 && matchmaker.isQueued('C') && matchmaker.isQueued('D'), 'the Giveaway and Chess clients were not pulled into it');
  check(rooms.listActiveGames().map((g) => g.variant).join() === 'chaturaji', 'the active-games list shows the Chaturaji game');
  const bad = [];
  for (const variant of ['Chaturaji', 'chaturanga', '', null, 7, {}, []]) bad.push((await e.call('four_join_queue', { timeControl: TC, variant }))[0]);
  check(bad.every((r) => r.ok === false && r.error === 'Unknown game mode.') && !matchmaker.isQueued('E'), 'a mis-spelt variant is refused by the validator and the socket is not queued');
  const again = (await a.call('four_join_queue', { timeControl: TC, variant: 'chaturaji' }))[0];
  check(again.ok === false && /already in a game/.test(again.error), 'a socket already seated in a Chaturaji game cannot queue again');
  // all three games queued at one time control, interleaved: twelve players make exactly three rooms, one per variant, and nobody is placed in another game's room
  {
    const TC3 = { initialSeconds: 300, incrementSeconds: 0 };
    const roomsBefore = rooms.listActiveGames().length;
    const order = ['ffa', 'giveaway', 'chaturaji'];
    const sockets = [];
    for (let i = 0; i < 12; i++) sockets.push({ id: `V${i}`, variant: order[i % 3], s: socket(`V${i}`) });
    for (const p of sockets) {
      const reply = await p.s.call('four_join_queue', { timeControl: TC3, ...(p.variant === 'ffa' ? {} : { variant: p.variant }) });
      assert.ok(reply[0].ok, `${p.id} joined`);
    }
    const found = (id) => events.filter((x) => x.id === id && x.event === 'four_match_found').map((x) => x.payload);
    check(sockets.every((p) => found(p.id).length === 1), 'twelve players, one match_found each, with no fill timer needed (every lobby filled with four of its own game)');
    check(sockets.every((p) => found(p.id)[0].variant === p.variant), '...each room names the game its players asked for');
    const roomOf = new Map(sockets.map((p) => [p.id, found(p.id)[0].roomId]));
    check(new Set(roomOf.values()).size === 3 && rooms.listActiveGames().length === roomsBefore + 3, '...in exactly three different rooms');
    check(['ffa', 'giveaway', 'chaturaji'].every((v) => new Set(sockets.filter((p) => p.variant === v).map((p) => roomOf.get(p.id))).size === 1), '...four players per room, all of one game');
    check(found('V2')[0].state.split(' ')[0].split('/').length === 8 && found('V0')[0].state.split(' ')[0].split('/').length === 14, 'the Chaturaji room started on the 8 x 8 board and the Chess room on the cross board');
  }

  // the bots of that room move on their own, on the 8 x 8 board
  const roomId = foundOf('A')[0].roomId;
  const room = rooms.rooms.get(roomId);
  const GEO_H = E.geometryOf(room.state.rules);
  for (let i = 0; i < 400 && room.seq < 6; i++) {
    if (room.seats[room.state.turn].controller === 'human') {
      // a human is on move: play its first legal move through the real handler (the bots wait for their turns)
      const mover = room.seats[room.state.turn].socketId === 'A' ? a : b;
      const first = E.legalMoves(room.state, room.state.turn)[0];
      const [reply] = await mover.call('four_make_move', { roomId, from: GEO_H.squareName(first.from), to: GEO_H.squareName(first.to) });
      assert.ok(reply.ok, 'the human\'s move through the handler is accepted');
    } else mock.timers.tick(100);
  }
  const botStates = events.filter((x) => x.id === 'A' && x.event === 'four_state' && x.payload.actor === 'bot').map((x) => x.payload);
  check(botStates.length > 0 && botStates.every((p) => /^[a-h][1-8]$/.test(p.move.from) && /^[a-h][1-8]$/.test(p.move.to)), `the room's bots play on their own on the 8 x 8 board (${botStates.length} bot moves in ${room.seq} plies)`);
  check(unhandled.length === 0, 'no unhandled rejection anywhere');
}

console.log(`\nAll ${passed} checks passed.`);
process.exit(0);
