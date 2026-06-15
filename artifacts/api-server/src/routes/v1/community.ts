import { Router } from "express";
import { getDb } from "../../bot/db/database.js";

const router = Router();

router.get("/stats", (_req, res) => {
  const db = getDb();

  const totalMembers = (db.prepare("SELECT COUNT(*) as cnt FROM users WHERE COALESCE(is_bot, 0) = 0 AND COALESCE(registered, 0) = 1").get() as any)?.cnt || 0;
  const totalCards = (db.prepare("SELECT COUNT(*) as cnt FROM cards").get() as any)?.cnt || 0;
  const totalGuilds = (db.prepare("SELECT COUNT(*) as cnt FROM guilds").get() as any)?.cnt || 0;
  const totalBots = (db.prepare("SELECT COUNT(*) as cnt FROM bots").get() as any)?.cnt || 0;
  const activeMissions = (db.prepare(`
    SELECT COUNT(*) as cnt FROM rpg_characters
    WHERE last_adventure > (unixepoch() - 3600)
      OR last_quest > (unixepoch() - 3600)
  `).get() as any)?.cnt || 0;
  const totalTransactions = (db.prepare("SELECT COUNT(*) as cnt FROM inventory").get() as any)?.cnt || 0;

  res.json({
    totalMembers: Number(totalMembers),
    totalBots: Number(totalBots),
    activeMissions: Number(activeMissions),
    totalCards: Number(totalCards),
    totalGuilds: Number(totalGuilds),
    totalTransactions: Number(totalTransactions),
  });
});

export { router as communityRouter };
