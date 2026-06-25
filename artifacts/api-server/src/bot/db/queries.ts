/**
 * All database queries — fully async, backed by MongoDB.
 * Mirrors the previous SQLite queries.ts interface as closely as possible.
 * Integer auto-increment IDs (user_cards, auctions, etc.) are now MongoDB
 * ObjectId strings.
 */
import { col, ObjectId } from "./mongo.js";

// ─────────────────────────────────────────────────────────────────────────────
//  JID / phone normalisation helpers
// ─────────────────────────────────────────────────────────────────────────────

export function extractNumberFromJid(jid: string): string {
  if (!jid) return "";
  const user = jid.split("@")[0].split(":")[0];
  const digits = user.replace(/\D/g, "");
  return digits || user;
}

export const normalizeUserId = extractNumberFromJid;

function getJidVariants(jid: string): string[] {
  const values = new Set<string>();
  if (!jid) return [];
  values.add(jid);
  const [rawUser, rawServer = "s.whatsapp.net"] = jid.split("@");
  const user = rawUser.split(":")[0].replace(/\D/g, "") || rawUser.split(":")[0];
  if (user) {
    values.add(user);
    values.add(`${user}@${rawServer}`);
    values.add(`${user}@s.whatsapp.net`);
    values.add(`${user}@lid`);
  }
  return [...values];
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function toStr(id: any): string {
  return id?.toString() ?? "";
}

async function generateDisplayId(): Promise<string> {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  for (let tries = 0; tries < 50; tries++) {
    const did = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    const exists = await col("users").findOne({ display_id: did });
    if (!exists) return did;
  }
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

async function generateCopyId(): Promise<string> {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  for (let tries = 0; tries < 50; tries++) {
    const cid = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    const exists = await col("user_cards").findOne({ copy_id: cid });
    if (!exists) return cid;
  }
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}

// ─────────────────────────────────────────────────────────────────────────────
//  Users
// ─────────────────────────────────────────────────────────────────────────────

export async function getUser(userId: string): Promise<any> {
  const phone = extractNumberFromJid(userId);
  const byId = await col("users").findOne({ _id: phone as any });
  if (byId) return { ...byId, id: byId._id };
  const byLid = await col("users").findOne({ lid: phone });
  if (byLid) return { ...byLid, id: byLid._id };
  return null;
}

export async function getUserByLid(lid: string): Promise<any> {
  const lidNum = lid.split("@")[0].replace(/\D/g, "");
  if (!lidNum) return null;
  const doc = await col("users").findOne({ lid: lidNum });
  return doc ? { ...doc, id: doc._id } : null;
}

export async function ensureUser(userId: string, name?: string): Promise<any> {
  const phone = extractNumberFromJid(userId);
  const existing = await getUser(phone);
  if (!existing) {
    const did = await generateDisplayId();
    await col("users").insertOne({
      _id: phone as any,
      name: name || phone,
      balance: 0,
      bank: 0,
      display_id: did,
      registered: 0,
      created_at: now(),
    });
  } else {
    const targetId = existing._id || existing.id;
    const updates: Record<string, any> = {};
    if (!existing.display_id) updates.display_id = await generateDisplayId();
    if (name && name !== targetId && (!existing.name || existing.name === targetId || existing.name === phone)) {
      updates.name = name;
    }
    if (Object.keys(updates).length > 0) {
      await col("users").updateOne({ _id: targetId as any }, { $set: updates });
    }
  }
  return getUser(phone);
}

export async function getMentionName(userId: string): Promise<string> {
  const phone = extractNumberFromJid(userId);
  const user = await getUser(phone);
  if (user?.name && user.name !== phone) return user.name;
  if (!user && userId.endsWith("@lid")) {
    const lidUser = await getUserByLid(userId);
    if (lidUser) return lidUser.name && lidUser.name !== lidUser.id ? lidUser.name : lidUser.id;
  }
  if (user?.id) return user.id;
  return phone;
}

export async function updateUser(userId: string, data: Record<string, any>): Promise<void> {
  const phone = extractNumberFromJid(userId);
  await ensureUser(phone);
  if (Object.keys(data).length === 0) return;
  await col("users").updateOne(
    { _id: phone as any },
    { $set: { ...data, updated_at: now() } }
  );
}

export async function linkUserLid(phoneOrId: string, lidJid: string): Promise<void> {
  const phone = extractNumberFromJid(phoneOrId);
  const lidNum = lidJid.split("@")[0].replace(/\D/g, "");
  if (!phone || !lidNum) return;

  await col("users").updateOne(
    { _id: phone as any, $or: [{ lid: null }, { lid: "" }, { lid: { $exists: false } }] },
    { $set: { lid: lidNum } }
  );

  // Migrate staff row keyed by LID → phone
  const lidStaff = await col("staff").findOne({ _id: lidNum as any });
  if (lidStaff) {
    const phoneStaff = await col("staff").findOne({ _id: phone as any });
    if (!phoneStaff) {
      await col("staff").updateOne({ _id: lidNum as any }, { $set: { _id: phone as any, user_id: phone } });
    } else {
      await col("staff").deleteOne({ _id: lidNum as any });
    }
  }
}

export async function resetUserBalance(userId: string): Promise<void> {
  const phone = extractNumberFromJid(userId);
  await col("users").updateOne({ _id: phone as any }, { $set: { balance: 0, bank: 0, updated_at: now() } });
}

export async function resetUserProfile(userId: string): Promise<any> {
  const phone = extractNumberFromJid(userId);
  await Promise.all([
    col("afk_users").deleteOne({ _id: phone as any }),
    col("inventory").deleteMany({ user_id: phone }),
    col("user_cards").deleteMany({ user_id: phone }),
    col("card_deck").deleteMany({ user_id: phone }),
    col("deck_backgrounds").deleteOne({ _id: phone as any }),
    col("rpg_characters").deleteOne({ _id: phone as any }),
    col("guild_members").deleteOne({ _id: phone as any }),
    col("message_counts").deleteMany({ user_id: phone }),
    col("warnings").deleteMany({ user_id: phone }),
    col("muted_users").deleteMany({ user_id: phone }),
    col("summer_tokens").deleteOne({ _id: phone as any }),
    col("users").deleteOne({ _id: phone as any }),
  ]);
  return ensureUser(phone);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Groups
// ─────────────────────────────────────────────────────────────────────────────

export async function getGroup(groupId: string): Promise<any> {
  const doc = await col("groups").findOne({ _id: groupId as any });
  return doc ? { ...doc, id: doc._id } : null;
}

export async function getAllGroups(): Promise<any[]> {
  const docs = await col("groups").find({}).toArray();
  return docs.map((d) => ({ ...d, id: d._id }));
}

export async function ensureGroup(groupId: string, name?: string): Promise<any> {
  await col("groups").updateOne(
    { _id: groupId as any },
    { $setOnInsert: { name: name || groupId, created_at: now() } },
    { upsert: true }
  );
  if (name) {
    await col("groups").updateOne({ _id: groupId as any }, { $set: { name } });
  }
  return getGroup(groupId);
}

export async function updateGroup(groupId: string, data: Record<string, any>): Promise<void> {
  await col("groups").updateOne(
    { _id: groupId as any },
    { $set: { ...data, updated_at: now() }, $setOnInsert: { name: groupId, created_at: now() } },
    { upsert: true }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Warnings
// ─────────────────────────────────────────────────────────────────────────────

export async function getWarnings(userId: string, groupId: string): Promise<any[]> {
  const phone = extractNumberFromJid(userId);
  return col("warnings").find({ user_id: phone, group_id: groupId }).toArray();
}

export async function addWarning(userId: string, groupId: string, reason: string, warnedBy: string): Promise<any[]> {
  const phone = extractNumberFromJid(userId);
  await col("warnings").insertOne({
    user_id: phone,
    group_id: groupId,
    reason,
    warned_by: extractNumberFromJid(warnedBy),
    created_at: now(),
  });
  return getWarnings(phone, groupId);
}

export async function resetWarnings(userId: string, groupId: string): Promise<void> {
  const phone = extractNumberFromJid(userId);
  await col("warnings").deleteMany({ user_id: phone, group_id: groupId });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Message counts
// ─────────────────────────────────────────────────────────────────────────────

export async function incrementMessageCount(userId: string, groupId: string): Promise<void> {
  const phone = extractNumberFromJid(userId);
  const id = `${phone}:${groupId}`;
  await col("message_counts").updateOne(
    { _id: id as any },
    { $inc: { count: 1 }, $set: { user_id: phone, group_id: groupId, last_message: now() } },
    { upsert: true }
  );
}

export async function getActiveMembers(groupId: string, days = 7, minMsgs = 5): Promise<any[]> {
  const since = now() - days * 86400;
  return col("message_counts").find({
    group_id: groupId,
    last_message: { $gt: since },
    count: { $gte: minMsgs },
  }).sort({ count: -1 }).toArray();
}

export async function getInactiveMembers(groupId: string, days = 7, minMsgs = 5): Promise<any[]> {
  const since = now() - days * 86400;
  return col("message_counts").find({
    group_id: groupId,
    $or: [{ last_message: { $lte: since } }, { count: { $lt: minMsgs } }],
  }).sort({ count: 1 }).toArray();
}

// ─────────────────────────────────────────────────────────────────────────────
//  Cards
// ─────────────────────────────────────────────────────────────────────────────

export async function getCard(cardId: string): Promise<any> {
  const doc = await col("cards").findOne({ _id: cardId as any });
  return doc ? { ...doc, id: doc._id } : null;
}

export async function getAllCards(tier?: string): Promise<any[]> {
  const query = tier ? { tier } : {};
  const docs = await col("cards").find(query).toArray();
  const results = docs.map((d) => ({ ...d, id: d._id }));
  if (results.length === 0 && !tier) {
    import("../cards-loader.js").then(({ loadCardsFromRepo }) =>
      loadCardsFromRepo().catch(() => {})
    ).catch(() => {});
  }
  return results;
}

export async function addCard(card: {
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
}): Promise<void> {
  await col("cards").updateOne(
    { _id: card.id as any },
    {
      $set: {
        name: card.name,
        tier: card.tier,
        series: card.series || "General",
        image_data: card.image_data || null,
        description: card.description || "",
        attack: card.attack ?? 50,
        defense: card.defense ?? 50,
        speed: card.speed ?? 50,
        uploaded_by: card.uploaded_by ? extractNumberFromJid(card.uploaded_by) : null,
        created_at: now(),
      },
    },
    { upsert: true }
  );
}

export async function getUserCards(userId: string): Promise<any[]> {
  const phone = extractNumberFromJid(userId);
  const userCards = await col("user_cards").find({ user_id: phone }).sort({ obtained_at: -1 }).toArray();
  if (!userCards.length) return [];
  const cardIds = [...new Set(userCards.map((uc) => uc.card_id))];
  const cards = await col("cards").find({ _id: { $in: cardIds as any[] } }).toArray();
  const cardMap = new Map(cards.map((c) => [c._id as string, { ...c, id: c._id }]));
  return userCards.map((uc) => ({
    ...(cardMap.get(uc.card_id) || {}),
    user_card_id: toStr(uc._id),
    obtained_at: uc.obtained_at,
    lent_to: uc.lent_to,
    copy_id: uc.copy_id,
  }));
}

export async function getUserCard(userCardId: string): Promise<any> {
  let oid: ObjectId;
  try { oid = new ObjectId(userCardId); } catch { return null; }
  const uc = await col("user_cards").findOne({ _id: oid });
  if (!uc) return null;
  const card = await col("cards").findOne({ _id: uc.card_id as any });
  return card
    ? { ...card, id: card._id, user_card_id: toStr(uc._id), user_id: uc.user_id, obtained_at: uc.obtained_at, lent_to: uc.lent_to }
    : null;
}

export async function giveCard(userId: string, cardId: string): Promise<string> {
  const phone = extractNumberFromJid(userId);
  const copyId = await generateCopyId();
  const result = await col("user_cards").insertOne({
    user_id: phone,
    card_id: cardId,
    copy_id: copyId,
    obtained_at: now(),
    lent_to: null,
    lent_at: null,
  });
  return toStr(result.insertedId);
}

export async function deleteUserCardByCopyId(copyId: string, ownerId: string): Promise<any> {
  const phone = extractNumberFromJid(ownerId);
  const row = await col("user_cards").findOne({ copy_id: copyId, user_id: phone });
  if (!row) return null;
  await col("card_deck").deleteMany({ user_card_id: toStr(row._id) });
  await col("user_cards").deleteOne({ _id: row._id });
  return { ...row, id: toStr(row._id) };
}

export async function deleteUserCardByCopyIdAdmin(copyId: string): Promise<any> {
  const row = await col("user_cards").findOne({ copy_id: copyId });
  if (!row) return null;
  await col("card_deck").deleteMany({ user_card_id: toStr(row._id) });
  await col("user_cards").deleteOne({ _id: row._id });
  return { ...row, id: toStr(row._id) };
}

export async function getUserCardByCopyId(copyId: string): Promise<any> {
  const uc = await col("user_cards").findOne({ copy_id: copyId });
  if (!uc) return null;
  const card = await col("cards").findOne({ _id: uc.card_id as any });
  return card
    ? { ...uc, id: toStr(uc._id), card_name: card.name, tier: card.tier, series: card.series }
    : { ...uc, id: toStr(uc._id) };
}

export async function transferCard(userCardId: string, newOwnerId: string): Promise<void> {
  let oid: ObjectId;
  try { oid = new ObjectId(userCardId); } catch { return; }
  await col("user_cards").updateOne(
    { _id: oid },
    { $set: { user_id: extractNumberFromJid(newOwnerId), lent_to: null } }
  );
}

export async function lendCard(userCardId: string, toUserId: string): Promise<void> {
  let oid: ObjectId;
  try { oid = new ObjectId(userCardId); } catch { return; }
  await col("user_cards").updateOne(
    { _id: oid },
    { $set: { lent_to: extractNumberFromJid(toUserId), lent_at: now() } }
  );
}

export async function retrieveCard(userId: string): Promise<void> {
  const phone = extractNumberFromJid(userId);
  await col("user_cards").updateMany(
    { user_id: phone, lent_to: { $ne: null } },
    { $set: { lent_to: null, lent_at: null } }
  );
}

export async function getLentCards(userId: string): Promise<any[]> {
  const phone = extractNumberFromJid(userId);
  const userCards = await col("user_cards").find({ user_id: phone, lent_to: { $ne: null } }).toArray();
  if (!userCards.length) return [];
  const cardIds = [...new Set(userCards.map((uc) => uc.card_id))];
  const cards = await col("cards").find({ _id: { $in: cardIds as any[] } }).toArray();
  const cardMap = new Map(cards.map((c) => [c._id as string, c]));
  return userCards.map((uc) => ({
    ...(cardMap.get(uc.card_id) || {}),
    user_card_id: toStr(uc._id),
    lent_to: uc.lent_to,
    lent_at: uc.lent_at,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Auctions
// ─────────────────────────────────────────────────────────────────────────────

export async function addAuction(sellerId: string, userCardId: string, price: number): Promise<string> {
  const result = await col("auctions").insertOne({
    seller_id: extractNumberFromJid(sellerId),
    user_card_id: userCardId,
    price,
    active: 1,
    created_at: now(),
  });
  return toStr(result.insertedId);
}

export async function getAuctions(): Promise<any[]> {
  const auctions = await col("auctions").find({ active: 1 }).sort({ created_at: -1 }).toArray();
  if (!auctions.length) return [];
  const userCardIds = auctions.map((a) => { try { return new ObjectId(a.user_card_id); } catch { return null; } }).filter(Boolean);
  const userCards = await col("user_cards").find({ _id: { $in: userCardIds as any[] } }).toArray();
  const cardIds = [...new Set(userCards.map((uc) => uc.card_id))];
  const cards = await col("cards").find({ _id: { $in: cardIds as any[] } }).toArray();
  const cardMap = new Map(cards.map((c) => [c._id as string, c]));
  const ucMap = new Map(userCards.map((uc) => [toStr(uc._id), uc]));
  return auctions.map((a) => {
    const uc = ucMap.get(a.user_card_id);
    const card = cardMap.get(uc?.card_id);
    return { ...a, id: toStr(a._id), name: card?.name, tier: card?.tier, series: card?.series, seller_id: uc?.user_id };
  });
}

export async function getAuction(auctionId: string): Promise<any> {
  let oid: ObjectId;
  try { oid = new ObjectId(auctionId); } catch { return null; }
  const a = await col("auctions").findOne({ _id: oid, active: 1 });
  if (!a) return null;
  let card: any = null;
  let uc: any = null;
  try {
    uc = await col("user_cards").findOne({ _id: new ObjectId(a.user_card_id) });
    if (uc) card = await col("cards").findOne({ _id: uc.card_id as any });
  } catch {}
  return { ...a, id: toStr(a._id), name: card?.name, tier: card?.tier, series: card?.series, card_owner: uc?.user_id };
}

export async function closeAuction(auctionId: string, buyerId: string): Promise<void> {
  let oid: ObjectId;
  try { oid = new ObjectId(auctionId); } catch { return; }
  await col("auctions").updateOne(
    { _id: oid },
    { $set: { active: 0, buyer_id: extractNumberFromJid(buyerId), sold_at: now() } }
  );
}

export interface CreateAuctionOptions {
  sellerId: string;
  sellerName: string;
  userCardId: string;
  cardId: string;
  cardName: string;
  cardTier: string;
  cardSeries: string;
  cardImageUrl: string | null;
  startingPrice: number;
  minIncrement: number;
  endTime: number;
  groupJid: string | null;
}

export async function createAuction(opts: CreateAuctionOptions): Promise<string> {
  const result = await col("auctions").insertOne({
    seller_id: extractNumberFromJid(opts.sellerId),
    seller_name: opts.sellerName,
    user_card_id: opts.userCardId,
    card_id: opts.cardId,
    card_name: opts.cardName,
    card_tier: opts.cardTier,
    card_series: opts.cardSeries,
    card_image_url: opts.cardImageUrl || null,
    starting_price: opts.startingPrice,
    current_bid: opts.startingPrice,
    current_bidder_id: null,
    current_bidder_name: null,
    min_increment: opts.minIncrement,
    end_time: opts.endTime,
    active: 1,
    status: "active",
    bids: [],
    group_jid: opts.groupJid || null,
    price: opts.startingPrice,
    created_at: now(),
  });
  return toStr(result.insertedId);
}

export async function placeBid(
  auctionId: string,
  bidderId: string,
  bidderName: string,
  amount: number
): Promise<{ ok: boolean; message: string; auction?: any }> {
  let oid: ObjectId;
  try { oid = new ObjectId(auctionId); } catch { return { ok: false, message: "Invalid auction ID" }; }
  const nowSec = now();
  const auction = await col("auctions").findOne({ _id: oid, active: 1 });
  if (!auction) return { ok: false, message: "Auction not found or already ended" };
  if (auction.end_time && auction.end_time < nowSec) return { ok: false, message: "This auction has already ended" };
  const bidderPhone = extractNumberFromJid(bidderId);
  if (auction.seller_id === bidderPhone) return { ok: false, message: "You cannot bid on your own auction" };
  const minBid = Math.max(
    (auction.current_bid ?? auction.starting_price ?? 0) + (auction.min_increment || 100),
    auction.starting_price || 0
  );
  if (amount < minBid) return { ok: false, message: `Minimum bid is $${minBid.toLocaleString()}` };
  const bid = { bidder_id: bidderPhone, bidder_name: bidderName, amount, bid_at: nowSec };
  await col("auctions").updateOne({ _id: oid }, {
    $set: { current_bid: amount, current_bidder_id: bidderPhone, current_bidder_name: bidderName },
    $push: { bids: bid as any },
  });
  const updated = await col("auctions").findOne({ _id: oid });
  return { ok: true, message: "Bid placed successfully", auction: updated ? { ...updated, id: toStr(updated._id) } : null };
}

export async function settleExpiredAuctions(): Promise<void> {
  const nowSec = now();
  const expired = await col("auctions").find({ active: 1, end_time: { $lt: nowSec } }).toArray();
  for (const a of expired) {
    await col("auctions").updateOne({ _id: a._id }, { $set: { active: 0, status: "ended", ended_at: nowSec } });
    if (!a.current_bidder_id || !a.user_card_id) continue;
    try {
      const winnerQuery = { $or: [{ phone: a.current_bidder_id }, { wa_sender: a.current_bidder_id }] };
      const winnerUser = await col("users").findOne(winnerQuery as any);
      if (!winnerUser) continue;
      let ucOid: ObjectId;
      try { ucOid = new ObjectId(a.user_card_id); } catch { continue; }
      await col("user_cards").updateOne({ _id: ucOid }, { $set: { user_id: `${a.current_bidder_id}@s.whatsapp.net` } });
      const paidAmt = a.current_bid || a.price || 0;
      await col("users").updateOne({ _id: winnerUser._id }, { $inc: { balance: -Math.min(paidAmt, winnerUser.balance || 0) } });
      const sellerQuery = { $or: [{ phone: a.seller_id }, { wa_sender: a.seller_id }] };
      const sellerUser = await col("users").findOne(sellerQuery as any);
      if (sellerUser) await col("users").updateOne({ _id: sellerUser._id }, { $inc: { balance: paidAmt } });
    } catch {}
  }
}

export async function getAuctionsLive(): Promise<any[]> {
  void settleExpiredAuctions();
  const nowSec = now();
  const auctions = await col("auctions").find({ active: 1 }).sort({ end_time: 1 }).toArray();
  return auctions.map((a) => ({
    ...a,
    id: toStr(a._id),
    timeLeft: Math.max(0, (a.end_time || 0) - nowSec),
    imageUrl: a.card_image_url || null,
  }));
}

export async function getAuctionById(auctionId: string): Promise<any> {
  let oid: ObjectId;
  try { oid = new ObjectId(auctionId); } catch { return null; }
  const a = await col("auctions").findOne({ _id: oid });
  if (!a) return null;
  const nowSec = now();
  return { ...a, id: toStr(a._id), timeLeft: Math.max(0, (a.end_time || 0) - nowSec) };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Card spawns
// ─────────────────────────────────────────────────────────────────────────────

export async function spawnCardInGroup(groupId: string, cardId: string, token: string, messageId?: string, expiresAt?: number): Promise<string> {
  const result = await col("card_spawns").insertOne({
    group_id: groupId,
    card_id: cardId,
    spawn_token: token,
    message_id: messageId || null,
    spawned_at: now(),
    expires_at: expiresAt ?? (now() + 270),
    claimed_by: null,
    claimed_at: null,
  });
  await col("groups").updateOne({ _id: groupId as any }, { $set: { last_spawned_card_id: cardId } });
  return toStr(result.insertedId);
}

export async function getActiveSpawn(groupId: string): Promise<any> {
  const nowSec = now();
  const doc = await col("card_spawns").findOne(
    { group_id: groupId, claimed_by: null, $or: [{ expires_at: { $exists: false } }, { expires_at: { $gt: nowSec } }] },
    { sort: { spawned_at: -1 } }
  );
  return doc ? { ...doc, id: toStr(doc._id) } : null;
}

export async function getActiveSpawnByToken(groupId: string, token: string): Promise<any> {
  const nowSec = now();
  const doc = await col("card_spawns").findOne({
    group_id: groupId, spawn_token: token, claimed_by: null,
    $or: [{ expires_at: { $exists: false } }, { expires_at: { $gt: nowSec } }],
  });
  return doc ? { ...doc, id: toStr(doc._id) } : null;
}

export async function getLastSpawnedCardId(groupId: string): Promise<string> {
  const group = await getGroup(groupId);
  return group?.last_spawned_card_id || "";
}

export async function getRecentSpawnedCardIds(groupId: string): Promise<string[]> {
  const group = await getGroup(groupId);
  try { return JSON.parse(group?.recent_spawned_cards || "[]"); } catch { return []; }
}

export async function recordRecentSpawnedCard(groupId: string, cardId: string, maxHistory = 25): Promise<void> {
  const recent = await getRecentSpawnedCardIds(groupId);
  recent.push(cardId);
  while (recent.length > maxHistory) recent.shift();
  await col("groups").updateOne({ _id: groupId as any }, { $set: { recent_spawned_cards: JSON.stringify(recent) } });
}

export async function getCardOwnerCount(cardId: string): Promise<number> {
  return col("user_cards").countDocuments({ card_id: cardId });
}

export async function claimSpawn(spawnId: string, userId: string): Promise<void> {
  let oid: ObjectId;
  try { oid = new ObjectId(spawnId); } catch { return; }
  await col("card_spawns").updateOne(
    { _id: oid },
    { $set: { claimed_by: extractNumberFromJid(userId), claimed_at: now() } }
  );
}

export async function deleteCard(cardId: string): Promise<void> {
  await Promise.all([
    col("card_spawns").deleteMany({ card_id: cardId }),
    col("user_cards").deleteMany({ card_id: cardId }),
    col("cards").deleteOne({ _id: cardId as any }),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Deck
// ─────────────────────────────────────────────────────────────────────────────

export async function getDeck(userId: string): Promise<any[]> {
  const phone = extractNumberFromJid(userId);
  const deck = await col("card_deck").find({ user_id: phone }).sort({ slot: 1 }).toArray();
  if (!deck.length) return [];
  const userCardOids = deck
    .map((d) => { try { return new ObjectId(d.user_card_id); } catch { return null; } })
    .filter(Boolean) as ObjectId[];
  const userCards = await col("user_cards").find({ _id: { $in: userCardOids } }).toArray();
  const cardIds = [...new Set(userCards.map((uc) => uc.card_id))];
  const cards = await col("cards").find({ _id: { $in: cardIds as any[] } }).toArray();
  const cardMap = new Map(cards.map((c) => [c._id as string, { ...c, id: c._id }]));
  const ucMap = new Map(userCards.map((uc) => [toStr(uc._id), uc]));
  return deck.map((d) => {
    const uc = ucMap.get(d.user_card_id);
    return { ...(cardMap.get(uc?.card_id) || {}), slot: d.slot, user_card_id: d.user_card_id };
  });
}

export async function addToDeck(userId: string, slot: number, userCardId: string): Promise<void> {
  const phone = extractNumberFromJid(userId);
  await col("card_deck").updateOne(
    { user_id: phone, slot },
    { $set: { user_id: phone, slot, user_card_id: userCardId } },
    { upsert: true }
  );
}

export async function removeFromDeck(userId: string, slot: number): Promise<void> {
  const phone = extractNumberFromJid(userId);
  await col("card_deck").deleteOne({ user_id: phone, slot });
}

export async function clearDeck(userId: string): Promise<void> {
  const phone = extractNumberFromJid(userId);
  await col("card_deck").deleteMany({ user_id: phone });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Leaderboards
// ─────────────────────────────────────────────────────────────────────────────

export async function getXpLeaderboard(limit = 10): Promise<any[]> {
  const docs = await col("users")
    .find({ is_bot: { $ne: 1 }, registered: 1 })
    .sort({ level: -1, xp: -1 })
    .limit(limit)
    .project({ _id: 1, name: 1, xp: 1, level: 1 })
    .toArray();
  return docs.map((d) => ({ ...d, id: d._id }));
}

export async function isBot(userId: string): Promise<boolean> {
  const phone = extractNumberFromJid(userId);
  const doc = await col("users").findOne({ _id: phone as any }, { projection: { is_bot: 1 } });
  return doc?.is_bot === 1;
}

export async function addUserXp(userId: string, amount: number): Promise<{ xp: number; level: number; xpNeeded: number }> {
  const user = await ensureUser(userId);
  let xp = Number(user.xp || 0) + amount;
  let level = Math.max(1, Number(user.level || 1));
  while (xp >= level * 100) {
    xp -= level * 100;
    level += 1;
  }
  await updateUser(userId, { xp, level });
  return { xp, level, xpNeeded: level * 100 };
}

export async function getUserRank(userId: string): Promise<number> {
  const phone = extractNumberFromJid(userId);
  const user = await ensureUser(phone);
  const score = Number(user.level || 1) * 100000 + Number(user.xp || 0);
  const count = await col("users").countDocuments({
    $expr: { $gt: [{ $add: [{ $multiply: [{ $ifNull: ["$level", 1] }, 100000] }, { $ifNull: ["$xp", 0] }] }, score] },
    is_bot: { $ne: 1 },
    registered: 1,
  });
  return count + 1;
}

export async function getCardLeaderboard(limit = 10): Promise<any[]> {
  return col("user_cards").aggregate([
    {
      $lookup: {
        from: "users",
        localField: "user_id",
        foreignField: "_id",
        as: "user",
      },
    },
    { $unwind: "$user" },
    { $match: { "user.is_bot": { $ne: 1 }, "user.registered": 1 } },
    { $group: { _id: "$user_id", card_count: { $sum: 1 } } },
    { $sort: { card_count: -1 } },
    { $limit: limit },
    { $project: { user_id: "$_id", card_count: 1 } },
  ]).toArray();
}

export async function getCardStats(): Promise<{ total: number; byTier: any[]; bySeries: any[] }> {
  const [total, byTier, bySeries] = await Promise.all([
    col("cards").countDocuments(),
    col("cards").aggregate([{ $group: { _id: "$tier", count: { $sum: 1 } } }, { $sort: { _id: 1 } }, { $project: { tier: "$_id", count: 1 } }]).toArray(),
    col("cards").aggregate([{ $group: { _id: "$series", count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }, { $limit: 10 }, { $project: { series: "$_id", count: 1 } }]).toArray(),
  ]);
  return { total, byTier, bySeries };
}

export async function getRichList(groupId?: string, limit = 10): Promise<any[]> {
  const base: any = { is_bot: { $ne: 1 }, registered: 1 };
  if (groupId) {
    const members = await col("message_counts").distinct("user_id", { group_id: groupId });
    base._id = { $in: members };
  }
  const docs = await col("users")
    .find(base)
    .project({ _id: 1, name: 1, balance: 1, bank: 1 })
    .toArray();
  return docs
    .map((d) => ({ id: d._id, name: d.name, total: (d.balance || 0) + (d.bank || 0) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

// ─────────────────────────────────────────────────────────────────────────────
//  AFK
// ─────────────────────────────────────────────────────────────────────────────

export async function setAfk(userId: string, reason: string): Promise<void> {
  const phone = extractNumberFromJid(userId);
  await col("afk_users").updateOne(
    { _id: phone as any },
    { $set: { user_id: phone, reason, started_at: now() } },
    { upsert: true }
  );
}

export async function removeAfk(userId: string): Promise<void> {
  const phone = extractNumberFromJid(userId);
  await col("afk_users").deleteOne({ _id: phone as any });
}

export async function getAfk(userId: string): Promise<any> {
  const phone = extractNumberFromJid(userId);
  return col("afk_users").findOne({ _id: phone as any });
}

// ─────────────────────────────────────────────────────────────────────────────
//  RPG characters
// ─────────────────────────────────────────────────────────────────────────────

export async function getRpg(userId: string): Promise<any> {
  const phone = extractNumberFromJid(userId);
  const doc = await col("rpg_characters").findOne({ _id: phone as any });
  if (!doc) return null;
  // Defensive defaults — older records (created before these fields existed)
  // may be missing them entirely, which produces NaN/undefined in dungeon
  // battles and the .rpg dashboard. These fallbacks apply to the returned
  // object only; they do not persist until updateRpg writes them back.
  return {
    ...doc,
    user_id: phone,
    attack: doc.attack ?? 15,
    defense: doc.defense ?? 10,
    speed: doc.speed ?? 10,
    dungeon_floor: doc.dungeon_floor ?? 1,
    last_dungeon: doc.last_dungeon ?? 0,
    last_quest: doc.last_quest ?? 0,
  };
}

export async function ensureRpg(userId: string): Promise<any> {
  const phone = extractNumberFromJid(userId);
  await col("rpg_characters").updateOne(
    { _id: phone as any },
    {
      $setOnInsert: {
        user_id: phone,
        hp: 100, max_hp: 100,
        mana: 50, max_mana: 50,
        attack: 15, defense: 10, speed: 10,
        strength: 1, agility: 1, intelligence: 1, luck: 1,
        skill_points: 0,
        level: 1, xp: 0,
        gold: 0,
        dungeon_floor: 1,
        last_dungeon: 0, last_quest: 0,
        created_at: now(),
        last_action: 0,
      },
    },
    { upsert: true }
  );
  return getRpg(phone);
}

export async function updateRpg(userId: string, data: Record<string, any>): Promise<void> {
  const phone = extractNumberFromJid(userId);
  if (Object.keys(data).length === 0) return;
  await col("rpg_characters").updateOne(
    { _id: phone as any },
    { $set: { ...data, updated_at: now() } }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Inventory
// ─────────────────────────────────────────────────────────────────────────────

const HIDDEN_ITEMS = new Set(["card pack", "premium card pack", "vip pass", "vip access"]);

export async function getInventory(userId: string): Promise<any[]> {
  const phone = extractNumberFromJid(userId);
  const docs = await col("inventory").find({ user_id: phone, quantity: { $gt: 0 } }).toArray();
  return docs.filter((d) => !HIDDEN_ITEMS.has(d.item?.toLowerCase()));
}

export async function addToInventory(userId: string, item: string, qty = 1): Promise<void> {
  const phone = extractNumberFromJid(userId);
  await col("inventory").updateOne(
    { user_id: phone, item },
    { $inc: { quantity: qty }, $setOnInsert: { user_id: phone, item, created_at: now() } },
    { upsert: true }
  );
}

export async function removeFromInventory(userId: string, item: string, qty = 1): Promise<boolean> {
  const phone = extractNumberFromJid(userId);
  const existing = await col("inventory").findOne({ user_id: phone, item });
  if (!existing || existing.quantity < qty) return false;
  await col("inventory").updateOne({ user_id: phone, item }, { $inc: { quantity: -qty } });
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Shop
// ─────────────────────────────────────────────────────────────────────────────

export async function getShop(): Promise<any[]> {
  const docs = await col("shop_items").find({}).sort({ category: 1, price: 1 }).toArray();
  return docs
    .filter((d) => !HIDDEN_ITEMS.has(d.name?.toLowerCase()))
    .map((d) => ({ ...d, id: toStr(d._id) }));
}

export async function getShopItem(name: string): Promise<any> {
  if (HIDDEN_ITEMS.has(name.toLowerCase())) return null;
  const doc = await col("shop_items").findOne({ name: { $regex: new RegExp(`^${name}$`, "i") } });
  return doc ? { ...doc, id: toStr(doc._id) } : null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Guilds
// ─────────────────────────────────────────────────────────────────────────────

export async function getGuild(name: string): Promise<any> {
  const doc = await col("guilds").findOne({ name: { $regex: new RegExp(`^${name}$`, "i") } });
  return doc ? { ...doc, id: doc._id } : null;
}

export async function getGuildById(guildId: string): Promise<any> {
  const doc = await col("guilds").findOne({ _id: guildId as any });
  return doc ? { ...doc, id: doc._id } : null;
}

export async function getUserGuild(userId: string): Promise<any> {
  const phone = extractNumberFromJid(userId);
  const membership = await col("guild_members").findOne({ _id: phone as any });
  if (!membership) return null;
  return getGuildById(membership.guild_id);
}

export async function createGuild(id: string, name: string, ownerId: string): Promise<void> {
  const ownerPhone = extractNumberFromJid(ownerId);
  await col("guilds").insertOne({
    _id: id as any,
    name,
    owner_id: ownerPhone,
    level: 1,
    xp: 0,
    description: "",
    created_at: now(),
  });
  await col("guild_members").updateOne(
    { _id: ownerPhone as any },
    { $set: { user_id: ownerPhone, guild_id: id, joined_at: now() } },
    { upsert: true }
  );
}

export async function joinGuild(userId: string, guildId: string): Promise<void> {
  const phone = extractNumberFromJid(userId);
  await col("guild_members").updateOne(
    { _id: phone as any },
    { $set: { user_id: phone, guild_id: guildId, joined_at: now() } },
    { upsert: true }
  );
}

export async function leaveGuild(userId: string): Promise<void> {
  const phone = extractNumberFromJid(userId);
  await col("guild_members").deleteOne({ _id: phone as any });
}

export async function getGuildMembers(guildId: string): Promise<any[]> {
  return col("guild_members").find({ guild_id: guildId }).toArray();
}

export async function kickFromGuild(userId: string, guildId: string): Promise<void> {
  const phone = extractNumberFromJid(userId);
  await col("guild_members").deleteOne({ _id: phone as any, guild_id: guildId });
}

export async function disbandGuild(guildId: string): Promise<void> {
  await Promise.all([
    col("guild_members").deleteMany({ guild_id: guildId }),
    col("guilds").deleteOne({ _id: guildId as any }),
  ]);
}

export async function getGuildsByIds(guildIds: string[]): Promise<any[]> {
  if (guildIds.length === 0) return [];
  const docs = await col("guilds").find({ _id: { $in: guildIds as any[] } }).toArray();
  return docs.map((d: any) => ({ ...d, id: toStr(d._id) }));
}

export async function getAllGuilds(): Promise<any[]> {
  const docs = await col("guilds").find({}).sort({ level: -1 }).toArray();
  return docs.map((d) => ({ ...d, id: d._id }));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Staff
// ─────────────────────────────────────────────────────────────────────────────

export async function addStaff(userId: string, role: string, addedBy: string): Promise<void> {
  const phone = extractNumberFromJid(userId);
  const addedByPhone = extractNumberFromJid(addedBy);
  await col("staff").updateOne(
    { _id: phone as any },
    { $set: { user_id: phone, role, added_by: addedByPhone, added_at: now() } },
    { upsert: true }
  );
}

export async function getStaff(userId: string): Promise<any> {
  const phone = extractNumberFromJid(userId);
  const doc = await col("staff").findOne({ _id: phone as any }) ||
               await col("staff").findOne({ _id: userId as any });
  return doc ? { ...doc, user_id: doc._id } : null;
}

export async function removeStaff(userId: string, role?: string): Promise<void> {
  const phone = extractNumberFromJid(userId);
  if (role) {
    await col("staff").deleteOne({ _id: phone as any, role });
  } else {
    await col("staff").deleteOne({ _id: phone as any });
  }
}

export async function getStaffAny(userId: string): Promise<any> {
  for (const jid of getJidVariants(userId)) {
    const staff = await getStaff(jid);
    if (staff) return staff;
  }
  return null;
}

export async function getStaffList(): Promise<any[]> {
  const docs = await col("staff").find({}).toArray();
  return docs
    .map((d) => ({ ...d, user_id: d._id }))
    .sort((a, b) => {
      const order: Record<string, number> = { guardian: 1, mod: 2, recruit: 3 };
      return (order[a.role] || 4) - (order[b.role] || 4) || b.added_at - a.added_at;
    });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Group mods
// ─────────────────────────────────────────────────────────────────────────────

export async function addMod(userId: string, groupId: string, addedBy: string): Promise<void> {
  const phone = extractNumberFromJid(userId);
  const id = `${phone}:${groupId}`;
  await col("mods").updateOne(
    { _id: id as any },
    { $set: { user_id: phone, group_id: groupId, added_by: extractNumberFromJid(addedBy), added_at: now() } },
    { upsert: true }
  );
}

export async function getMods(groupId: string): Promise<any[]> {
  return col("mods").find({ group_id: groupId }).toArray();
}

export async function isMod(userId: string, groupId: string): Promise<boolean> {
  const phone = extractNumberFromJid(userId);
  const id = `${phone}:${groupId}`;
  return !!(await col("mods").findOne({ _id: id as any }));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Bans
// ─────────────────────────────────────────────────────────────────────────────

export async function addBan(type: "user" | "group", target: string, display: string, reason: string, addedBy: string): Promise<void> {
  const normalizedTarget = type === "user" ? extractNumberFromJid(target) : target;
  const id = `${type}:${normalizedTarget}`;
  await col("banned_entities").updateOne(
    { _id: id as any },
    { $set: { type, target: normalizedTarget, display, reason, added_by: extractNumberFromJid(addedBy), added_at: now() } },
    { upsert: true }
  );
}

export async function removeBan(type: "user" | "group", target: string): Promise<void> {
  const normalizedTarget = type === "user" ? extractNumberFromJid(target) : target;
  await col("banned_entities").deleteOne({ _id: `${type}:${normalizedTarget}` as any });
}

export async function getBan(type: "user" | "group", target: string): Promise<any> {
  const normalizedTarget = type === "user" ? extractNumberFromJid(target) : target;
  return col("banned_entities").findOne({ _id: `${type}:${normalizedTarget}` as any });
}

export async function getBanList(): Promise<any[]> {
  return col("banned_entities").find({}).sort({ added_at: -1 }).toArray();
}

export async function isBanned(type: "user" | "group", target: string): Promise<boolean> {
  return !!(await getBan(type, target));
}

export async function isUserBanned(userId: string, extraIds: string[] = []): Promise<boolean> {
  const variants = [...getJidVariants(userId), ...extraIds.flatMap(getJidVariants)];
  for (const target of variants) {
    if (await isBanned("user", target)) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Mutes
// ─────────────────────────────────────────────────────────────────────────────

export async function muteUser(userId: string, groupId: string, mutedBy: string, expiresAt: number): Promise<void> {
  const phone = extractNumberFromJid(userId);
  const id = `${phone}:${groupId}`;
  await col("muted_users").updateOne(
    { _id: id as any },
    { $set: { user_id: phone, group_id: groupId, muted_by: extractNumberFromJid(mutedBy), expires_at: expiresAt, created_at: now() } },
    { upsert: true }
  );
}

export async function unmuteUser(userId: string, groupId: string): Promise<void> {
  const phone = extractNumberFromJid(userId);
  await col("muted_users").deleteOne({ _id: `${phone}:${groupId}` as any });
}

export async function getActiveMute(userId: string, groupId: string): Promise<any> {
  const phone = extractNumberFromJid(userId);
  const mute = await col("muted_users").findOne({ _id: `${phone}:${groupId}` as any });
  if (!mute) return null;
  const expiresAt = Number(mute.expires_at || 0);
  if (expiresAt > 0 && expiresAt <= now()) {
    await unmuteUser(phone, groupId);
    return null;
  }
  return mute;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Economy utilities
// ─────────────────────────────────────────────────────────────────────────────

export async function resetAllBalances(): Promise<void> {
  await col("users").updateMany({}, { $set: { balance: 0, bank: 0, updated_at: now() } });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Bot settings
// ─────────────────────────────────────────────────────────────────────────────

export async function setBotSetting(key: string, value: Buffer | string): Promise<void> {
  const data = Buffer.isBuffer(value) ? value.toString("base64") : value;
  const isBuffer = Buffer.isBuffer(value);
  await col("bot_settings").updateOne(
    { _id: key as any },
    { $set: { value: data, is_buffer: isBuffer, updated_at: now() } },
    { upsert: true }
  );
}

export async function getBotSetting(key: string): Promise<Buffer | null> {
  const doc = await col("bot_settings").findOne({ _id: key as any });
  if (!doc?.value) return null;
  if (doc.is_buffer) return Buffer.from(doc.value, "base64");
  return Buffer.from(doc.value);
}

export async function deleteBotSetting(key: string): Promise<void> {
  await col("bot_settings").deleteOne({ _id: key as any });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Summer tokens
// ─────────────────────────────────────────────────────────────────────────────

export async function getSummerTokens(userId: string): Promise<number> {
  const phone = extractNumberFromJid(userId);
  const doc = await col("summer_tokens").findOne({ _id: phone as any });
  return doc?.tokens || 0;
}

export async function addSummerTokens(userId: string, amount: number): Promise<void> {
  const phone = extractNumberFromJid(userId);
  await col("summer_tokens").updateOne(
    { _id: phone as any },
    { $inc: { tokens: amount }, $setOnInsert: { user_id: phone, created_at: now() } },
    { upsert: true }
  );
}

export async function setSummerTokens(userId: string, amount: number): Promise<void> {
  const phone = extractNumberFromJid(userId);
  await col("summer_tokens").updateOne(
    { _id: phone as any },
    { $set: { tokens: amount, user_id: phone } },
    { upsert: true }
  );
}

export async function getTopSummerTokens(limit = 10): Promise<any[]> {
  return col("summer_tokens").aggregate([
    { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "user" } },
    { $unwind: "$user" },
    { $match: { "user.is_bot": { $ne: 1 }, "user.registered": 1 } },
    { $sort: { tokens: -1 } },
    { $limit: limit },
    { $project: { user_id: "$_id", tokens: 1, name: "$user.name" } },
  ]).toArray();
}

// ─────────────────────────────────────────────────────────────────────────────
//  Trade / sell offers
// ─────────────────────────────────────────────────────────────────────────────

export async function createTradeOffer(fromUser: string, toUser: string, fromCard: string, toCard: string): Promise<string> {
  const result = await col("trade_offers").insertOne({
    from_user: extractNumberFromJid(fromUser),
    to_user: extractNumberFromJid(toUser),
    from_card: fromCard,
    to_card: toCard,
    status: "pending",
    created_at: now(),
  });
  return toStr(result.insertedId);
}

export async function getPendingTrade(toUser: string): Promise<any> {
  const phone = extractNumberFromJid(toUser);
  const doc = await col("trade_offers")
    .find({ to_user: phone, status: "pending" })
    .sort({ created_at: -1 })
    .limit(1)
    .toArray();
  return doc[0] ? { ...doc[0], id: toStr(doc[0]._id) } : null;
}

export async function updateTradeStatus(id: string, status: string): Promise<void> {
  let oid: ObjectId;
  try { oid = new ObjectId(id); } catch { return; }
  await col("trade_offers").updateOne({ _id: oid }, { $set: { status } });
}

export async function createSellOffer(sellerId: string, buyerId: string, userCardId: string, price: number): Promise<string> {
  const result = await col("sell_offers").insertOne({
    seller_id: extractNumberFromJid(sellerId),
    buyer_id: extractNumberFromJid(buyerId),
    user_card_id: userCardId,
    price,
    status: "pending",
    created_at: now(),
  });
  return toStr(result.insertedId);
}

export async function getPendingSellOffer(buyerId: string): Promise<any> {
  const phone = extractNumberFromJid(buyerId);
  const docs = await col("sell_offers")
    .find({ buyer_id: phone, status: "pending" })
    .sort({ created_at: -1 })
    .limit(1)
    .toArray();
  return docs[0] ? { ...docs[0], id: toStr(docs[0]._id) } : null;
}

export async function updateSellOfferStatus(id: string, status: string): Promise<void> {
  let oid: ObjectId;
  try { oid = new ObjectId(id); } catch { return; }
  await col("sell_offers").updateOne({ _id: oid }, { $set: { status } });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Card ownership
// ─────────────────────────────────────────────────────────────────────────────

export async function getCardOwners(cardId: string): Promise<any[]> {
  const userCards = await col("user_cards").find({ card_id: cardId }).sort({ _id: 1 }).toArray();
  if (!userCards.length) return [];
  const userIds = userCards.map((uc) => uc.user_id);
  const users = await col("users").find({ _id: { $in: userIds as any[] } }).toArray();
  const userMap = new Map(users.map((u) => [u._id as string, u]));
  return userCards.map((uc, idx) => {
    const u = userMap.get(uc.user_id) || {};
    return {
      user_id: uc.user_id,
      name: (u as any).name,
      display_id: (u as any).display_id,
      user_card_id: toStr(uc._id),
      copy_id: uc.copy_id,
      obtained_at: uc.obtained_at,
      issue_num: idx + 1,
    };
  });
}

export async function getCardIssueNumber(userCardId: string, cardId: string): Promise<number> {
  const rows = await col("user_cards").find({ card_id: cardId }, { projection: { _id: 1 } }).sort({ _id: 1 }).toArray();
  const idx = rows.findIndex((r) => toStr(r._id) === userCardId);
  return idx >= 0 ? idx + 1 : 1;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Group activity / spawn tracking
// ─────────────────────────────────────────────────────────────────────────────

export async function incrementGroupActivity(groupId: string): Promise<void> {
  const n = now();
  const WINDOW = 20 * 60;
  const group = await getGroup(groupId);
  if (!group) return;
  const windowStart = Number(group.recent_msg_window || 0);
  if (n - windowStart > WINDOW) {
    await col("groups").updateOne({ _id: groupId as any }, { $set: { recent_msg_count: 1, recent_msg_window: n } });
  } else {
    await col("groups").updateOne({ _id: groupId as any }, { $inc: { recent_msg_count: 1 } });
  }
}

export async function getGroupActivity(groupId: string): Promise<{ count: number; percentage: number }> {
  const FULL_ACTIVITY = 2000;
  const WINDOW = 20 * 60;
  const n = now();
  const group = await getGroup(groupId);
  if (!group) return { count: 0, percentage: 0 };
  const windowStart = Number(group.recent_msg_window || 0);
  const count = (n - windowStart <= WINDOW) ? Number(group.recent_msg_count || 0) : 0;
  const percentage = Math.min(100, Math.round((count / FULL_ACTIVITY) * 100));
  return { count, percentage };
}

export async function getTodaySpawnCount(groupId: string): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const group = await getGroup(groupId);
  if (!group) return 0;
  if (group.spawn_date !== today) return 0;
  return Number(group.spawn_count_today || 0);
}

export async function recordSpawnForGroup(groupId: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const group = await getGroup(groupId);
  const currentCount = group?.spawn_date === today ? Number(group.spawn_count_today || 0) : 0;
  await col("groups").updateOne({ _id: groupId as any }, { $set: { spawn_count_today: currentCount + 1, spawn_date: today } });
}

export async function getNextSpawnTime(groupId: string): Promise<number> {
  const group = await getGroup(groupId);
  return Number(group?.next_spawn_time || 0);
}

export async function setNextSpawnTime(groupId: string, time: number): Promise<void> {
  await col("groups").updateOne({ _id: groupId as any }, { $set: { next_spawn_time: time } });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Lottery
// ─────────────────────────────────────────────────────────────────────────────

export async function getActiveLottery(groupId?: string): Promise<any> {
  const query: any = { active: 1 };
  if (groupId) query.group_id = groupId;
  const doc = await col("lotteries").findOne(query, { sort: { created_at: -1 } });
  return doc ? { ...doc, id: toStr(doc._id) } : null;
}

export async function createLottery(groupId?: string): Promise<string> {
  const result = await col("lotteries").insertOne({
    group_id: groupId || null,
    pool: 0,
    active: 1,
    created_at: now(),
  });
  return toStr(result.insertedId);
}

export async function addLotteryEntry(lotteryId: string, userId: string, amount: number): Promise<string> {
  let oid: ObjectId;
  try { oid = new ObjectId(lotteryId); } catch { return ""; }
  const result = await col("lottery_entries").insertOne({
    lottery_id: lotteryId,
    user_id: extractNumberFromJid(userId),
    amount,
    created_at: now(),
  });
  await col("lotteries").updateOne({ _id: oid }, { $inc: { pool: amount } });
  return toStr(result.insertedId);
}

export async function getLotteryEntries(lotteryId: string): Promise<any[]> {
  return col("lottery_entries").find({ lottery_id: lotteryId }).toArray();
}

export async function closeLottery(lotteryId: string, winnerId: string): Promise<void> {
  let oid: ObjectId;
  try { oid = new ObjectId(lotteryId); } catch { return; }
  await col("lotteries").updateOne(
    { _id: oid },
    { $set: { active: 0, winner_id: extractNumberFromJid(winnerId), ended_at: now() } }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  Admin / clear utilities
// ─────────────────────────────────────────────────────────────────────────────

export async function purgeUnregisteredPlayerData(): Promise<void> {
  const unregistered = await col("users").distinct("_id", { $or: [{ registered: 0 }, { registered: { $exists: false } }] });
  if (!unregistered.length) return;

  const unreg = unregistered as string[];

  // Disband guilds owned by unregistered users
  const unregGuilds = await col("guilds").distinct("_id", { owner_id: { $in: unreg } });
  await Promise.all([
    col("guild_members").deleteMany({ guild_id: { $in: unregGuilds } }),
    col("guilds").deleteMany({ _id: { $in: unregGuilds as any[] } }),
    col("guild_members").deleteMany({ user_id: { $in: unreg } }),
    col("user_cards").deleteMany({ user_id: { $in: unreg } }),
    col("card_deck").deleteMany({ user_id: { $in: unreg } }),
    col("deck_backgrounds").deleteMany({ _id: { $in: unreg as any[] } }),
    col("rpg_characters").deleteMany({ _id: { $in: unreg as any[] } }),
    col("inventory").deleteMany({ user_id: { $in: unreg } }),
    col("afk_users").deleteMany({ _id: { $in: unreg as any[] } }),
    col("summer_tokens").deleteMany({ _id: { $in: unreg as any[] } }),
    col("users").deleteMany({ _id: { $in: unreg as any[] } }),
  ]);
}

export async function clearAllPlayerData(): Promise<void> {
  const collections = [
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
  await Promise.all(collections.map((c) => col(c).deleteMany({})));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Frames
// ─────────────────────────────────────────────────────────────────────────────

// Short, human-friendly frame codes (e.g. "fr7k2") — stable once assigned,
// unlike the list-position numbers which shift whenever a frame is added or
// removed. This is what should be shown to users instead of the raw 24-char
// Mongo ObjectId.
function generateFrameCode(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let code = "fr";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export async function getAllFrames(): Promise<any[]> {
  const docs = await col("frames").find({}).sort({ _id: 1 }).project({ image: 0 }).toArray();
  return docs.map((d, i) => ({ ...d, id: toStr(d._id), code: d.code || null, seq: i + 1 }));
}

export async function getFrameById(id: string | number): Promise<any> {
  const idStr = id.toString().trim();

  // Preferred path — short, stable frame code (e.g. "fr7k2").
  if (/^fr[a-z0-9]{4,8}$/i.test(idStr)) {
    const doc = await col("frames").findOne({ code: idStr.toLowerCase() });
    if (doc) return { ...doc, id: toStr(doc._id), seq: 0 };
  }

  // Legacy path — numeric list position, still supported for old links/scripts.
  const num = typeof id === "number" ? id : parseInt(idStr, 10);
  if (!isNaN(num) && num >= 1 && num <= 9999) {
    const frames = await getAllFrames();
    const frame = frames[num - 1];
    if (frame) return frame;
  }

  // Fallback — raw Mongo ObjectId, for any code that still has it stored.
  let oid: ObjectId;
  try { oid = new ObjectId(idStr); } catch { return null; }
  const doc = await col("frames").findOne({ _id: oid });
  return doc ? { ...doc, id: toStr(doc._id), code: doc.code || null, seq: 0 } : null;
}

export async function addFrame(name: string, theme: string, svg: string | null, image: Buffer | null, uploadedBy: string, url?: string): Promise<string> {
  let code = generateFrameCode();
  // Extremely unlikely collision, but guard anyway since code must be unique.
  for (let attempt = 0; attempt < 5; attempt++) {
    const clash = await col("frames").findOne({ code });
    if (!clash) break;
    code = generateFrameCode();
  }
  const result = await col("frames").insertOne({
    name,
    theme,
    svg,
    image: image ? image.toString("base64") : null,
    uploaded_by: uploadedBy,
    url: url || null,
    code,
    created_at: now(),
  });
  return code;
}

export async function equipFrame(userId: string, frameId: string | null): Promise<void> {
  const phone = extractNumberFromJid(userId);
  await col("users").updateOne({ _id: phone as any }, { $set: { frame_id: frameId } });
}

export async function getUserEquippedFrame(userId: string): Promise<any> {
  const phone = extractNumberFromJid(userId);
  const user = await col("users").findOne({ _id: phone as any }, { projection: { frame_id: 1 } });
  if (!user?.frame_id) return null;
  return getFrameById(user.frame_id);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Shoob sync / imported IDs
// ─────────────────────────────────────────────────────────────────────────────

export async function getShoobImportedIds(): Promise<Set<string>> {
  const docs = await col("shoob_imported_ids").find({}, { projection: { _id: 1 } }).toArray();
  return new Set(docs.map((d) => d._id as string));
}

export async function markShoobImported(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const n = now();
  await col("shoob_imported_ids").bulkWrite(
    ids.map((id) => ({
      updateOne: {
        filter: { _id: id as any },
        update: { $setOnInsert: { imported_at: n } },
        upsert: true,
      },
    }))
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  World events (new — RPG living world system)
// ─────────────────────────────────────────────────────────────────────────────

export async function addWorldEvent(event: {
  type: string;
  title: string;
  description: string;
  group_id?: string;
  actor?: string;
  metadata?: Record<string, any>;
}): Promise<string> {
  const result = await col("world_events").insertOne({
    ...event,
    created_at: now(),
    expires_at: now() + 7 * 86400,
  });
  return toStr(result.insertedId);
}

export async function getRecentWorldEvents(groupId?: string, limit = 10): Promise<any[]> {
  const query: any = { expires_at: { $gt: now() } };
  if (groupId) query.group_id = { $in: [groupId, null, undefined] };
  const docs = await col("world_events").find(query).sort({ created_at: -1 }).limit(limit).toArray();
  return docs.map((d) => ({ ...d, id: toStr(d._id) }));
}

export async function addWorldHistory(entry: {
  title: string;
  actor: string;
  actor_name: string;
  group_id?: string;
  category: string;
}): Promise<void> {
  await col("world_history").insertOne({ ...entry, created_at: now() });
}

export async function getWorldHistory(groupId?: string, limit = 20): Promise<any[]> {
  const query: any = groupId ? { $or: [{ group_id: groupId }, { group_id: null }] } : {};
  const docs = await col("world_history").find(query).sort({ created_at: -1 }).limit(limit).toArray();
  return docs.map((d) => ({ ...d, id: toStr(d._id) }));
}

export async function addRumor(rumor: { text: string; credibility: string; group_id?: string }): Promise<void> {
  await col("rumors").insertOne({
    ...rumor,
    verified: false,
    created_at: now(),
    expires_at: now() + 72 * 3600,
  });
}

export async function getActiveRumors(groupId?: string, limit = 5): Promise<any[]> {
  const query: any = { expires_at: { $gt: now() } };
  if (groupId) query.group_id = { $in: [groupId, null, undefined] };
  const docs = await col("rumors").find(query).sort({ created_at: -1 }).limit(limit).toArray();
  return docs.map((d) => ({ ...d, id: toStr(d._id) }));
}

// ── Territory Control (Atlas) ──────────────────────────────────────────────
// Territory geography (which region it's in, base resource, map position) is
// static — see bot/atlas.ts. What's stored here is purely the live state:
// who controls it right now, and the guild-set tax rate. This is what makes
// the world map a live representation of database state instead of static
// lore — the same document this reads is what a guild changes when it
// claims a territory through the bot.

export interface TerritoryState {
  territory_id: string;     // matches TerritoryDef.id from atlas.ts
  guild_id: string | null;  // real _id from the guilds collection, or null if unclaimed
  claimed_at: number;
  tax_rate: number;         // 0-50 (%), guild-set, affects member income from this territory
  danger_level: number;     // 1-10, rises over time if uncontested/unguarded
}

export async function getTerritoryState(territoryId: string): Promise<TerritoryState | null> {
  const doc = await col("territory_state").findOne({ territory_id: territoryId });
  return doc ? (doc as unknown as TerritoryState) : null;
}

/** All territory ownership records — this is the live data the world map reads. */
export async function getAllTerritoryState(): Promise<TerritoryState[]> {
  const docs = await col("territory_state").find({}).toArray();
  return docs as unknown as TerritoryState[];
}

/** Every territory currently owned by a specific guild. */
export async function getGuildTerritories(guildId: string): Promise<TerritoryState[]> {
  const docs = await col("territory_state").find({ guild_id: guildId }).toArray();
  return docs as unknown as TerritoryState[];
}

/**
 * Claim or contest a territory for a guild. Returns the outcome so the
 * calling command can report it to the player — this function does not
 * itself touch gold/cooldowns; the command layer is responsible for
 * checking and deducting those before calling this.
 */
export async function claimTerritory(
  territoryId: string,
  guildId: string,
  guildName: string,
  claimantUserId: string,
  claimantName: string
): Promise<{ outcome: "claimed" | "taken_over"; previousGuildId: string | null }> {
  const existing = await getTerritoryState(territoryId);
  const previousGuildId = existing?.guild_id ?? null;

  await col("territory_state").updateOne(
    { territory_id: territoryId },
    {
      $set: {
        territory_id: territoryId,
        guild_id: guildId,
        claimed_at: now(),
        danger_level: 1,
      },
      $setOnInsert: { tax_rate: 10 },
    },
    { upsert: true }
  );

  const outcome = previousGuildId && previousGuildId !== guildId ? "taken_over" : "claimed";

  await addWorldHistory({
    title: outcome === "taken_over"
      ? `${guildName} seized a territory from a rival guild`
      : `${guildName} claimed a new territory`,
    actor: claimantUserId,
    actor_name: claimantName,
    category: "territory",
  });

  return { outcome, previousGuildId };
}

export async function setTerritoryTaxRate(territoryId: string, guildId: string, taxRate: number): Promise<boolean> {
  const clamped = Math.max(0, Math.min(50, Math.round(taxRate)));
  const result = await col("territory_state").updateOne(
    { territory_id: territoryId, guild_id: guildId },
    { $set: { tax_rate: clamped } }
  );
  return result.matchedCount > 0;
}

/**
 * Legacy compatibility shim for the old free-text territory display the
 * .rpg dashboard used before real guild ownership existed. New code should
 * use getAllTerritoryState / getTerritoryState directly, which carry a real
 * guild_id instead of a plain string.
 */
export async function getTerritoryControl(groupId?: string): Promise<any[]> {
  const states = await getAllTerritoryState();
  if (states.length === 0) return [];
  const guildIds = [...new Set(states.map((s) => s.guild_id).filter(Boolean))] as string[];
  const guilds = guildIds.length
    ? await col("guilds").find({ _id: { $in: guildIds as any[] } }).toArray()
    : [];
  const guildNameById = new Map(guilds.map((g: any) => [toStr(g._id), g.name]));
  return states.map((s) => ({
    name: s.territory_id,
    controller: s.guild_id ? guildNameById.get(s.guild_id) || "Unknown Guild" : null,
    controlled_at: s.claimed_at,
  }));
}

// ── Achievement System ─────────────────────────────────────────────────────

export async function grantAchievement(
  userId: string,
  key: string,
  name: string,
  description: string,
  icon: string
): Promise<boolean> {
  const phone = userId.split("@")[0].split(":")[0].replace(/\D/g, "") || userId;
  const existing = await col("achievements").findOne({ user_id: phone, key });
  if (existing) return false;
  await col("achievements").insertOne({
    user_id: phone,
    key, name, description, icon,
    granted_at: now(),
  });
  return true;
}

export async function getUserAchievements(userId: string): Promise<any[]> {
  const phone = userId.split("@")[0].split(":")[0].replace(/\D/g, "") || userId;
  const docs = await col("achievements").find({ user_id: phone }).sort({ granted_at: -1 }).toArray();
  return docs.map((d) => ({ ...d, id: toStr(d._id) }));
}

export async function countUserAchievements(userId: string): Promise<number> {
  const phone = userId.split("@")[0].split(":")[0].replace(/\D/g, "") || userId;
  return col("achievements").countDocuments({ user_id: phone });
}

export async function getLastRpgVisit(userId: string): Promise<number> {
  const phone = userId.split("@")[0].split(":")[0].replace(/\D/g, "") || userId;
  const doc = await col("rpg_visits").findOne({ user_id: phone });
  return doc?.visited_at ?? 0;
}

export async function setLastRpgVisit(userId: string): Promise<void> {
  const phone = userId.split("@")[0].split(":")[0].replace(/\D/g, "") || userId;
  await col("rpg_visits").updateOne(
    { user_id: phone },
    { $set: { user_id: phone, visited_at: now() } },
    { upsert: true }
  );
}

export async function getQuestCount(userId: string): Promise<number> {
  const phone = userId.split("@")[0].split(":")[0].replace(/\D/g, "") || userId;
  const doc = await col("rpg").findOne({ id: phone });
  return doc?.total_quests ?? 0;
}

export async function incrementQuestCount(userId: string): Promise<number> {
  const phone = userId.split("@")[0].split(":")[0].replace(/\D/g, "") || userId;
  const res = await col("rpg").findOneAndUpdate(
    { id: phone },
    { $inc: { total_quests: 1 } },
    { returnDocument: "after", upsert: false }
  );
  return res?.total_quests ?? 0;
}

export async function getRaidCount(userId: string): Promise<number> {
  const phone = userId.split("@")[0].split(":")[0].replace(/\D/g, "") || userId;
  const doc = await col("rpg").findOne({ id: phone });
  return doc?.total_raids ?? 0;
}

export async function incrementRaidCount(userId: string): Promise<number> {
  const phone = userId.split("@")[0].split(":")[0].replace(/\D/g, "") || userId;
  const res = await col("rpg").findOneAndUpdate(
    { id: phone },
    { $inc: { total_raids: 1 } },
    { returnDocument: "after", upsert: false }
  );
  return res?.total_raids ?? 0;
}
