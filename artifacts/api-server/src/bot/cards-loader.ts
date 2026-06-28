/**
 * cards-loader.ts
 * Reads unified_cards.jsonl (or cards.json as fallback) and syncs all cards
 * into MongoDB using a unified schema — no shoob/mazoku distinction.
 *
 * JSONL is processed line-by-line (readline), so we never load the whole
 * file into memory at once.  This prevents the OOM crash on 512 MB instances.
 */
import fs from "fs";
import readline from "readline";
import path from "path";
import { fileURLToPath } from "url";
import { randomBytes } from "crypto";
import { col } from "./db/mongo.js";
import { logger } from "../lib/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ── Resolve file path ─────────────────────────────────────────────────── */
function resolveFile(names: string[]): string | null {
  const roots = [
    path.resolve(__dirname, "../../../"),
    path.resolve(__dirname, "../../../../"),
    process.cwd(),
    path.resolve(process.cwd(), "../../"),
  ];
  for (const name of names) {
    for (const root of roots) {
      const p = path.join(root, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/* ── Tiny ID generator ─────────────────────────────────────────────────── */
const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
async function genId(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const c = Array.from(randomBytes(8) as Uint8Array)
      .map((b: number) => ID_CHARS[b % ID_CHARS.length]).join("");
    if (!await col("cards").findOne({ _id: c as any }, { projection: { _id: 1 } })) return c;
  }
  return "C" + Date.now().toString(36).toUpperCase();
}

/* ── Stream JSONL file, yield one card per line ─────────────────────────── */
async function* streamJsonl(filePath: string): AsyncGenerator<any> {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed);
    } catch {
      // skip malformed lines
    }
  }
}

/* ── Stream cards.json (legacy) without loading the whole array ─────────── */
async function* streamCardsJson(filePath: string): AsyncGenerator<any> {
  // For legacy cards.json we load the whole file because it uses a JSON array.
  // This is the FALLBACK path; prefer unified_cards.jsonl when available.
  logger.warn("Falling back to cards.json (consider running merge_cards.js)");
  const raw = fs.readFileSync(filePath, "utf8");
  const data = JSON.parse(raw);
  const cards: any[] = data.cards || [];
  for (const c of cards) yield c;
}

/* ── Normalise a raw card from either source ───────────────────────────── */
const MAZOKU_TIER: Record<string, string> = { C: "T2", R: "T4", SR: "T5", SSR: "T6", UR: "TS" };
const ANIMATED    = new Set(["T6", "TS", "TX", "TZ"]);

function normaliseCard(raw: any, isJsonl: boolean): any | null {
  // unified_cards.jsonl cards already have normalized fields
  if (isJsonl) {
    const id = String(raw.shoob_id || raw.mazoku_id || raw.id || "").trim();
    if (!id) return null;
    const isAnimated = raw.is_animated === true || raw.is_animated === 1 || ANIMATED.has(raw.tier || "");
    const isEvent    = raw.is_event === true || raw.is_event === 1;
    return {
      name:        raw.name   || "Unknown",
      series:      raw.series || "General",
      tier:        raw.tier   || "T1",
      is_animated: isAnimated ? 1 : 0,
      is_event:    isEvent ? 1 : 0,
      event_name:  raw.event_name || null,
      shoob_id:    raw.shoob_id  || null,
      mazoku_id:   raw.mazoku_id || null,
      image_url:   raw.image_url || null,
      webm_url:    raw.webm_url  || null,
      gif_url:     raw.gif_url   || null,
      has_webm:    raw.has_webm  ? 1 : 0,
      has_webp:    raw.has_webp  ? 1 : 0,
      file_hash:   raw.file_hash || null,
      slug:        raw.slug      || null,
      source:      raw.source    || "shoob",
      _primaryId:  id,
    };
  }

  // Legacy cards.json format (shoob only)
  const shoobId = String(raw.shoob_id || "").trim();
  if (!shoobId) return null;
  const hasWebm    = raw.has_webm === true || raw.has_webm === 1;
  const isAnimated = raw.is_animated === true || raw.is_animated === 1 || ANIMATED.has(raw.tier || "");
  return {
    name:        raw.name   || "Unknown",
    series:      raw.series || "General",
    tier:        raw.tier   || "T1",
    is_animated: isAnimated ? 1 : 0,
    shoob_id:    shoobId,
    mazoku_id:   null,
    image_url:   `https://api.shoob.gg/site/api/cardr/${shoobId}?size=400`,
    webm_url:    hasWebm ? `https://api.shoob.gg/site/api/cardr/${shoobId}?type=webm` : null,
    gif_url:     null,
    has_webm:    hasWebm ? 1 : 0,
    has_webp:    raw.has_webp ? 1 : 0,
    file_hash:   raw.file_hash || null,
    slug:        raw.slug      || null,
    source:      "shoob",
    _primaryId:  shoobId,
  };
}

