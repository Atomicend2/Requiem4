import {
  makeWASocket,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  Browsers,
  type WASocket,
  type BaileysEventMap,
} from "@whiskeysockets/baileys";
import { useMongoAuthState } from "./db/mongo-auth.js";
import { col } from "./db/mongo.js";
import { Boom } from "@hapi/boom";
import path from "path";
import fs from "fs";
import { spawnSync } from "child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "../lib/logger.js";
import { handleMessage } from "./handlers/message.js";
import { handleGroupUpdate, handleGroupParticipantsUpdate } from "./handlers/group.js";

// DATA_DIR env var lets you point auth + DB at a persistent mount (e.g. Render Disk at /data).
// MUST match the DATA_DIR value in database.ts — both must point to the same persistent disk.
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(process.cwd(), "data");
const AUTH_DIR = path.join(DATA_DIR, "auth");
// Store pairing number outside AUTH_DIR so it survives a logout/wipe
const PAIRING_PHONE_PATH = path.join(DATA_DIR, "paired-phone.txt");

if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

// Migrate paired-phone.txt from old location (inside auth/) to data/ if needed
const OLD_PAIRING_PHONE_PATH = path.join(AUTH_DIR, "paired-phone.txt");
if (!fs.existsSync(PAIRING_PHONE_PATH) && fs.existsSync(OLD_PAIRING_PHONE_PATH)) {
  try {
    fs.copyFileSync(OLD_PAIRING_PHONE_PATH, PAIRING_PHONE_PATH);
    fs.rmSync(OLD_PAIRING_PHONE_PATH, { force: true });
  } catch { /* ignore */ }
}

// ─── Owner Identity ───────────────────────────────────────────────────────────
//
// PHONE vs LID — these are two completely different things:
//
//   PHONE  →  the real phone number, e.g. 2348144550593
//             Used as the primary DB key (users.id / users.phone).
//             Used to SEND WhatsApp messages (phone@s.whatsapp.net).
//
//   LID    →  WhatsApp's internal numeric identifier, e.g. 101014040526896
//             Assigned by WhatsApp servers; NOT derived from the phone number.
//             Stored in users.lid column for cross-reference only.
//             You must NEVER use a LID where a phone number is expected.
//
// BOT_OWNER_PHONE  →  set this in .env to your plain phone number (digits only).
// BOT_OWNER_LID    →  set this in .env to your WhatsApp LID (digits only).
//                     Used only for LID-based lookups (not for sending or DB keys).
//
// Both default to the values below if not set in .env.

export const BOT_OWNER_PHONE = (process.env["BOT_OWNER_PHONE"] || "2347056705430").replace(/\D/g, "");
export const BOT_OWNER_LID   = (process.env["BOT_OWNER_LID"]   || "166761483776248").replace(/\D/g, "");

// Normalize a phone-like string to digits only (E.164 without +)
export function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, "");
}

// All owner phone numbers from env + the hardcoded default
export function getOwnerNumbers(): string[] {
  const envOwners = (process.env["OWNER_NUMBERS"] || "")
    .split(",")
    .map((n) => normalizePhone(n.trim()))
    .filter(Boolean);
  const defaultOwner = normalizePhone(BOT_OWNER_PHONE);
  const all = new Set([defaultOwner, ...envOwners]);
  return [...all].filter(Boolean);
}

// Returns true when the given plain phone number belongs to an owner
export function isOwnerPhone(phone: string): boolean {
  const normalized = normalizePhone(phone);
  return getOwnerNumbers().includes(normalized);
}

// Returns true when the given LID (digits only or @lid JID) belongs to the owner
export function isOwnerLid(lid: string): boolean {
  const lidNum = lid.split("@")[0].replace(/\D/g, "");
  return lidNum === BOT_OWNER_LID;
}

export const PREFIX = ".";

let sock: WASocket | null = null;
let overrideSock: WASocket | null = null; // set by bot-manager when a managed bot is active
let overrideConnected = false;
let isConnected = false;
let isConnecting = false;
let pairingCode: string | null = null;
let reconnectAttempts = 0;
let connectionGeneration = 0;
let isShuttingDown = false;
const MAX_RECONNECT_DELAY = 30000;
const STABLE_CONNECTION_MS = 30000;
const replyContext = new AsyncLocalStorage<any>();

/** Called by bot-manager when a managed bot connects/disconnects. */
export function setActiveSock(s: WASocket | null, connected = false): void {
  overrideSock = s;
  overrideConnected = connected;
}

function getActiveSock(): WASocket {
  const active = overrideSock || sock;
  if (!active) throw new Error("Socket not initialized");
  return active;
}

