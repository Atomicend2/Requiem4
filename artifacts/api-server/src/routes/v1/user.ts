import { Router } from "express";
import multer from "multer";
import sharp from "sharp";
import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireAuth, type AuthRequest } from "./middleware.js";
import { getDb } from "../../bot/db/database.js";
import { getUserRank, getUserGuild, getInventory, updateUser } from "../../bot/db/queries.js";

const ASSETS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../assets");

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

router.get("/stats", requireAuth, (req: AuthRequest, res) => {
  const user = req.user;
  const db = getDb();

  const rank = getUserRank(user.id);
  const totalUsers = (db.prepare("SELECT COUNT(*) as cnt FROM users WHERE COALESCE(is_bot, 0) = 0").get() as any)?.cnt || 0;
  const xpNeeded = (user.level || 1) * 100;

  const rpgRow = db.prepare("SELECT * FROM rpg_characters WHERE user_id = ?").get(user.id) as any;
  const rpg = rpgRow
    ? {
        class: rpgRow.class || "Warrior",
        hp: rpgRow.hp || 100,
        maxHp: rpgRow.max_hp || 100,
        attack: rpgRow.attack || 20,
        defense: rpgRow.defense || 10,
        speed: rpgRow.speed || 15,
        dungeonFloor: rpgRow.dungeon_floor || 1,
        skillPoints: rpgRow.skill_points || 0,
      }
    : null;

  const guildRow = getUserGuild(user.id);
  const guild = guildRow
    ? { id: guildRow.id, name: guildRow.name, level: guildRow.level || 1 }
    : null;

  const bankCapItems = db.prepare(`
    SELECT si.effect FROM inventory i
    JOIN shop_items si ON LOWER(si.name) = LOWER(i.item)
    WHERE i.user_id = ? AND si.category = 'passive' AND si.effect LIKE 'bank_cap:%'
  `).all(user.id) as any[];
  const extraBankCap = bankCapItems.reduce((acc: number, row: any) => {
    const val = parseInt((row.effect || "").replace("bank_cap:", ""), 10) || 0;
    return acc + val;
  }, 0);
  const baseBankMax = 100_000;  // must match BASE_CAP in economy.ts
  const bankMax = baseBankMax + extraBankCap;

  const displayPhone = user.phone || user.id;

  res.json({
    profile: {
      id: user.id,
      phone: displayPhone,
      name: user.name || "Shadow",
      level: user.level || 1,
      xp: user.xp || 0,
      balance: user.balance || 0,
      bank: user.bank || 0,
      bankMax,
      lotteryTickets: user.lottery_tickets || 0,
      premium: user.premium || 0,
      bio: user.bio || "",
      registeredAt: user.created_at || 0,
      hasAvatar: !!(user.profile_picture && Buffer.isBuffer(user.profile_picture)),
      hasBackground: !!(user.profile_background && Buffer.isBuffer(user.profile_background)),
    },
    rpg,
    guild,
    rank,
    totalUsers: Number(totalUsers),
    xpNeeded,
  });
});

// ── Profile avatar image ────────────────────────────────────────────────────
router.get("/avatar", requireAuth, async (req: AuthRequest, res) => {
  const user = req.user;
  if (user.profile_picture && Buffer.isBuffer(user.profile_picture)) {
    res.set("Content-Type", "image/jpeg");
    res.set("Cache-Control", "no-cache");
    res.send(user.profile_picture);
    return;
  }
  // Serve default avatar
  const defaultPath = path.join(ASSETS_DIR, "default_pp.jpg");
  if (existsSync(defaultPath)) {
    res.set("Content-Type", "image/jpeg");
    res.set("Cache-Control", "public, max-age=86400");
    createReadStream(defaultPath).pipe(res);
  } else {
    res.status(404).json({ success: false, message: "No avatar set" });
  }
});

