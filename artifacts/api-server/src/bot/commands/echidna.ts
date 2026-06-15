/**
 * ═══════════════════════════════════════════════════════════════════
 *  AI COMPANION ENGINE — Multi-Personality Character System
 *  Layered architecture: Persona Core → Memory → Affinity → Mood → Response
 * ═══════════════════════════════════════════════════════════════════
 *
 *  This engine originally powered a single character ("Echidna") but now
 *  drives ANY personality registered in commands/personas.ts. Each linked
 *  bot (see bot-manager.ts / Admin → Bots) can be assigned its own
 *  personality, so different bots can have entirely different companions
 *  while sharing the same mood/affinity/memory/sticker machinery.
 *
 *  Activation rules:
 *    • Bot is mentioned (@tag)  → always responds
 *    • Message is a reply to a bot message → responds
 *    • Persona's name is mentioned (e.g. "echidna", "C.C.", "zero")  → responds
 *    • Group has echidna_chat = "on" → responds to every message
 *    • Direct message → always responds
 *
 *  Sticker system (.botreply):
 *    Owner / mod / guardian only.
 *    .botreply sticker [name]   → sets the sticker buffer as a named reply sticker
 *    .botreply list             → shows saved sticker names
 *    .botreply delete [name]    → deletes a saved sticker
 *    .botreply random           → toggle random-sticker-only replies for heated conversations
 *    .botreply echidna on/off   → toggle always-on companion chat in this group
 */

import type { WASocket, proto } from "@whiskeysockets/baileys";
import type { CommandContext } from "./index.js";
import { getBotSetting, setBotSetting, deleteBotSetting, getStaff } from "../db/queries.js";
import { isOwnerPhone, sendText } from "../connection.js";
import { logger } from "../../lib/logger.js";
import { getDb } from "../db/database.js";
import { getPersona, DEFAULT_PERSONA, type PersonaKey, type PersonaDef } from "./personas.js";
import { getPersonaForSock } from "../bot-manager.js";
import axios from "axios";

// ─── Types ────────────────────────────────────────────────────────────────────

type EchidnaMood =
  | "neutral"
  | "curious"
  | "interested"
  | "impressed"
  | "playful"
  | "thoughtful"
  | "concerned";

interface EchidnaMemory {
  name?: string;
  nickname?: string;
  hobbies?: string[];
  favorite_anime?: string;
  favorite_games?: string[];
  favorite_drink?: string;
  favorite_food?: string;
  working_on?: string;
  exam_info?: string;
  important_events?: string[];
  preferences?: Record<string, string>;
  frequently_discussed?: string[];
  last_updated?: number;
}

