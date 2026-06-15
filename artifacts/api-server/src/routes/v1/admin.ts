import { Router, type Request, type Response, type NextFunction } from "express";
import { randomBytes } from "crypto";
import { requireAuth, type AuthRequest } from "./middleware.js";
import { getDb } from "../../bot/db/database.js";
import { getSocket, isSocketConnected } from "../../bot/connection.js";
import {
  startBot, stopBot, getAllBotsStatus, getBotStatusInfo, setPrimaryBot, requestBotPairingCode, setBotPersona,
} from "../../bot/bot-manager.js";
import { PERSONA_LIST, isValidPersona } from "../../bot/commands/personas.js";
import multer from "multer";
import path from "path";
import fs from "fs";

const router = Router();

// Setup multer for image uploads
const uploadDir = path.join(process.cwd(), "data", "uploads", "menu-images");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
      const botId = (req.params as any).id || "default";
      cb(null, `menu-${botId}-${Date.now()}${path.extname(file.originalname)}`);
    },
  }),
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|gif)$/i;
    if (allowed.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"));
    }
  },
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
});

const ADMIN_PASSWORD = process.env["ADMIN_PASSWORD"] || "Flowers";

// ── Owner identity ────────────────────────────────────────────────────────────
// BOT_OWNER_PHONE → plain phone number (e.g. 2348XXXXXXXXX) — the real phone.
// BOT_OWNER_LID   → WhatsApp internal LID (e.g. 101014040526896) — NOT a phone.
// These are completely different. Never mix them up.
const OWNER_PHONE = (process.env["BOT_OWNER_PHONE"] || "2348144550593").replace(/\D/g, "");
const OWNER_LID   = (process.env["BOT_OWNER_LID"]   || "101014040526896").replace(/\D/g, "");

/**
 * Check whether the authenticated request belongs to the bot owner.
 *
 * Three-way check so old sessions and partially-migrated DB rows
 * all resolve correctly:
 *   1. req.user.phone matches the owner phone number
 *   2. req.user.id matches the owner phone number (or old JID forms)
 *   3. req.user.lid matches the owner LID (catches rows found via LID before phone was set)
 */
function isOwner(req: AuthRequest): boolean {
  const phone  = (req.user?.phone || "").replace(/\D/g, "");
  const userId = (req.user?.id   || "");
  const lid    = (req.user?.lid  || "").replace(/\D/g, "");

  // Check 1: phone column matches owner phone
  if (phone && phone === OWNER_PHONE) return true;

  // Check 2: id column matches owner phone (or old @s.whatsapp.net / :device forms)
  const userIdDigits = userId.split("@")[0].split(":")[0].replace(/\D/g, "");
  if (userIdDigits === OWNER_PHONE) return true;

  // Check 3: LID column matches owner LID
  if (OWNER_LID && lid && lid === OWNER_LID) return true;

  return false;
}

function isStaff(req: AuthRequest): boolean {
  if (isOwner(req)) return true;
  const db = getDb();
  const userId = req.user?.id || "";
  const phone  = (req.user?.phone || "").replace(/\D/g, "");
  // Check by id, phone, and common JID variants
  const row = db.prepare(
    "SELECT 1 FROM staff WHERE user_id = ? OR user_id = ? OR user_id LIKE ?"
  ).get(userId, phone, `${userId.split("@")[0]}%`);
  return !!row;
}

function isAdminToken(token: string): boolean {
  if (!token) return false;
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare("SELECT 1 FROM admin_sessions WHERE token = ? AND expires_at > ?").get(token, now);
  return !!row;
}

function requireAdminAccess(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (isAdminToken(token)) {
    (req as any).isAdminSession = true;
    next();
    return;
  }
  requireAuth(req as AuthRequest, res, () => {
    if (!isStaff(req as AuthRequest) && !isOwner(req as AuthRequest)) {
      res.status(403).json({ success: false, message: "Access denied." });
      return;
    }
    next();
  });
}

// ─── Auth ───────────────────────────────────────────────────────────

router.post("/login", (req, res) => {
  const { password } = req.body as { password?: string };
  if (!password || password !== ADMIN_PASSWORD) {
    res.status(401).json({ success: false, message: "Invalid password." });
    return;
  }
  const db = getDb();
  const token = randomBytes(32).toString("hex");
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 30 * 24 * 3600;
  db.prepare("INSERT INTO admin_sessions (token, created_at, expires_at) VALUES (?, ?, ?)").run(token, now, expiresAt);
  res.json({ success: true, token });
});

// ─── Stats ───────────────────────────────────────────────────────────

