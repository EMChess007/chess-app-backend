#!/usr/bin/env node
/**
 * End-to-end smoke test for the tournament layer (create/join/start, round-robin pairing
 * progression, points, standings) — same style and same "connect to an already-running backend
 * as real socket.io-client players" approach as test-multiplayer.mjs. No mocking.
 *
 * Usage:
 *   npm run dev                       (in one terminal, from backend/)
 *   node scripts/test-tournament.mjs  (in another)
 *
 * BACKEND_URL env var overrides the default http://localhost:3000.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

const SERVER_URL = process.env.BACKEND_URL ?? 'http://localhost:3000';
let passedChecks = 0;

function check(condition, message) {
  assert.ok(condition, message);
  passedChecks++;
  console.log(`  ✓ ${message}`);
}

async function registerUser(username) {
  const res = await fetch(`${SERVER_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${username}.${randomUUID().slice(0, 8)}@test.local`, username, password: 'testpassword123' }),
  });
  if (!res.ok) throw new Error(`register ${username} failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { userId: data.user.id, username: data.user.username, token: data.token };
}

function connect(name, token) {
  return new Promise((resolve, reject) => {
    const socket = io(SERVER_URL, { transports: ['websocket'], reconnection: false, auth: token ? { token } : {} });
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

function waitFor(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function testGuestsAreRejected() {
  console.log('\n=== 1. Guests cannot create or join a tournament ===');
  const guest = await connect('Guest', null);
  const createAck = await emitAck(guest, 'create_tournament', {
    name: 'Guest Cup',
    timeControl: { initialSeconds: 180, incrementSeconds: 0 },
    isChess960: false,
  });
  check(createAck.ok === false, 'create_tournament rejected for a guest (no auth token)');
  const joinAck = await emitAck(guest, 'join_tournament', { code: 'ABCDEF' });
  check(joinAck.ok === false, 'join_tournament rejected for a guest (no auth token)');
  guest.disconnect();
}

async function testMinimumPlayersToStart() {
  console.log('\n=== 2. Starting requires at least 3 players, and only the creator may start ===');
  const alice = await registerUser(`alice_${randomUUID().slice(0, 6)}`);
  const bob = await registerUser(`bob_${randomUUID().slice(0, 6)}`);
  const aliceSocket = await connect('Alice', alice.token);
  const bobSocket = await connect('Bob', bob.token);

  const createAck = await emitAck(aliceSocket, 'create_tournament', {
    name: 'Two Player Cup',
    timeControl: { initialSeconds: 180, incrementSeconds: 0 },
    isChess960: false,
  });
  check(createAck.ok === true, "Alice's create_tournament ack is ok");

  const joinAck = await emitAck(bobSocket, 'join_tournament', { code: createAck.code });
  check(joinAck.ok === true, 'Bob joins with the code');
  check(joinAck.tournament.participants.length === 2, 'lobby reports 2 participants');

  const bobStartAck = await emitAck(bobSocket, 'start_tournament', { tournamentId: createAck.tournamentId });
  check(bobStartAck.ok === false, 'a non-creator cannot start the tournament');

  const tooFewAck = await emitAck(aliceSocket, 'start_tournament', { tournamentId: createAck.tournamentId });
  check(tooFewAck.ok === false, 'the creator cannot start with only 2 participants');

  aliceSocket.disconnect();
  bobSocket.disconnect();
}

async function testFullRoundRobinProgression() {
  console.log('\n=== 3. Full 3-player round robin: pairing progression, points, standings ===');
  const alice = await registerUser(`alice_${randomUUID().slice(0, 6)}`);
  const bob = await registerUser(`bob_${randomUUID().slice(0, 6)}`);
  const carol = await registerUser(`carol_${randomUUID().slice(0, 6)}`);
  const aliceSocket = await connect('Alice', alice.token);
  const bobSocket = await connect('Bob', bob.token);
  const carolSocket = await connect('Carol', carol.token);
  const socketByName = { Alice: aliceSocket, Bob: bobSocket, Carol: carolSocket };
  const nameByUserId = { [alice.userId]: 'Alice', [bob.userId]: 'Bob', [carol.userId]: 'Carol' };

  const createAck = await emitAck(aliceSocket, 'create_tournament', {
    name: 'Round Robin Cup',
    timeControl: { initialSeconds: 300, incrementSeconds: 0 },
    isChess960: false,
  });
  check(createAck.ok === true, "Alice's create_tournament ack is ok");
  const tournamentId = createAck.tournamentId;

  const bobJoin = emitAck(bobSocket, 'join_tournament', { code: createAck.code });
  const bobSeesLobby = waitFor(bobSocket, 'tournament_lobby_update');
  await Promise.all([bobJoin, bobSeesLobby]);

  const carolJoin = await emitAck(carolSocket, 'join_tournament', { code: createAck.code });
  check(carolJoin.ok === true, 'Carol joins with the code');
  check(carolJoin.tournament.participants.length === 3, 'lobby reports 3 participants once Carol joins');

  // start_tournament: with 3 players (Alice, Bob, Carol), the round-robin schedule is exactly the
  // 3 pairs [A-B, A-C, B-C]. Only one pair per player can run at once, so starting should launch
  // exactly ONE of the three pairs immediately (whichever the pairing algorithm reaches first
  // with both sides free) and leave the third player waiting.
  const readyEvents = [];
  const captureReady = (who) => (payload) => readyEvents.push({ who, payload });
  aliceSocket.on('tournament_match_ready', captureReady('Alice'));
  bobSocket.on('tournament_match_ready', captureReady('Bob'));
  carolSocket.on('tournament_match_ready', captureReady('Carol'));

  const startAck = await emitAck(aliceSocket, 'start_tournament', { tournamentId });
  check(startAck.ok === true, 'the creator starts the tournament successfully');
  await new Promise((r) => setTimeout(r, 300));

  check(readyEvents.length === 2, 'exactly 2 of the 3 players received tournament_match_ready (one pair started)');
  const readyNames = readyEvents.map((e) => e.who).sort();
  const waitingName = ['Alice', 'Bob', 'Carol'].find((n) => !readyNames.includes(n));
  console.log(`  First pair started: ${readyNames.join(' vs ')} — ${waitingName} is waiting`);

  const roomId = readyEvents[0].payload.roomId;
  check(readyEvents.every((e) => e.payload.roomId === roomId), 'both notified players share the same roomId');

  // Play out every match by resigning (fastest deterministic way to finish a room's game) until
  // the whole round robin completes, tracking who "won" each pair as we go. The first entry in
  // the currently-ready pair always resigns — arbitrary but deterministic, and every game ends
  // decisively (never a draw), which is all the points assertions below need.
  const finishedPairs = [];
  while (finishedPairs.length < 3) {
    // The server emits the NEXT pair's tournament_match_ready synchronously right after the
    // previous match's game_over — by the time this loop even gets here it may well have already
    // arrived (queued in readyEvents ahead of us), so this only needs to poll briefly, not
    // unconditionally sleep first.
    const deadline = Date.now() + 3000;
    while (readyEvents.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    check(readyEvents.length === 2, `exactly one pair is ready before match #${finishedPairs.length + 1}`);
    // Consume exactly this pair's two notifications (not a blanket reset) — any later pair's
    // events that happened to already have arrived stay queued for the next loop iteration.
    const [resignerReady, otherReady] = readyEvents.splice(0, 2);
    const resignerSocket = socketByName[resignerReady.who];
    const otherSocket = socketByName[otherReady.who];

    const resignerGameOver = waitFor(resignerSocket, 'game_over');
    const otherGameOver = waitFor(otherSocket, 'game_over');
    await emitAck(resignerSocket, 'resign', { roomId: resignerReady.payload.roomId });
    const [resignerResult] = await Promise.all([resignerGameOver, otherGameOver]);
    check(resignerResult.reason === 'resignation', `${resignerReady.who} vs ${otherReady.who}: game ended by resignation`);
    finishedPairs.push({ loser: resignerReady.who, winner: otherReady.who });
    console.log(`  Match finished: ${resignerReady.who} resigned to ${otherReady.who}`);
  }

  check(finishedPairs.length === 3, 'all 3 round-robin pairs were played to completion');

  // Every unique pair among Alice/Bob/Carol must have played exactly once.
  const playedPairs = new Set(finishedPairs.map((f) => [f.loser, f.winner].sort().join('-')));
  check(playedPairs.size === 3, 'each pair of players faced each other exactly once (true round robin)');

  const winsCount = { Alice: 0, Bob: 0, Carol: 0 };
  for (const f of finishedPairs) winsCount[f.winner] += 1;

  const finalStandings = await emitAck(aliceSocket, 'get_tournament_standings', { tournamentId });
  check(finalStandings.ok === true, 'get_tournament_standings ack is ok');
  check(finalStandings.standings.status === 'finished', 'tournament status is "finished" after all pairs played');

  const expectedPointsByName = { Alice: winsCount.Alice, Bob: winsCount.Bob, Carol: winsCount.Carol };
  for (const row of finalStandings.standings.standings) {
    const name = nameByUserId[row.userId];
    check(row.points === expectedPointsByName[name], `${name}'s final points (${row.points}) match resignation outcomes`);
    check(row.played === 2, `${name} played exactly 2 matches (round robin of 3)`);
  }
  const sortedDesc = [...finalStandings.standings.standings].every(
    (row, i, arr) => i === 0 || arr[i - 1].points >= row.points
  );
  check(sortedDesc, 'standings are sorted by points, descending');

  aliceSocket.disconnect();
  bobSocket.disconnect();
  carolSocket.disconnect();
}

async function testKingOfTheHillFlagThreadsThrough() {
  console.log('\n=== 4. King of the Hill flag propagates: create -> lobby -> match ===');
  const dan = await registerUser(`dan_${randomUUID().slice(0, 6)}`);
  const eva = await registerUser(`eva_${randomUUID().slice(0, 6)}`);
  const fay = await registerUser(`fay_${randomUUID().slice(0, 6)}`);
  const danSocket = await connect('Dan', dan.token);
  const evaSocket = await connect('Eva', eva.token);
  const faySocket = await connect('Fay', fay.token);

  const createAck = await emitAck(danSocket, 'create_tournament', {
    name: 'Hilltop Cup',
    timeControl: { initialSeconds: 180, incrementSeconds: 0 },
    isChess960: false,
    isKingOfTheHill: true,
  });
  check(createAck.ok === true, "Dan's create_tournament ack is ok");

  const evaJoinAck = await emitAck(evaSocket, 'join_tournament', { code: createAck.code });
  check(evaJoinAck.ok === true, 'Eva joins with the code');
  check(evaJoinAck.tournament.isKingOfTheHill === true, "the lobby state Eva receives reports isKingOfTheHill: true");

  const readyPromise = Promise.race([waitFor(danSocket, 'tournament_match_ready'), waitFor(evaSocket, 'tournament_match_ready'), waitFor(faySocket, 'tournament_match_ready')]);
  await emitAck(faySocket, 'join_tournament', { code: createAck.code });
  const startAck = await emitAck(danSocket, 'start_tournament', { tournamentId: createAck.tournamentId });
  check(startAck.ok === true, 'the tournament starts successfully');

  const readyPayload = await readyPromise;
  check(readyPayload.isKingOfTheHill === true, 'the first tournament_match_ready payload also reports isKingOfTheHill: true');

  danSocket.disconnect();
  evaSocket.disconnect();
  faySocket.disconnect();
}

async function main() {
  console.log(`Connecting to ${SERVER_URL} ...`);
  await testGuestsAreRejected();
  await testMinimumPlayersToStart();
  await testFullRoundRobinProgression();
  await testKingOfTheHillFlagThreadsThrough();

  console.log(`\nAll good — ${passedChecks} checks passed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\nTEST FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