interface EchidnaUserState {
  affinity: number;              // 0–100
  mood: EchidnaMood;            // current mood
  memory: EchidnaMemory;        // long-term facts
  conversation: Array<{ role: "user" | "assistant"; content: string }>;
  lastInteraction: number;
  messageCount: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const OPENROUTER_API = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
const MODEL = "openai/gpt-4o";

if (!OPENROUTER_KEY) {
  logger.warn("OPENROUTER_API_KEY is not set — Echidna AI responses will be unavailable until it is configured");
}

const AFFINITY_LABELS: Array<[number, string]> = [
  [20,  "Stranger"],
  [40,  "Acquaintance"],
  [60,  "Familiar"],
  [80,  "Friend"],
  [100, "Trusted Companion"],
];

// Mood thresholds by keyword patterns
const MOOD_TRIGGERS: Array<[RegExp, EchidnaMood]> = [
  [/\b(why|how|what if|curious|wonder|explain|tell me|i don'?t understand)\b/i, "curious"],
  [/\b(interesting|fascinating|never knew|that'?s new|didn'?t know)\b/i, "interested"],
  [/\b(impressive|amazing|incredible|brilliant|genius|wow|great work)\b/i, "impressed"],
  [/\b(haha|lol|joke|funny|lmao|playful|tease)\b/i, "playful"],
  [/\b(think|consider|reflect|ponder|maybe|perhaps|philosophy|meaning)\b/i, "thoughtful"],
  [/\b(sad|hurt|worried|anxious|scared|struggling|stressed|depressed)\b/i, "concerned"],
];

// In-memory session state (resets on restart — intentional; memories persist in DB)
const userSessions = new Map<string, EchidnaUserState>();

// ─── DB helpers ───────────────────────────────────────────────────────────────

function stateKey(userId: string, persona: PersonaKey) {
  const prefix = persona === DEFAULT_PERSONA ? "echidna" : persona;
  return `${prefix}:state:${userId.split("@")[0].split(":")[0]}`;
}

function loadUserState(userId: string, persona: PersonaKey): EchidnaUserState {
  // Check in-memory first
  const cacheKey = `${persona}:${userId}`;
  const cached = userSessions.get(cacheKey);
  if (cached) return cached;

  // Try DB
  try {
    const raw = getBotSetting(stateKey(userId, persona));
    if (raw) {
      const parsed = JSON.parse(raw.toString("utf8")) as EchidnaUserState;
      userSessions.set(cacheKey, parsed);
      return parsed;
    }
  } catch {}

  // Fresh state
  const fresh: EchidnaUserState = {
    affinity: 0,
    mood: "neutral",
    memory: {},
    conversation: [],
    lastInteraction: Date.now(),
    messageCount: 0,
  };
  userSessions.set(cacheKey, fresh);
  return fresh;
}

function saveUserState(userId: string, persona: PersonaKey, state: EchidnaUserState) {
  userSessions.set(`${persona}:${userId}`, state);
  try {
    setBotSetting(stateKey(userId, persona), JSON.stringify(state));
  } catch (e) {
    logger.warn({ e }, "Failed to persist companion state");
  }
}

// ─── Affinity helpers ─────────────────────────────────────────────────────────

function getAffinityLabel(score: number): string {
  for (const [threshold, label] of AFFINITY_LABELS) {
    if (score <= threshold) return label;
  }
  return "Trusted Companion";
}

function calcAffinityGain(msg: string): number {
  // Longer, more thoughtful messages give more affinity
  const length = msg.trim().length;
  if (length > 200) return 3;
  if (length > 80) return 2;
  return 1;
}

// ─── Mood detection ───────────────────────────────────────────────────────────

function detectMood(msg: string, currentMood: EchidnaMood): EchidnaMood {
  for (const [pattern, mood] of MOOD_TRIGGERS) {
    if (pattern.test(msg)) return mood;
  }
  return currentMood === "concerned" ? "neutral" : currentMood;
}

// ─── Character Core prompt ────────────────────────────────────────────────────

function buildSystemPrompt(state: EchidnaUserState, userName: string, persona: PersonaDef): string {
  const affinityLabel = getAffinityLabel(state.affinity);
  const mem = state.memory;

  // Build memory context
  const memLines: string[] = [];
  if (mem.name || mem.nickname) memLines.push(`- Known as: ${mem.nickname || mem.name}`);
  if (mem.working_on) memLines.push(`- Working on: ${mem.working_on}`);
  if (mem.favorite_anime) memLines.push(`- Favourite anime: ${mem.favorite_anime}`);
  if (mem.favorite_drink) memLines.push(`- Favourite drink: ${mem.favorite_drink}`);
  if (mem.favorite_food) memLines.push(`- Favourite food: ${mem.favorite_food}`);
  if (mem.hobbies?.length) memLines.push(`- Hobbies: ${mem.hobbies.join(", ")}`);
  if (mem.exam_info) memLines.push(`- Exam situation: ${mem.exam_info}`);
  if (mem.frequently_discussed?.length) memLines.push(`- Often discusses: ${mem.frequently_discussed.join(", ")}`);

  // Affinity-tuned greeting style note
  let affinityNote = "";
  if (state.affinity <= 20) {
    affinityNote = "You barely know this person. Keep responses polite but measured. Do not use their name.";
  } else if (state.affinity <= 40) {
    affinityNote = "You have spoken briefly before. You are slightly warmer, occasionally use their name.";
  } else if (state.affinity <= 60) {
    affinityNote = "You are familiar with this person. You may reference past topics naturally when relevant.";
  } else if (state.affinity <= 80) {
    affinityNote = "You consider this person a friend. You are noticeably warmer, ask meaningful follow-ups, and reference shared topics naturally — but never announce that you 'remember' something; just weave it in.";
  } else {
    affinityNote = "You deeply trust this person. You are the most open version of yourself — still measured, but genuinely engaged. Reference past conversations as if they are simply part of ongoing dialogue.";
  }

  // Mood flavour
  const moodNote: Record<EchidnaMood, string> = {
    neutral:    "Speak with calm, measured elegance.",
    curious:    "You are visibly curious. Ask a follow-up question. Let your fascination show slightly.",
    interested: "You are genuinely interested. Lean in intellectually.",
    impressed:  "You are quietly impressed. Allow one understated acknowledgment of it.",
    playful:    "Allow a single light tease or witty observation — but keep your composure.",
    thoughtful: "You are in a reflective mood. Speak more carefully, perhaps pose a philosophical angle.",
    concerned:  "You are subtly concerned for this person. Be a little warmer than usual without fussing.",
  };

  return `${persona.core}

## Current Relationship
Affinity with ${userName}: ${state.affinity}/100 — ${affinityLabel}
${affinityNote}

## Your Current Mood: ${state.mood}
${moodNote[state.mood]}

${memLines.length > 0 ? `## What You Know About ${userName}\n${memLines.join("\n")}` : ""}

## Memory Instruction
If you learn any of the following from this conversation, append a JSON block at the very end of your response (the backend will parse and strip it before delivery):
<${persona.memoryTag}>{"field": "value"}</${persona.memoryTag}>
Fields: name, nickname, hobbies (array), favorite_anime, favorite_games (array), favorite_drink, favorite_food, working_on, exam_info, important_events (array), frequently_discussed (array).
Only include this block when you actually learned something new.

Stay fully in character as described above. Act accordingly.`;
}

// ─── OpenRouter call ──────────────────────────────────────────────────────────

async function callEchidna(
  state: EchidnaUserState,
  userName: string,
  userMessage: string,
  persona: PersonaDef
): Promise<string> {
  if (!OPENROUTER_KEY) {
    return "My apologies — it seems my connection to the arcane network has not yet been established. The administrator must configure my key before I can speak freely.";
  }
  const systemPrompt = buildSystemPrompt(state, userName, persona);

  // Keep last 12 turns to stay within context budget
  const history = state.conversation.slice(-12);

  // OpenRouter uses the OpenAI-compatible messages format.
  // The system prompt must be the first message with role "system" —
  // NOT a top-level "system" field (that's the Anthropic native API only).
  const messages = [
    { role: "system" as const, content: systemPrompt },
    ...history,
    { role: "user" as const, content: userMessage },
  ];

  try {
    const resp = await axios.post(
      OPENROUTER_API,
      {
        model: MODEL,
        max_tokens: 400,
        messages,
      },
      {
        headers: {
          "Authorization": `Bearer ${OPENROUTER_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://requiem-order.app",
          "X-Title": `Requiem Order WhatsApp Bot — ${persona.shortLabel}`,
        },
        timeout: 20000,
      }
    );

    return resp.data.choices?.[0]?.message?.content?.trim() || "...";
  } catch (err: any) {
    const status = (err as any)?.response?.status;
    logger.error({ err: err?.message, status }, "Echidna OpenRouter call failed");
    if (status === 401 || status === 403) {
      return "My apologies — it seems my key to the arcane network has been revoked. The administrator must update the OPENROUTER_API_KEY.";
    }
    if (status === 429) {
      return "My apologies. The arcane network is momentarily overloaded. Try again in a moment.";
    }
    return "My apologies. It seems our connection is momentarily strained. Do try again.";
  }
}

