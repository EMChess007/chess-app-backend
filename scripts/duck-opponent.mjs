#!/usr/bin/env node
/**
 * A live Duck Chess opponent for MANUAL testing — a real socket.io client (a guest) that plays random legal Duck Chess
 * turns through the real server, so you can play the other side from the app and watch the real OnlineGameScreen
 * (duck highlighting, notation, turn flow, rejoin, spectating) without a second device. Not part of CI or the nightly.
 *
 *   npx tsx scripts/duck-opponent.mjs                  # challenge mode (default): prints a code, waits for you
 *   npx tsx scripts/duck-opponent.mjs queue            # joins the quick-match queue for Duck Chess
 *   npx tsx scripts/duck-opponent.mjs join ABC123      # joins somebody else's challenge by code
 * Options (any order): --time=300 (initial seconds; 0 = No time limit), --inc=0, --delay=1500 (ms "thinking" per turn),
 *   --draws=accept|decline (default decline), --once (stop after one game instead of starting another).
 * BACKEND_URL overrides the default http://localhost:3000.
 *
 * From the app: in challenge mode, Challenge a Friend → Join by Code → enter the printed code (no dev flag needed).
 * In queue mode, Play Online → Duck Chess (needs EXPO_PUBLIC_ENABLE_ONLINE_DUCK=true) → the SAME time control as --time.
 *
 * It uses the mobile app's own duck-aware move generation (the same one the nightly fuzz uses), and takes a king when it
 * can so games end. It never resigns or offers draws, and it leaves when the server closes the socket.
 */
import { io } from 'socket.io-client';
import { ChessEngine } from '../../src/logic/ChessEngine.ts';
import { getLegalDuckPlacementSquares } from '../../src/logic/duckChess.ts';

const SERVER_URL = process.env.BACKEND_URL ?? 'http://localhost:3000';
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const positional = args.filter((a) => !a.startsWith('--'));
const mode = positional[0] ?? 'challenge';
const joinCode = positional[1];
const initialSeconds = Number(opt('time', 300));
const incrementSeconds = Number(opt('inc', 0));
const thinkMs = Number(opt('delay', 1500));
const acceptDraws = opt('draws', 'decline') === 'accept';
const once = args.includes('--once');
if (!['challenge', 'queue', 'join'].includes(mode) || (mode === 'join' && !joinCode)) {
  console.error('Usage: duck-opponent.mjs [challenge | queue | join CODE] [--time=300] [--inc=0] [--delay=1500] [--draws=accept|decline] [--once]');
  process.exit(2);
}
const timeControl = { initialSeconds, incrementSeconds };
const timeControlLabel = initialSeconds <= 0 ? 'No time limit' : incrementSeconds > 0 ? `${Math.round(initialSeconds / 60)} | ${incrementSeconds}` : `${Math.round(initialSeconds / 60)} min`;

const log = (...parts) => console.log(`[${new Date().toLocaleTimeString()}]`, ...parts);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randInt = (n) => Math.floor(Math.random() * n);

const socket = io(SERVER_URL, { transports: ['websocket'], reconnection: false });
const ack = (event, payload) =>
  new Promise((resolve, reject) => {
    socket.timeout(8000).emit(event, payload, (err, response) => (err ? reject(new Error(`"${event}" ack timed out`)) : resolve(response)));
  });

let game = null; // { roomId, color, fen, duck, over }
let gameCount = 0;
let finishedGame = null; // resolves the current game's promise

const newEngine = (fen, duck) => new ChessEngine(fen, { skipValidation: true, duckChess: true, duckSquare: duck });

