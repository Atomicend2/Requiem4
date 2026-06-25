import { randomBytes } from "crypto";

export function generateId(length = 5): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  const bytes = randomBytes(length);
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

export function generateUniqueCardId(existingIds: Set<string>): string {
  let id = generateId(5);
  while (existingIds.has(id)) {
    id = generateId(5);
  }
  return id;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatNumber(n: number): string {
  return n.toLocaleString();
}

export function timeAgo(timestamp: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - timestamp;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function parseJid(jid: string): string {
  return jid.split(":")[0].split("@")[0];
}

export function getTierEmoji(tier: string): string {
  const map: Record<string, string> = {
    T1: "⚪",
    T2: "🟢",
    T3: "🔵",
    T4: "🟣",
    T5: "🔴",
    T6: "🌀",
    TS: "⭐",
    TX: "💎",
    TZ: "🔱",
  };
  return map[tier] || "❓";
}

/**
 * Returns a small badge emoji for event cards based on their event_name.
 * Falls back to a generic 🎉 if the event isn't recognized.
 * Pass card.event_name (e.g. "christmas", "halloween") — case-insensitive.
 */
export function getEventEmoji(eventName: string | null | undefined): string {
  if (!eventName) return "";
  const map: Record<string, string> = {
    christmas: "🎄",
    xmas: "🎄",
    halloween: "🎃",
    easter: "🐰",
    valentine: "💘",
    summer: "☀️",
    winter: "❄️",
    "new year": "🎆",
    newyear: "🎆",
    anniversary: "🎂",
    lunar: "🧧",
  };
  return map[eventName.toLowerCase().trim()] || "🎉";
}

/**
 * Builds the display label for a card, e.g. "⭐🎃 Rem (Halloween)".
 * Use this anywhere a card name is rendered to players.
 */
export function getCardDisplayLabel(card: { name: string; tier: string; is_event?: number | boolean; event_name?: string | null }): string {
  const tierEmoji = getTierEmoji(card.tier);
  if (!card.is_event) return `${tierEmoji} ${card.name}`;
  const eventEmoji = getEventEmoji(card.event_name);
  const eventTag = card.event_name ? ` (${card.event_name})` : "";
  return `${tierEmoji}${eventEmoji} ${card.name}${eventTag}`;
}

export function getTierValue(tier: string): number {
  const map: Record<string, number> = {
    T1: 1,
    T2: 2,
    T3: 3,
    T4: 4,
    T5: 5,
    T6: 6,
    TS: 7,
    TX: 8,
    TZ: 9,
  };
  return map[tier] || 0;
}

export const IMAGE_TIERS = new Set(["T1", "T2", "T3", "T4", "T5"]);
export const VIDEO_TIERS = new Set(["T6", "TS", "TX", "TZ"]);

export function getRandomCard(cards: any[]): any {
  if (cards.length === 0) return null;
  return cards[Math.floor(Math.random() * cards.length)];
}

export function getWeightedRandomCard(cards: any[]): any {
  if (cards.length === 0) return null;

  // TX and TZ can NEVER spawn — they are summon-only.
  // Event cards (is_event: 1) can NEVER spawn normally either — they only come from event games.
  const spawnableCards = cards.filter(
    (c) => c.tier !== "TX" && c.tier !== "TZ" && c.is_event !== 1 && c.is_event !== true
  );
  if (spawnableCards.length === 0) return null;

  // Rarity weights (higher = more common):
  // TS & T6: both very very rare (blue moon tier) — TS slightly rarer than T6
  // T5: rare, but noticeably more common than T6
  // T4 and below: normal spawn pool
  const weights: Record<string, number> = {
    T1: 400, T2: 200, T3: 100, T4: 40, T5: 10, T6: 2, TS: 1,
  };

  let totalWeight = 0;
  const cardWeights = spawnableCards.map((c) => {
    const w = weights[c.tier] ?? 10;
    totalWeight += w;
    return { card: c, w };
  });

  let rand = Math.random() * totalWeight;
  for (const { card, w } of cardWeights) {
    rand -= w;
    if (rand <= 0) return card;
  }
  return spawnableCards[spawnableCards.length - 1];
}

export function coinFlip(): "heads" | "tails" {
  return Math.random() < 0.5 ? "heads" : "tails";
}

export function rollDice(): number {
  return Math.floor(Math.random() * 6) + 1;
}

export function spin(): string {
  const symbols = ["🍒", "🍋", "🍊", "🍇", "⭐", "💎", "7️⃣"];
  const result = Array.from({ length: 3 }, () => symbols[Math.floor(Math.random() * symbols.length)]);
  return result.join(" | ");
}

export function checkSlotWin(result: string): number {
  const parts = result.split(" | ");
  if (parts[0] === parts[1] && parts[1] === parts[2]) {
    return 3;
  }
  if (parts[0] === parts[1] || parts[1] === parts[2] || parts[0] === parts[2]) {
    return 2;
  }
  return -1;
}

export function getRouletteColor(number: number): string {
  if (number === 0) return "green";
  const reds = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
  return reds.includes(number) ? "red" : "black";
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function mentionTag(jid: string): string {
  const num = parseJid(jid);
  return `@${num}`;
}

export function isValidTier(tier: string): boolean {
  return ["T1","T2","T3","T4","T5","T6","TS","TX","TZ"].includes(tier.toUpperCase());
}

/** Returns true when the buffer contains a GIF (magic bytes 47 49 46 38 = "GIF8"). */
export function isGifBuffer(buf: Buffer): boolean {
  return (
    buf.length >= 4 &&
    buf[0] === 0x47 && // G
    buf[1] === 0x49 && // I
    buf[2] === 0x46 && // F
    buf[3] === 0x38    // 8
  );
}

export function normalizeId(id: string): string {
  if (!id.includes("@")) {
    return id.includes("-") ? `${id}@g.us` : `${id}@s.whatsapp.net`;
  }
  return id;
}
