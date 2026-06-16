import { Router } from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import { fileURLToPath } from "url";
import { requireAuth, optionalAuth, type AuthRequest } from "./middleware.js";
import { getDb } from "../../bot/db/database.js";
import { getSocket, isSocketConnected } from "../../bot/connection.js";
import { getStaff } from "../../bot/db/queries.js";
import { logger } from "../../lib/logger.js";

const __dirname_routes = path.dirname(fileURLToPath(import.meta.url));
// Resolve cards.json with multiple candidates to handle both esbuild bundle and tsc builds.
// esbuild (single dist/index.mjs): __dirname_routes = artifacts/api-server/dist/ → 3 levels up
// tsc (dist/routes/v1/cards.js):   __dirname_routes = dist/routes/v1/          → 5 levels up
function _resolveCardsJsonPath(): string {
  const candidates = [
    path.resolve(__dirname_routes, "../../../cards.json"),       // esbuild bundle
    path.resolve(__dirname_routes, "../../../../../cards.json"),  // tsc build
    path.resolve(process.cwd(), "cards.json"),                   // running from repo root
    path.resolve(process.cwd(), "../../cards.json"),             // running from artifacts/api-server/
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}
const CARDS_JSON_PATH = _resolveCardsJsonPath();

// Get image URL — prefers stored blob, falls back through all CDN paths
function getCardImageUrl(card: any): string {
  // 1. Stored blob (custom / manually uploaded cards)
  if (card.image_data) return `/api/v1/cards/${card.id}/image`;

  // 2. Parse raw_data JSON for media_url or _id
  let rawObj: any = null;
  try {
    if (card.raw_data) {
      rawObj = typeof card.raw_data === "string" ? JSON.parse(card.raw_data) : card.raw_data;
    }
  } catch {}

  // 3. Direct media_url stored in raw_data (set by cards-loader from cards.json)
  if (rawObj?.media_url) return rawObj.media_url;

  // 4. Build CDN URL from shoob_id (on card itself, or inside raw_data)
  const shoobId = card.shoob_id || rawObj?._id || rawObj?.id;
  if (shoobId) {
    const hasWebm = card.has_webm || rawObj?.has_webm;
    if (hasWebm) return `https://api.shoob.gg/site/api/cardr/${shoobId}?type=webm`;
    return `https://api.shoob.gg/site/api/cardr/${shoobId}?size=400`;
  }

  return "";
}


const router = Router();
const uploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const ANIMATED_TIERS = new Set(["T6", "TS", "TX", "TZ"]); // must match VIDEO_TIERS in utils.ts
const VALID_TIERS = ["T1","T2","T3","T4","T5","T6","TS","TX","TZ"];

// Shoob.gg public card API
// Shoob returns exactly 15 cards per page regardless of any limit= param.
const SHOOB_API       = "https://api.shoob.gg";
const SHOOB_PAGE_SIZE = 15; // actual cards per page (Shoob ignores limit=)

// ── Read cards directly from cards.json (no DB required) ─────────────────────
// GET /api/v1/cards/from-json?page=1&limit=50&tier=T3&search=naruto
// Used by the web frontend as a fallback when the DB hasn't been populated yet,
// AND as the primary source since cards.json is always up-to-date from GitHub Actions.
router.get("/from-json", (req, res) => {
  try {
    if (!fs.existsSync(CARDS_JSON_PATH)) {
      res.status(404).json({ success: false, message: "cards.json not found on server", cards: [], total: 0 });
      return;
    }

    const raw = fs.readFileSync(CARDS_JSON_PATH, "utf8");
    const data = JSON.parse(raw);
    let cards: any[] = data.cards || [];

    const { tier, search, page: pageStr, limit: limitStr } = req.query as Record<string, string | undefined>;

    // Filter by tier
    if (tier && tier !== "all") {
      cards = cards.filter((c: any) => c.tier === tier);
    }

    // Filter by name/series search
    if (search) {
      const q = search.toLowerCase();
      cards = cards.filter((c: any) =>
        (c.name || "").toLowerCase().includes(q) ||
        (c.series || "").toLowerCase().includes(q)
      );
    }

    const total = cards.length;
    const limit = Math.min(Math.max(parseInt(limitStr || "50", 10) || 50, 1), 200);
    const page  = Math.max(parseInt(pageStr || "1", 10) || 1, 1);
    const start = (page - 1) * limit;
    const paginated = cards.slice(start, start + limit);

    const result = paginated.map((c: any) => {
      const isAnimated = ANIMATED_TIERS.has(c.tier) || c.is_animated === true || c.is_animated === 1;
      const hasWebm = !!c.has_webm;

      // Direct Shoob CDN URL for the media
      const rawUrl = c.media_url ||
        (c.shoob_id
          ? (hasWebm
            ? `https://api.shoob.gg/site/api/cardr/${c.shoob_id}?type=webm`
            : `https://api.shoob.gg/site/api/cardr/${c.shoob_id}?size=400`)
          : "");

      // Shoob serves GIFs for ALL animated cards — even ?type=webm URLs return GIFs.
      // Use the URL directly in an <img> tag. GIFs animate automatically.
      // Never proxy: Render datacenter IPs may be blocked by Shoob.
      const imageUrl = rawUrl;

      return {
        id: c.shoob_id || c.id || "",
        shoob_id: c.shoob_id || "",
        name: c.name || "Unknown",
        tier: c.tier || "T1",
        series: c.series || "General",
        description: "",
        imageUrl,
        isAnimated,
        isVideo: false,  // always false — use <img> for all cards, GIFs animate natively
        totalCopies: 0,
        owners: [],
        ownerName: "Unclaimed",
        ownerId: null,
        source: "cards.json",
      };
    });

    res.json({
      cards: result,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
      source: "cards.json",
    });
  } catch (err: any) {
    logger.error({ err }, "Error reading cards.json for from-json route");
    res.status(500).json({ success: false, message: "Failed to read cards.json", cards: [], total: 0 });
  }
});

// ── Trigger cards.json → DB loader on-demand (no auth required for health) ───
// POST /api/v1/cards/reload-from-json
// Allows the web UI or an ops engineer to re-trigger the cards.json → SQLite sync
// without restarting the server.
router.post("/reload-from-json", requireAuth, async (req: AuthRequest, res) => {
  try {
    const { loadCardsFromRepo } = await import("../../bot/cards-loader.js");
    const stats = await loadCardsFromRepo();
    res.json({ success: true, ...stats });
  } catch (err: any) {
    logger.error({ err }, "reload-from-json error");
    res.status(500).json({ success: false, message: err?.message || "Reload failed" });
  }
});


// ── Media proxy — pipes Shoob CDN media through our server so browser CORS is satisfied ──
// GET /api/v1/cards/media-proxy?url=ENCODED_URL
// Without this, browsers block <video> tags pointing at api.shoob.gg because Shoob
// does not send Access-Control-Allow-Origin headers on video responses.
// Only proxies URLs from api.shoob.gg for security.
router.get("/media-proxy", (req, res) => {
  const raw = req.query.url as string;
  if (!raw) { res.status(400).send("Missing url"); return; }

  let target: URL;
  try { target = new URL(decodeURIComponent(raw)); } catch {
    res.status(400).send("Invalid url"); return;
  }

  if (!target.hostname.endsWith("shoob.gg")) {
    res.status(403).send("Forbidden"); return;
  }

  // Follow up to 5 redirects so Shoob CDN redirect chains don't silently fail
  function fetchWithRedirects(url: URL, redirectsLeft: number) {
    const lib = url.protocol === "https:" ? https : http;
    const req2 = lib.get(url.toString(), {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://shoob.gg/",
      },
    }, (upstream) => {
      const status = upstream.statusCode || 200;

      // Follow redirect
      if ((status === 301 || status === 302 || status === 303 || status === 307 || status === 308)
          && upstream.headers.location && redirectsLeft > 0) {
        upstream.resume(); // drain the body
        let nextUrl: URL;
        try { nextUrl = new URL(upstream.headers.location, url.toString()); } catch {
          if (!res.headersSent) res.status(502).send("Bad redirect");
          return;
        }
        // Only follow redirects within shoob.gg for safety
        if (!nextUrl.hostname.endsWith("shoob.gg") && !nextUrl.hostname.endsWith("cdn.shoob.gg")) {
          // Non-shoob redirect — pipe the original response as-is
          if (!res.headersSent) res.status(502).send("Redirect outside shoob");
          return;
        }
        fetchWithRedirects(nextUrl, redirectsLeft - 1);
        return;
      }

      const ct = upstream.headers["content-type"] || "application/octet-stream";
      const cl = upstream.headers["content-length"];
      res.setHeader("Content-Type", ct);
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      if (cl) res.setHeader("Content-Length", cl);
      res.status(status);
      upstream.pipe(res);
    });
    req2.on("error", (err) => {
      logger.error({ err }, "media-proxy upstream error");
      if (!res.headersSent) res.status(502).send("Upstream error");
    });
    req2.setTimeout(15000, () => {
      req2.destroy();
      if (!res.headersSent) res.status(504).send("Upstream timeout");
    });
  }

  fetchWithRedirects(target, 5);
});

