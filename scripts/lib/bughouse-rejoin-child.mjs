/**
 * A NEW PROCESS as the restarted app (Bughouse W7, scripts/test-bughouse-sockets.mjs): it knows nothing but what the app would have saved - the server address, the room and the seat's token -
 * connects with a socket of its own, asks `bug_rejoin`, prints ONE json line with what it was given, and then waits on stdin:
 *   "resign"  -> sends bug_resign and prints the ack as one json line
 *   (stdin closed) -> disconnects and exits.
 * It prints only the seat, the seq, the snapshot text and the ack's flags - never the token it was given.
 *
 *   node scripts/lib/bughouse-rejoin-child.mjs '{"url":"http://localhost:3000","roomId":"...","playerToken":"..."}'
 */
import { createInterface } from 'node:readline';
import { io } from 'socket.io-client';

const { url, roomId, playerToken } = JSON.parse(process.argv[2] ?? '{}');
const socket = io(url, { transports: ['websocket'], reconnection: false });
const say = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const timer = setTimeout(() => {
  say({ ok: false, error: 'the child could not connect in 8 s' });
  process.exit(1);
}, 8000);

socket.on('connect', () => {
  socket.timeout(5000).emit('bug_rejoin', { roomId, playerToken }, (err, ack) => {
    clearTimeout(timer);
    if (err) {
      say({ ok: false, error: 'the rejoin ack never arrived' });
      process.exit(1);
    }
    say(ack.ok ? { ok: true, finished: ack.finished === true, seat: ack.state?.seat ?? null, seq: ack.state?.seq ?? null, text: ack.state?.state ?? null, gameOver: ack.gameOver?.state ?? null } : { ok: false, reason: ack.reason, error: ack.error });
  });
});
socket.on('connect_error', (error) => {
  say({ ok: false, error: `connect_error: ${error.message}` });
  process.exit(1);
});

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() !== 'resign') return;
  socket.timeout(5000).emit('bug_resign', { roomId }, (err, ack) => say({ resign: err ? { ok: false, error: 'no ack' } : { ok: ack.ok === true, reason: ack.reason } }));
}).on('close', () => {
  socket.disconnect();
  process.exit(0);
});