type ConnectOptions = {
  promptForPhone?: boolean;
};

export function getSocket(): WASocket | null {
  return sock;
}

export function getAnySock(): WASocket | null {
  return overrideSock || sock;
}

export function isSocketConnected(): boolean {
  return overrideConnected || isConnected;
}

export function isSocketConnecting(): boolean {
  return isConnecting;
}

export function getPairingCode(): string | null {
  return pairingCode;
}

export async function gracefulShutdown(): Promise<void> {
  isShuttingDown = true;
  connectionGeneration++; // prevent any pending reconnect timers from firing
  if (sock) {
    try {
      await sock.end(undefined);
    } catch { /* ignore */ }
    sock = null;
  }
  isConnected = false;
  isConnecting = false;
}

export function getBotName(): string {
  return sock?.user?.name || "Requiem Order";
}

export function getBotPhone(): string {
  return sock?.user?.id?.split("@")[0]?.split(":")[0] || "";
}

export async function runWithReplyContext<T>(msg: any, fn: () => Promise<T>): Promise<T> {
  return replyContext.run(msg, fn);
}

function withReplyOptions(options?: any) {
  const quoted = replyContext.getStore();
  if (!quoted) return options;
  return { quoted, ...(options || {}) };
}

function normalizePhoneNumber(phoneNumber?: string): string | undefined {
  const normalized = phoneNumber?.replace(/\D/g, "");
  return normalized || undefined;
}

export function rememberPairingPhoneNumber(phoneNumber?: string): string | undefined {
  const normalized = normalizePhoneNumber(phoneNumber);
  if (!normalized) return undefined;
  fs.writeFileSync(PAIRING_PHONE_PATH, normalized, "utf8");
  return normalized;
}

function getRememberedPairingPhoneNumber(): string | undefined {
  try {
    return normalizePhoneNumber(fs.readFileSync(PAIRING_PHONE_PATH, "utf8"));
  } catch {
    return undefined;
  }
}