// Serve card media BLOB from the database (image or video for animated tiers)
router.get("/:id/image", (req, res) => {
  const db = getDb();
  const card = db.prepare("SELECT image_data, tier FROM cards WHERE id = ?").get(req.params.id) as any;
  if (!card?.image_data) {
    res.status(404).end();
    return;
  }
  const isAnimated = ANIMATED_TIERS.has(card.tier);
  const contentType = isAnimated ? "video/mp4" : "image/jpeg";
  const buf: Buffer = Buffer.isBuffer(card.image_data) ? card.image_data : Buffer.from(card.image_data);
  const total = buf.length;

  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.setHeader("Accept-Ranges", "bytes");

  const rangeHeader = req.headers["range"];
  if (isAnimated && rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : total - 1;
      const chunkSize = end - start + 1;
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
      res.setHeader("Content-Length", chunkSize);
      res.end(buf.slice(start, end + 1));
      return;
    }
  }

  res.setHeader("Content-Length", total);
  res.end(buf);
});

function getCardCopyCount(db: any, cardId: string): number {
  const row = db.prepare("SELECT COUNT(*) as cnt FROM user_cards WHERE card_id = ?").get(cardId) as any;
  return row?.cnt || 0;
}

function getCardOwner(db: any, cardId: string): { name: string; id: string } | null {
  const row = db.prepare(`
    SELECT u.id, u.name FROM user_cards uc
    JOIN users u ON u.id = uc.user_id
    WHERE uc.card_id = ?
    ORDER BY uc.obtained_at ASC LIMIT 1
  `).get(cardId) as any;
  return row ? { id: row.id, name: row.name || "Unknown" } : null;
}

