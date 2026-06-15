import type { WASocket } from "@whiskeysockets/baileys";
import {
  getAllCards, getActiveSpawn, getActiveSpawnByToken, claimSpawn, spawnCardInGroup, giveCard, getCard,
  ensureUser, getUser, getGroup, ensureGroup, getUserCards,
  getTodaySpawnCount, recordSpawnForGroup, getNextSpawnTime, setNextSpawnTime,
  getGroupActivity, getLastSpawnedCardId, getRecentSpawnedCardIds, recordRecentSpawnedCard, getCardOwnerCount,
} from "../db/queries.js";
import { sendText, sendImage } from "../connection.js";
import { getTierEmoji, getWeightedRandomCard, formatNumber, VIDEO_TIERS } from "../utils.js";
import { logger } from "../../lib/logger.js";
import sharp from "sharp";

const MAX_SPAWNS_PER_DAY = 6;
const SPAWN_MIN_SECS = 3600;
const SPAWN_MAX_SECS = 28800;
const ACTIVITY_REQUIRED = 30;

const TIER_PRICES: Record<string, number> = {
  T1: 500, T2: 1000, T3: 2500, T4: 5000, T5: 10000, T6: 15000, TS: 25000, TX: 50000, TZ: 100000,
};

function randomSpawnDelay(): number {
  return SPAWN_MIN_SECS + Math.floor(Math.random() * (SPAWN_MAX_SECS - SPAWN_MIN_SECS));
}

export async function checkAutoSpawn(sock: WASocket, groupId: string): Promise<void> {
  try {
    ensureGroup(groupId);
    const group = getGroup(groupId);
    if (!group) return;

    if ((group.cards_enabled || "on") !== "on") return;
    if ((group.spawn_enabled || "on") !== "on") return;

    const now = Math.floor(Date.now() / 1000);
    let nextSpawn = getNextSpawnTime(groupId);

    if (nextSpawn === 0) {
      const delay = randomSpawnDelay();
      setNextSpawnTime(groupId, now + delay);
      return;
    }

    if (now < nextSpawn) return;

    const activity = getGroupActivity(groupId);
    if (activity.percentage < ACTIVITY_REQUIRED) {
      setNextSpawnTime(groupId, now + randomSpawnDelay());
      return;
    }

    const todayCount = getTodaySpawnCount(groupId);
    if (todayCount >= MAX_SPAWNS_PER_DAY) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);
      setNextSpawnTime(groupId, Math.floor(tomorrow.getTime() / 1000) + SPAWN_MIN_SECS + Math.floor(Math.random() * 14400));
      return;
    }

    setNextSpawnTime(groupId, now + randomSpawnDelay());
    await spawnCard(sock, groupId);
  } catch (err) {
    logger.error({ err }, "Error in checkAutoSpawn");
  }
}

const HIGH_TIER_MAX_ISSUES = 3;
const NORMAL_MAX_ISSUES = 2;

function getMaxIssues(tier: string): number {
  // TX and TZ are ultra-rare — only 1 copy can ever exist.
  if (tier === "TX" || tier === "TZ") return 1;
  // T5, T6, and TS are high-tier — allow up to 3 copies.
  if (tier === "T5" || tier === "T6" || tier === "TS") return HIGH_TIER_MAX_ISSUES;
  return NORMAL_MAX_ISSUES;
}

