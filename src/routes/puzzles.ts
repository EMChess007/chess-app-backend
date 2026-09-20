import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';

const router = Router();

/** "YYYY-MM-DD" in UTC — matches the mobile app's own daily-puzzle date key convention. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

router.get('/progress', requireAuth, async (req: AuthedRequest, res) => {
  const puzzleDate = typeof req.query.date === 'string' ? req.query.date : todayUtc();

  const progress = await prisma.puzzleProgress.findUnique({
    where: { userId_puzzleDate: { userId: req.userId!, puzzleDate } },
  });

  res.json(progress ?? { userId: req.userId, puzzleDate, solved: false, completedAt: null });
});

router.post('/progress', requireAuth, async (req: AuthedRequest, res) => {
  const puzzleDate = typeof req.body?.puzzleDate === 'string' ? req.body.puzzleDate : todayUtc();
  const solved = req.body?.solved !== false;

  const progress = await prisma.puzzleProgress.upsert({
    where: { userId_puzzleDate: { userId: req.userId!, puzzleDate } },
    create: { userId: req.userId!, puzzleDate, solved, completedAt: solved ? new Date() : null },
    update: { solved, completedAt: solved ? new Date() : null },
  });

  res.json(progress);
});

export default router;
