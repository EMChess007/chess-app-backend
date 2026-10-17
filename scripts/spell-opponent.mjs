#!/usr/bin/env node
/**
 * A live Spell Chess opponent for MANUAL testing — a real socket.io client (a guest) that plays random legal Spell Chess turns through the real
 * server, so you can play the other side from the app and watch the real OnlineGameScreen (Freeze/Jump bar, frozen squares, notation, rejoin,
 * spectating) without a second device. Not part of CI or the nightly (the CI coverage is the Spell scenario in test-multiplayer.mjs).
 *
 *   npx tsx scripts/spell-opponent.mjs                  # challenge mode (default): prints a code, waits for you
 *   npx tsx scripts/spell-opponent.mjs queue            # joins the quick-match queue for Spell Chess
 *   npx tsx scripts/spell-opponent.mjs join ABC123      # joins somebody else's challenge by code
 * Options (any order): --time=300 (initial seconds; 0 = No time limit), --inc=0, --delay=1500 (ms "thinking" per turn), --elo=1500 (how eager it is to
 *   cast: the app's own bot cast heuristic), --cast=0.35 (extra probability of a random legal cast on top of the heuristic's choice, so every spell path
 *   gets exercised), --draws=accept|decline (default decline), --once (stop after one game instead of starting another).
 * BACKEND_URL overrides the default http://localhost:3000.
 *
 * From the app: in challenge mode, Challenge a Friend -> Join by Code -> enter the printed code. In queue mode, Quick Match -> the Spell Chess variant ->
 * the SAME time control as --time.
 *
 * Every turn is assembled with the mobile app's OWN Spell Chess engine, exactly like its Bot screen does: an optional cast (chooseSpellChessBotCast, plus
 * random extra casts), the turn context (spellTurnContext: frozen squares read BEFORE the cast, jump square AFTER it, the Freeze zone that may waive check),
 * and the moves that are legal under that context (getSpellChessLegalMoves). A cast that leaves no legal move is dropped for that turn. It takes a king
 * with a Jump when it can so games end, never resigns or offers draws, and leaves when the server closes the socket.
 */
