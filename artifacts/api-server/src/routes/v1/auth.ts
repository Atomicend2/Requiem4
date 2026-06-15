import { Router } from "express";
import { randomBytes, createHmac } from "crypto";
import { getDb } from "../../bot/db/database.js";
import { getAnySock } from "../../bot/connection.js";
import { logger } from "../../lib/logger.js";
import { getUserByLid, linkUserLid } from "../../bot/db/queries.js";

// ── Stateless signed session tokens ──────────────────────────────────────────
// Format: base64(userId + ":" + expiresAt + ":" + nonce) + "." + hmac
// Survives server restarts — nothing stored in DB. Set JWT_SECRET in Render env.
const SESSION_SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET || "requiem-default-secret-change-me";
const SESSION_DAYS   = 30;

export function createSessionToken(userId: string): string {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_DAYS * 24 * 3600;
  const nonce     = randomBytes(8).toString("hex");
  const payload   = Buffer.from(`${userId}:${expiresAt}:${nonce}`).toString("base64url");
  const sig       = createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifySessionToken(token: string): { userId: string; expiresAt: number } | null {
  try {
    const [payload, sig] = token.split(".");
    if (!payload || !sig) return null;
    const expected = createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
    if (expected !== sig) return null;
    const [userId, expiresAtStr] = Buffer.from(payload, "base64url").toString().split(":");
    const expiresAt = Number(expiresAtStr);
    if (!userId || !expiresAt || Math.floor(Date.now() / 1000) > expiresAt) return null;
    return { userId, expiresAt };
  } catch {
    return null;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

const router = Router();

const OTP_EXPIRY_SECONDS = 300;

function ensureWebTables() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS web_otps (
      phone TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS web_sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS web_achievements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      icon TEXT DEFAULT 'star',
      earned_at INTEGER DEFAULT (unixepoch())
    );
  `);
}

ensureWebTables();

function normalizePhone(raw: string): string | null {
  const cleaned = raw.replace(/\D/g, "");
  if (cleaned.length < 7 || cleaned.length > 15) return null;
  return cleaned;
}

function getUserByPhone(phone: string) {
  const db = getDb();
  // Try plain phone / id match first, then fall back to LID column
  const row = db.prepare(
    "SELECT * FROM users WHERE id = ? OR phone = ? OR lid = ? LIMIT 1"
  ).get(phone, phone, phone) as any;
  return row || null;
}

router.post("/otp/send", async (req, res) => {
  const { phone } = req.body as { phone?: string };
  if (!phone) {
    res.status(400).json({ success: false, message: "Phone number is required" });
    return;
  }

  const normalized = normalizePhone(phone);
  if (!normalized) {
    res.status(400).json({ success: false, message: "Invalid phone number format" });
    return;
  }

  let user = getUserByPhone(normalized);

  // ── LID cross-check & deduplication ──────────────────────────────────────
  // If no row found by phone, ask WhatsApp what the LID is for this number.
  // The bot may have stored the user under their LID before we resolved it.
  if (!user) {
    try {
      const activeSock = getAnySock();
      if (activeSock) {
        const jid = `${normalized}@s.whatsapp.net`;
        const results = await (activeSock as any).onWhatsApp(jid);
        const lidJid: string | undefined = results?.[0]?.lid;
        if (lidJid) {
          const lidNum = lidJid.split("@")[0];
          const lidUser = getUserByPhone(lidNum) || getUserByLid(lidNum);
          if (lidUser) {
            const db = getDb();
            // Merge: rename the LID-keyed row to phone number so admin panel
            // shows ONE record and web session resolves to the right row.
            if (lidUser.id !== normalized) {
              const phoneRecord = db.prepare("SELECT * FROM users WHERE id = ?").get(normalized) as any;
              if (!phoneRecord) {
                // Safe to rename
                db.transaction(() => {
                  db.prepare("UPDATE users SET id = ?, phone = ?, lid = COALESCE(lid, ?) WHERE id = ?")
                    .run(normalized, normalized, lidNum, lidUser.id);
                  for (const t of ["rpg_characters", "inventory", "user_cards", "message_counts", "card_deck", "deck_backgrounds", "guild_members", "warnings", "muted_users", "summer_tokens", "afk_users", "staff"]) {
                    try { db.prepare(`UPDATE OR IGNORE ${t} SET user_id = ? WHERE user_id = ?`).run(normalized, lidUser.id); } catch {}
                  }
                })();
              } else {
                // Both rows exist — keep phone row, merge lid info
                db.prepare("UPDATE users SET lid = COALESCE(lid, ?) WHERE id = ?").run(lidNum, normalized);
                // Delete the orphan LID row
                db.prepare("DELETE FROM users WHERE id = ?").run(lidUser.id);
              }
            } else {
              // id already is normalized phone, just ensure phone/lid columns set
              db.prepare("UPDATE users SET phone = ?, lid = COALESCE(lid, ?) WHERE id = ?")
                .run(normalized, lidNum, normalized);
            }
            user = getUserByPhone(normalized);
          }
        }
      }
    } catch {}
  }
  // ─────────────────────────────────────────────────────────────────────────

  if (!user) {
    res.status(404).json({
      success: false,
      message: "Phone number not found. Please register on the website first.",
      registerRedirect: true,
    });
    return;
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = Math.floor(Date.now() / 1000) + OTP_EXPIRY_SECONDS;

  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO web_otps (phone, code, expires_at) VALUES (?, ?, ?)").run(normalized, code, expiresAt);

  const activeSock = getAnySock();
  if (!activeSock) {
    logger.warn("No socket available, cannot send OTP DM");
    res.status(500).json({ success: false, message: "Bot is not initialized. Please try again shortly." });
    return;
  }

  try {
    // Always send messages to JID (phone@s.whatsapp.net), never to LID
    const jid = `${normalized}@s.whatsapp.net`;
    await activeSock.sendMessage(jid, {
      text: `*Requiem Order 反逆* — Your login code:\n\n*${code}*\n\nThis code expires in 5 minutes. Do not share it with anyone.`,
    });
    logger.info({ phone: normalized }, "OTP sent via WhatsApp");
  } catch (err) {
    logger.error({ err }, "Failed to send OTP via WhatsApp");
    res.status(500).json({ success: false, message: "Failed to send OTP. The bot may be reconnecting — please try again in a few seconds." });
    return;
  }

  res.json({ success: true, message: "OTP sent to your WhatsApp" });
});

router.post("/register", async (req, res) => {
  const { phone, name } = req.body as { phone?: string; name?: string };

  if (!phone || !name) {
    res.status(400).json({ success: false, message: "Phone number and name are required" });
    return;
  }

  const normalized = normalizePhone(phone);
  if (!normalized) {
    res.status(400).json({ success: false, message: "Invalid phone number format" });
    return;
  }

  const trimmedName = name.trim();
  if (trimmedName.length < 2) {
    res.status(400).json({ success: false, message: "Name must be at least 2 characters" });
    return;
  }

  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  let existing = getUserByPhone(normalized);

  // ── LID cross-check ───────────────────────────────────────────────────────
  // Check if the bot already created a row for this number under their LID.
  let resolvedLid: string | null = null;
  if (!existing || !existing.registered) {
    try {
      const activeSock = getAnySock();
      if (activeSock) {
        const jid = `${normalized}@s.whatsapp.net`;
        const results = await (activeSock as any).onWhatsApp(jid);
        const lidJid: string | undefined = results?.[0]?.lid;
        if (lidJid) {
          // Store only the numeric LID — never store the @lid suffix in the DB
          resolvedLid = lidJid.split("@")[0].replace(/\D/g, "") || null;
          if (resolvedLid && !existing) {
            // Try to find by LID number
            existing = getUserByPhone(resolvedLid) || getUserByLid(resolvedLid);
          }
        }
      }
    } catch {}
  }
  // ─────────────────────────────────────────────────────────────────────────

  if (existing && existing.registered) {
    res.status(409).json({
      success: false,
      message: "This number is already registered. Please log in instead.",
      loginRedirect: true,
    });
    return;
  }

  if (!existing) {
    // Use the plain phone number as the canonical user ID — never the JID or LID
    db.prepare(
      "INSERT OR IGNORE INTO users (id, name, phone, lid, registered, registered_at, created_at, balance) VALUES (?, ?, ?, ?, 1, ?, ?, 45000)"
    ).run(normalized, trimmedName, normalized, resolvedLid, now, now);
  } else {
    // Migrate any old JID-keyed or LID-keyed row to the plain phone number key
    const existingPhone = existing.id.split("@")[0].split(":")[0].replace(/\D/g, "");
    if (existingPhone !== normalized) {
      // Old row had JID or LID as id — rename to plain phone atomically
      db.transaction(() => {
        db.prepare("UPDATE users SET id = ?, name = ?, phone = ?, lid = COALESCE(lid, ?), registered = 1, registered_at = ? WHERE id = ?")
          .run(normalized, trimmedName, normalized, resolvedLid, now, existing.id);
        for (const t of ["rpg_characters", "inventory", "user_cards", "message_counts", "card_deck", "deck_backgrounds", "guild_members", "warnings", "muted_users", "summer_tokens", "afk_users"]) {
          try { db.prepare(`UPDATE OR IGNORE ${t} SET user_id = ? WHERE user_id = ?`).run(normalized, existing.id); } catch {}
        }
      })();
    } else {
      db.prepare(
        "UPDATE users SET name = ?, phone = ?, lid = COALESCE(lid, ?), registered = 1, registered_at = ? WHERE id = ?"
      ).run(trimmedName, normalized, resolvedLid, now, normalized);
    }
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = now + OTP_EXPIRY_SECONDS;
  db.prepare("INSERT OR REPLACE INTO web_otps (phone, code, expires_at) VALUES (?, ?, ?)").run(normalized, code, expiresAt);

  const activeSock = getAnySock();
  if (!activeSock) {
    logger.warn("No socket during registration, account created without OTP delivery");
    res.json({
      success: true,
      botOffline: true,
      message: "Account created! The bot is not yet initialized — use the Resend OTP button once the bot is online.",
    });
    return;
  }

  try {
    await activeSock.sendMessage(`${normalized}@s.whatsapp.net`, {
      text: `*Requiem Order 反逆* — Welcome, ${trimmedName}!\n\nYour registration code:\n\n*${code}*\n\nExpires in 5 minutes. Don't share this code.`,
    });
  } catch (err) {
    logger.error({ err }, "Failed to send registration OTP");
    res.json({
      success: true,
      botOffline: true,
      message: "Account created! The bot couldn't deliver the code right now — use the Resend OTP button to retry in a few seconds.",
    });
    return;
  }

  res.json({ success: true, message: "Account created! Check your WhatsApp for the verification code." });
});

