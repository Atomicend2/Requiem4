/**
 * cards-loader.ts
 * Reads cards.json (written by GitHub Actions scraper) and syncs
 * any new or updated cards into the bot's SQLite database.
 *
 * Images are NOT stored in the DB — they are fetched on demand
 * from Shoob's CDN via media_url when a card is displayed.
 *
 * Called once at bot startup. Fast — only processes new cards.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomBytes } from "crypto";
import { getDb } from "./db/database.js";
import { logger } from "../lib/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// With esbuild bundling (single dist/index.mjs), __dirname = artifacts/api-server/dist/
// cards.json lives at repo root: ../../../ from dist/ = Requiem3-main/cards.json
// We also try process.cwd() as a fallback for different deployment layouts.
function resolveCardsJson(): string {
  const candidates = [
    path.resolve(__dirname, "../../../cards.json"),        // esbuild bundle: dist/ → api-server/ → artifacts/ → root
    path.resolve(__dirname, "../../../../cards.json"),      // tsc: dist/bot/ → dist/ → api-server/ → artifacts/ → root
    path.resolve(process.cwd(), "cards.json"),             // running from repo root
    path.resolve(process.cwd(), "../../cards.json"),       // running from artifacts/api-server/
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0]; // return first candidate even if not found, for error logging
}
const CARDS_JSON = resolveCardsJson();

export async function loadCardsFromRepo(): Promise<{ imported: number; updated: number; skipped: number }> {
  const stats = { imported: 0, updated: 0, skipped: 0 };

  logger.info({ cardsJsonPath: CARDS_JSON }, "Attempting to load cards from cards.json");

  if (!fs.existsSync(CARDS_JSON)) {
    logger.warn({ cardsJsonPath: CARDS_JSON }, "cards.json not found at expected path — skipping card loader");
    return stats;
  }

  let data: any;
  try {
    const fileContent = fs.readFileSync(CARDS_JSON, "utf8");
    data = JSON.parse(fileContent);
  } catch (e) {
    logger.error({ e, cardsJsonPath: CARDS_JSON }, "Failed to parse cards.json");
    return stats;
  }

  const cards: any[] = data.cards || [];
  if (cards.length === 0) {
    logger.warn("cards.json is empty or has no 'cards' array");
    return stats;
  }

  logger.info({ total: cards.length, cardsJsonPath: CARDS_JSON }, "Loading cards from cards.json...");
  const db = getDb();

  for (const card of cards) {
    const shoobId = String(card.shoob_id || "").trim();
    if (!shoobId) { 
      stats.skipped++; 
      continue; 
    }

    const existing = db.prepare(
      "SELECT id FROM cards WHERE shoob_id = ?"
    ).get(shoobId) as any;

    if (existing) {
      // Build media_url with proper CDN endpoint
      const hasWebm = card.has_webm === true;
      const mediaUrl = hasWebm
        ? `https://api.shoob.gg/site/api/cardr/${shoobId}?type=webm`
        : `https://api.shoob.gg/site/api/cardr/${shoobId}?size=400`;

      db.prepare(`
        UPDATE cards SET
          name=?, tier=?, series=?, is_animated=?,
          raw_data=?, file_hash=?, has_webm=?, has_webp=?, slug=?,
          source='shoob'
        WHERE id=?
      `).run(
        card.name, card.tier, card.series, card.is_animated ? 1 : 0,
        JSON.stringify({ media_url: mediaUrl, has_webm: card.has_webm || false, _id: card.shoob_id }),
        card.file_hash || "",
        card.has_webm ? 1 : 0,
        card.has_webp ? 1 : 0,
        card.slug || "",
        existing.id,
      );
      db.prepare(
        "INSERT OR IGNORE INTO shoob_imported_ids (shoob_id, local_card_id) VALUES (?, ?)"
      ).run(shoobId, existing.id);
      stats.updated++;
      logger.debug({ shoobId, cardName: card.name }, "Updated existing card");
      continue;
    }

    const localId = genId(db);
    try {
      // Build media_url with proper CDN endpoint
      const hasWebm = card.has_webm === true;
      const mediaUrl = hasWebm
        ? `https://api.shoob.gg/site/api/cardr/${shoobId}?type=webm`
        : `https://api.shoob.gg/site/api/cardr/${shoobId}?size=400`;

      db.prepare(`
        INSERT INTO cards
          (id, name, series, tier, image_data, is_animated,
           uploaded_by, source, shoob_id,
           raw_data, file_hash, has_webm, has_webp, slug)
        VALUES (?, ?, ?, ?, NULL, ?, 'github-actions', 'shoob', ?, ?, ?, ?, ?, ?)
      `).run(
        localId,
        card.name, card.series, card.tier,
        card.is_animated ? 1 : 0,
        shoobId,
        JSON.stringify({ media_url: mediaUrl, has_webm: card.has_webm || false, _id: card.shoob_id }),
        card.file_hash || "",
        card.has_webm ? 1 : 0,
        card.has_webp ? 1 : 0,
        card.slug || "",
      );
      db.prepare(
        "INSERT OR IGNORE INTO shoob_imported_ids (shoob_id, local_card_id) VALUES (?, ?)"
      ).run(shoobId, localId);
      stats.imported++;
      logger.debug({ shoobId, cardName: card.name, localId }, "Imported new card");
    } catch (e: any) {
      logger.error({ e, shoobId, cardName: card.name }, "Failed to insert card");
      stats.skipped++;
    }
  }

  logger.info(stats, "✅ cards.json load complete — cards are now available to web API and bot commands");
  return stats;
}

const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function genId(db: any): string {
  for (let i = 0; i < 50; i++) {
    const c = Array.from(randomBytes(8) as Uint8Array)
      .map((b: number) => ID_CHARS[b % ID_CHARS.length]).join("");
    if (!db.prepare("SELECT 1 FROM cards WHERE id=?").get(c)) return c;
  }
  return "C" + Date.now().toString(36).toUpperCase();
}
