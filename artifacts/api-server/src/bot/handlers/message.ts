import type { WASocket, proto } from "@whiskeysockets/baileys";
import { BOT_OWNER_LID, BOT_OWNER_PHONE, PREFIX, sendText, runWithReplyContext, getBotName, isOwnerPhone, isOwnerLid } from "../connection.js";
import { ensureUser, ensureGroup, incrementMessageCount, incrementGroupActivity, getStaff, isBanned, isUserBanned, getBotSetting, getUser, updateUser, addUserXp, getActiveMute, getGroup, linkUserLid, getUserByLid } from "../db/queries.js";
import { checkAntilink, checkAntispam, checkBlacklist } from "./antispam.js";
import { checkAutoSpawn, handleGetCard } from "./cardspawn.js";
import { checkAfkMention, checkSenderReturnedFromAfk, handleAfk } from "../commands/afk.js";
import { handleAdmin } from "../commands/admin.js";
import { handleEconomy } from "../commands/economy.js";
import { handleGambling } from "../commands/gambling.js";
import { handleCards } from "../commands/cards.js";
import { handleGames, handleGameInput } from "../commands/games.js";
import { handleFun } from "../commands/fun.js";
import { handleInteraction } from "../commands/interactions.js";
import { handleRpg } from "../commands/rpg.js";
import { handleGuilds } from "../commands/guilds.js";
import { handleStaff } from "../commands/staff.js";
import { handleAI } from "../commands/ai.js";
import { handleMenu, handleStaffMenu, handleInfo, handleHelp, handleSetMenuImage } from "../commands/menu.js";
import { handleSummer } from "../commands/summer.js";
import { handleLottery } from "../commands/lottery.js";
import { handleConverter } from "../commands/converter.js";
import { logger } from "../../lib/logger.js";
import type { CommandContext } from "../commands/index.js";
import { resolveMentionedJid } from "../utils/identity.js";
import { shouldEchidnaRespond, handleEchidnaMessage, handleBotReply, handleEchidnaInfo } from "../commands/echidna.js";
import { getPersona } from "../commands/personas.js";
import { getPersonaForSock } from "../bot-manager.js";
import { handlePullCards, handleSyncCards, handleCardLogs } from "./shoob-sync.js";

// "Welcome Master" greeting state now lives in the DB (users.owner_greeted),
// so it fires exactly once ever — not once per process restart.

