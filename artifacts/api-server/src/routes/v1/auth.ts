import { Router } from "express";
import { randomBytes, createHmac } from "crypto";
import { col } from "../../bot/db/mongo.js";
import { getAnySock } from "../../bot/connection.js";
import { logger } from "../../lib/logger.js";
import { getUserByLid } from "../../bot/db/queries.js";

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

const router = Router();
const OTP_EXPIRY_SECONDS = 300;

function normalizePhone(raw: string): string | null {
  const cleaned = raw.replace(/\D/g, "");
  if (cleaned.length < 7 || cleaned.length > 15) return null;
  return cleaned;
}

async function getUserByPhone(phone: string): Promise<any> {
  const doc = await col("users").findOne({
    $or: [{ _id: phone as any }, { phone }, { lid: phone }],
  });
  return doc ? { ...doc, id: doc._id } : null;
}

router.post("/otp/send", async (req, res) => {
  const { phone } = req.body as { phone?: string };
  if (!phone) { res.status(400).json({ success: false, message: "Phone number is required" }); return; }

  const normalized = normalizePhone(phone);
  if (!normalized) { res.status(400).json({ success: false, message: "Invalid phone number format" }); return; }

  let user = await getUserByPhone(normalized);

  if (!user) {
    try {
      const activeSock = getAnySock();
      if (activeSock) {
        const jid = `${normalized}@s.whatsapp.net`;
        const results = await (activeSock as any).onWhatsApp(jid);
        const lidJid: string | undefined = results?.[0]?.lid;
        if (lidJid) {
          const lidNum = lidJid.split("@")[0];
          const lidUser = (await getUserByPhone(lidNum)) || (await getUserByLid(lidNum));
          if (lidUser) {
            const existingId = String(lidUser._id || lidUser.id);
            if (existingId !== normalized) {
              const phoneRecord = await col("users").findOne({ _id: normalized as any });
              if (!phoneRecord) {
                await col("users").updateOne(
                  { _id: existingId as any },
                  { $set: { _id: normalized, phone: normalized, lid: lidNum } }
                );
                const childTables = ["rpg_characters","inventory","user_cards","message_counts","card_deck","deck_backgrounds","guild_members","warnings","muted_users","summer_tokens","afk_users","staff"];
                for (const t of childTables) {
                  try { await col(t).updateMany({ user_id: existingId }, { $set: { user_id: normalized } }); } catch {}
                }
              } else {
                await col("users").updateOne({ _id: normalized as any }, { $set: { lid: lidNum } });
                await col("users").deleteOne({ _id: existingId as any });
              }
            } else {
              await col("users").updateOne({ _id: existingId as any }, { $set: { phone: normalized, lid: lidNum } });
            }
            user = await getUserByPhone(normalized);
          }
        }
      }
    } catch {}
  }

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
  await col("web_otps").replaceOne(
    { _id: normalized as any },
    { _id: normalized, code, expires_at: expiresAt },
    { upsert: true }
  );

  const activeSock = getAnySock();
  if (!activeSock) {
    logger.warn("No socket available, cannot send OTP DM");
    res.status(500).json({ success: false, message: "Bot is not initialized. Please try again shortly." });
    return;
  }

  try {
    await activeSock.sendMessage(`${normalized}@s.whatsapp.net`, {
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
  if (!phone || !name) { res.status(400).json({ success: false, message: "Phone number and name are required" }); return; }

  const normalized = normalizePhone(phone);
  if (!normalized) { res.status(400).json({ success: false, message: "Invalid phone number format" }); return; }

  const trimmedName = name.trim();
  if (trimmedName.length < 2) { res.status(400).json({ success: false, message: "Name must be at least 2 characters" }); return; }

  const now = Math.floor(Date.now() / 1000);
  let existing = await getUserByPhone(normalized);
  let resolvedLid: string | null = null;

  if (!existing || !existing.registered) {
    try {
      const activeSock = getAnySock();
      if (activeSock) {
        const jid = `${normalized}@s.whatsapp.net`;
        const results = await (activeSock as any).onWhatsApp(jid);
        const lidJid: string | undefined = results?.[0]?.lid;
        if (lidJid) {
          resolvedLid = lidJid.split("@")[0].replace(/\D/g, "") || null;
          if (resolvedLid && !existing) {
            existing = (await getUserByPhone(resolvedLid)) || (await getUserByLid(resolvedLid));
          }
        }
      }
    } catch {}
  }

  if (existing && existing.registered) {
    res.status(409).json({ success: false, message: "This number is already registered. Please log in instead.", loginRedirect: true });
    return;
  }

  if (!existing) {
    await col("users").insertOne({
      _id: normalized as any,
      name: trimmedName,
      phone: normalized,
      lid: resolvedLid,
      registered: 1,
      registered_at: now,
      created_at: now,
      balance: 45000,
    });
  } else {
    const existingId = String(existing._id || existing.id);
    if (existingId !== normalized) {
      const phoneRecord = await col("users").findOne({ _id: normalized as any });
      const childTables = ["rpg_characters","inventory","user_cards","message_counts","card_deck","deck_backgrounds","guild_members","warnings","muted_users","summer_tokens","afk_users"];
      if (!phoneRecord) {
        await col("users").updateOne(
          { _id: existingId as any },
          { $set: { _id: normalized, name: trimmedName, phone: normalized, lid: existing.lid || resolvedLid, registered: 1, registered_at: now, balance: existing.balance || 45000 } }
        );
        for (const t of childTables) {
          try { await col(t).updateMany({ user_id: existingId }, { $set: { user_id: normalized } }); } catch {}
        }
      } else {
        await col("users").updateOne({ _id: normalized as any }, { $set: { name: trimmedName, lid: existing.lid || resolvedLid, registered: 1, registered_at: now, balance: phoneRecord.balance || 45000 } });
        await col("users").deleteOne({ _id: existingId as any });
      }
    } else {
      await col("users").updateOne(
        { _id: normalized as any },
        { $set: { name: trimmedName, phone: normalized, lid: existing.lid || resolvedLid, registered: 1, registered_at: now, balance: existing.balance || 45000 } }
      );
    }
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = now + OTP_EXPIRY_SECONDS;
  await col("web_otps").replaceOne({ _id: normalized as any }, { _id: normalized, code, expires_at: expiresAt }, { upsert: true });

  const activeSock = getAnySock();
  if (!activeSock) {
    logger.warn("No socket during registration, account created without OTP delivery");
    res.json({ success: true, botOffline: true, message: "Account created! The bot is not yet initialized — use the Resend OTP button once the bot is online." });
    return;
  }

  try {
    await activeSock.sendMessage(`${normalized}@s.whatsapp.net`, {
      text: `*Requiem Order 反逆* — Welcome, ${trimmedName}!\n\nYour registration code:\n\n*${code}*\n\nExpires in 5 minutes. Don't share this code.`,
    });
  } catch (err) {
    logger.error({ err }, "Failed to send registration OTP");
    res.json({ success: true, botOffline: true, message: "Account created! The bot couldn't deliver the code right now — use the Resend OTP button to retry in a few seconds." });
    return;
  }

  res.json({ success: true, message: "Account created! Check your WhatsApp for the verification code." });
});

router.post("/otp/verify", async (req, res) => {
  const { phone, code } = req.body as { phone?: string; code?: string };
  if (!phone || !code) { res.status(400).json({ success: false, message: "Phone and code are required" }); return; }

  const normalized = normalizePhone(phone);
  if (!normalized) { res.status(400).json({ success: false, message: "Invalid phone number" }); return; }

  const now = Math.floor(Date.now() / 1000);
  const otp = await col("web_otps").findOne({ _id: normalized as any });

  if (!otp) { res.status(401).json({ success: false, message: "No OTP found. Please request a new code." }); return; }
  if (otp.expires_at < now) {
    await col("web_otps").deleteOne({ _id: normalized as any });
    res.status(401).json({ success: false, message: "OTP has expired. Please request a new code." });
    return;
  }
  if (otp.code !== code.trim()) { res.status(401).json({ success: false, message: "Incorrect code. Please try again." }); return; }

  await col("web_otps").deleteOne({ _id: normalized as any });

  const user = await getUserByPhone(normalized);
  if (!user) { res.status(404).json({ success: false, message: "User not found." }); return; }

  if (!user.phone) {
    await col("users").updateOne({ _id: normalized as any }, { $set: { phone: normalized } });
  }

  const token = createSessionToken(normalized);

  const ownerPhone = (process.env["BOT_OWNER_PHONE"] || "2348144550593").replace(/\D/g, "");
  const ownerLid   = (process.env["BOT_OWNER_LID"]   || "101014040526896").replace(/\D/g, "");
  const userLid    = (user.lid || "").replace(/\D/g, "");
  const isOwner = normalized === ownerPhone || (ownerLid && userLid && userLid === ownerLid);

  const staffRow = await col("staff").findOne({ user_id: normalized });
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
