import { getDb } from "./database.js";

// ─────────────────────────────────────────────────────────────────────────────
//  SINGLE SOURCE OF TRUTH: plain phone number
//  Every user-facing ID flowing through this file is a bare phone number
//  string (e.g. "2348031234567").  JIDs, LIDs, and any "@..." suffixes are
//  stripped immediately upon entry so every DB row is keyed by phone number.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract just the plain phone number from a WhatsApp JID.
 *
 *   "2348031234567@s.whatsapp.net" → "2348031234567"
 *   "2348031234567:3@s.whatsapp.net" → "2348031234567"
 *   "2348031234567" → "2348031234567"  (already clean)
 */
export function extractNumberFromJid(jid: string): string {
  if (!jid) return "";
  // Split off everything after "@", then strip the device suffix (":N")
  const user = jid.split("@")[0].split(":")[0];
  // Remove any remaining non-digit chars that can appear in LID-style JIDs
  const digits = user.replace(/\D/g, "");
  return digits || user; // fall back to raw user portion if no digits
}

// Backward-compat alias — all internal code may use either name
export const normalizeUserId = extractNumberFromJid;

// ─────────────────────────────────────────────────────────────────────────────
//  User helpers
// ─────────────────────────────────────────────────────────────────────────────

export function getUser(userId: string) {
  const db = getDb();
  const phone = extractNumberFromJid(userId);
  // Try direct id match (phone-keyed row) first
  const byId = db.prepare("SELECT * FROM users WHERE id = ?").get(phone) as any;
  if (byId) return byId;
  // Sender may still be a LID (101xxx) before phone mapping is cached —
  // fall back to the lid column so the "not registered" gate doesn't fire
  // for users who already completed .verify.
  return db.prepare("SELECT * FROM users WHERE lid = ?").get(phone) as any || null;
}


/**
 * Look up a user by their LID (the digits-only part of a @lid JID).
 * Returns null if no row has that LID stored yet.
 *
 * Use this in the web auth flow BEFORE inserting a new row, to avoid
 * creating a duplicate when the same person already registered via the bot.
 */
export function getUserByLid(lid: string): any {
  const db = getDb();
  // lid can be passed as "101014040526896@lid" or just "101014040526896"
  const lidNum = lid.split("@")[0].replace(/\D/g, "");
  if (!lidNum) return null;
  return db.prepare("SELECT * FROM users WHERE lid = ?").get(lidNum) as any || null;
}

/**
 * Store a user's LID digits against their phone-keyed row so future
 * lookups by LID resolve immediately without needing group metadata.
 *
 * Also migrates any staff/mod table rows that were keyed by LID digits
 * (added when the user was first seen via @lid) to use their real phone
 * number so .getStaff(phone) works correctly going forward.
 */
export function linkUserLid(phoneOrId: string, lidJid: string): void {
  const db = getDb();
  const phone = extractNumberFromJid(phoneOrId);
  const lidNum = lidJid.split("@")[0].replace(/\D/g, "");
  if (!phone || !lidNum) return;

  // 1. Store LID on the phone-keyed user row
  db.prepare(
    "UPDATE users SET lid = ? WHERE id = ? AND (lid IS NULL OR lid = '')"
  ).run(lidNum, phone);

  // 2. Migrate any staff row keyed by raw LID digits → real phone number.
  //    This happens when a user was added as mod/guardian from WhatsApp (their
  //    JID was @lid at the time) before we resolved their phone number.
  try {
    const lidStaff = db.prepare("SELECT * FROM staff WHERE user_id = ?").get(lidNum) as any;
    if (lidStaff) {
      const phoneStaff = db.prepare("SELECT * FROM staff WHERE user_id = ?").get(phone) as any;
      if (!phoneStaff) {
        // No phone-keyed entry — rename the LID entry
        db.prepare("UPDATE staff SET user_id = ? WHERE user_id = ?").run(phone, lidNum);
      } else {
        // Phone entry already exists — the LID entry is a duplicate, remove it
        db.prepare("DELETE FROM staff WHERE user_id = ?").run(lidNum);
      }
    }
  } catch {
    // staff table may not exist yet in all DB versions — safe to ignore
  }
}

function generateDisplayId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const db = getDb();
  let did = "";
  let tries = 0;
  do {
    did = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    tries++;
  } while (tries < 50 && db.prepare("SELECT 1 FROM users WHERE display_id = ?").get(did));
  return did;
}

function generateCopyId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const db = getDb();
  let cid = "";
  let tries = 0;
  do {
    cid = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    tries++;
  } while (tries < 50 && db.prepare("SELECT 1 FROM user_cards WHERE copy_id = ?").get(cid));
  return cid;
}

export function ensureUser(userId: string, name?: string) {
  const db = getDb();
  const phone = extractNumberFromJid(userId);
  const existing = getUser(phone);
  if (!existing) {
    const did = generateDisplayId();
    db.prepare(
      "INSERT OR IGNORE INTO users (id, name, balance, bank, display_id) VALUES (?, ?, 0, 0, ?)"
    ).run(phone, name || phone, did);
  } else {
    // IMPORTANT: existing may have been found via the `lid` fallback inside
    // getUser() — meaning existing.id is the CANONICAL phone-keyed row id,
    // which can differ from `phone` (which, for an unresolved @lid sender,
    // is just the LID digits). All writes below must target existing.id,
    // never the raw `phone` var, or they silently no-op against a row that
    // doesn't exist and a ghost LID row never gets updated/merged.
    const targetId = existing.id;
    if (!existing.display_id) {
      const did = generateDisplayId();
      db.prepare("UPDATE users SET display_id = ? WHERE id = ? AND (display_id IS NULL OR display_id = '')").run(did, targetId);
    }
    // Update name from pushName when we have a real name and the stored one is missing or was defaulted to the phone number
    if (name && name !== targetId && (!existing.name || existing.name === targetId || existing.name === phone)) {
      db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, targetId);
    }
  }
  return getUser(phone);
}

export function getMentionName(userId: string): string {
  const phone = extractNumberFromJid(userId);
  const user = getUser(phone);
  if (user?.name && user.name !== phone) return user.name;
  // If the JID was a @lid and the direct phone lookup returned nothing
  // (because the LID digits ≠ the real phone number), try the LID index.
  if (!user && userId.endsWith("@lid")) {
    const lidUser = getUserByLid(userId);
    if (lidUser) {
      if (lidUser.name && lidUser.name !== lidUser.id) return lidUser.name;
      return lidUser.id; // real phone number as fallback
    }
  }
  if (user?.id) return user.id; // known user, just no custom name
  return phone;
}