// ── Profile background image ────────────────────────────────────────────────
router.get("/background", requireAuth, async (req: AuthRequest, res) => {
  const user = req.user;
  if (user.profile_background && Buffer.isBuffer(user.profile_background)) {
    res.set("Content-Type", "image/jpeg");
    res.set("Cache-Control", "no-cache");
    res.send(user.profile_background);
    return;
  }
  // Serve default background
  const defaultPath = path.join(ASSETS_DIR, "default_bg.jpg");
  if (existsSync(defaultPath)) {
    res.set("Content-Type", "image/jpeg");
    res.set("Cache-Control", "public, max-age=86400");
    createReadStream(defaultPath).pipe(res);
  } else {
    res.status(404).json({ success: false, message: "No background set" });
  }
});

// ── Upload profile picture ──────────────────────────────────────────────────
router.post("/setpp", requireAuth, upload.single("image"), async (req: AuthRequest, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, message: "No image provided" });
      return;
    }
    const resized = await sharp(req.file.buffer)
      .resize(800, 800, { fit: "cover" })
      .jpeg({ quality: 92 })
      .toBuffer();
    updateUser(req.user!.id, { profile_picture: resized, profile_picture_video: null });
    res.json({ success: true, message: "Profile picture updated." });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || "Failed to process image" });
  }
});

// ── Upload profile background ───────────────────────────────────────────────
router.post("/setbg", requireAuth, upload.single("image"), async (req: AuthRequest, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, message: "No image provided" });
      return;
    }
    const resized = await sharp(req.file.buffer)
      .resize(765, 850, { fit: "cover" })
      .jpeg({ quality: 92 })
      .toBuffer();
    updateUser(req.user!.id, { profile_background: resized, profile_background_video: null });
    res.json({ success: true, message: "Profile background updated." });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || "Failed to process image" });
  }
});

// ── Skill points ────────────────────────────────────────────────────────────
router.get("/skills", requireAuth, (req: AuthRequest, res) => {
  const db = getDb();
  const rpg = db.prepare("SELECT * FROM rpg_characters WHERE user_id = ?").get(req.user!.id) as any;
  if (!rpg) {
    res.json({ skillPoints: 0, attack: 20, defense: 10, speed: 15, maxHp: 100 });
    return;
  }
  res.json({
    skillPoints: rpg.skill_points || 0,
    attack: rpg.attack || 20,
    defense: rpg.defense || 10,
    speed: rpg.speed || 15,
    maxHp: rpg.max_hp || 100,
    hp: rpg.hp || 100,
    dungeonFloor: rpg.dungeon_floor || 1,
    level: rpg.level || 1,
  });
});

router.post("/skills/assign", requireAuth, (req: AuthRequest, res) => {
  const { stat, points } = req.body as { stat?: string; points?: number };
  const validStats: Record<string, string> = {
    attack: "attack", defense: "defense", speed: "speed", hp: "max_hp",
  };
  if (!stat || !(stat in validStats)) {
    res.status(400).json({ success: false, message: "stat must be one of: attack, defense, speed, hp" });
    return;
  }
  const pts = Math.max(1, Math.floor(Number(points) || 1));
  const db = getDb();
  const rpg = db.prepare("SELECT * FROM rpg_characters WHERE user_id = ?").get(req.user!.id) as any;
  if (!rpg) {
    res.status(404).json({ success: false, message: "No RPG character found. Start with .dungeon in the bot." });
    return;
  }
  const available = rpg.skill_points || 0;
  if (pts > available) {
    res.status(400).json({ success: false, message: `Not enough skill points. You have ${available} SP.` });
    return;
  }
  const dbKey = validStats[stat];
  const gain = dbKey === "max_hp" ? pts * 5 : pts * 2;
  const current = rpg[dbKey] || 0;
  const newVal = current + gain;
  const updates: Record<string, number> = {
    skill_points: available - pts,
    [dbKey]: newVal,
  };
  if (dbKey === "max_hp") {
    updates.hp = Math.min(rpg.hp || 1, newVal);
  }
  const setClause = Object.keys(updates).map((k) => `${k} = ?`).join(", ");
  db.prepare(`UPDATE rpg_characters SET ${setClause} WHERE user_id = ?`)
    .run(...Object.values(updates), req.user!.id);
  res.json({
    success: true,
    message: `Spent ${pts} SP on ${stat}! +${gain} ${stat === "hp" ? "Max HP" : stat}.`,
    newValue: newVal,
    remainingPoints: available - pts,
  });
});

