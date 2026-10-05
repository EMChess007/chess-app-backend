#!/usr/bin/env node
/**
 * End-to-end smoke test for the realtime multiplayer layer (matchmaking, game rooms, move
 * sync, disconnect/reconnect, clock timeout) — connects to an ALREADY RUNNING backend as two
 * plain socket.io-client "players" and exercises the real socket protocol, exactly as a mobile
 * client eventually would. No mocking: this is the actual server.
 *
 * Usage:
 *   npm run dev                          (in one terminal, from backend/)
 *   node scripts/test-multiplayer.mjs    (in another)
 *
 * BACKEND_URL env var overrides the default http://localhost:3000.
 */
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';

const SERVER_URL = process.env.BACKEND_URL ?? 'http://localhost:3000';
let passedChecks = 0;

function check(condition, message) {
  assert.ok(condition, message);
  passedChecks++;
  console.log(`  ✓ ${message}`);
}

function connect(name) {
  return new Promise((resolve, reject) => {
    const socket = io(SERVER_URL, { transports: ['websocket'], reconnection: false });
    const timer = setTimeout(() => reject(new Error(`${name}: connect timed out`)), 5000);
    socket.on('connect', () => {
      clearTimeout(timer);
      console.log(`[${name}] connected (socket ${socket.id})`);
      resolve(socket);
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(new Error(`${name}: connect_error — ${err.message}`));
    });
  });
}

function emitAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(5000).emit(event, payload, (err, response) => {
      if (err) {
        reject(new Error(`"${event}" ack never arrived (timeout)`));
        return;
      }
      resolve(response);
    });
  });
}

/**
 * Resolves with the next `event` on `socket` — and, because `socket.once` only sees events that arrive AFTER it is
 * called, THE LISTENER MUST BE ATTACHED BEFORE the emit that provokes the event.
 *
 * THE TRAP (it failed the nightly once in ~800 pairings, as 'timed out waiting for "match_found"'): the second
 * player's join_queue makes the server send the ack and match_found back to back. If both frames arrive in one network
 * read (a busy CI runner), the socket parses them in a single synchronous pass: the ack callback only QUEUES the
 * awaiting code, and match_found fires before it runs — with nobody listening yet. Writing
 * `await emitAck(join_queue); return waitFor(match_found)` is therefore a race; register the listener first.
 * (Not a server bug: the real app keeps a permanent match_found listener.)
 */
