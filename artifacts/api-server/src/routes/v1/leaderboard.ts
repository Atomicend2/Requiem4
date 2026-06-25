import { Router } from "express";
import { requireAuth, optionalAuth, type AuthRequest } from "./middleware.js";
import { col } from "../../bot/db/mongo.js";
import { getUserRank } from "../../bot/db/queries.js";

const router = Router();

router.get("/", optionalAuth, async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(5, Number(req.query.limit) || 10));

    const users = await col("users")
      .find({ is_bot: { $ne: 1 }, registered: 1 })
      .sort({ level: -1, xp: -1 })
      .limit(limit)
      .project({ _id: 1, name: 1, xp: 1, level: 1 })
      .toArray();

    const userIds = users.map((u) => u._id);
    const memberships = await col("guild_members").find({ user_id: { $in: userIds } }).toArray();
    const guildIds = memberships.map((m) => m.guild_id);
    const guilds = await col("guilds").find({ _id: { $in: guildIds as any[] } }).project({ _id: 1, name: 1 }).toArray();
    const guildMap = new Map(guilds.map((g) => [g._id as string, g.name]));
    const memberGuildMap = new Map(memberships.map((m) => [m.user_id, m.guild_id]));

    const result = users.map((u: any, idx: number) => ({
      rank: idx + 1,
      userId: u._id,
      name: u.name || "Shadow",
      level: u.level || 1,
      xp: u.xp || 0,
      guildName: guildMap.get(memberGuildMap.get(u._id) || "") || null,
    }));

    res.json({ entries: result });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/me", requireAuth, async (req: AuthRequest, res) => {
  try {
    const user = req.user;
    const [rank, total, membership] = await Promise.all([
      getUserRank(user.id),
      col("users").countDocuments({ is_bot: { $ne: 1 }, registered: 1 }),
      col("guild_members").findOne({ user_id: user.id }),
    ]);

    let guildName: string | null = null;
    if (membership) {
      const guild = await col("guilds").findOne({ _id: membership.guild_id as any }, { projection: { name: 1 } });
      guildName = guild?.name || null;
    }

    res.json({
      rank,
      total,
      entry: {
        rank,
        userId: user.id,
        name: user.name || "Shadow",
        level: user.level || 1,
        xp: user.xp || 0,
        guildName,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export { router as leaderboardRouter };