router.get("/", optionalAuth, (req, res) => {
  const db = getDb();
  const { tier, series } = req.query as { tier?: string; series?: string };

  let query = "SELECT * FROM cards";
  const params: any[] = [];
  const conditions: string[] = [];

  if (tier) {
    conditions.push("tier = ?");
    params.push(tier);
  }
  if (series) {
    conditions.push("LOWER(series) LIKE LOWER(?)");
    params.push(`%${series}%`);
  }
  if (conditions.length > 0) {
    query += " WHERE " + conditions.join(" AND ");
  }
  query += " ORDER BY tier, name";

  const cards = db.prepare(query).all(...params) as any[];

  const result = cards.map((card: any) => {
    const owner = getCardOwner(db, card.id);
    const totalCopies = getCardCopyCount(db, card.id);
    const owners = db.prepare(`
      SELECT DISTINCT u.id, u.name FROM user_cards uc
      JOIN users u ON u.id = uc.user_id
      WHERE uc.card_id = ?
      LIMIT 5
    `).all(card.id) as any[];
    const isAnimated = ANIMATED_TIERS.has(card.tier);
    return {
      id: card.id,
      name: card.name,
      tier: card.tier,
      series: card.series || "General",
      description: card.description || "",
      imageUrl: getCardImageUrl(card),
      isAnimated,
      totalCopies,
      ownerName: owner?.name || "Unclaimed",
      ownerId: owner?.id || null,
      owners: owners.map((o: any) => ({ id: o.id, name: o.name || "Shadow" })),
    };
  });

  res.json({ cards: result, total: result.length });
});

router.get("/my", requireAuth, (req: AuthRequest, res) => {
  const db = getDb();
  const userCards = db.prepare(`
    SELECT uc.id as user_card_id, uc.obtained_at, c.*
    FROM user_cards uc
    JOIN cards c ON c.id = uc.card_id
    WHERE uc.user_id = ?
    ORDER BY uc.obtained_at DESC
  `).all(req.userId!) as any[];

  const result = userCards.map((uc: any) => {
    const totalCopies = getCardCopyCount(db, uc.id);
    const owners = db.prepare(`
      SELECT DISTINCT u.id, u.name FROM user_cards ucc
      JOIN users u ON u.id = ucc.user_id
      WHERE ucc.card_id = ?
      LIMIT 5
    `).all(uc.id) as any[];
    const isAnimated = ANIMATED_TIERS.has(uc.tier);
    return {
      userCardId: uc.user_card_id,
      card: {
        id: uc.id,
        name: uc.name,
        tier: uc.tier,
        series: uc.series || "General",
        description: uc.description || "",
        imageUrl: getCardImageUrl({ ...uc, id: uc.id }),
        isAnimated,
        totalCopies,
        ownerName: req.user?.name || "You",
        ownerId: req.userId,
        owners: owners.map((o: any) => ({ id: o.id, name: o.name || "Shadow" })),
      },
      obtainedAt: uc.obtained_at || 0,
    };
  });

  res.json({ cards: result, total: result.length });
});

router.post("/wishlist", requireAuth, async (req: AuthRequest, res) => {
  const { cardId } = req.body as { cardId?: string };
  if (!cardId) {
    res.status(400).json({ success: false, message: "cardId is required" });
    return;
  }

  const db = getDb();
  const card = db.prepare("SELECT * FROM cards WHERE id = ?").get(cardId) as any;
  if (!card) {
    res.status(404).json({ success: false, message: "Card not found" });
    return;
  }

  const owner = getCardOwner(db, cardId);
  if (!owner) {
    res.json({ success: true, message: "Card is unclaimed — no owner to notify" });
    return;
  }

  const sock = getSocket();
  if (sock && isSocketConnected() && owner.id !== req.userId) {
    try {
      const requesterName = req.user?.name || "Someone";
      await sock.sendMessage(owner.id, {
        text: `*Requiem Order 反逆 — Trade Alert*\n\n${requesterName} wants to trade for your *${card.name}* (${card.tier} - ${card.series || "General"}).\n\nReply with .trade to negotiate.`,
      });
    } catch (err) {
      logger.error({ err }, "Failed to send wishlist notification");
    }
  }

  res.json({ success: true, message: "Trade notification sent to card owner" });
});