router.post("/otp/verify", (req, res) => {
  const { phone, code } = req.body as { phone?: string; code?: string };
  if (!phone || !code) {
    res.status(400).json({ success: false, message: "Phone and code are required" });
    return;
  }

  const normalized = normalizePhone(phone);
  if (!normalized) {
    res.status(400).json({ success: false, message: "Invalid phone number" });
    return;
  }

  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const otp = db.prepare("SELECT * FROM web_otps WHERE phone = ?").get(normalized) as any;

  if (!otp) {
    res.status(401).json({ success: false, message: "No OTP found. Please request a new code." });
    return;
  }

  if (otp.expires_at < now) {
    db.prepare("DELETE FROM web_otps WHERE phone = ?").run(normalized);
    res.status(401).json({ success: false, message: "OTP has expired. Please request a new code." });
    return;
  }

  if (otp.code !== code.trim()) {
    res.status(401).json({ success: false, message: "Incorrect code. Please try again." });
    return;
  }

  db.prepare("DELETE FROM web_otps WHERE phone = ?").run(normalized);

  const user = getUserByPhone(normalized);
  if (!user) {
    res.status(404).json({ success: false, message: "User not found." });
    return;
  }

  // Ensure the users row has phone populated — fix old rows that may have it empty
  if (!user.phone) {
    db.prepare("UPDATE users SET phone = ? WHERE id = ?").run(normalized, user.id);
  }

  // Create a stateless signed token — no DB row needed, survives server restarts.
  const canonicalId = normalized;
  const token = createSessionToken(canonicalId);

  // ── Owner check ──────────────────────────────────────────────────────────
  // BOT_OWNER_PHONE is the plain phone number (e.g. 2348XXXXXXXXX).
  // BOT_OWNER_LID   is the WhatsApp LID       (e.g. 101014040526896).
  // We check BOTH so registration works whether the user row was keyed by
  // phone or was found via LID cross-reference.
  const ownerPhone = (process.env["BOT_OWNER_PHONE"] || "2348144550593").replace(/\D/g, "");
  const ownerLid   = (process.env["BOT_OWNER_LID"]   || "101014040526896").replace(/\D/g, "");
  const userLid    = (user.lid || "").replace(/\D/g, "");

  const isOwner = normalized === ownerPhone || (ownerLid && userLid && userLid === ownerLid);

  const staffRow = db.prepare("SELECT 1 FROM staff WHERE user_id = ?").get(normalized);
  const isMod = isOwner || !!staffRow ? 1 : 0;

  res.json({
    success: true,
    token,
    user: {
      id: normalized,
      name: user.name || "Shadow",
      phone: normalized,
      level: user.level || 1,
      xp: user.xp || 0,
      balance: user.balance || 0,
      bank: user.bank || 0,
      premium: user.premium || 0,
      bio: user.bio || "",
      registeredAt: user.created_at || 0,
      isMod,
      isOwner,
    },
  });
});

export { router as authRouter };