// ─── Memory extractor ─────────────────────────────────────────────────────────

function extractAndStripMemory(
  response: string,
  state: EchidnaUserState,
  persona: PersonaDef
): { cleaned: string; updated: boolean } {
  const tagRe = new RegExp(`<${persona.memoryTag}>([\\s\\S]*?)</${persona.memoryTag}>`);
  const tagReGlobal = new RegExp(`<${persona.memoryTag}>[\\s\\S]*?</${persona.memoryTag}>`, "g");
  const match = response.match(tagRe);
  if (!match) return { cleaned: response, updated: false };

  const cleaned = response.replace(tagReGlobal, "").trim();

  try {
    const patch = JSON.parse(match[1]) as Partial<EchidnaMemory>;
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined && v !== null && v !== "") {
        (state.memory as any)[k] = v;
      }
    }
    state.memory.last_updated = Date.now();
    return { cleaned, updated: true };
  } catch {
    return { cleaned, updated: false };
  }
}

// ─── Sticker helpers ──────────────────────────────────────────────────────────

function stickerKey(name: string) {
  return `echidna:sticker:${name.toLowerCase().replace(/\s+/g, "_")}`;
}

function listStickerNames(): string[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT key FROM bot_settings WHERE key LIKE 'echidna:sticker:%'"
  ).all() as Array<{ key: string }>;
  return rows.map(r => r.key.replace("echidna:sticker:", "").replace(/_/g, " "));
}

