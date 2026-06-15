import { Router } from "express";
import { getDb } from "../../bot/db/database.js";

const router = Router();

const MAX_ENTRIES = 15;

router.get("/", (_req, res) => {
  const db = getDb();

  const activeLottery = db.prepare(`
    SELECT * FROM lotteries WHERE active = 1 ORDER BY created_at DESC LIMIT 1
  `).get() as any;

  let entries: any[] = [];
  let entryCount = 0;
  let pool = 0;

  if (activeLottery) {
    pool = activeLottery.pool || 0;
    const rawEntries = db.prepare(`
      SELECT le.user_id, le.amount, le.created_at, u.name
      FROM lottery_entries le
      LEFT JOIN users u ON u.id = le.user_id
      WHERE le.lottery_id = ?
      ORDER BY le.created_at ASC
    `).all(activeLottery.id) as any[];
    entryCount = rawEntries.length;
    entries = rawEntries.map((e: any) => ({
      userId: e.user_id,
      name: e.name || "Shadow",
      enteredAt: e.created_at || 0,
    }));
  }

  const recentWinners = db.prepare(`
    SELECT l.winner_id, l.pool, l.ended_at, u.name
    FROM lotteries l
    LEFT JOIN users u ON u.id = l.winner_id
    WHERE l.active = 0 AND l.winner_id IS NOT NULL
    ORDER BY l.ended_at DESC
    LIMIT 10
  `).all() as any[];

  res.json({
    active: !!activeLottery,
    pool,
    entryCount,
    maxEntries: MAX_ENTRIES,
    entries,
    recentWinners: recentWinners.map((w: any) => ({
      userId: w.winner_id,
      name: w.name || "Shadow",
      prize: w.pool || 0,
      wonAt: w.ended_at || 0,
    })),
  });
});

export { router as lotteryRouter };