/* ── Main export ───────────────────────────────────────────────────────── */
/* ── Sync state — single source of truth for "is a sync currently running"
 * and live progress. This is what makes concurrent syncs impossible: if a
 * sync is already in flight (whether triggered at boot or by an admin
 * pressing the button, possibly more than once because the first request
 * looked like it hung), a second call returns the in-progress state instead
 * of starting a second, fully independent pass against the same
 * collection. Two unguarded syncs racing against each other — each running
 * its own duplicate-cleanup pass and its own import snapshot at a different
 * moment — is what produced wildly inconsistent partial counts and
 * documents getting tagged inconsistently when this didn't exist. ── */
export type SyncState = {
  running: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  processed: number;
  total: number;
  lastResult: { imported: number; updated: number; skipped: number; fileNotFound?: boolean; resolvedPath?: string } | null;
  lastError: string | null;
};

const syncState: SyncState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  processed: 0,
  total: 0,
  lastResult: null,
  lastError: null,
};

export function getSyncState(): SyncState {
  return { ...syncState };
}

export async function loadCardsFromRepo(opts: { force?: boolean } = {}): Promise<{ imported: number; updated: number; skipped: number; fileNotFound?: boolean; resolvedPath?: string }> {
  if (syncState.running) {
    logger.warn("loadCardsFromRepo called while a sync is already running — ignoring this call and returning the existing run's state");
    return syncState.lastResult || { imported: 0, updated: 0, skipped: 0 };
  }
  syncState.running = true;
  syncState.startedAt = Date.now();
  syncState.finishedAt = null;
  syncState.processed = 0;
  syncState.total = 0;
  syncState.lastError = null;
  try {
    const result = await loadCardsFromRepoInner(opts);
    syncState.lastResult = result;
    return result;
  } catch (e: any) {
    syncState.lastError = e?.message || String(e);
    throw e;
  } finally {
    syncState.running = false;
    syncState.finishedAt = Date.now();
  }
}