function getRandomSticker(): Buffer | null {
  const names = listStickerNames();
  if (!names.length) return null;
  const pick = names[Math.floor(Math.random() * names.length)];
  return getBotSetting(stickerKey(pick));
}

/** Decide whether Echidna should send a sticker-only reply this turn */
function shouldSendStickerOnly(messageCount: number): boolean {
  // Every ~7–10 messages in an active conversation, she might reply with just a sticker
  return messageCount > 5 && Math.random() < 0.08;
}

// ─── Permission check ─────────────────────────────────────────────────────────

function isModOrAbove(sender: string): boolean {
  const phone = sender.split("@")[0].split(":")[0];
  if (isOwnerPhone(phone)) return true;
  const staff = getStaff(sender);
  return staff?.role === "mod" || staff?.role === "guardian";
}

// ─── Activation check ─────────────────────────────────────────────────────────

export function shouldEchidnaRespond(params: {
  isGroup: boolean;
  from: string;
  body: string;
  botJid: string;
  botLid?: string;
  isReplyToBot: boolean;
  echidnaChatEnabled: boolean;
  mentionedJids: string[];
  persona?: PersonaDef;
}): boolean {
  const { isGroup, body, botJid, botLid, isReplyToBot, echidnaChatEnabled, mentionedJids, persona } = params;

  // DMs: regular users are blocked upstream by the message gate.
  // If a DM reaches here it's an owner/staff — respond.
  if (!isGroup) return true;

  const botPhone = botJid.split("@")[0].split(":")[0];
  const botLidNum = (botLid || "").split("@")[0].split(":")[0];

  const isMentioned = mentionedJids.some(j => {
    const p = j.split("@")[0].split(":")[0];
    return p === botPhone || (botLidNum && p === botLidNum);
  });

  // Check for the active persona's name mention — case-insensitive whole-word match
  const nameMatch = (persona?.mentionRegex || /\bechidna\b/i).test(body);

  return isMentioned || nameMatch || isReplyToBot || echidnaChatEnabled;
}

// ─── Main Echidna responder ───────────────────────────────────────────────────