export async function handleMessage(
  sock: WASocket,
  msg: proto.IWebMessageInfo
): Promise<void> {
  if (!msg.message) return;

  if (!msg.key) return;
  const from = msg.key.remoteJid!;
  if (from === "status@broadcast") return;
  const isGroup = from.endsWith("@g.us");
  const messageContent = unwrapMessage(msg.message as any);
  const normalizedMsg = { ...msg, message: messageContent } as proto.IWebMessageInfo;

  const senderRaw = isGroup
    ? (msg.key.participant || (msg.key.fromMe ? getPrimaryBotJid(sock) : ""))
    : (msg.key.remoteJid || "");
  let sender = senderRaw;
  let resolvedGroupMeta: any = null;

  if (!sender) return;

  // Skip bots entirely — fromMe (own bot messages) and DB-flagged bots
  if (msg.key.fromMe) return;

  // ── LID resolution ──────────────────────────────────────────────────────────
  // Newer WhatsApp clients use @lid JIDs (e.g. 101xxx@lid) instead of the real
  // phone JID — in groups AND in DMs. Resolve to the real @s.whatsapp.net JID
  // using group metadata (groups only) so we always store the phone number as
  // the user ID.
  const senderWasLid = sender.endsWith("@lid");
  if (senderWasLid && isGroup) {
    try {
      resolvedGroupMeta = await sock.groupMetadata(from);
      for (const p of resolvedGroupMeta.participants as any[]) {
        const isMatch = p.id === sender || p.lid === sender;
        if (isMatch) {
          const realJid = ([p.id, p.lid] as string[])
            .find(j => j?.endsWith("@s.whatsapp.net"));
          if (realJid) { sender = realJid; break; }
        }
      }
    } catch {}
  }
  // DMs never have group metadata to resolve @lid → phone with, AND group
  // resolution above can simply fail to find a match (bot lost admin, stale
  // participant cache, just rejoined, etc). In both cases, fall back to the
  // DB: if this exact LID was already linked to a phone-keyed row by a prior
  // .verify, use that — instead of leaving `sender` as a raw @lid value that
  // every downstream ensureUser()/getUser()/inventory call would otherwise
  // key a brand-new ghost row off of.
  let earlyLidFallbackPhone = "";
  if (sender.endsWith("@lid")) {
    const lidRecord = await getUserByLid(senderRaw);
    if (lidRecord?.id) {
      earlyLidFallbackPhone = lidRecord.id;
      sender = `${lidRecord.id}@s.whatsapp.net`;
    }
  }
  // If we resolved an @lid JID, migrate the LID-keyed DB record to the real phone
  if (senderWasLid && !sender.endsWith("@lid")) {
    const lidNum = senderRaw.split("@")[0];
    const realPhone = sender.split("@")[0].split(":")[0];
    try {
      const { col: colMig } = await import("../db/mongo.js");
      const lidRecord = await colMig("users").findOne({ _id: lidNum });
      const MIGRATE_TABLES = ["rpg_characters","inventory","user_cards","message_counts","card_deck","deck_backgrounds","guild_members","warnings","muted_users","summer_tokens","afk_users","lottery_entries"] as const;
      if (lidRecord) {
        const phoneRecord = await colMig("users").findOne({ _id: realPhone });
        if (!phoneRecord) {
          // Migrate LID-keyed record to phone-keyed (insert new, migrate children, delete old)
          const { _id: _oldId, ...restLid } = lidRecord;
          await colMig("users").insertOne({ ...restLid, _id: realPhone, phone: realPhone, lid: lidNum });
          for (const t of MIGRATE_TABLES) {
            try { await colMig(t).updateMany({ user_id: lidNum }, { $set: { user_id: realPhone } }); } catch {}
          }
          await colMig("users").deleteOne({ _id: lidNum });
        } else {
          // Both records exist — merge into phone-keyed, delete lid-keyed duplicate
          await colMig("users").updateOne({ _id: realPhone }, [
            { $set: {
              lid: { $ifNull: ["$lid", lidNum] },
              balance: { $add: ["$balance", lidRecord.balance || 0] },
              xp: { $max: ["$xp", lidRecord.xp || 0] },
              level: { $max: ["$level", lidRecord.level || 0] },
            }}
          ] as any);
          for (const t of MIGRATE_TABLES) {
            try { await colMig(t).updateMany({ user_id: lidNum }, { $set: { user_id: realPhone } }); } catch {}
          }
          await colMig("users").deleteOne({ _id: lidNum });
        }
      } else if (!earlyLidFallbackPhone) {
        // No LID-keyed row yet — just store the lid on the phone-keyed row
        await linkUserLid(realPhone, senderRaw);
      }
    } catch {}
  }
  // ────────────────────────────────────────────────────────────────────────────

  const senderNormalized = sender.split("@")[0].split(":")[0];
  const senderUserRecord = await getUser(senderNormalized);
  if (senderUserRecord?.is_bot === 1) return;

  if (await isUserBanned(sender)) return;
  if (isGroup && await isBanned("group", from)) {
    await sock.groupLeave(from).catch(() => {});
    return;
  }

  const body =
    messageContent?.conversation ||
    messageContent?.extendedTextMessage?.text ||
    messageContent?.imageMessage?.caption ||
    messageContent?.videoMessage?.caption ||
    messageContent?.documentMessage?.caption ||
    messageContent?.buttonsResponseMessage?.selectedButtonId ||
    messageContent?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    messageContent?.templateButtonReplyMessage?.selectedId ||
    "";
  const trimmedBody = body.trim();
  const isCommandBody = trimmedBody.startsWith(PREFIX);

  const mentionedJids: string[] =
    getContextInfo(messageContent)?.mentionedJid || [];

  await ensureUser(sender, msg.pushName || undefined);
  void addUserXp(sender, 5);

  if (isGroup) {
    void incrementMessageCount(sender, from);
    void incrementGroupActivity(from);
  }

  let groupMeta: any = resolvedGroupMeta;
  let isAdmin = false;
  let isBotAdmin = false;
  let isGroupAdmin = false;

  if (isGroup) {
    try {
      await ensureGroup(from);
      if (!groupMeta) groupMeta = await sock.groupMetadata(from);
      const botIds = getBotIdentityCandidates(sock);

      const senderParticipant = groupMeta.participants.find(
        (p: any) => sameWhatsAppUser(p.id, sender)
      );
      isGroupAdmin = senderParticipant?.admin === "admin" || senderParticipant?.admin === "superadmin";
      isAdmin = isGroupAdmin;

      const botParticipant = groupMeta.participants.find(
        (p: any) => botIds.some((botId) => sameWhatsAppUser(p.id, botId))
      );
      isBotAdmin = !!botParticipant?.admin;
    } catch (err) {
      logger.debug({ err }, "Could not get group metadata");
    }
  }

  // Pre-resolve every @lid JID in the mention list using now-populated group metadata.
  // All commands read ctx.resolvedMentions[0] — they never need to call
  // resolveMentionedJid() themselves or touch the raw mentionedJid array.
  const resolvedMentions: string[] = mentionedJids.map((jid: string) =>
    resolveMentionedJid(jid, groupMeta)
  );

  const senderPhone = sender.split("@")[0].split(":")[0];
  const senderStaff = await getStaff(senderPhone);
  // isOwner: check phone list, check staff table (owner role), and also check
  // the original senderRaw (pre-LID-resolution) so even if resolution failed
  // the owner can still be recognised by their phone number in the owner list.
  const rawSenderPhone = senderRaw.split("@")[0].split(":")[0].replace(/\D/g, "") || "";
  // LID fallback: earlyLidFallbackPhone was already resolved above (before any
  // DB writes) using the DB lid column. If sender was successfully rewritten to
  // a phone JID up there, earlyLidFallbackPhone holds the phone digits and
  // sender.endsWith("@lid") is now false — so this block is a safety net only
  // for brand-new users whose @lid has no DB record yet (first-ever message).
  let lidFallbackPhone = earlyLidFallbackPhone;
  if (!lidFallbackPhone && sender.endsWith("@lid")) {
    const lidRecord = await getUserByLid(senderRaw);
    if (lidRecord) lidFallbackPhone = lidRecord.id;
  }
  // Direct LID match against BOT_OWNER_LID — works on the very first message,
  // with zero DB dependency. This is what makes the owner recognisable even
  // before any row exists for them (DMs have no group metadata to resolve
  // @lid → phone, so this is the only reliable path for a brand-new owner).
  const isDirectLidOwner = senderRaw.endsWith("@lid") && isOwnerLid(senderRaw);
  const lidFallbackStaff = lidFallbackPhone ? await getStaff(lidFallbackPhone) : null;
  const isOwner = isOwnerPhone(senderPhone)
    || isOwnerPhone(rawSenderPhone)
    || isDirectLidOwner
    || (lidFallbackPhone ? isOwnerPhone(lidFallbackPhone) : false)
    || senderStaff?.role === "owner"
    || lidFallbackStaff?.role === "owner";

  // If we recognised the owner purely by their raw LID (no DB row linking it
  // yet), make sure their canonical phone-keyed row exists and has the LID
  // stored, so every subsequent lookup (getUser, getStaff, etc.) succeeds
  // without needing this fallback again.
  if (isDirectLidOwner) {
    try {
      const { ensureUser: ensureOwnerUser, linkUserLid: linkOwnerLid } = await import("../db/queries.js");
      await ensureOwnerUser(BOT_OWNER_PHONE, msg.pushName || undefined);
      await linkOwnerLid(BOT_OWNER_PHONE, senderRaw);
    } catch (err) {
      logger.debug({ err }, "Could not auto-link owner LID");
    }
  }

  // ── Welcome Master greeting ──────────────────────────────────────────────
  // Fires once per session when the owner sends their FIRST message (any
  // content, not just a command). Uses a module-level Set so it only sends
  // once per process startup, not once per message.
  if (isOwner) {
    const ownerKey = lidFallbackPhone || senderPhone || rawSenderPhone || BOT_OWNER_PHONE;
    const ownerRow = await getUser(ownerKey);
    if (!ownerRow?.owner_greeted) {
      const staffCommandList =
`👑 *Welcome back, Master.*

_${getBotName()} is at your command._
⚡ All systems online.

Here is your full staff command reference — these are not shown in *.menu* since they're privileged-only.

*🛡️ STAFF MANAGEMENT* _(mod/guardian/owner)_
• *.addmod <phone>* — Appoint a mod
• *.addguardian <phone>* — Appoint a guardian
• *.addrole <phone> <mod|guardian>* — Set role explicitly
• *.removemod <phone>* / *.removeguardian <phone>* — Remove a staff member
• *.recruit <phone>* — Add a recruit (lowest staff tier)
• *.modlist* / *.mods* — List all current staff and roles

*🤖 BOT MANAGEMENT* _(mod/guardian/owner)_
• *.bots* — Live status of every connected bot
• *.show* — Current bot's name, ID, and online count
• *.join <invite_link>* — Make bot join a group
• *.exit* — Make bot leave current group
• *.post <message>* — Broadcast to every group the bot is in
• *.setmenuimg* — Set the image attached to *.menu* (reply to an image)

*💰 ECONOMY & ACCESS CONTROL* _(mod/guardian/owner)_
• *.addpremium <phone> [days=30]* — Grant Premium status
• *.removepremium <phone>* — Revoke Premium status
• *.resetbal <phone>* — Reset a user's balance
• *.addinv <phone> <item>* — Give a user an inventory item
• *.reset <phone>* — Fully wipe a user's profile (*owner only*)

*🔨 MODERATION* _(mod/guardian/owner)_
• *.ban <phone> [reason]* — Bot-wide ban a user
• *.unban <phone>* — Lift a ban
• *.banlist* — View all banned users

*🎴 CARD DATABASE* _(mod/guardian/owner)_
• *.fetchcards [tier] [limit]* — Import cards from Shoob.gg
• *.pullcards* — Full bulk card import (Shoob)
• *.synccards* — Incremental card sync
• *.cardlogs* — View recent card sync activity
• *.upload <tier> <name>, <series>* — Upload a card manually (reply to an image)
• *.dc* / *.ac* / *.rc* — Disable / enable / restrict card spawning in current group

*📋 GROUP UTILITIES* _(mod/guardian/owner)_
• *.setms <message>* / *.delms* — Set or remove the milestone message
• *.setrules <text>* — Set the group rules
• *.rules* — View the current group rules

*👑 OWNER-ONLY COMMANDS*
• *.reset <phone>* — Fully wipe a user's profile
• *.summon* — Force-connect / reconnect all bots
• *.restart* — Restart bot processes

> _This message only sends once per session. Type *.menu* anytime for the regular command list._`;

      // Always DM the owner — even if they triggered this from inside a group
      const ownerDmJid = `${ownerKey.replace(/\D/g, "")}@s.whatsapp.net`;
      await sendText(ownerDmJid, staffCommandList).catch(() => {});
      try {
        await ensureUser(ownerKey, msg.pushName || undefined);
        void updateUser(ownerKey, { owner_greeted: 1 });
      } catch (err) {
        logger.debug({ err }, "Could not persist owner_greeted flag");
      }
    }
  }
  // ────────────────────────────────────────────────────────────────────────

  // DMs are restricted to the owner and guardians only. Everyone else
  // (including mods and recruits) is silently ignored in DMs — no reply,
  // no command processing. Groups remain open to everyone, unaffected by
  // this check.
  if (!isGroup) {
    const dmStaff = await getStaff(sender) || (lidFallbackPhone ? await getStaff(lidFallbackPhone) : null);
    const isGuardianOrAbove = isOwner || dmStaff?.role === "guardian";
    if (!isGuardianOrAbove) return;
  }

  if (isGroup && await getActiveMute(sender, from)) {
    await sock.sendMessage(from, { delete: normalizedMsg.key as any }).catch(() => {});
    return;
  }

  if (isGroup && !msg.key.fromMe) {
    // Clear AFK for any real content: text, media, or quoted replies.
    // EXCEPTION: if the message body starts with ">" the user is deliberately
    // chatting while AFK — do NOT clear their AFK status for that message.
    // Only stickers and reactions are also exempt.
    const isSticker = !!messageContent?.stickerMessage;
    const isReaction = !!messageContent?.reactionMessage;
    // Detect AFK-passthrough: message starts with ">" (user wants to chat without leaving AFK)
    const isAfkPassthrough = trimmedBody.startsWith(">");
    // When a user types "> text" in WhatsApp it may arrive as extendedTextMessage
    // with either an empty conversation field or non-empty extendedTextMessage.text.
    // We check BOTH body (already pulls extendedTextMessage.text) and the raw field.
    const extRawText = messageContent?.extendedTextMessage?.text || "";
    const hasContent = body.length > 0 ||
      extRawText.length > 0 ||
      !!messageContent?.imageMessage ||
      !!messageContent?.videoMessage ||
      !!messageContent?.audioMessage ||
      !!messageContent?.documentMessage ||
      !!(messageContent?.extendedTextMessage?.contextInfo?.stanzaId);
    if (!isSticker && !isReaction && !isAfkPassthrough && hasContent) {
      await checkSenderReturnedFromAfk(from, sender, sock, normalizedMsg).catch(() => {});
    }
  }

  if (mentionedJids.length > 0) {
    await checkAfkMention(from, sender, mentionedJids, sock).catch(() => {});
    if (!msg.key.fromMe) {
      await sendMentionStickerIfNeeded(sock, from, mentionedJids, normalizedMsg).catch((err) => {
        logger.warn({ err }, "Failed to send mention sticker");
      });
    }
  }

  if (isGroup && body && !isCommandBody) {
    const antiSpam = await checkAntispam(sock, from, sender, isAdmin).catch(() => false);
    if (antiSpam) return;

    const antiLink = await checkAntilink(sock, from, sender, body, normalizedMsg.key, isAdmin).catch(() => false);
    if (antiLink) return;

    // .antism — delete messages that are replies to WhatsApp Statuses
    const msgGroup = await getGroup(from);
    if (msgGroup?.antispam === "on" && !isAdmin) {
      const ctxInfo = getContextInfo(messageContent);
      const isStatusReply = ctxInfo?.remoteJid === "status@broadcast" ||
        ctxInfo?.quotedMessage?.statusMentionMessage != null ||
        (ctxInfo?.stanzaId && ctxInfo?.participant?.includes("status"));
      if (isStatusReply) {
        await sock.sendMessage(from, { delete: normalizedMsg.key as any }).catch(() => {});
        return;
      }
    }

    const bl = await checkBlacklist(sock, from, sender, body, msg.key, isAdmin).catch(() => false);
    if (bl) return;

    await checkAutoSpawn(sock, from).catch(() => {});
  }

  if (!isCommandBody) {
    const plainGet = trimmedBody.match(/^get\s+(\S+)/i);
    if (plainGet && isGroup) {
      return handleGetCard(sock, from, sender, plainGet[1]);
    }
    if (isGroup) {
      const handled = await handleGameInput(
        {
          sock, msg: normalizedMsg, from, sender, command: "", args: [], isAdmin, isBotAdmin,
          isOwner, isGroupAdmin, groupMeta, prefix: PREFIX, body,
        },
        body
      ).catch(() => false);
      if (handled) return;
    }

    // ── AI companion activation check ────────────────────────────────────────
    // The active persona (Echidna, Euphemia, etc. — see personas.ts) responds
    // to: @mentions (by JID or LID), replies to bot, persona name mention,
    // DMs, or when echidna_chat is enabled for the group.
    if (body.trim().length > 0) {
      const botSock = sock as any;
      const botJid: string = botSock?.user?.id || "";
      const botLid: string = botSock?.user?.lid || "";
      const contextInfo = getContextInfo(normalizedMsg.message as any);
      const quotedParticipant: string = contextInfo?.participant || "";
      const botPhone = botJid.split("@")[0].split(":")[0];
      const botLidNum = botLid.split("@")[0].split(":")[0];
      // Normalise both sides before comparing so :0 device suffixes don't cause mismatches
      const quotedPhone = quotedParticipant.split("@")[0].split(":")[0];
      const isReplyToBot = !!(quotedPhone && (
        quotedPhone === botPhone ||
        (botLidNum && quotedPhone === botLidNum)
      ));
      const groupRecord = isGroup ? await getGroup(from) : null;
      const echidnaChatEnabled = groupRecord?.echidna_chat === "on";
      const persona = getPersona(getPersonaForSock(sock));

      const shouldReply = shouldEchidnaRespond({
        isGroup,
        from,
        body,
        botJid,
        botLid,
        isReplyToBot,
        echidnaChatEnabled,
        mentionedJids,
        persona,
      });

      if (shouldReply) {
        // Always quote the triggering message so the companion replies directly to
        // the user — whether they were @mentioned, named, replied to, or just
        // chatting in an always-on group.
        handleEchidnaMessage(
          sock,
          from,
          sender,
          body,
          normalizedMsg,
          msg.pushName || undefined,
          persona.key
        ).catch((err) => logger.warn({ err }, "Companion response failed"));
        return;
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    return;
  }

  logger.info({ from, sender, commandText: trimmedBody.slice(0, 80), fromMe: !!msg.key.fromMe }, "Processing WhatsApp group command");

  const [rawCmd, ...args] = trimmedBody.slice(PREFIX.length).trim().split(/\s+/);
  const command = rawCmd.toLowerCase();
  const replySock = createReplySocket(sock, normalizedMsg);

  const ctx: CommandContext = {
    sock: replySock, msg: normalizedMsg, from, sender, command, args, isAdmin, isBotAdmin,
    isOwner, isGroupAdmin, groupMeta, prefix: PREFIX, body: trimmedBody,
    resolvedMentions, lidFallbackPhone, senderRaw,
  };

  try {
    await runWithReplyContext(normalizedMsg, () => dispatch(ctx));
  } catch (err) {
    logger.error({ err, command }, "Error dispatching command");
    await sendText(from, `❌ An error occurred. Please try again.`).catch(() => {});
  }
}

function unwrapMessage(message: any): any {
  let current = message;
  for (let i = 0; i < 8; i++) {
    if (!current) return message;
    if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message;
      continue;
    }
    if (current.viewOnceMessage?.message) {
      current = current.viewOnceMessage.message;
      continue;
    }
    if (current.viewOnceMessageV2?.message) {
      current = current.viewOnceMessageV2.message;
      continue;
    }
    if (current.documentWithCaptionMessage?.message) {
      current = current.documentWithCaptionMessage.message;
      continue;
    }
    if (current.editedMessage?.message) {
      current = current.editedMessage.message;
      continue;
    }
    return current;
  }
  return current || message;
}

function getContextInfo(message: any): any {
  return message?.extendedTextMessage?.contextInfo ||
    message?.imageMessage?.contextInfo ||
    message?.videoMessage?.contextInfo ||
    message?.documentMessage?.contextInfo ||
    message?.stickerMessage?.contextInfo ||
    message?.buttonsResponseMessage?.contextInfo ||
    message?.listResponseMessage?.contextInfo ||
    message?.templateButtonReplyMessage?.contextInfo ||
    {};
}

async function sendMentionStickerIfNeeded(sock: WASocket, from: string, mentionedJids: string[], quoted: proto.IWebMessageInfo): Promise<void> {
  for (const jid of mentionedJids) {
    if (!await canUseMentionSticker(jid)) continue;
    const sticker = getBotSetting(`mention_sticker:${jid}`);
    if (!sticker) continue;
    await sock.sendMessage(from, { sticker }, { quoted: quoted as any });
  }
}

async function canUseMentionSticker(jid: string): Promise<boolean> {
  const phone = jid.split("@")[0].split(":")[0].replace(/\D/g, "");
  if (isOwnerPhone(phone)) return true;
  if (jid.endsWith("@lid")) {
    const lidUser = await getUserByLid(jid);
    if (lidUser && isOwnerPhone(lidUser.id)) return true;
  }
  const staff = await getStaff(jid);
  if (staff?.role === "mod" || staff?.role === "guardian") return true;
  const user = await getUser(jid);
  if (!user?.premium) return false;
  const expiry = Number(user.premium_expiry || 0);
  return expiry === 0 || expiry > Math.floor(Date.now() / 1000);
}

const UNREG_ALLOWED_CMDS = new Set([
  "reg", "register", "link", "verify",
  "menu", "ping", "test", "alive", "uptime",
  "info", "help", "website", "community",
  "rpggroup", "rpggc", "gamblinggroup", "gamblinggc", "gamblegc",
]);

async function dispatch(ctx: CommandContext): Promise<void> {
  const { command, from, sender, msg } = ctx;

  const isPrivilegedStaff = !!(await getStaff(sender)) || (!!(ctx.lidFallbackPhone) && !!(await getStaff(ctx.lidFallbackPhone)));
  if (isPrivilegedStaff && !(await getUser(sender)) && !(ctx.lidFallbackPhone && await getUser(ctx.lidFallbackPhone))) {
    try {
      const { ensureUser: ensureStaffUser } = await import("../db/queries.js");
      const staffPhone = ctx.lidFallbackPhone || sender.split("@")[0].split(":")[0].replace(/\D/g, "");
      await ensureStaffUser(staffPhone, msg.pushName || undefined);
    } catch (err) {
      logger.debug({ err }, "Could not auto-ensure staff user row");
    }
  }
  if (!UNREG_ALLOWED_CMDS.has(command) && !ctx.isOwner && !isPrivilegedStaff) {
    // getUser() extracts the phone from the JID. If group metadata resolution
    // failed and sender is still an @lid JID, the extracted digits are the LID,
    // not the phone — so look up by LID as a fallback before giving up.
    const senderUser = await getUser(sender) ?? (ctx.lidFallbackPhone ? await getUser(ctx.lidFallbackPhone) : null);
    if (!senderUser?.registered) {
      await sendText(
        from,
        `❌ *Not registered yet.*\n\n` +
        `To use bot commands:\n\n` +
        `*Option A — Link via WhatsApp:*\n` +
        `1. Type *.reg <your phone number>* — e.g. *.reg 2348144550593*\n` +
        `2. Enter the code with *.verify <code>*\n\n` +
        `*Option B — Register on the website first:*\n` +
        `${process.env["WEBSITE_URL"] || "https://requiem-order.onrender.com"}\n\n` +
        `_Then type *.reg <phone>* here to connect your WhatsApp._`
      );
      return;
    }
  }

  switch (command) {
    case "menu":
      return handleMenu(ctx);

    case "staffmenu":
    case "adminmenu":
    case "modmenu":
      return handleStaffMenu(ctx);

    case "setmenuimg": {
      if (!ctx.isOwner && (await getStaff(sender))?.role !== "guardian") {
        await sendText(from, "❌ Only the owner or a guardian can set the menu image.");
        return;
      }
      return handleSetMenuImage(ctx);
    }

    case "ping":
    case "test":
    case "alive": {
      const pingMs = getPingMs(msg);
      await Promise.all([
        ctx.sock.sendMessage(from, { react: { text: "✅", key: msg.key } }).catch(() => {}),
        sendText(from, `🌌 *${getBotName()}* — 反逆 Online\n⚡ ${pingMs}ms`),
      ]);
      return;
    }

    case "uptime": {
      const u = process.uptime();
      const d = Math.floor(u / 86400);
      const h = Math.floor((u % 86400) / 3600);
      const m = Math.floor((u % 3600) / 60);
      const s = Math.floor(u % 60);
      const uptimeStr = d > 0 ? `${d}d ${h}h ${m}m ${s}s` : `${h}h ${m}m ${s}s`;
      await sendText(from, `⏱️ *Requiem Order* has been online for: *${uptimeStr}*`);
      return;
    }

    case "info":
      return handleInfo(ctx);

    case "help":
      return handleHelp(ctx);

    case "website": {
      const websiteUrl = process.env["WEBSITE_URL"] || "https://requiem-order.onrender.com";
      await sendText(from, `🌐 *Requiem Order — Official Website*\n\n${websiteUrl}\n\n_View your profile, cards, shop, leaderboard and more._`);
      return;
    }

    case "rpggroup":
    case "rpggc":
      await sendText(from, "⚔️ *Requiem RPG Group*\n\n⦿ Rᴇǫᴜɪᴇᴍ Rᴘɢ ⦿\nhttps://chat.whatsapp.com/ImIccJmupOWGwtvidmagv4?s=cl&p=a&ilr=1&amv=2\n\n_Dungeons, raids, and RPG combat happen here._");
      return;

    case "gamblinggroup":
    case "gamblinggc":
    case "gamblegc":
      await sendText(from, "🎲 *Requiem Gambling Group*\n\n⦿ Rᴇǫᴜɪᴇᴍ Gᴀᴍʙʟɪɴɢ ⦿\nhttps://chat.whatsapp.com/JNAUOAw9IuyIMKeV8L2Nv8?s=cl&p=a&ilr=1&amv=2\n\n_Slots, dice, roulette and all gambling games live here._");
      return;

    case "community": {
      const msg =
        `⦿ *Rᴇǫᴜɪᴇᴍ Oʀᴅᴇʀ ⦿ — Community Groups*\n\n` +
        `🏠 *Main Community*\n` +
        `⦿ Rᴇǫᴜɪᴇᴍ Oʀᴅᴇʀ ⦿\n` +
        `https://chat.whatsapp.com/Dvr9aW1HeJQ2NA1RyqhrBQ\n\n` +
        `⚔️ *RPG Group*\n` +
        `⦿ Rᴇǫᴜɪᴇᴍ Rᴘɢ ⦿\n` +
        `https://chat.whatsapp.com/ImIccJmupOWGwtvidmagv4?s=cl&p=a&ilr=1&amv=2\n\n` +
        `🎲 *Gambling Group*\n` +
        `⦿ Rᴇǫᴜɪᴇᴍ Gᴀᴍʙʟɪɴɢ ⦿\n` +
        `https://chat.whatsapp.com/JNAUOAw9IuyIMKeV8L2Nv8?s=cl&p=a&ilr=1&amv=2\n\n` +
        `_Join the group that fits your playstyle!_`;
      await sendText(from, msg);
      return;
    }

    // ── .verify <code> ──────────────────────────────────────────────────────
    // Step 2 of WhatsApp account linking.
    // Validates OTP then runs a single TRANSACTION that:
    //   4a. Writes the confirmed lid onto the canonical phone-keyed row
    //   4b. Deletes any extra rows sharing the same phone (ghost dupes)
    //   4c. Deletes any row that claimed the same lid under a different phone
    // After the transaction exactly ONE row owns this phone, ONE owns this lid.
    case "verify": {
      // Must derive the OTP lookup key EXACTLY the same way .link/.reg derived
      // it when storing the OTP (senderPhone2 there), or a lidFallbackPhone
      // mismatch between the two messages causes a false "no pending request"
      // even though the code was sent correctly seconds earlier.
      const senderPhone = ctx.senderRaw.endsWith("@lid")
        ? (ctx.lidFallbackPhone || sender.split("@")[0].split(":")[0])
        : sender.split("@")[0].split(":")[0];
      const already = await getUser(senderPhone);
      // Short-circuit only when FULLY linked (both registered AND lid set)
      if (already?.registered && already?.lid) {
        await sendText(from, "✅ *Already linked!* Type *.p* to see your profile.");
        return;
      }
      const inputCode = ctx.args[0]?.trim();
      if (!inputCode) {
        await sendText(from, "❌ Usage: *.verify <code>*\n\nRun *.link <phone>* first to get a code.");
        return;
      }
      const { col: colOtp } = await import("../db/mongo.js");
      const nowSec = Math.floor(Date.now() / 1000);
      const otpRow = await colOtp("whatsapp_link_otps").findOne({ wa_sender: senderPhone });
      if (!otpRow) {
        await sendText(from, "❌ No pending link request found.\n\nType *.link <phone>* to start the process.");
        return;
      }
      if (otpRow.expires_at < nowSec) {
        await colOtp("whatsapp_link_otps").deleteOne({ wa_sender: senderPhone });
        await sendText(from, "❌ Code expired. Type *.link <phone>* again to get a new code.");
        return;
      }
      if (otpRow.code !== inputCode) {
        await sendText(from, "❌ Wrong code. Check your WhatsApp and try again, or run *.link <phone>* for a new code.");
        return;
      }

      // ✅ OTP verified — consume it
      await colOtp("whatsapp_link_otps").deleteOne({ wa_sender: senderPhone });
      const phone = otpRow.phone as string;

      const lidNum = ctx.senderRaw.endsWith("@lid") ? ctx.senderRaw.split("@")[0] : null;

      const CHILD_TABLES = [
        "rpg_characters", "inventory", "user_cards", "message_counts",
        "card_deck", "deck_backgrounds", "guild_members", "warnings",
        "muted_users", "summer_tokens", "afk_users", "lottery_entries",
      ] as const;

      // 4c: kill any row that already owns THIS lid under a different phone
      if (lidNum) {
        const lidConflict = await colOtp("users").findOne({ lid: lidNum, _id: { $ne: phone } });
        if (lidConflict) {
          await colOtp("users").updateOne({ _id: phone }, [
            { $set: {
              balance: { $add: ["$balance", lidConflict.balance || 0] },
              xp: { $max: ["$xp", lidConflict.xp || 0] },
              level: { $max: ["$level", lidConflict.level || 0] },
            }}
          ] as any);
          for (const t of CHILD_TABLES) {
            try { await colOtp(t).updateMany({ user_id: lidConflict._id }, { $set: { user_id: phone } }); } catch {}
          }
          await colOtp("users").deleteOne({ _id: lidConflict._id as string });
        }
      }

      // Ensure the canonical phone-keyed row exists
      const existing = await colOtp("users").findOne({ $or: [{ _id: phone }, { phone }] });
      if (!existing) {
        await colOtp("users").insertOne({
          _id: phone, phone, whatsapp_id: senderPhone, lid: lidNum,
          registered: 1, registered_at: nowSec, balance: 45000, created_at: nowSec,
        });
      } else if (existing._id !== phone) {
        const { _id: oldId, ...restExisting } = existing;
        await colOtp("users").insertOne({
          ...restExisting, _id: phone, phone,
          whatsapp_id: senderPhone,
          lid: existing.lid ?? lidNum,
          registered: 1,
          registered_at: existing.registered_at || nowSec,
        });
        for (const t of CHILD_TABLES) {
          try { await colOtp(t).updateMany({ user_id: oldId }, { $set: { user_id: phone } }); } catch {}
        }
        await colOtp("users").deleteOne({ _id: oldId as string });
      } else {
        await colOtp("users").updateOne({ _id: phone }, { $set: {
          whatsapp_id: senderPhone,
          lid: existing.lid ?? lidNum,
          registered: 1,
          registered_at: existing.registered_at || nowSec,
          phone,
        }});
      }

      // Write lid onto canonical row
      if (lidNum) {
        await colOtp("users").updateOne({ _id: phone }, { $set: { lid: lidNum } });
      }

      // Delete any ghost rows sharing same phone
      await colOtp("users").deleteMany({ phone, _id: { $ne: phone } });

      // Migrate senderPhone ghost row
      if (senderPhone !== phone) {
        for (const t of CHILD_TABLES) {
          try { await colOtp(t).updateMany({ user_id: senderPhone }, { $set: { user_id: phone } }); } catch {}
        }
        await colOtp("users").deleteOne({ _id: senderPhone });
      }

      const userRow = await colOtp("users").findOne({ _id: phone });
      const displayName = userRow?.name && userRow.name !== phone ? userRow.name : `+${phone}`;
      const balance = userRow?.balance ?? 45000;
      await sendText(
        from,
        `✅ *Account Linked!*\n\n` +
        `Welcome, *${displayName}*! Your WhatsApp is now connected to your Requiem Order account.\n\n` +
        `💰 *Balance:* $${balance.toLocaleString()}\n\n` +
        `📝 _Visit the website to set your name and password._\n` +
        `Type *.p* to see your profile or *.help* for all commands.`
      );
      return;
    }

    case "afk":
      return handleAfk(ctx);

    case "get":
      if (ctx.args[0]) {
        return handleGetCard(ctx.sock, from, sender, ctx.args[0]);
      }
      return;

    case "spawncard":
      if (ctx.isOwner || !!(await getStaff(senderPhone))) {
        const { spawnCard } = await import("./cardspawn.js");
        return spawnCard(ctx.sock as any, from);
      }
      return;

    case "kick":
    case "delete":
    case "del":
    case "d":
    case "warn":
    case "resetwarn":
    case "antilink":
    case "antism":
    case "welcome":
    case "setwelcome":
    case "leave":
    case "setleave":
    case "promote":
    case "demote":
    case "pm":
    case "dm":
    case "mute":
    case "unmute":
    case "open":
    case "close":
    case "hidetag":
    case "tagall":
    case "activity":
    case "active":
    case "inactive":
    case "gamble":
    case "gambling":
    case "cards":
    case "antibot":
    case "purge":
    case "blacklist":
    case "groupinfo":
    case "gi":
    case "groupstats":
    case "gs":
    case "gcl":
    case "gclink":
      return handleAdmin(ctx);

    // ── .reg <phone> / .link <phone> ──────────────────────────────────────────
    // Unified registration+link command.
    //   3a. Phone row exists + registered → "already linked", STOP
    //   3b. Phone row exists but not registered → send OTP (re-link allowed)
    //    4. No row for that phone → create ghost row anchored to phone, then OTP
    // Without a phone arg → show instructions.
    case "reg":
    case "register":
    case "link": {
      // If first arg looks like a 6-digit code, it's a .verify shorthand
      if (/^\d{6}$/.test(ctx.args[0]?.trim() || "")) {
        return dispatch({ ...ctx, command: "verify" });
      }
      const rawPhone = ctx.args[0]?.replace(/\D/g, "") || "";
      if (!rawPhone || rawPhone.length < 7 || rawPhone.length > 15) {
        // Show unified instructions
        await sendText(
          from,
          `👋 *Welcome to Requiem Order 反逆!*\n\n` +
          `To register or link your WhatsApp account:\n\n` +
          `1️⃣ Type *.reg <your phone number>*\n` +
          `   _Example: .reg 2348144550593_\n\n` +
          `2️⃣ A 6-digit code will be sent to your private messages.\n\n` +
          `3️⃣ Type *.verify <code>* to confirm and activate your account.\n\n` +
          `> Already registered on the website? Use the same phone number you signed up with.`
        );
        return;
      }
      // Use the raw (pre-resolution) sender to build the DM JID.
      // If LID resolution succeeded, ctx.sender is already a @s.whatsapp.net
      // phone JID. If not (still @lid), fall back to whatever phone we have.
      // Either way we send to senderPhone2@s.whatsapp.net which is the canonical
      // address WhatsApp accepts for DMs.
      const senderPhone2 = ctx.senderRaw.endsWith("@lid")
        ? (ctx.lidFallbackPhone || sender.split("@")[0].split(":")[0])
        : sender.split("@")[0].split(":")[0];

      // Derive incoming LID from the raw (un-resolved) sender JID
      const incomingLidNum = ctx.senderRaw.endsWith("@lid") ? ctx.senderRaw.split("@")[0] : null;

      // Check by the CLAIMED phone number (rawPhone) — that's the canonical key
      const { col: colReg } = await import("../db/mongo.js");
      const alreadyUser = await colReg("users").findOne({ $or: [{ _id: rawPhone }, { phone: rawPhone }] });

      // 3a: fully registered already — gate closed
      if (alreadyUser?.registered) {
        // Link this WhatsApp lid to the existing web-registered row so future
        // commands (which arrive as @lid JIDs) resolve correctly.
        if (incomingLidNum) {
          await linkUserLid(rawPhone, incomingLidNum);
        }
        await sendText(from, "✅ *This number is already registered.*\n\nType *.p* to view your profile or visit the website to log in.");
        return;
      }

      // 4: brand new user — anchor the phone before OTP so no orphan rows form
      if (!alreadyUser) {
        const ghostNow = Math.floor(Date.now() / 1000);
        await colReg("users").insertOne({ _id: rawPhone, phone: rawPhone, lid: incomingLidNum, registered: 0, created_at: ghostNow, updated_at: ghostNow });
      }

      // 3b / 4 continued: generate OTP and send to sender's DM
      const regCode = String(Math.floor(100000 + Math.random() * 900000));
      const regExpiry = Math.floor(Date.now() / 1000) + 300;
      await colReg("whatsapp_link_otps").replaceOne(
        { wa_sender: senderPhone2 },
        { wa_sender: senderPhone2, phone: rawPhone, code: regCode, expires_at: regExpiry },
        { upsert: true }
      );
      try {
        await ctx.sock.sendMessage(`${senderPhone2}@s.whatsapp.net`, {
          text:
            `*Requiem Order 反逆 — Registration Code*\n\n` +
            `Linking to account: *+${rawPhone}*\n\n` +
            `Your code: *${regCode}*\n\n` +
            `Type *.verify ${regCode}* in any chat to complete.\n\n` +
            `_Expires in 5 minutes. Do not share this code._`,
        });
        await sendText(from, `📲 *Code sent to your private messages.*\n\nCheck your DM from this bot and type *.verify <code>* here to link your account.`);
      } catch {
        await colReg("whatsapp_link_otps").deleteOne({ wa_sender: senderPhone2 });
        await sendText(from, "❌ Couldn't send the code to your DM. Open a private chat with this bot first, then try again.");
      }
      return;
    }

    case "frame":
    case "balance":
    case "bal":
    case "gems":
    case "premium":
    case "prem":
    case "membership":
    case "memb":
    case "daily":
    case "withdraw":
    case "wid":
    case "wd":
    case "deposit":
    case "dep":
    case "donate":
    case "richlist":
    case "richlistglobal":
    case "richlg":
    case "setname":
    case "profile":
    case "p":
    case "setpp":
    case "setbg":
    case "bio":
    case "setage":
    case "inventory":
    case "inv":
    case "shop":
    case "buy":
    case "sell":
    case "use":
    case "leaderboard":
    case "lb":
    case "work":
    case "dig":
    case "fish":
    case "beg":
    case "steal":
    case "roast":
    case "stats":
      return handleEconomy(ctx);

    case "bc":
      if (ctx.args.length === 0) return handleEconomy(ctx);
      return;

    case "lc":
      if (!ctx.args[0]?.startsWith("@") && ctx.args.length < 2) {
        return handleEconomy(ctx);
      }
      return handleCards(ctx);

    case "lottery":
    case "ll":
    case "lp":
    case "drawlottery":
      return handleLottery(ctx);

    case "slots":
    case "dice":
    case "casino":
    case "coinflip":
    case "cf":
    case "doublebet":
    case "db":
    case "doublepayout":
    case "dp":
    case "roulette":
    case "horse":
    case "spin":
      return handleGambling(ctx);

    case "collection":
    case "coll":
    case "deck":
    case "sdi":
    case "card":
    case "cardinfo":
    case "ci":
    case "cs":
    case "mycollectionseries":
    case "mycolls":
    case "cardleaderboard":
    case "cardlb":
    case "cardshop":
    case "stardust":
    case "vs":
    case "auction":
    case "auctions":
    case "myauc":
    case "remauc":
    case "listauc":
    case "bid":
    case "claim":
    case "si":
    case "slb":
    case "tier":
    case "myseries":
    case "ubs":
    case "ups":
    case "cg":
    case "ctd":
    case "lcd":
    case "retrieve":
    case "sellc":
    case "tc":
    case "accept":
    case "decline":
    case "ss":
    case "sc":
    case "deletecard":
    case "delcard":
    case "forge":
    case "fuse":
    case "fusion":
      return handleCards(ctx);

    case "tictactoe":
    case "ttt":
    case "connectfour":
    case "c4":
    case "wordchain":
    case "wcg":
    case "joinwcg":
    case "startbattle":
    case "truthordare":
    case "td":
    case "truth":
    case "dare":
    case "stopgame":
    case "uno":
    case "startuno":
    case "unoplay":
    case "unodraw":
    case "unohand":
    case "unouno":
    case "unocatch":
      return handleGames(ctx);

    case "gay":
    case "lesbian":
    case "simp":
    case "match":
    case "ship":
    case "character":
    case "psize":
    case "pp":
    case "duality":
    case "gen":
    case "pov":
    case "social":
    case "relation":
    case "wouldyourather":
    case "wyr":
    case "joke":
    case "fancy":
    case "rizz":
      return handleFun(ctx);

    case "hug":
    case "kiss":
    case "slap":
    case "wave":
    case "pat":
    case "dance":
    case "sad":
    case "smile":
    case "laugh":
    case "punch":
    case "kill":
    case "hit":
    case "kidnap":
    case "lick":
    case "bonk":
    case "tickle":
    case "shrug":
    case "bite":
    case "cry":
    case "blush":
      return handleInteraction(ctx);

    case "adventure":
    case "rpg":
    case "rpgstats":
    case "dungeon":
    case "heal":
    case "quest":
    case "raid":
    case "class":
    case "skill":
    case "achievements":
    case "achieve":
    case "arcane":
    case "attack":
    case "heavy":
    case "defend":
    case "special":
    case "item":
    case "flee":
    case "explore":
    case "rest":
      return handleRpg(ctx);

    case "ai":
    case "gpt":
    case "translate":
    case "tt":
    case "chat":
      return handleAI(ctx);

    case "mem":
      return handleEchidnaInfo(ctx);

    case "comp":
      return handleEchidnaInfo(ctx);

    case "botreply":
    case "chatbot":
      return handleBotReply(ctx);

    case "sticker":
    case "s":
    case "take":
    case "toimg":
    case "turnimg":
    case "play":
    case "speech":
    case "mood":
    case "pintimg":
      return handleConverter(ctx);

    case "summer":
    case "token":
      return handleSummer(ctx);

    case "guild":
      return handleGuilds(ctx);

    case "bots":
    case "addguardian":
    case "addmod":
    case "removeguardian":
    case "removemod":
    case "recruit":
    case "addpremium":
    case "removepremium":
    case "mods":
    case "modlist":
    case "modslist":
    case "cardmakers":
    case "post":
    case "join":
    case "setms":
    case "delms":
    case "exit":
    case "show":
    case "dc":
    case "ac":
    case "rc":
    case "upload":
    case "ban":
    case "unban":
    case "banlist":
    case "resetbal":
    case "reset":
    case "addinv":
    case "rules":
    case "addrole":
    case "fetchcards":
    case "summon":
    case "restart":
      return handleStaff(ctx);

    case "pullcards":
      return handlePullCards(ctx);

    case "synccards":
      return handleSyncCards(ctx);

    case "cardlogs":
      return handleCardLogs(ctx);

    case "cds":
      return handleEconomy(ctx);

    default:
      break;
  }
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
        logger.warn({ attempt, delay }, "Rate-overlimit on reply socket, retrying");
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

function createReplySocket(sock: WASocket, msg: proto.IWebMessageInfo): WASocket {
  return new Proxy(sock as any, {
    get(target, prop) {
      if (prop !== "sendMessage") {
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (jid: string, content: any, options?: any) => {
        if (content?.delete || content?.react || content?.edit) {
          return sendWithRetry(() => target.sendMessage(jid, content, options));
        }
        return sendWithRetry(() => target.sendMessage(jid, content, { quoted: msg, ...(options || {}) }));
      };
    },
  }) as WASocket;
}

function getPrimaryBotJid(sock: WASocket): string {
  const id = sock.user?.id || "";
  const decoded = normalizeJid(id);
  return decoded || id;
}

function getBotIdentityCandidates(sock: WASocket): string[] {
  const candidates = new Set<string>();
  const id = sock.user?.id || "";
  const lid = (sock.user as any)?.lid || "";
  for (const value of [id, lid, getPrimaryBotJid(sock)]) {
    if (!value) continue;
    candidates.add(value);
    const normalized = normalizeJid(value);
    if (normalized) candidates.add(normalized);
    const user = normalized.split("@")[0];
    if (user) {
      candidates.add(`${user}@s.whatsapp.net`);
      candidates.add(`${user}@lid`);
    }
  }
  return [...candidates];
}

function sameWhatsAppUser(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const na = normalizeJid(a);
  const nb = normalizeJid(b);
  if (na === nb) return true;
  const au = na.split("@")[0];
  const bu = nb.split("@")[0];
  return !!au && au === bu;
}

function normalizeJid(jid: string): string {
  if (!jid) return "";
  const [userPart, serverPart = "s.whatsapp.net"] = jid.split("@");
  const user = userPart.split(":")[0];
  return `${user}@${serverPart}`;
}

function getPingMs(msg: proto.IWebMessageInfo): number {
  const raw = msg.messageTimestamp as any;
  const seconds = typeof raw === "number" ? raw : Number(raw?.low || raw || 0);
  const sent = seconds > 0 ? seconds * 1000 : Date.now();
  return Math.max(1, Date.now() - sent);
}