// ── Web card upload (staff only) ────────────────────────────────────────────
// POST /api/v1/cards/upload  — multipart: file (image or video), tier, name, series
router.post("/upload", requireAuth, uploadMem.single("file"), async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false, message: "Not authenticated" }); return; }

    // Check staff / mod permission
    const staffRow = getStaff(userId);
    const BOT_OWNER = (process.env["OWNER_NUMBERS"] || process.env["BOT_OWNER_LID"] || "2348144550593").split(",")[0].replace(/\D/g, "");
    const isStaff = !!staffRow || userId.replace(/\D/g, "") === BOT_OWNER;
    if (!isStaff) {
      res.status(403).json({ success: false, message: "Only staff can upload cards." });
      return;
    }

    if (!req.file) { res.status(400).json({ success: false, message: "No file provided" }); return; }

    const tier = (req.body?.tier || "").toUpperCase().trim();
    const name = (req.body?.name || "").trim();
    const series = (req.body?.series || "").trim();

    if (!VALID_TIERS.includes(tier)) {
      res.status(400).json({ success: false, message: `Invalid tier. Valid: ${VALID_TIERS.join(", ")}` });
      return;
    }
    if (!name || name.length < 2) {
      res.status(400).json({ success: false, message: "Card name is required (min 2 chars)" });
      return;
    }
    if (!series || series.length < 2) {
      res.status(400).json({ success: false, message: "Series name is required" });
      return;
    }

    const db = getDb();
    const existing = db.prepare("SELECT id FROM cards WHERE LOWER(name) = LOWER(?)").get(name) as any;
    if (existing) {
      res.status(409).json({ success: false, message: `A card named "${name}" already exists (ID: ${existing.id}).` });
      return;
    }

    const isAnimated = ANIMATED_TIERS.has(tier);
    const mimeType = req.file.mimetype;
    const isVideo = mimeType.startsWith("video/");

    if (isAnimated && !isVideo && !mimeType.startsWith("image/")) {
      res.status(400).json({ success: false, message: "Animated tier cards require a video or image file." });
      return;
    }
    if (!isAnimated && isVideo) {
      res.status(400).json({ success: false, message: `Tier ${tier} is not animated. Please upload an image.` });
      return;
    }

    let imageData: Buffer = req.file.buffer;

    if (!isVideo) {
      try {
        const sharp = (await import("sharp")).default;
        imageData = await sharp(req.file.buffer)
          .resize(800, 1100, { fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 92 })
          .toBuffer();
      } catch { /* sharp not available or unsupported format — use raw */ }
    }

    const result = db.prepare(
      "INSERT INTO cards (name, series, tier, image_data, is_animated, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(name, series, tier, imageData, isAnimated ? 1 : 0, userId);

    const cardId = result.lastInsertRowid;

    res.json({
      success: true,
      message: `Card uploaded! 🎴 ${name} (${tier}) — ${series}`,
      card: { id: cardId, name, series, tier, isAnimated },
    });
  } catch (err: any) {
    logger.error({ err }, "Card upload error");
    res.status(500).json({ success: false, message: err?.message || "Upload failed" });
  }
});


// ── Shoob.gg card import (staff only) ────────────────────────────────────────
// POST /api/v1/cards/fetch-cards
// Body: { tier?, series?, limit? }
//
// Fetches cards from the Shoob.gg public API (https://api.shoob.gg).
// Shoob card shape: { _id, id, name, slug, tier, category[], file, claim_count }
//
// Body params:
//   tier   - "T1"–"T6", "TS", "TX", "TZ" to filter by tier (optional)
//   series - override series label for all imported cards (optional)
//   limit  - max cards to import, 1–200 (default 20)

// Normalise Shoob tier field ("1"→"T1", "S"→"TS", etc.)
function normaliseShoobTier(raw: string | number | undefined, fallback = "T1"): string {
  if (raw === null || raw === undefined) return fallback;
  const s = String(raw).trim().toUpperCase();
  if (s.startsWith("T") && ["T1","T2","T3","T4","T5","T6","TS","TX","TZ"].includes(s)) return s;
  if (/^\d$/.test(s)) return `T${s}`;
  if (s === "S") return "TS";
  if (s === "X") return "TX";
  if (s === "Z") return "TZ";
  return fallback;
}