async function takeTurnIfMine() {
  const g = game;
  if (!g || g.over || g.busy) return;
  const engine = newEngine(g.fen, g.duck);
  if (engine.getTurn() !== g.color) return;
  g.busy = true;
  try {
    await sleep(thinkMs);
    if (g.over) return;
    const legal = engine.getPseudoLegalMoves(g.color);
    if (legal.length === 0) return; // a blockade — the server ends the game by itself
    const kingTakes = legal.filter((m) => newEngine(g.fen, g.duck).movePseudoLegal(m.from, m.to, m.promotion)?.captured === 'k');
    const pool = kingTakes.length > 0 ? kingTakes : legal;
    const pick = pool[randInt(pool.length)];
    const after = newEngine(g.fen, g.duck);
    const applied = after.movePseudoLegal(pick.from, pick.to, pick.promotion);
    const capturesKing = applied?.captured === 'k';
    const squares = capturesKing ? [] : getLegalDuckPlacementSquares(after, g.duck);
    const duckTo = capturesKing ? undefined : squares[randInt(squares.length)];
    const res = await ack('make_move', { roomId: g.roomId, from: pick.from, to: pick.to, promotion: pick.promotion, duckTo });
    if (!res.ok) {
      log(`my turn ${pick.from}${pick.to}${duckTo ? ` @${duckTo}` : ''} was REFUSED by the server: ${res.error}`);
      return;
    }
    g.fen = res.fen;
    if (!capturesKing) g.duck = res.duckSquare ?? duckTo ?? g.duck;
    log(`played ${res.san}${duckTo ? ` @${duckTo}` : ''}`);
  } finally {
    g.busy = false;
  }
}

socket.on('match_found', (m) => {
  gameCount++;
  game = { roomId: m.roomId, color: m.color, fen: m.fen, duck: null, over: false, busy: false };
  log(`Game ${gameCount} started — I am ${m.color === 'w' ? 'White' : 'Black'} (room ${m.roomId}), ${m.isDuckChess ? 'Duck Chess' : 'NOT Duck Chess (!)'}, ${m.timeControl.initialSeconds <= 0 ? 'No time limit' : `${m.timeControl.initialSeconds / 60} min`}`);
  takeTurnIfMine();
});
socket.on('opponent_move', (p) => {
  if (!game) return;
  game.fen = p.fen;
  if (p.duckSquare !== undefined) game.duck = p.duckSquare;
  log(`you played ${p.san ?? '?'}${p.duck ? ` @${p.duck}` : ''}`);
  takeTurnIfMine();
});
socket.on('draw_offered', async () => {
  if (!game) return;
  log(`you offered a draw — ${acceptDraws ? 'accepting' : 'declining'}`);
  await ack('respond_draw', { roomId: game.roomId, accept: acceptDraws }).catch(() => {});
});
socket.on('opponent_disconnected', () => log('you disconnected (the server gives you 45 s to come back)'));
socket.on('opponent_reconnected', () => log('you are back'));
socket.on('chat_message', (c) => log(`chat: ${c.text}`));
socket.on('game_over', (o) => {
  if (!game) return;
  game.over = true;
  log(`Game over — ${o.reason}, winner: ${o.winner ?? 'nobody (draw)'}`);
  finishedGame?.();
});
socket.on('disconnect', () => {
  log('disconnected from the server — exiting');
  process.exit(0);
});

function waitForGameEnd() {
  return new Promise((resolve) => (finishedGame = resolve));
}

socket.on('connect', async () => {
  log(`connected to ${SERVER_URL} as a guest`);
  for (;;) {
    const ended = waitForGameEnd();
    if (mode === 'join') {
      const res = await ack('join_challenge', { code: joinCode });
      if (!res.ok) {
        log(`could not join ${joinCode}: ${res.error}`);
        process.exit(1);
      }
      log(`joined challenge ${joinCode}`);
    } else if (mode === 'queue') {
      const res = await ack('join_queue', { timeControl, timeControlLabel, isDuckChess: true });
      if (!res.ok) {
        log(`could not queue: ${res.error}`);
        process.exit(1);
      }
      log(`waiting in the Duck Chess queue (${timeControlLabel}) — pick Duck Chess + ${timeControlLabel} in the app`);
    } else {
      const res = await ack('create_challenge', { timeControl, timeControlLabel, isDuckChess: true });
      if (!res.ok) {
        log(`could not create a challenge: ${res.error}`);
        process.exit(1);
      }
      log(`CHALLENGE CODE:  ${res.code}   (${timeControlLabel}, Duck Chess) — in the app: Challenge a Friend → Join by Code`);
    }
    await ended;
    if (once || mode === 'join') break;
    log('starting another game…');
    await sleep(1500);
  }
  socket.disconnect();
});
