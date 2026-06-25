import {
  makeWASocket,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { col } from "./db/mongo.js";
import { useMongoAuthState } from "./db/mongo-auth.js";
import { logger } from "../lib/logger.js";
import { setActiveSock } from "./connection.js";
import { handleMessage } from "./handlers/message.js";
import { handleGroupUpdate, handleGroupParticipantsUpdate } from "./handlers/group.js";
import { DEFAULT_PERSONA, isValidPersona, type PersonaKey } from "./commands/personas.js";
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
  roles: string[];
  menuImageUrl: string;
}

interface LiveInstance {
  sock: any;
  status: BotStatusInfo["status"];
  pairingCode: string | null;
}

const live = new Map<string, LiveInstance>();
const sockBotIds = new WeakMap<object, string>();

export async function startBot(botId: string): Promise<void> {
  const existing = live.get(botId);
  if (existing && (existing.status === "connected" || existing.status === "connecting" || existing.status === "pairing")) {
    return;
  }

  const row = await col("bots").findOne({ _id: botId as any });
  if (!row) throw new Error(`Bot ${botId} not found`);

  const { state, saveCreds } = await useMongoAuthState(botId);
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
  await col("bots").updateOne({ _id: botId as any }, { $set: { status: "connecting" } });

  sock.ws?.on?.("error", (err: any) => {
    logger.warn({ err, botId }, "Managed bot socket error (handled)");
  });
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update: any) => {
    if (update.pairingCode) {
      inst.pairingCode = update.pairingCode;
      inst.status = "pairing";
      await col("bots").updateOne({ _id: botId as any }, { $set: { status: "pairing" } });
      logger.info({ botId, code: update.pairingCode }, "Pairing code ready for managed bot");
    }

    if (update.connection === "open") {
      inst.status = "connected";
      inst.pairingCode = null;
      const phone = sock.user?.id?.split("@")[0]?.split(":")[0] || row.phone;
      await col("bots").updateOne({ _id: botId as any }, { $set: { status: "connected", phone } });
      logger.info({ botId, name: row.name }, "Managed bot connected");
      setActiveSock(sock, true);
    }

    if (update.connection === "close") {
      const code = (update.lastDisconnect?.error as any)?.output?.statusCode;
      inst.status = "disconnected";
      await col("bots").updateOne({ _id: botId as any }, { $set: { status: "disconnected" } });
      logger.info({ botId, code }, "Managed bot disconnected");
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
        await col("bots").updateOne({ _id: botId as any }, { $set: { status: "pairing" } });
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
  await col("bots").updateOne({ _id: botId as any }, { $set: { status: "disconnected" } });
}

export async function disconnectBot(botId: string): Promise<void> {
  const inst = live.get(botId);
  if (!inst) return;
  try { inst.sock?.end(undefined); } catch {}
  inst.status = "disconnected";
  live.delete(botId);
  await col("bots").updateOne({ _id: botId as any }, { $set: { status: "disconnected" } });
}

export async function getAllBotsStatus(): Promise<BotStatusInfo[]> {
  const rows = await col("bots").find({}).sort({ is_primary: -1, created_at: 1 }).toArray();
  return rows.map((row) => {
    const inst = live.get(row._id as string);
    const roles: string[] = Array.isArray(row.roles) ? row.roles : [];
    return {
      id: row._id as string,
      name: row.name,
      phone: row.phone || "",
      status: (inst?.status || row.status || "disconnected") as BotStatusInfo["status"],
      pairingCode: inst?.pairingCode || null,
      isPrimary: !!row.is_primary,
      imageUrl: row.menu_image_url || row.image_url || "",
      menuImageUrl: row.menu_image_url || "",
      persona: isValidPersona(row.persona) ? row.persona : DEFAULT_PERSONA,
      roles,
    };
  });
}

export async function getBotStatusInfo(botId: string): Promise<BotStatusInfo | null> {
  const row = await col("bots").findOne({ _id: botId as any });
  if (!row) return null;
  const inst = live.get(botId);
  const roles: string[] = Array.isArray(row.roles) ? row.roles : [];
  return {
    id: row._id as string,
    name: row.name,
    phone: row.phone || "",
    status: (inst?.status || row.status || "disconnected") as BotStatusInfo["status"],
    pairingCode: inst?.pairingCode || null,
    isPrimary: !!row.is_primary,
    imageUrl: row.menu_image_url || row.image_url || "",
    menuImageUrl: row.menu_image_url || "",
    persona: isValidPersona(row.persona) ? row.persona : DEFAULT_PERSONA,
    roles,
  };
}

export async function setBotPersona(botId: string, persona: PersonaKey): Promise<void> {
  await col("bots").updateOne({ _id: botId as any }, { $set: { persona } });
}

export async function getPersonaForSock(sock: any): Promise<PersonaKey> {
  const botId = sockBotIds.get(sock);
  if (botId) {
    const row = await col("bots").findOne({ _id: botId as any }, { projection: { persona: 1 } });
    if (row && isValidPersona(row.persona)) return row.persona;
  }
  const primary = await col("bots").findOne({ is_primary: 1 }, { projection: { persona: 1 } });
  if (primary && isValidPersona(primary.persona)) return primary.persona;
  return DEFAULT_PERSONA;
}

export async function requestBotPairingCode(botId: string, phone: string): Promise<string> {
  const row = await col("bots").findOne({ _id: botId as any });
  if (!row) throw new Error(`Bot ${botId} not found`);

  const phoneDigits = phone.replace(/\D/g, "");
  if (phoneDigits.length < 7) throw new Error("Invalid phone number");

  await col("bots").updateOne({ _id: botId as any }, { $set: { phone: phoneDigits } });

  const inst = live.get(botId);
  if (!inst || !inst.sock) {
    await startBot(botId);
    await new Promise((r) => setTimeout(r, 4000));
    const updated = live.get(botId);
    if (updated?.pairingCode) return updated.pairingCode;
    throw new Error("Bot starting — check status in a few seconds for the pairing code");
  }

  try {
    const code = await inst.sock.requestPairingCode(phoneDigits);
    inst.pairingCode = code;
    inst.status = "pairing";
    await col("bots").updateOne({ _id: botId as any }, { $set: { status: "pairing" } });
    return code;
  } catch (err: any) {
    throw new Error(err?.message || "Failed to request pairing code");
  }
}

export async function setPrimaryBot(botId: string): Promise<void> {
  await col("bots").updateMany({}, { $set: { is_primary: 0 } });
  await col("bots").updateOne({ _id: botId as any }, { $set: { is_primary: 1 } });
}

export async function initManagedBots(): Promise<void> {
  const rows = await col("bots").find({}).toArray();
  for (const row of rows) {
    if (row.is_primary || row.status === "connected") {
      startBot(row._id as string).catch((err) =>
        logger.warn({ err, id: row._id }, "Failed to auto-start managed bot")
      );
    }
  }
}
