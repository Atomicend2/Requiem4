import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  Browsers,
  type WASocket,
  type BaileysEventMap,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import path from "path";
import fs from "fs";
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

export const BOT_OWNER_PHONE = (process.env["BOT_OWNER_PHONE"] || "2348144550593").replace(/\D/g, "");
export const BOT_OWNER_LID   = (process.env["BOT_OWNER_LID"]   || "101014040526896").replace(/\D/g, "");

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
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
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
        // Wipe only the auth credentials
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        fs.mkdirSync(AUTH_DIR, { recursive: true });
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
        const { getDb } = await import("./db/database.js");
        const db = getDb();
        for (const phone of getOwnerNumbers()) {
          // Use bare phone as user_id (consistent with normalizeUserId)
          const existingStaff = db.prepare("SELECT 1 FROM staff WHERE user_id = ?").get(phone);
          if (!existingStaff) {
            db.prepare("INSERT OR REPLACE INTO staff (user_id, role, added_by, added_at) VALUES (?, 'owner', 'system', unixepoch())").run(phone);
          }
          // Also ensure lid is stored on the owner's users row if the row exists
          const ownerLid = BOT_OWNER_LID;
          if (ownerLid) {
            db.prepare("UPDATE users SET lid = ? WHERE id = ? AND (lid IS NULL OR lid = '' OR lid = id)")
              .run(ownerLid, phone);
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
      await handleGroupParticipantsUpdate(sock!, update as any);
    } catch (err) {
      logger.error({ err }, "Error handling group participants update");
    }
  });

  sock.ev.on("groups.update", async (updates) => {
    try {
      await handleGroupUpdate(sock!, updates);
    } catch (err) {
      logger.error({ err }, "Error handling groups update");
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
  return sendWithRetry(() => s.sendMessage(jid, { text, mentions: mentions || [] }, withReplyOptions()));
}

export async function sendImage(jid: string, imageBuffer: Buffer, caption?: string) {
  const s = getActiveSock();
  return sendWithRetry(() => s.sendMessage(jid, { image: imageBuffer, caption: caption || "" }, withReplyOptions()));
}

export async function sendVideo(jid: string, videoBuffer: Buffer, caption?: string) {
  const s = getActiveSock();
  return sendWithRetry(() => s.sendMessage(jid, { video: videoBuffer, gifPlayback: true, mimetype: "video/mp4", caption: caption || "" }, withReplyOptions()));
}

export async function sendMedia(jid: string, buffer: Buffer, isVideo: boolean, caption?: string) {
  return isVideo ? sendVideo(jid, buffer, caption) : sendImage(jid, buffer, caption);
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
