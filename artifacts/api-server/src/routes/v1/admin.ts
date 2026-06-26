import { Router, type Request, type Response, type NextFunction } from "express";
import { randomBytes } from "crypto";
import { requireAuth, type AuthRequest } from "./middleware.js";
import { col, ObjectId } from "../../bot/db/mongo.js";
import { getSocket, isSocketConnected } from "../../bot/connection.js";
import {
  startBot, stopBot, getAllBotsStatus, getBotStatusInfo, setPrimaryBot, requestBotPairingCode, setBotPersona,
} from "../../bot/bot-manager.js";
import { PERSONA_LIST, isValidPersona } from "../../bot/commands/personas.js";
import multer from "multer";
import path from "path";
import fs from "fs";

const router = Router();

const uploadDir = path.join(process.cwd(), "data", "uploads", "menu-images");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

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
    if (allowed.test(file.originalname)) cb(null, true);
    else cb(new Error("Only image files are allowed"));
  },
  limits: { fileSize: 5 * 1024 * 1024 },
});

const ADMIN_PASSWORD = process.env["ADMIN_PASSWORD"] || "Flowers";
const OWNER_PHONE = (process.env["BOT_OWNER_PHONE"] || "2348144550593").replace(/\D/g, "");
const OWNER_LID   = (process.env["BOT_OWNER_LID"]   || "101014040526896").replace(/\D/g, "");

function isOwner(req: AuthRequest): boolean {
  const phone  = (req.user?.phone || "").replace(/\D/g, "");
  const userId = (req.user?.id   || "");
  const lid    = (req.user?.lid  || "").replace(/\D/g, "");
  if (phone && phone === OWNER_PHONE) return true;
  const userIdDigits = userId.split("@")[0].split(":")[0].replace(/\D/g, "");
  if (userIdDigits === OWNER_PHONE) return true;
  if (OWNER_LID && lid && lid === OWNER_LID) return true;
  return false;
}

async function isStaff(req: AuthRequest): Promise<boolean> {
  if (isOwner(req)) return true;
  const userId = req.user?.id || "";
  const row = await col("staff").findOne({ user_id: userId });
  return !!row;
}

// In-memory token cache — acts as a fallback if MongoDB is temporarily unavailable
// { token -> expiresAtSeconds }
const memTokenCache = new Map<string, number>();

async function isAdminToken(token: string): Promise<boolean> {
  if (!token) return false;
  const now = Math.floor(Date.now() / 1000);
  // Check in-memory cache first (fast path and MongoDB-offline fallback)
  const memExpiry = memTokenCache.get(token);
  if (memExpiry !== undefined && memExpiry > now) return true;
  // Fall back to MongoDB (also refreshes the in-memory cache)
  try {
    const row = await col("admin_sessions").findOne({ _id: token as any, expires_at: { $gt: now } });
    if (row) {
      memTokenCache.set(token, row.expires_at as number);
      return true;
    }
  } catch {
    // MongoDB unavailable — rely on in-memory cache only
  }
  return false;
}

export function requireAdminAccess(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  (async () => {
    if (token && await isAdminToken(token)) {
      (req as any).isAdminSession = true;
      next();
      return;
    }
    requireAuth(req as AuthRequest, res, async () => {
      if (!(await isStaff(req as AuthRequest)) && !isOwner(req as AuthRequest)) {
        res.status(403).json({ success: false, message: "Access denied." });
        return;
      }
      next();
    });
  })().catch(() => res.status(500).json({ success: false, message: "Auth error" }));
}

// ─── Auth ────────────────────────────────────────────────────────────────────

router.post("/login", async (req, res) => {
  const { password } = req.body as { password?: string };
  if (!password || password !== ADMIN_PASSWORD) {
    res.status(401).json({ success: false, message: "Invalid password." }); return;
  }
  const token = randomBytes(32).toString("hex");
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 30 * 24 * 3600;
  // Store in-memory cache immediately — this ensures the token works even if
  // MongoDB is slow to persist or temporarily unavailable.
  memTokenCache.set(token, expiresAt);
  // Persist to MongoDB in the background (non-blocking)
  col("admin_sessions").insertOne({ _id: token as any, created_at: now, expires_at: expiresAt }).catch(() => {});
  res.json({ success: true, token });
});

// ─── Stats ───────────────────────────────────────────────────────────────────