// Sync-log stats route: shows recent .pullcards / .synccards run history
router.get("/sync-log", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false, message: "Not authenticated" }); return; }
    const staffRow = getStaff(userId);
    const BOT_OWNER = (process.env["OWNER_NUMBERS"] || process.env["BOT_OWNER_PHONE"] || "2348144550593").split(",")[0].replace(/\D/g, "");
    const isStaff = !!staffRow || userId.replace(/\D/g, "") === BOT_OWNER;
    if (!isStaff) { res.status(403).json({ success: false, message: "Only staff can view sync logs." }); return; }

    const db = getDb();
    const logs = db.prepare("SELECT * FROM shoob_sync_log ORDER BY ran_at DESC LIMIT 20").all();
    const totalCards  = (db.prepare("SELECT COUNT(*) as cnt FROM cards").get() as any)?.cnt || 0;
    const shoobCards  = (db.prepare("SELECT COUNT(*) as cnt FROM cards WHERE source = 'shoob'").get() as any)?.cnt || 0;
    const trackedIds  = (db.prepare("SELECT COUNT(*) as cnt FROM shoob_imported_ids").get() as any)?.cnt || 0;
    res.json({ success: true, logs, totalCards, shoobCards, trackedIds });
  } catch (err: any) {
    logger.error({ err }, "Sync log error");
    res.status(500).json({ success: false, message: err?.message || "Failed to fetch sync log" });
  }
});