// ── Unassign skill points (downgrade a stat, refund SP) ────────────────────
router.post("/skills/unassign", requireAuth, (req: AuthRequest, res) => {
  const { stat, points } = req.body as { stat?: string; points?: number };
  const validStats: Record<string, string> = {
    attack: "attack", defense: "defense", speed: "speed", hp: "max_hp",
  };
  // Base minimums — stats cannot go below these
  const BASE_MIN: Record<string, number> = { attack: 20, defense: 10, speed: 15, max_hp: 100 };
  if (!stat || !(stat in validStats)) {
    res.status(400).json({ success: false, message: "stat must be one of: attack, defense, speed, hp" });
    return;
  }
  const pts = Math.max(1, Math.floor(Number(points) || 1));
  const db = getDb();
  const rpg = db.prepare("SELECT * FROM rpg_characters WHERE user_id = ?").get(req.user!.id) as any;
  if (!rpg) {
    res.status(404).json({ success: false, message: "No RPG character found." });
    return;
  }
  const dbKey = validStats[stat];
  const loss = dbKey === "max_hp" ? pts * 5 : pts * 2;
  const current = rpg[dbKey] || 0;
  const minVal = BASE_MIN[dbKey];
  const newVal = Math.max(minVal, current - loss);
  const actualLoss = current - newVal;
  if (actualLoss <= 0) {
    res.status(400).json({ success: false, message: `${stat} is already at its minimum value of ${minVal}.` });
    return;
  }
  const actualPtsRefunded = dbKey === "max_hp" ? Math.floor(actualLoss / 5) : Math.floor(actualLoss / 2);
  const newSp = (rpg.skill_points || 0) + actualPtsRefunded;
  const updates: Record<string, number> = {
    skill_points: newSp,
    [dbKey]: newVal,
  };
  if (dbKey === "max_hp") {
    updates.hp = Math.min(rpg.hp || newVal, newVal);
  }
  const setClause = Object.keys(updates).map((k) => `${k} = ?`).join(", ");
  db.prepare(`UPDATE rpg_characters SET ${setClause} WHERE user_id = ?`)
    .run(...Object.values(updates), req.user!.id);
  res.json({
    success: true,
    message: `Removed ${actualLoss} from ${stat}. Refunded ${actualPtsRefunded} SP.`,
    newValue: newVal,
    remainingPoints: newSp,
  });
});

router.get("/inventory", requireAuth, (req: AuthRequest, res) => {
  const items = getInventory(req.userId!);

  const categorized = items.map((item: any) => {
    const name = (item.item || "").toLowerCase();
    let category = "general";
    if (name.includes("shovel") || name.includes("fishing") || name.includes("rod") || name.includes("pickaxe")) {
      category = "tools";
    } else if (name.includes("potion") || name.includes("elixir") || name.includes("heal")) {
      category = "potions";
    } else if (name.includes("pistol") || name.includes("sword") || name.includes("gun") || name.includes("weapon") || name.includes("blade")) {
      category = "weapons";
    } else if (name.includes("note") || name.includes("bank")) {
      category = "passive";
    } else if (name.includes("ticket") || name.includes("lottery")) {
      category = "lottery";
    }
    return {
      item: item.item,
      quantity: item.quantity || 1,
      category,
    };
  });

  res.json({ items: categorized });
});

router.get("/achievements", requireAuth, (req: AuthRequest, res) => {
  const db = getDb();
  const achievements = db.prepare(
    "SELECT * FROM web_achievements WHERE user_id = ? ORDER BY earned_at DESC"
  ).all(req.userId!) as any[];

  res.json({
    achievements: achievements.map((a: any) => ({
      id: a.id,
      name: a.name,
      description: a.description || "",
      icon: a.icon || "star",
      earnedAt: a.earned_at || 0,
    })),
  });
});

export { router as userRouter };