export async function spawnCard(sock: WASocket, groupId: string, specific?: string): Promise<void> {
  const existing = getActiveSpawn(groupId);
  if (existing) return;

  const allCards = getAllCards();
  if (allCards.length === 0) {
    logger.warn({ groupId }, "Cannot spawn card — database is empty. Run bot startup or trigger card loader.");
    return;
  }

  let card: any;
  if (specific) {
    card = allCards.find((c) => c.id === specific) || getWeightedRandomCard(allCards);
  } else {
    const recentIds = getRecentSpawnedCardIds(groupId);
    const nonRecentCards = allCards.filter((c) => !recentIds.includes(c.id));
    const pool = nonRecentCards.length > 0 ? nonRecentCards : allCards;
    card = getWeightedRandomCard(pool);
  }
  if (!card) return;

  const maxIssues = getMaxIssues(card.tier);
  const ownerCount = getCardOwnerCount(card.id);
  const issueNum = ownerCount + 1;

  if (issueNum > maxIssues) {
    const fallbackPool = allCards.filter((c) => getCardOwnerCount(c.id) < getMaxIssues(c.tier));
    if (fallbackPool.length === 0) return;
    card = getWeightedRandomCard(fallbackPool);
    if (!card) return;
  }

  const currentIssue = getCardOwnerCount(card.id) + 1;
  const maxIssuesFinal = getMaxIssues(card.tier);

  // Generate unique lowercase alphanumeric claim code (6 chars)
  const claimChars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const token = Array.from({ length: 6 }, () => claimChars[Math.floor(Math.random() * claimChars.length)]).join("");

  spawnCardInGroup(groupId, card.id, token);
  recordSpawnForGroup(groupId);
  recordRecentSpawnedCard(groupId, card.id);

  const tierPrice = TIER_PRICES[card.tier] || 500;

  const caption =
    `✨ *A card has appeared!*\n\n` +
    `*🎴 Name:* ${card.name}\n` +
    `*🃏 Series:* ${card.series || "General"}\n` +
    `*⭐ Tier:* ${card.tier}\n` +
    `*📋 Issue:* ${currentIssue}\n` +
    `*🏷️ Price:* $${formatNumber(tierPrice)}\n\n` +
    `> Type \`.claim ${token}\` to claim!`;

  try {
    const buf = await getCardImageBuffer(card);
    if (VIDEO_TIERS.has(card.tier)) {
      const { getAnySock } = await import("../connection.js");
      const activeSock = getAnySock();
      if (activeSock) {
        await activeSock.sendMessage(groupId, { video: buf, gifPlayback: true, mimetype: "video/mp4", caption });
      } else {
        await sendImage(groupId, buf, caption);
      }
    } else {
      await sendImage(groupId, buf, caption);
    }
    logger.info({ cardId: card.id, cardName: card.name, tier: card.tier, groupId }, "Card spawned successfully");
  } catch (err) {
    logger.error({ err, cardId: card.id, cardName: card.name }, "Error spawning card image — using placeholder");
    const fallback = await makeCardPlaceholder(card);
    await sendImage(groupId, fallback, caption);
  }
}

export async function handleGetCard(
  sock: WASocket,
  groupId: string,
  senderId: string,
  cardId: string
): Promise<void> {
  const spawn = getActiveSpawnByToken(groupId, cardId);
  if (!spawn) {
    const anySpawn = getActiveSpawn(groupId);
    if (!anySpawn) {
      await sendText(groupId, "❌ There's no active card spawn right now.");
    } else {
      await sendText(groupId, "❌ Wrong card ID. Check the spawn message for the correct code!");
    }
    return;
  }

  ensureUser(senderId);

  const alreadyOwned = getUserCards(senderId).some((c: any) => c.id === spawn.card_id);
  if (alreadyOwned) {
    await sendText(groupId, "❌ You already own this card! Each card can only be claimed once per user.");
    return;
  }

  const card = getCard(spawn.card_id);
  const maxIssues = getMaxIssues(card?.tier || "T1");
  const currentOwners = getCardOwnerCount(spawn.card_id);

  if (currentOwners >= maxIssues) {
    await sendText(groupId, `❌ This card has reached its maximum issues (${maxIssues}/${maxIssues}).`);
    return;
  }

  claimSpawn(spawn.id, senderId);
  giveCard(senderId, spawn.card_id);

  const issueNum = currentOwners + 1;
  const tierPrice = TIER_PRICES[card?.tier] || 500;

  // Strip both the @server suffix and any :device suffix so the display
  // is the plain phone number (e.g. 2547xxx, not 2547xxx:3).
  const senderDisplay = senderId.split("@")[0].split(":")[0];
  await sendText(
    groupId,
    `🎉 @${senderDisplay} claimed the card!\n\n` +
    `*🎴 Name:* ${card?.name || spawn.card_id}\n` +
    `*⭐ Tier:* ${card?.tier || "T?"}\n` +
    `*📋 Issue:* #${issueNum}\n` +
    `*🏷️ Price:* $${formatNumber(tierPrice)}`,
    [senderId]
  );
  logger.info({ userId: senderId, cardId: spawn.card_id, cardName: card?.name }, "Card claimed successfully");
}

