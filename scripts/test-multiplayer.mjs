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
      const ack = await emitAck(alice, 'join_queue', { timeControl, isChess960: false });
      check(ack.ok === true, 'Alice join_queue ack is ok');
      return waitFor(alice, 'match_found');
    })(),
    (async () => {
      await new Promise((r) => setTimeout(r, 150)); // keeps the log order readable, not required for correctness
      const ack = await emitAck(bob, 'join_queue', { timeControl, isChess960: false });
      check(ack.ok === true, 'Bob join_queue ack is ok');
      return waitFor(bob, 'match_found');
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
      await emitAck(eve, 'join_queue', { timeControl, isChess960: false });
      return waitFor(eve, 'match_found');
    })(),
    (async () => {
      await new Promise((r) => setTimeout(r, 150));
      await emitAck(frank, 'join_queue', { timeControl, isChess960: false });
      return waitFor(frank, 'match_found');
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
      await emitAck(gina, 'join_queue', { timeControl, isChess960: false });
      return waitFor(gina, 'match_found');
    })(),
    (async () => {
      await new Promise((r) => setTimeout(r, 150));
      await emitAck(hank, 'join_queue', { timeControl, isChess960: false });
      return waitFor(hank, 'match_found');
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
      await emitAck(oscar, 'join_queue', { timeControl, isChess960: false, isKingOfTheHill: true });
      return waitFor(oscar, 'match_found');
    })(),
    (async () => {
      await new Promise((r) => setTimeout(r, 150));
      await emitAck(petra, 'join_queue', { timeControl, isChess960: false, isKingOfTheHill: true });
      return waitFor(petra, 'match_found');
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

async function main() {
  console.log(`Connecting to ${SERVER_URL} ...`);
  await testMatchmakingAndMoveSync();
  await testLeaveQueue();
  await testDisconnectAndReconnect();
  await testClockTimeout();
  await testChess960Matchmaking();
  await testKingOfTheHillMatchmaking();
  await testKingOfTheHillWin();

  console.log(`\nAll good — ${passedChecks} checks passed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\nTEST FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