router.get("/stats", requireAdminAccess as any, async (req: AuthRequest, res) => {
  const db = getDb();

  const totalUsers   = (db.prepare("SELECT COUNT(*) as c FROM users WHERE COALESCE(is_bot,0)=0 AND COALESCE(registered,0)=1").get() as any)?.c || 0;
  const totalBots    = (db.prepare("SELECT COUNT(*) as c FROM bots").get() as any)?.c || 0;
  const totalCards   = (db.prepare("SELECT COUNT(*) as c FROM cards").get() as any)?.c || 0;
  const totalGuilds  = (db.prepare("SELECT COUNT(*) as c FROM guilds").get() as any)?.c || 0;
  const totalBanned  = (db.prepare("SELECT COUNT(*) as c FROM banned_entities").get() as any)?.c || 0;
  const totalStaff   = (db.prepare("SELECT COUNT(*) as c FROM staff").get() as any)?.c || 0;

  const recentUsers = db.prepare(
    `SELECT u.id, u.name, u.phone, u.level, u.xp, u.balance, u.bank,
      COALESCE(u.premium,0) as premium, COALESCE(u.is_bot,0) as is_bot,
      COALESCE(u.registered,0) as registered, u.created_at,
      (SELECT s.role FROM staff s WHERE s.user_id = u.id LIMIT 1) as role,
      (SELECT 1 FROM banned_entities WHERE id = u.id AND type='user') as is_banned
    FROM users u WHERE COALESCE(u.is_bot,0)=0 ORDER BY u.created_at DESC LIMIT 20`
  ).all();

  const staffList = db.prepare(
    "SELECT s.user_id, s.role, u.name, u.phone FROM staff s LEFT JOIN users u ON s.user_id = u.id"
  ).all();

  const topUsers = db.prepare(
    `SELECT id, name, phone, level, xp, balance, bank FROM users
     WHERE COALESCE(is_bot,0)=0 AND COALESCE(registered,0)=1
       AND id NOT IN (SELECT id FROM banned_entities WHERE type='user')
     ORDER BY level DESC, xp DESC LIMIT 10`
  ).all();

  const botConnected = isSocketConnected();
  const { getPairingCode } = await import("../../bot/connection.js");

  res.json({
    botConnected,
    pairingCode: getPairingCode(),
    isOwner: isOwner(req),
    stats: { totalUsers, totalBots, totalCards, totalGuilds, totalBanned, totalStaff },
    recentUsers,
    staffList,
    topUsers,
  });
});

// ─── Player Search ────────────────────────────────────────────────────────

router.get("/players", requireAdminAccess as any, (req, res) => {
  const { q } = req.query as { q?: string };
  if (!q || q.trim().length < 1) {
    res.json({ success: true, players: [] });
    return;
  }
  const db = getDb();
  const term = `%${q.trim()}%`;
  const players = db.prepare(`
    SELECT u.id, u.name,
           COALESCE(NULLIF(u.phone,''), u.id) as phone,
           u.balance, u.bank, u.level, u.xp,
           COALESCE(u.registered,0) as registered, u.created_at,
           COALESCE(u.is_bot,0) as is_bot,
           (SELECT 1 FROM banned_entities WHERE id = u.id AND type='user') as is_banned,
           (SELECT s.role FROM staff s WHERE s.user_id = u.id LIMIT 1) as role
    FROM users u
    WHERE (u.name LIKE ? OR u.phone LIKE ? OR u.id LIKE ?)
      AND COALESCE(u.is_bot,0) = 0
    ORDER BY u.level DESC LIMIT 25
  `).all(term, term, term) as any[];
  res.json({ success: true, players });
});

router.get("/players/:id", requireAdminAccess as any, (req, res) => {
  const db = getDb();
  const id = decodeURIComponent(req.params.id);
  const player = db.prepare(`
    SELECT u.*,
      (SELECT 1 FROM banned_entities WHERE id = u.id AND type='user') as is_banned,
      (SELECT s.role FROM staff s WHERE s.user_id = u.id LIMIT 1) as staff_role
    FROM users u WHERE u.id = ?
  `).get(id) as any;
  if (!player) { res.status(404).json({ success: false, message: "Player not found." }); return; }

  const inventory = db.prepare("SELECT * FROM inventory WHERE user_id = ?").all(id);
  const cards = db.prepare(`
    SELECT uc.id as uc_id, uc.obtained_at, c.name, c.series, c.tier
    FROM user_cards uc JOIN cards c ON c.id = uc.card_id
    WHERE uc.user_id = ? ORDER BY uc.obtained_at DESC LIMIT 20
  `).all(id);
  const warnings = db.prepare("SELECT * FROM warnings WHERE user_id = ? ORDER BY created_at DESC LIMIT 10").all(id);
  const rpg = db.prepare("SELECT * FROM rpg_characters WHERE user_id = ?").get(id) || {};

  res.json({ success: true, player, inventory, cards, warnings, rpg });
});

