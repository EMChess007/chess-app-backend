import { createServer } from 'node:http';
import cors from 'cors';
import 'dotenv/config';
import express, { type ErrorRequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { Server as SocketIOServer } from 'socket.io';
import { registerBughouseHandlers } from './game/bughouseHandlers.js';
import { resolveBughouseTestSeed, seededBughouseDeps } from './game/bughouseTestSwitches.js';
import { registerFourPlayerHandlers } from './game/fourPlayerHandlers.js';
import { FourStartSnapshots, createFourTestSetupRouter, resolveFourTestSeed, resolveFourTestSetup, seededFourDeps } from './game/fourTestSwitches.js';
import { registerSocketHandlers } from './game/socketHandlers.js';
import { createAuthLimiter } from './lib/authRateLimit.js';
import { resolveTrustedHops } from './lib/clientIp.js';
import { describeClientIp, httpKeyGenerator } from './lib/httpClientKey.js';
import authRouter from './routes/auth.js';
import gamesRouter from './routes/games.js';
import puzzlesRouter from './routes/puzzles.js';
import usersRouter from './routes/users.js';

// A defense-in-depth backstop, not a substitute for handling errors at their source (every
// socket.io event handler below already does that) — this exists so a future handler someone adds
// without a try/catch logs its failure instead of silently crashing the whole process and
// disconnecting every player in every active game, online or not.
process.on('unhandledRejection', (reason) => {
  console.error('[process] Unhandled promise rejection:', reason);
});

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// The number of proxies in front of this server (TRUSTED_PROXY_HOPS; 1 in production, 0 elsewhere - src/lib/clientIp.ts). One number, read once, used by BOTH sides: the sockets
// (clientIpOf) and HTTP (below). It is a NUMBER for Express, never `true`: `true` believes the leftmost X-Forwarded-For entry, which the client writes.
const trustedProxyHops = resolveTrustedHops();
app.set('trust proxy', trustedProxyHops);

app.use(helmet());
app.use(cors());
app.use(express.json());

// A generous ceiling for the whole API — mainly to blunt naive scripted abuse/scraping, not meant
// to affect any real client's normal usage pattern. Counted per CLIENT address (httpClientKey.ts: the same rule as the sockets'), not per proxy.
const httpKey = httpKeyGenerator(trustedProxyHops);
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: httpKey,
});
app.use(globalLimiter);

// DIAGNOSTIC (BUGHOUSE_SPEC.md W9 may remove it): the caller's OWN derived address and three counts, to check TRUSTED_PROXY_HOPS after a deploy. Behind the global limiter; echoes no
// header, holds no other user's data, logs no response. See TESTING.md.
app.get('/health/client-ip', (req, res) => res.json(describeClientIp(req, trustedProxyHops)));

// Tighter limit specifically for login/register — these are the endpoints an attacker would
// actually want to hammer (password brute-forcing, mass fake-account creation), and are cheap for
// a legitimate user to stay well under (nobody logs in or registers 20+ times in 15 minutes).
// 20 per 15 minutes (src/lib/authRateLimit.ts, which also holds the test-only, never-in-production override).
const authLimiter = createAuthLimiter(process.env, console.warn, httpKey);

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

// TEST-ONLY switches of the 4-seat server (src/game/fourTestSwitches.ts): with neither environment variable set (production, and every normal run) nothing below changes anything.
const fourTestSeed = resolveFourTestSeed();
const fourStartSnapshots = new FourStartSnapshots();
const fourTestSetup = resolveFourTestSetup();
if (fourTestSetup) app.use('/test-setup', createFourTestSetupRouter(fourStartSnapshots));

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
// 4 Player Chess Online: its own `four_*` events on its own connection listener - no code or state shared with the 2-player handlers above.
registerFourPlayerHandlers(io, { ...seededFourDeps(fourTestSeed), ...(fourTestSetup ? { startSnapshotFor: (variant) => fourStartSnapshots.take(variant) } : {}) });
// Bughouse Online: its own `bug_*` events on its own connection listener, its own matchmaker and room manager (BUGHOUSE_SPEC.md W2). With the seed switch unset (production, and every normal run; src/game/bughouseTestSwitches.ts) nothing is seeded.
registerBughouseHandlers(io, seededBughouseDeps(resolveBughouseTestSeed()));

// Listening on 0.0.0.0 (not just localhost) so devices on the same LAN — e.g. a phone
// running Expo Go — can reach this server via the computer's local network IP.
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`chess-app backend listening on http://0.0.0.0:${PORT} (REST + Socket.IO)`);
  // Which mode the process is really in (the test-only switches are ignored in "production"): readable in the host's deploy log. Prints the mode only, never another variable.
  console.log(`[startup] NODE_ENV=${process.env.NODE_ENV ?? '(unset)'}`);
});