router.get("/stats", requireAdminAccess as any, async (req: AuthRequest, res) => {
  try {
    const now = Math.floor(Date.now() / 1000);
    const OPT = { maxTimeMS: 8000 };
    const [totalUsers, totalBots, totalCards, totalGuilds, totalBanned, totalStaff] = await Promise.all([
      col("users").countDocuments({ is_bot: { $ne: 1 }, registered: 1 }, OPT),
      col("bots").countDocuments({}, OPT),
      col("cards").countDocuments({}, OPT),
      col("guilds").countDocuments({}, OPT),
      col("banned_entities").countDocuments({}, OPT),
      col("staff").countDocuments({}, OPT),
    ]);

    const recentUsers = await col("users").find({
      is_bot: { $ne: 1 },
      $or: [{ registered: 1 }, { phone: { $nin: [null, ""] } }],
    }).sort({ created_at: -1 }).limit(20).toArray();

    const staffDocs = await col("staff").find({}).toArray();
    const staffUserIds = staffDocs.map((s) => s.user_id);
    const staffUsers = await col("users").find({ _id: { $in: staffUserIds as any[] } }).project({ _id: 1, name: 1, phone: 1 }).toArray();
    const staffUserMap = new Map(staffUsers.map((u) => [String(u._id), u]));
    const staffList = staffDocs.map((s) => ({
      user_id: s.user_id,
      role: s.role,
      name: staffUserMap.get(String(s.user_id))?.name || null,
      phone: staffUserMap.get(String(s.user_id))?.phone || null,
    }));

    const bannedIds = (await col("banned_entities").find({ type: "user" }).project({ _id: 1 }).toArray()).map((b) => String(b._id));
    const topUsers = await col("users").find({ is_bot: { $ne: 1 }, registered: 1, _id: { $nin: bannedIds as any[] } })
      .sort({ level: -1, xp: -1 }).limit(10).project({ _id: 1, name: 1, phone: 1, level: 1, xp: 1, balance: 1, bank: 1 }).toArray();

    const botConnected = isSocketConnected();
    let pairingCode: string | null = null;
    try { const conn = await import("../../bot/connection.js"); pairingCode = conn.getPairingCode(); } catch {}

    const bannedIdSet = new Set(bannedIds);
    const recentUserIds = recentUsers.map((u: any) => String(u._id));
    const recentStaffDocs = await col("staff").find({ user_id: { $in: recentUserIds } }).toArray();
    const recentStaffMap = new Map(recentStaffDocs.map((s: any) => [String(s.user_id), s.role]));
    const formattedUsers = recentUsers.map((u: any) => ({
      id: u._id, name: u.name, phone: u.phone, level: u.level, xp: u.xp, balance: u.balance, bank: u.bank,
      premium: u.premium || 0, is_bot: u.is_bot || 0, registered: u.registered || 0, created_at: u.created_at,
      role: recentStaffMap.get(String(u._id)) || null, is_banned: bannedIdSet.has(String(u._id)) ? 1 : 0,
    }));

    res.json({
      botConnected,
      pairingCode,
      isOwner: isOwner(req),
      stats: { totalUsers, totalBots, totalCards, totalGuilds, totalBanned, totalStaff },
      recentUsers: formattedUsers,
      staffList,
      topUsers: topUsers.map((u: any) => ({ id: u._id, name: u.name, phone: u.phone, level: u.level, xp: u.xp, balance: u.balance, bank: u.bank })),
    });
  } catch (err: any) {
    // If MongoDB isn't connected yet, return zero-state stats so the dashboard still renders
    const botConnected = isSocketConnected();
    res.json({
      botConnected, pairingCode: null, isOwner: false,
      stats: { totalUsers: 0, totalBots: 0, totalCards: 0, totalGuilds: 0, totalBanned: 0, totalStaff: 0 },
      recentUsers: [], staffList: [], topUsers: [],
      _warning: err?.message || "MongoDB unavailable — showing zero-state stats",
    });
  }
});

// ─── Player Search ────────────────────────────────────────────────────────────