import { io } from 'socket.io-client';
import { ChessEngine } from '../../src/logic/ChessEngine.ts';
import { chooseSpellChessBotCast, getSpellChessLegalMoves } from '../../src/logic/bots.ts';
import {
  canCastFreeze,
  canCastJump,
  checkIsWaivedByFreeze,
  getFreezeZoneSquares,
  initialSpellChessState,
  spellMoveNotation,
  spellTurnContext,
} from '../../src/logic/spellChess.ts';

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
const elo = Number(opt('elo', 1500));
const extraCastChance = Number(opt('cast', 0.35));
const acceptDraws = opt('draws', 'decline') === 'accept';
const once = args.includes('--once');
if (!['challenge', 'queue', 'join'].includes(mode) || (mode === 'join' && !joinCode)) {
  console.error('Usage: spell-opponent.mjs [challenge | queue | join CODE] [--time=300] [--inc=0] [--delay=1500] [--elo=1500] [--cast=0.35] [--draws=accept|decline] [--once]');
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

let game = null; // { roomId, color, fen, spellState, over, busy }
let gameCount = 0;
let finishedGame = null; // resolves the current game's promise

const scratch = (fen) => new ChessEngine(fen, { skipValidation: true, spellChess: true });

/** Everything needed to play one candidate turn: the cast (or null), its context and the legal moves under it. */
function turnOptions(fen, color, spellState, cast) {
  const ctx = spellTurnContext(spellState, color, cast);
  const freezeEscapeActive = ctx.freezeZone ? checkIsWaivedByFreeze(scratch(fen), color, ctx.freezeZone) : false;
  const moves = getSpellChessLegalMoves(fen, color, { chess960: false, frozenSquares: ctx.frozenSquares, jumpSquare: ctx.jumpSquare, freezeEscapeActive });
  return { ctx, moves };
}

/** The app's own cast heuristic first, then (with probability --cast) a random legal cast, so every spell path gets played now and then. */
function pickCast(fen, color, spellState) {
  const engine = scratch(fen);
  const chosen = chooseSpellChessBotCast(engine, color, spellState, elo);
  if (chosen) return chosen;
  if (Math.random() >= extraCastChance) return null;
  const occupied = [];
  for (const file of 'abcdefgh') for (const rank of '12345678') if (engine.getPieceAt(`${file}${rank}`)) occupied.push(`${file}${rank}`);
  const choices = [];
  if (canCastFreeze(spellState, color)) {
    const center = occupied[randInt(occupied.length)];
    choices.push({ type: 'freeze', center, squares: getFreezeZoneSquares(center) });
  }
  if (canCastJump(spellState, color)) choices.push({ type: 'jump', square: occupied[randInt(occupied.length)] });
  return choices.length > 0 ? choices[randInt(choices.length)] : null;
}

async function takeTurnIfMine() {
  const g = game;
  if (!g || g.over || g.busy) return;
  if (scratch(g.fen).getTurn() !== g.color) return;
  g.busy = true;
  try {
    await sleep(thinkMs);
    if (g.over) return;
    let cast = pickCast(g.fen, g.color, g.spellState);
    let { moves } = turnOptions(g.fen, g.color, g.spellState, cast);
    if (moves.length === 0 && cast) {
      cast = null; // a cast that leaves no legal move is dropped for this turn
      ({ moves } = turnOptions(g.fen, g.color, g.spellState, null));
    }
    if (moves.length === 0) return; // checkmate / stalemate — the server ends the game by itself
    const kingTakes = moves.filter((m) => m.captured === 'k');
    const captures = moves.filter((m) => m.captured);
    const pool = kingTakes.length > 0 ? kingTakes : captures.length > 0 && Math.random() < 0.4 ? captures : moves;
    const pick = pool[randInt(pool.length)];
    const res = await ack('make_move', { roomId: g.roomId, from: pick.from, to: pick.to, promotion: pick.promotion, ...(cast ? { spell: cast } : {}) });
    if (!res.ok) {
      log(`my turn ${pick.from}${pick.to}${cast ? ` (${cast.type})` : ''} was REFUSED by the server: ${res.error}`);
      return;
    }
    g.fen = res.fen;
    if (res.spellState !== undefined) g.spellState = res.spellState;
    log(`played ${spellMoveNotation({ san: res.san }, cast)}`);
  } finally {
    g.busy = false;
  }
}

socket.on('match_found', (m) => {
  gameCount++;
  game = { roomId: m.roomId, color: m.color, fen: m.fen, spellState: initialSpellChessState(), over: false, busy: false };
  log(`Game ${gameCount} started — I am ${m.color === 'w' ? 'White' : 'Black'} (room ${m.roomId}), ${m.isSpellChess ? 'Spell Chess' : 'NOT Spell Chess (!)'}, ${m.timeControl.initialSeconds <= 0 ? 'No time limit' : `${Math.round(m.timeControl.initialSeconds / 60)} min`}`);
  takeTurnIfMine();
});
socket.on('opponent_move', (p) => {
  if (!game) return;
  game.fen = p.fen;
  if (p.spellState !== undefined) game.spellState = p.spellState;
  log(`you played ${spellMoveNotation({ san: p.san ?? '?' }, p.spell ?? null)}`);
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
      const res = await ack('join_queue', { timeControl, timeControlLabel, isSpellChess: true });
      if (!res.ok) {
        log(`could not queue: ${res.error}`);
        process.exit(1);
      }
      log(`waiting in the Spell Chess queue (${timeControlLabel}) — pick Spell Chess + ${timeControlLabel} in the app`);
    } else {
      const res = await ack('create_challenge', { timeControl, timeControlLabel, isSpellChess: true });
      if (!res.ok) {
        log(`could not create a challenge: ${res.error}`);
        process.exit(1);
      }
      log(`CHALLENGE CODE:  ${res.code}   (${timeControlLabel}, Spell Chess) — in the app: Challenge a Friend → Join by Code`);
    }
    await ended;
    if (once || mode === 'join') break;
    log('starting another game…');
    await sleep(1500);
  }
  socket.disconnect();
});
