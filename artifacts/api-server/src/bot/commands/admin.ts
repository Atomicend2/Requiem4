import type { WASocket } from "@whiskeysockets/baileys";
import type { CommandContext } from "./index.js";
import {
  ensureGroup, getGroup, updateGroup, getWarnings, addWarning, resetWarnings,
  getActiveMembers, getInactiveMembers, getMods, addMod, isMod, getGroupActivity,
  muteUser, unmuteUser, getCardStats, getStaff, getMentionName,
} from "../db/queries.js";
import { sendText } from "../connection.js";
import { formatNumber, mentionTag } from "../utils.js";
import { resolveMentionedJid } from "../utils/identity.js";

export async function handleAdmin(ctx: CommandContext): Promise<void> {
  const { sock, msg, from, sender, args, isAdmin, isBotAdmin, isOwner, isGroupAdmin, groupMeta, prefix, resolvedMentions } = ctx;
  const cmd = ctx.command;

  if (!from.endsWith("@g.us")) {
    await sendText(from, "❌ This command can only be used in groups.");
    return;
  }

  const group = getGroup(from) || {};
  const canUse = isAdmin || isMod(sender, from) || isOwner;

  if (cmd === "kick") {
    if (!canUse) return noPerms(from);
    if (!isBotAdmin) return botNoAdmin(from);
    const info = msg.message?.extendedTextMessage?.contextInfo;
    const rawMentioned = resolvedMentions[0]
      || info?.participant
      || (args[0] ? `${args[0].replace(/\D/g, "")}@s.whatsapp.net` : null);
    if (!rawMentioned) {
      await sendText(from, "❌ Please mention someone to kick or reply to their message with .kick.");
      return;
    }
    const mentioned = rawMentioned;
    await sock.groupParticipantsUpdate(from, [mentioned], "remove");
    await sock.sendMessage(from, {
      text: `🚫 @${getMentionName(mentioned)} has been kicked successfully.`,
      mentions: [mentioned],
    });
    return;
  }

  if (cmd === "delete" || cmd === "del") {
    if (!canUse) return noPerms(from);
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.stanzaId;
    if (!quoted) {
      await sendText(from, "❌ Reply to a message to delete it.");
      return;
    }
    const key = {
      remoteJid: from,
      fromMe: false,
      id: quoted,
      participant: msg.message?.extendedTextMessage?.contextInfo?.participant,
    };
    await sock.sendMessage(from, { delete: key });
    return;
  }

  if (cmd === "warn") {
    if (!canUse) return noPerms(from);
    const rawMentioned = resolvedMentions[0];
    if (!rawMentioned) {
      await sendText(from, "❌ Please mention someone to warn.");
      return;
    }
    const mentioned = resolveMentionedJid(rawMentioned, groupMeta);
    const reason = args.slice(1).join(" ") || "No reason provided";
    const warns = addWarning(mentioned, from, reason, sender);
    const count = warns.length;
    await sendText(
      from,
      `┌─❖\n│「 ⚠️ 𝗪𝗔𝗥𝗡𝗜𝗡𝗚 」\n└┬❖ 「 @${getMentionName(mentioned)} 」\n│✑ 𝗥𝗘𝗔𝗦𝗢𝗡: ${reason}\n│✑ 𝗗𝗲𝘃𝗶𝗰𝗲: WhatsApp\n│✑ 𝗟𝗜𝗠𝗜𝗧: ${count} / 5\n└────────────┈ ⳹`,
      [mentioned]
    );
    if (count >= 5) {
      if (isBotAdmin) {
        await sock.groupParticipantsUpdate(from, [mentioned], "remove");
        await sendText(from, `🚫 @${getMentionName(mentioned)} reached 5 warnings and was removed.`, [mentioned]);
      }
    }
    return;
  }

  if (cmd === "resetwarn") {
    if (!canUse) return noPerms(from);
    const rawMentioned = resolvedMentions[0];
    if (!rawMentioned) {
      await sendText(from, "❌ Please mention someone.");
      return;
    }
    const mentioned = resolveMentionedJid(rawMentioned, groupMeta);
    resetWarnings(mentioned, from);
    await sendText(from, `✅ Warnings reset for @${getMentionName(mentioned)}.`, [mentioned]);
    return;
  }

  if (cmd === "antilink") {
    if (!canUse) return noPerms(from);
    const action = args[0]?.toLowerCase();
    if (!action || action === "on") {
      updateGroup(from, { antilink: "on", antilink_action: args[1] || "delete" });
      await sendText(from, `🔗 Anti-Link enabled (action: ${args[1] || "delete"})`);
    } else if (action === "off") {
      updateGroup(from, { antilink: "off" });
      await sendText(from, "🔗 Anti-Link disabled.");
    } else if (action === "set") {
      const a = args[1]?.toLowerCase();
      if (!["delete","warn","kick"].includes(a)) {
        await sendText(from, "Valid actions: delete, warn, kick");
        return;
      }
      updateGroup(from, { antilink: "on", antilink_action: a });
      await sendText(from, `🔗 Anti-Link action set to: ${a}`);
    }
    return;
  }

  if (cmd === "antism") {
    if (!canUse) return noPerms(from);
    const val = args[0]?.toLowerCase();
    if (val === "on") {
      updateGroup(from, { antispam: "on" });
      await sendText(from, "🚫 Anti-Spam enabled.");
    } else {
      updateGroup(from, { antispam: "off" });
      await sendText(from, "🚫 Anti-Spam disabled.");
    }
    return;
  }

  if (cmd === "welcome") {
    if (!canUse) return noPerms(from);
    const val = args[0]?.toLowerCase();
    updateGroup(from, { welcome: val === "on" ? "on" : "off" });
    await sendText(from, `✉️ Welcome messages ${val === "on" ? "enabled" : "disabled"}.`);
    return;
  }

  if (cmd === "setwelcome") {
    if (!canUse) return noPerms(from);
    const msg_text = args.join(" ");
    if (!msg_text) {
      await sendText(from, "❌ Usage: .setwelcome <message>\nUse @user where the new member should be tagged.\nExample: .setwelcome @user, welcome to Requiem Order 反逆!");
      return;
    }
    updateGroup(from, { welcome_msg: msg_text });
    const preview = msg_text.replace(/@user/gi, mentionTag(sender)).replace(/@mention/gi, mentionTag(sender));
    await sendText(
      from,
      `✅ Welcome message set!\n\nPreview:\n${preview}\n\n_Use @user as placeholder for the joining member._`,
      (/@user/i.test(msg_text) || /@mention/i.test(msg_text)) ? [sender] : []
    );
    return;
  }

  if (cmd === "leave") {
    if (!canUse) return noPerms(from);
    const val = args[0]?.toLowerCase();
    updateGroup(from, { leave: val === "on" ? "on" : "off" });
    await sendText(from, `🚪 Leave messages ${val === "on" ? "enabled" : "disabled"}.`);
    return;
  }

  if (cmd === "setleave") {
    if (!canUse) return noPerms(from);
    const msg_text = args.join(" ");
    if (!msg_text) {
      await sendText(from, "❌ Usage: .setleave <message>\nUse @user as placeholder.\nExample: .setleave @user has left Requiem Order 反逆. Goodbye!");
      return;
    }
    updateGroup(from, { leave_msg: msg_text });
    const preview = msg_text.replace(/@user/gi, mentionTag(sender)).replace(/@mention/gi, mentionTag(sender));
    await sendText(
      from,
      `✅ Leave message set!\n\nPreview:\n${preview}`,
      (/@user/i.test(msg_text) || /@mention/i.test(msg_text)) ? [sender] : []
    );
    return;
  }

  if (cmd === "promote") {
    if (!canUse) return noPerms(from);
    if (!isBotAdmin) return botNoAdmin(from);
    const rawMentioned = resolvedMentions[0]
      || msg.message?.extendedTextMessage?.contextInfo?.participant;
    if (!rawMentioned) {
      await sendText(from, "❌ Please mention someone.");
      return;
    }
    const mentioned = resolveMentionedJid(rawMentioned, groupMeta);
    await sock.groupParticipantsUpdate(from, [mentioned], "promote");
    await sock.sendMessage(from, {
      text: `@${getMentionName(mentioned)} is now an admin`,
      mentions: [mentioned],
    });
    return;
  }

  if (cmd === "demote") {
    if (!canUse) return noPerms(from);
    if (!isBotAdmin) return botNoAdmin(from);
    const rawMentioned = resolvedMentions[0]
      || msg.message?.extendedTextMessage?.contextInfo?.participant;
    if (!rawMentioned) {
      await sendText(from, "❌ Please mention someone.");
      return;
    }
    const mentioned = resolveMentionedJid(rawMentioned, groupMeta);
    await sock.groupParticipantsUpdate(from, [mentioned], "demote");
    await sock.sendMessage(from, {
      text: `@${getMentionName(mentioned)} is no longer an admin`,
      mentions: [mentioned],
    });
    return;
  }

  if (cmd === "pm") {
    const staffRole = getStaff(sender);
    const canPromote = isOwner || staffRole?.role === "mod" || staffRole?.role === "guardian";
    if (!canPromote) return noPerms(from);
    if (!isBotAdmin) return botNoAdmin(from);
    const rawMentioned = resolvedMentions[0]
      || msg.message?.extendedTextMessage?.contextInfo?.participant;
    if (!rawMentioned) { await sendText(from, "❌ Mention someone to promote. Usage: .pm @user"); return; }
    const mentioned = resolveMentionedJid(rawMentioned, groupMeta);
    await sock.groupParticipantsUpdate(from, [mentioned], "promote");
    await sock.sendMessage(from, { text: `✅ @${getMentionName(mentioned)} has been promoted to admin.`, mentions: [mentioned] });
    return;
  }

  if (cmd === "dm") {
    const staffRole = getStaff(sender);
    const canDemote = isOwner || staffRole?.role === "mod" || staffRole?.role === "guardian";
    if (!canDemote) return noPerms(from);
    if (!isBotAdmin) return botNoAdmin(from);
    const rawMentioned = resolvedMentions[0]
      || msg.message?.extendedTextMessage?.contextInfo?.participant;
    if (!rawMentioned) { await sendText(from, "❌ Mention someone to demote. Usage: .dm @user"); return; }
    const mentioned = resolveMentionedJid(rawMentioned, groupMeta);
    await sock.groupParticipantsUpdate(from, [mentioned], "demote");
    await sock.sendMessage(from, { text: `✅ @${getMentionName(mentioned)} has been demoted.`, mentions: [mentioned] });
    return;
  }

  if (cmd === "mute") {
    if (!canUse) return noPerms(from);
    if (!isBotAdmin) return botNoAdmin(from);
    const info = msg.message?.extendedTextMessage?.contextInfo;
    const rawTarget = resolvedMentions[0] || info?.participant || null;
    if (rawTarget) {
      const target = resolveMentionedJid(rawTarget, groupMeta);
      const durationText = info?.mentionedJid?.[0] ? args[1] : args[0];
      const durationSeconds = parseDuration(durationText || "1h");
      if (!durationSeconds) {
        await sendText(from, "❌ Usage: .mute @user <time>\nExamples: .mute @user 1m, or reply with .mute 1h");
        return;
      }
      const expiresAt = Math.floor(Date.now() / 1000) + durationSeconds;
      muteUser(target, from, sender, expiresAt);
      await sendText(from, `🔇 @${getMentionName(target)} muted for ${formatDuration(durationSeconds)}.`, [target]);
      return;
    }
    await sock.groupSettingUpdate(from, "announcement");
    updateGroup(from, { muted: 1 });
    await sendText(from, "🔇 Group muted. Only admins can send messages.");
    return;
  }

  if (cmd === "unmute") {
    if (!canUse) return noPerms(from);
    if (!isBotAdmin) return botNoAdmin(from);
    const info = msg.message?.extendedTextMessage?.contextInfo;
    const rawTarget = resolvedMentions[0] || info?.participant || null;
    if (rawTarget) {
      const target = resolveMentionedJid(rawTarget, groupMeta);
      unmuteUser(target, from);
      await sendText(from, `🔊 @${getMentionName(target)} unmuted.`, [target]);
      return;
    }
    await sock.groupSettingUpdate(from, "not_announcement");
    updateGroup(from, { muted: 0 });
    await sendText(from, "🔊 Group unmuted.");
    return;
  }

  if (cmd === "open") {
    if (!canUse) return noPerms(from);
    if (!isBotAdmin) return botNoAdmin(from);
    await sock.groupSettingUpdate(from, "not_announcement");
    await sendText(from, "🔓 Group opened.");
    return;
  }

  if (cmd === "close") {
    if (!canUse) return noPerms(from);
    if (!isBotAdmin) return botNoAdmin(from);
    await sock.groupSettingUpdate(from, "announcement");
    await sendText(from, "🔒 Group closed. Only admins can send messages.");
    return;
  }

  if (cmd === "hidetag") {
    if (!canUse) return noPerms(from);
    const participants = groupMeta?.participants || [];
    // Filter @lid — WhatsApp only notifies real @s.whatsapp.net JIDs
    const all = participants
      .map((p: any) => p.id as string || "")
      .filter((id: string) => id && !id.endsWith("@lid"));
    const text = args.join(" ") || "📢 Announcement";
    // Delete the command message silently
    await sock.sendMessage(from, { delete: msg.key! }).catch(() => {});
    // Send the message with all mentions (hidden tag)
    await sock.sendMessage(from, { text, mentions: all });
    return;
  }

  if (cmd === "tagall") {
    if (!canUse) return noPerms(from);
    const participants = groupMeta?.participants || [];
    // Filter @lid — WhatsApp won't notify users tagged via @lid JIDs
    const realParticipants = participants.filter((p: any) => p.id && !(p.id as string).endsWith("@lid"));
    const mentions: string[] = realParticipants.map((p: any) => p.id as string);
    const announcement = args.join(" ") || "📢 Attention everyone!";
    const senderName = getMentionName(sender);
    let memberLines = "";
    for (const p of realParticipants) {
      memberLines += `│  ➤ @${getMentionName(p.id)}\n`;
    }
    const text =
      `╭─❰ 👥 ᴛᴀɢ ᴀʟʟ ɴᴏᴛɪɢʏ ❱─╮\n` +
      `│ 📢 Message: ${announcement}\n` +
      `│ 👤 From: @${senderName}\n` +
      `│\n` +
      `├─ 📌 ᴛᴀɢ ʟɪsᴛ\n` +
      `${memberLines}` +
      `╰────────────── ───╯`;
    await sock.sendMessage(from, { text, mentions: [...mentions, sender] });
    return;
  }

  if (cmd === "activity") {
    const activity = getGroupActivity(from);
    const isActive = activity.percentage >= 30;
    const statusLine = isActive
      ? `📌 𝗦𝘁𝗮𝘁𝘂𝘀: ✅ 𝗔𝗰𝘁𝗶𝘃𝗲`
      : `📌 𝗦𝘁𝗮𝘁𝘂𝘀: ❌ 𝗜𝗻𝗮𝗰𝘁𝗶𝘃𝗲`;
    const footer = isActive
      ? `> *✅ This group has enough activity for cards to be enabled 🎴*`
      : `> *⚠️ This group needs to reach 30% in order for a mod/guardian to enable cards 🎴*`;
    const text =
      `📊 𝗚𝗥𝗢𝗨𝗣 𝗔𝗖𝗧𝗜𝗩𝗜𝗧𝗬 𝗥𝗘𝗣𝗢𝗥𝗧\n\n` +
      `💬 𝗠𝗲𝘀𝘀𝗮𝗴𝗲𝘀 (20𝗺): ${activity.count}\n` +
      `📈 𝗣𝗲𝗿𝗰𝗲𝗻𝘁𝗮𝗴𝗲: ${activity.percentage}%\n` +
      `${statusLine}\n\n` +
      `${footer}`;
    await sendText(from, text);
    return;
  }

  if (cmd === "active" || cmd === "inactive") {
    if (!canUse) return noPerms(from);
    const active = getActiveMembers(from);
    const counted = new Set(active.map((m) => m.user_id));
    const inactiveFromCounts = getInactiveMembers(from);
    const inactiveMap = new Map<string, any>();
    for (const member of inactiveFromCounts) inactiveMap.set(member.user_id, member);
    for (const participant of groupMeta?.participants || []) {
      if (!counted.has(participant.id) && !inactiveMap.has(participant.id)) {
        inactiveMap.set(participant.id, { user_id: participant.id, count: 0 });
      }
    }
    const inactive = [...inactiveMap.values()];

    let text = `╔═ ❰ 👥 𝗠𝗘𝗠𝗕𝗘𝗥 𝗦𝗧𝗔𝗧𝗦 ❱ ═╗\n`;
    text += `║ 🟢 Active Members: ${active.length}\n`;
    text += `║ 🔴 Inactive Members (≤ 5 msgs in 7d): ${inactive.length}\n║\n`;

    if (cmd !== "inactive") {
      text += `╠═ 🟢 𝗔𝗖𝗧𝗜𝗩𝗘\n`;
      for (const m of active) {
        text += `║ ○ @${getMentionName(m.user_id)}\n`;
      }
      text += "║\n";
    }

    if (cmd !== "active") {
      text += `╠═ 🔴 𝗜𝗡𝗔𝗖𝗧𝗜𝗩𝗘\n`;
      for (const m of inactive) {
        text += `║ ○ @${getMentionName(m.user_id)}\n`;
      }
    }

    text += "╚══════════════════╝";

    const all = [...active, ...inactive].map((m) => m.user_id);
    await sock.sendMessage(from, { text, mentions: all });
    return;
  }

  if (cmd === "gamble") {
    const staffRole = getStaff(sender);
    const canToggleGamble = isOwner || staffRole?.role === "mod" || staffRole?.role === "guardian";
    if (!canToggleGamble) return noPerms(from);
    const val = args[0]?.toLowerCase();
    if (val === "on") {
      updateGroup(from, { gambling_enabled: "on" });
      await sendText(from, "🎰 Gambling commands are now *enabled*.");
    } else if (val === "off") {
      updateGroup(from, { gambling_enabled: "off" });
      await sendText(from, "🎰 Gambling commands are now *disabled*.");
    } else {
      const g = getGroup(from);
      await sendText(from, `🎰 Gambling is currently: *${g?.gambling_enabled || "on"}*\nUsage: .gamble on/off`);
    }
    return;
  }

  if (cmd === "cards") {
    if (args[0]?.toLowerCase() === "available") {
      const stats = getCardStats();
      const tierLines = stats.byTier.length > 0
        ? stats.byTier.map((row: any) => `• ${row.tier}: ${row.count}`).join("\n")
        : "• None";
      const seriesLines = stats.bySeries.length > 0
        ? stats.bySeries.map((row: any) => `• ${row.series || "General"}: ${row.count}`).join("\n")
        : "• None";
      await sendText(
        from,
        `🎴 *Cards Available*\n\n` +
        `Total cards in database: *${stats.total}*\n\n` +
        `*By Tier:*\n${tierLines}\n\n` +
        `*Top Series:*\n${seriesLines}`
      );
      return;
    }
    if (!canUse) return noPerms(from);
    const val = args[0]?.toLowerCase();
    if (val === "on") {
      const activity = getGroupActivity(from);
      if (activity.percentage < 30) {
        await sendText(from,
          `❌ Cannot enable cards yet!\n\n` +
          `📈 Current activity: *${activity.percentage}%* (need 30%)\n` +
          `💬 Messages in 20min: ${activity.count}/600\n\n` +
          `> Use *.activity* to check group activity status.`
        );
        return;
      }
      updateGroup(from, { cards_enabled: "on", spawn_enabled: "on" });
      await sendText(from, "🎴 Card spawning is now *enabled*!");
    } else if (val === "off") {
      updateGroup(from, { cards_enabled: "off", spawn_enabled: "off" });
      await sendText(from, "🎴 Card spawning is now *disabled*.");
    } else {
      const g = getGroup(from);
      await sendText(from, `🎴 Cards are currently: *${g?.cards_enabled || "on"}*\nUsage: .cards on/off`);
    }
    return;
  }

  if (cmd === "antibot") {
    if (!canUse) return noPerms(from);
    const val = args[0]?.toLowerCase();
    if (val === "on") {
      updateGroup(from, { anti_bot: "on" });
      await sendText(from, "🤖 Anti-Bot enabled. Bot accounts joining will be automatically kicked.");
    } else if (val === "off") {
      updateGroup(from, { anti_bot: "off" });
      await sendText(from, "🤖 Anti-Bot disabled.");
    } else {
      const g = getGroup(from);
      await sendText(from, `🤖 Anti-Bot is currently: *${g?.anti_bot || "off"}*\nUsage: .antibot on/off`);
    }
    return;
  }

  if (cmd === "purge") {
    if (!canUse) return noPerms(from);
    if (!isBotAdmin) return botNoAdmin(from);
    const countryCode = args[0]?.replace(/\+/g, "").replace(/\D/g, "");
    if (!countryCode || countryCode.length < 1 || countryCode.length > 4) {
      await sendText(from,
        "❌ Usage: .purge <country_code>\n" +
        "Example: .purge 234 — removes all +234 (Nigeria) members\n" +
        "         .purge 1   — removes all +1 (US/CA) members\n\n" +
        "_Non-admin members with that country code will be removed._"
      );
      return;
    }
    // Always fetch fresh group metadata so purge works even without prior cache
    let meta = groupMeta;
    if (!meta) {
      try { meta = await sock.groupMetadata(from); } catch { meta = null; }
    }
    const participants: any[] = meta?.participants || [];
    if (participants.length === 0) {
      await sendText(from, "❌ Could not load group members. Make sure the bot is an admin.");
      return;
    }
    const toRemove = participants
      .filter((p: any) => {
        const phone = (p.id || "").split("@")[0].split(":")[0];
        return phone.startsWith(countryCode) && !p.admin;
      })
      .map((p: any) => p.id);
    if (toRemove.length === 0) {
      await sendText(from, `✅ No non-admin members with country code +${countryCode} found.`);
      return;
    }
    await sendText(from, `⚠️ Removing *${toRemove.length}* member(s) with +${countryCode}…`);
    for (let i = 0; i < toRemove.length; i += 5) {
      const batch = toRemove.slice(i, i + 5);
      await sock.groupParticipantsUpdate(from, batch, "remove").catch(() => {});
      if (i + 5 < toRemove.length) await new Promise((r) => setTimeout(r, 1500));
    }
    await sendText(from, `✅ Purge complete. Removed *${toRemove.length}* member(s) with +${countryCode}.`);
    return;
  }

  if (cmd === "blacklist") {
    if (!canUse) return noPerms(from);
    const sub = args[0]?.toLowerCase();
    const g = getGroup(from);
    let bl: string[] = [];
    try { bl = JSON.parse(g?.blacklist || "[]"); } catch { bl = []; }

    if (sub === "add") {
      // Support both phone numbers and words
      const entry = args.slice(1).join(" ").replace(/\+/g, "").trim();
      if (!entry) {
        await sendText(from, "❌ Usage: .blacklist add [number or word]\nExample: .blacklist add 2348012345678\nExample: .blacklist add badword");
        return;
      }
      if (bl.includes(entry)) {
        await sendText(from, `ℹ️ *${entry}* is already on the blacklist.`);
        return;
      }
      bl.push(entry);
      updateGroup(from, { blacklist: JSON.stringify(bl) });
      const isPhone = /^\d+$/.test(entry);
      await sendText(from, `✅ Added ${isPhone ? "number" : "word"} *${entry}* to the blacklist.${isPhone ? "\n🚫 They will be removed if already in the group or when they try to join." : ""}`);

      // If it's a phone number, remove them immediately if they're already in the group
      if (isPhone) {
        let meta2 = groupMeta;
        if (!meta2) { try { meta2 = await sock.groupMetadata(from); } catch { meta2 = null; } }
        const existing = (meta2?.participants || []).find((p: any) => {
          const phone = (p.id || "").split("@")[0].split(":")[0];
          return phone.endsWith(entry);
        });
        if (existing && !existing.admin) {
          await sock.groupParticipantsUpdate(from, [existing.id], "remove").catch(() => {});
          await sendText(from, `🚫 *${entry}* was in the group and has been removed.`);
        }
      }
      return;
    } else if (sub === "remove") {
      const entry = args.slice(1).join(" ").replace(/\+/g, "").trim();
      if (!entry) { await sendText(from, "❌ Provide a number or word to remove."); return; }
      bl = bl.filter((w) => w !== entry);
      updateGroup(from, { blacklist: JSON.stringify(bl) });
      await sendText(from, `✅ Removed *${entry}* from blacklist.`);
    } else if (sub === "list") {
      if (bl.length === 0) {
        await sendText(from, "🔒 Blacklist is empty.");
      } else {
        const phones = bl.filter((e) => /^\d+$/.test(e));
        const words  = bl.filter((e) => !/^\d+$/.test(e));
        let out = "🔒 *Blacklist*\n";
        if (phones.length) out += `\n📵 *Numbers (${phones.length}):*\n${phones.map((p) => `• +${p}`).join("\n")}`;
        if (words.length)  out += `\n🚫 *Words (${words.length}):*\n${words.map((w) => `• ${w}`).join("\n")}`;
        await sendText(from, out);
      }
    } else {
      await sendText(from, "Usage: .blacklist add [number/word] | .blacklist remove [number/word] | .blacklist list");
    }
    return;
  }

  if (cmd === "gi") {
    const meta = groupMeta;
    const admins = meta?.participants?.filter((p: any) => p.admin) || [];
    const adminCount = admins.length;
    const memberCount = meta?.participants?.length || 0;
    const groupName = meta?.subject || "Unknown";
    const groupDesc = meta?.desc || meta?.description || "No description";
    const creation = meta?.creation
      ? new Date(Number(meta.creation) * 1000).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
      : "Unknown";
    let adminLines = admins.slice(0, 5).map((p: any) => `║   • @${getMentionName(p.id)}`).join("\n");
    if (admins.length > 5) adminLines += `\n║   ...and ${admins.length - 5} more`;
    const text =
      `╔═ ❰ ℹ️ 𝗚𝗥𝗢𝗨𝗣 𝗜𝗡𝗙𝗢 ❱ ═╗\n` +
      `║ 📛 𝗡𝗮𝗺𝗲: ${groupName}\n` +
      `║ 👥 𝗠𝗲𝗺𝗯𝗲𝗿𝘀: ${memberCount}\n` +
      `║ 🛡️ 𝗔𝗱𝗺𝗶𝗻𝘀: ${adminCount}\n` +
      `║ 📅 𝗖𝗿𝗲𝗮𝘁𝗲𝗱: ${creation}\n║\n` +
      `║ 📝 𝗗𝗲𝘀𝗰𝗿𝗶𝗽𝘁𝗶𝗼𝗻:\n║   ${groupDesc.slice(0, 200)}\n║\n` +
      `║ 🛡️ 𝗔𝗱𝗺𝗶𝗻𝘀:\n${adminLines || "║   None"}\n` +
      `╚══════════════════╝`;
    await sock.sendMessage(from, { text, mentions: admins.slice(0, 5).map((p: any) => p.id) });
    return;
  }

  if (cmd === "groupinfo") {
    const g = getGroup(from);
    const meta = groupMeta;
    const admins = meta?.participants?.filter((p: any) => p.admin)?.length || 0;
    let bl: string[] = [];
    try { bl = JSON.parse(g?.blacklist || "[]"); } catch {}

    const text = `╔═ ❰ 📊 𝗚𝗥𝗢𝗨𝗣 𝗖𝗢𝗡𝗙𝗜𝗚 ❱ ═╗\n` +
      `║ 👥 𝗣𝗮𝗿𝘁𝗶𝗰𝗶𝗽𝗮𝗻𝘁𝘀: ${meta?.participants?.length || "?"}\n` +
      `║ 🛡️ 𝗔𝗱𝗺𝗶𝗻𝘀: ${admins}\n║\n` +
      `║ 🔗 𝗔𝗻𝘁𝗶-𝗟𝗶𝗻𝗸: ${g?.antilink || "off"} (${g?.antilink_action || "delete"})\n` +
      `║ 🚫 𝗔𝗻𝘁𝗶-𝗦𝗽𝗮𝗺: ${g?.antispam || "off"}\n` +
      `║ 🤖 𝗔𝗻𝘁𝗶-𝗕𝗼𝘁: ${g?.anti_bot || "off"}\n║\n` +
      `║ ✉️ 𝗪𝗲𝗹𝗰𝗼𝗺𝗲: ${g?.welcome || "off"}\n` +
      `║ 📨 𝗠𝘀𝗴: ${g?.welcome_msg || "(default)"}\n║\n` +
      `║ 🚪 𝗟𝗲𝗮𝘃𝗲: ${g?.leave || "off"}\n` +
      `║ 📨 𝗠𝘀𝗴: ${g?.leave_msg || "(default)"}\n║\n` +
      `║ 🎴 𝗖𝗮𝗿𝗱𝘀: ${g?.cards_enabled || "on"}\n` +
      `║ 🎮 𝗚𝗮𝗺𝗲𝘀: ${g?.games_enabled || "on"}\n` +
      `║ 🎰 𝗚𝗮𝗺𝗯𝗹𝗶𝗻𝗴: ${g?.gambling_enabled || "on"}\n║\n` +
      `║ 🔒 𝗕𝗹𝗮𝗰𝗸𝗹𝗶𝘀𝘁: ${bl.length} words\n` +
      `╚══════════════════╝`;

    await sendText(from, text);
    return;
  }

  if (cmd === "gcl" || cmd === "gclink") {
    if (!isBotAdmin) return botNoAdmin(from);
    try {
      const inviteCode = await sock.groupInviteCode(from);
      const link = `https://chat.whatsapp.com/${inviteCode}`;
      const { updateGroup } = await import("../db/queries.js");
      updateGroup(from, { last_gcl: Math.floor(Date.now() / 1000) });
      // Try to send group picture with the link
      try {
        const ppUrl = await sock.profilePictureUrl(from, "image").catch(() => null);
        if (ppUrl) {
          const { default: https } = await import("https");
          const imgBuf: Buffer = await new Promise((res, rej) => {
            https.get(ppUrl, (r) => { const c: Buffer[] = []; r.on("data", (d: Buffer) => c.push(d)); r.on("end", () => res(Buffer.concat(c))); r.on("error", rej); });
          });
          await sock.sendMessage(from, { image: imgBuf, caption: `🔗 *Group Invite Link*\n\n${link}` });
          return;
        }
      } catch { /* fall through to text */ }
      await sock.sendMessage(from, { text: `🔗 *Group Invite Link*\n\n${link}` });
    } catch {
      await sendText(from, "❌ Failed to get group invite link. Make sure the bot is an admin.");
    }
    return;
  }

  if (cmd === "groupstats" || cmd === "gs") {
    const active = getActiveMembers(from);
    const inactive = getInactiveMembers(from);
    const meta = groupMeta;
    const g = getGroup(from);
    let bl: string[] = [];
    try { bl = JSON.parse(g?.blacklist || "[]"); } catch {}
    const admins = meta?.participants?.filter((p: any) => p.admin)?.length || 0;

    const text = `╔═ ❰ 📊 𝗚𝗥𝗢𝗨𝗣 𝗦𝗧𝗔𝗧𝗦 📊 ❱ ═╗\n` +
      `║ 👥 𝗣𝗮𝗿𝘁𝗶𝗰𝗶𝗽𝗮𝗻𝘁𝘀: ${meta?.participants?.length || "?"}\n` +
      `║ 🛡️ 𝗔𝗱𝗺𝗶𝗻𝘀: ${admins}\n║\n` +
      `║ 🔗 𝗔𝗻𝘁𝗶-𝗟𝗶𝗻𝗸: ${g?.antilink || "off"} (${g?.antilink_action || "delete"})\n` +
      `║ 🚫 𝗔𝗻𝘁𝗶-𝗦𝗽𝗮𝗺: ${g?.antispam || "off"}\n` +
      `║ 👑 𝗔𝗻𝘁𝗶-𝗔𝗱𝗺𝗶𝗻: ${g?.anti_admin || "off"}\n` +
      `║ 🤖 𝗔𝗻𝘁𝗶-𝗕𝗼𝘁: ${g?.anti_bot || "off"}\n` +
      `║ 🏕️ 𝗔𝗻𝘁𝗶-𝗖𝗮𝗺𝗽𝗶𝗻𝗴: ${g?.anti_camping || "off"}\n║\n` +
      `║ ✉️ 𝗪𝗲𝗹𝗰𝗼𝗺𝗲: ${g?.welcome || "off"}\n` +
      `║ 📨 𝗠𝘀𝗴: ${g?.welcome_msg || "(default)"}\n║\n` +
      `║ 🚪 𝗟𝗲𝗮𝘃𝗲: ${g?.leave || "off"}\n` +
      `║ 📨 𝗠𝘀𝗴: ${g?.leave_msg || "(default)"}\n║\n` +
      `║ 🎴 𝗖𝗮𝗿𝗱𝘀: ${g?.cards_enabled || "on"}\n` +
      `║ 🎴 𝗦𝗽𝗮𝘄𝗻: ${g?.spawn_enabled || "on"}\n` +
      `║ 🎮 𝗚𝗮𝗺𝗲𝘀: ${g?.games_enabled || "on"}\n` +
      `║ 🎰 𝗚𝗮𝗺𝗯𝗹𝗶𝗻𝗴: ${g?.gambling_enabled || "on"}\n║\n` +
      `║ 🔒 𝗕𝗹𝗮𝗰𝗸𝗹𝗶𝘀𝘁: ${bl.length} words\n` +
      `╚══════════════════╝`;

    await sendText(from, text);
    return;
  }

  if (cmd === "addmod") {
    if (!isAdmin && !isOwner) return noPerms(from);
    const rawMentioned = resolvedMentions[0];
    if (!rawMentioned) { await sendText(from, "❌ Mention someone."); return; }
    const mentioned = resolveMentionedJid(rawMentioned, groupMeta);
    addMod(mentioned, from, sender);
    await sendText(from, `✅ @${getMentionName(mentioned)} is now a mod in this group.`, [mentioned]);
    return;
  }
}

async function noPerms(jid: string) {
  await sendText(jid, "❌ You don't have permission to use this command.");
}

async function botNoAdmin(jid: string) {
  await sendText(jid, "❌ Bot needs admin privileges to perform this action.");
}

function parseDuration(input?: string): number | null {
  if (!input) return null;
  const match = input.trim().match(/^(\d+)(s|m|h|d|y)$/i);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, y: 31536000 };
  return value > 0 ? value * multipliers[unit] : null;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 31536000) return `${Math.floor(seconds / 86400)}d`;
  return `${Math.floor(seconds / 31536000)}y`;
}