export function updateUser(userId: string, data: Record<string, any>) {
  const db = getDb();
  const phone = extractNumberFromJid(userId);
  ensureUser(phone);
  const keys = Object.keys(data);
  if (keys.length === 0) return;
  const set = keys.map((k) => `${k} = ?`).join(", ");
  db.prepare(`UPDATE users SET ${set}, updated_at = unixepoch() WHERE id = ?`).run(
    ...keys.map((k) => data[k]),
    phone
  );
}

export function resetUserBalance(userId: string) {
  const db = getDb();
  const phone = extractNumberFromJid(userId);
  ensureUser(phone);
  return db.prepare("UPDATE users SET balance = 0, bank = 0, updated_at = unixepoch() WHERE id = ?").run(phone);
}

export function resetUserProfile(userId: string) {
  const db = getDb();
  const phone = extractNumberFromJid(userId);
  db.transaction(() => {
    db.prepare("DELETE FROM afk_users WHERE user_id = ?").run(phone);
    db.prepare("DELETE FROM inventory WHERE user_id = ?").run(phone);
    db.prepare("DELETE FROM user_cards WHERE user_id = ?").run(phone);
    db.prepare("DELETE FROM card_deck WHERE user_id = ?").run(phone);
    db.prepare("DELETE FROM deck_backgrounds WHERE user_id = ?").run(phone);
    db.prepare("DELETE FROM rpg_characters WHERE user_id = ?").run(phone);
    db.prepare("DELETE FROM guild_members WHERE user_id = ?").run(phone);
    db.prepare("DELETE FROM message_counts WHERE user_id = ?").run(phone);
    db.prepare("DELETE FROM warnings WHERE user_id = ?").run(phone);
    db.prepare("DELETE FROM muted_users WHERE user_id = ?").run(phone);
    db.prepare("DELETE FROM summer_tokens WHERE user_id = ?").run(phone);
    db.prepare("DELETE FROM users WHERE id = ?").run(phone);
  })();
  return ensureUser(phone);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Group helpers
// ─────────────────────────────────────────────────────────────────────────────

export function getGroup(groupId: string) {
  const db = getDb();
  return db.prepare("SELECT * FROM groups WHERE id = ?").get(groupId) as any;
}

export function getAllGroups() {
  const db = getDb();
  return db.prepare("SELECT * FROM groups").all() as any[];
}

export function ensureGroup(groupId: string, name?: string) {
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO groups (id, name) VALUES (?, ?)"
  ).run(groupId, name || groupId);
  if (name) {
    db.prepare("UPDATE groups SET name = ? WHERE id = ?").run(name, groupId);
  }
  return getGroup(groupId);
}

