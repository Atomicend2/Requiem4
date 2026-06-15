import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { getDb } from "./db/database.js";
import { logger } from "../lib/logger.js";
import { setActiveSock } from "./connection.js";
import { handleMessage } from "./handlers/message.js";
import { handleGroupUpdate, handleGroupParticipantsUpdate } from "./handlers/group.js";
import { DEFAULT_PERSONA, isValidPersona, type PersonaKey } from "./commands/personas.js";
import fs from "fs";
import Pino from "pino";

export interface BotStatusInfo {
  id: string;
  name: string;
  phone: string;
  status: "disconnected" | "connecting" | "pairing" | "connected";
  pairingCode: string | null;
  isPrimary: boolean;
  imageUrl: string;
  persona: PersonaKey;
}

interface LiveInstance {
  sock: any;
  status: BotStatusInfo["status"];
  pairingCode: string | null;
}

const live = new Map<string, LiveInstance>();

// Maps a live WASocket instance back to its bot row id, so message handlers
// (which only receive the socket) can resolve which AI personality should
// respond. See getPersonaForSock().
const sockBotIds = new WeakMap<object, string>();

export async function startBot(botId: string): Promise<void> {
  const existing = live.get(botId);
  if (existing && (existing.status === "connected" || existing.status === "connecting" || existing.status === "pairing")) {
    return;
  }

  const db = getDb();
  const row = db.prepare("SELECT * FROM bots WHERE id = ?").get(botId) as any;
  if (!row) throw new Error(`Bot ${botId} not found`);

  const authDir = row.auth_dir || `data/bots/${botId}/auth`;
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  let version: any;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch (err) {
    logger.warn({ err, botId }, "Could not fetch latest Baileys version, using fallback");
    version = [2, 3000, 1015901307];
  }
  const silent = Pino({ level: "silent" }) as any;

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, silent),
    },
    printQRInTerminal: false,
    logger: silent,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    browser: ["Ubuntu", "Chrome", "22.04.4"],
  });

  const inst: LiveInstance = { sock, status: "connecting", pairingCode: null };
  live.set(botId, inst);
  sockBotIds.set(sock, botId);
  db.prepare("UPDATE bots SET status = 'connecting' WHERE id = ?").run(botId);

  // Prevent uncaught "error" events from crashing the process
  sock.ws?.on?.("error", (err: any) => {
    logger.warn({ err, botId }, "Managed bot socket error (handled)");
  });
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update: any) => {
    if (update.pairingCode) {
      inst.pairingCode = update.pairingCode;
      inst.status = "pairing";
      db.prepare("UPDATE bots SET status = 'pairing' WHERE id = ?").run(botId);
      logger.info({ botId, code: update.pairingCode }, "Pairing code ready for managed bot");
    }

    if (update.connection === "open") {
      inst.status = "connected";
      inst.pairingCode = null;
      const phone = sock.user?.id?.split("@")[0]?.split(":")[0] || row.phone;
      db.prepare("UPDATE bots SET status = 'connected', phone = ? WHERE id = ?").run(phone, botId);
      logger.info({ botId, name: row.name }, "Managed bot connected");
      // Make this bot the active socket so all sendText/sendImage/sendMessage calls route through it
      setActiveSock(sock, true);
    }

    if (update.connection === "close") {
      const code = (update.lastDisconnect?.error as any)?.output?.statusCode;
      inst.status = "disconnected";
      db.prepare("UPDATE bots SET status = 'disconnected' WHERE id = ?").run(botId);
      logger.info({ botId, code }, "Managed bot disconnected");
      // Clear the active sock override so we don't try to send through a dead socket
      setActiveSock(null, false);
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(() => startBot(botId).catch(() => {}), 8000);
      } else {
        live.delete(botId);
      }
    }
  });

  sock.ev.on("messages.upsert", async (m: any) => {
    if (m.type !== "notify") return;
    for (const msg of m.messages) {
      if (!msg.message) continue;
      if (msg.key.fromMe) continue;
      try {
        await handleMessage(sock, msg);
      } catch (err) {
        logger.error({ err, botId }, "Managed bot error handling message");
      }
    }
  });

  sock.ev.on("group-participants.update", async (update: any) => {
    try {
      await handleGroupParticipantsUpdate(sock, update as any);
    } catch (err) {
      logger.error({ err, botId }, "Managed bot error handling group participants update");
    }
  });

  sock.ev.on("groups.update", async (updates: any) => {
    try {
      await handleGroupUpdate(sock, updates);
    } catch (err) {
      logger.error({ err, botId }, "Managed bot error handling groups update");
    }
  });

  if (!state.creds.registered && row.phone) {
    try {
      await new Promise((r) => setTimeout(r, 3000));
      const phoneDigits = row.phone.replace(/\D/g, "");
      if (phoneDigits.length >= 7) {
        const code = await sock.requestPairingCode(phoneDigits);
        inst.pairingCode = code;
        inst.status = "pairing";
        db.prepare("UPDATE bots SET status = 'pairing' WHERE id = ?").run(botId);
        logger.info({ botId, code }, "Pairing code generated");
      }
    } catch (err) {
      logger.warn({ err, botId }, "Could not get pairing code for managed bot");
    }
  }
}

