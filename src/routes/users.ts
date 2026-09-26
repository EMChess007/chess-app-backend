import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';

const router = Router();

const RATING_CATEGORIES = ['bullet', 'blitz', 'rapid'] as const;
type RatingCategory = (typeof RATING_CATEGORIES)[number];
const RATING_FIELD: Record<RatingCategory, 'bulletRating' | 'blitzRating' | 'rapidRating'> = {
  bullet: 'bulletRating',
  blitz: 'blitzRating',
  rapid: 'rapidRating',
};

router.get('/me', requireAuth, async (req: AuthedRequest, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json({ id: user.id, email: user.email, username: user.username, createdAt: user.createdAt });
});

// Mirrors the client's own locally-computed rating (see src/logic/rating.ts) so the leaderboard
// below can read it — the server never computes the Elo math itself, just stores whatever number
// the client already arrived at (see the User model's bulletRating/blitzRating/rapidRating
// comment for why: bot-game results, a major input to that math, never touch the server at all).
router.post('/me/rating', requireAuth, async (req: AuthedRequest, res) => {
  const { category, rating } = req.body ?? {};
  if (!RATING_CATEGORIES.includes(category) || typeof rating !== 'number' || !Number.isFinite(rating)) {
    return res.status(400).json({ error: 'Invalid category or rating.' });
  }
  const field = RATING_FIELD[category as RatingCategory];
  await prisma.user.update({ where: { id: req.userId }, data: { [field]: Math.round(rating) } });
  res.json({ ok: true });
});

// Top 50 by rating for the requested category — a simple global leaderboard (no friends-graph),
// plus the requesting user's own rank/rating so they can see where they stand even if they're
// outside the top 50 shown.
router.get('/leaderboard', requireAuth, async (req: AuthedRequest, res) => {
  const category = req.query.category;
  if (typeof category !== 'string' || !RATING_CATEGORIES.includes(category as RatingCategory)) {
    return res.status(400).json({ error: 'Invalid or missing category.' });
  }
  const field = RATING_FIELD[category as RatingCategory];

  const [top, me] = await Promise.all([
    prisma.user.findMany({
      orderBy: { [field]: 'desc' },
      take: 50,
      select: { id: true, username: true, bulletRating: true, blitzRating: true, rapidRating: true },
    }),
    prisma.user.findUnique({
      where: { id: req.userId },
      select: { bulletRating: true, blitzRating: true, rapidRating: true },
    }),
  ]);

  const ratingOf = (u: { bulletRating: number; blitzRating: number; rapidRating: number }) => u[field];
  const myRating = me ? ratingOf(me) : null;
  const myRank = myRating === null ? null : (await prisma.user.count({ where: { [field]: { gt: myRating } } })) + 1;

  res.json({
    entries: top.map((u, index) => ({ rank: index + 1, userId: u.id, username: u.username, rating: ratingOf(u) })),
    me: myRating === null ? null : { rating: myRating, rank: myRank },
  });
});

export default router;
