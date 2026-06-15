import type { CommandContext } from "./index.js";
import { sendText, getAnySock } from "../connection.js";
import { getDb } from "../db/database.js";
import {
  getAllGroups,
  getStaff, getStaffList, extractNumberFromJid, getMentionName,
  getUser, updateUser, addToInventory, addBan, removeBan, getBanList,
  updateGroup, getGroup, resetUserBalance, resetUserProfile,
} from "../db/queries.js";
import { getAllBotsStatus } from "../bot-manager.js";

function isModOrAbove(ctx: CommandContext): boolean {
  if (ctx.isOwner) return true;
  const staff = getStaff(ctx.sender);
  return !!staff && ["owner", "guardian", "mod"].includes(staff.role);
}

export async function handleStaff(ctx: CommandContext): Promise<void> {
  const { from, sender, args, command: cmd, sock } = ctx;


  // ── .bots — list all bots with real-time status ──────────────────────────
  if (cmd === "bots") {
    const bots = getAllBotsStatus();
    if (!bots || bots.length === 0) {
      await sendText(from, "🤖 No bots are configured.");
      return;
    }
    const statusEmoji: Record<string, string> = {
      connected:    "🟢",
      connecting:   "🟡",
      pairing:      "🟠",
      disconnected: "🔴",
    };
    const statusLabel: Record<string, string> = {
      connected:    "Online",
      connecting:   "Connecting…",
      pairing:      "Pairing…",
      disconnected: "Offline",
    };
    const connectedCount = bots.filter((b: any) => b.status === "connected").length;
    const lines = bots.map((b: any) => {
      const st    = b.status || "disconnected";
      const emoji = statusEmoji[st] ?? "🔴";
      const label = statusLabel[st] ?? "Offline";
      const primary = b.isPrimary ? " ⭐" : "";
      const phone   = b.phone ? ` (${b.phone})` : "";
      return `   │✑  ${emoji} *${b.name || b.id}*${primary} — ${label}${phone}`;
    });
    const header =
      `┌─❖\n│「 🆃🅴🅽🅺🆄 」\n└┬❖ 「 𝗕𝗢𝗧𝗦 」\n` +
      `   │  ${connectedCount}/${bots.length} online\n`;
    const msg = header + lines.join("\n") + `\n   └────────────┈ ⳹`;
    await sendText(from, msg);
    return;
  }

  // ── .modlist / .mods / .modslist / .cardmakers ─────────────────────────────
  if (cmd === "modlist" || cmd === "mods" || cmd === "modslist" || cmd === "cardmakers") {
    const db = getDb();
    // Include owners in this list
    const allStaff = getStaffList();
    if (allStaff.length === 0) {
      await sendText(from, "📋 No staff are registered.");
      return;
    }
    const grouped: Record<string, any[]> = { owner: [], guardian: [], mod: [], recruit: [] };
    for (const s of allStaff) {
      const key = s.role in grouped ? s.role : "mod";
      grouped[key].push(s);
    }

    const allMentionJids: string[] = [];

    const formatSection = (role: string, label: string, emoji: string) => {
      const list = grouped[role];
      if (!list || list.length === 0) return "";
      const rows = list.map((s: any) => {
        const jid = `${s.user_id}@s.whatsapp.net`;
        allMentionJids.push(jid);
        return `   │✑  @${s.user_id}`;
      }).join("\n");
      return `   ├────────────┈ ⳹\n   │ 「 ${emoji} ${label} ${emoji} 」\n${rows}\n`;
    };

    let body = `┌─❖\n│「 🆃🅴🅽🅺🆄 」\n└┬❖ 「 👑 𝗦𝘁𝗮𝗳𝗳 👑 」\n`;
    body += formatSection("owner", "𝗢𝘄𝗻𝗲𝗿", "👑");
    body += formatSection("guardian", "𝗚𝘂𝗮𝗿𝗱𝗶𝗮𝗻𝘀", "🛡️");
    body += formatSection("mod", "𝗠𝗼𝗱𝘀", "⚔️");
    body += formatSection("recruit", "𝗥𝗲𝗰𝗿𝘂𝗶𝘁𝘀", "🌱");
    body += `   └────────────┈ ⳹\n> ⚠️ Unnecessary use of this command will lead to a *ban from the community.*`;

    await sock.sendMessage(from, { text: body, mentions: allMentionJids });
    return;
  }

  // ── .addmod / .addguardian ─────────────────────────────────────────────────
  if (cmd === "addmod" || cmd === "addguardian") {
    if (!isModOrAbove(ctx)) {
      await sendText(from, "❌ Only mods, guardians, and owner can manage roles.");
      return;
    }
    const role = cmd === "addmod" ? "mod" : "guardian";
    const targetPhone = args[0]?.replace(/\D/g, "");
    if (!targetPhone) {
      await sendText(from, `❌ Usage: *.${cmd}* [phone_number]\nExample: .${cmd} 2348031234567`);
      return;
    }
    const db = getDb();
    const existing = db.prepare("SELECT * FROM staff WHERE user_id = ?").get(targetPhone) as any;
    if (existing && existing.role === role) {
      await sendText(from, `❌ +${targetPhone} is already a ${role}.`);
      return;
    }
    db.prepare("INSERT OR REPLACE INTO staff (user_id, role, added_by, added_at) VALUES (?, ?, ?, unixepoch())")
      .run(targetPhone, role, extractNumberFromJid(sender));
    await sendText(from, `✅ +${targetPhone} is now a *${role}*.`);
    return;
  }

  // ── .removeguardian / .removemod ──────────────────────────────────────────
  if (cmd === "removeguardian" || cmd === "removemod") {
    if (!isModOrAbove(ctx)) {
      await sendText(from, "❌ Only mods, guardians, and owner can manage roles.");
      return;
    }
    const targetPhone = args[0]?.replace(/\D/g, "");
    if (!targetPhone) {
      await sendText(from, `❌ Usage: *.${cmd}* [phone_number]`);
      return;
    }
    const db = getDb();
    const existing = db.prepare("SELECT * FROM staff WHERE user_id = ?").get(targetPhone) as any;
    if (!existing) {
      await sendText(from, `❌ +${targetPhone} is not in the staff list.`);
      return;
    }
    if (existing.role === "owner") {
      await sendText(from, `❌ Cannot remove an owner from staff.`);
      return;
    }
    db.prepare("DELETE FROM staff WHERE user_id = ?").run(targetPhone);
    await sendText(from, `✅ +${targetPhone} has been removed from staff.`);
    return;
  }

  // ── .recruit ──────────────────────────────────────────────────────────────
  if (cmd === "recruit") {
    if (!isModOrAbove(ctx)) {
      await sendText(from, "❌ Only mods, guardians, and owner can recruit.");
      return;
    }
    const targetPhone = args[0]?.replace(/\D/g, "");
    if (!targetPhone) {
      await sendText(from, "❌ Usage: *.recruit* [phone_number]");
      return;
    }
    const db = getDb();
    db.prepare("INSERT OR REPLACE INTO staff (user_id, role, added_by, added_at) VALUES (?, 'recruit', ?, unixepoch())")
      .run(targetPhone, extractNumberFromJid(sender));
    await sendText(from, `✅ +${targetPhone} has been recruited to Requiem Order staff.`);
    return;
  }

  // ── .addpremium ────────────────────────────────────────────────────────────
  if (cmd === "addpremium") {
    if (!isModOrAbove(ctx)) {
      await sendText(from, "❌ Only mods, guardians, and owner can grant premium.");
      return;
    }
    const targetPhone = args[0]?.replace(/\D/g, "");
    const days = parseInt(args[1] || "30", 10);
    if (!targetPhone) {
      await sendText(from, "❌ Usage: *.addpremium* [phone_number] [days=30]");
      return;
    }
    const expiry = Math.floor(Date.now() / 1000) + days * 86400;
    updateUser(targetPhone, { premium: 1, premium_expiry: expiry });
    await sendText(from, `✅ +${targetPhone} now has *Premium* for ${days} day(s).\n🌟 Expires: ${new Date(expiry * 1000).toDateString()}`);
    return;
  }

  // ── .removepremium ─────────────────────────────────────────────────────────
  if (cmd === "removepremium") {
    if (!isModOrAbove(ctx)) {
      await sendText(from, "❌ Only mods, guardians, and owner can remove premium.");
      return;
    }
    const targetPhone = args[0]?.replace(/\D/g, "");
    if (!targetPhone) {
      await sendText(from, "❌ Usage: *.removepremium* [phone_number]");
      return;
    }
    updateUser(targetPhone, { premium: 0, premium_expiry: 0 });
    await sendText(from, `✅ Premium removed from +${targetPhone}.`);
    return;
  }

  // ── .ban ──────────────────────────────────────────────────────────────────
  if (cmd === "ban") {
    if (!isModOrAbove(ctx)) {
      await sendText(from, "❌ Only mods, guardians, and owner can ban users.");
      return;
    }
    const targetPhone = args[0]?.replace(/\D/g, "");
    const reason = args.slice(1).join(" ") || "Banned by staff";
    if (!targetPhone) {
      await sendText(from, "❌ Usage: *.ban* [phone_number] [reason]");
      return;
    }
    addBan("user", targetPhone, `+${targetPhone}`, reason, sender);
    await sendText(from, `🔨 +${targetPhone} has been *banned*.\n📋 Reason: ${reason}`);
    return;
  }

  // ── .unban ────────────────────────────────────────────────────────────────
  if (cmd === "unban") {
    if (!isModOrAbove(ctx)) {
      await sendText(from, "❌ Only mods, guardians, and owner can unban users.");
      return;
    }
    const targetPhone = args[0]?.replace(/\D/g, "");
    if (!targetPhone) {
      await sendText(from, "❌ Usage: *.unban* [phone_number]");
      return;
    }
    removeBan("user", targetPhone);
    await sendText(from, `✅ +${targetPhone} has been *unbanned*.`);
    return;
  }

  // ── .banlist ──────────────────────────────────────────────────────────────
  if (cmd === "banlist") {
    if (!isModOrAbove(ctx)) {
      await sendText(from, "❌ Only mods and above can view the ban list.");
      return;
    }
    const banned = getBanList().filter((b: any) => b.type === "user");
    if (!banned || banned.length === 0) {
      await sendText(from, "📋 No users are currently banned.");
      return;
    }
    const lines = banned.map((b: any) => `• +${b.target} — ${b.reason || "No reason"}`);
    await sendText(from, `🔨 *Banned Users* (${banned.length})\n\n${lines.join("\n")}`);
    return;
  }

  // ── .addrole ──────────────────────────────────────────────────────────────
  if (cmd === "addrole") {
    if (!isModOrAbove(ctx)) {
      await sendText(from, "❌ Only mods, guardians, and owner can manage roles.");
      return;
    }
    const targetPhone = args[0]?.replace(/\D/g, "");
    const role = args[1]?.toLowerCase();
    if (!targetPhone || !role || !["mod", "guardian"].includes(role)) {
      await sendText(from, "❌ Usage: .addrole [phone_number] [mod|guardian]");
      return;
    }
    const db = getDb();
    db.prepare("INSERT OR REPLACE INTO staff (user_id, role, added_by, added_at) VALUES (?, ?, ?, unixepoch())")
      .run(targetPhone, role, extractNumberFromJid(sender));
    await sendText(from, `✅ +${targetPhone} is now a ${role}.`);
    return;
  }

  // ── .post ─────────────────────────────────────────────────────────────────
  if (cmd === "post") {
    if (!isModOrAbove(ctx)) {
      await sendText(from, "❌ Only mods, guardians, and owner can post announcements.");
      return;
    }
    const message = args.join(" ");
    if (!message) {
      await sendText(from, "❌ Usage: *.post* [message]\n_This broadcasts your message to every group the bot is in._");
      return;
    }
    const anySock = getAnySock();
    if (!anySock) {
      await sendText(from, "❌ Bot socket not available.");
      return;
    }

    const allGroups = getAllGroups();
    const announcement = `📢 *ANNOUNCEMENT — Requiem Order 反逆*\n\n${message}`;
    let sent = 0;
    let failed = 0;

    // Notify sender that broadcast is starting
    await sendText(from, `📡 Broadcasting to *${allGroups.length}* groups…`);

    for (const group of allGroups) {
      try {
        // Fetch all participant JIDs to hidetag (ping everyone silently)
        let mentions: string[] = [];
        try {
          const meta = await anySock.groupMetadata(group.id);
          mentions = meta.participants.map((p: any) => p.id);
        } catch { /* no participant data — send without mentions */ }

        await anySock.sendMessage(group.id, { text: announcement, mentions });
        sent++;
      } catch {
        failed++;
      }
      // Small delay to avoid rate-limiting
      await new Promise((r) => setTimeout(r, 500));
    }

    await sendText(from, `✅ Broadcast complete!\n📤 Sent: *${sent}* groups\n❌ Failed: *${failed}* groups`);
    return;
  }

  // ── .join ─────────────────────────────────────────────────────────────────
  if (cmd === "join") {
    if (!isModOrAbove(ctx)) {
      await sendText(from, "❌ Only mods, guardians, and owner can make the bot join groups.");
      return;
    }
    const inviteLink = args[0];
    if (!inviteLink) {
      await sendText(from, "❌ Usage: *.join* [invite_link]");
      return;
    }
    const code = inviteLink.replace("https://chat.whatsapp.com/", "").split("?")[0].trim();
    if (!code) {
      await sendText(from, "❌ Invalid invite link.");
      return;
    }
    try {
      await sock.groupAcceptInvite(code);
      await sendText(from, `✅ Bot has joined the group.`);
    } catch (err: any) {
      await sendText(from, `❌ Failed to join: ${err?.message || "Unknown error"}`);
    }
    return;
  }

  // ── .exit ─────────────────────────────────────────────────────────────────
  if (cmd === "exit") {
    if (!isModOrAbove(ctx)) {
      await sendText(from, "❌ Only mods and above can make the bot leave.");
      return;
    }
    if (!from.endsWith("@g.us")) {
      await sendText(from, "❌ Must be used in a group.");
      return;
    }
    await sendText(from, "👋 Goodbye! The bot is leaving this group.");
    await sock.groupLeave(from).catch(() => {});
    return;
  }

  // ── .show ─────────────────────────────────────────────────────────────────
  if (cmd === "show") {
    if (!isModOrAbove(ctx)) {
      await sendText(from, "❌ Only mods and above can use this command.");
      return;
    }
    const anySock = getAnySock();
    if (!anySock) {
      await sendText(from, "❌ Bot not connected.");
      return;
    }
    const user = anySock.user;
    const bots = getAllBotsStatus();
    const online = bots.filter((b: any) => b.connected).length;
    await sendText(from, `🤖 *Bot Info*\n\n📛 Name: ${user?.name || "Unknown"}\n📱 ID: ${user?.id || "Unknown"}\n🟢 Online Bots: ${online}/${bots.length}`);
    return;
  }

  // ── .dc / .ac / .rc ──────────────────────────────────────────────────────
  if (cmd === "dc" || cmd === "ac" || cmd === "rc") {
    if (!isModOrAbove(ctx)) {
      await sendText(from, "❌ Only mods and above can change card settings.");
      return;
    }
    if (!from.endsWith("@g.us")) {
      await sendText(from, "❌ Must be used in a group.");
      return;
    }
    if (cmd === "dc") {
      updateGroup(from, { cards_enabled: "off", spawn_enabled: "off" });
      await sendText(from, "🃏 Card spawning *disabled* in this group.");
    } else if (cmd === "ac") {
      updateGroup(from, { cards_enabled: "on", spawn_enabled: "on" });
      await sendText(from, "🃏 Card spawning *enabled* in this group.");
    } else {
      updateGroup(from, { spawn_enabled: "off" });
      await sendText(from, "🃏 Auto card spawning *restricted* — manual spawning still works.");
    }
    return;
  }

  // ── .upload ────────────────────────────────────────────────────────────────
  // Usage: .upload T5 Gojo, Jujutsu Kaisen   (reply to an image)
  if (cmd === "upload") {
    if (!isModOrAbove(ctx)) {
      await sendText(from, "❌ Only staff can upload cards.");
      return;
    }

    // Parse: first arg is tier, rest split by comma is name, series
    // e.g. args = ["T5", "Gojo,", "Jujutsu", "Kaisen"]
    const rawArgs = args.join(" "); // "T5 Gojo, Jujutsu Kaisen"
    const tierMatch = rawArgs.match(/^(T[A-Z0-9]+)\s+(.+)$/i);
    if (!tierMatch) {
      await sendText(from, "❌ Usage: *.upload [Tier] [Name], [Series]*\nExample: .upload T5 Gojo, Jujutsu Kaisen\n\nReply to an image when using this command.");
      return;
    }

    const tier = tierMatch[1].toUpperCase();
    const rest = tierMatch[2];
    const commaIdx = rest.indexOf(",");
    if (commaIdx === -1) {
      await sendText(from, "❌ Usage: *.upload [Tier] [Name], [Series]*\nExample: .upload T5 Gojo, Jujutsu Kaisen");
      return;
    }

    const cardName = rest.slice(0, commaIdx).trim();
    const series   = rest.slice(commaIdx + 1).trim();

    if (!cardName || !series) {
      await sendText(from, "❌ Both card name and series are required.\nExample: .upload T5 Gojo, Jujutsu Kaisen");
      return;
    }

    // Require an image or video to be attached or quoted
    const quotedMsg = ctx.msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const directImg = ctx.msg.message?.imageMessage;
    const quotedImg = quotedMsg?.imageMessage;
    const imgMsg = directImg ?? quotedImg;

    // Download and save the card image or video
    const { downloadContentFromMessage } = await import("@whiskeysockets/baileys");
    const ANIMATED_TIERS_SET = new Set(["T6","TS","TX","TZ"]);
    const isAnimatedTier = ANIMATED_TIERS_SET.has(tier);

    // For animated tiers also check for video
    const quotedVideo = quotedMsg?.videoMessage;
    const directVideo = ctx.msg.message?.videoMessage;
    const videoMsg = directVideo ?? quotedVideo;

    let imageBuffer: Buffer;
    let isAnimated = 0;

    if (isAnimatedTier && videoMsg) {
      const vStream = await downloadContentFromMessage(videoMsg, "video");
      const vChunks: Buffer[] = [];
      for await (const chunk of vStream) vChunks.push(chunk as Buffer);
      imageBuffer = Buffer.concat(vChunks);
      isAnimated = 1;
    } else if (imgMsg) {
      const stream = await downloadContentFromMessage(imgMsg, "image");
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      imageBuffer = Buffer.concat(chunks);
      isAnimated = 0;
    } else {
      await sendText(from, `❌ Please reply to an image${isAnimatedTier ? " or video" : ""} or send it with this command.\nUsage: *.upload T5 Gojo, Jujutsu Kaisen*`);
      return;
    }

    const db = getDb();
    const VALID_TIERS = ["T1","T2","T3","T4","T5","T6","TS","TX","TZ"];
    if (!VALID_TIERS.includes(tier)) {
      await sendText(from, `❌ Invalid tier *${tier}*.\nValid tiers: ${VALID_TIERS.join(", ")}`);
      return;
    }

    // Check for duplicate card name
    const existing = db.prepare("SELECT id FROM cards WHERE LOWER(name) = LOWER(?)").get(cardName) as any;
    if (existing) {
      await sendText(from, `❌ A card named *${cardName}* already exists (ID: ${existing.id}).`);
      return;
    }

    // Generate a unique card ID
    const { randomBytes } = await import("crypto");
    const idChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let newCardId = "";
    for (let attempt = 0; attempt < 50; attempt++) {
      const bytes = randomBytes(8);
      const candidate = Array.from(bytes as Buffer).map((b: number) => idChars[b % idChars.length]).join("");
      if (!db.prepare("SELECT 1 FROM cards WHERE id = ?").get(candidate)) {
        newCardId = candidate;
        break;
      }
    }
    if (!newCardId) newCardId = "C" + Date.now().toString(36).toUpperCase();

    db.prepare(
      "INSERT INTO cards (id, name, series, tier, image_data, is_animated, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(newCardId, cardName, series, tier, imageBuffer, isAnimated, sender.split("@")[0]);

    await sendText(from,
      `✅ Card uploaded successfully!\n\n` +
      `🎴 *${cardName}* — *${tier}*\n` +
      `📚 Series: *${series}*\n` +
      `🆔 Card ID: *${newCardId}*`
    );
    return;
  }

  // ── .rules ────────────────────────────────────────────────────────────────
  if (cmd === "rules") {
    if (!from.endsWith("@g.us")) {
      await sendText(from, "❌ Must be used in a group.");
      return;
    }
    const group = getGroup(from);
    const rules = group?.rules || null;
    if (!rules) {
      await sendText(from, "📋 No rules have been set for this group.\n\n_Use *.setrules* [rules text] to set them._");
      return;
    }
    await sendText(from, `📋 *Group Rules*\n\n${rules}`);
    return;
  }

  // ── .resetbal ─────────────────────────────────────────────────────────────
  if (cmd === "resetbal") {
    if (!isModOrAbove(ctx)) {
      await sendText(from, "❌ Only mods and above can reset balances.");
      return;
    }
    const targetPhone = args[0]?.replace(/\D/g, "");
    if (!targetPhone) {
      await sendText(from, "❌ Usage: *.resetbal* [phone_number]");
      return;
    }
    resetUserBalance(targetPhone);
    await sendText(from, `✅ Balance reset for +${targetPhone}.`);
    return;
  }

  // ── .reset ────────────────────────────────────────────────────────────────
  if (cmd === "reset") {
    if (!ctx.isOwner) {
      await sendText(from, "❌ Only the owner can fully reset user profiles.");
      return;
    }
    const targetPhone = args[0]?.replace(/\D/g, "");
    if (!targetPhone) {
      await sendText(from, "❌ Usage: *.reset* [phone_number]");
      return;
    }
    resetUserProfile(targetPhone);
    await sendText(from, `✅ Profile fully reset for +${targetPhone}.`);
    return;
  }

  // ── .addinv ───────────────────────────────────────────────────────────────
  if (cmd === "addinv") {
    if (!isModOrAbove(ctx)) {
      await sendText(from, "❌ Only mods and above can add inventory items.");
      return;
    }
    const targetPhone = args[0]?.replace(/\D/g, "");
    const item = args.slice(1).join(" ");
    if (!targetPhone || !item) {
      await sendText(from, "❌ Usage: *.addinv* [phone_number] [item name]");
      return;
    }
    addToInventory(targetPhone, item);
    await sendText(from, `✅ Added *${item}* to +${targetPhone}'s inventory.`);
    return;
  }

  // ── .setms ────────────────────────────────────────────────────────────────
  if (cmd === "setms") {
    if (!isModOrAbove(ctx)) {
      await sendText(from, "❌ Only mods and above can set milestone messages.");
      return;
    }
    const msText = args.join(" ");
    if (!msText) {
      await sendText(from, "❌ Usage: *.setms* [message]\nMilestone message for the group.");
      return;
    }
    if (from.endsWith("@g.us")) {
      updateGroup(from, { milestone_msg: msText });
    } else {
      const db = getDb();
      db.prepare("INSERT OR REPLACE INTO bot_settings (key, value) VALUES ('global_milestone_msg', ?)").run(msText);
    }
    await sendText(from, `✅ Milestone message set:\n\n_${msText}_`);
    return;
  }

  // ── .delms ────────────────────────────────────────────────────────────────
  if (cmd === "delms") {
    if (!isModOrAbove(ctx)) {
      await sendText(from, "❌ Only mods and above can delete milestone messages.");
      return;
    }
    if (from.endsWith("@g.us")) {
      updateGroup(from, { milestone_msg: null });
    } else {
      const db = getDb();
      db.prepare("DELETE FROM bot_settings WHERE key = 'global_milestone_msg'").run();
    }
    await sendText(from, "✅ Milestone message deleted.");
    return;
  }

  // ── .fetchcards ───────────────────────────────────────────────────────────
  // Imports cards from Shoob.gg public API (https://api.shoob.gg).
  //
  // Usage:
  //   .fetchcards [tier] [limit]
  //   .fetchcards [limit]
  //
  // Examples:
  //   .fetchcards T5 30    ← up to 30 T5 cards from Shoob
  //   .fetchcards T3 50    ← up to 50 T3 cards
  //   .fetchcards 20       ← 20 cards of any tier
  //   .fetchcards          ← 20 cards (default)
  //
  // Shoob tier mapping: "1"→T1 … "6"→T6, "S"→TS, "X"→TX, "Z"→TZ
  // For a full import use .pullcards; for incremental use .synccards.
  if (cmd === "fetchcards") {
    if (!isModOrAbove(ctx)) {
      await sendText(from, "❌ Only mods and above can import cards.");
      return;
    }

    const SHOOB_API = "https://api.shoob.gg";
    const VALID_TIERS_FETCH = ["T1","T2","T3","T4","T5","T6","TS","TX","TZ"];
    const ANIMATED_TIERS_FETCH = new Set(["T6","TS","TX","TZ"]);

    // Shoob numeric/letter tier → bot T-prefix
    function normTier(raw: string | number | undefined): string {
      if (raw === null || raw === undefined) return "T1";
      const s = String(raw).trim().toUpperCase();
      if (s.startsWith("T") && VALID_TIERS_FETCH.includes(s)) return s;
      if (/^\d$/.test(s)) return `T${s}`;
      if (s === "S") return "TS";
      if (s === "X") return "TX";
      if (s === "Z") return "TZ";
      return "T1";
    }

    // Parse args: .fetchcards [tier] [limit]
    const firstArg = (args[0] || "").toUpperCase();
    let filterTier = "";
    let limit = 20;

    if (firstArg && VALID_TIERS_FETCH.includes(firstArg)) {
      filterTier = firstArg;
      limit = Math.min(parseInt(args[1] || "20", 10) || 20, 200);
    } else if (firstArg && /^\d+$/.test(firstArg)) {
      limit = Math.min(parseInt(firstArg, 10) || 20, 200);
    } else if (firstArg) {
      await sendText(from,
        `❌ Invalid option *${firstArg}*.\n\n` +
        `Usage:\n` +
        `• *.fetchcards [tier] [limit]*  — e.g. *.fetchcards T5 30*\n` +
        `• *.fetchcards [limit]*         — e.g. *.fetchcards 50*\n\n` +
        `For a full import use *.pullcards*; incremental: *.synccards*`
      );
      return;
    }

    let statusMsg = `🌐 Fetching cards from Shoob.gg...\n`;
    statusMsg += `_Tier: ${filterTier || "any"} | Limit: ${limit}_`;
    await sendText(from, statusMsg);

    try {
      const { getDb } = await import("../db/database.js");
      const db = getDb();

      // Paginate Shoob until we have enough cards (or run out)
      const collected: any[] = [];
      let page = 1;
      while (collected.length < limit) {
        const url = `${SHOOB_API}/site/api/cards?page=${page}&limit=50`;
        const apiRes = await fetch(url, {
          headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0 (compatible; RequiemOrderBot/1.0)" },
          signal: AbortSignal.timeout(20000),
        });
        if (!apiRes.ok) {
          await sendText(from, `❌ Shoob API returned HTTP ${apiRes.status}. Try again in a moment.`);
          return;
        }
        const apiData: any = await apiRes.json();
        const pageCards: any[] = Array.isArray(apiData)
          ? apiData
          : (apiData.cards || apiData.data || apiData.results || []);
        if (!pageCards.length) break;

        for (const c of pageCards) {
          const cardTier = normTier(c.tier);
          if (filterTier && cardTier !== filterTier) continue;
          collected.push(c);
          if (collected.length >= limit) break;
        }
        if (pageCards.length < 50) break; // last page
        page++;
      }

      if (!collected.length) {
        await sendText(from,
          filterTier
            ? `❌ No ${filterTier} cards found on Shoob right now. Try a different tier or run *.pullcards*.`
            : `❌ No cards returned from Shoob. Try *.pullcards* for a full import.`
        );
        return;
      }

      // ── ID generator ─────────────────────────────────────────────────────
      const { randomBytes } = await import("crypto");
      const idChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
      function genCardId(): string {
        for (let attempt = 0; attempt < 50; attempt++) {
          const bytes = randomBytes(8);
          const candidate = Array.from(bytes as Buffer).map((b: number) => idChars[b % idChars.length]).join("");
          if (!db.prepare("SELECT 1 FROM cards WHERE id = ?").get(candidate)) return candidate;
        }
        return "C" + Date.now().toString(36).toUpperCase();
      }

      let imported = 0;
      let skipped = 0;
      const errors: string[] = [];
      const uploaderPhone = sender.split("@")[0].split(":")[0];

      for (const sc of collected) {
        // Shoob card shape: { _id, id, name, slug, tier, category[], file }
        const shoobId: string = String(sc._id || sc.id || "").trim();
        const cardName: string = (sc.name || sc.slug || shoobId).trim().replace(/_/g, " ");
        if (!cardName || cardName.length < 2) { skipped++; continue; }

        // Skip if already imported by shoob_id or by name
        const existsByShoobId = shoobId ? db.prepare("SELECT 1 FROM cards WHERE shoob_id = ?").get(shoobId) : null;
        const existsByName = db.prepare("SELECT 1 FROM cards WHERE LOWER(name) = LOWER(?)").get(cardName);
        if (existsByShoobId || existsByName) { skipped++; continue; }

        const cardTier = normTier(sc.tier);
        // category[0] is the anime/series; fall back gracefully
        const cardSeries: string = Array.isArray(sc.category) && sc.category[0]
          ? String(sc.category[0]).trim()
          : (sc.series || sc.anime || "Shoob");

        const imageUrl = shoobId ? `${SHOOB_API}/site/api/cardr/${shoobId}?size=400` : "";
        const isVideoCard = /\.(webm|mp4|mov)(\?|$)/i.test(imageUrl);
        const isGif = /\.gif(\?|$)/i.test(imageUrl);
        const cardIsAnimated = isGif || isVideoCard || ANIMATED_TIERS_FETCH.has(cardTier) ? 1 : 0;

        let imageData: Buffer | null = null;
        if (imageUrl) {
          try {
            const mediaRes = await fetch(imageUrl, {
              headers: { "User-Agent": "Mozilla/5.0 (compatible; RequiemOrderBot/1.0)" },
              signal: AbortSignal.timeout(25000),
            });
            if (mediaRes.ok) {
              const buf = Buffer.from(await mediaRes.arrayBuffer());
              if (!isVideoCard && !isGif) {
                try {
                  const sharp = (await import("sharp")).default;
                  imageData = await sharp(buf)
                    .resize(800, 1100, { fit: "inside", withoutEnlargement: true })
                    .jpeg({ quality: 92 })
                    .toBuffer();
                } catch { imageData = buf; }
              } else {
                imageData = buf;
              }
            }
          } catch (e: any) {
            errors.push(`${cardName}: ${(e as any)?.message || "fetch failed"}`);
          }
          await new Promise(r => setTimeout(r, 110)); // rate-limit CDN
        }

        const newCardId = genCardId();
        db.prepare(
          "INSERT INTO cards (id, name, series, tier, image_data, is_animated, uploaded_by, source, shoob_id) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, 'shoob', ?)"
        ).run(newCardId, cardName, cardSeries, cardTier, imageData, cardIsAnimated, uploaderPhone, shoobId || null);

        if (shoobId) {
          db.prepare(
            "INSERT OR IGNORE INTO shoob_imported_ids (shoob_id, local_card_id) VALUES (?, ?)"
          ).run(shoobId, newCardId);
        }
        imported++;
      }

      let summary =
        `✅ *Import Done!*\n\n` +
        `🎴 Imported: *${imported}* cards\n` +
        `⏭️ Skipped (duplicates): *${skipped}*\n` +
        `📊 Total checked: *${collected.length}*\n` +
        (filterTier ? `⭐ Tier filter: *${filterTier}*\n` : "");
      if (errors.length > 0) {
        summary += `\n⚠️ Image errors (${errors.length}): ${errors.slice(0, 3).join(", ")}`;
        if (errors.length > 3) summary += ` …and ${errors.length - 3} more`;
      }
      await sendText(from, summary);
    } catch (err: any) {
      await sendText(from, `❌ Card import failed: ${err?.message || "Unknown error"}`);
    }
    return;
  }

  // ── .website ──────────────────────────────────────────────────────────────
  if (cmd === "website") {
    const websiteUrl = process.env["WEBSITE_URL"] || "";
    if (!websiteUrl) {
      await sendText(from, "❌ Website URL not configured.");
      return;
    }
    await sendText(from, `🌐 *Requiem Order Website*\n\n${websiteUrl}`);
    return;
  }

  await sendText(from, `❌ Unknown staff command: *.${cmd}*\n\nAvailable: bots, modlist, addmod, addguardian, removeguardian, removemod, recruit, addpremium, removepremium, ban, unban, banlist, post, join, exit, show, dc, ac, rc, upload, rules, resetbal, reset, addinv, setms, delms, fetchcards, pullcards, synccards, cardlogs, website`);
}