async function getCardImageBuffer(card: any): Promise<Buffer> {
  // 1. Stored blob (custom uploaded cards)
  if (card.image_data) {
    return Buffer.isBuffer(card.image_data) ? card.image_data : Buffer.from(card.image_data);
  }
  
  // 2. media_url direct OR inside raw_data JSON (scraped cards from cards.json)
  let mediaUrl: string | null = card.media_url || null;
  if (!mediaUrl && card.raw_data) {
    try {
      const raw = typeof card.raw_data === "string" ? JSON.parse(card.raw_data) : card.raw_data;
      mediaUrl = raw?.media_url || null;
    } catch (e) {
      logger.debug({ err: e, cardId: card.id }, "Failed to parse raw_data JSON");
    }
  }
  
  // 3. Build CDN URL from shoob_id as final fallback
  if (!mediaUrl && card.shoob_id) {
    const hasWebm = card.has_webm === 1 || card.has_webm === true;
    mediaUrl = hasWebm
      ? `https://api.shoob.gg/site/api/cardr/${card.shoob_id}?type=webm`
      : `https://api.shoob.gg/site/api/cardr/${card.shoob_id}?size=400`;
  }
  
  if (mediaUrl) {
    try {
      logger.debug({ cardId: card.id, mediaUrl }, "Fetching card image from CDN");
      const res = await fetch(mediaUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        signal: AbortSignal.timeout(12000),
      });
      if (res.ok) {
        const contentType = res.headers.get("content-type") || "";
        const buf = Buffer.from(await res.arrayBuffer());
        logger.debug({ cardId: card.id, size: buf.length, contentType }, "Successfully fetched card image");
        if (contentType.includes("gif") || contentType.includes("webm") || contentType.includes("video")) {
          return buf;
        }
        return sharp(buf).jpeg({ quality: 88 }).toBuffer();
      } else {
        logger.warn({ cardId: card.id, status: res.status, mediaUrl }, "CDN returned non-OK response");
      }
    } catch (err) {
      logger.warn({ err, cardId: card.id, mediaUrl }, "Failed to fetch card image from CDN");
    }
  } else {
    logger.debug({ cardId: card.id, hasImageData: !!card.image_data, hasShoobId: !!card.shoob_id }, "No media URL available");
  }
  
  logger.info({ cardId: card.id }, "Generating placeholder for card (no image available)");
  return makeCardPlaceholder(card);
}

async function makeCardPlaceholder(card: any): Promise<Buffer> {
  const name = escapeSvg(card.name || "Unknown Card");
  const series = escapeSvg(card.series || "General");
  const tier = escapeSvg(card.tier || "T?");
  const svg = `<svg width="900" height="1260" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#111827"/>
        <stop offset="55%" stop-color="#312e81"/>
        <stop offset="100%" stop-color="#020617"/>
      </linearGradient>
    </defs>
    <rect width="900" height="1260" rx="42" fill="url(#bg)"/>
    <rect x="54" y="54" width="792" height="1152" rx="32" fill="none" stroke="#eab308" stroke-width="10"/>
    <text x="450" y="210" fill="#f8fafc" font-size="64" font-family="Arial" font-weight="700" text-anchor="middle">ALPHA CARD</text>
    <text x="450" y="560" fill="#fde68a" font-size="82" font-family="Arial" font-weight="700" text-anchor="middle">${name}</text>
    <text x="450" y="680" fill="#dbeafe" font-size="48" font-family="Arial" text-anchor="middle">${series}</text>
    <text x="450" y="930" fill="#f8fafc" font-size="72" font-family="Arial" font-weight="700" text-anchor="middle">${tier}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function escapeSvg(value: string): string {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[ch]!));
}
