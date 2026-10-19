/**
 * The server's side of the story, read through a real spectator socket: the room as the SERVER holds it (state text, seq, clocks, seats), kept current from `four_state` /
 * `four_seat_update` / `four_game_over`. The browser tests compare what the screens show with this, using the MOBILE APP's own engine (src/logic/fourPlayer, imported file by
 * file as the nightly fuzz does - a namespace import of its index would expose nothing under tsx) to read the snapshot - not the server's generated copy.
 */
import { io } from 'socket.io-client';
import { SEAT_NAMES, SQUARE8 } from '../../../src/logic/fourPlayer/board.ts';
import { CHATURAJI_RULES, deserialize, rulesFor } from '../../../src/logic/fourPlayer/state.ts';
import { applyMoveRaw, isInCheck, legalMoves, moveLabelOn } from '../../../src/logic/fourPlayer/moves.ts';
import { sleep } from './stack.mjs';

export { SEAT_NAMES, SQUARE8, CHATURAJI_RULES, legalMoves, moveLabelOn, isInCheck, applyMoveRaw };

const emitAck = (socket, event, payload) =>
  new Promise((resolve, reject) => {
    socket.timeout(8000).emit(event, payload, (err, response) => (err ? reject(new Error(`"${event}" ack never arrived`)) : resolve(response)));
  });

/** Lists the live 4-seat games and returns the one whose seat names are all among `names` (the test's own accounts), or null. */
export async function findRoom(socket, names, variant = 'chaturaji') {
  const { ok, games } = await emitAck(socket, 'four_list_active_games', {});
  if (!ok) return null;
  return games.find((g) => (g.variant ?? 'ffa') === variant && names.every((n) => g.seats.some((s) => s.name === n))) ?? null;
}

/**
 * Watches one room. `latest` is always the newest state; `waitFor(predicate)` resolves when a state satisfies it. The deserialized state is cached per seq.
 */
export async function watchRoom(apiUrl, roomId, variant = 'chaturaji') {
  const socket = io(apiUrl, { transports: ['websocket'], reconnection: false });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  const rules = rulesFor(variant);
  const room = { seq: -1, text: '', state: null, clocksMs: [0, 0, 0, 0], seats: [], gameOver: null, gains: [], events: [] };
  const adopt = (seq, text, clocksMs) => {
    if (seq <= room.seq) return;
    const next = deserialize(text, rules);
    // every score increase between two consecutive positions: what the screens must have announced as "+N"
    if (room.state && seq === room.seq + 1) for (let seat = 0; seat < 4; seat++) if (next.score[seat] > room.state.score[seat]) room.gains.push({ seq, seat, points: next.score[seat] - room.state.score[seat] });
    room.seq = seq;
    room.text = text;
    room.state = next;
    room.clocksMs = clocksMs;
  };
  socket.on('four_state', (p) => {
    if (p.roomId !== roomId) return;
    room.events.push(...(p.events ?? []));
    adopt(p.seq, p.state, p.clocksMs);
  });
  socket.on('four_seat_update', (p) => {
    if (p.roomId === roomId) room.seats = p.seats;
  });
  socket.on('four_game_over', (p) => {
    if (p.roomId === roomId) room.gameOver = p;
  });
  const ack = await emitAck(socket, 'four_spectate_game', { roomId });
  if (!ack.ok) throw new Error(`could not spectate: ${ack.error}`);
  adopt(ack.state.seq, ack.state.state, ack.state.clocksMs);
  room.seats = ack.state.seats;
  return {
    room,
    socket,
    close: () => socket.disconnect(),
    /** Resolves with the room when `predicate(room)` holds (checked on every event and every 50 ms). */
    async waitFor(predicate, what, timeoutMs = 60_000) {
      const t0 = Date.now();
      while (!predicate(room)) {
        if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
        await sleep(50);
      }
      return room;
    },
  };
}

/** What a cell's accessibility label must start with for the engine state: "e4, Red knight" / "e4, eliminated Blue pawn" / "e4". */
export function expectedCellPrefix(state, square) {
  const name = SQUARE8.squareName(square);
  const code = state.cells[square];
  if (code <= 0) return name;
  const seat = code >> 4;
  return `${name}, ${state.status[seat] === 'active' ? '' : 'eliminated '}${SEAT_NAMES[seat]}`;
}

const TYPE_WORDS = ['', 'pawn', 'knight', 'bishop', 'boat', 'queen', 'king', 'queen', 'knight', 'bishop', 'boat'];
/** The full label a cell must carry for a piece, boats included ("d8, Red boat"). */
export function expectedPieceLabel(state, square) {
  const code = state.cells[square];
  if (code <= 0) return SQUARE8.squareName(square);
  const seat = code >> 4;
  return `${SQUARE8.squareName(square)}, ${state.status[seat] === 'active' ? '' : 'eliminated '}${SEAT_NAMES[seat]} ${TYPE_WORDS[code & 15]}`;
}
