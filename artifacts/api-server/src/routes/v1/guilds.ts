import { Router } from "express";
import { getDb } from "../../bot/db/database.js";

const router = Router();

router.get("/", (req, res) => {
  const db = getDb();
  const search = req.query.search as string | undefined;

  let query = `
    SELECT g.*, u.name as owner_name,
      COUNT(gm.user_id) as member_count
    FROM guilds g
    LEFT JOIN users u ON u.id = g.owner_id
    LEFT JOIN guild_members gm ON gm.guild_id = g.id
  `;
  const params: any[] = [];

  if (search) {
    query += " WHERE LOWER(g.name) LIKE LOWER(?)";
    params.push(`%${search}%`);
  }
  query += " GROUP BY g.id ORDER BY g.level DESC, member_count DESC";

  const guilds = db.prepare(query).all(...params) as any[];

  res.json({
    guilds: guilds.map((g: any) => ({
      id: g.id,
      name: g.name,
      description: g.description || "",
      level: g.level || 1,
      memberCount: Number(g.member_count) || 0,
      ownerName: g.owner_name || "Unknown",
      createdAt: g.created_at || 0,
    })),
  });
});

router.get("/:guildId", (req, res) => {
  const db = getDb();
  const { guildId } = req.params;

  const guild = db.prepare(`
    SELECT g.*, u.name as owner_name,
      COUNT(gm.user_id) as member_count
    FROM guilds g
    LEFT JOIN users u ON u.id = g.owner_id
    LEFT JOIN guild_members gm ON gm.guild_id = g.id
    WHERE g.id = ?
    GROUP BY g.id
  `).get(guildId) as any;

  if (!guild) {
    res.status(404).json({ success: false, message: "Guild not found" });
    return;
  }

  const members = db.prepare(`
    SELECT gm.user_id, gm.joined_at, u.name, u.level
    FROM guild_members gm
    LEFT JOIN users u ON u.id = gm.user_id
    WHERE gm.guild_id = ?
    ORDER BY u.level DESC, gm.joined_at ASC
  `).all(guildId) as any[];

  res.json({
    guild: {
      id: guild.id,
      name: guild.name,
      description: guild.description || "",
      level: guild.level || 1,
      memberCount: Number(guild.member_count) || 0,
      ownerName: guild.owner_name || "Unknown",
      createdAt: guild.created_at || 0,
    },
    members: members.map((m: any) => ({
      userId: m.user_id,
      name: m.name || "Shadow",
      level: m.level || 1,
      joinedAt: m.joined_at || 0,
    })),
  });
});

export { router as guildsRouter };