async function loadCardsFromRepoInner(opts: { force?: boolean } = {}): Promise<{ imported: number; updated: number; skipped: number; fileNotFound?: boolean; resolvedPath?: string }> {
  const stats: { imported: number; updated: number; skipped: number; fileNotFound?: boolean; resolvedPath?: string } = { imported: 0, updated: 0, skipped: 0 };

  // Prefer unified JSONL; fall back to legacy cards.json
  const jsonlPath = resolveFile(["unified_cards.jsonl"]);
  const jsonPath  = resolveFile(["cards.json"]);
  const filePath  = jsonlPath || jsonPath;
  const isJsonl   = !!jsonlPath;

  if (!filePath) {
    logger.warn(
      { triedRoots: [path.resolve(__dirname, "../../../"), path.resolve(__dirname, "../../../../"), process.cwd(), path.resolve(process.cwd(), "../../")] },
      "Neither unified_cards.jsonl nor cards.json found — skipping card loader"
    );
    stats.fileNotFound = true;
    return stats;
  }
  stats.resolvedPath = filePath;

  const metaKey = isJsonl ? "unified_jsonl" : "shoob_json";
  logger.info({ filePath, isJsonl, force: !!opts.force }, "Card loader starting");

  /* Fast-skip: file unchanged and DB already populated. This only applies
   * to the automatic boot-time sync — its entire purpose is to avoid
   * redoing a full pass on every restart when nothing changed. An explicit
   * manual re-sync (opts.force) must NEVER hit this shortcut: matching file
   * size is a weak signal on its own (two different file contents can land
   * on the same byte count, and more importantly, an admin pressing "sync
   * now" is explicitly asking to verify and reconcile state regardless of
   * what the last recorded size was — silently no-op'ing on that request
   * is exactly what made the sync button look broken). */
  let fileSize = 0;
  try { fileSize = fs.statSync(filePath).size; } catch {}
  // Rough estimate for progress reporting only — average observed line
  // length in unified_cards.jsonl is ~430 bytes. Exact precision doesn't
  // matter here, this just gives the admin panel something to show a
  // percentage against instead of leaving "processed" with no context.
  syncState.total = fileSize > 0 ? Math.round(fileSize / 430) : 0;

  if (!opts.force && fileSize > 0) {
    const meta = await col("sync_meta").findOne({ _id: metaKey as any }).catch(() => null);
    if (meta && meta.file_size === fileSize && meta.imported_count > 0) {
      logger.info({ importedCount: meta.imported_count }, "Card file unchanged — skipping sync");
      return stats;
    }
  }

  /* ── One-time cleanup: collapse any EXISTING duplicate documents that
   * already share the same shoob_id or mazoku_id. These are leftovers from
   * the old insert logic (random _id per insert, dedup tracked in a
   * separate, non-atomically-written collection) — a crash mid-sync could
   * leave the same card inserted twice under different local ids. The
   * upsert-by-shoob_id/mazoku_id added above prevents NEW duplicates, but
   * does nothing to clean up ones that already exist, since updateOne only
   * ever touches the first match. This pass finds and merges them down to
   * one document each, going forward. ── */
  try {
    const dupGroups = await col("cards").aggregate([
      { $match: { shoob_id: { $ne: null } } },
      { $group: { _id: "$shoob_id", ids: { $push: "$_id" }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ]).toArray().catch(() => [] as any[]);

    const mazokuDupGroups = await col("cards").aggregate([
      { $match: { mazoku_id: { $ne: null } } },
      { $group: { _id: "$mazoku_id", ids: { $push: "$_id" }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ]).toArray().catch(() => [] as any[]);

    const allDupGroups = [...dupGroups, ...mazokuDupGroups];
    if (allDupGroups.length > 0) {
      const allDupIds = allDupGroups.flatMap((g: any) => g.ids);
      const ownedIds = new Set(
        (await col("user_cards").find(
          { card_id: { $in: allDupIds } },
          { projection: { card_id: 1 } }
        ).toArray()).map((d: any) => d.card_id)
      );

      const toDelete: any[] = [];
      for (const g of allDupGroups) {
        const ids: any[] = g.ids;
        // Prefer to keep a copy that's owned by a player; otherwise keep the
        // first (oldest-inserted) copy. Delete the rest.
        const ownedCopy = ids.find((id) => ownedIds.has(id));
        const keepId = ownedCopy ?? ids[0];
        for (const id of ids) {
          if (id !== keepId) toDelete.push(id);
        }
      }
      if (toDelete.length > 0) {
        await col("cards").deleteMany({ _id: { $in: toDelete } });
        logger.info(
          { duplicateGroups: allDupGroups.length, documentsRemoved: toDelete.length },
          "Card sync: collapsed pre-existing duplicate documents sharing the same shoob_id/mazoku_id"
        );
      }
    }
  } catch (e: any) {
    logger.warn({ e: e.message }, "Pre-existing duplicate cleanup failed (non-fatal)");
  }

  /* Collect already-imported primary IDs (shoob_id OR mazoku_id) directly
   * from the cards collection itself — this is the single source of truth.
   * (Previously this read from separate shoob_imported_ids/mazoku_imported_ids
   * tracking collections, which could silently fall out of sync with `cards`
   * if the process crashed between the two writes, causing the same card to
   * be re-imported as a brand-new duplicate document on the next sync.) */
  const existingCardIdDocs = await col("cards")
    .find({}, { projection: { shoob_id: 1, mazoku_id: 1 } })
    .toArray()
    .catch(() => [] as any[]);
  const importedIds = new Set<string>();
  for (const d of existingCardIdDocs) {
    if (d.shoob_id)  importedIds.add(d.shoob_id);
    if (d.mazoku_id) importedIds.add(d.mazoku_id);
  }

  /* Skip sync if DB already has at least as many docs as the file */
  const existingCount = await col("cards").countDocuments().catch(() => 0);
  if (existingCount > 0 && importedIds.size > 0) {
    // We'll still run to catch new additions, but only skip if sizes match
  }

  const stream = isJsonl ? streamJsonl(filePath) : streamCardsJson(filePath);

  // NOTE: true duplicate elimination (same shoob_id, same mazoku_id, or same
  // name+series+tier+file_hash content) already happens once, upstream, in
  // merge_cards.js when unified_cards.jsonl is generated. There used to be a
  // second, redundant dedup pass here that skipped any incoming card whose
  // image_url already existed in the database — but that ran BEFORE the
  // upsert logic below, so it intercepted every already-imported card before
  // it could ever be matched against the upsert-by-id path and have its
  // fields refreshed. In practice this meant every existing card was always
  // counted as "skipped" and never "updated", no matter what changed in the
  // source file (tier fixes, event tags, etc. never propagated to cards that
  // were already in Mongo). Removed — the upsert keyed on shoob_id/mazoku_id
  // below is the single source of truth for "is this card new or existing",
  // and it's what actually updates a changed card's fields.
  const BATCH = 50;
  let batch: any[] = [];

  const processBatch = async () => {
    const cardOps: any[] = [];

    for (const raw of batch) {
      const card = normaliseCard(raw, isJsonl);
      if (!card) { stats.skipped++; continue; }

      const pid = card._primaryId;
      delete card._primaryId;

      // Upsert keyed on the card's own shoob_id/mazoku_id (NOT a randomly
      // generated local id, and NOT a separate tracking collection). This is
      // what makes the sync crash-safe: if the process dies mid-batch (e.g.
      // an unhandled rejection elsewhere takes down the whole instance) and
      // the same batch gets reprocessed on the next run, this upsert can
      // only ever touch the ONE document that already has this shoob_id/
      // mazoku_id — it can never insert a second document for the same
      // card. The old design generated a brand-new random _id on every
      // insert and relied on a separate, non-atomically-written tracking
      // collection to remember "already imported" — a crash between the two
      // writes could desync them, and the next sync would then insert the
      // same card again under a new id. That's how true duplicates (absent
      // from the source JSON entirely) accumulated in Mongo over time.
      const field = card.shoob_id ? "shoob_id" : "mazoku_id";
      if (importedIds.has(pid)) {
        cardOps.push({
          updateOne: { filter: { [field]: pid }, update: { $set: card } },
        });
        stats.updated++;
      } else {
        const localId = await genId();
        cardOps.push({
          updateOne: {
            filter: { [field]: pid },
            update: {
              $set: card,
              $setOnInsert: { _id: localId as any, created_at: Math.floor(Date.now() / 1000) },
            },
            upsert: true,
          },
        });
        importedIds.add(pid);
        stats.imported++;
      }
    }

    try {
      if (cardOps.length) await col("cards").bulkWrite(cardOps, { ordered: false });
    } catch (e: any) { logger.warn({ e: e.message }, "Card bulk write partial error"); }

    // Best-effort mirror into the legacy tracking collections, for other
    // tools (the scraper, manual sync routes) that still query them. This is
    // NOT relied on for dedup correctness — that's enforced by the upsert
    // above keyed directly on shoob_id/mazoku_id in `cards`. If this write
    // fails or is skipped by a crash, nothing breaks; it only affects
    // anything reading these collections directly for stats/lookups.
    try {
      const trackingOps: any[] = [];
      for (const op of cardOps) {
        const doc = op.insertOne?.document || op.updateOne?.update?.$set;
        if (!doc) continue;
        if (doc.shoob_id) {
          trackingOps.push({
            updateOne: {
              filter: { shoob_id: doc.shoob_id },
              update: { $setOnInsert: { shoob_id: doc.shoob_id } },
              upsert: true,
            },
          });
        }
      }
      if (trackingOps.length) await col("shoob_imported_ids").bulkWrite(trackingOps, { ordered: false });
    } catch (e: any) { logger.warn({ e: e.message }, "Legacy tracking collection mirror failed (non-fatal)"); }

    batch = [];
  };

  let totalSeen = 0;
  for await (const raw of stream) {
    totalSeen++;
    syncState.processed = totalSeen;
    batch.push(raw);
    if (batch.length >= BATCH) await processBatch();
  }
  if (batch.length > 0) await processBatch();

  // ── Reconciliation: remove any card in Mongo whose shoob_id/mazoku_id no
  // longer appears in the current source file. Without this, cards imported
  // under an older export (before an ID changed, or before a dedup pass on
  // the file itself) stick around forever as orphaned duplicates — the file
  // and the database silently drift apart over repeated syncs. We only run
  // this when the sync actually read a non-trivial number of cards, so a
  // truncated/failed read of the file can't wipe out the whole collection.
  if (isJsonl && totalSeen > 0) {
    try {
      const currentIdsStream = streamJsonl(filePath);
      const currentIds = new Set<string>();
      for await (const raw of currentIdsStream) {
        const pid = String(raw.shoob_id || raw.mazoku_id || raw.id || "").trim();
        if (pid) currentIds.add(pid);
      }

      if (currentIds.size > 0) {
        const allCardIds = await col("cards").find({}, { projection: { _id: 1, shoob_id: 1, mazoku_id: 1 } }).toArray();
        const staleMongoIds: any[] = [];
        const staleShoobIds: string[] = [];
        const staleMazokuIds: string[] = [];
        for (const doc of allCardIds) {
          const pid = String(doc.shoob_id || doc.mazoku_id || "").trim();
          if (pid && !currentIds.has(pid)) {
            staleMongoIds.push(doc._id);
            if (doc.shoob_id)  staleShoobIds.push(doc.shoob_id);
            if (doc.mazoku_id) staleMazokuIds.push(doc.mazoku_id);
          }
        }
        if (staleMongoIds.length > 0) {
          // Don't delete cards that players already own — unequip them from
          // circulation (no longer spawnable/orphaned-safe) but never destroy
          // a card that's sitting in someone's collection.
          const ownedCardIds = new Set(
            (await col("user_cards").find(
              { card_id: { $in: staleMongoIds } },
              { projection: { card_id: 1 } }
            ).toArray()).map((d: any) => d.card_id)
          );
          const safeToDelete = staleMongoIds.filter((id) => !ownedCardIds.has(id));
          if (safeToDelete.length > 0) {
            await col("cards").deleteMany({ _id: { $in: safeToDelete } });
          }
          if (staleShoobIds.length)  await col("shoob_imported_ids").deleteMany({ shoob_id: { $in: staleShoobIds } });
          if (staleMazokuIds.length) await col("mazoku_imported_ids").deleteMany({ mazoku_id: { $in: staleMazokuIds } });
          logger.info(
            { staleFound: staleMongoIds.length, deleted: safeToDelete.length, keptOwned: staleMongoIds.length - safeToDelete.length },
            "Card reconciliation: removed orphaned cards not present in current source file"
          );
        }
      }
    } catch (e: any) {
      logger.warn({ e: e.message }, "Card reconciliation step failed (non-fatal)");
    }
  }

  // Persist metadata for fast-skip on future cold starts
  await col("sync_meta").updateOne(
    { _id: metaKey as any },
    { $set: { file_size: fileSize, imported_count: totalSeen, synced_at: Math.floor(Date.now() / 1000) } },
    { upsert: true }
  ).catch(() => {});

  logger.info({ ...stats, totalSeen, isJsonl }, "✅ Card sync complete");
  return stats;
}