export function updateGroup(groupId: string, data: Record<string, any>) {
  const db = getDb();
  // Ensure the group row exists before trying to update it
  db.prepare("INSERT OR IGNORE INTO groups (id, name) VALUES (?, ?)").run(groupId, groupId);
  const keys = Object.keys(data);
  if (keys.length === 0) return;
  const set = keys.map((k) => `${k} = ?`).join(", ");
  db.prepare(`UPDATE groups SET ${set}, updated_at = unixepoch() WHERE id = ?`).run(
    ...keys.map((k) => data[k]),
    groupId
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Warnings
// ─────────────────────────────────────────────────────────────────────────────

export function getWarnings(userId: string, groupId: string) {
  const db = getDb();
  const phone = extractNumberFromJid(userId);
  return db
    .prepare("SELECT * FROM warnings WHERE user_id = ? AND group_id = ?")
    .all(phone, groupId) as any[];
}

export function addWarning(userId: string, groupId: string, reason: string, warnedBy: string) {
  const db = getDb();
  const phone = extractNumberFromJid(userId);
  db.prepare(
    "INSERT INTO warnings (user_id, group_id, reason, warned_by) VALUES (?, ?, ?, ?)"
  ).run(phone, groupId, reason, extractNumberFromJid(warnedBy));
  return getWarnings(phone, groupId);
}

export function resetWarnings(userId: string, groupId: string) {
  const db = getDb();
  const phone = extractNumberFromJid(userId);
  db.prepare("DELETE FROM warnings WHERE user_id = ? AND group_id = ?").run(phone, groupId);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Message counts
// ─────────────────────────────────────────────────────────────────────────────

export function incrementMessageCount(userId: string, groupId: string) {
  const db = getDb();
  const phone = extractNumberFromJid(userId);
  db.prepare(`
    INSERT INTO message_counts (user_id, group_id, count, last_message)
    VALUES (?, ?, 1, unixepoch())
    ON CONFLICT(user_id, group_id) DO UPDATE SET count = count + 1, last_message = unixepoch()
  `).run(phone, groupId);
}

export function getActiveMembers(groupId: string, days = 7, minMsgs = 5) {
  const db = getDb();
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  return db
    .prepare(
      "SELECT user_id, count FROM message_counts WHERE group_id = ? AND last_message > ? AND count >= ? ORDER BY count DESC"
    )
    .all(groupId, since, minMsgs) as any[];
}

export function getInactiveMembers(groupId: string, days = 7, minMsgs = 5) {
  const db = getDb();
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  return db
    .prepare(
      "SELECT user_id, count FROM message_counts WHERE group_id = ? AND (last_message <= ? OR count < ?) ORDER BY count ASC"
    )
    .all(groupId, since, minMsgs) as any[];
}

// ─────────────────────────────────────────────────────────────────────────────
//  Cards
// ─────────────────────────────────────────────────────────────────────────────

export function getCard(cardId: string) {
  const db = getDb();
  return db.prepare("SELECT * FROM cards WHERE id = ?").get(cardId) as any;
}

export function getAllCards(tier?: string) {
  const db = getDb();
  if (tier) {
    return db.prepare("SELECT * FROM cards WHERE tier = ?").all(tier) as any[];
  }
  const rows = db.prepare("SELECT * FROM cards").all() as any[];
  // If DB is empty, kick off the cards.json loader in background so future
  // spawn/commands have data without blocking the current call.
  if (rows.length === 0) {
    import("../cards-loader.js").then(({ loadCardsFromRepo }) =>
      loadCardsFromRepo().catch(() => {})
    ).catch(() => {});
  }
  return rows;
}

export function addCard(card: {
  id: string;
  name: string;
  tier: string;
  series?: string;
  image_data?: Buffer;
  description?: string;
  attack?: number;
  defense?: number;
  speed?: number;
  uploaded_by?: string;
}) {
  const db = getDb();
  db.prepare(`
    INSERT INTO cards (id, name, tier, series, image_data, description, attack, defense, speed, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    card.id,
    card.name,
    card.tier,
    card.series || "General",
    card.image_data || null,
    card.description || "",
    card.attack || 50,
    card.defense || 50,
    card.speed || 50,
    card.uploaded_by ? extractNumberFromJid(card.uploaded_by) : null
  );
}

export function getUserCards(userId: string) {
  const db = getDb();
  const phone = extractNumberFromJid(userId);
  return db.prepare(`
    SELECT uc.id as user_card_id, uc.obtained_at, uc.lent_to, c.*
    FROM user_cards uc
    JOIN cards c ON c.id = uc.card_id
    WHERE uc.user_id = ?
    ORDER BY uc.obtained_at DESC
  `).all(phone) as any[];
}

export function getUserCard(userCardId: number) {
  const db = getDb();
  return db.prepare(`
    SELECT uc.id as user_card_id, uc.user_id, uc.obtained_at, uc.lent_to, c.*
    FROM user_cards uc
    JOIN cards c ON c.id = uc.card_id
    WHERE uc.id = ?
  `).get(userCardId) as any;
}

export function giveCard(userId: string, cardId: string) {
  const db = getDb();
  const phone = extractNumberFromJid(userId);
  const copyId = generateCopyId();
  const result = db.prepare(
    "INSERT INTO user_cards (user_id, card_id, copy_id) VALUES (?, ?, ?)"
  ).run(phone, cardId, copyId);
  return result.lastInsertRowid as number;
}

export function deleteUserCardByCopyId(copyId: string, ownerId: string) {
  const db = getDb();
  const phone = extractNumberFromJid(ownerId);
  const row = db.prepare("SELECT * FROM user_cards WHERE copy_id = ? AND user_id = ?").get(copyId, phone) as any;
  if (!row) return null;
  db.prepare("DELETE FROM card_deck WHERE user_card_id = ?").run(row.id);
  db.prepare("DELETE FROM user_cards WHERE id = ?").run(row.id);
  return row;
}

export function deleteUserCardByCopyIdAdmin(copyId: string) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM user_cards WHERE copy_id = ?").get(copyId) as any;
  if (!row) return null;
  db.prepare("DELETE FROM card_deck WHERE user_card_id = ?").run(row.id);
  db.prepare("DELETE FROM user_cards WHERE id = ?").run(row.id);
  return row;
}

export function getUserCardByCopyId(copyId: string) {
  const db = getDb();
  return db.prepare("SELECT uc.*, c.name AS card_name, c.tier, c.series FROM user_cards uc JOIN cards c ON c.id = uc.card_id WHERE uc.copy_id = ?").get(copyId) as any;
}

export function transferCard(userCardId: number, newOwnerId: string) {
  const db = getDb();
  db.prepare("UPDATE user_cards SET user_id = ?, lent_to = NULL WHERE id = ?").run(
    extractNumberFromJid(newOwnerId),
    userCardId
  );
}

export function lendCard(userCardId: number, toUserId: string) {
  const db = getDb();
  db.prepare(
    "UPDATE user_cards SET lent_to = ?, lent_at = unixepoch() WHERE id = ?"
  ).run(extractNumberFromJid(toUserId), userCardId);
}

export function retrieveCard(userId: string) {
  const db = getDb();
  const phone = extractNumberFromJid(userId);
  db.prepare(
    "UPDATE user_cards SET lent_to = NULL, lent_at = NULL WHERE user_id = ? AND lent_to IS NOT NULL"
  ).run(phone);
}

export function getLentCards(userId: string) {
  const db = getDb();
  const phone = extractNumberFromJid(userId);
  return db.prepare(`
    SELECT uc.id as user_card_id, uc.lent_to, uc.lent_at, c.*
    FROM user_cards uc
    JOIN cards c ON c.id = uc.card_id
    WHERE uc.user_id = ? AND uc.lent_to IS NOT NULL
  `).all(phone) as any[];
}

// ─────────────────────────────────────────────────────────────────────────────
//  Auctions
// ─────────────────────────────────────────────────────────────────────────────

export function addAuction(sellerId: string, userCardId: number, price: number) {
  const db = getDb();
  const result = db.prepare(
    "INSERT INTO auctions (seller_id, user_card_id, price) VALUES (?, ?, ?)"
  ).run(extractNumberFromJid(sellerId), userCardId, price);
  return result.lastInsertRowid as number;
}

export function getAuctions() {
  const db = getDb();
  return db.prepare(`
    SELECT a.*, c.name, c.tier, c.series, uc.user_id as seller_id
    FROM auctions a
    JOIN user_cards uc ON uc.id = a.user_card_id
    JOIN cards c ON c.id = uc.card_id
    WHERE a.active = 1
    ORDER BY a.created_at DESC
  `).all() as any[];
}

export function getAuction(auctionId: number) {
  const db = getDb();
  return db.prepare(`
    SELECT a.*, c.name, c.tier, c.series, uc.user_id as card_owner
    FROM auctions a
    JOIN user_cards uc ON uc.id = a.user_card_id
    JOIN cards c ON c.id = uc.card_id
    WHERE a.id = ? AND a.active = 1
  `).get(auctionId) as any;
}

export function closeAuction(auctionId: number, buyerId: string) {
  const db = getDb();
  db.prepare(
    "UPDATE auctions SET active = 0, buyer_id = ?, sold_at = unixepoch() WHERE id = ?"
  ).run(extractNumberFromJid(buyerId), auctionId);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Card spawns
// ─────────────────────────────────────────────────────────────────────────────

export function spawnCardInGroup(groupId: string, cardId: string, token: string, messageId?: string) {
  const db = getDb();
  const result = db.prepare(
    "INSERT INTO card_spawns (group_id, card_id, spawn_token, message_id) VALUES (?, ?, ?, ?)"
  ).run(groupId, cardId, token, messageId || null);
  db.prepare("UPDATE groups SET last_spawned_card_id = ? WHERE id = ?").run(cardId, groupId);
  return result.lastInsertRowid as number;
}

export function getActiveSpawn(groupId: string) {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM card_spawns WHERE group_id = ? AND claimed_by IS NULL ORDER BY spawned_at DESC LIMIT 1"
  ).get(groupId) as any;
}

export function getActiveSpawnByToken(groupId: string, token: string) {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM card_spawns WHERE group_id = ? AND spawn_token = ? AND claimed_by IS NULL LIMIT 1"
  ).get(groupId, token) as any;
}

export function getLastSpawnedCardId(groupId: string): string {
  const group = getGroup(groupId);
  return group?.last_spawned_card_id || "";
}

export function getRecentSpawnedCardIds(groupId: string): string[] {
  const group = getGroup(groupId);
  try {
    return JSON.parse(group?.recent_spawned_cards || "[]");
  } catch {
    return [];
  }
}

export function recordRecentSpawnedCard(groupId: string, cardId: string, maxHistory = 25) {
  const db = getDb();
  const recent = getRecentSpawnedCardIds(groupId);
  recent.push(cardId);
  while (recent.length > maxHistory) recent.shift();
  db.prepare("UPDATE groups SET recent_spawned_cards = ? WHERE id = ?").run(JSON.stringify(recent), groupId);
}

export function getCardOwnerCount(cardId: string): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) as cnt FROM user_cards WHERE card_id = ?").get(cardId) as any;
  return row?.cnt || 0;
}

export function claimSpawn(spawnId: number, userId: string) {
  const db = getDb();
  db.prepare(
    "UPDATE card_spawns SET claimed_by = ?, claimed_at = unixepoch() WHERE id = ?"
  ).run(extractNumberFromJid(userId), spawnId);
}

export function deleteCard(cardId: string) {
  const db = getDb();
  db.prepare("DELETE FROM card_spawns WHERE card_id = ?").run(cardId);
  db.prepare("DELETE FROM user_cards WHERE card_id = ?").run(cardId);
  db.prepare("DELETE FROM cards WHERE id = ?").run(cardId);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Deck
// ─────────────────────────────────────────────────────────────────────────────

export function getDeck(userId: string) {
  const db = getDb();
  const phone = extractNumberFromJid(userId);
  return db.prepare(`
    SELECT cd.slot, uc.id as user_card_id, c.*
    FROM card_deck cd
    JOIN user_cards uc ON uc.id = cd.user_card_id
    JOIN cards c ON c.id = uc.card_id
    WHERE cd.user_id = ?
    ORDER BY cd.slot
  `).all(phone) as any[];
}

export function addToDeck(userId: string, slot: number, userCardId: number) {
  const db = getDb();
  db.prepare(
    "INSERT OR REPLACE INTO card_deck (user_id, slot, user_card_id) VALUES (?, ?, ?)"
  ).run(extractNumberFromJid(userId), slot, userCardId);
}

export function removeFromDeck(userId: string, slot: number) {
  const db = getDb();
  db.prepare("DELETE FROM card_deck WHERE user_id = ? AND slot = ?").run(extractNumberFromJid(userId), slot);
}

export function clearDeck(userId: string) {
  const db = getDb();
  db.prepare("DELETE FROM card_deck WHERE user_id = ?").run(extractNumberFromJid(userId));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Leaderboards
// ─────────────────────────────────────────────────────────────────────────────

export function getXpLeaderboard(limit = 10) {
  const db = getDb();
  return db.prepare(
    "SELECT id, name, xp, level FROM users WHERE COALESCE(is_bot, 0) = 0 AND COALESCE(registered, 0) = 1 AND id NOT IN (SELECT target FROM banned_entities WHERE type = 'user') ORDER BY COALESCE(level, 1) DESC, COALESCE(xp, 0) DESC LIMIT ?"
  ).all(limit) as any[];
}

export function isBot(userId: string): boolean {
  const db = getDb();
  const phone = extractNumberFromJid(userId);
  const row = db.prepare("SELECT is_bot FROM users WHERE id = ?").get(phone) as any;
  return row?.is_bot === 1;
}

export function addUserXp(userId: string, amount: number) {
  const user = ensureUser(userId);
  let xp = Number(user.xp || 0) + amount;
  let level = Math.max(1, Number(user.level || 1));
  while (xp >= level * 100) {
    xp -= level * 100;
    level += 1;
  }
  updateUser(userId, { xp, level });
  return { xp, level, xpNeeded: level * 100 };
}

export function getUserRank(userId: string): number {
  const db = getDb();
  const phone = extractNumberFromJid(userId);
  const user = ensureUser(phone);
  const score = Number(user.level || 1) * 100000 + Number(user.xp || 0);
  const row = db.prepare(`
    SELECT COUNT(*) + 1 as rank
    FROM users
    WHERE (COALESCE(level, 1) * 100000 + COALESCE(xp, 0)) > ?
      AND COALESCE(is_bot, 0) = 0
      AND COALESCE(registered, 0) = 1
  `).get(score) as any;
  return Number(row?.rank || 1);
}

export function getCardLeaderboard(limit = 10) {
  const db = getDb();
  return db.prepare(`
    SELECT uc.user_id, COUNT(*) as card_count
    FROM user_cards uc
    JOIN users u ON u.id = uc.user_id
    WHERE COALESCE(u.is_bot, 0) = 0 AND COALESCE(u.registered, 0) = 1
    GROUP BY uc.user_id ORDER BY card_count DESC LIMIT ?
  `).all(limit) as any[];
}

export function getCardStats() {
  const db = getDb();
  const total = db.prepare("SELECT COUNT(*) as count FROM cards").get() as any;
  const byTier = db.prepare("SELECT tier, COUNT(*) as count FROM cards GROUP BY tier ORDER BY tier").all() as any[];
  const bySeries = db.prepare("SELECT series, COUNT(*) as count FROM cards GROUP BY series ORDER BY count DESC, series LIMIT 10").all() as any[];
  return {
    total: Number(total?.count || 0),
    byTier,
    bySeries,
  };
}

export function getRichList(groupId?: string, limit = 10) {
  const db = getDb();
  const baseFilter = `COALESCE(is_bot, 0) = 0 AND COALESCE(registered, 0) = 1 AND id NOT IN (SELECT target FROM banned_entities WHERE type = 'user')`;
  if (groupId) {
    return db.prepare(`
      SELECT u.id, u.name, u.balance + u.bank as total
      FROM users u
      WHERE u.id IN (SELECT user_id FROM message_counts WHERE group_id = ?)
        AND ${baseFilter}
      ORDER BY total DESC LIMIT ?
    `).all(groupId, limit) as any[];
  }
  return db.prepare(`
    SELECT id, name, balance + bank as total
    FROM users WHERE ${baseFilter}
    ORDER BY total DESC LIMIT ?
  `).all(limit) as any[];
}

// ─────────────────────────────────────────────────────────────────────────────
//  AFK
// ─────────────────────────────────────────────────────────────────────────────

export function setAfk(userId: string, reason: string) {
  const db = getDb();
  db.prepare(
    "INSERT OR REPLACE INTO afk_users (user_id, reason, started_at) VALUES (?, ?, unixepoch())"
  ).run(extractNumberFromJid(userId), reason);
}

export function removeAfk(userId: string) {
  const db = getDb();
  db.prepare("DELETE FROM afk_users WHERE user_id = ?").run(extractNumberFromJid(userId));
}

export function getAfk(userId: string) {
  const db = getDb();
  return db.prepare("SELECT * FROM afk_users WHERE user_id = ?").get(extractNumberFromJid(userId)) as any;
}

// ─────────────────────────────────────────────────────────────────────────────
//  RPG
// ─────────────────────────────────────────────────────────────────────────────

export function getRpg(userId: string) {
  const db = getDb();
  return db.prepare("SELECT * FROM rpg_characters WHERE user_id = ?").get(extractNumberFromJid(userId)) as any;
}

export function ensureRpg(userId: string) {
  const db = getDb();
  const phone = extractNumberFromJid(userId);
  db.prepare(`
    INSERT OR IGNORE INTO rpg_characters (user_id) VALUES (?)
  `).run(phone);
  return getRpg(phone);
}

export function updateRpg(userId: string, data: Record<string, any>) {
  const db = getDb();
  const phone = extractNumberFromJid(userId);
  const keys = Object.keys(data);
  if (keys.length === 0) return;
  const set = keys.map((k) => `${k} = ?`).join(", ");
  db.prepare(`UPDATE rpg_characters SET ${set} WHERE user_id = ?`).run(
    ...keys.map((k) => data[k]),
    phone
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Inventory
// ─────────────────────────────────────────────────────────────────────────────

export function getInventory(userId: string) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM inventory
    WHERE user_id = ?
      AND quantity > 0
      AND LOWER(item) NOT IN ('card pack', 'premium card pack', 'vip pass', 'vip access')
  `).all(extractNumberFromJid(userId)) as any[];
}

export function addToInventory(userId: string, item: string, qty = 1) {
  const db = getDb();
  const phone = extractNumberFromJid(userId);
  const existing = db.prepare("SELECT * FROM inventory WHERE user_id = ? AND item = ?").get(phone, item) as any;
  if (existing) {
    db.prepare("UPDATE inventory SET quantity = quantity + ? WHERE user_id = ? AND item = ?").run(qty, phone, item);
  } else {
    db.prepare("INSERT INTO inventory (user_id, item, quantity) VALUES (?, ?, ?)").run(phone, item, qty);
  }
}

export function removeFromInventory(userId: string, item: string, qty = 1) {
  const db = getDb();
  const phone = extractNumberFromJid(userId);
  const existing = db.prepare("SELECT * FROM inventory WHERE user_id = ? AND item = ?").get(phone, item) as any;
  if (!existing || existing.quantity < qty) return false;
  db.prepare("UPDATE inventory SET quantity = quantity - ? WHERE user_id = ? AND item = ?").run(qty, phone, item);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Shop
// ─────────────────────────────────────────────────────────────────────────────

export function getShop() {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM shop_items
    WHERE LOWER(name) NOT IN ('card pack', 'premium card pack', 'vip pass', 'vip access')
    ORDER BY category, price
  `).all() as any[];
}

export function getShopItem(name: string) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM shop_items
    WHERE LOWER(name) = LOWER(?)
      AND LOWER(name) NOT IN ('card pack', 'premium card pack', 'vip pass', 'vip access')
  `).get(name) as any;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Guilds
// ─────────────────────────────────────────────────────────────────────────────

export function getGuild(name: string) {
  const db = getDb();
  return db.prepare("SELECT * FROM guilds WHERE LOWER(name) = LOWER(?)").get(name) as any;
}

export function getGuildById(guildId: string) {
  const db = getDb();
  return db.prepare("SELECT * FROM guilds WHERE id = ?").get(guildId) as any;
}

export function getUserGuild(userId: string) {
  const db = getDb();
  const phone = extractNumberFromJid(userId);
  const membership = db.prepare("SELECT * FROM guild_members WHERE user_id = ?").get(phone) as any;
  if (!membership) return null;
  return db.prepare("SELECT * FROM guilds WHERE id = ?").get(membership.guild_id) as any;
}

export function createGuild(id: string, name: string, ownerId: string) {
  const db = getDb();
  const ownerPhone = extractNumberFromJid(ownerId);
  db.prepare("INSERT INTO guilds (id, name, owner_id) VALUES (?, ?, ?)").run(id, name, ownerPhone);
  db.prepare("INSERT INTO guild_members (user_id, guild_id) VALUES (?, ?)").run(ownerPhone, id);
}

export function joinGuild(userId: string, guildId: string) {
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO guild_members (user_id, guild_id) VALUES (?, ?)").run(extractNumberFromJid(userId), guildId);
}

export function leaveGuild(userId: string) {
  const db = getDb();
  db.prepare("DELETE FROM guild_members WHERE user_id = ?").run(extractNumberFromJid(userId));
}

export function getGuildMembers(guildId: string) {
  const db = getDb();
  return db.prepare("SELECT * FROM guild_members WHERE guild_id = ?").all(guildId) as any[];
}

export function kickFromGuild(userId: string, guildId: string) {
  const db = getDb();
  db.prepare("DELETE FROM guild_members WHERE user_id = ? AND guild_id = ?").run(extractNumberFromJid(userId), guildId);
}

export function disbandGuild(guildId: string) {
  const db = getDb();
  db.prepare("DELETE FROM guild_members WHERE guild_id = ?").run(guildId);
  db.prepare("DELETE FROM guilds WHERE id = ?").run(guildId);
}

export function getAllGuilds() {
  const db = getDb();
  return db.prepare("SELECT * FROM guilds ORDER BY level DESC").all() as any[];
}

// ─────────────────────────────────────────────────────────────────────────────
//  Staff
// ─────────────────────────────────────────────────────────────────────────────

export function addStaff(userId: string, role: string, addedBy: string) {
  const db = getDb();
  const phone = extractNumberFromJid(userId);
  const addedByPhone = extractNumberFromJid(addedBy);
  db.prepare("INSERT OR REPLACE INTO staff (user_id, role, added_by) VALUES (?, ?, ?)").run(phone, role, addedByPhone);
}

export function getStaff(userId: string) {
  const db = getDb();
  const phone = extractNumberFromJid(userId);
  return (
    db.prepare("SELECT * FROM staff WHERE user_id = ?").get(phone) ||
    db.prepare("SELECT * FROM staff WHERE user_id = ?").get(userId)
  ) as any;
}

export function removeStaff(userId: string, role?: string) {
  const db = getDb();
  const phone = extractNumberFromJid(userId);
  if (role) {
    db.prepare("DELETE FROM staff WHERE user_id = ? AND role = ?").run(phone, role);
  } else {
    db.prepare("DELETE FROM staff WHERE user_id = ?").run(phone);
  }
}

export function getStaffAny(userId: string) {
  const variants = getJidVariants(userId);
  for (const jid of variants) {
    const staff = getStaff(jid);
    if (staff) return staff;
  }
  return null;
}

export function getStaffList() {
  const db = getDb();
  return db.prepare("SELECT * FROM staff ORDER BY CASE role WHEN 'guardian' THEN 1 WHEN 'mod' THEN 2 WHEN 'recruit' THEN 3 ELSE 4 END, added_at DESC").all() as any[];
}

// ─────────────────────────────────────────────────────────────────────────────
//  Group mods
// ─────────────────────────────────────────────────────────────────────────────

export function addMod(userId: string, groupId: string, addedBy: string) {
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO mods (user_id, group_id, added_by) VALUES (?, ?, ?)").run(
    extractNumberFromJid(userId), groupId, extractNumberFromJid(addedBy)
  );
}

export function getMods(groupId: string) {
  const db = getDb();
  return db.prepare("SELECT * FROM mods WHERE group_id = ?").all(groupId) as any[];
}

export function isMod(userId: string, groupId: string) {
  const db = getDb();
  return !!db.prepare("SELECT 1 FROM mods WHERE user_id = ? AND group_id = ?").get(extractNumberFromJid(userId), groupId);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Bans
// ─────────────────────────────────────────────────────────────────────────────

export function addBan(type: "user" | "group", target: string, display: string, reason: string, addedBy: string) {
  const db = getDb();
  // For user bans, store the plain phone number as target
  const normalizedTarget = type === "user" ? extractNumberFromJid(target) : target;
  db.prepare(`
    INSERT INTO banned_entities (type, target, display, reason, added_by)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(type, target) DO UPDATE SET display = excluded.display, reason = excluded.reason, added_by = excluded.added_by, added_at = unixepoch()
  `).run(type, normalizedTarget, display, reason, extractNumberFromJid(addedBy));
}

export function removeBan(type: "user" | "group", target: string) {
  const db = getDb();
  const normalizedTarget = type === "user" ? extractNumberFromJid(target) : target;
  db.prepare("DELETE FROM banned_entities WHERE type = ? AND target = ?").run(type, normalizedTarget);
}

export function getBan(type: "user" | "group", target: string) {
  const db = getDb();
  return db.prepare("SELECT * FROM banned_entities WHERE type = ? AND target = ?").get(type, target) as any;
}

export function getBanList() {
  const db = getDb();
  return db.prepare("SELECT * FROM banned_entities ORDER BY added_at DESC").all() as any[];
}

export function isBanned(type: "user" | "group", target: string) {
  return !!getBan(type, target);
}

export function isUserBanned(userId: string, extraIds: string[] = []) {
  return [...getJidVariants(userId), ...extraIds.flatMap(getJidVariants)].some((target) => isBanned("user", target));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Mutes
// ─────────────────────────────────────────────────────────────────────────────

export function muteUser(userId: string, groupId: string, mutedBy: string, expiresAt: number) {
  const db = getDb();
  db.prepare(`
    INSERT INTO muted_users (user_id, group_id, muted_by, expires_at, created_at)
    VALUES (?, ?, ?, ?, unixepoch())
    ON CONFLICT(user_id, group_id) DO UPDATE SET muted_by = excluded.muted_by, expires_at = excluded.expires_at, created_at = unixepoch()
  `).run(extractNumberFromJid(userId), groupId, extractNumberFromJid(mutedBy), expiresAt);
}

export function unmuteUser(userId: string, groupId: string) {
  const db = getDb();
  db.prepare("DELETE FROM muted_users WHERE user_id = ? AND group_id = ?").run(extractNumberFromJid(userId), groupId);
}

export function getActiveMute(userId: string, groupId: string) {
  const db = getDb();
  const phone = extractNumberFromJid(userId);
  const mute = db.prepare("SELECT * FROM muted_users WHERE user_id = ? AND group_id = ?").get(phone, groupId) as any;
  if (!mute) return null;
  const expiresAt = Number(mute.expires_at || 0);
  if (expiresAt > 0 && expiresAt <= Math.floor(Date.now() / 1000)) {
    unmuteUser(phone, groupId);
    return null;
  }
  return mute;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Economy utilities
// ─────────────────────────────────────────────────────────────────────────────

export function resetAllBalances() {
  const db = getDb();
  return db.prepare("UPDATE users SET balance = 0, bank = 0, updated_at = unixepoch()").run();
}

// ─────────────────────────────────────────────────────────────────────────────
//  JID variant helper (internal — used only for ban/mute lookups)
// ─────────────────────────────────────────────────────────────────────────────

function getJidVariants(jid: string): string[] {
  const values = new Set<string>();
  if (!jid) return [];
  values.add(jid);
  const [rawUser, rawServer = "s.whatsapp.net"] = jid.split("@");
  const user = rawUser.split(":")[0].replace(/\D/g, "") || rawUser.split(":")[0];
  if (user) {
    values.add(user); // bare phone number (primary ID)
    values.add(`${user}@${rawServer}`);
    values.add(`${user}@s.whatsapp.net`);
    values.add(`${user}@lid`);
  }
  return [...values];
}

// ─────────────────────────────────────────────────────────────────────────────
//  Bot settings
// ─────────────────────────────────────────────────────────────────────────────

export function setBotSetting(key: string, value: Buffer | string) {
  const db = getDb();
  db.prepare(`
    INSERT INTO bot_settings (key, value, updated_at)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()
  `).run(key, value);
}

export function getBotSetting(key: string): Buffer | null {
  const db = getDb();
  const row = db.prepare("SELECT value FROM bot_settings WHERE key = ?").get(key) as any;
  if (!row?.value) return null;
  return Buffer.isBuffer(row.value) ? row.value : Buffer.from(row.value);
}

export function deleteBotSetting(key: string) {
  const db = getDb();
  db.prepare("DELETE FROM bot_settings WHERE key = ?").run(key);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Summer tokens
// ─────────────────────────────────────────────────────────────────────────────

export function getSummerTokens(userId: string) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM summer_tokens WHERE user_id = ?").get(extractNumberFromJid(userId)) as any;
  return row?.tokens || 0;
}

export function addSummerTokens(userId: string, amount: number) {
  const db = getDb();
  const phone = extractNumberFromJid(userId);
  db.prepare(`
    INSERT INTO summer_tokens (user_id, tokens) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET tokens = tokens + ?
  `).run(phone, amount, amount);
}

export function setSummerTokens(userId: string, amount: number) {
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO summer_tokens (user_id, tokens) VALUES (?, ?)").run(extractNumberFromJid(userId), amount);
}

export function getTopSummerTokens(limit = 10) {
  const db = getDb();
  return db.prepare(`
    SELECT st.user_id, st.tokens, u.name
    FROM summer_tokens st
    JOIN users u ON u.id = st.user_id
    WHERE COALESCE(u.is_bot, 0) = 0 AND COALESCE(u.registered, 0) = 1
    ORDER BY st.tokens DESC LIMIT ?
  `).all(limit) as any[];
}

// ─────────────────────────────────────────────────────────────────────────────
//  Trade / sell offers
// ─────────────────────────────────────────────────────────────────────────────

export function createTradeOffer(fromUser: string, toUser: string, fromCard: number, toCard: number) {
  const db = getDb();
  const result = db.prepare(
    "INSERT INTO trade_offers (from_user, to_user, from_card, to_card) VALUES (?, ?, ?, ?)"
  ).run(extractNumberFromJid(fromUser), extractNumberFromJid(toUser), fromCard, toCard);
  return result.lastInsertRowid as number;
}

export function getPendingTrade(toUser: string) {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM trade_offers WHERE to_user = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1"
  ).get(extractNumberFromJid(toUser)) as any;
}

export function updateTradeStatus(id: number, status: string) {
  const db = getDb();
  db.prepare("UPDATE trade_offers SET status = ? WHERE id = ?").run(status, id);
}

export function createSellOffer(sellerId: string, buyerId: string, userCardId: number, price: number) {
  const db = getDb();
  const result = db.prepare(
    "INSERT INTO sell_offers (seller_id, buyer_id, user_card_id, price) VALUES (?, ?, ?, ?)"
  ).run(extractNumberFromJid(sellerId), extractNumberFromJid(buyerId), userCardId, price);
  return result.lastInsertRowid as number;
}

export function getPendingSellOffer(buyerId: string) {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM sell_offers WHERE buyer_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1"
  ).get(extractNumberFromJid(buyerId)) as any;
}

export function updateSellOfferStatus(id: number, status: string) {
  const db = getDb();
  db.prepare("UPDATE sell_offers SET status = ? WHERE id = ?").run(status, id);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Card ownership queries
// ─────────────────────────────────────────────────────────────────────────────

export function getCardOwners(cardId: string) {
  const db = getDb();
  return db.prepare(`
    SELECT uc.user_id, u.name, u.display_id, uc.id as user_card_id, uc.copy_id, uc.obtained_at,
           ROW_NUMBER() OVER (ORDER BY uc.id ASC) as issue_num
    FROM user_cards uc
    LEFT JOIN users u ON u.id = uc.user_id
    WHERE uc.card_id = ?
    ORDER BY uc.id ASC
  `).all(cardId) as any[];
}

export function getCardIssueNumber(userCardId: number, cardId: string): number {
  const db = getDb();
  const rows = db.prepare(
    "SELECT id FROM user_cards WHERE card_id = ? ORDER BY id ASC"
  ).all(cardId) as any[];
  const idx = rows.findIndex((r) => r.id === userCardId);
  return idx >= 0 ? idx + 1 : 1;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Group activity / spawn tracking
// ─────────────────────────────────────────────────────────────────────────────

export function incrementGroupActivity(groupId: string) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const WINDOW = 20 * 60;
  const group = getGroup(groupId);
  if (!group) return;
  const windowStart = Number(group.recent_msg_window || 0);
  if (now - windowStart > WINDOW) {
    db.prepare("UPDATE groups SET recent_msg_count = 1, recent_msg_window = ? WHERE id = ?").run(now, groupId);
  } else {
    db.prepare("UPDATE groups SET recent_msg_count = recent_msg_count + 1 WHERE id = ?").run(groupId);
  }
}

export function getGroupActivity(groupId: string): { count: number; percentage: number } {
  const FULL_ACTIVITY = 2000;
  const WINDOW = 20 * 60;
  const now = Math.floor(Date.now() / 1000);
  const group = getGroup(groupId);
  if (!group) return { count: 0, percentage: 0 };
  const windowStart = Number(group.recent_msg_window || 0);
  const count = (now - windowStart <= WINDOW) ? Number(group.recent_msg_count || 0) : 0;
  const percentage = Math.min(100, Math.round((count / FULL_ACTIVITY) * 100));
  return { count, percentage };
}

export function getTodaySpawnCount(groupId: string): number {
  const today = new Date().toISOString().slice(0, 10);
  const group = getGroup(groupId);
  if (!group) return 0;
  if (group.spawn_date !== today) return 0;
  return Number(group.spawn_count_today || 0);
}

export function recordSpawnForGroup(groupId: string) {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const group = getGroup(groupId);
  const currentCount = group?.spawn_date === today ? Number(group.spawn_count_today || 0) : 0;
  db.prepare("UPDATE groups SET spawn_count_today = ?, spawn_date = ? WHERE id = ?").run(currentCount + 1, today, groupId);
}

export function getNextSpawnTime(groupId: string): number {
  const group = getGroup(groupId);
  return Number(group?.next_spawn_time || 0);
}

export function setNextSpawnTime(groupId: string, time: number) {
  const db = getDb();
  db.prepare("UPDATE groups SET next_spawn_time = ? WHERE id = ?").run(time, groupId);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Lottery
// ─────────────────────────────────────────────────────────────────────────────

export function getActiveLottery(groupId?: string) {
  const db = getDb();
  if (groupId) {
    return db.prepare("SELECT * FROM lotteries WHERE group_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1").get(groupId) as any;
  }
  return db.prepare("SELECT * FROM lotteries WHERE active = 1 ORDER BY created_at DESC LIMIT 1").get() as any;
}

export function createLottery(groupId?: string) {
  const db = getDb();
  const result = db.prepare("INSERT INTO lotteries (group_id, pool, active) VALUES (?, 0, 1)").run(groupId || null);
  return result.lastInsertRowid as number;
}

export function addLotteryEntry(lotteryId: number, userId: string, amount: number) {
  const db = getDb();
  const result = db.prepare("INSERT INTO lottery_entries (lottery_id, user_id, amount) VALUES (?, ?, ?)").run(
    lotteryId, extractNumberFromJid(userId), amount
  );
  db.prepare("UPDATE lotteries SET pool = pool + ? WHERE id = ?").run(amount, lotteryId);
  return result.lastInsertRowid as number;
}

export function getLotteryEntries(lotteryId: number) {
  const db = getDb();
  return db.prepare("SELECT * FROM lottery_entries WHERE lottery_id = ?").all(lotteryId) as any[];
}

export function closeLottery(lotteryId: number, winnerId: string) {
  const db = getDb();
  db.prepare("UPDATE lotteries SET active = 0, winner_id = ?, ended_at = unixepoch() WHERE id = ?").run(
    extractNumberFromJid(winnerId), lotteryId
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Admin / clear utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Remove all guild members and guild owners who have not fully registered
 * (registered = 0 or NULL). Disbands guilds whose owner is unregistered.
 */
export function purgeUnregisteredPlayerData() {
  const db = getDb();
  db.transaction(() => {
    // Disband guilds whose owner is not registered
    const unregOwners = db.prepare(`
      SELECT g.id FROM guilds g
      LEFT JOIN users u ON u.id = g.owner_id
      WHERE COALESCE(u.registered, 0) = 0
    `).all() as any[];
    for (const g of unregOwners) {
      db.prepare("DELETE FROM guild_members WHERE guild_id = ?").run(g.id);
      db.prepare("DELETE FROM guilds WHERE id = ?").run(g.id);
    }
    // Remove guild members who are not registered
    db.prepare(`
      DELETE FROM guild_members WHERE user_id IN (
        SELECT id FROM users WHERE COALESCE(registered, 0) = 0
      )
    `).run();
    // Remove user_cards for unregistered users
    db.prepare(`
      DELETE FROM user_cards WHERE user_id IN (
        SELECT id FROM users WHERE COALESCE(registered, 0) = 0
      )
    `).run();
    // Remove unregistered users from card_deck, deck_backgrounds, rpg, inventory, afk, summer_tokens
    for (const t of ["card_deck", "deck_backgrounds", "rpg_characters", "inventory", "afk_users", "summer_tokens"]) {
      db.prepare(`DELETE FROM ${t} WHERE user_id IN (SELECT id FROM users WHERE COALESCE(registered, 0) = 0)`).run();
    }
    // Finally delete unregistered user rows
    db.prepare("DELETE FROM users WHERE COALESCE(registered, 0) = 0").run();
  })();
}

/**
 * Full wipe of all player/card/bot data. Preserves schema, shop_items, and groups.
 */
export function clearAllPlayerData() {
  const db = getDb();
  const tables = [
    "users", "user_cards", "card_deck", "deck_backgrounds",
    "auctions", "card_spawns", "cards",
    "guild_members", "guilds",
    "rpg_characters", "inventory", "summer_tokens",
    "trade_offers", "sell_offers",
    "games", "uno_games", "uno_hands", "word_chain",
    "afk_users", "lotteries", "lottery_entries",
    "message_counts", "warnings", "muted_users", "battle_requests",
    "bots", "admin_sessions", "web_otps", "web_sessions",
    "staff", "mods", "banned_entities", "bot_settings",
  ];
  db.transaction(() => {
    for (const t of tables) {
      try { db.prepare(`DELETE FROM ${t}`).run(); } catch {}
    }
  })();
}

// ─────────────────────────────────────────────────────────────────────────────
//  Frames
// ─────────────────────────────────────────────────────────────────────────────

export function getAllFrames() {
  const db = getDb();
  return db.prepare("SELECT id, name, theme, svg, url, uploaded_by, created_at FROM frames ORDER BY id ASC").all() as any[];
}

export function getFrameById(id: number) {
  const db = getDb();
  return db.prepare("SELECT * FROM frames WHERE id = ?").get(id) as any;
}

export function addFrame(name: string, theme: string, svg: string | null, image: Buffer | null, uploadedBy: string, url?: string): number {
  const db = getDb();
  const result = db.prepare(
    "INSERT INTO frames (name, theme, svg, image, uploaded_by, url) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(name, theme, svg, image, uploadedBy, url || null);
  return Number(result.lastInsertRowid);
}

export function equipFrame(userId: string, frameId: number | null) {
  const db = getDb();
  const phone = extractNumberFromJid(userId);
  db.prepare("UPDATE users SET frame_id = ? WHERE id = ?").run(frameId, phone);
}

export function getUserEquippedFrame(userId: string) {
  const db = getDb();
  const phone = extractNumberFromJid(userId);
  return db.prepare(
    "SELECT f.* FROM frames f JOIN users u ON u.frame_id = f.id WHERE u.id = ?"
  ).get(phone) as any;
}
