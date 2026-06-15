import { Router } from "express";
import { requireAuth, optionalAuth, type AuthRequest } from "./middleware.js";
import { getDb } from "../../bot/db/database.js";
import { getUserRank } from "../../bot/db/queries.js";

const router = Router();

router.get("/", optionalAuth, (req, res) => {
  const db = getDb();
  const limit = Math.min(100, Math.max(5, Number(req.query.limit) || 10));

  const entries = db.prepare(`
    SELECT u.id, u.name, u.xp, u.level,
      g.name as guild_name
    FROM users u
    LEFT JOIN guild_members gm ON gm.user_id = u.id
    LEFT JOIN guilds g ON g.id = gm.guild_id
    WHERE COALESCE(u.is_bot, 0) = 0
      AND COALESCE(u.registered, 0) = 1
    ORDER BY COALESCE(u.level, 1) DESC, COALESCE(u.xp, 0) DESC
    LIMIT ?
  `).all(limit) as any[];

  const result = entries.map((u: any, idx: number) => ({
    rank: idx + 1,
    userId: u.id,
    name: u.name || "Shadow",
    level: u.level || 1,
    xp: u.xp || 0,
    guildName: u.guild_name || null,
  }));

  res.json({ entries: result });
});

router.get("/me", requireAuth, (req: AuthRequest, res) => {
  const db = getDb();
  const user = req.user;
  const rank = getUserRank(user.id);
  const total = (db.prepare("SELECT COUNT(*) as cnt FROM users WHERE COALESCE(is_bot, 0) = 0 AND COALESCE(registered, 0) = 1").get() as any)?.cnt || 0;

  const guildRow = db.prepare(`
    SELECT g.name as guild_name FROM guild_members gm
    JOIN guilds g ON g.id = gm.guild_id
    WHERE gm.user_id = ?
  `).get(user.id) as any;

  res.json({
    rank,
    total: Number(total),
    entry: {
      rank,
      userId: user.id,
      name: user.name || "Shadow",
      level: user.level || 1,
      xp: user.xp || 0,
      guildName: guildRow?.guild_name || null,
    },
  });
});

export { router as leaderboardRouter };