router.post("/players/:id/ban", requireAdminAccess as any, (req, res) => {
  const db = getDb();
  const id = decodeURIComponent(req.params.id);
  const { reason } = req.body as { reason?: string };
  db.prepare("INSERT OR REPLACE INTO banned_entities (type, target, display, reason, added_by) VALUES ('user', ?, ?, ?, ?)")
    .run(id, id, reason || "Admin ban", (req as any).user?.id || "admin");
  res.json({ success: true, message: "Player banned." });
});

router.post("/players/:id/unban", requireAdminAccess as any, (req, res) => {
  const db = getDb();
  const id = decodeURIComponent(req.params.id);
  db.prepare("DELETE FROM banned_entities WHERE type = 'user' AND target = ?").run(id);
  res.json({ success: true, message: "Player unbanned." });
});

router.post("/players/:id/coins", requireAdminAccess as any, (req, res) => {
  const db = getDb();
  const id = decodeURIComponent(req.params.id);
  const { amount, target } = req.body as { amount?: number; target?: "wallet" | "bank" };
  const field = target === "bank" ? "bank" : "balance";
  const player = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as any;
  if (!player) { res.status(404).json({ success: false, message: "Player not found." }); return; }
  const current = Number(player[field] || 0);
  const next = Math.max(0, current + Number(amount || 0));
  db.prepare(`UPDATE users SET ${field} = ?, updated_at = unixepoch() WHERE id = ?`).run(next, id);
  res.json({ success: true, message: `${field === "balance" ? "Wallet" : "Bank"} set to ${next}.` });
});

router.post("/players/:id/role", requireAdminAccess as any, (req, res) => {
  const db = getDb();
  const id = decodeURIComponent(req.params.id);
  const { role } = req.body as { role?: string };
  if (!role || !["user", "guardian", "mod", "owner"].includes(role.toLowerCase())) {
    res.status(400).json({ success: false, message: "Invalid role. Valid: user, guardian, mod, owner" });
    return;
  }
  if (role.toLowerCase() === "user") {
    db.prepare("DELETE FROM staff WHERE user_id = ?").run(id);
  } else {
    db.prepare("INSERT OR REPLACE INTO staff (user_id, role, added_at) VALUES (?, ?, unixepoch())").run(id, role.toLowerCase());
  }
  res.json({ success: true, message: `Role set to ${role}.` });
});

router.post("/players/:id/reset", requireAdminAccess as any, (req, res) => {
  const db = getDb();
  const id = decodeURIComponent(req.params.id);
  db.prepare("UPDATE users SET balance=0, bank=0, xp=0, level=1, updated_at=unixepoch() WHERE id=?").run(id);
  db.prepare("DELETE FROM inventory WHERE user_id=?").run(id);
  res.json({ success: true, message: "Player economy reset." });
});

router.post("/players/:id/clear-cooldowns", requireAdminAccess as any, (req, res) => {
  const db = getDb();
  const id = decodeURIComponent(req.params.id);
  db.prepare("UPDATE users SET last_daily=0,last_work=0,last_dig=0,last_fish=0,last_beg=0,last_gamble=0,last_steal=0 WHERE id=?").run(id);
  res.json({ success: true, message: "Cooldowns cleared." });
});