export async function handleEchidnaMessage(
  sock: WASocket,
  from: string,
  sender: string,
  body: string,
  quotedMsg?: proto.IWebMessageInfo,
  pushName?: string,
  personaKey?: PersonaKey
): Promise<void> {
  const persona = getPersona(personaKey);
  const userId = sender.split("@")[0].split(":")[0];
  const state = loadUserState(userId, persona.key);

  // Detect mood from incoming message
  state.mood = detectMood(body, state.mood);

  // Affinity gain
  const gain = calcAffinityGain(body);
  state.affinity = Math.min(100, state.affinity + gain);
  state.messageCount++;
  state.lastInteraction = Date.now();

  const userName = state.memory.nickname || state.memory.name || pushName || userId;

  // Possibly send a sticker-only reply
  const stickers = listStickerNames();
  if (stickers.length > 0 && shouldSendStickerOnly(state.messageCount)) {
    const buf = getRandomSticker();
    if (buf) {
      await sock.sendMessage(from, { sticker: buf }, quotedMsg ? { quoted: quotedMsg as any } : undefined).catch(() => {});
      saveUserState(userId, persona.key, state);
      return;
    }
  }

  // Get AI response
  const raw = await callEchidna(state, userName, body, persona);

  // Extract and strip any memory updates
  const { cleaned, updated } = extractAndStripMemory(raw, state, persona);

  // Update conversation history
  state.conversation.push({ role: "user", content: body });
  state.conversation.push({ role: "assistant", content: cleaned });

  // Trim to 20 turns
  if (state.conversation.length > 20) {
    state.conversation = state.conversation.slice(-20);
  }

  saveUserState(userId, persona.key, state);

  // Send response
  await sock.sendMessage(
    from,
    { text: cleaned },
    quotedMsg ? { quoted: quotedMsg as any } : undefined
  ).catch(() => {});

  // After text, optionally send a mood/affinity sticker if we have one
  if (stickers.length > 0 && state.affinity > 40 && Math.random() < 0.12) {
    const stickerBuf = getBotSetting(stickerKey(state.mood)) || getRandomSticker();
    if (stickerBuf) {
      await new Promise(r => setTimeout(r, 800));
      await sock.sendMessage(from, { sticker: stickerBuf }).catch(() => {});
    }
  }
}

// ─── .botreply command handler ────────────────────────────────────────────────

export async function handleBotReply(ctx: CommandContext): Promise<void> {
  const { from, sender, args, sock, msg } = ctx;
  const persona = getPersona(getPersonaForSock(sock));

  if (!isModOrAbove(sender)) {
    await sendText(from, "❌ Only mods, guardians, and the owner can use `.botreply`.");
    return;
  }

  const sub = args[0]?.toLowerCase();

  // ── .botreply list
  if (!sub || sub === "list") {
    const names = listStickerNames();
    if (!names.length) {
      await sendText(from, `🎴 No ${persona.shortLabel} stickers saved yet.\n\nUse \`.botreply sticker [name]\` while quoting a sticker to add one.`);
      return;
    }
    await sendText(from, `🎴 *${persona.shortLabel} Sticker Library*\n\n${names.map(n => `• ${n}`).join("\n")}\n\n_Quote a sticker and use \`.botreply sticker [name]\` to add more._`);
    return;
  }

  // ── .botreply delete [name]
  if (sub === "delete" || sub === "del") {
    const name = args.slice(1).join(" ");
    if (!name) {
      await sendText(from, "❌ Usage: `.botreply delete [name]`");
      return;
    }
    deleteBotSetting(stickerKey(name));
    await sendText(from, `🗑️ Deleted sticker: *${name}*`);
    return;
  }

  // ── .botreply sticker [name]
  if (sub === "sticker") {
    const name = args.slice(1).join(" ").trim();
    if (!name) {
      await sendText(from, "❌ Usage: `.botreply sticker [name]`\nQuote a sticker and provide a name.");
      return;
    }

    // Try to get sticker from quoted message
    const quoted = (msg as any)?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const stickerData = quoted?.stickerMessage;

    if (!stickerData) {
      await sendText(from, "❌ Please quote a sticker message, then use `.botreply sticker [name]`.");
      return;
    }

    try {
      // Download the sticker using Baileys media download
      const { downloadMediaMessage } = await import("@whiskeysockets/baileys");
      const fakeMsg = {
        key: { ...msg.key },
        message: quoted,
      } as proto.IWebMessageInfo;
      const buffer = await downloadMediaMessage(fakeMsg, "buffer", {}, { reuploadRequest: sock.updateMediaMessage });
      if (!buffer || !Buffer.isBuffer(buffer)) throw new Error("empty buffer");

      setBotSetting(stickerKey(name), buffer as Buffer);
      await sendText(from, `✅ Sticker saved as: *${name}*\n\n${persona.shortLabel} will use it in replies.`);
    } catch (err) {
      logger.error({ err }, "Failed to save Echidna sticker");
      await sendText(from, "❌ Could not download the sticker. Make sure it's a valid WhatsApp sticker.");
    }
    return;
  }

  // ── .botreply random (toggle context)
  if (sub === "random") {
    await sendText(from, `ℹ️ ${persona.shortLabel} already uses random stickers automatically in active conversations.`);
    return;
  }

  // ── .botreply echidna on/off — toggle echidna_chat in this group
  if (sub === "echidna" || sub === "chat") {
    const val = args[1]?.toLowerCase();
    if (!from.endsWith("@g.us")) {
      await sendText(from, "❌ This is a group-only toggle.");
      return;
    }
    const { updateGroup } = await import("../db/queries.js");
    updateGroup(from, { echidna_chat: val === "on" ? "on" : "off" });
    await sendText(from, `🧠 ${persona.shortLabel} auto-reply in this group: *${val === "on" ? "ON" : "OFF"}*\n${val === "on" ? "They will respond to every message." : "They will only respond when mentioned or replied to."}`);
    return;
  }

  await sendText(from, `❓ Usage:\n• \`.botreply list\` — see saved stickers\n• \`.botreply sticker [name]\` — save a quoted sticker\n• \`.botreply delete [name]\` — remove a sticker\n• \`.botreply echidna on/off\` — toggle ${persona.shortLabel} auto-reply in this group`);
}