export async function stopBot(botId: string): Promise<void> {
  const inst = live.get(botId);
  if (!inst) return;
  try { await inst.sock?.logout(); } catch {}
  inst.status = "disconnected";
  live.delete(botId);
  const db = getDb();
  db.prepare("UPDATE bots SET status = 'disconnected' WHERE id = ?").run(botId);
}

export async function disconnectBot(botId: string): Promise<void> {
  const inst = live.get(botId);
  if (!inst) return;
  try { inst.sock?.end(undefined); } catch {}
  inst.status = "disconnected";
  live.delete(botId);
  const db = getDb();
  db.prepare("UPDATE bots SET status = 'disconnected' WHERE id = ?").run(botId);
}

export function getAllBotsStatus(): BotStatusInfo[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM bots ORDER BY is_primary DESC, created_at ASC").all() as any[];
  return rows.map((row) => {
    const inst = live.get(row.id);
    return {
      id: row.id,
      name: row.name,
      phone: row.phone || "",
      status: (inst?.status || row.status || "disconnected") as BotStatusInfo["status"],
      pairingCode: inst?.pairingCode || null,
      isPrimary: !!row.is_primary,
      imageUrl: row.menu_image_url || row.image_url || "",
      persona: isValidPersona(row.persona) ? row.persona : DEFAULT_PERSONA,
    };
  });
}

export function getBotStatusInfo(botId: string): BotStatusInfo | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM bots WHERE id = ?").get(botId) as any;
  if (!row) return null;
  const inst = live.get(botId);
  return {
    id: row.id,
    name: row.name,
    phone: row.phone || "",
    status: (inst?.status || row.status || "disconnected") as BotStatusInfo["status"],
    pairingCode: inst?.pairingCode || null,
    isPrimary: !!row.is_primary,
    imageUrl: row.menu_image_url || row.image_url || "",
    persona: isValidPersona(row.persona) ? row.persona : DEFAULT_PERSONA,
  };
}

/**
 * Sets the AI companion personality for a managed bot.
 * See bot/commands/personas.ts for the full registry of available personas.
 */
export function setBotPersona(botId: string, persona: PersonaKey): void {
  const db = getDb();
  db.prepare("UPDATE bots SET persona = ? WHERE id = ?").run(persona, botId);
}

/**
 * Resolves the AI companion personality that should respond on a given
 * WhatsApp socket. Falls back to the primary bot's persona, then the
 * system default, if the socket isn't a managed multi-bot instance
 * (e.g. the legacy single-bot connection).
 */
export function getPersonaForSock(sock: any): PersonaKey {
  const db = getDb();
  const botId = sockBotIds.get(sock);
  if (botId) {
    const row = db.prepare("SELECT persona FROM bots WHERE id = ?").get(botId) as any;
    if (row && isValidPersona(row.persona)) return row.persona;
  }
  const primary = db.prepare("SELECT persona FROM bots WHERE is_primary = 1 LIMIT 1").get() as any;
  if (primary && isValidPersona(primary.persona)) return primary.persona;
  return DEFAULT_PERSONA;
}

export async function requestBotPairingCode(botId: string, phone: string): Promise<string> {
  const db = getDb();
  const row = db.prepare("SELECT * FROM bots WHERE id = ?").get(botId) as any;
  if (!row) throw new Error(`Bot ${botId} not found`);

  const phoneDigits = phone.replace(/\D/g, "");
  if (phoneDigits.length < 7) throw new Error("Invalid phone number");

  // Save the phone for future reconnects
  db.prepare("UPDATE bots SET phone = ? WHERE id = ?").run(phoneDigits, botId);

  const inst = live.get(botId);
  if (!inst || !inst.sock) {
    // Start the bot first, then it will auto-request the pairing code
    await startBot(botId);
    // Wait briefly then check
    await new Promise((r) => setTimeout(r, 4000));
    const updated = live.get(botId);
    if (updated?.pairingCode) return updated.pairingCode;
    throw new Error("Bot starting — check status in a few seconds for the pairing code");
  }

  try {
    const code = await inst.sock.requestPairingCode(phoneDigits);
    inst.pairingCode = code;
    inst.status = "pairing";
    db.prepare("UPDATE bots SET status = 'pairing' WHERE id = ?").run(botId);
    return code;
  } catch (err: any) {
    throw new Error(err?.message || "Failed to request pairing code");
  }
}

export function setPrimaryBot(botId: string): void {
  const db = getDb();
  db.prepare("UPDATE bots SET is_primary = 0").run();
  db.prepare("UPDATE bots SET is_primary = 1 WHERE id = ?").run(botId);
}

export async function initManagedBots(): Promise<void> {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM bots").all() as any[];
  for (const row of rows) {
    if (row.is_primary || row.status === "connected") {
      startBot(row.id).catch((err) =>
        logger.warn({ err, id: row.id }, "Failed to auto-start managed bot")
      );
    }
  }
}