function waitFor(socket, event, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function testMatchmakingAndMoveSync() {
  console.log('\n=== 1. Matchmaking + move sync + server-side validation ===');
  const alice = await connect('Alice');
  const bob = await connect('Bob');

  const timeControl = { initialSeconds: 300, incrementSeconds: 0 };

  const [matchA, matchB] = await Promise.all([
    (async () => {
      const matchFound = waitFor(alice, 'match_found'); // BEFORE the emit — see waitFor's doc comment
      matchFound.catch(() => {}); // no unhandled rejection if the join fails first; the caller still sees it
      const ack = await emitAck(alice, 'join_queue', { timeControl, isChess960: false });
      check(ack.ok === true, 'Alice join_queue ack is ok');
      return matchFound;
    })(),
    (async () => {
      await new Promise((r) => setTimeout(r, 150)); // keeps the log order readable, not required for correctness
      const matchFound = waitFor(bob, 'match_found'); // BEFORE the emit — see waitFor's doc comment
      matchFound.catch(() => {}); // no unhandled rejection if the join fails first; the caller still sees it
      const ack = await emitAck(bob, 'join_queue', { timeControl, isChess960: false });
      check(ack.ok === true, 'Bob join_queue ack is ok');
      return matchFound;
    })(),
  ]);

  console.log(`[Alice] match_found: room=${matchA.roomId} color=${matchA.color}`);
  console.log(`[Bob]   match_found: room=${matchB.roomId} color=${matchB.color}`);

  check(matchA.roomId === matchB.roomId, 'both players were placed in the same room');
  check(matchA.color !== matchB.color, 'players were assigned different colors');
  check(
    matchA.fen === 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    'starting position is the classical setup for a non-960 game'
  );
  check(matchA.whiteMs === 300_000 && matchA.blackMs === 300_000, 'both clocks start at the full 300s');

  const white = matchA.color === 'w' ? { socket: alice, match: matchA, name: 'Alice' } : { socket: bob, match: matchB, name: 'Bob' };
  const black = matchA.color === 'b' ? { socket: alice, match: matchA, name: 'Alice' } : { socket: bob, match: matchB, name: 'Bob' };
  const roomId = matchA.roomId;
  console.log(`White = ${white.name}, Black = ${black.name}`);

  // White plays e4, Black should receive it as opponent_move.
  const blackSeesE4 = waitFor(black.socket, 'opponent_move');
  const e4Ack = await emitAck(white.socket, 'make_move', { roomId, from: 'e2', to: 'e4' });
  check(e4Ack.ok === true, 'e2-e4 accepted by the server');
  const e4Seen = await blackSeesE4;
  check(e4Seen.san === 'e4', 'Black received opponent_move for e4');
  check(e4Seen.turn === 'b', "opponent_move reports it's now Black's turn");

  // Black plays e5, White should receive it.
  const whiteSeesE5 = waitFor(white.socket, 'opponent_move');
  const e5Ack = await emitAck(black.socket, 'make_move', { roomId, from: 'e7', to: 'e5' });
  check(e5Ack.ok === true, 'e7-e5 accepted by the server');
  const e5Seen = await whiteSeesE5;
  check(e5Seen.san === 'e5', 'White received opponent_move for e5');
  check(e5Seen.fen.startsWith('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR'), 'synced FEN matches 1.e4 e5');

  // Knights out — a few more moves to prove sustained sync, not just the first exchange.
  const blackSeesNf3 = waitFor(black.socket, 'opponent_move');
  await emitAck(white.socket, 'make_move', { roomId, from: 'g1', to: 'f3' });
  check((await blackSeesNf3).san === 'Nf3', 'Black received opponent_move for Nf3');

  const whiteSeesNc6 = waitFor(white.socket, 'opponent_move');
  await emitAck(black.socket, 'make_move', { roomId, from: 'b8', to: 'c6' });
  check((await whiteSeesNc6).san === 'Nc6', 'White received opponent_move for Nc6');

  // Illegal move: pawn can't jump to e6 from e4.
  const illegalAck = await emitAck(white.socket, 'make_move', { roomId, from: 'e4', to: 'e6' });
  check(illegalAck.ok === false, 'illegal move (e4-e6) rejected by server-side chess.js validation');

  // Out-of-turn move: it's White's turn, Black tries to move anyway.
  const outOfTurnAck = await emitAck(black.socket, 'make_move', { roomId, from: 'g8', to: 'f6' });
  check(outOfTurnAck.ok === false, "move rejected when it isn't that player's turn");

  alice.disconnect();
  bob.disconnect();
}

async function testLeaveQueue() {
  console.log('\n=== 2. leave_queue actually empties the queue ===');
  const carol = await connect('Carol');
  const dave = await connect('Dave');
  const timeControl = { initialSeconds: 180, incrementSeconds: 2 };

  const joinAck = await emitAck(carol, 'join_queue', { timeControl, isChess960: false });
  check(joinAck.ok === true, 'Carol join_queue ack is ok');

  const leaveAck = await emitAck(carol, 'leave_queue', {});
  check(leaveAck.ok === true, 'Carol leave_queue ack is ok');

  // Dave joins with the same time control — if Carol were still queued, Dave would get an
  // immediate match_found. Since she left, he should just sit in the (now-empty) queue.
  let daveMatched = false;
  dave.once('match_found', () => {
    daveMatched = true;
  });
  await emitAck(dave, 'join_queue', { timeControl, isChess960: false });
  await new Promise((r) => setTimeout(r, 500));
  check(daveMatched === false, "Dave wasn't matched against a player who already left the queue");

  await emitAck(dave, 'leave_queue', {});
  carol.disconnect();
  dave.disconnect();
}

async function testDisconnectAndReconnect() {
  console.log('\n=== 3. Disconnect -> opponent notified -> rejoin resumes the seat ===');
  const eve = await connect('Eve');
  const frank = await connect('Frank');
  const timeControl = { initialSeconds: 300, incrementSeconds: 0 };

  const [matchE, matchF] = await Promise.all([
    (async () => {
      const matchFound = waitFor(eve, 'match_found'); // BEFORE the emit — see waitFor's doc comment
      matchFound.catch(() => {}); // no unhandled rejection if the join fails first; the caller still sees it
      await emitAck(eve, 'join_queue', { timeControl, isChess960: false });
      return matchFound;
    })(),
    (async () => {
      await new Promise((r) => setTimeout(r, 150));
      const matchFound = waitFor(frank, 'match_found'); // BEFORE the emit — see waitFor's doc comment
      matchFound.catch(() => {}); // no unhandled rejection if the join fails first; the caller still sees it
      await emitAck(frank, 'join_queue', { timeControl, isChess960: false });
      return matchFound;
    })(),
  ]);

  const roomId = matchE.roomId;
  const eveToken = matchE.playerToken;

  // Eve drops off the network mid-game.
  const frankSeesDisconnect = waitFor(frank, 'opponent_disconnected');
  eve.disconnect();
  const disconnectPayload = await frankSeesDisconnect;
  check(typeof disconnectPayload.graceSeconds === 'number', 'Frank was told how long the grace period is');
  console.log(`  (Frank informed opponent disconnected, ${disconnectPayload.graceSeconds}s grace period)`);

  // Eve reconnects with a brand new socket (as a real client reload would) and rejoins using
  // the playerToken she was given at match_found.
  const eveReconnected = await connect('Eve (reconnected)');
  const frankSeesReconnect = waitFor(frank, 'opponent_reconnected');
  const rejoinAck = await emitAck(eveReconnected, 'rejoin_game', { roomId, playerToken: eveToken });
  check(rejoinAck.ok === true, 'rejoin_game with the correct playerToken succeeds');
  check(rejoinAck.state.fen === matchE.fen, 'rejoined state has the (unchanged) current FEN');
  check(rejoinAck.state.color === matchE.color, 'rejoined state reports the same color Eve had');
  await frankSeesReconnect;
  console.log('  Frank correctly notified opponent_reconnected');

  // Wrong token should be refused.
  const badRejoinAck = await emitAck(frank, 'rejoin_game', { roomId, playerToken: 'not-a-real-token' });
  check(badRejoinAck.ok === false, 'rejoin_game with a bogus playerToken is rejected');

  eveReconnected.disconnect();
  frank.disconnect();
}

async function testClockTimeout() {
  console.log('\n=== 4. Server-side clock timeout ===');
  const gina = await connect('Gina');
  const hank = await connect('Hank');
  // A tiny time control so the test doesn't take long — the server has no idea this is a test,
  // it just runs the exact same timeout logic as a real 5-minute game would.
  const timeControl = { initialSeconds: 2, incrementSeconds: 0 };

  const [matchG] = await Promise.all([
    (async () => {
      const matchFound = waitFor(gina, 'match_found'); // BEFORE the emit — see waitFor's doc comment
      matchFound.catch(() => {}); // no unhandled rejection if the join fails first; the caller still sees it
      await emitAck(gina, 'join_queue', { timeControl, isChess960: false });
      return matchFound;
    })(),
    (async () => {
      await new Promise((r) => setTimeout(r, 150));
      const matchFound = waitFor(hank, 'match_found'); // BEFORE the emit — see waitFor's doc comment
      matchFound.catch(() => {}); // no unhandled rejection if the join fails first; the caller still sees it
      await emitAck(hank, 'join_queue', { timeControl, isChess960: false });
      return matchFound;
    })(),
  ]);

  const white = matchG.color === 'w' ? gina : hank;
  const black = matchG.color === 'w' ? hank : gina;
  console.log(`  White's 2s clock is now running; deliberately not moving...`);

  // Neither player moves — White's clock (the side to move first) should run out.
  const whiteGameOver = waitFor(white, 'game_over', 6000);
  const blackGameOver = waitFor(black, 'game_over', 6000);
  const [whiteResult, blackResult] = await Promise.all([whiteGameOver, blackGameOver]);

  check(whiteResult.reason === 'timeout', 'game_over reason is "timeout"');
  check(whiteResult.winner === 'b', 'Black is declared the winner when White times out');
  check(blackResult.reason === 'timeout' && blackResult.winner === 'b', 'both players received the same game_over outcome');

  gina.disconnect();
  hank.disconnect();
}

async function testChess960Matchmaking() {
  console.log('\n=== 5. Chess960 matchmaking (isolated queue + randomized start position) ===');
  const ivy = await connect('Ivy');
  const jack = await connect('Jack');
  const classicalControl = { initialSeconds: 180, incrementSeconds: 0 };

  // A classical-time-control player waiting should NOT be matched against a 960 player even
  // with an identical time control — the isChess960 flag must partition the queue.
  let ivyMatched = false;
  ivy.once('match_found', () => {
    ivyMatched = true;
  });
  await emitAck(ivy, 'join_queue', { timeControl: classicalControl, isChess960: false });

  const jackMatchPromise = waitFor(jack, 'match_found');
  const jackAck = await emitAck(jack, 'join_queue', { timeControl: classicalControl, isChess960: true });
  check(jackAck.ok === true, 'Jack (960) join_queue ack is ok');

  await new Promise((r) => setTimeout(r, 500));
  check(ivyMatched === false, 'a classical-queue player is not matched against a 960 player');

  // A second 960 player completes Jack's match.
  const kate = await connect('Kate');
  const ivyGivesUp = emitAck(ivy, 'leave_queue', {});
  const kateMatchPromise = waitFor(kate, 'match_found');
  await emitAck(kate, 'join_queue', { timeControl: classicalControl, isChess960: true });

  const [jackMatch, kateMatch] = await Promise.all([jackMatchPromise, kateMatchPromise]);
  await ivyGivesUp;

  check(jackMatch.roomId === kateMatch.roomId, 'the two 960 players were matched together');
  check(jackMatch.isChess960 === true, 'match_found correctly reports isChess960: true');
  check(
    jackMatch.fen !== 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    'the 960 game starts from a randomized (non-classical) back rank'
  );
  const backRank = jackMatch.fen.split(' ')[0].split('/')[7];
  const pieceCounts = [...backRank].reduce((counts, ch) => ({ ...counts, [ch]: (counts[ch] ?? 0) + 1 }), {});
  check(
    backRank.length === 8 && pieceCounts.K === 1 && pieceCounts.R === 2 && pieceCounts.Q === 1 && pieceCounts.B === 2 && pieceCounts.N === 2,
    'the generated back rank has exactly K, 2R, Q, 2B, 2N'
  );
  console.log(`  960 starting back rank: ${backRank}`);

  ivy.disconnect();
  jack.disconnect();
  kate.disconnect();
}

async function testKingOfTheHillMatchmaking() {
  console.log('\n=== 6. King of the Hill matchmaking (isolated queue) ===');
  const leo = await connect('Leo', null);
  const mia = await connect('Mia', null);
  const classicalControl = { initialSeconds: 180, incrementSeconds: 0 };

  // A plain-classical player waiting should NOT be matched against a King of the Hill player
  // even with an identical time control — isKingOfTheHill must partition the queue exactly like
  // isChess960 already does (see testChess960Matchmaking).
  let leoMatched = false;
  leo.once('match_found', () => {
    leoMatched = true;
  });
  await emitAck(leo, 'join_queue', { timeControl: classicalControl, isChess960: false, isKingOfTheHill: false });

  const miaMatchPromise = waitFor(mia, 'match_found');
  const miaAck = await emitAck(mia, 'join_queue', { timeControl: classicalControl, isChess960: false, isKingOfTheHill: true });
  check(miaAck.ok === true, 'Mia (King of the Hill) join_queue ack is ok');

  await new Promise((r) => setTimeout(r, 500));
  check(leoMatched === false, 'a plain-classical player is not matched against a King of the Hill player');

  const noa = await connect('Noa', null);
  const leoGivesUp = emitAck(leo, 'leave_queue', {});
  const noaMatchPromise = waitFor(noa, 'match_found');
  await emitAck(noa, 'join_queue', { timeControl: classicalControl, isChess960: false, isKingOfTheHill: true });

  const [miaMatch, noaMatch] = await Promise.all([miaMatchPromise, noaMatchPromise]);
  await leoGivesUp;

  check(miaMatch.roomId === noaMatch.roomId, 'the two King of the Hill players were matched together');
  check(miaMatch.isKingOfTheHill === true, 'match_found correctly reports isKingOfTheHill: true');

  leo.disconnect();
  mia.disconnect();
  noa.disconnect();
}

async function testKingOfTheHillWin() {
  console.log('\n=== 7. King of the Hill win detection (reaching d4 wins outright) ===');
  const oscar = await connect('Oscar', null);
  const petra = await connect('Petra', null);
  const timeControl = { initialSeconds: 300, incrementSeconds: 0 };

  const [matchO, matchP] = await Promise.all([
    (async () => {
      const matchFound = waitFor(oscar, 'match_found'); // BEFORE the emit — see waitFor's doc comment
      matchFound.catch(() => {}); // no unhandled rejection if the join fails first; the caller still sees it
      await emitAck(oscar, 'join_queue', { timeControl, isChess960: false, isKingOfTheHill: true });
      return matchFound;
    })(),
    (async () => {
      await new Promise((r) => setTimeout(r, 150));
      const matchFound = waitFor(petra, 'match_found'); // BEFORE the emit — see waitFor's doc comment
      matchFound.catch(() => {}); // no unhandled rejection if the join fails first; the caller still sees it
      await emitAck(petra, 'join_queue', { timeControl, isChess960: false, isKingOfTheHill: true });
      return matchFound;
    })(),
  ]);
  check(matchO.isKingOfTheHill === true, 'match_found reports isKingOfTheHill: true for both players');

  const white = matchO.color === 'w' ? { socket: oscar, name: 'Oscar' } : { socket: petra, name: 'Petra' };
  const black = matchO.color === 'b' ? { socket: oscar, name: 'Oscar' } : { socket: petra, name: 'Petra' };
  const roomId = matchO.roomId;
  console.log(`  White = ${white.name}, Black = ${black.name} — marching White's king to d4...`);

  // A verified-legal move sequence (see chess.js dry run) that walks White's king straight to d4
  // without ever passing through check, castling, or a repeated position — Black just shuffles a
  // knight harmlessly out of the way. White's own final move (Kd4) should end the game immediately
  // via King of the Hill, before Black ever gets to move again.
  const whiteMoves = [
    { from: 'e2', to: 'e3' },
    { from: 'e1', to: 'e2' },
    { from: 'e2', to: 'd3' },
    { from: 'd3', to: 'd4' },
  ];
  const blackMoves = [
    { from: 'g8', to: 'f6' },
    { from: 'f6', to: 'g8' },
    { from: 'g8', to: 'f6' },
  ];

  const whiteGameOver = waitFor(white.socket, 'game_over');
  const blackGameOver = waitFor(black.socket, 'game_over');

  for (let i = 0; i < whiteMoves.length; i++) {
    const wAck = await emitAck(white.socket, 'make_move', { roomId, ...whiteMoves[i] });
    check(wAck.ok === true, `White's move ${i + 1} (${whiteMoves[i].from}-${whiteMoves[i].to}) accepted`);
    if (i === whiteMoves.length - 1) break; // the last move ends the game — Black never replies
    const bAck = await emitAck(black.socket, 'make_move', { roomId, ...blackMoves[i] });
    check(bAck.ok === true, `Black's move ${i + 1} (${blackMoves[i].from}-${blackMoves[i].to}) accepted`);
  }

  const [whiteResult, blackResult] = await Promise.all([whiteGameOver, blackGameOver]);
  check(whiteResult.reason === 'kingOfTheHill', 'game_over reason is "kingOfTheHill"');
  check(whiteResult.winner === 'w', 'White (who reached d4) is declared the winner');
  check(blackResult.reason === 'kingOfTheHill' && blackResult.winner === 'w', 'both players received the same game_over outcome');

  oscar.disconnect();
  petra.disconnect();
}

async function testThreeCheckMatchmaking() {
  console.log('\n=== 8. Three-Check matchmaking (isolated queue) ===');
  const quinn = await connect('Quinn');
  const rex = await connect('Rex');
  const classicalControl = { initialSeconds: 180, incrementSeconds: 0 };

  // Same partitioning as King of the Hill (see testKingOfTheHillMatchmaking) — isThreeCheck must
  // keep this queue separate from a plain-classical wait, even with an identical time control.
  let quinnMatched = false;
  quinn.once('match_found', () => {
    quinnMatched = true;
  });
  await emitAck(quinn, 'join_queue', { timeControl: classicalControl, isChess960: false, isThreeCheck: false });

  const rexMatchPromise = waitFor(rex, 'match_found');
  const rexAck = await emitAck(rex, 'join_queue', { timeControl: classicalControl, isChess960: false, isThreeCheck: true });
  check(rexAck.ok === true, 'Rex (Three-Check) join_queue ack is ok');

  await new Promise((r) => setTimeout(r, 500));
  check(quinnMatched === false, 'a plain-classical player is not matched against a Three-Check player');

  const sara = await connect('Sara');
  const quinnGivesUp = emitAck(quinn, 'leave_queue', {});
  const saraMatchPromise = waitFor(sara, 'match_found');
  await emitAck(sara, 'join_queue', { timeControl: classicalControl, isChess960: false, isThreeCheck: true });

  const [rexMatch, saraMatch] = await Promise.all([rexMatchPromise, saraMatchPromise]);
  await quinnGivesUp;

  check(rexMatch.roomId === saraMatch.roomId, 'the two Three-Check players were matched together');
  check(rexMatch.isThreeCheck === true, 'match_found correctly reports isThreeCheck: true');

  quinn.disconnect();
  rex.disconnect();
  sara.disconnect();
}

async function testThreeCheckWin() {
  console.log('\n=== 9. Three-Check win detection (delivering the 3rd check wins outright) ===');
  const tara = await connect('Tara');
  const uri = await connect('Uri');
  const timeControl = { initialSeconds: 300, incrementSeconds: 0 };

  const [matchT, matchU] = await Promise.all([
    (async () => {
      const matchFound = waitFor(tara, 'match_found'); // BEFORE the emit — see waitFor's doc comment
      matchFound.catch(() => {}); // no unhandled rejection if the join fails first; the caller still sees it
      await emitAck(tara, 'join_queue', { timeControl, isChess960: false, isThreeCheck: true });
      return matchFound;
    })(),
    (async () => {
      await new Promise((r) => setTimeout(r, 150));
      const matchFound = waitFor(uri, 'match_found'); // BEFORE the emit — see waitFor's doc comment
      matchFound.catch(() => {}); // no unhandled rejection if the join fails first; the caller still sees it
      await emitAck(uri, 'join_queue', { timeControl, isChess960: false, isThreeCheck: true });
      return matchFound;
    })(),
  ]);
  check(matchT.isThreeCheck === true, 'match_found reports isThreeCheck: true for both players');

  const white = matchT.color === 'w' ? { socket: tara, name: 'Tara' } : { socket: uri, name: 'Uri' };
  const black = matchT.color === 'b' ? { socket: tara, name: 'Tara' } : { socket: uri, name: 'Uri' };
  const roomId = matchT.roomId;
  console.log(`  White = ${white.name}, Black = ${black.name} — delivering 3 checks with White's knight...`);

  // A verified-legal move sequence (see chess.js dry run) where White's knight checks Black's
  // king three separate times (capturing on c7 twice along the way, then forking from e6) —
  // White's own final move (Ne6+) should end the game immediately via Three-Check, before Black
  // ever gets to move again.
  const whiteMoves = [
    { from: 'b1', to: 'a3' },
    { from: 'a3', to: 'b5' },
    { from: 'b5', to: 'c7' }, // check 1
    { from: 'g1', to: 'f3' },
    { from: 'f3', to: 'd4' },
    { from: 'd4', to: 'b5' },
    { from: 'b5', to: 'c7' }, // check 2
    { from: 'c7', to: 'e6' }, // check 3 — ends the game
  ];
  const blackMoves = [
    { from: 'a7', to: 'a6' },
    { from: 'h7', to: 'h6' },
    { from: 'd8', to: 'c7' },
    { from: 'a6', to: 'a5' },
    { from: 'h6', to: 'h5' },
    { from: 'b7', to: 'b6' },
    { from: 'e8', to: 'd8' },
  ];

  const whiteGameOver = waitFor(white.socket, 'game_over');
  const blackGameOver = waitFor(black.socket, 'game_over');

  for (let i = 0; i < whiteMoves.length; i++) {
    const wAck = await emitAck(white.socket, 'make_move', { roomId, ...whiteMoves[i] });
    check(wAck.ok === true, `White's move ${i + 1} (${whiteMoves[i].from}-${whiteMoves[i].to}) accepted`);
    if (i === whiteMoves.length - 1) break; // the last move ends the game — Black never replies
    const bAck = await emitAck(black.socket, 'make_move', { roomId, ...blackMoves[i] });
    check(bAck.ok === true, `Black's move ${i + 1} (${blackMoves[i].from}-${blackMoves[i].to}) accepted`);
  }

  const [whiteResult, blackResult] = await Promise.all([whiteGameOver, blackGameOver]);
  check(whiteResult.reason === 'threeCheck', 'game_over reason is "threeCheck"');
  check(whiteResult.winner === 'w', 'White (who delivered the 3rd check) is declared the winner');
  check(blackResult.reason === 'threeCheck' && blackResult.winner === 'w', 'both players received the same game_over outcome');

  tara.disconnect();
  uri.disconnect();
}

async function testSetupChessBlindPairing() {
  console.log('\n=== 10. Setup Chess: blind pairing, both armies submitted, merged position playable ===');
  const vera = await connect('Vera');
  const wade = await connect('Wade');
  const timeControl = { initialSeconds: 300, incrementSeconds: 0 };

  // Paired instantly (isSetupChess partitions the queue exactly like every other variant flag),
  // but — unlike every other variant — NOT via match_found: no room exists yet, since there's no
  // starting position until both armies are in.
  const veraPairedPromise = waitFor(vera, 'setup_chess_paired');
  const wadePairedPromise = waitFor(wade, 'setup_chess_paired');
  await emitAck(vera, 'join_queue', { timeControl, isChess960: false, isSetupChess: true });
  await new Promise((r) => setTimeout(r, 150));
  await emitAck(wade, 'join_queue', { timeControl, isChess960: false, isSetupChess: true });
  const [veraPaired, wadePaired] = await Promise.all([veraPairedPromise, wadePairedPromise]);

  check(veraPaired.pairingId === wadePaired.pairingId, 'both players share the same pairingId');
  check(veraPaired.color !== wadePaired.color, 'the two players were assigned opposite colors');

  const white = veraPaired.color === 'w' ? { socket: vera, name: 'Vera' } : { socket: wade, name: 'Wade' };
  const black = veraPaired.color === 'b' ? { socket: vera, name: 'Vera' } : { socket: wade, name: 'Wade' };
  const pairingId = veraPaired.pairingId;
  console.log(`  White = ${white.name}, Black = ${black.name} — both submitting a King + Rook army...`);

  // A minimal, deliberately cheap, obviously-valid army for both sides (well under the 39-point
  // budget) — just enough to confirm the merge/validation/room-creation pipeline works end to
  // end, not a test of every possible army shape.
  const whiteArmySubmitted = emitAck(white.socket, 'submit_setup_chess', {
    pairingId,
    pieces: [
      { square: 'e1', type: 'k' },
      { square: 'a1', type: 'r' },
    ],
  });
  const whiteAck = await whiteArmySubmitted;
  check(whiteAck.ok === true, "White's army submission is accepted (still waiting on Black)");

  const whiteMatchFound = waitFor(white.socket, 'match_found');
  const blackMatchFound = waitFor(black.socket, 'match_found');
  const blackAck = await emitAck(black.socket, 'submit_setup_chess', {
    pairingId,
    pieces: [
      { square: 'e8', type: 'k' },
      { square: 'a8', type: 'r' },
    ],
  });
  check(blackAck.ok === true, "Black's army submission is accepted");

  const [whiteMatch, blackMatch] = await Promise.all([whiteMatchFound, blackMatchFound]);
  check(whiteMatch.roomId === blackMatch.roomId, 'both players land in the same room once both armies are in');
  check(whiteMatch.isSetupChess === true, 'match_found reports isSetupChess: true');
  check(
    whiteMatch.fen === 'r3k3/8/8/8/8/8/8/R3K3 w Qq - 0 1',
    'the merged FEN matches the two submitted armies exactly (empty middle ranks, White to move, queenside castling rights for both since each king+rook sit on their classical corner)'
  );

  // Confirm the merged position is a genuinely normal, playable game from here on — no special
  // Setup Chess logic exists past this point, it's 100% ordinary chess.js rules.
  const blackSeesE2 = waitFor(black.socket, 'opponent_move');
  const moveAck = await emitAck(white.socket, 'make_move', { roomId: whiteMatch.roomId, from: 'e1', to: 'e2' });
  check(moveAck.ok === true, "White's Ke1-e2 is accepted as an ordinary legal move from the merged position");
  check((await blackSeesE2).san === 'Ke2', 'Black received the move normally, like any other online game');

  vera.disconnect();
  wade.disconnect();
}

async function testSetupChessInvalidMergeAsksBothToRedo() {
  console.log('\n=== 11. Setup Chess: a merge that leaves a king in check asks both players to rebuild ===');
  const xena = await connect('Xena');
  const yuri = await connect('Yuri');
  const timeControl = { initialSeconds: 300, incrementSeconds: 0 };

  const xenaPairedPromise = waitFor(xena, 'setup_chess_paired');
  const yuriPairedPromise = waitFor(yuri, 'setup_chess_paired');
  await emitAck(xena, 'join_queue', { timeControl, isChess960: false, isSetupChess: true });
  await new Promise((r) => setTimeout(r, 150));
  await emitAck(yuri, 'join_queue', { timeControl, isChess960: false, isSetupChess: true });
  const [xenaPaired, yuriPaired] = await Promise.all([xenaPairedPromise, yuriPairedPromise]);

  const white = xenaPaired.color === 'w' ? xena : yuri;
  const black = xenaPaired.color === 'b' ? xena : yuri;
  const pairingId = xenaPaired.pairingId;

  // White's queen on e1 has an entirely open e-file straight to Black's king on e8 (the king went
  // on a1 instead, so the queen has the e-file to itself) — Black would already be in check
  // before ever getting a move, which a real game could never reach.
  const whiteInvalid = waitFor(white, 'setup_chess_invalid');
  const blackInvalid = waitFor(black, 'setup_chess_invalid');
  await emitAck(white, 'submit_setup_chess', {
    pairingId,
    pieces: [
      { square: 'a1', type: 'k' },
      { square: 'e1', type: 'q' },
    ],
  });
  await emitAck(black, 'submit_setup_chess', { pairingId, pieces: [{ square: 'e8', type: 'k' }] });

  await Promise.all([whiteInvalid, blackInvalid]);
  check(true, 'both players are told to rebuild when the merged position is illegal');

  // The pairing survives — both can resubmit and reach a normal match_found.
  const whiteMatchFound = waitFor(white, 'match_found');
  const blackMatchFound = waitFor(black, 'match_found');
  await emitAck(white, 'submit_setup_chess', { pairingId, pieces: [{ square: 'e1', type: 'k' }] });
  await emitAck(black, 'submit_setup_chess', { pairingId, pieces: [{ square: 'e8', type: 'k' }] });
  const [whiteMatch] = await Promise.all([whiteMatchFound, blackMatchFound]);
  check(whiteMatch.fen === '4k3/8/8/8/8/8/8/4K3 w - - 0 1', 'the pairing still works after a redo — resubmitted armies merge correctly');

  xena.disconnect();
  yuri.disconnect();
}

async function testFogOfWarMatchmaking() {
  console.log('\n=== 12. Fog of War matchmaking (isolated queue) ===');
  const zane = await connect('Zane');
  const amy = await connect('Amy');
  const classicalControl = { initialSeconds: 180, incrementSeconds: 0 };

  // Same partitioning as every other variant flag (see testKingOfTheHillMatchmaking) —
  // isFogOfWar must keep this queue separate from a plain-classical wait.
  let zaneMatched = false;
  zane.once('match_found', () => {
    zaneMatched = true;
  });
  await emitAck(zane, 'join_queue', { timeControl: classicalControl, isChess960: false, isFogOfWar: false });

  const amyMatchPromise = waitFor(amy, 'match_found');
  const amyAck = await emitAck(amy, 'join_queue', { timeControl: classicalControl, isChess960: false, isFogOfWar: true });
  check(amyAck.ok === true, 'Amy (Fog of War) join_queue ack is ok');

  await new Promise((r) => setTimeout(r, 500));
  check(zaneMatched === false, 'a plain-classical player is not matched against a Fog of War player');

  const bran = await connect('Bran');
  const zaneGivesUp = emitAck(zane, 'leave_queue', {});
  const branMatchPromise = waitFor(bran, 'match_found');
  await emitAck(bran, 'join_queue', { timeControl: classicalControl, isChess960: false, isFogOfWar: true });

  const [amyMatch, branMatch] = await Promise.all([amyMatchPromise, branMatchPromise]);
  await zaneGivesUp;

  check(amyMatch.roomId === branMatch.roomId, 'the two Fog of War players were matched together');
  check(amyMatch.isFogOfWar === true, 'match_found correctly reports isFogOfWar: true');

  zane.disconnect();
  amy.disconnect();
  bran.disconnect();
}

async function testFogOfWarRedactionAndWin() {
  console.log('\n=== 13. Fog of War: redacted starting position, hidden moves, king-safety bypass, king-capture win ===');
  const cleo = await connect('Cleo');
  const dirk = await connect('Dirk');
  const timeControl = { initialSeconds: 300, incrementSeconds: 0 };

  const [matchC, matchD] = await Promise.all([
    (async () => {
      const matchFound = waitFor(cleo, 'match_found'); // BEFORE the emit — see waitFor's doc comment
      matchFound.catch(() => {}); // no unhandled rejection if the join fails first; the caller still sees it
      await emitAck(cleo, 'join_queue', { timeControl, isChess960: false, isFogOfWar: true });
      return matchFound;
    })(),
    (async () => {
      await new Promise((r) => setTimeout(r, 150));
      const matchFound = waitFor(dirk, 'match_found'); // BEFORE the emit — see waitFor's doc comment
      matchFound.catch(() => {}); // no unhandled rejection if the join fails first; the caller still sees it
      await emitAck(dirk, 'join_queue', { timeControl, isChess960: false, isFogOfWar: true });
      return matchFound;
    })(),
  ]);
  check(matchC.isFogOfWar === true, 'match_found reports isFogOfWar: true for both players');

  const white = matchC.color === 'w' ? { socket: cleo, name: 'Cleo' } : { socket: dirk, name: 'Dirk' };
  const black = matchC.color === 'b' ? { socket: cleo, name: 'Cleo' } : { socket: dirk, name: 'Dirk' };
  const whiteMatch = matchC.color === 'w' ? matchC : matchD;
  const blackMatch = matchC.color === 'b' ? matchC : matchD;
  const roomId = matchC.roomId;
  console.log(`  White = ${white.name}, Black = ${black.name}`);

  // Even the classical starting position isn't fully visible to either side under Fog of War's
  // visibility rule — neither side's pieces can reach anywhere on the opponent's two ranks yet
  // (verified by hand against a plain chess.js + the same pseudo-legal-reach logic as
  // fogOfWar.ts, see this session's own exploration before writing this test).
  check(whiteMatch.fen === '8/8/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', "White's own starting view shows only White's own two ranks");
  check(blackMatch.fen === 'rnbqkbnr/pppppppp/8/8/8/8/8/8 w KQkq - 0 1', "Black's own starting view shows only Black's own two ranks");
  check(Array.isArray(whiteMatch.visibleSquares) && whiteMatch.visibleSquares.length > 0, 'match_found carries visibleSquares');

  // A verified-legal (as pseudo-legal, see this session's own chess.js exploration) sequence:
  // White pins their own knight (Nc3) to their own king with Black's bishop (Bb4) once the
  // d-pawn clears d2 — then moves the pinned knight away anyway (Nc3-d5), which ordinary chess
  // would reject outright (it leaves White's own king in check) but Fog of War must accept
  // (rule: no king-safety restriction at all). Black then captures the exposed king directly
  // (Bxe1) — Fog of War's only win condition.
  const plies = [
    { mover: white, from: 'e2', to: 'e4', expectedSan: 'e4', revealedToOpponent: false },
    { mover: black, from: 'e7', to: 'e5', expectedSan: 'e5', revealedToOpponent: true },
    { mover: white, from: 'b1', to: 'c3', expectedSan: 'Nc3', revealedToOpponent: false },
    { mover: black, from: 'f8', to: 'b4', expectedSan: 'Bb4', revealedToOpponent: true },
    { mover: white, from: 'd2', to: 'd4', expectedSan: 'd4', revealedToOpponent: true },
    { mover: black, from: 'd7', to: 'd6', expectedSan: 'd6', revealedToOpponent: false },
    // White's own king is in genuine check-safety danger here (Bb4 pins Nc3 to Ke1 with d2 now
    // empty) — moving the knight away is illegal in ordinary chess, accepted here.
    { mover: white, from: 'c3', to: 'd5', expectedSan: 'Nd5', revealedToOpponent: true },
  ];

  for (const ply of plies) {
    const opponent = ply.mover === white ? black : white;
    const opponentSeesMove = waitFor(opponent.socket, 'opponent_move');
    const ack = await emitAck(ply.mover.socket, 'make_move', { roomId, from: ply.from, to: ply.to });
    check(ack.ok === true, `${ply.mover.name}'s move ${ply.from}-${ply.to} (${ply.expectedSan}) accepted`);
    const seen = await opponentSeesMove;
    if (ply.revealedToOpponent) {
      check(seen.san === ply.expectedSan, `${opponent.name} is shown ${ply.expectedSan} (it was within their own visibility)`);
    } else {
      check(seen.san === undefined && seen.from === undefined, `${opponent.name} is NOT shown ${ply.expectedSan} (outside their own visibility)`);
      check(typeof seen.fen === 'string' && Array.isArray(seen.visibleSquares), `${opponent.name} still gets an updated (redacted) fen + visibleSquares`);
    }
  }

  // Black's bishop on b4 now has a clear diagonal straight to White's exposed king on e1 — the
  // direct king capture that ends a Fog of War game, instead of any checkmate/stalemate concept.
  const whiteGameOver = waitFor(white.socket, 'game_over');
  const blackGameOver = waitFor(black.socket, 'game_over');
  const captureAck = await emitAck(black.socket, 'make_move', { roomId, from: 'b4', to: 'e1' });
  check(captureAck.ok === true, "Black's king-capturing Bxe1 is accepted as an ordinary move");

  const [whiteResult, blackResult] = await Promise.all([whiteGameOver, blackGameOver]);
  check(whiteResult.reason === 'fogOfWar', 'game_over reason is "fogOfWar"');
  check(whiteResult.winner === 'b', 'Black (who captured the king) is declared the winner');
  check(blackResult.reason === 'fogOfWar' && blackResult.winner === 'b', 'both players received the same game_over outcome');

  cleo.disconnect();
  dirk.disconnect();
}

async function testGiveawayMatchmakingAndMandatoryCapture() {
  console.log('\n=== Giveaway: matchmaking, server-side mandatory capture, flag isolation ===');
  const timeControl = { initialSeconds: 300, incrementSeconds: 0 };

  // A Giveaway seeker must NOT be paired with a classic one (exact variant match only).
  const giveawaySeeker = await connect('Gia');
  const classicSeeker = await connect('Clay');
  check((await emitAck(giveawaySeeker, 'join_queue', { timeControl, isGiveaway: true })).ok === true, 'Gia queues for Giveaway');
  check((await emitAck(classicSeeker, 'join_queue', { timeControl })).ok === true, 'Clay queues for a classic game');
  await new Promise((r) => setTimeout(r, 400));
  let wronglyPaired = false;
  giveawaySeeker.once('match_found', () => (wronglyPaired = true));
  classicSeeker.once('match_found', () => (wronglyPaired = true));
  await new Promise((r) => setTimeout(r, 400));
  check(!wronglyPaired, 'a Giveaway seeker and a classic seeker are never paired with each other');
  await emitAck(giveawaySeeker, 'leave_queue', {});
  await emitAck(classicSeeker, 'leave_queue', {});
  giveawaySeeker.disconnect();
  classicSeeker.disconnect();

  // Giveaway cannot be combined with another variant — rejected, not silently resolved.
  const confused = await connect('Confused');
  const conflict = await emitAck(confused, 'join_queue', { timeControl, isGiveaway: true, isFogOfWar: true });
  check(conflict.ok === false && /cannot be combined/i.test(conflict.error), 'Giveaway + another variant flag is rejected on join_queue');
  const conflictChallenge = await emitAck(confused, 'create_challenge', { timeControl, isGiveaway: true, isChess960: true });
  check(conflictChallenge.ok === false, 'Giveaway + another variant flag is rejected on create_challenge too');
  confused.disconnect();

  const alice = await connect('Gwen');
  const bob = await connect('Gus');
  const [matchA, matchB] = await Promise.all([
    (async () => {
      const matchFound = waitFor(alice, 'match_found'); // BEFORE the emit — see waitFor's doc comment
      matchFound.catch(() => {}); // no unhandled rejection if the join fails first; the caller still sees it
      await emitAck(alice, 'join_queue', { timeControl, isGiveaway: true });
      return matchFound;
    })(),
    (async () => {
      await new Promise((r) => setTimeout(r, 150));
      const matchFound = waitFor(bob, 'match_found'); // BEFORE the emit — see waitFor's doc comment
      matchFound.catch(() => {}); // no unhandled rejection if the join fails first; the caller still sees it
      await emitAck(bob, 'join_queue', { timeControl, isGiveaway: true });
      return matchFound;
    })(),
  ]);
  check(matchA.roomId === matchB.roomId, 'two Giveaway seekers are paired');
  check(matchA.isGiveaway === true && matchB.isGiveaway === true, 'match_found tells both clients isGiveaway: true');
  check(matchA.isFogOfWar === false && matchA.isChess960 === false, 'and none of the other variant flags');

  const white = matchA.color === 'w' ? { socket: alice, name: 'Gwen' } : { socket: bob, name: 'Gus' };
  const black = matchA.color === 'b' ? { socket: alice, name: 'Gwen' } : { socket: bob, name: 'Gus' };
  const roomId = matchA.roomId;

  const move = async (who, from, to, promotion) => emitAck(who.socket, 'make_move', { roomId, from, to, promotion });
  check((await move(white, 'e2', 'e4')).ok === true, '1.e4 accepted (no capture exists yet)');
  check((await move(black, 'd7', 'd5')).ok === true, '1...d5 accepted');

  // Now exd5 is available, so every other move is illegal — the server must refuse it.
  const refused = await move(white, 'g1', 'f3');
  check(refused.ok === false && /capture is mandatory/i.test(refused.error), '2.Nf3 is REJECTED by the server while exd5 is available (mandatory capture)');
  check((await move(white, 'a2', 'a3')).ok === false, '2.a3 is rejected too');
  const blackSeesCapture = waitFor(black.socket, 'opponent_move');
  check((await move(white, 'e4', 'd5')).ok === true, '2.exd5 (the mandatory capture) is accepted');
  const seen = await blackSeesCapture;
  check(seen.san === 'exd5', 'Black receives exd5');

  // It is now Black's turn with Qxd5 / Nf6... mandatory: Qxd5 is the only capture.
  check((await move(black, 'g8', 'f6')).ok === false, "Black's non-capturing 2...Nf6 is rejected (Qxd5 is mandatory)");
  check((await move(black, 'd8', 'd5')).ok === true, '2...Qxd5 accepted');

  const whiteGameOver = waitFor(white.socket, 'game_over');
  const blackGameOver = waitFor(black.socket, 'game_over');
  check((await emitAck(white.socket, 'resign', { roomId })).ok === true, 'resignation still works in Giveaway');
  const [wr, br] = await Promise.all([whiteGameOver, blackGameOver]);
  check(wr.reason === 'resignation' && br.reason === 'resignation' && wr.winner === 'b', 'game_over reports the resignation (White resigned, so Black wins)');
  alice.disconnect();
  bob.disconnect();
}

async function testAtomicOnline() {
  console.log('\n=== Atomic: matchmaking, flag isolation, an exploded king ends the game ===');
  const timeControl = { initialSeconds: 300, incrementSeconds: 0 };

  const atomicSeeker = await connect('Ada');
  const classicSeeker = await connect('Cal');
  check((await emitAck(atomicSeeker, 'join_queue', { timeControl, isAtomic: true })).ok === true, 'Ada queues for Atomic');
  check((await emitAck(classicSeeker, 'join_queue', { timeControl })).ok === true, 'Cal queues for a classic game');
  let wronglyPaired = false;
  atomicSeeker.once('match_found', () => (wronglyPaired = true));
  classicSeeker.once('match_found', () => (wronglyPaired = true));
  await new Promise((r) => setTimeout(r, 600));
  check(!wronglyPaired, 'an Atomic seeker and a classic seeker are never paired with each other');
  await emitAck(atomicSeeker, 'leave_queue', {});
  await emitAck(classicSeeker, 'leave_queue', {});
  atomicSeeker.disconnect();
  classicSeeker.disconnect();

  const confused = await connect('Confused2');
  const conflict = await emitAck(confused, 'join_queue', { timeControl, isAtomic: true, isGiveaway: true });
  check(conflict.ok === false && /cannot be combined/i.test(conflict.error), 'Atomic + Giveaway is rejected on join_queue');
  check((await emitAck(confused, 'create_challenge', { timeControl, isAtomic: true, isFogOfWar: true })).ok === false, 'Atomic + another variant flag is rejected on create_challenge too');
  confused.disconnect();

  const alice = await connect('Atlas');
  const bob = await connect('Atom');
  const [matchA, matchB] = await Promise.all([
    (async () => {
      const matchFound = waitFor(alice, 'match_found'); // BEFORE the emit — see waitFor's doc comment
      matchFound.catch(() => {}); // no unhandled rejection if the join fails first; the caller still sees it
      await emitAck(alice, 'join_queue', { timeControl, isAtomic: true });
      return matchFound;
    })(),
    (async () => {
      await new Promise((r) => setTimeout(r, 150));
      const matchFound = waitFor(bob, 'match_found'); // BEFORE the emit — see waitFor's doc comment
      matchFound.catch(() => {}); // no unhandled rejection if the join fails first; the caller still sees it
      await emitAck(bob, 'join_queue', { timeControl, isAtomic: true });
      return matchFound;
    })(),
  ]);
  check(matchA.roomId === matchB.roomId, 'two Atomic seekers are paired');
  check(matchA.isAtomic === true && matchB.isAtomic === true && matchA.isGiveaway === false, 'match_found tells both clients isAtomic: true (and not Giveaway)');

  const white = matchA.color === 'w' ? { socket: alice } : { socket: bob };
  const black = matchA.color === 'b' ? { socket: alice } : { socket: bob };
  const roomId = matchA.roomId;
  const move = (who, from, to, promotion) => emitAck(who.socket, 'make_move', { roomId, from, to, promotion });

  check((await move(white, 'e2', 'e4')).ok === true, '1.e4 accepted');
  check((await move(black, 'e7', 'e5')).ok === true, '1...e5 accepted');
  check((await move(white, 'f1', 'c4')).ok === true, '2.Bc4 accepted');
  check((await move(black, 'b8', 'c6')).ok === true, '2...Nc6 accepted');
  check((await move(white, 'e1', 'f1')).ok === true, 'a king step is an ordinary legal move');
  check((await move(black, 'a7', 'a6')).ok === true, '...a6');
  check((await move(white, 'f1', 'e1')).ok === true, '...Ke1 back');
  check((await move(black, 'a6', 'a5')).ok === true, '...a5');

  const whiteOver = waitFor(white.socket, 'game_over');
  const blackOver = waitFor(black.socket, 'game_over');
  const bxf7 = await move(white, 'c4', 'f7');
  check(bxf7.ok === true && bxf7.san === 'Bxf7#', '3.Bxf7 explodes the black king on e8 and is written Bxf7#');
  const [wr, br] = await Promise.all([whiteOver, blackOver]);
  check(wr.reason === 'atomic' && wr.winner === 'w', 'game_over reason is atomic and White wins');
  check(br.reason === 'atomic' && br.winner === 'w', 'both players received the same outcome');
  alice.disconnect();
  bob.disconnect();
}

async function testDuckChessOnline() {
  console.log('\n=== Duck Chess: matchmaking, a turn is a move + the duck, a king capture ends the game ===');
  const timeControl = { initialSeconds: 300, incrementSeconds: 0 };

  const duckSeeker = await connect('Dora');
  const classicSeeker = await connect('Cyd');
  check((await emitAck(duckSeeker, 'join_queue', { timeControl, isDuckChess: true })).ok === true, 'Dora queues for Duck Chess');
  check((await emitAck(classicSeeker, 'join_queue', { timeControl })).ok === true, 'Cyd queues for a classic game');
  let wronglyPaired = false;
  duckSeeker.once('match_found', () => (wronglyPaired = true));
  classicSeeker.once('match_found', () => (wronglyPaired = true));
  await new Promise((r) => setTimeout(r, 600));
  check(!wronglyPaired, 'a Duck Chess seeker and a classic seeker are never paired with each other');
  await emitAck(duckSeeker, 'leave_queue', {});
  await emitAck(classicSeeker, 'leave_queue', {});
  duckSeeker.disconnect();
  classicSeeker.disconnect();

  const confused = await connect('Confused3');
  const conflict = await emitAck(confused, 'join_queue', { timeControl, isDuckChess: true, isAtomic: true });
  check(conflict.ok === false && /cannot be combined/i.test(conflict.error), 'Duck Chess + another variant is rejected on join_queue');
  check((await emitAck(confused, 'create_challenge', { timeControl, isDuckChess: true, isGiveaway: true })).ok === false, '...and on create_challenge');
  confused.disconnect();

  const alice = await connect('Duckie');
  const bob = await connect('Quack');
  const [matchA, matchB] = await Promise.all([
    (async () => {
      const matchFound = waitFor(alice, 'match_found'); // BEFORE the emit — see waitFor's doc comment
      matchFound.catch(() => {}); // no unhandled rejection if the join fails first; the caller still sees it
      await emitAck(alice, 'join_queue', { timeControl, isDuckChess: true });
      return matchFound;
    })(),
    (async () => {
      await new Promise((r) => setTimeout(r, 150));
      const matchFound = waitFor(bob, 'match_found'); // BEFORE the emit — see waitFor's doc comment
      matchFound.catch(() => {}); // no unhandled rejection if the join fails first; the caller still sees it
      await emitAck(bob, 'join_queue', { timeControl, isDuckChess: true });
      return matchFound;
    })(),
  ]);
  check(matchA.roomId === matchB.roomId, 'two Duck Chess seekers are paired');
  check(matchA.isDuckChess === true && matchB.isDuckChess === true && matchA.isAtomic === false, 'match_found tells both clients isDuckChess: true');

  const white = matchA.color === 'w' ? { socket: alice } : { socket: bob };
  const black = matchA.color === 'b' ? { socket: alice } : { socket: bob };
  const roomId = matchA.roomId;
  const turn = (who, from, to, duckTo) => emitAck(who.socket, 'make_move', { roomId, from, to, duckTo });

  const noDuck = await turn(white, 'e2', 'e4');
  check(noDuck.ok === false && /duck/i.test(noDuck.error), 'a move with no duck destination is refused');
  check((await turn(white, 'e2', 'e4', 'e4')).ok === false, 'a duck on an occupied square is refused');
  const blackSees = waitFor(black.socket, 'opponent_move');
  const first = await turn(white, 'e2', 'e4', 'a6');
  check(first.ok === true && first.duckSquare === 'a6', '1.e4 with the duck placed on a6 is accepted as one turn');
  const seen = await blackSees;
  check(seen.san === 'e4' && seen.duck === 'a6' && seen.duckSquare === 'a6', 'Black receives the move and the duck together');
  check((await turn(black, 'a7', 'a6', 'a5')).ok === false, 'Black cannot push a7-a6: the duck is on a6');
  check((await turn(black, 'f7', 'f5', 'a6')).ok === false, 'the duck may not stay where it is');
  check((await turn(black, 'f7', 'f5', 'a5')).ok === true, '1...f5 (duck to a5)');
  check((await turn(white, 'd1', 'h5', 'a4')).ok === true, '2.Qh5 (duck to a4) — the queen now looks down the h5-e8 diagonal');
  check((await turn(black, 'h7', 'h6', 'a3')).ok === true, '2...h6 (duck to a3) — Black ignores the attack, there is no check');

  const whiteOver = waitFor(white.socket, 'game_over');
  const blackOver = waitFor(black.socket, 'game_over');
  const win = await turn(white, 'h5', 'e8');
  check(win.ok === true && win.san === 'Qxe8', '3.Qxe8 captures the king and needs no duck');
  const [wr, br] = await Promise.all([whiteOver, blackOver]);
  check(wr.reason === 'duckChess' && wr.winner === 'w' && br.reason === 'duckChess' && br.winner === 'w', 'both players get game_over {reason: duckChess, winner: white}');
  alice.disconnect();
  bob.disconnect();
}

async function testNoTimeLimitOnline() {
  console.log('\n=== No time limit: live-only game with no clock ===');
  const unlimited = { initialSeconds: 0, incrementSeconds: 0 };

  const bad = await connect('Bad-tc');
  check((await emitAck(bad, 'join_queue', { timeControl: { initialSeconds: 0, incrementSeconds: 5 } })).ok === false, 'an unlimited control with an increment is rejected on join_queue');
  check((await emitAck(bad, 'join_queue', { timeControl: { initialSeconds: null, incrementSeconds: 0 } })).ok === false, '...as is a non-numeric time (Infinity serialises to null)');
  bad.disconnect();

  const timedSeeker = await connect('Timed');
  const unlimitedSeeker = await connect('Free');
  await emitAck(timedSeeker, 'join_queue', { timeControl: { initialSeconds: 300, incrementSeconds: 0 } });
  await emitAck(unlimitedSeeker, 'join_queue', { timeControl: unlimited });
  let wronglyPaired = false;
  timedSeeker.once('match_found', () => (wronglyPaired = true));
  unlimitedSeeker.once('match_found', () => (wronglyPaired = true));
  await new Promise((r) => setTimeout(r, 600));
  check(!wronglyPaired, 'a timed seeker and a no-time-limit seeker are never paired');
  await emitAck(timedSeeker, 'leave_queue', {});
  await emitAck(unlimitedSeeker, 'leave_queue', {});
  timedSeeker.disconnect();
  unlimitedSeeker.disconnect();

  const alice = await connect('Nora');
  const bob = await connect('Nico');
  const [matchA, matchB] = await Promise.all([
    (async () => {
      const matchFound = waitFor(alice, 'match_found'); // BEFORE the emit — see waitFor's doc comment
      matchFound.catch(() => {}); // no unhandled rejection if the join fails first; the caller still sees it
      await emitAck(alice, 'join_queue', { timeControl: unlimited });
      return matchFound;
    })(),
    (async () => {
      await new Promise((r) => setTimeout(r, 150));
      const matchFound = waitFor(bob, 'match_found'); // BEFORE the emit — see waitFor's doc comment
      matchFound.catch(() => {}); // no unhandled rejection if the join fails first; the caller still sees it
      await emitAck(bob, 'join_queue', { timeControl: unlimited });
      return matchFound;
    })(),
  ]);
  check(matchA.roomId === matchB.roomId, 'two no-time-limit seekers are paired');
  check(matchA.timeControl.initialSeconds === 0, 'match_found carries timeControl.initialSeconds 0 (how the clients know to hide the clock)');
  const white = matchA.color === 'w' ? { socket: alice, match: matchA } : { socket: bob, match: matchB };
  const black = matchA.color === 'w' ? { socket: bob, match: matchB } : { socket: alice, match: matchA };
  const sentinel = white.match.whiteMs;
  check(sentinel === Number.MAX_SAFE_INTEGER && white.match.blackMs === sentinel, 'both clocks start at the constant "no clock" value');

  const seen = waitFor(black.socket, 'opponent_move');
  const first = await emitAck(white.socket, 'make_move', { roomId: white.match.roomId, from: 'e2', to: 'e4' });
  check(first.ok === true && first.whiteMs === sentinel && first.blackMs === sentinel, "White's move is accepted with the clocks untouched");
  const relayed = await seen;
  check(relayed.whiteMs === sentinel && relayed.blackMs === sentinel, "Black is told the move with the clocks untouched");
  await new Promise((r) => setTimeout(r, 1300));
  const reply = await emitAck(black.socket, 'make_move', { roomId: white.match.roomId, from: 'e7', to: 'e5' });
  check(reply.ok === true && reply.whiteMs === sentinel && reply.blackMs === sentinel, 'after 1.3 s of thinking the clocks are still untouched (nothing ticks)');
  alice.disconnect();
  bob.disconnect();
}

/** Blocks THIS process's event loop for `ms` — stands in for a busy CI runner that cannot read its socket for a while. */
function stallEventLoop(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function testPairingSurvivesABusyClient() {
  console.log('\n=== Pairing: match_found is not lost when the client is busy (regression: the nightly fuzz flake) ===');
  // A time control nothing else in this suite uses, so these two can only ever pair with each other.
  const timeControl = { initialSeconds: 777, incrementSeconds: 0 };

  // THE OLD, RACY PATTERN — informational only (not asserted: whether the two frames really coalesce is up to the OS).
  // The second joiner's join_queue gets its ack and match_found back to back; with the client stalled both sit in the
  // socket and are parsed in one synchronous pass, so match_found fires before the awaiting code attaches a listener.
  {
    const early = await connect('Racy-A');
    const late = await connect('Racy-B');
    await emitAck(early, 'join_queue', { timeControl });
    const ackPromise = emitAck(late, 'join_queue', { timeControl });
    stallEventLoop(150);
    await ackPromise;
    const outcome = await waitFor(late, 'match_found', 1500).then(() => 'received', () => 'LOST');
    console.log(`  (control) ack-then-listen under a 150 ms stall: match_found ${outcome}`);
    early.disconnect();
    late.disconnect();
  }

  // THE FIX — listener first. This must always work, stalled or not.
  const first = await connect('Stall-A');
  const second = await connect('Stall-B');
  const firstMatch = waitFor(first, 'match_found');
  firstMatch.catch(() => {});
  check((await emitAck(first, 'join_queue', { timeControl })).ok === true, 'the first player joins the queue');

  const secondMatch = waitFor(second, 'match_found'); // BEFORE the emit
  secondMatch.catch(() => {});
  const secondAck = emitAck(second, 'join_queue', { timeControl });
  stallEventLoop(150); // the ack and match_found for the second player now pile up in its socket
  check((await secondAck).ok === true, 'the second player joins and is paired while its event loop was blocked for 150 ms');
  const [matchFirst, matchSecond] = await Promise.all([firstMatch, secondMatch]);
  check(matchFirst.roomId === matchSecond.roomId, 'BOTH players still received match_found, for the same room');
  first.disconnect();
  second.disconnect();
}

async function main() {
  console.log(`Connecting to ${SERVER_URL} ...`);
  await testMatchmakingAndMoveSync();
  await testLeaveQueue();
  await testDisconnectAndReconnect();
  await testClockTimeout();
  await testChess960Matchmaking();
  await testKingOfTheHillMatchmaking();
  await testKingOfTheHillWin();
  await testThreeCheckMatchmaking();
  await testThreeCheckWin();
  await testSetupChessBlindPairing();
  await testSetupChessInvalidMergeAsksBothToRedo();
  await testFogOfWarMatchmaking();
  await testFogOfWarRedactionAndWin();
  await testGiveawayMatchmakingAndMandatoryCapture();
  await testAtomicOnline();
  await testDuckChessOnline();
  await testNoTimeLimitOnline();
  await testPairingSurvivesABusyClient();

  console.log(`\nAll good — ${passedChecks} checks passed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\nTEST FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
