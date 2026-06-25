import type { CommandContext } from "./index.js";
import { sendText, getAnySock } from "../connection.js";
import { logger } from "../../lib/logger.js";
import { col } from "../db/mongo.js";
import {
  getAllGroups,
  getStaff, getStaffList, extractNumberFromJid, getMentionName,
  getUser, updateUser, addToInventory, addBan, removeBan, getBanList,
  updateGroup, getGroup, resetUserBalance, resetUserProfile, getAllCards,
  setBotSetting, deleteBotSetting,
} from "../db/queries.js";
import { getAllBotsStatus } from "../bot-manager.js";
import { spawnCard } from "../handlers/cardspawn.js";

async function isModOrAbove(ctx: CommandContext): Promise<boolean> {
  if (ctx.isOwner) return true;
  const staff = await getStaff(ctx.sender);
  return !!staff && ["owner", "guardian", "mod"].includes((staff as any).role);
}

async function isOwnerOrGuardian(ctx: CommandContext): Promise<boolean> {
  if (ctx.isOwner) return true;
  const staff = await getStaff(ctx.sender);
  return !!staff && ["owner", "guardian"].includes((staff as any).role);
}

export async function handleStaff(ctx: CommandContext): Promise<void> {
  const { from, sender, args, command: cmd, sock } = ctx;

  if (cmd === "bots") {
    const bots = getAllBotsStatus();
    if (!bots || bots.length === 0) { await sendText(from, "🤖 No bots are configured."); return; }
    const statusEmoji: Record<string, string> = { connected:"🟢", connecting:"🟡", pairing:"🟠", disconnected:"🔴" };
    const statusLabel: Record<string, string> = { connected:"Online", connecting:"Connecting…", pairing:"Pairing…", disconnected:"Offline" };
    const connectedCount = bots.filter((b: any) => b.status === "connected").length;
    const lines = bots.map((b: any) => {
      const st = b.status || "disconnected";
      return `   │✑  ${statusEmoji[st] ?? "🔴"} *${b.name || b.id}*${b.isPrimary ? " ⭐" : ""} — ${statusLabel[st] ?? "Offline"}${b.phone ? ` (${b.phone})` : ""}`;
    });
    const msg = `┌─❖\n│「 𝗥𝗘𝗤𝗨𝗜𝗘𝗠 」\n└┬❖ 「 𝗕𝗢𝗧𝗦 」\n   │  ${connectedCount}/${bots.length} online\n` + lines.join("\n") + `\n   └────────────┈ ⳹`;
    await sendText(from, msg);
    return;
  }

  if (cmd === "modlist" || cmd === "mods" || cmd === "modslist" || cmd === "cardmakers") {
    const allStaff = await getStaffList();
    if ((allStaff as any[]).length === 0) { await sendText(from, "📋 No staff are registered."); return; }
    const grouped: Record<string, any[]> = { owner: [], guardian: [], mod: [], recruit: [] };
    for (const s of allStaff as any[]) { const key = s.role in grouped ? s.role : "mod"; grouped[key].push(s); }
    const allMentionJids: string[] = [];
    const formatSection = (role: string, label: string, emoji: string) => {
      const list = grouped[role]; if (!list || list.length === 0) return "";
      const rows = list.map((s: any) => { const jid = `${s.user_id}@s.whatsapp.net`; allMentionJids.push(jid); return `   │✑  @${s.user_id}`; }).join("\n");
      return `   ├────────────┈ ⳹\n   │ 「 ${emoji} ${label} ${emoji} 」\n${rows}\n`;
    };
    let body = `┌─❖\n│「 𝗥𝗘𝗤𝗨𝗜𝗘𝗠 」\n└┬❖ 「 👑 𝗦𝘁𝗮𝗳𝗳 👑 」\n`;
    body += formatSection("owner","𝗢𝘄𝗻𝗲𝗿","👑") + formatSection("guardian","𝗚𝘂𝗮𝗿𝗱𝗶𝗮𝗻𝘀","🛡️") + formatSection("mod","𝗠𝗼𝗱𝘀","⚔️") + formatSection("recruit","𝗥𝗲𝗰𝗿𝘂𝗶𝘁𝘀","🌱");
    body += `   └────────────┈ ⳹\n> ⚠️ Unnecessary use of this command will lead to a *ban from the community.*`;
    await sock.sendMessage(from, { text: body, mentions: allMentionJids });
    return;
  }

  if (cmd === "addmod" || cmd === "addguardian") {
    if (!(await isModOrAbove(ctx))) { await sendText(from, "❌ Only mods, guardians, and owner can manage roles."); return; }
    const role = cmd === "addmod" ? "mod" : "guardian";
    const targetPhone = args[0]?.replace(/\D/g, "");
    if (!targetPhone) { await sendText(from, `❌ Usage: *.${cmd}* [phone_number]`); return; }
    const existing = await col("staff").findOne({ _id: targetPhone as any });
    if (existing && existing.role === role) { await sendText(from, `❌ +${targetPhone} is already a ${role}.`); return; }
    await col("staff").updateOne({ _id: targetPhone as any }, { $set: { _id: targetPhone, user_id: targetPhone, role, added_by: extractNumberFromJid(sender), added_at: Math.floor(Date.now()/1000) } }, { upsert: true });
    await sendText(from, `✅ +${targetPhone} is now a *${role}*.`);
    return;
  }

  if (cmd === "removeguardian" || cmd === "removemod") {
    if (!(await isModOrAbove(ctx))) { await sendText(from, "❌ Only mods, guardians, and owner can manage roles."); return; }
    const targetPhone = args[0]?.replace(/\D/g, "");
    if (!targetPhone) { await sendText(from, `❌ Usage: *.${cmd}* [phone_number]`); return; }
    const existing = await col("staff").findOne({ _id: targetPhone as any });
    if (!existing) { await sendText(from, `❌ +${targetPhone} is not in the staff list.`); return; }
    if (existing.role === "owner") { await sendText(from, `❌ Cannot remove an owner from staff.`); return; }
    await col("staff").deleteOne({ _id: targetPhone as any });
    await sendText(from, `✅ +${targetPhone} has been removed from staff.`);
    return;
  }

  if (cmd === "recruit") {
    if (!(await isModOrAbove(ctx))) { await sendText(from, "❌ Only mods, guardians, and owner can recruit."); return; }
    const targetPhone = args[0]?.replace(/\D/g, "");
    if (!targetPhone) { await sendText(from, "❌ Usage: *.recruit* [phone_number]"); return; }
    await col("staff").updateOne({ _id: targetPhone as any }, { $set: { _id: targetPhone, user_id: targetPhone, role: "recruit", added_by: extractNumberFromJid(sender), added_at: Math.floor(Date.now()/1000) } }, { upsert: true });
    await sendText(from, `✅ +${targetPhone} has been recruited to Requiem Order staff.`);
    return;
  }

  if (cmd === "addpremium") {
    if (!(await isModOrAbove(ctx))) { await sendText(from, "❌ Only mods, guardians, and owner can grant premium."); return; }
    const targetPhone = args[0]?.replace(/\D/g, "");
    const days = parseInt(args[1] || "30", 10);
    if (!targetPhone) { await sendText(from, "❌ Usage: *.addpremium* [phone_number] [days=30]"); return; }
    const expiry = Math.floor(Date.now() / 1000) + days * 86400;
    await updateUser(targetPhone, { premium: 1, premium_expiry: expiry });
    await sendText(from, `✅ +${targetPhone} now has *Premium* for ${days} day(s).\n🌟 Expires: ${new Date(expiry * 1000).toDateString()}`);
    return;
  }

  if (cmd === "removepremium") {
    if (!(await isModOrAbove(ctx))) { await sendText(from, "❌ Only mods, guardians, and owner can remove premium."); return; }
    const targetPhone = args[0]?.replace(/\D/g, "");
    if (!targetPhone) { await sendText(from, "❌ Usage: *.removepremium* [phone_number]"); return; }
    await updateUser(targetPhone, { premium: 0, premium_expiry: 0 });
    await sendText(from, `✅ Premium removed from +${targetPhone}.`);
    return;
  }

  if (cmd === "ban") {
    if (!(await isModOrAbove(ctx))) { await sendText(from, "❌ Only mods, guardians, and owner can ban users."); return; }
    const targetPhone = args[0]?.replace(/\D/g, "");
    const reason = args.slice(1).join(" ") || "Banned by staff";
    if (!targetPhone) { await sendText(from, "❌ Usage: *.ban* [phone_number] [reason]"); return; }
    await addBan("user", targetPhone, `+${targetPhone}`, reason, sender);
    await sendText(from, `🔨 +${targetPhone} has been *banned*.\n📋 Reason: ${reason}`);
    return;
  }

  if (cmd === "unban") {
    if (!(await isModOrAbove(ctx))) { await sendText(from, "❌ Only mods, guardians, and owner can unban users."); return; }
    const targetPhone = args[0]?.replace(/\D/g, "");
    if (!targetPhone) { await sendText(from, "❌ Usage: *.unban* [phone_number]"); return; }
    await removeBan("user", targetPhone);
    await sendText(from, `✅ +${targetPhone} has been *unbanned*.`);
    return;
  }

  if (cmd === "banlist") {
    if (!(await isModOrAbove(ctx))) { await sendText(from, "❌ Only mods and above can view the ban list."); return; }
    const banned = (await getBanList()).filter((b: any) => b.type === "user");
    if (!banned || banned.length === 0) { await sendText(from, "📋 No users are currently banned."); return; }
    const lines = banned.map((b: any) => `• +${b.target} — ${b.reason || "No reason"}`);
    await sendText(from, `🔨 *Banned Users* (${banned.length})\n\n${lines.join("\n")}`);
    return;
  }

  if (cmd === "addrole") {
    if (!(await isModOrAbove(ctx))) { await sendText(from, "❌ Only mods, guardians, and owner can manage roles."); return; }
    const targetPhone = args[0]?.replace(/\D/g, "");
    const role = args[1]?.toLowerCase();
    if (!targetPhone || !role || !["mod","guardian"].includes(role)) { await sendText(from, "❌ Usage: .addrole [phone_number] [mod|guardian]"); return; }
    await col("staff").updateOne({ _id: targetPhone as any }, { $set: { _id: targetPhone, user_id: targetPhone, role, added_by: extractNumberFromJid(sender), added_at: Math.floor(Date.now()/1000) } }, { upsert: true });
    await sendText(from, `✅ +${targetPhone} is now a ${role}.`);
    return;
  }

  if (cmd === "post") {
    if (!(await isModOrAbove(ctx))) { await sendText(from, "❌ Only mods, guardians, and owner can post announcements."); return; }
    const message = args.join(" ");
    if (!message) { await sendText(from, "❌ Usage: *.post* [message]"); return; }
    const anySock = getAnySock();
    if (!anySock) { await sendText(from, "❌ Bot socket not available."); return; }
    const allGroups = await getAllGroups();
    const announcement = `📢 *ANNOUNCEMENT — Requiem Order 反逆*\n\n${message}`;
    let sent = 0, failed = 0;
    await sendText(from, `📡 Broadcasting to *${(allGroups as any[]).length}* groups…`);
    for (const group of allGroups as any[]) {
      try {
        let mentions: string[] = [];
        try { const meta = await anySock.groupMetadata(group.id || group._id); mentions = meta.participants.map((p: any) => p.id); } catch {}
        await anySock.sendMessage(group.id || group._id, { text: announcement, mentions });
        sent++;
      } catch { failed++; }
      await new Promise((r) => setTimeout(r, 500));
    }
    await sendText(from, `✅ Broadcast complete!\n📤 Sent: *${sent}* groups\n❌ Failed: *${failed}* groups`);
    return;
  }

  if (cmd === "join") {
    if (!(await isModOrAbove(ctx))) { await sendText(from, "❌ Only mods, guardians, and owner can make the bot join groups."); return; }
    const inviteLink = args[0];
    if (!inviteLink) { await sendText(from, "❌ Usage: *.join* [invite_link]"); return; }
    const code = inviteLink.replace("https://chat.whatsapp.com/", "").split("?")[0].trim();
    if (!code) { await sendText(from, "❌ Invalid invite link."); return; }
    try {
      let inviteInfo: any = null;
      try { inviteInfo = await sock.groupGetInviteInfo(code); } catch {}
      if (inviteInfo?.id) {
        const existing = await sock.groupMetadata(inviteInfo.id).catch(() => null);
        if (existing) { await sendText(from, `✅ Bot is already in *${existing.subject}*.`); return; }
        const groupInviteMessage = { inviteCode: code, inviteExpiration: inviteInfo.inviteExpiration || 0, groupJid: inviteInfo.id, groupName: inviteInfo.subject || "", groupThumbnail: undefined as any };
        try { await sock.groupAcceptInviteV4(from, groupInviteMessage); await sendText(from, `✅ Bot has joined *${inviteInfo.subject || "the group"}*.`); }
        catch { await sock.groupAcceptInvite(code); await sendText(from, `✅ Bot has joined *${inviteInfo.subject || "the group"}*.`); }
      } else { await sock.groupAcceptInvite(code); await sendText(from, `✅ Bot has joined the group.`); }
    } catch (err: any) {
      const errMsg = err?.message || "Unknown error";
      if (errMsg.includes("account_reachout_restricted") || errMsg.includes("reachout_restricted")) {
        await sendText(from, `❌ WhatsApp is blocking the bot from joining groups via invite link right now.\n\n*Workarounds:*\n1️⃣ Add the bot's number directly as a group participant\n2️⃣ Wait 24–72 hours and try again`);
      } else { await sendText(from, `❌ Failed to join: ${errMsg}`); }
    }
    return;
  }

  if (cmd === "exit") {
    if (!(await isModOrAbove(ctx))) { await sendText(from, "❌ Only mods and above can make the bot leave."); return; }
    if (!from.endsWith("@g.us")) { await sendText(from, "❌ Must be used in a group."); return; }
    await sendText(from, "👋 Goodbye! The bot is leaving this group.");
    await sock.groupLeave(from).catch(() => {});
    return;
  }

  if (cmd === "show") {
    if (!(await isModOrAbove(ctx))) { await sendText(from, "❌ Only mods and above can use this command."); return; }
    const anySock = getAnySock();
    if (!anySock) { await sendText(from, "❌ Bot not connected."); return; }
    const user = anySock.user;
    const bots = getAllBotsStatus();
    const online = bots.filter((b: any) => b.connected).length;
    await sendText(from, `🤖 *Bot Info*\n\n📛 Name: ${user?.name || "Unknown"}\n📱 ID: ${user?.id || "Unknown"}\n🟢 Online Bots: ${online}/${bots.length}`);
    return;
  }

  if (cmd === "dc" || cmd === "ac" || cmd === "rc") {
    if (!(await isModOrAbove(ctx))) { await sendText(from, "❌ Only mods and above can change card settings."); return; }
    if (!from.endsWith("@g.us")) { await sendText(from, "❌ Must be used in a group."); return; }
    if (cmd === "dc") { await updateGroup(from, { cards_enabled: "off", spawn_enabled: "off" }); await sendText(from, "🃏 Card spawning *disabled* in this group."); }
    else if (cmd === "ac") { await updateGroup(from, { cards_enabled: "on", spawn_enabled: "on" }); await sendText(from, "🃏 Card spawning *enabled* in this group."); }
    else { await updateGroup(from, { spawn_enabled: "off" }); await sendText(from, "🃏 Auto card spawning *restricted* — manual spawning still works."); }
    return;
  }

  if (cmd === "upload") {
    if (!(await isModOrAbove(ctx))) { await sendText(from, "❌ Only staff can upload cards."); return; }
    const rawArgs = args.join(" ");
    const tierMatch = rawArgs.match(/^(T[A-Z0-9]+)\s+(.+)$/i);
    if (!tierMatch) { await sendText(from, "❌ Usage: *.upload [Tier] [Name], [Series]*\nExample: .upload T5 Gojo, Jujutsu Kaisen\n\nReply to an image when using this command."); return; }
    const tier = tierMatch[1].toUpperCase();
    const rest = tierMatch[2];
    const commaIdx = rest.indexOf(",");
    if (commaIdx === -1) { await sendText(from, "❌ Usage: *.upload [Tier] [Name], [Series]*"); return; }
    const cardName = rest.slice(0, commaIdx).trim();
    const series = rest.slice(commaIdx + 1).trim();
    if (!cardName || !series) { await sendText(from, "❌ Both card name and series are required."); return; }
    const quotedMsg = ctx.msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const directImg = ctx.msg.message?.imageMessage;
    const quotedImg = quotedMsg?.imageMessage;
    const imgMsg = directImg ?? quotedImg;
    const ANIMATED_TIERS_SET = new Set(["T6","TS","TX","TZ"]);
    const isAnimatedTier = ANIMATED_TIERS_SET.has(tier);
    const quotedVideo = quotedMsg?.videoMessage;
    const directVideo = ctx.msg.message?.videoMessage;
    const videoMsg = directVideo ?? quotedVideo;
    const { downloadContentFromMessage } = await import("@whiskeysockets/baileys");
    let imageBuffer: Buffer;
    let isAnimated = 0;
    if (isAnimatedTier && videoMsg) {
      const vStream = await downloadContentFromMessage(videoMsg, "video");
      const vChunks: Buffer[] = [];
      for await (const chunk of vStream) vChunks.push(chunk as Buffer);
      imageBuffer = Buffer.concat(vChunks); isAnimated = 1;
    } else if (imgMsg) {
      const stream = await downloadContentFromMessage(imgMsg, "image");
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      imageBuffer = Buffer.concat(chunks); isAnimated = 0;
    } else {
      await sendText(from, `❌ Please reply to an image${isAnimatedTier ? " or video" : ""} or send it with this command.`); return;
    }
    const VALID_TIERS = ["T1","T2","T3","T4","T5","T6","TS","TX","TZ"];
    if (!VALID_TIERS.includes(tier)) { await sendText(from, `❌ Invalid tier *${tier}*. Valid: ${VALID_TIERS.join(", ")}`); return; }
    const existingByName = await col("cards").findOne({ name: { $regex: `^${cardName}$`, $options: "i" } });
    if (existingByName) { await sendText(from, `❌ A card named *${cardName}* already exists (ID: ${existingByName._id}).`); return; }
    const { generateUniqueCardId } = await import("../utils.js");
    const existingIds = new Set((await col("cards").distinct("_id")));
    const newCardId = generateUniqueCardId(existingIds as Set<any>);
    await col("cards").insertOne({ _id: newCardId as any, id: newCardId, name: cardName, series, tier, image_data: imageBuffer.toString("base64"), is_animated: isAnimated, uploaded_by: sender.split("@")[0], source: "upload", created_at: Math.floor(Date.now()/1000) });
    await sendText(from, `✅ Card uploaded successfully!\n\n🎴 *${cardName}* — *${tier}*\n📚 Series: *${series}*\n🆔 Card ID: *${newCardId}*`);
    return;
  }

  if (cmd === "rules") {
    if (!from.endsWith("@g.us")) { await sendText(from, "❌ Must be used in a group."); return; }
    const group = await getGroup(from);
    const rules = (group as any)?.rules || null;
    if (!rules) { await sendText(from, "📋 No rules have been set for this group.\n\n_Use *.setrules* [rules text] to set them._"); return; }
    await sendText(from, `📋 *Group Rules*\n\n${rules}`);
    return;
  }

  if (cmd === "resetbal") {
    if (!(await isModOrAbove(ctx))) { await sendText(from, "❌ Only mods and above can reset balances."); return; }
    const targetPhone = args[0]?.replace(/\D/g, "");
    if (!targetPhone) { await sendText(from, "❌ Usage: *.resetbal* [phone_number]"); return; }
    await resetUserBalance(targetPhone);
    await sendText(from, `✅ Balance reset for +${targetPhone}.`);
    return;
  }

  if (cmd === "reset") {
    if (!ctx.isOwner) { await sendText(from, "❌ Only the owner can fully reset user profiles."); return; }
    const targetPhone = args[0]?.replace(/\D/g, "");
    if (!targetPhone) { await sendText(from, "❌ Usage: *.reset* [phone_number]"); return; }
    await resetUserProfile(targetPhone);
    await sendText(from, `✅ Profile fully reset for +${targetPhone}.`);
    return;
  }

  if (cmd === "addinv") {
    if (!(await isModOrAbove(ctx))) { await sendText(from, "❌ Only mods and above can add inventory items."); return; }
    const targetPhone = args[0]?.replace(/\D/g, "");
    const item = args.slice(1).join(" ");
    if (!targetPhone || !item) { await sendText(from, "❌ Usage: *.addinv* [phone_number] [item name]"); return; }
    await addToInventory(targetPhone, item);
    await sendText(from, `✅ Added *${item}* to +${targetPhone}'s inventory.`);
    return;
  }

  if (cmd === "setms") {
    if (!(await isModOrAbove(ctx))) { await sendText(from, "❌ Only mods and above can set milestone messages."); return; }
    const msText = args.join(" ");
    if (!msText) { await sendText(from, "❌ Usage: *.setms* [message]"); return; }
    if (from.endsWith("@g.us")) { await updateGroup(from, { milestone_msg: msText }); }
    else { await setBotSetting("global_milestone_msg", msText); }
    await sendText(from, `✅ Milestone message set:\n\n_${msText}_`);
    return;
  }

  if (cmd === "delms") {
    if (!(await isModOrAbove(ctx))) { await sendText(from, "❌ Only mods and above can delete milestone messages."); return; }
    if (from.endsWith("@g.us")) { await updateGroup(from, { milestone_msg: null }); }
    else { await deleteBotSetting("global_milestone_msg"); }
    await sendText(from, "✅ Milestone message deleted.");
    return;
  }

  if (cmd === "fetchcards") {
    if (!(await isModOrAbove(ctx))) { await sendText(from, "❌ Only mods and above can import cards."); return; }
    const SHOOB_API = "https://api.shoob.gg";
    const VALID_TIERS_FETCH = ["T1","T2","T3","T4","T5","T6","TS","TX","TZ"];
    const ANIMATED_TIERS_FETCH = new Set(["T6","TS","TX","TZ"]);
    function normTier(raw: string | number | undefined): string {
      if (raw === null || raw === undefined) return "T1";
      const s = String(raw).trim().toUpperCase();
      if (s.startsWith("T") && VALID_TIERS_FETCH.includes(s)) return s;
      if (/^\d$/.test(s)) return `T${s}`;
      if (s === "S") return "TS"; if (s === "X") return "TX"; if (s === "Z") return "TZ";
      return "T1";
    }
    const firstArg = (args[0] || "").toUpperCase();
    let filterTier = "";
    let limit = 20;
    if (firstArg && VALID_TIERS_FETCH.includes(firstArg)) { filterTier = firstArg; limit = Math.min(parseInt(args[1] || "20", 10) || 20, 200); }
    else if (firstArg && /^\d+$/.test(firstArg)) { limit = Math.min(parseInt(firstArg, 10) || 20, 200); }
    else if (firstArg) { await sendText(from, `❌ Invalid option. Usage: *.fetchcards [tier] [limit]*`); return; }
    await sendText(from, `🌐 Fetching cards from Shoob.gg...\n_Tier: ${filterTier || "any"} | Limit: ${limit}_`);
    try {
      const collected: any[] = [];
      let page = 1;
      while (collected.length < limit) {
        const apiRes = await fetch(`${SHOOB_API}/site/api/cards?page=${page}&limit=50`, { headers: { "Accept":"application/json","User-Agent":"Mozilla/5.0" }, signal: AbortSignal.timeout(20000) });
        if (!apiRes.ok) { await sendText(from, `❌ Shoob API returned HTTP ${apiRes.status}.`); return; }
        const apiData: any = await apiRes.json();
        const pageCards: any[] = Array.isArray(apiData) ? apiData : (apiData.cards || apiData.data || apiData.results || []);
        if (!pageCards.length) break;
        for (const c of pageCards) {
          const cardTier = normTier(c.tier);
          if (filterTier && cardTier !== filterTier) continue;
          collected.push(c);
          if (collected.length >= limit) break;
        }
        if (pageCards.length < 50) break;
        page++;
      }
      if (!collected.length) { await sendText(from, filterTier ? `❌ No ${filterTier} cards found on Shoob.` : `❌ No cards returned from Shoob.`); return; }
      const { generateUniqueCardId } = await import("../utils.js");
      const existingIds = new Set(await col("cards").distinct("_id"));
      let imported = 0, skipped = 0;
      const errors: string[] = [];
      const uploaderPhone = sender.split("@")[0].split(":")[0];
      for (const sc of collected) {
        const shoobId: string = String(sc._id || sc.id || "").trim();
        const cardName: string = (sc.name || sc.slug || shoobId).trim().replace(/_/g, " ");
        if (!cardName || cardName.length < 2) { skipped++; continue; }
        const existsByShoobId = shoobId ? await col("cards").findOne({ shoob_id: shoobId }) : null;
        const existsByName = await col("cards").findOne({ name: { $regex: `^${cardName}$`, $options: "i" } });
        if (existsByShoobId || existsByName) { skipped++; continue; }
        const cardTier = normTier(sc.tier);
        const cardSeries: string = Array.isArray(sc.category) && sc.category[0] ? String(sc.category[0]).trim() : (sc.series || sc.anime || "Shoob");
        const imageUrl = shoobId ? `${SHOOB_API}/site/api/cardr/${shoobId}?size=400` : "";
        const cardIsAnimated = ANIMATED_TIERS_FETCH.has(cardTier) ? 1 : 0;
        let imageBase64: string | null = null;
        if (imageUrl) {
          try {
            const mediaRes = await fetch(imageUrl, { headers: { "User-Agent":"Mozilla/5.0" }, signal: AbortSignal.timeout(25000) });
            if (mediaRes.ok) {
              const buf = Buffer.from(await mediaRes.arrayBuffer());
              if (!cardIsAnimated) { try { const sharp = (await import("sharp")).default; imageBase64 = (await sharp(buf).resize(800,1100,{fit:"inside",withoutEnlargement:true}).jpeg({quality:92}).toBuffer()).toString("base64"); } catch { imageBase64 = buf.toString("base64"); } }
              else { imageBase64 = buf.toString("base64"); }
            }
          } catch (e: any) { errors.push(`${cardName}: ${e?.message || "fetch failed"}`); }
          await new Promise((r) => setTimeout(r, 110));
        }
        const newCardId = generateUniqueCardId(existingIds as Set<any>);
        existingIds.add(newCardId);
        await col("cards").insertOne({ _id: newCardId as any, id: newCardId, name: cardName, series: cardSeries, tier: cardTier, image_data: imageBase64, is_animated: cardIsAnimated, uploaded_by: uploaderPhone, source: "shoob", shoob_id: shoobId || null, created_at: Math.floor(Date.now()/1000) });
        imported++;
      }
      let summary = `✅ *Import Done!*\n\n🎴 Imported: *${imported}* cards\n⏭️ Skipped: *${skipped}*\n📊 Total: *${collected.length}*${filterTier ? `\n⭐ Tier: *${filterTier}*` : ""}`;
      if (errors.length > 0) summary += `\n\n⚠️ Errors (${errors.length}): ${errors.slice(0, 3).join(", ")}${errors.length > 3 ? ` …and ${errors.length - 3} more` : ""}`;
      await sendText(from, summary);
    } catch (err: any) { await sendText(from, `❌ Card import failed: ${err?.message || "Unknown error"}`); }
    return;
  }

  if (cmd === "website") {
    const websiteUrl = process.env["WEBSITE_URL"] || "";
    if (!websiteUrl) { await sendText(from, "❌ Website URL not configured."); return; }
    await sendText(from, `🌐 *Requiem Order Website*\n\n${websiteUrl}`);
    return;
  }

  if (cmd === "summon") {
    if (!(await isModOrAbove(ctx))) { await sendText(from, "❌ Only mods, guardians and the owner can summon cards."); return; }
    if (!from.endsWith("@g.us")) { await sendText(from, "❌ Must be used in a group."); return; }
    if (args.length === 0) { await sendText(from, "❌ Usage:\n*.summon <tier>* — e.g. .summon TX\n*.summon <name>* — e.g. .summon Lelouch"); return; }
    const tierMap: Record<string, string> = { "1":"T1","2":"T2","3":"T3","4":"T4","5":"T5","6":"T6","s":"TS","x":"TX","z":"TZ","t1":"T1","t2":"T2","t3":"T3","t4":"T4","t5":"T5","t6":"T6","ts":"TS","tx":"TX","tz":"TZ" };
    const VALID_TIERS = ["T1","T2","T3","T4","T5","T6","TS","TX","TZ"];
    const lastArgRaw = args[args.length - 1].toLowerCase();
    const tierFromLast = tierMap[lastArgRaw];
    let searchTier: string | null = null;
    let nameParts = args;
    if (tierFromLast && args.length > 1) { searchTier = tierFromLast; nameParts = args.slice(0, -1); }
    const nameQuery = nameParts.join(" ").trim();
    const allCards = await getAllCards();
    if (!searchTier && VALID_TIERS.includes(nameQuery.toUpperCase())) {
      const tier = nameQuery.toUpperCase();
      const tierCards = (allCards as any[]).filter((c) => c.tier === tier);
      if (tierCards.length === 0) { await sendText(from, `❌ No cards found for tier *${tier}*.`); return; }
      const card = tierCards[Math.floor(Math.random() * tierCards.length)];
      await sendText(from, `✨ Summoning *${card.name}* (${card.tier})…`);
      await spawnCard(sock, from, String(card.id || card._id));
      return;
    }
    const nameMatches = (allCards as any[]).filter((c) => c.name.toLowerCase().includes(nameQuery.toLowerCase()) && (searchTier ? c.tier === searchTier : true));
    if (nameMatches.length === 0) { await sendText(from, `❌ No card found matching *"${nameQuery}"*${searchTier ? ` (tier ${searchTier})` : ""}.`); return; }
    if (nameMatches.length > 1) {
      const list = nameMatches.slice(0, 10).map((c: any) => `• ${c.name} (${c.tier})`).join("\n");
      await sendText(from, `⚠️ Multiple cards match *"${nameQuery}"*:\n\n${list}${nameMatches.length > 10 ? `\n_...and ${nameMatches.length - 10} more_` : ""}\n\nAdd a tier to narrow it down.`);
      return;
    }
    const card = nameMatches[0];
    await sendText(from, `✨ Summoning *${card.name}* (${card.tier})…`);
    await spawnCard(sock, from, String(card.id || card._id));
    return;
  }

  if (cmd === "restart") {
    if (!(await isModOrAbove(ctx))) { await sendText(from, "❌ Only mods and above can restart the bot."); return; }
    await sendText(from, "♻️ *Restarting bot…* Give it 15–30 seconds.");
    setTimeout(async () => {
      try { const { connectToWhatsApp, gracefulShutdown } = await import("../connection.js"); await gracefulShutdown(); await connectToWhatsApp(undefined, { promptForPhone: false }); }
      catch (err) { logger.error({ err }, ".restart failed"); }
    }, 1500);
    return;
  }

  await sendText(from, `❌ Unknown staff command: *.${cmd}*\n\nAvailable: bots, modlist, addmod, addguardian, removeguardian, removemod, recruit, addpremium, removepremium, ban, unban, banlist, addrole, post, join, exit, show, dc, ac, rc, upload, rules, resetbal, reset, addinv, setms, delms, fetchcards, website, summon, restart`);
}
