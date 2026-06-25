import type { WASocket } from "@whiskeysockets/baileys";
import {
  getAllCards, getActiveSpawn, getActiveSpawnByToken, claimSpawn, spawnCardInGroup, giveCard, getCard,
  ensureUser, getUser, updateUser, getGroup, ensureGroup, getUserCards,
  getTodaySpawnCount, recordSpawnForGroup, getNextSpawnTime, setNextSpawnTime,
  getGroupActivity, getLastSpawnedCardId, getRecentSpawnedCardIds, recordRecentSpawnedCard, getCardOwnerCount,
} from "../db/queries.js";
import { sendText, sendImage } from "../connection.js";
import { getTierEmoji, getWeightedRandomCard, formatNumber, VIDEO_TIERS, isGifBuffer } from "../utils.js";
import { logger } from "../../lib/logger.js";
import sharp from "sharp";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);

async function ensureMp4(buf: Buffer, cardId?: string | number): Promise<Buffer> {
  const isMp4 = buf.length > 8 && buf.slice(4, 8).toString("ascii") === "ftyp";
  if (isMp4) return buf;

  const isGif = isGifBuffer(buf);
  const inExt = isGif ? "gif" : "webm";
  const uid = cardId ?? randomUUID();
  const inPath  = `${tmpdir()}/card_${uid}_in.${inExt}`;
  const outPath = `${tmpdir()}/card_${uid}_out.mp4`;

  try {
    await writeFile(inPath, buf);
    const gifArgs = isGif ? ["-r", "15"] : [];
    await execFileAsync("ffmpeg", [
      "-y", "-i", inPath,
      ...gifArgs,
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-c:v", "libx264", "-preset", "fast", "-crf", "28",
      "-movflags", "+faststart",
      "-an",
      outPath,
    ], { timeout: 60_000 });
    const mp4 = await readFile(outPath);
    return mp4;
  } catch (err) {
    logger.warn({ err, cardId }, "ensureMp4: ffmpeg conversion failed, sending original buffer");
    return buf;
  } finally {
    await unlink(inPath).catch(() => {});
    await unlink(outPath).catch(() => {});
  }
}

const MAX_SPAWNS_PER_DAY = 5;
const SPAWN_MIN_SECS = 3600;
const SPAWN_MAX_SECS = 28800;
const ACTIVITY_REQUIRED = 30;
const CARD_EXPIRY_MIN_SECS = 240;
const CARD_EXPIRY_MAX_SECS = 300;

const TIER_PRICES: Record<string, number> = {
  T1: 3500, T2: 12000, T3: 27500, T4: 52500, T5: 62500, T6: 112000, TS: 250000, TX: 350000, TZ: 500000,
};

function randomSpawnDelay(): number {
  return SPAWN_MIN_SECS + Math.floor(Math.random() * (SPAWN_MAX_SECS - SPAWN_MIN_SECS));
}

export async function checkAutoSpawn(sock: WASocket, groupId: string): Promise<void> {
  try {
    await ensureGroup(groupId);
    const group = await getGroup(groupId);
    if (!group) return;

    if ((group.cards_enabled || "on") !== "on") return;
    if ((group.spawn_enabled || "on") !== "on") return;

    const now = Math.floor(Date.now() / 1000);
    let nextSpawn = await getNextSpawnTime(groupId);

    if (nextSpawn === 0) {
      const delay = randomSpawnDelay();
      await setNextSpawnTime(groupId, now + delay);
      return;
    }

    if (now < nextSpawn) return;

    const activity = await getGroupActivity(groupId);
    if (activity.percentage < ACTIVITY_REQUIRED) {
      await setNextSpawnTime(groupId, now + randomSpawnDelay());
      return;
    }

    const todayCount = await getTodaySpawnCount(groupId);
    if (todayCount >= MAX_SPAWNS_PER_DAY) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);
      await setNextSpawnTime(groupId, Math.floor(tomorrow.getTime() / 1000) + SPAWN_MIN_SECS + Math.floor(Math.random() * 14400));
      return;
    }

    await setNextSpawnTime(groupId, now + randomSpawnDelay());
    await spawnCard(sock, groupId);
  } catch (err) {
    logger.error({ err }, "Error in checkAutoSpawn");
  }
}

const HIGH_TIER_MAX_ISSUES = 3;
const NORMAL_MAX_ISSUES = 2;

function getMaxIssues(tier: string): number {
  if (tier === "TX" || tier === "TZ") return 1;
  if (tier === "T5" || tier === "T6" || tier === "TS") return HIGH_TIER_MAX_ISSUES;
  return NORMAL_MAX_ISSUES;
}