router.post("/fetch-cards", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false, message: "Not authenticated" }); return; }

    const staffRow = getStaff(userId);
    const BOT_OWNER = (process.env["OWNER_NUMBERS"] || process.env["BOT_OWNER_PHONE"] || "2348144550593").split(",")[0].replace(/\D/g, "");
    const isStaff = !!staffRow || userId.replace(/\D/g, "") === BOT_OWNER;
    if (!isStaff) { res.status(403).json({ success: false, message: "Only staff can import cards." }); return; }

    const rawTier = (req.body?.tier as string | undefined)?.toUpperCase().trim() || "";
    const tier = rawTier || "";

    if (tier && !VALID_TIERS.includes(tier)) {
      res.status(400).json({ success: false, message: `Invalid tier. Valid: ${VALID_TIERS.join(", ")} (or leave blank for all tiers)` });
      return;
    }

    const seriesOverride = ((req.body?.series || "") as string).trim();
    const limit = Math.min(parseInt(req.body?.limit || "20", 10) || 20, 200);

    const db = getDb();

    // Paginate Shoob until we collect enough matching cards.
    // Shoob ignores limit= and always returns 15 cards per page.
    const collected: any[] = [];
    let page = 1;
    while (collected.length < limit) {
      const url = `${SHOOB_API}/site/api/cards?page=${page}`;
      logger.info({ url }, "Fetching Shoob card page");
      const apiRes = await fetch(url, {
        headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0 (compatible; RequiemOrderBot/1.0)" },
        signal: AbortSignal.timeout(20000),
      });
      if (!apiRes.ok) {
        res.status(502).json({ success: false, message: `Shoob API returned ${apiRes.status}. Try again.` });
        return;
      }
      const apiData: any = await apiRes.json();
      const pageCards: any[] = Array.isArray(apiData) ? apiData : (apiData.cards || apiData.data || apiData.results || []);
      if (!pageCards.length) break;

      for (const c of pageCards) {
        const cardTier = normaliseShoobTier(c.tier);
        if (tier && cardTier !== tier) continue;
        // Filter by anime/category if provided
        if (req.body?.anime) {
          const animeQuery = (req.body.anime as string).trim().toLowerCase();
          const cats = Array.isArray(c.category) ? c.category.map((x: string) => String(x).toLowerCase()) : [];
          const nameMatch = String(c.name || c.slug || "").toLowerCase().includes(animeQuery);
          const catMatch  = cats.some((cat: string) => cat.includes(animeQuery));
          const slugMatch = String(c.slugged || "").toLowerCase().includes(animeQuery);
          if (!nameMatch && !catMatch && !slugMatch) continue;
        }
        collected.push(c);
        if (collected.length >= limit) break;
      }
      if (pageCards.length < SHOOB_PAGE_SIZE) break;
      page++;
    }

    if (!collected.length) {
      res.status(502).json({
        success: false,
        message: tier
          ? `No ${tier} cards found on Shoob right now. Try a different tier.`
          : "No cards returned from Shoob. Try again later.",
      });
      return;
    }

    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const sc of collected) {
      // Shoob shape: { _id, id, name, slug, tier, category[], file }
      const shoobId: string = String(sc._id || sc.id || "").trim();
      const cardName: string = (sc.name || sc.slug || shoobId).trim().replace(/_/g, " ");
      if (!cardName || cardName.length < 2) { skipped++; continue; }

      // Skip if already in DB by shoob_id or name
      const existsByShoobId = shoobId ? db.prepare("SELECT 1 FROM cards WHERE shoob_id = ?").get(shoobId) : null;
      const existsByName = db.prepare("SELECT 1 FROM cards WHERE LOWER(name) = LOWER(?)").get(cardName);
      if (existsByShoobId || existsByName) { skipped++; continue; }

      const cardTier = normaliseShoobTier(sc.tier, tier || "T1");
      const cardSeries: string = seriesOverride ||
        (Array.isArray(sc.category) && sc.category[0] ? String(sc.category[0]).trim() : (sc.series || sc.anime || "Shoob"));

      const file    = String(sc.file || "").toLowerCase();
      const isGif   = file.endsWith(".gif");
      const isWebm  = sc.has_webm === true;
      const cardIsAnimated = (
        isGif || isWebm ||
        sc.has_webp === true ||
        sc.patched === true ||
        ANIMATED_TIERS.has(cardTier)
      ) ? 1 : 0;

      // Build correct media URL — WebM if available, else the card render endpoint
      const mediaUrl = isWebm
        ? `${SHOOB_API}/site/api/cardr/${shoobId}?type=webm`
        : `${SHOOB_API}/site/api/cardr/${shoobId}?size=400`;

      // Generate unique local card ID
      const { randomBytes } = await import("crypto");
      const idChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
      let localId = "C" + Date.now().toString(36).toUpperCase();
      for (let a = 0; a < 50; a++) {
        const bytes = randomBytes(8);
        const candidate = Array.from(bytes as Buffer).map((b: number) => idChars[b % idChars.length]).join("");
        if (!db.prepare("SELECT 1 FROM cards WHERE id = ?").get(candidate)) { localId = candidate; break; }
      }

      let imageData: Buffer | null = null;
      if (mediaUrl) {
        try {
          const mediaRes = await fetch(mediaUrl, {
            headers: { "User-Agent": "Mozilla/5.0 (compatible; RequiemOrderBot/1.0)" },
            signal: AbortSignal.timeout(30000),
          });
          if (mediaRes.ok) {
            const buf = Buffer.from(await mediaRes.arrayBuffer());
            if (!isWebm && !isGif) {
              // Static image — normalise via sharp
              try {
                const sharp = (await import("sharp")).default;
                imageData = await sharp(buf)
                  .resize(800, 1100, { fit: "inside", withoutEnlargement: true })
                  .jpeg({ quality: 92 })
                  .toBuffer();
              } catch { imageData = buf; }
            } else {
              // GIF / WebM — store as-is
              imageData = buf;
            }
          }
        } catch (e: any) {
          errors.push(`${cardName}: ${e?.message || "fetch failed"}`);
        }
      }

      db.prepare(
        "INSERT INTO cards (id, name, series, tier, image_data, is_animated, uploaded_by, source, shoob_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'shoob', ?)"
      ).run(localId, cardName, cardSeries, cardTier, imageData, cardIsAnimated, userId, shoobId || null);

      if (shoobId) {
        db.prepare(
          "INSERT OR IGNORE INTO shoob_imported_ids (shoob_id, local_card_id) VALUES (?, ?)"
        ).run(shoobId, localId);
      }
      imported++;
    }

    res.json({
      success: true,
      message: `Import complete: ${imported} imported, ${skipped} skipped${errors.length ? ` (${errors.length} image errors)` : ""}.`,
      imported,
      skipped,
      total_available: collected.length,
      errors: errors.slice(0, 10),
    });
  } catch (err: any) {
    logger.error({ err }, "Card fetch error");
    res.status(500).json({ success: false, message: err?.message || "Fetch failed" });
  }
});

export { router as cardsRouter };


// ── Shoob Sync Log routes ────────────────────────────────────────────────────
// GET /api/v1/cards/scraper/status  — returns Shoob sync summary & DB counts
// GET /api/v1/cards/scraper/history — returns last 20 sync run records
// POST /api/v1/cards/scraper/run    — triggers an incremental Shoob sync

router.get("/scraper/status", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false, message: "Not authenticated" }); return; }
    const staffRow = getStaff(userId);
    const BOT_OWNER = (process.env["OWNER_NUMBERS"] || process.env["BOT_OWNER_PHONE"] || "2348144550593").split(",")[0].replace(/\D/g, "");
    const isStaff = !!staffRow || userId.replace(/\D/g, "") === BOT_OWNER;
    if (!isStaff) { res.status(403).json({ success: false, message: "Only staff can view sync status." }); return; }

    const db = getDb();
    const totalCards  = (db.prepare("SELECT COUNT(*) as cnt FROM cards").get() as any)?.cnt ?? 0;
    const shoobCards  = (db.prepare("SELECT COUNT(*) as cnt FROM cards WHERE source = 'shoob'").get() as any)?.cnt ?? 0;
    const trackedIds  = (db.prepare("SELECT COUNT(*) as cnt FROM shoob_imported_ids").get() as any)?.cnt ?? 0;
    const lastRun     = db.prepare("SELECT ran_at, run_type FROM shoob_sync_log ORDER BY ran_at DESC LIMIT 1").get() as any;

    res.json({
      source: "shoob.gg",
      status: "ready",
      total_cards: totalCards,
      shoob_cards: shoobCards,
      tracked_ids: trackedIds,
      last_run: lastRun ? new Date(lastRun.ran_at * 1000).toISOString() : null,
      last_run_type: lastRun?.run_type ?? null,
    });
  } catch (err: any) {
    logger.error({ err }, "Scraper status error");
    res.status(500).json({ success: false, message: err?.message || "Failed to fetch status" });
  }
});