export async function connectToWhatsApp(phoneNumber?: string, options: ConnectOptions = {}): Promise<WASocket> {
  if (sock && (isConnected || isConnecting)) {
    return sock;
  }
  isConnecting = true;
  const generation = ++connectionGeneration;
  const { state, saveCreds } = await useMongoAuthState("primary");
  const { version, isLatest } = await fetchLatestBaileysVersion();
  const browser = Browsers.ubuntu("Chrome");
  logger.info({ version, isLatest, browser }, "Using WhatsApp Web pairing identity");

  const silentLogger = {
    level: "silent" as const,
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    child: () => silentLogger,
  };

  // Simple in-memory group metadata cache so welcome/leave messages
  // can fetch participant lists without an extra network round-trip.
  const groupMetaCache = new Map<string, { data: any; ts: number }>();
  const GROUP_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  function cacheGroupMeta(jid: string, data: any) {
    groupMetaCache.set(jid, { data, ts: Date.now() });
  }

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, silentLogger),
    },
    printQRInTerminal: false,
    logger: silentLogger,
    browser,
    generateHighQualityLinkPreview: true,
    syncFullHistory: false,
    markOnlineOnConnect: true,
    retryRequestDelayMs: 1000,
    maxMsgRetryCount: 5,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
    cachedGroupMetadata: async (jid) => {
      const cached = groupMetaCache.get(jid);
      if (cached && Date.now() - cached.ts < GROUP_CACHE_TTL_MS) return cached.data;
      return undefined;
    },
  });

  if (!state.creds.registered) {
    logger.info("Bot not registered — pair via Admin Panel > Bot Manager");
  }

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "close") {
      if (generation !== connectionGeneration) return;
      isConnected = false;
      isConnecting = false;
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const reason = (lastDisconnect?.error as any)?.message || (lastDisconnect?.error as Boom)?.output?.payload?.message || "unknown";
      const shouldReconnect =
        statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
        reconnectAttempts++;
        logger.warn({ delay, attempt: reconnectAttempts, statusCode, reason }, "WhatsApp connection closed; reconnecting");
        setTimeout(() => {
          if (generation === connectionGeneration && !isConnected && !isConnecting) {
            connectToWhatsApp(undefined, { promptForPhone: false });
          }
        }, delay);
      } else {
        // If we're shutting down intentionally, don't wipe auth — preserve creds for next startup
        if (isShuttingDown) {
          logger.info("Shutting down — skipping auth wipe");
          return;
        }
        logger.info("Logged out from WhatsApp — clearing auth");
        pairingCode = null;
        col("wa_auth").deleteMany({ bot_id: "primary" }).catch(() => {});
        // Auto-reconnect — re-pair manually via Admin Panel > Bot Manager
        setTimeout(() => {
          if (generation === connectionGeneration) {
            logger.info("Auto-reconnecting after logout (no phone — pair via Bot Manager)");
            connectToWhatsApp();
          }
        }, 3000);
      }
    } else if (connection === "open") {
      if (generation !== connectionGeneration) return;
      isConnected = true;
      isConnecting = false;
      pairingCode = null;
      logger.info("Connected to WhatsApp successfully");
      // Sync owner phone numbers to staff table.
      // We do NOT insert into users here — the owner gets a users row naturally
      // when they send their first WhatsApp message. Inserting here would
      // show unregistered owners in member counts and leaderboards.
      try {
        const { addStaff, getStaff, updateUser } = await import("./db/queries.js");
        for (const phone of getOwnerNumbers()) {
          const existing = await getStaff(phone);
          if (!existing) {
            await addStaff(phone, "owner", "system");
          }
          if (BOT_OWNER_LID) {
            await updateUser(phone, { lid: BOT_OWNER_LID }).catch(() => {});
          }
        }
        logger.info({ owners: getOwnerNumbers(), ownerLid: BOT_OWNER_LID }, "Owner numbers synced to staff");
      } catch (err) {
        logger.warn({ err }, "Failed to sync owner numbers");
      }
      setTimeout(() => {
        if (generation === connectionGeneration && isConnected) {
          reconnectAttempts = 0;
        }
      }, STABLE_CONNECTION_MS);
    } else if (connection === "connecting") {
      if (generation !== connectionGeneration) return;
      isConnecting = true;
      logger.info("Connecting to WhatsApp...");
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    if (m.type !== "notify") return;
    for (const msg of m.messages) {
      if (!msg.message) continue;
      if (msg.key.fromMe) continue;
      try {
        await handleMessage(sock!, msg);
      } catch (err) {
        logger.error({ err }, "Error handling message");
      }
    }
  });

  sock.ev.on("group-participants.update", async (update) => {
    try {
      // Invalidate cached metadata so welcome/leave handlers see fresh participants
      groupMetaCache.delete(update.id);
      await handleGroupParticipantsUpdate(sock!, update as any);
    } catch (err) {
      logger.error({ err }, "Error handling group participants update");
    }
  });

  sock.ev.on("groups.update", async (updates) => {
    try {
      // Keep cache fresh when group info changes (name, description, etc.)
      for (const u of updates) {
        if (u.id) groupMetaCache.delete(u.id);
      }
      await handleGroupUpdate(sock!, updates);
    } catch (err) {
      logger.error({ err }, "Error handling groups update");
    }
  });

  // Warm the group metadata cache whenever Baileys delivers a full metadata object
  sock.ev.on("messaging-history.set", ({ chats }) => {
    for (const chat of chats) {
      if (chat.id?.endsWith("@g.us") && (chat as any).metadata) {
        cacheGroupMeta(chat.id, (chat as any).metadata);
      }
    }
  });

  return sock;
}