export async function spawnCard(sock: WASocket, groupId: string, specific?: string): Promise<void> {
  const existing = await getActiveSpawn(groupId);
  if (existing) return;

  const allCards = await getAllCards();
  if (allCards.length === 0) {
    logger.warn({ groupId }, "Cannot spawn card — database is empty.");
    return;
  }

  let card: any;
  if (specific) {
    card = allCards.find((c) => String(c.id) === String(specific));
    if (!card) card = getWeightedRandomCard(allCards);
  } else {
    const recentIds = await getRecentSpawnedCardIds(groupId);
    const spawnableCards = allCards.filter((c) => c.tier !== "TX" && c.tier !== "TZ");
    const nonRecentCards = spawnableCards.filter((c) => !recentIds.includes(c.id));
    const pool = nonRecentCards.length > 0 ? nonRecentCards : spawnableCards;
    card = getWeightedRandomCard(pool);
  }
  if (!card) return;

  const maxIssues = getMaxIssues(card.tier);
  const ownerCount = await getCardOwnerCount(card.id);
  const issueNum = ownerCount + 1;

  if (issueNum > maxIssues) {
    const eligibleCards = allCards.filter((c) => c.tier !== "TX" && c.tier !== "TZ");
    const ownerCounts = await Promise.all(eligibleCards.map((c) => getCardOwnerCount(c.id)));
    const fallbackPool = eligibleCards.filter((c, i) => ownerCounts[i] < getMaxIssues(c.tier));
    if (fallbackPool.length === 0) return;
    card = getWeightedRandomCard(fallbackPool);
    if (!card) return;
  }

  const currentIssue = (await getCardOwnerCount(card.id)) + 1;
  const maxIssuesFinal = getMaxIssues(card.tier);

  const claimChars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const token = Array.from({ length: 6 }, () => claimChars[Math.floor(Math.random() * claimChars.length)]).join("");

  const expiryOffset = CARD_EXPIRY_MIN_SECS + Math.floor(Math.random() * (CARD_EXPIRY_MAX_SECS - CARD_EXPIRY_MIN_SECS));
  const expiresAt = Math.floor(Date.now() / 1000) + expiryOffset;
  const expiryMins = Math.ceil(expiryOffset / 60);

  await spawnCardInGroup(groupId, card.id, token, undefined, expiresAt);
  await recordSpawnForGroup(groupId);
  await recordRecentSpawnedCard(groupId, card.id);

  const tierPrice = TIER_PRICES[card.tier] || 500;

  const caption =
    `✨ *A card has appeared!*\n\n` +
    `*🎴 Name:* ${card.name}\n` +
    `*🃏 Series:* ${card.series || "General"}\n` +
    `*⭐ Tier:* ${card.tier}\n` +
    `*📋 Issue:* ${currentIssue}\n` +
    `*🏷️ Price:* $${formatNumber(tierPrice)}\n\n` +
    `> Type \`.claim ${token}\` to claim!\n` +
    `> ⏳ Expires in *${expiryMins} minutes* — claim fast!`;

  try {
    if (VIDEO_TIERS.has(card.tier)) {
      const { getAnySock } = await import("../connection.js");
      const activeSock = getAnySock();
      if (!activeSock) {
        const buf = await getCardImageBuffer(card);
        await sendImage(groupId, buf, caption);
      } else if (!card.image_data) {
        let mediaUrl: string | null = card.media_url || null;
        if (!mediaUrl && card.raw_data) {
          try {
            const raw = typeof card.raw_data === "string" ? JSON.parse(card.raw_data) : card.raw_data;
            mediaUrl = raw?.media_url || null;
          } catch {}
        }
        if (!mediaUrl && card.shoob_id) {
          const hasWebm = card.has_webm === 1 || card.has_webm === true;
          mediaUrl = hasWebm
            ? `https://api.shoob.gg/site/api/cardr/${card.shoob_id}?type=webm`
            : `https://api.shoob.gg/site/api/cardr/${card.shoob_id}?size=400`;
        }
        if (mediaUrl) {
          const hasWebm = card.has_webm === 1 || card.has_webm === true;
          if (hasWebm) {
            try {
              const res = await fetch(mediaUrl, {
                headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
                signal: AbortSignal.timeout(20000),
              });
              const buf = res.ok ? Buffer.from(await res.arrayBuffer()) : await getCardImageBuffer(card);
              const mp4Buf = await ensureMp4(buf, card.id);
              await activeSock.sendMessage(groupId, { video: mp4Buf, gifPlayback: true, mimetype: "video/mp4", caption });
            } catch {
              const buf = await getCardImageBuffer(card);
              const mp4Buf = await ensureMp4(buf, card.id);
              await activeSock.sendMessage(groupId, { video: mp4Buf, gifPlayback: true, mimetype: "video/mp4", caption });
            }
          } else {
            try {
              const res = await fetch(mediaUrl, {
                headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
                signal: AbortSignal.timeout(20000),
              });
              const buf = res.ok ? Buffer.from(await res.arrayBuffer()) : await getCardImageBuffer(card);
              const mp4Buf = await ensureMp4(buf, card.id);
              await activeSock.sendMessage(groupId, { video: mp4Buf, gifPlayback: true, mimetype: "video/mp4", caption });
            } catch {
              const buf = await getCardImageBuffer(card);
              const mp4Buf = await ensureMp4(buf, card.id);
              await activeSock.sendMessage(groupId, { video: mp4Buf, gifPlayback: true, mimetype: "video/mp4", caption });
            }
          }
        } else {
          const buf = await getCardImageBuffer(card);
          const mp4Buf = await ensureMp4(buf, card.id);
          await activeSock.sendMessage(groupId, { video: mp4Buf, gifPlayback: true, mimetype: "video/mp4", caption });
        }
      } else {
        const buf = await getCardImageBuffer(card);
        const mp4Buf = await ensureMp4(buf, card.id);
        await activeSock.sendMessage(groupId, { video: mp4Buf, gifPlayback: true, mimetype: "video/mp4", caption });
      }
    } else {
      const buf = await getCardImageBuffer(card);
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
  const spawn = await getActiveSpawnByToken(groupId, cardId);
  if (!spawn) {
    const anySpawn = await getActiveSpawn(groupId);
    if (!anySpawn) {
      await sendText(groupId, "❌ There's no active card spawn right now.");
    } else {
      await sendText(groupId, "❌ Wrong card ID. Check the spawn message for the correct code!");
    }
    return;
  }

  await ensureUser(senderId);

  const userCards = await getUserCards(senderId);
  const alreadyOwned = userCards.some((c: any) => c.id === spawn.card_id);
  if (alreadyOwned) {
    await sendText(groupId, "❌ You already own this card! Each card can only be claimed once per user.");
    return;
  }

  const card = await getCard(spawn.card_id);
  const maxIssues = getMaxIssues(card?.tier || "T1");
  const currentOwners = await getCardOwnerCount(spawn.card_id);

  if (currentOwners >= maxIssues) {
    await sendText(groupId, `❌ This card has reached its maximum issues (${maxIssues}/${maxIssues}).`);
    return;
  }

  const tierPrice = TIER_PRICES[card?.tier || "T1"] || 500;
  const claimerUser = await getUser(senderId);
  const claimerBalance = claimerUser?.balance ?? 0;
  if (claimerBalance < tierPrice) {
    await sendText(groupId,
      `❌ Not enough coins to claim *${card?.name || "this card"}* (${card?.tier || "T?"}).\n\n` +
      `💰 Cost: $${formatNumber(tierPrice)}\n` +
      `👛 Your balance: $${formatNumber(claimerBalance)}\n\n` +
      `_Earn more coins with .daily, .work, .adventure, or dungeon runs._`
    );
    return;
  }

  await claimSpawn(spawn.id, senderId);
  await giveCard(senderId, spawn.card_id);
  void updateUser(senderId, { balance: claimerBalance - tierPrice });

  const issueNum = currentOwners + 1;
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
  if (card.image_data) {
    return Buffer.isBuffer(card.image_data) ? card.image_data : Buffer.from(card.image_data);
  }
  
  let mediaUrl: string | null = card.media_url || null;
  if (!mediaUrl && card.raw_data) {
    try {
      const raw = typeof card.raw_data === "string" ? JSON.parse(card.raw_data) : card.raw_data;
      mediaUrl = raw?.media_url || null;
    } catch (e) {
      logger.debug({ err: e, cardId: card.id }, "Failed to parse raw_data JSON");
    }
  }
  
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
        if (
          contentType.includes("gif") || contentType.includes("webm") ||
          contentType.includes("video") || isGifBuffer(buf)
        ) {
          return buf;
        }
        return sharp(buf).jpeg({ quality: 88 }).toBuffer();
      } else {
        logger.warn({ cardId: card.id, status: res.status, mediaUrl }, "CDN returned non-OK response");
      }
    } catch (err) {
      logger.warn({ err, cardId: card.id, mediaUrl }, "Failed to fetch card image from CDN");
    }
  }
  
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