router.get("/scraper/history", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false, message: "Not authenticated" }); return; }
    const staffRow = getStaff(userId);
    const BOT_OWNER = (process.env["OWNER_NUMBERS"] || process.env["BOT_OWNER_PHONE"] || "2348144550593").split(",")[0].replace(/\D/g, "");
    const isStaff = !!staffRow || userId.replace(/\D/g, "") === BOT_OWNER;
    if (!isStaff) { res.status(403).json({ success: false, message: "Only staff can view sync history." }); return; }

    const db = getDb();
    const logs = db.prepare("SELECT * FROM shoob_sync_log ORDER BY ran_at DESC LIMIT 20").all() as any[];
    const result = logs.map((r: any) => ({
      timestamp: new Date(r.ran_at * 1000).toISOString(),
      run_type: r.run_type,
      cards_added: r.imported,
      updated: r.updated,
      skipped: r.skipped,
      errors: r.errors,
      total_seen: r.total_seen,
      duration_ms: r.duration_ms,
      started_by: r.started_by,
      success: r.errors === 0,
    }));
    res.json(result);
  } catch (err: any) {
    logger.error({ err }, "Scraper history error");
    res.status(500).json({ success: false, message: err?.message || "Failed to fetch history" });
  }
});

router.post("/scraper/run", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false, message: "Not authenticated" }); return; }
    const staffRow = getStaff(userId);
    const BOT_OWNER = (process.env["OWNER_NUMBERS"] || process.env["BOT_OWNER_PHONE"] || "2348144550593").split(",")[0].replace(/\D/g, "");
    const isStaff = !!staffRow || userId.replace(/\D/g, "") === BOT_OWNER;
    if (!isStaff) { res.status(403).json({ success: false, message: "Only staff can trigger sync." }); return; }

    const db = getDb();
    const runMode = (req.body?.mode === "full") ? "full" : "incremental";
    const uploader = userId.replace(/\D/g, "");

    // ── Try Playwright scraper first (architecture-compliant) ──────────────
    try {
      const { runPlaywrightScraper } = await import("../../scraper/shoob-playwright.js");
      const result = await runPlaywrightScraper({
        syncOnly: runMode === "incremental",
        uploader,
        onProgress: undefined, // web-triggered: no streaming progress
        maxPage: runMode === "incremental" ? 100 : undefined, // cap incremental web runs
      });

      res.json({
        success: true,
        method: "playwright",
        mode: runMode,
        imported: result.imported,
        updated: result.updated,
        skipped: result.skipped,
        errors: result.errors,
        total_seen: result.totalSeen,
        pages_scraped: result.pagesScraped,
        duration_ms: result.durationMs,
      });
      return;
    } catch (pwErr: any) {
      logger.warn({ pwErr }, "Playwright unavailable for web scraper/run — using REST fallback");
    }

    // ── REST API fallback ──────────────────────────────────────────────────
    let imported = 0, updated = 0, skipped = 0, errors = 0, totalSeen = 0;
    let page = 1;
    const idChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const normTier = (raw: any, fb = "T1"): string => {
      if (!raw) return fb;
      const s = String(raw).trim().toUpperCase();
      if (s.startsWith("T") && ["T1","T2","T3","T4","T5","T6","TS","TX","TZ"].includes(s)) return s;
      if (/^\d$/.test(s)) return `T${s}`;
      if (s === "S") return "TS";
      if (s === "X") return "TX";
      if (s === "Z") return "TZ";
      return fb;
    };

    const startMs = Date.now();
    try {
      while (true) {
        const url = `${SHOOB_API}/site/api/cards?page=${page}`;
        const apiRes = await fetch(url, {
          headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; RequiemOrderBot/1.0)" },
          signal: AbortSignal.timeout(20000),
        });
        if (!apiRes.ok) break;
        const apiData: any = await apiRes.json();
        const pageCards: any[] = Array.isArray(apiData) ? apiData : (apiData.cards || apiData.data || apiData.results || []);
        if (!pageCards.length) break;
        totalSeen += pageCards.length;

        for (const sc of pageCards) {
          const shoobId = String(sc._id || sc.id || "").trim();
          if (!shoobId) { skipped++; continue; }

          if (runMode === "incremental") {
            const already = db.prepare("SELECT local_card_id FROM shoob_imported_ids WHERE shoob_id = ?").get(shoobId);
            if (already) { skipped++; continue; }
          }

          const cardName = (sc.name || sc.slug || shoobId).trim().replace(/_/g, " ");
          const tier = normTier(sc.tier);
          const series = (Array.isArray(sc.category) && sc.category[0]) ? String(sc.category[0]).trim() : "Shoob";

          const file   = String(sc.file || "").toLowerCase();
          const isGif  = file.endsWith(".gif");
          const isWebm = sc.has_webm === true;
          const animated = (
            isGif || isWebm ||
            sc.has_webp === true ||
            sc.patched === true ||
            ["T6","TS","TX","TZ"].includes(tier)
          ) ? 1 : 0;

          const mediaUrl = isWebm
            ? `${SHOOB_API}/site/api/cardr/${shoobId}?type=webm`
            : `${SHOOB_API}/site/api/cardr/${shoobId}?size=400`;

          const rawJson  = JSON.stringify(sc);
          const fileHash = sc.file || "";
          const hasWebm  = sc.has_webm ? 1 : 0;
          const hasWebp  = sc.has_webp ? 1 : 0;
          const slug     = sc.slug || "";

          const existingByShoobId = db.prepare("SELECT id FROM cards WHERE shoob_id = ?").get(shoobId) as any;
          if (existingByShoobId) {
            db.prepare("UPDATE cards SET name=?,tier=?,series=?,is_animated=?,raw_data=?,file_hash=?,has_webm=?,has_webp=?,slug=?,source='shoob' WHERE id=?")
              .run(cardName, tier, series, animated, rawJson, fileHash, hasWebm, hasWebp, slug, existingByShoobId.id);
            db.prepare("INSERT OR IGNORE INTO shoob_imported_ids (shoob_id, local_card_id) VALUES (?,?)")
              .run(shoobId, existingByShoobId.id);
            updated++;
            continue;
          }

          let imageData: Buffer | null = null;
          try {
            const mRes = await fetch(mediaUrl, {
              headers: { "User-Agent": "Mozilla/5.0 (compatible; RequiemOrderBot/1.0)" },
              signal: AbortSignal.timeout(30000),
            });
            if (mRes.ok) {
              const buf = Buffer.from(await mRes.arrayBuffer());
              if (!isWebm && !isGif) {
                try {
                  const sharp = (await import("sharp")).default;
                  imageData = await sharp(buf).resize(800,1100,{fit:"inside",withoutEnlargement:true}).jpeg({quality:92}).toBuffer();
                } catch { imageData = buf; }
              } else {
                imageData = buf;
              }
            }
          } catch { errors++; }

          const { randomBytes } = await import("crypto");
          let localId = "C" + Date.now().toString(36).toUpperCase();
          for (let a = 0; a < 50; a++) {
            const bytes = randomBytes(8);
            const cand = Array.from(bytes as Buffer).map((b: number) => idChars[b % idChars.length]).join("");
            if (!db.prepare("SELECT 1 FROM cards WHERE id = ?").get(cand)) { localId = cand; break; }
          }

          try {
            db.prepare("INSERT INTO cards (id,name,series,tier,image_data,is_animated,uploaded_by,source,shoob_id,raw_data,file_hash,has_webm,has_webp,slug) VALUES (?,?,?,?,?,?,?,'shoob',?,?,?,?,?,?)")
              .run(localId, cardName, series, tier, imageData, animated, uploader, shoobId, rawJson, fileHash, hasWebm, hasWebp, slug);
            db.prepare("INSERT OR IGNORE INTO shoob_imported_ids (shoob_id, local_card_id) VALUES (?,?)").run(shoobId, localId);
            imported++;
          } catch { errors++; }

          await new Promise(r => setTimeout(r, 100));
        }
        if (pageCards.length < SHOOB_PAGE_SIZE) break;
        page++;
        if (runMode === "incremental" && imported + updated >= 200) break;
      }
    } catch (loopErr: any) {
      logger.warn({ loopErr }, "REST fallback sync loop error");
    }

    const durationMs = Date.now() - startMs;
    db.prepare(
      "INSERT INTO shoob_sync_log (run_type, started_by, imported, updated, skipped, errors, total_seen, duration_ms, ran_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(`rest-${runMode}`, uploader, imported, updated, skipped, errors, totalSeen, durationMs, Math.floor(Date.now() / 1000));

    res.json({
      success: true,
      method: "rest-fallback",
      mode: runMode,
      imported,
      updated,
      skipped,
      errors,
      total_seen: totalSeen,
      duration_ms: durationMs,
    });
  } catch (err: any) {
    logger.error({ err }, "Scraper run error");
    res.status(500).json({ success: false, message: err?.message || "Scraper run failed" });
  }
});