router.get("/players", requireAdminAccess as any, async (req, res) => {
  const { q } = req.query as { q?: string };
  if (!q || q.trim().length < 1) { res.json({ success: true, players: [] }); return; }
  try {
    const term = q.trim();
    const regex = { $regex: term, $options: "i" };
    const players = await col("users").find({
      is_bot: { $ne: 1 },
      $or: [{ name: regex }, { phone: regex }, { _id: regex }],
    }).sort({ level: -1 }).limit(25).toArray();

    const playerIds = players.map((p) => String(p._id));
    const [bannedDocs, staffDocs] = await Promise.all([
      col("banned_entities").find({ id: { $in: playerIds }, type: "user" }).toArray(),
      col("staff").find({ user_id: { $in: playerIds } }).toArray(),
    ]);
    const bannedSet = new Set(bannedDocs.map((b) => String(b.id)));
    const staffMap = new Map(staffDocs.map((s) => [String(s.user_id), s.role]));

    res.json({
      success: true,
      players: players.map((u: any) => ({
        id: u._id, name: u.name, phone: u.phone || u._id, balance: u.balance, bank: u.bank, level: u.level, xp: u.xp,
        registered: u.registered || 0, created_at: u.created_at, is_bot: u.is_bot || 0,
        is_banned: bannedSet.has(String(u._id)) ? 1 : 0, role: staffMap.get(String(u._id)) || null,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/players/:id", requireAdminAccess as any, async (req, res) => {
  try {
    const id = decodeURIComponent(req.params.id);
    const player = await col("users").findOne({ _id: id as any });
    if (!player) { res.status(404).json({ success: false, message: "Player not found." }); return; }

    const [inventory, userCards, warnings, rpg, staffRow, bannedRow] = await Promise.all([
      col("inventory").find({ user_id: id }).toArray(),
      // No limit here — an admin reviewing a player's collection (e.g. to
      // remove an illegitimately obtained card, or clear the whole
      // collection) needs to see everything, not just the most recent 20.
      col("user_cards").find({ user_id: id }).sort({ obtained_at: -1 }).toArray(),
      col("warnings").find({ user_id: id }).sort({ created_at: -1 }).limit(10).toArray(),
      col("rpg_characters").findOne({ user_id: id }),
      col("staff").findOne({ user_id: id }),
      col("banned_entities").findOne({ id, type: "user" }),
    ]);

    const cardIds = userCards.map((uc) => uc.card_id);
    const cardDocs = await col("cards").find({ _id: { $in: cardIds as any[] } }).project({ _id: 1, name: 1, series: 1, tier: 1 }).toArray();
    const cardMap = new Map(cardDocs.map((c) => [String(c._id), c]));

    res.json({
      success: true,
      player: { ...player, id: player._id, is_banned: bannedRow ? 1 : 0, staff_role: staffRow?.role || null },
      inventory,
      cards: userCards.map((uc: any) => ({
        uc_id: uc._id?.toString(),
        copy_id: uc.copy_id,
        obtained_at: uc.obtained_at,
        ...cardMap.get(String(uc.card_id)),
      })),
      warnings,
      rpg: rpg || {},
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/players/:id/ban", requireAdminAccess as any, async (req, res) => {
  try {
    const id = decodeURIComponent(req.params.id);
    const { reason } = req.body as { reason?: string };
    await col("banned_entities").updateOne(
      { id, type: "user" },
      { $set: { id, type: "user", target: id, display: id, reason: reason || "Admin ban", added_by: (req as any).user?.id || "admin" } },
      { upsert: true }
    );
    res.json({ success: true, message: "Player banned." });
  } catch (err: any) { res.status(500).json({ success: false, message: err.message }); }
});

router.post("/players/:id/unban", requireAdminAccess as any, async (req, res) => {
  try {
    const id = decodeURIComponent(req.params.id);
    await col("banned_entities").deleteOne({ id, type: "user" });
    res.json({ success: true, message: "Player unbanned." });
  } catch (err: any) { res.status(500).json({ success: false, message: err.message }); }
});

router.post("/players/:id/coins", requireAdminAccess as any, async (req, res) => {
  try {
    const id = decodeURIComponent(req.params.id);
    const { amount, target } = req.body as { amount?: number; target?: "wallet" | "bank" };
    const field = target === "bank" ? "bank" : "balance";
    const player = await col("users").findOne({ _id: id as any });
    if (!player) { res.status(404).json({ success: false, message: "Player not found." }); return; }
    const current = Number((player as any)[field] || 0);
    const next = Math.max(0, current + Number(amount || 0));
    await col("users").updateOne({ _id: id as any }, { $set: { [field]: next, updated_at: Math.floor(Date.now() / 1000) } });
    res.json({ success: true, message: `${field === "balance" ? "Wallet" : "Bank"} set to ${next}.` });
  } catch (err: any) { res.status(500).json({ success: false, message: err.message }); }
});

router.post("/players/:id/role", requireAdminAccess as any, async (req, res) => {
  try {
    const id = decodeURIComponent(req.params.id);
    const { role } = req.body as { role?: string };
    if (!role || !["user", "guardian", "mod", "owner"].includes(role.toLowerCase())) {
      res.status(400).json({ success: false, message: "Invalid role. Valid: user, guardian, mod, owner" }); return;
    }
    if (role.toLowerCase() === "user") {
      await col("staff").deleteOne({ user_id: id });
    } else {
      await col("staff").updateOne({ user_id: id }, { $set: { user_id: id, role: role.toLowerCase(), added_at: Math.floor(Date.now() / 1000) } }, { upsert: true });
    }
    res.json({ success: true, message: `Role set to ${role}.` });
  } catch (err: any) { res.status(500).json({ success: false, message: err.message }); }
});

router.post("/players/:id/reset", requireAdminAccess as any, async (req, res) => {
  try {
    const id = decodeURIComponent(req.params.id);
    const now = Math.floor(Date.now() / 1000);
    await col("users").updateOne({ _id: id as any }, { $set: { balance: 0, bank: 0, xp: 0, level: 1, updated_at: now } });
    await col("inventory").deleteMany({ user_id: id });
    res.json({ success: true, message: "Player economy reset." });
  } catch (err: any) { res.status(500).json({ success: false, message: err.message }); }
});

router.post("/players/:id/clear-cooldowns", requireAdminAccess as any, async (req, res) => {
  try {
    const id = decodeURIComponent(req.params.id);
    await col("users").updateOne({ _id: id as any }, { $set: { last_daily: 0, last_work: 0, last_dig: 0, last_fish: 0, last_beg: 0, last_gamble: 0, last_steal: 0 } });
    res.json({ success: true, message: "Cooldowns cleared." });
  } catch (err: any) { res.status(500).json({ success: false, message: err.message }); }
});

// Remove one specific card copy from a player's collection — for cases
// where a card was obtained illegitimately (exploit, duplication bug,
// trading scam) and needs to be taken back without touching the rest of
// their collection. Identified by uc_id (the user_cards document's own
// _id), not copy_id, since uc_id is always unique per owned copy.
router.delete("/players/:id/cards/:ucId", requireAdminAccess as any, async (req, res) => {
  try {
    const id = decodeURIComponent(req.params.id);
    const ucId = req.params.ucId;
    let oid: any;
    try { oid = new ObjectId(ucId); } catch { res.status(400).json({ success: false, message: "Invalid card id." }); return; }

    const row = await col("user_cards").findOne({ _id: oid, user_id: id });
    if (!row) { res.status(404).json({ success: false, message: "Card not found in this player's collection." }); return; }

    await col("card_deck").deleteMany({ user_card_id: ucId });
    await col("user_cards").deleteOne({ _id: oid });
    res.json({ success: true, message: "Card removed from player's collection." });
  } catch (err: any) { res.status(500).json({ success: false, message: err.message }); }
});

// Clear a player's ENTIRE card collection. Destructive and irreversible —
// the frontend should require explicit confirmation before calling this.
router.delete("/players/:id/cards", requireAdminAccess as any, async (req, res) => {
  try {
    const id = decodeURIComponent(req.params.id);
    const owned = await col("user_cards").find({ user_id: id }, { projection: { _id: 1 } }).toArray();
    const ucIds = owned.map((d: any) => d._id?.toString());
    if (ucIds.length > 0) {
      await col("card_deck").deleteMany({ user_card_id: { $in: ucIds } });
    }
    const result = await col("user_cards").deleteMany({ user_id: id });
    res.json({ success: true, message: `Removed ${result.deletedCount ?? 0} card(s) from player's collection.`, removed: result.deletedCount ?? 0 });
  } catch (err: any) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── Dedup ───────────────────────────────────────────────────────────────────

router.post("/dedup-users", requireAdminAccess as any, async (req, res) => {
  try {
    const lidRows = await col("users").find({
      $where: "this._id.length > 13",
      phone: { $nin: [null, ""] },
    }).toArray();

    let merged = 0;
    let deleted = 0;
    const childTables = ["rpg_characters","inventory","user_cards","message_counts","card_deck","deck_backgrounds","guild_members","warnings","muted_users","summer_tokens","afk_users","staff"];

    for (const lidRow of lidRows) {
      const existingId = String(lidRow._id);
      const phone = (lidRow.phone || "").replace(/\D/g, "");
      if (!phone || phone === existingId) continue;

      const phoneRow = await col("users").findOne({ _id: phone as any });
      if (!phoneRow) {
        await col("users").updateOne({ _id: existingId as any }, { $set: { phone, lid: existingId } });
        for (const t of childTables) {
          try { await col(t).updateMany({ user_id: existingId }, { $set: { user_id: phone } }); } catch {}
        }
        merged++;
      } else {
        await col("users").updateOne({ _id: phone as any }, { $set: { lid: lidRow.lid || existingId } });
        await col("users").deleteOne({ _id: existingId as any });
        deleted++;
      }
    }

    res.json({ success: true, message: `Dedup complete. Merged: ${merged}, deleted duplicates: ${deleted}.` });
  } catch (err: any) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── Legacy Actions ───────────────────────────────────────────────────────────

router.post("/reset-balance", requireAdminAccess as any, async (req: AuthRequest, res) => {
  if (!(req as any).isAdminSession && !isOwner(req)) { res.status(403).json({ success: false, message: "Owner only." }); return; }
  try {
    await col("users").updateMany({}, { $set: { balance: 0, bank: 0 } });
    res.json({ success: true, message: "All balances reset to zero." });
  } catch (err: any) { res.status(500).json({ success: false, message: err.message }); }
});

router.post("/ban", requireAdminAccess as any, async (req: AuthRequest, res) => {
  const { phone } = req.body as { phone?: string };
  if (!phone) { res.status(400).json({ success: false, message: "phone required" }); return; }
  try {
    const normalized = phone.replace(/\D/g, "");
    await col("banned_entities").updateOne(
      { id: normalized, type: "user" },
      { $setOnInsert: { id: normalized, type: "user", reason: "Admin ban", added_by: (req as AuthRequest).user?.id || "admin", added_at: Math.floor(Date.now() / 1000) } },
      { upsert: true }
    );
    res.json({ success: true, message: `${normalized} banned.` });
  } catch (err: any) { res.status(500).json({ success: false, message: err.message }); }
});

router.post("/unban", requireAdminAccess as any, async (req: AuthRequest, res) => {
  const { phone } = req.body as { phone?: string };
  if (!phone) { res.status(400).json({ success: false, message: "phone required" }); return; }
  try {
    const normalized = phone.replace(/\D/g, "");
    await col("banned_entities").deleteOne({ id: normalized, type: "user" });
    res.json({ success: true, message: `${normalized} unbanned.` });
  } catch (err: any) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── Bot Management ───────────────────────────────────────────────────────────

router.get("/bots", requireAdminAccess as any, async (_req, res) => {
  res.json({ success: true, bots: await getAllBotsStatus() });
});

router.get("/bots/status", requireAdminAccess as any, async (_req, res) => {
  res.json({ success: true, bots: await getAllBotsStatus() });
});

router.post("/bots", requireAdminAccess as any, async (req, res) => {
  const { name, phone } = req.body as { name?: string; phone?: string };
  if (!name) { res.status(400).json({ success: false, message: "name required" }); return; }
  try {
    const existing = await col("bots").countDocuments();
    if (existing >= 5) { res.status(400).json({ success: false, message: "Maximum 5 bots allowed." }); return; }
    const id = randomBytes(6).toString("hex");
    const authDir = `data/bots/${id}/auth`;
    await col("bots").insertOne({ _id: id as any, name: name.trim(), phone: (phone || "").replace(/\D/g, ""), auth_dir: authDir, status: "disconnected", roles: [] });
    res.json({ success: true, message: `Bot "${name}" registered.`, id });
  } catch (err: any) { res.status(500).json({ success: false, message: err.message }); }
});

router.post("/bots/:id/start", requireAdminAccess as any, async (req, res) => {
  try { await startBot(req.params.id); res.json({ success: true, message: "Bot starting — check status for pairing code." }); }
  catch (err: any) { res.status(500).json({ success: false, message: err.message }); }
});

router.post("/bots/:id/stop", requireAdminAccess as any, async (req, res) => {
  try { await stopBot(req.params.id); res.json({ success: true, message: "Bot stopped." }); }
  catch (err: any) { res.status(500).json({ success: false, message: err.message }); }
});

router.post("/bots/:id/set-primary", requireAdminAccess as any, (req, res) => {
  setPrimaryBot(req.params.id);
  res.json({ success: true, message: "Primary bot updated." });
});

// ─── AI Companion Personas ─────────────────────────────────────────────────

router.get("/personas", requireAdminAccess as any, (_req, res) => {
  res.json({ success: true, personas: PERSONA_LIST.map((p) => ({ key: p.key, displayName: p.displayName, shortLabel: p.shortLabel })) });
});

router.post("/bots/:id/persona", requireAdminAccess as any, async (req, res) => {
  const { persona } = req.body as { persona?: string };
  if (!isValidPersona(persona)) { res.status(400).json({ success: false, message: "Unknown persona." }); return; }
  try {
    const bot = await col("bots").findOne({ _id: req.params.id as any });
    if (!bot) { res.status(404).json({ success: false, message: "Bot not found." }); return; }
    setBotPersona(req.params.id, persona);
    res.json({ success: true, message: "Persona updated." });
  } catch (err: any) { res.status(500).json({ success: false, message: err.message }); }
});

router.get("/bots/:id/status", requireAdminAccess as any, (req, res) => {
  const status = getBotStatusInfo(req.params.id);
  if (!status) { res.status(404).json({ success: false, message: "Bot not found." }); return; }
  res.json({ success: true, bot: status });
});

router.delete("/bots/:id", requireAdminAccess as any, async (req, res) => {
  try { await stopBot(req.params.id); } catch {}
  try {
    await col("bots").deleteOne({ _id: req.params.id as any });
    res.json({ success: true, message: "Bot removed." });
  } catch (err: any) { res.status(500).json({ success: false, message: err.message }); }
});

router.post("/bots/:id/request-pairing", requireAdminAccess as any, async (req, res) => {
  const { phone } = req.body as { phone?: string };
  if (!phone) { res.status(400).json({ success: false, message: "phone required" }); return; }
  try {
    const code = await requestBotPairingCode(req.params.id, phone);
    res.json({ success: true, code, message: `Pairing code: ${code}` });
  } catch (err: any) { res.status(500).json({ success: false, message: err.message }); }
});

router.post("/bots/:id/roles", requireAdminAccess as any, async (req, res) => {
  const { id } = req.params;
  const { roles } = req.body as { roles?: string[] };
  if (!Array.isArray(roles)) { res.status(400).json({ success: false, message: "roles must be array" }); return; }
  try {
    await col("bots").updateOne({ _id: id as any }, { $set: { roles } });
    res.json({ success: true, message: "Roles updated." });
  } catch (err: any) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── Menu Image Upload ────────────────────────────────────────────────────────

router.post("/bots/:id/menu-image", requireAdminAccess as any, upload.single("image"), async (req, res) => {
  if (!req.file) { res.status(400).json({ success: false, message: "No image provided." }); return; }
  try {
    const botId = req.params.id;
    const imagePath = req.file.path;
    await col("bots").updateOne({ _id: botId as any }, { $set: { menu_image_url: imagePath } });
    res.json({ success: true, message: "Menu image uploaded successfully.", imagePath });
  } catch (err: any) { res.status(500).json({ success: false, message: err.message }); }
});

router.get("/bots/:id/menu-image", requireAdminAccess as any, async (req, res) => {
  try {
    const bot = await col("bots").findOne({ _id: req.params.id as any });
    if (!bot || !bot.menu_image_url || !fs.existsSync(bot.menu_image_url)) {
      res.status(404).json({ success: false, message: "Menu image not found." }); return;
    }
    res.sendFile(bot.menu_image_url);
  } catch (err: any) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── Database Cleanup ──────────────────────────────────────────────────────

router.post("/clear-player-data", requireAdminAccess as any, async (req: AuthRequest, res) => {
  if (!(req as any).isAdminSession && !isOwner(req)) { res.status(403).json({ success: false, message: "Owner only." }); return; }
  try {
    await Promise.all([
      col("users").deleteMany({ is_bot: { $ne: 1 } }),
      col("inventory").deleteMany({}),
      col("user_cards").deleteMany({}),
      col("card_deck").deleteMany({}),
      col("rpg_characters").deleteMany({}),
      col("auctions").deleteMany({}),
      col("card_spawns").deleteMany({}),
      col("trade_offers").deleteMany({}),
      col("sell_offers").deleteMany({}),
      col("guild_members").deleteMany({}),
      col("warnings").deleteMany({}),
      col("afk_users").deleteMany({}),
      col("summer_tokens").deleteMany({}),
    ]);
    res.json({ success: true, message: "All player data cleared successfully." });
  } catch (err: any) { res.status(500).json({ success: false, message: err.message }); }
});

export { router as adminRouter };