// ─── .mem command — what Echidna knows about you ─────────────────────────────
// .comp command — affinity / compatibility stats

export async function handleEchidnaInfo(ctx: CommandContext): Promise<void> {
  const { from, sender, command, sock } = ctx;
  const persona = getPersona(getPersonaForSock(sock));
  const userId = sender.split("@")[0].split(":")[0];
  const state = loadUserState(userId, persona.key);

  // .mem — show memory
  if (command === "mem") {
    const mem = state.memory;
    const lines: string[] = [];
    if (mem.name) lines.push(`Name: ${mem.name}`);
    if (mem.nickname) lines.push(`Nickname: ${mem.nickname}`);
    if (mem.working_on) lines.push(`Working on: ${mem.working_on}`);
    if (mem.favorite_anime) lines.push(`Fav anime: ${mem.favorite_anime}`);
    if (mem.favorite_drink) lines.push(`Fav drink: ${mem.favorite_drink}`);
    if (mem.favorite_food) lines.push(`Fav food: ${mem.favorite_food}`);
    if (mem.hobbies?.length) lines.push(`Hobbies: ${mem.hobbies.join(", ")}`);
    if (mem.exam_info) lines.push(`Exams: ${mem.exam_info}`);
    if (mem.frequently_discussed?.length) lines.push(`Often discusses: ${mem.frequently_discussed.join(", ")}`);

    if (!lines.length) {
      await sendText(from, `🧠 ${persona.shortLabel} hasn't learned anything specific about you yet.\n\nJust chat with them — they pay attention.`);
      return;
    }
    await sendText(from, `🧠 *What ${persona.shortLabel} Knows About You*\n\n${lines.map(l => `• ${l}`).join("\n")}`);
    return;
  }

  // .comp — affinity / compatibility stats
  const label = getAffinityLabel(state.affinity);
  const moodEmoji: Record<EchidnaMood, string> = {
    neutral: "😐", curious: "🤔", interested: "✨", impressed: "👁️",
    playful: "😏", thoughtful: "🌙", concerned: "🫂",
  };

  await sendText(
    from,
    `🌿 *${persona.shortLabel} — Compatibility*\n\n` +
    `Affinity: *${state.affinity}/100* — ${label}\n` +
    `Mood: ${moodEmoji[state.mood]} ${state.mood}\n` +
    `Messages exchanged: ${state.messageCount}\n\n` +
    `_Use \`.mem\` to see what ${persona.shortLabel} knows about you._`
  );
}
