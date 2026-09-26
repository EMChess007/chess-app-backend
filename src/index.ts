import { createServer } from 'node:http';
import cors from 'cors';
import 'dotenv/config';
import express, { type ErrorRequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { Server as SocketIOServer } from 'socket.io';
import { registerSocketHandlers } from './game/socketHandlers.js';
import authRouter from './routes/auth.js';
import gamesRouter from './routes/games.js';
import puzzlesRouter from './routes/puzzles.js';
import usersRouter from './routes/users.js';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(helmet());
app.use(cors());
app.use(express.json());

// A generous ceiling for the whole API — mainly to blunt naive scripted abuse/scraping, not meant
// to affect any real client's normal usage pattern.
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

// Tighter limit specifically for login/register — these are the endpoints an attacker would
// actually want to hammer (password brute-forcing, mass fake-account creation), and are cheap for
// a legitimate user to stay well under (nobody logs in or registers 20+ times in 15 minutes).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});

// Without this, a successful request produces zero terminal output — indistinguishable from
// a request that never arrived at all, which makes "is my client even reaching the backend?"
// impossible to debug from this log alone.
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/auth', authLimiter, authRouter);
app.use('/users', usersRouter);
app.use('/games', gamesRouter);
app.use('/puzzles', puzzlesRouter);

// Express 5 forwards rejected promises from async route handlers here automatically, so a
// DB hiccup or bug returns a 500 to that one request instead of crashing the whole process.
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
};
app.use(errorHandler);

// Socket.IO needs a raw http.Server to attach to (it upgrades HTTP connections to WebSocket
// itself), so the Express app is wrapped in one instead of using app.listen() directly — both
// the REST API and the realtime game/matchmaking layer share this single server and port.
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, { cors: { origin: '*' } });
registerSocketHandlers(io);

// Listening on 0.0.0.0 (not just localhost) so devices on the same LAN — e.g. a phone
// running Expo Go — can reach this server via the computer's local network IP.
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`chess-app backend listening on http://0.0.0.0:${PORT} (REST + Socket.IO)`);
});