// ─── Dedup: merge LID-keyed rows into phone-keyed rows ────────────────────
// Calling POST /api/v1/admin/dedup-users cleans up duplicate rows created
// when the bot stored users under their LID before phone resolution happened.
router.post("/dedup-users", requireAdminAccess as any, (req, res) => {
  const db = getDb();
  // Find all rows where id looks like a LID (>13 digits, no @, no -)
  const lidRows = db.prepare(
    "SELECT * FROM users WHERE length(id) > 13 AND id NOT LIKE '%@%' AND id NOT LIKE '%-%' AND COALESCE(phone,'') != '' AND phone != id"
  ).all() as any[];

  let merged = 0;
  let deleted = 0;
  const CHILD_TABLES = ["rpg_characters","inventory","user_cards","message_counts","card_deck","deck_backgrounds","guild_members","warnings","muted_users","summer_tokens","afk_users","staff"];

  for (const lidRow of lidRows) {
    const phone = (lidRow.phone || "").replace(/\D/g, "");
    if (!phone) continue;
    const phoneRow = db.prepare("SELECT * FROM users WHERE id = ?").get(phone) as any;
    db.transaction(() => {
      if (!phoneRow) {
        // Rename LID row to phone
        db.prepare("UPDATE users SET id = ?, phone = ?, lid = COALESCE(lid, ?) WHERE id = ?")
          .run(phone, phone, lidRow.id, lidRow.id);
        for (const t of CHILD_TABLES) {
          try { db.prepare(`UPDATE OR IGNORE ${t} SET user_id = ? WHERE user_id = ?`).run(phone, lidRow.id); } catch {}
        }
        merged++;
      } else {
        // Phone row exists — keep it, drop the LID orphan
        db.prepare("UPDATE users SET lid = COALESCE(lid, ?) WHERE id = ?").run(lidRow.id, phone);
        db.prepare("DELETE FROM users WHERE id = ?").run(lidRow.id);
        deleted++;
      }
    })();
  }

  res.json({ success: true, message: `Dedup complete. Merged: ${merged}, deleted duplicates: ${deleted}.` });
});

// ─── Legacy Actions ───────────────────────────────────────────────────────

router.post("/reset-balance", requireAdminAccess as any, (req: AuthRequest, res) => {
  if (!(req as any).isAdminSession && !isOwner(req)) {
    res.status(403).json({ success: false, message: "Owner only." });
    return;
  }
  const db = getDb();
  db.prepare("UPDATE users SET balance = 0, bank = 0").run();
  res.json({ success: true, message: "All balances reset to zero." });
});

router.post("/ban", requireAdminAccess as any, (req: AuthRequest, res) => {
  const { phone } = req.body as { phone?: string };
  if (!phone) { res.status(400).json({ success: false, message: "phone required" }); return; }
  const db = getDb();
  const normalized = phone.replace(/\D/g, "");
  db.prepare("INSERT OR IGNORE INTO banned_entities (type, target, reason, added_by, added_at) VALUES ('user', ?, 'Admin ban', ?, unixepoch())")
    .run(normalized, (req as AuthRequest).user?.id || "admin");
  res.json({ success: true, message: `${normalized} banned.` });
});

router.post("/unban", requireAdminAccess as any, (req: AuthRequest, res) => {
  const { phone } = req.body as { phone?: string };
  if (!phone) { res.status(400).json({ success: false, message: "phone required" }); return; }
  const db = getDb();
  const normalized = phone.replace(/\D/g, "");
  db.prepare("DELETE FROM banned_entities WHERE type = 'user' AND target = ?").run(normalized);
  res.json({ success: true, message: `${normalized} unbanned.` });
});

// ─── Bot Management ───────────────────────────────────────────────────────

router.get("/bots", requireAdminAccess as any, (_req, res) => {
  res.json({ success: true, bots: getAllBotsStatus() });
});

router.get("/bots/status", requireAdminAccess as any, (_req, res) => {
  res.json({ success: true, bots: getAllBotsStatus() });
});

router.post("/bots", requireAdminAccess as any, (req, res) => {
  const { name, phone } = req.body as { name?: string; phone?: string };
  if (!name) { res.status(400).json({ success: false, message: "name required" }); return; }
  const db = getDb();
  const existing = db.prepare("SELECT COUNT(*) as c FROM bots").get() as any;
  if ((existing?.c || 0) >= 5) {
    res.status(400).json({ success: false, message: "Maximum 5 bots allowed." });
    return;
  }
  const id = randomBytes(6).toString("hex");
  const authDir = `data/bots/${id}/auth`;
  db.prepare("INSERT INTO bots (id, name, phone, auth_dir, status, roles) VALUES (?, ?, ?, ?, 'disconnected', '[]')")
    .run(id, name.trim(), (phone || "").replace(/\D/g, ""), authDir);
  res.json({ success: true, message: `Bot "${name}" registered.`, id });
});

