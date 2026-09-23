import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';

const router = Router();
// 'online' games are never posted through this route — the server saves those itself, straight
// from the game room, once for each player, when the game ends (see game/rooms.ts endGame). It's
// still accepted here for completeness/consistency with GET's response shape.
const OPPONENT_TYPES = new Set(['bot', 'human', 'online']);

router.post('/', requireAuth, async (req: AuthedRequest, res) => {
  const { opponentType, opponentElo, result, pgn, timeControl, isChess960, playedAt } = req.body ?? {};

  if (!OPPONENT_TYPES.has(opponentType)) {
    return res.status(400).json({ error: "opponentType must be 'bot', 'human', or 'online'" });
  }
  if (typeof result !== 'string' || !result) {
    return res.status(400).json({ error: 'result is required' });
  }
  if (typeof pgn !== 'string') {
    return res.status(400).json({ error: 'pgn is required' });
  }
  if (typeof timeControl !== 'string' || !timeControl) {
    return res.status(400).json({ error: 'timeControl is required' });
  }
  if (opponentElo !== undefined && opponentElo !== null && typeof opponentElo !== 'number') {
    return res.status(400).json({ error: 'opponentElo must be a number or null' });
  }

  const game = await prisma.game.create({
    data: {
      userId: req.userId!,
      opponentType,
      opponentElo: opponentElo ?? null,
      result,
      pgn,
      timeControl,
      isChess960: Boolean(isChess960),
      ...(playedAt ? { playedAt: new Date(playedAt) } : {}),
    },
  });

  res.status(201).json(game);
});

router.get('/', requireAuth, async (req: AuthedRequest, res) => {
  const games = await prisma.game.findMany({
    where: { userId: req.userId },
    orderBy: { playedAt: 'desc' },
  });
  res.json(games);
});

export default router;