async function sendWithRetry(fn: () => Promise<any>, retries = 4): Promise<any> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const isRateLimit =
        err?.message?.includes("rate-overlimit") ||
        err?.output?.payload?.message?.includes("rate-overlimit") ||
        err?.data === 429;
      if (isRateLimit && attempt < retries) {
        const delay = Math.min(2000 * Math.pow(2, attempt), 30000);
        logger.warn({ attempt, delay, jid: err?.jid }, "Rate-overlimit hit, retrying after delay");
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

export async function sendMessage(jid: string, content: any, options?: any) {
  const s = getActiveSock();
  return sendWithRetry(() => s.sendMessage(jid, content, withReplyOptions(options)));
}

export async function sendText(jid: string, text: string, mentions?: string[]) {
  const s = getActiveSock();
  // Auto-detect @phonenumber patterns in text and ensure they are in the mentions
  // array. WhatsApp ONLY renders tappable blue mentions when the JID is in the
  // mentions array — the @number in the text string alone is never enough.
  const autoMentions = [...text.matchAll(/@(\d{7,15})\b/g)]
    .map(m => `${m[1]}@s.whatsapp.net`);
  const allMentions = [...new Set([...(mentions ?? []), ...autoMentions])];
  return sendWithRetry(() => s.sendMessage(jid, { text, mentions: allMentions }, withReplyOptions()));
}

export async function sendImage(jid: string, imageBuffer: Buffer, caption?: string, mentions?: string[]) {
  const s = getActiveSock();
  return sendWithRetry(() => s.sendMessage(jid, { image: imageBuffer, caption: caption || "", mentions }, withReplyOptions()));
}

export async function sendVideo(jid: string, videoBuffer: Buffer, caption?: string) {
  const s = getActiveSock();
  return sendWithRetry(() => s.sendMessage(jid, { video: videoBuffer, gifPlayback: true, mimetype: "video/mp4", caption: caption || "" }, withReplyOptions()));
}

/**
 * Convert an animated buffer (GIF or WebM) to H.264 MP4 using ffmpeg.
 * WhatsApp requires MP4 for all video/gif messages.
 * Returns null if ffmpeg fails or is unavailable.
 */
function animatedToMp4(buf: Buffer, srcExt: "gif" | "webm"): Buffer | null {
  try {
    const uid = Date.now();
    const tmpIn  = path.join("/tmp", `wa_anim_${uid}.${srcExt}`);
    const tmpOut = path.join("/tmp", `wa_anim_${uid}.mp4`);
    fs.writeFileSync(tmpIn, buf);

    // For GIFs: force 15 fps so variable-delay frames are all preserved.
    // For WebM: let ffmpeg infer the fps from the source.
    const gifArgs = srcExt === "gif" ? ["-r", "15"] : [];

    // WebM files usually carry Opus/Vorbis audio — convert to AAC.
    // Even for silent sources (GIF/WebM with no audio), WhatsApp on some
    // endpoints requires an active audio track, so inject a silent one.
    const audioArgs = [
      "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-c:a", "aac", "-b:a", "128k",
      "-shortest",
    ];

    const result = spawnSync("ffmpeg", [
      "-y",
      ...(srcExt === "gif" ? ["-f", "gif"] : []),
      "-i", tmpIn,
      ...gifArgs,
      ...audioArgs,
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-c:v", "libx264", "-profile:v", "main", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart", "-preset", "fast",
      tmpOut,
    ], { timeout: 60000 });

    fs.unlinkSync(tmpIn);
    if (result.status !== 0) {
      logger.warn({ stderr: result.stderr?.toString(), srcExt }, "ffmpeg animated→MP4 failed");
      return null;
    }
    const mp4 = fs.readFileSync(tmpOut);
    fs.unlinkSync(tmpOut);
    return mp4;
  } catch (err) {
    logger.warn({ err }, "animatedToMp4 error");
    return null;
  }
}

export async function sendMedia(jid: string, buffer: Buffer, isAnimated: boolean, caption?: string, mentions?: string[]) {
  if (!isAnimated) return sendImage(jid, buffer, caption, mentions);

  const s = getActiveSock();

  // Detect format by magic bytes
  const isGif  = buffer.length >= 4
    && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46; // "GIF"

  const isWebm = buffer.length >= 4
    && buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3;

  const isMp4  = buffer.length > 8
    && buffer.slice(4, 8).toString("ascii") === "ftyp";

  // GIF — must convert to MP4 (WhatsApp rejects .gif entirely)
  if (isGif) {
    const mp4 = animatedToMp4(buffer, "gif");
    if (mp4) {
      return sendWithRetry(() =>
        s.sendMessage(jid, { video: mp4, gifPlayback: true, mimetype: "video/mp4", caption: caption || "", mentions }, withReplyOptions())
      );
    }
    logger.warn("GIF→MP4 failed, falling back to static image");
    return sendImage(jid, buffer, caption, mentions);
  }

  // WebM — convert to MP4 for maximum WhatsApp compatibility
  if (isWebm) {
    const mp4 = animatedToMp4(buffer, "webm");
    if (mp4) {
      return sendWithRetry(() =>
        s.sendMessage(jid, { video: mp4, gifPlayback: true, mimetype: "video/mp4", caption: caption || "", mentions }, withReplyOptions())
      );
    }
    logger.warn("WebM→MP4 failed, falling back to static image");
    return sendImage(jid, buffer, caption, mentions);
  }

  // Already MP4 (or unknown animated format) — send directly
  return sendWithRetry(() =>
    s.sendMessage(jid, { video: buffer, gifPlayback: true, mimetype: "video/mp4", caption: caption || "", mentions }, withReplyOptions())
  );
}

export async function sendReact(jid: string, msgKey: any, emoji: string) {
  const s = getActiveSock();
  return s.sendMessage(jid, { react: { text: emoji, key: msgKey } });
}

function getMessageTimestampMs(msg: any): number {
  const raw = msg.messageTimestamp;
  const seconds =
    typeof raw === "number"
      ? raw
      : typeof raw === "bigint"
        ? Number(raw)
        : Number(raw?.low || raw || 0);
  return seconds > 0 ? seconds * 1000 : 0;
}