router.post("/bots/:id/start", requireAdminAccess as any, async (req, res) => {
  try {
    await startBot(req.params.id);
    res.json({ success: true, message: "Bot starting — check status for pairing code." });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/bots/:id/stop", requireAdminAccess as any, async (req, res) => {
  try {
    await stopBot(req.params.id);
    res.json({ success: true, message: "Bot stopped." });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/bots/:id/set-primary", requireAdminAccess as any, (req, res) => {
  setPrimaryBot(req.params.id);
  res.json({ success: true, message: "Primary bot updated." });
});

// ─── AI Companion Personas ───────────────────────────────────────────────────

router.get("/personas", requireAdminAccess as any, (_req, res) => {
  res.json({
    success: true,
    personas: PERSONA_LIST.map((p) => ({ key: p.key, displayName: p.displayName, shortLabel: p.shortLabel })),
  });
});

router.post("/bots/:id/persona", requireAdminAccess as any, (req, res) => {
  const { persona } = req.body as { persona?: string };
  if (!isValidPersona(persona)) {
    res.status(400).json({ success: false, message: "Unknown persona." });
    return;
  }
  const db = getDb();
  const bot = db.prepare("SELECT id FROM bots WHERE id = ?").get(req.params.id);
  if (!bot) { res.status(404).json({ success: false, message: "Bot not found." }); return; }
  setBotPersona(req.params.id, persona);
  res.json({ success: true, message: "Persona updated." });
});

router.get("/bots/:id/status", requireAdminAccess as any, (req, res) => {
  const status = getBotStatusInfo(req.params.id);
  if (!status) { res.status(404).json({ success: false, message: "Bot not found." }); return; }
  res.json({ success: true, bot: status });
});

router.delete("/bots/:id", requireAdminAccess as any, async (req, res) => {
  try {
    await stopBot(req.params.id);
  } catch {}
  const db = getDb();
  db.prepare("DELETE FROM bots WHERE id = ?").run(req.params.id);
  res.json({ success: true, message: "Bot removed." });
});

router.post("/bots/:id/request-pairing", requireAdminAccess as any, async (req, res) => {
  const { phone } = req.body as { phone?: string };
  if (!phone) { res.status(400).json({ success: false, message: "phone required" }); return; }
  try {
    const code = await requestBotPairingCode(req.params.id, phone);
    res.json({ success: true, code, message: `Pairing code: ${code}` });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/bots/:id/roles", requireAdminAccess as any, (req, res) => {
  const { id } = req.params;
  const { roles } = req.body as { roles?: string[] };
  if (!Array.isArray(roles)) { res.status(400).json({ success: false, message: "roles must be array" }); return; }
  const db = getDb();
  db.prepare("UPDATE bots SET roles = ? WHERE id = ?").run(JSON.stringify(roles), id);
  res.json({ success: true, message: "Roles updated." });
});

// ─── Menu Image Upload ───────────────────────────────────────────────────────

router.post("/bots/:id/menu-image", requireAdminAccess as any, upload.single("image"), (req, res) => {
  if (!req.file) {
    res.status(400).json({ success: false, message: "No image provided." });
    return;
  }

  const db = getDb();
  const botId = req.params.id;
  const imagePath = req.file.path;

  try {
    db.prepare("UPDATE bots SET menu_image_url = ? WHERE id = ?").run(imagePath, botId);
    res.json({ success: true, message: "Menu image uploaded successfully.", imagePath });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/bots/:id/menu-image", requireAdminAccess as any, (req, res) => {
  const db = getDb();
  const botId = req.params.id;
  const bot = db.prepare("SELECT menu_image_url FROM bots WHERE id = ?").get(botId) as any;

  if (!bot || !bot.menu_image_url || !fs.existsSync(bot.menu_image_url)) {
    res.status(404).json({ success: false, message: "Menu image not found." });
    return;
  }

  res.sendFile(bot.menu_image_url);
});

// ─── Database Cleanup ───────────────────────────────────────────────────────

router.post("/clear-player-data", requireAdminAccess as any, (req: AuthRequest, res) => {
  if (!(req as any).isAdminSession && !isOwner(req)) {
    res.status(403).json({ success: false, message: "Owner only." });
    return;
  }

  const db = getDb();
  try {
    // Clear all user economy data while keeping structure
    db.prepare("DELETE FROM users WHERE COALESCE(is_bot, 0) = 0").run();
    db.prepare("DELETE FROM inventory").run();
    db.prepare("DELETE FROM user_cards").run();
    db.prepare("DELETE FROM card_deck").run();
    db.prepare("DELETE FROM rpg_characters").run();
    db.prepare("DELETE FROM auctions").run();
    db.prepare("DELETE FROM card_spawns").run();
    db.prepare("DELETE FROM trade_offers").run();
    db.prepare("DELETE FROM sell_offers").run();
    db.prepare("DELETE FROM guild_members").run();
    db.prepare("DELETE FROM warnings").run();
    db.prepare("DELETE FROM afk_users").run();
    db.prepare("DELETE FROM summer_tokens").run();
    
    res.json({ success: true, message: "All player data cleared successfully." });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export { router as adminRouter };
