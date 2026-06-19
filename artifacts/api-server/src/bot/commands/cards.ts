import type { CommandContext } from "./index.js";
import { sendText, sendImage, sendMedia } from "../connection.js";
import { logger } from "../../lib/logger.js";
import {
  getUserCards, getCard, giveCard, transferCard, lendCard, retrieveCard, getLentCards,
  getUserCard, getDeck, addToDeck, removeFromDeck, clearDeck, getCardLeaderboard,
  getAllCards, ensureUser, getUser, updateUser, createTradeOffer, getPendingTrade,
  updateTradeStatus, createSellOffer, getPendingSellOffer, updateSellOfferStatus,
  getCardOwners, getCardIssueNumber, addCard,
  setBotSetting, getBotSetting, deleteBotSetting,
  deleteUserCardByCopyId, getUserCardByCopyId, getStaff, getMentionName, extractNumberFromJid,
} from "../db/queries.js";
import { getTierEmoji, formatNumber, generateId, VIDEO_TIERS, isGifBuffer } from "../utils.js";
import sharp from "sharp";

export async function handleCards(ctx: CommandContext): Promise<void> {
  const { from, sender, args, command: cmd, msg, sock, resolvedMentions } = ctx;
  // Canonical DB key — user.id (phone digits), not raw sender which may be @lid
  const userId = getUser(sender.split("@")[0].split(":")[0])?.id || sender.split("@")[0].split(":")[0];

  if (cmd === "collection" || cmd === "coll") {
    const target = resolvedMentions[0] || sender;
    const cards = getUserCards(target);
    if (cards.length === 0) {
      await sendText(from, `🎴 @${getMentionName(target)} has no cards yet!`, [target]);
      return;
    }
    let text = `*🎴 Your card collection:*\n\n`;
    cards.slice(0, 30).forEach((c, i) => {
      const tierNum = c.tier.replace(/^T/, "");
      const tierLabel = c.tier.startsWith("T") && !isNaN(Number(tierNum)) ? `Tier ${tierNum}` : c.tier;
      text += `${i + 1}. 🃏 ${c.name} ${tierLabel}\n`;
    });
    if (cards.length > 30) text += `\n_...and ${cards.length - 30} more_`;
    await sock.sendMessage(from, { text, mentions: [target] });
    return;
  }

  if (cmd === "card") {
    const idx = parseInt(args[0]) - 1;
    const cards = getUserCards(userId);
    if (isNaN(idx) || idx < 0 || idx >= cards.length) {
      await sendText(from, `❌ Invalid card index. You have ${cards.length} cards.`);
      return;
    }
    const c = cards[idx];
    const issueNum = getCardIssueNumber(c.user_card_id, c.id);
    const buf = await getCardImageBuffer(c);
    const caption =
      `∘₊✦──────✦₊∘\n` +
      `🎴 𝗖𝗔𝗥𝗗 𝗜𝗡𝗙𝗢\n` +
      `∘₊✦──────✦₊∘\n\n` +
      `𝗡𝗮𝗺𝗲: ${c.name}\n` +
      `𝗖𝗮𝗿𝗱 𝗜𝗗: ${c.id}\n` +
      `𝗗𝗲𝘀𝗰𝗿𝗶𝗽𝘁𝗶𝗼𝗻: ${c.description || c.name}\n` +
      `𝗧𝗶𝗲𝗿: ${c.tier}\n` +
      `𝗜𝘀𝘀𝘂𝗲: #${issueNum}\n\n` +
      `∘₊✦──────✦₊∘`;
    await sendMedia(from, buf, VIDEO_TIERS.has(c.tier) || c.is_animated === 1 || c.is_animated === true, caption);
    return;
  }

  if (cmd === "cardinfo" || cmd === "ci") {
    if (args.length === 0) { await sendText(from, "❌ Usage: .ci <card name> [tier]"); return; }
    // ⌛ instant reaction — card image generation can take a moment
    await sock.sendMessage(from, { react: { text: "⌛", key: msg.key } }).catch(() => {});

    // Tier map: "1"→"T1" ... "6"→"T6", "s"→"TS", "x"→"TX", "z"→"TZ"
    const tierMap: Record<string, string> = {
      "1": "T1", "2": "T2", "3": "T3", "4": "T4", "5": "T5", "6": "T6",
      "s": "TS", "x": "TX", "z": "TZ",
    };
    const lastArg = args[args.length - 1].toLowerCase();
    let searchTier: string | null = null;
    let nameParts = args;

    if (tierMap[lastArg]) {
      searchTier = tierMap[lastArg];
      nameParts = args.slice(0, -1);
    }

    const searchName = nameParts.join(" ");
    if (!searchName) { await sendText(from, "❌ Usage: .ci <card name> [tier]"); return; }

    const allCards = getAllCards();
    const matches = allCards.filter((c) => {
      const nameMatch = c.name.toLowerCase().includes(searchName.toLowerCase());
      const tierMatch = searchTier ? c.tier === searchTier : true;
      return nameMatch && tierMatch;
    });
    if (matches.length === 0) { await sendText(from, "❌ Card not found."); return; }
    if (matches.length === 1) {
      const found = matches[0];
      const owners = getCardOwners(found.id);
      const buf = await getCardImageBuffer(found);
      const ownerMentions: string[] = [];
      let ownersSection = "_⛔ No owners yet_";
      if (owners.length > 0) {
        const shown = owners.slice(0, 10);
        ownersSection = shown.map((o) => {
          ownerMentions.push(o.user_id);
          const u = getUser(o.user_id);
          const nameLabel = u?.name && u.name !== o.user_id ? u.name : (u?.display_id || extractNumberFromJid(o.user_id));
          return `• #${o.issue_num} ${nameLabel} [${o.copy_id || o.user_card_id}]`;
        }).join("\n");
        if (owners.length > 10) ownersSection += `\n_...and ${owners.length - 10} more_`;
      }
      const caption =
        `∘₊✦────────✦₊∘\n` +
        `🎴 𝗖𝗔𝗥𝗗 𝗜𝗡𝗙𝗢\n` +
        `∘₊✦────────✦₊∘\n\n` +
        `𝗡𝗮𝗺𝗲: ${found.name}\n` +
        `𝗦𝗲𝗿𝗶𝗲𝘀: ${found.series || "General"}\n` +
        `𝗧𝗶𝗲𝗿: ${found.tier}\n` +
        `𝗖𝗮𝗿𝗱 𝗜𝗗: ${found.id}\n` +
        `𝗧𝗼𝘁𝗮𝗹 𝗜𝘀𝘀𝘂𝗲𝘀: ${owners.length}\n\n` +
        `✦────⋆⋅✧⋅⋆────✦\n` +
        `👥 𝗢𝗪𝗡𝗘𝗥𝗦\n` +
        `✦────⋆⋅✧⋅⋆────✦\n\n` +
        `${ownersSection}\n\n` +
        `∘₊✦────────✦₊∘`;
      if (VIDEO_TIERS.has(found.tier) && !isGifBuffer(buf)) {
        await sock.sendMessage(from, { video: buf, gifPlayback: true, mimetype: "video/mp4", caption, mentions: ownerMentions });
      } else {
        await sock.sendMessage(from, { image: buf, caption, mentions: ownerMentions });
      }
    } else {
      for (let i = 0; i < matches.length; i++) {
        const c = matches[i];
        const owners = getCardOwners(c.id);
        let buf: Buffer;
        try {
          buf = await getCardImageBuffer(c);
        } catch {
          await sendText(from, `⚠️ Could not load image for *${c.name}* (${c.tier}) — skipping.`);
          continue;
        }
        const ownerMentions: string[] = [];
        let ownersSection = "_⛔ No owners yet_";
        if (owners.length > 0) {
          const shown = owners.slice(0, 5);
          ownersSection = shown.map((o) => {
            ownerMentions.push(o.user_id);
            return `• #${o.issue_num} @${extractNumberFromJid(o.user_id)} [ID:${o.user_card_id}]`;
          }).join("\n");
          if (owners.length > 5) ownersSection += `\n_...and ${owners.length - 5} more_`;
        }
        const caption =
          `∘₊✦────────✦₊∘\n` +
          `🎴 𝗖𝗔𝗥𝗗 ${i + 1}/${matches.length}\n` +
          `∘₊✦────────✦₊∘\n\n` +
          `𝗡𝗮𝗺𝗲: ${c.name}\n` +
          `𝗦𝗲𝗿𝗶𝗲𝘀: ${c.series || "General"}\n` +
          `𝗧𝗶𝗲𝗿: ${c.tier}\n` +
          `𝗖𝗮𝗿𝗱 𝗜𝗗: ${c.id}\n` +
          `𝗧𝗼𝘁𝗮𝗹 𝗜𝘀𝘀𝘂𝗲𝘀: ${owners.length}\n\n` +
          `👥 𝗢𝗪𝗡𝗘𝗥𝗦\n${ownersSection}\n\n` +
          `∘₊✦────────✦₊∘`;
        if (VIDEO_TIERS.has(c.tier) && !isGifBuffer(buf)) {
          await sock.sendMessage(from, { video: buf, gifPlayback: true, mimetype: "video/mp4", caption, mentions: ownerMentions });
        } else {
          await sock.sendMessage(from, { image: buf, caption, mentions: ownerMentions });
        }
      }
    }
    return;
  }

  if (cmd === "mycollectionseries" || cmd === "mycolls") {
    const cards = getUserCards(userId);
    const series: Record<string, number> = {};
    for (const c of cards) {
      series[c.series] = (series[c.series] || 0) + 1;
    }
    const text = `📚 *Your Series Collection*\n\n` +
      Object.entries(series).map(([s, n]) => `• ${s}: ${n} cards`).join("\n") || "No cards yet!";
    await sendText(from, text);
    return;
  }

  if (cmd === "ss") {
    const seriesName = args.join(" ");
    if (!seriesName) { await sendText(from, "❌ Usage: .ss <series name>"); return; }
    const allCards = getAllCards();
    const seriesCards = allCards.filter((c) =>
      (c.series || "General").toLowerCase().includes(seriesName.toLowerCase())
    );
    if (seriesCards.length === 0) {
      await sendText(from, `❌ No cards found for series: *${seriesName}*`);
      return;
    }
    const actualSeries = seriesCards[0].series || "General";
    let text =
      `╭─❰ 🎴 ᴄᴀʀᴅs ʙʏ sᴇʀɪᴇꜱ ❱─╮\n` +
      `│ 📚 sᴇʀɪᴇs: ${actualSeries}\n` +
      `│ 🃏 ᴛᴏᴛᴀʟ ᴄᴀʀᴅs: ${seriesCards.length}\n` +
      `│\n`;
    for (let i = 0; i < seriesCards.length; i++) {
      const c = seriesCards[i];
      text += `├─ 🃏 ${i + 1}. ${c.name}\n`;
      text += `│   ᴛɪᴇʀ: ${c.tier}\n`;
    }
    text += `╰──────────────╯`;
    await sendText(from, text);
    return;
  }

  if (cmd === "sc") {
    const searchName = args.join(" ");
    if (!searchName) { await sendText(from, "❌ Usage: .sc <card name>"); return; }
    const myCards = getUserCards(userId);
    const found = myCards.filter((c) =>
      c.name.toLowerCase().includes(searchName.toLowerCase())
    );
    if (found.length === 0) {
      await sendText(from, `🔎 No cards found matching *"${searchName}"* in your collection.`);
      return;
    }
    let text = `🔎 Search Results for: *"${searchName}"*\n\n`;
    for (let i = 0; i < found.length; i++) {
      const c = found[i];
      text += `🃏 ${i + 1}. ${c.name} (${c.series || "General"})\n`;
      text += `   Tier: ${c.tier}\n`;
      text += `   Index: ${myCards.indexOf(c) + 1}\n\n`;
    }
    text += `Total found: ${found.length} card(s)`;
    await sendText(from, text);
    return;
  }

  if (cmd === "cardleaderboard" || cmd === "cardlb") {
    const lb = getCardLeaderboard(10);
    const MEDALS = ["🥇", "🥈", "🥉"];
    let text = "╔ ❰ 🎴 Cᴀʀᴅ Lᴇᴀᴅᴇʀʙᴏᴀʀᴅ ❱ ╗\n║ 🃏 Tᴏᴘ Cᴏʟʟᴇᴄᴛᴏʀs\n║\n";
    lb.forEach((e, i) => {
      const num = String(i + 1).padStart(2, "0");
      const medal = MEDALS[i];
      const u = getUser(e.user_id);
      const name = u?.name || extractNumberFromJid(e.user_id);
      const prefix = medal ? `${medal} ${num}.` : `${num}.`;
      text += `║ ${prefix} ${name}\n║     └─ 🃏 Cᴀʀᴅs: ${e.card_count}\n║\n`;
    });
    text += "╚══════════════════╝";
    await sock.sendMessage(from, { text, mentions: lb.map((e) => e.user_id) });
    return;
  }

  if (cmd === "cardshop") {
    const cards = getAllCards();
    const tiers: Record<string, any[]> = {};
    for (const c of cards) {
      if (!tiers[c.tier]) tiers[c.tier] = [];
      tiers[c.tier].push(c);
    }
    let text = "🃏 *Card Shop*\n\n";
    for (const [tier, cs] of Object.entries(tiers)) {
      text += `${getTierEmoji(tier)} *${tier}*\n`;
      cs.slice(0, 5).forEach((c) => {
        text += `  • ${c.name} (${c.series}) — ID: \`${c.id}\`\n`;
      });
    }
    text += "\nUse .get [card_id] to claim a spawned card.";
    await sendText(from, text);
    return;
  }

  if (cmd === "stardust") {
    const cards = getUserCards(userId);
    const tierDustMap: Record<string, number> = {"T1":5,"T2":10,"T3":25,"T4":50,"T5":100,"TS":250,"TX":500};
    const dust = cards.reduce((acc, c) => acc + (tierDustMap[c.tier] || 5), 0);
    await sendText(from, `✨ Your stardust value: *${dust} SD*\n(Based on ${cards.length} cards)`);
    return;
  }

  if (cmd === "vs") {
    const challenged = resolvedMentions[0];
    if (!challenged) { await sendText(from, "❌ Mention someone to VS."); return; }
    const myDeck = getDeck(sender);
    const theirDeck = getDeck(challenged);
    if (myDeck.length === 0) { await sendText(from, "❌ You don't have a deck set. Use .ctd [card #]"); return; }
    if (theirDeck.length === 0) { await sendText(from, "❌ Your opponent has no deck."); return; }

    const myPower = myDeck.reduce((acc, c) => acc + c.attack + c.defense + c.speed, 0);
    const theirPower = theirDeck.reduce((acc, c) => acc + c.attack + c.defense + c.speed, 0);
    const winner = myPower > theirPower ? sender : myPower < theirPower ? challenged : null;

    await sock.sendMessage(from, {
      text: `⚔️ *Card Battle*\n\n@${getMentionName(sender)} Power: ${myPower}\n@${getMentionName(challenged)} Power: ${theirPower}\n\n${winner ? `🏆 Winner: @${getMentionName(winner)}!` : "🤝 It's a tie!"}`,
      mentions: [sender, challenged],
    });
    return;
  }

  if (cmd === "auction" || cmd === "myauc" || cmd === "remauc" || cmd === "listauc" || cmd === "bid") {
    await sendText(from, "🚧 Auction system coming soon.");
    return;
  }

  // .claim <claimCode> — claim a spawned card by its claim code
  if (cmd === "claim") {
    const code = args[0]?.toLowerCase();
    if (!code) { await sendText(from, "❌ Usage: .claim <claimCode>"); return; }
    const db = (await import("../db/database.js")).getDb();
    const spawn = db.prepare(
      "SELECT * FROM card_spawns WHERE spawn_token = ? AND claimed_by IS NULL LIMIT 1"
    ).get(code) as any;
    if (!spawn) { await sendText(from, "❌ Invalid or already claimed code."); return; }
    const cardData = getCard(spawn.card_id);
    if (!cardData) { await sendText(from, "❌ Card not found."); return; }
    db.prepare("UPDATE card_spawns SET claimed_by = ?, claimed_at = unixepoch() WHERE id = ?").run(sender, spawn.id);
    giveCard(sender, spawn.card_id);
    const buf = await getCardImageBuffer(cardData);
    await sock.sendMessage(from, {
      image: buf,
      caption: `🎉 @${getMentionName(sender)} claimed *${cardData.name}* (${cardData.tier})!`,
      mentions: [sender],
    });
    return;
  }

  // .si <name> — search owned cards by partial name
  if (cmd === "si") {
    const query = args.join(" ").toLowerCase();
    if (!query) { await sendText(from, "❌ Usage: .si <name>"); return; }
    const cards = getUserCards(userId);
    const matches = cards.filter((c) => c.name.toLowerCase().includes(query));
    if (matches.length === 0) { await sendText(from, `❌ No cards matching "${args.join(" ")}".`); return; }
    const shown = matches.slice(0, 20);
    const lines = shown.map((c, i) => {
      const collIndex = cards.indexOf(c) + 1;
      const tierNum = c.tier.replace(/^T/, "");
      const tierLabel = c.tier.startsWith("T") && !isNaN(Number(tierNum)) ? `T${tierNum}` : c.tier;
      return (
        `┌─⟡ 𝗖𝗔𝗥𝗗 ${i + 1}\n` +
        `║ ➩ 𝗡𝗮𝗺𝗲 : ${c.name}\n` +
        `║ ➩ 𝗦𝗲𝗿𝗶𝗲𝘀 : ${c.series || "General"}\n` +
        `║ ➩ 𝗧𝗶𝗲𝗿 : ${tierLabel}\n` +
        `║ ➩ 𝗜𝗻𝗱𝗲𝘅 : #${collIndex}\n` +
        `║ ➩ 𝗜𝗗 : ${c.id}\n` +
        `└────────────────`
      );
    });
    const header =
      `┌─⟡ 🔍 𝗦𝗘𝗔𝗥𝗖𝗛 𝗥𝗘𝗦𝗨𝗟𝗧𝗦\n` +
      `║ ➩ Query : "${args.join(" ")}"\n` +
      `║ ➩ Found : ${matches.length} card(s)\n` +
      `╠─────────────────────\n`;
    const footer = matches.length > 20 ? `\n_...and ${matches.length - 20} more_` : "";
    await sendText(from, header + lines.join("\n") + footer);
    return;
  }

  // .slb <series> — series leaderboard
  if (cmd === "slb") {
    const seriesName = args.join(" ");
    if (!seriesName) { await sendText(from, "❌ Usage: .slb <series>"); return; }
    const db = (await import("../db/database.js")).getDb();
    const rows = db.prepare(`
      SELECT uc.user_id, COUNT(*) as cnt, u.name
      FROM user_cards uc
      JOIN cards c ON c.id = uc.card_id
      LEFT JOIN users u ON u.id = uc.user_id
      WHERE LOWER(c.series) LIKE LOWER(?)
      GROUP BY uc.user_id
      ORDER BY cnt DESC
      LIMIT 10
    `).all(`%${seriesName}%`) as any[];
    if (rows.length === 0) { await sendText(from, `❌ No collectors found for series "${seriesName}".`); return; }
    const MEDALS = ["🥇", "🥈", "🥉"];
    const lines = rows.map((r, i) => {
      const medal = MEDALS[i] || `${String(i + 1).padStart(2, "0")}.`;
      const name = r.name || extractNumberFromJid(r.user_id);
      return `║ ║ ${medal} ${name}\n║ ║     └─ 🃏 ${r.cnt} cards`;
    });
    const text =
      `┌─⟡ 『 📊 𝗦𝗘𝗥𝗜𝗘𝗦 𝗟𝗘𝗔𝗗𝗘𝗥𝗕𝗢𝗔𝗥𝗗 』⟡\n` +
      `║\n` +
      `║ ┌──────────────────────\n` +
      `║ ║ 📚 𝗦𝗲𝗿𝗶𝗲𝘀 : ${seriesName}\n` +
      `║ ║ 👥 𝗧𝗼𝗽 𝗖𝗼𝗹𝗹𝗲𝗰𝘁𝗼𝗿𝘀\n` +
      `║ └──────────────────────\n` +
      `║\n` +
      `╠─⟡ 🏆 𝗥𝗔𝗡𝗞𝗜𝗡𝗚𝗦\n` +
      `║ ┌──────────────────────\n` +
      lines.join("\n") + "\n" +
      `║ └──────────────────────\n` +
      `╚══════════════════════╝`;
    await sendText(from, text);
    return;
  }

  // .tier — show owned cards grouped by tier
  if (cmd === "tier") {
    const cards = getUserCards(userId);
    if (cards.length === 0) { await sendText(from, "🎴 You have no cards."); return; }
    const groups: Record<string, string[]> = {};
    for (const c of cards) {
      const t = c.tier || "Unknown";
      if (!groups[t]) groups[t] = [];
      groups[t].push(c.name);
    }
    const tierOrder = ["TX", "TZ", "TS", "T6", "T5", "T4", "T3", "T2", "T1"];
    const sortedKeys = [...tierOrder.filter((t) => groups[t]), ...Object.keys(groups).filter((t) => !tierOrder.includes(t))];
    const lines = sortedKeys.map((t) => {
      const tierNum = t.replace(/^T/, "");
      const label = t.startsWith("T") && !isNaN(Number(tierNum)) ? `Tier ${tierNum}` : t;
      return `*${label}* (${groups[t].length})\n${groups[t].slice(0, 5).join(", ")}${groups[t].length > 5 ? ` +${groups[t].length - 5} more` : ""}`;
    });
    await sendText(from, `🏆 *Your Cards by Tier*\n\n${lines.join("\n\n")}`);
    return;
  }

  // .myseries — show all unique series in user collection
  if (cmd === "myseries") {
    const phoneNormalized = extractNumberFromJid(sender);
    const cards = getUserCards(userId);
    if (cards.length === 0) { await sendText(from, "🎴 You have no cards."); return; }
    const db = (await import("../db/database.js")).getDb();
    const seriesRows = db.prepare(`
      SELECT DISTINCT c.series, COUNT(*) as cnt
      FROM user_cards uc
      JOIN cards c ON c.id = uc.card_id
      WHERE uc.user_id = ? OR uc.user_id = ?
      GROUP BY c.series
      ORDER BY cnt DESC
    `).all(phoneNormalized, sender) as any[];
    const lines = seriesRows.map((r, i) => `${i + 1}. ${r.series || "General"} — ${r.cnt} cards`);
    await sendText(from, `📚 *Your Series Collection*\n\n${lines.join("\n")}`);
    return;
  }

  // .cs <series> — show user's cards from a specific series
  if (cmd === "cs") {
    const seriesName = args.join(" ");
    if (!seriesName) { await sendText(from, "❌ Usage: .cs <series name>"); return; }
    const cards = getUserCards(userId);
    const found = cards.filter((c) =>
      (c.series || "General").toLowerCase().includes(seriesName.toLowerCase())
    );
    if (found.length === 0) {
      await sendText(from, `❌ You have no cards from series: *${seriesName}*`);
      return;
    }
    const actualSeries = found[0].series || "General";
    let text =
      `╭─❰ 🎴 ʏᴏᴜʀ ᴄᴀʀᴅs ❱─╮\n` +
      `│ 📚 sᴇʀɪᴇs: ${actualSeries}\n` +
      `│ 🃏 ᴄᴏᴜɴᴛ: ${found.length}\n` +
      `│\n`;
    for (let i = 0; i < found.length && i < 20; i++) {
      const c = found[i];
      const collIndex = cards.indexOf(c) + 1;
      text += `├─ 🃏 #${collIndex}: ${c.name}\n`;
      text += `│   ᴛɪᴇʀ: ${c.tier}\n`;
    }
    if (found.length > 20) text += `├─ ᴀɴᴅ ${found.length - 20} ᴍᴏʀᴇ...\n`;
    text += `╰──────────────╯`;
    await sendText(from, text);
    return;
  }

  // .ubs — bulk card upload via Gemini AI (reply to multiple images)
  if (cmd === "ubs") {
    const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
    const quotedMsg = ctxInfo?.quotedMessage;
    if (!quotedMsg?.imageMessage && !msg.message?.imageMessage) {
      await sendText(from, "❌ Reply to an image (or send an image with .ubs) to analyze it with AI.\n\nUsage:\n• Reply to an image: .ubs\n• After result: .ups confirm  to save  |  .ups cancel  to discard");
      return;
    }
    await sendText(from, "🤖 Analyzing card with Gemini AI...");
    try {
      const { downloadMediaMessage } = await import("@whiskeysockets/baileys");
      const target = quotedMsg?.imageMessage
        ? { key: { remoteJid: from, fromMe: false, id: ctxInfo?.stanzaId || "", participant: ctxInfo?.participant }, message: quotedMsg }
        : msg;
      const buffer = await downloadMediaMessage(target as any, "buffer", {}, { reuploadRequest: (sock as any).updateMediaMessage } as any);
      const imageBase64 = (Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as any)).toString("base64");

      const geminiKey = process.env["GEMINI_API_KEY"] || "";
      if (!geminiKey) {
        await sendText(from, "❌ Gemini API key not configured. Set GEMINI_API_KEY in environment secrets.");
        return;
      }
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{
              parts: [
                {
                  text: `Analyze this anime trading card image. Return ONLY a raw JSON object with no markdown, no code fences, no explanation. Format: {"name":"character name","series":"anime/series name","tier":"T1"}. Tier must be one of: T1 T2 T3 T4 T5 T6 TS TX TZ. Guess tier from art quality: sketchy/simple=T1, detailed=T3, cinematic=T5, legendary/god-tier=T6 TS TX TZ. Return ONLY the JSON object.`
                },
                { inline_data: { mime_type: "image/jpeg", data: imageBase64 } }
              ]
            }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 256 },
          }),
        }
      );
      const geminiData = await geminiRes.json() as any;
      if (geminiRes.status === 429 || geminiData?.error?.code === 429 || geminiData?.error?.status === "RESOURCE_EXHAUSTED") {
        await sendText(from, "❌ Gemini API quota exceeded. You've hit the daily limit — try again tomorrow or check your usage at console.cloud.google.com/apis/api/generativelanguage.googleapis.com/quotas");
        return;
      }
      if (geminiData?.error) throw new Error(geminiData.error.message || "Gemini API error");
      const rawText = (geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
      // Strip markdown code fences if present
      const stripped = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
      const jsonMatch = stripped.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.error({ rawText, geminiData }, "Gemini returned no JSON");
        throw new Error(`No JSON in response. Got: "${rawText.slice(0, 100)}"`);
      }
      const parsed = JSON.parse(jsonMatch[0]);

      // Store pending upload using bot_settings
      setBotSetting(`ubs_pending:${sender}`, JSON.stringify({ name: parsed.name, series: parsed.series, tier: parsed.tier, imageBase64, uploadedBy: sender }));

      await sendText(from, `🤖 *Gemini Card Analysis*\n\n📛 Name: *${parsed.name}*\n📚 Series: *${parsed.series}*\n⭐ Tier: *${parsed.tier}*\n\nType *.ups confirm* to save this card, or *.ups cancel* to discard.`);
    } catch (err: any) {
      await sendText(from, `❌ Gemini analysis failed: ${err?.message || "Unknown error"}`);
    }
    return;
  }

  // .ups — confirm or cancel bulk upload
  if (cmd === "ups") {
    const sub = args[0]?.toLowerCase();

    if (sub === "cancel") {
      deleteBotSetting(`ubs_pending:${sender}`);
      await sendText(from, "❌ Card upload cancelled.");
      return;
    }

    if (sub === "confirm") {
      const pendingRaw = getBotSetting(`ubs_pending:${sender}`);
      if (!pendingRaw) { await sendText(from, "❌ No pending card upload. Use .ubs first."); return; }
      const pending = JSON.parse(pendingRaw.toString());
      const imageBuffer = Buffer.from(pending.imageBase64, "base64");
      const resized = await sharp(imageBuffer).resize(900, 1260, { fit: "cover" }).jpeg({ quality: 90 }).toBuffer();
      const { generateUniqueCardId } = await import("../utils.js");
      const existingIds = new Set((await import("../db/database.js")).getDb().prepare("SELECT id FROM cards").all().map((r: any) => r.id));
      const cardId = generateUniqueCardId(existingIds);
      await addCard({ id: cardId, name: pending.name, series: pending.series, tier: pending.tier, image_data: resized, uploaded_by: pending.uploadedBy });
      deleteBotSetting(`ubs_pending:${sender}`);
      await sendText(from, `✅ Card *${pending.name}* (${pending.tier}) from *${pending.series}* has been added to the database!`);
      return;
    }

    await sendText(from, "❌ Usage: .ups confirm | .ups cancel\n\nTo start: reply to a card image with .ubs");
    return;
  }

  if (cmd === "cg") {
    const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
    const mentioned = resolvedMentions[0] || ctxInfo?.participant;
    const numArg = args.find((a) => /^\d+$/.test(a));
    const cardNum = numArg ? parseInt(numArg) : NaN;
    if (!mentioned || isNaN(cardNum)) { await sendText(from, "❌ Usage: .cg @user [card #]  or reply to a user's message with .cg [card #]"); return; }
    const cards = getUserCards(userId);
    if (cardNum < 1 || cardNum > cards.length) { await sendText(from, `❌ Invalid card number. You have ${cards.length} cards.`); return; }
    const card = cards[cardNum - 1];
    ensureUser(mentioned);
    transferCard(card.user_card_id, mentioned);
    await sock.sendMessage(from, {
      text: `🎁 @${getMentionName(sender)} gifted *${card.name}* to @${getMentionName(mentioned)}!`,
      mentions: [sender, mentioned],
    });
    return;
  }

  if (cmd === "ctd") {
    if (args[0]?.toLowerCase() === "clear") {
      clearDeck(sender);
      await sendText(from, "✅ Deck cleared.");
      return;
    }
    if (args[0]?.toLowerCase() === "remove") {
      const slot = parseInt(args[1]);
      if (isNaN(slot)) { await sendText(from, "❌ Usage: .ctd remove [slot]"); return; }
      removeFromDeck(sender, slot);
      await sendText(from, `✅ Removed card from slot ${slot}.`);
      return;
    }
    const cardNum = parseInt(args[0]);
    if (isNaN(cardNum)) { await sendText(from, "❌ Usage: .ctd [card #]"); return; }
    const cards = getUserCards(userId);
    if (cardNum < 1 || cardNum > cards.length) { await sendText(from, "❌ Invalid card number."); return; }
    const card = cards[cardNum - 1];
    const deck = getDeck(sender);
    if (deck.length >= 5) { await sendText(from, "❌ Deck is full (5 cards max). Use .ctd remove [slot] to remove one."); return; }
    const nextSlot = deck.length + 1;
    addToDeck(sender, nextSlot, card.user_card_id);
    await sendText(from, `✅ Added *${card.name}* to deck slot ${nextSlot}.`);
    return;
  }

  if (cmd === "deck") {
    const deck = getDeck(sender);
    if (deck.length === 0) { await sendText(from, "🃏 Your deck is empty. Use .ctd [card #]"); return; }
    const totalPower = deck.reduce((acc, c) => acc + c.attack + c.defense + c.speed, 0);
    let text = `🃏 *Your Deck* (Total Power: ${totalPower})\n\n`;
    deck.forEach((c) => {
      text += `[Slot ${c.slot}] ${getTierEmoji(c.tier)} *${c.name}* — ATK:${c.attack} DEF:${c.defense} SPD:${c.speed}\n`;
    });
    await sendText(from, text);
    return;
  }

  if (cmd === "sdi") {
    await sendText(from, "🎴 Deck background customization coming soon!");
    return;
  }

  if (cmd === "lc") {
    const mentioned = resolvedMentions[0];
    const cardNum = parseInt(args[1] || args[0]);
    if (!mentioned || isNaN(cardNum)) { await sendText(from, "❌ Usage: .lc @user [card #]"); return; }
    const cards = getUserCards(userId);
    if (cardNum < 1 || cardNum > cards.length) { await sendText(from, "❌ Invalid card number."); return; }
    const card = cards[cardNum - 1];
    lendCard(card.user_card_id, mentioned);
    await sock.sendMessage(from, {
      text: `🤝 @${getMentionName(sender)} lent *${card.name}* to @${getMentionName(mentioned)}!`,
      mentions: [sender, mentioned],
    });
    return;
  }

  if (cmd === "lcd") {
    const lent = getLentCards(sender);
    if (lent.length === 0) { await sendText(from, "✅ You have no lent cards."); return; }
    const text = "🤝 *Lent Cards*\n\n" +
      lent.map((c) => `• *${c.name}* → @${getMentionName(c.lent_to || "")}`).join("\n");
    await sock.sendMessage(from, { text, mentions: lent.map((c) => c.lent_to).filter(Boolean) });
    return;
  }

  if (cmd === "retrieve") {
    retrieveCard(sender);
    await sendText(from, "✅ All lent cards have been retrieved!");
    return;
  }

  if (cmd === "sellc") {
    const mentioned = resolvedMentions[0];
    const cardNum = parseInt(args[1] || args[0]);
    const price = parseInt(args[2] || args[1] || args[0]);
    if (!mentioned || isNaN(cardNum) || isNaN(price)) {
      await sendText(from, "❌ Usage: .sellc @user [card #] [price]");
      return;
    }
    const cards = getUserCards(userId);
    if (cardNum < 1 || cardNum > cards.length) { await sendText(from, "❌ Invalid card number."); return; }
    const card = cards[cardNum - 1];
    const offerId = createSellOffer(sender, mentioned, card.user_card_id, price);
    await sock.sendMessage(from, {
      text: `💰 @${getMentionName(mentioned)}, @${getMentionName(sender)} wants to sell you *${card.name}* for $${formatNumber(price)}.\n\nReply *.accept* to buy or *.decline* to reject.`,
      mentions: [sender, mentioned],
    });
    return;
  }

  if (cmd === "tc") {
    const quotedCtx = msg.message?.extendedTextMessage?.contextInfo;
    if (!quotedCtx) { await sendText(from, "❌ Reply to someone's message with .tc [your card #] [their card #]"); return; }
    const recipient = quotedCtx.participant || quotedCtx.remoteJid;
    if (!recipient) { await sendText(from, "❌ Couldn't determine recipient."); return; }
    const myCardNum = parseInt(args[0]);
    const theirCardNum = parseInt(args[1]);
    if (isNaN(myCardNum) || isNaN(theirCardNum)) { await sendText(from, "❌ Usage: .tc [your card #] [their card #] (reply to their message)"); return; }
    const myCards = getUserCards(userId);
    const theirCards = getUserCards(recipient);
    if (myCardNum < 1 || myCardNum > myCards.length) { await sendText(from, "❌ Invalid card number."); return; }
    if (theirCardNum < 1 || theirCardNum > theirCards.length) { await sendText(from, "❌ They don't have that card."); return; }
    const myCard = myCards[myCardNum - 1];
    const theirCard = theirCards[theirCardNum - 1];
    const offerId = createTradeOffer(sender, recipient, myCard.user_card_id, theirCard.user_card_id);
    await sock.sendMessage(from, {
      text: `🔄 @${getMentionName(recipient)}, @${getMentionName(sender)} wants to trade:\n*${myCard.name}* for your *${theirCard.name}*\n\nReply *.accept* or *.decline*`,
      mentions: [sender, recipient],
    });
    return;
  }

  if (cmd === "accept") {
    const trade = getPendingTrade(sender);
    if (trade) {
      const myCard = getUserCard(trade.to_card);
      const theirCard = getUserCard(trade.from_card);
      if (!myCard || !theirCard) { await sendText(from, "❌ Cards no longer available."); return; }
      transferCard(trade.from_card, sender);
      transferCard(trade.to_card, trade.from_user);
      updateTradeStatus(trade.id, "accepted");
      await sock.sendMessage(from, {
        text: `✅ Trade complete!\n@${getMentionName(sender)} got *${theirCard.name}*\n@${getMentionName(trade.from_user)} got *${myCard.name}*`,
        mentions: [sender, trade.from_user],
      });
      return;
    }

    const sell = getPendingSellOffer(sender);
    if (sell) {
      const buyerUser = ensureUser(sender);
      if ((buyerUser.balance || 0) < sell.price) {
        await sendText(from, `❌ Not enough money. Need $${formatNumber(sell.price)}.`);
        return;
      }
      const card = getUserCard(sell.user_card_id);
      transferCard(sell.user_card_id, sender);
      updateUser(sender, { balance: (buyerUser.balance || 0) - sell.price });
      const seller = ensureUser(sell.seller_id);
      updateUser(sell.seller_id, { balance: (seller.balance || 0) + sell.price });
      updateSellOfferStatus(sell.id, "accepted");
      await sock.sendMessage(from, {
        text: `✅ Purchase complete! @${getMentionName(sender)} bought *${card.name}* for $${formatNumber(sell.price)}.`,
        mentions: [sender, sell.seller_id],
      });
      return;
    }

    await sendText(from, "❌ No pending offer found.");
    return;
  }

  if (cmd === "decline") {
    const trade = getPendingTrade(sender);
    if (trade) { updateTradeStatus(trade.id, "declined"); await sendText(from, "❌ Trade declined."); return; }
    const sell = getPendingSellOffer(sender);
    if (sell) { updateSellOfferStatus(sell.id, "declined"); await sendText(from, "❌ Offer declined."); return; }
    await sendText(from, "❌ No pending offer found.");
    return;
  }

  if (cmd === "deletecard" || cmd === "delcard") {
    if (!ctx.isOwner && !getStaff(sender)) {
      await sendText(from, "❌ Only staff can delete cards.");
      return;
    }
    const copyId = (args[0] || "").toUpperCase();
    if (!copyId) {
      await sendText(from, "❌ Usage: .delcard <copy_id>\nExample: .delcard AB3K9");
      return;
    }
    const card = getUserCardByCopyId(copyId);
    if (!card) {
      await sendText(from, `❌ No card found with ID: *${copyId}*`);
      return;
    }
    const { deleteUserCardByCopyIdAdmin } = await import("../db/queries.js");
    const deleted = deleteUserCardByCopyIdAdmin(copyId);
    if (!deleted) {
      await sendText(from, `❌ Could not delete card *${copyId}*.`);
      return;
    }
    const u = getUser(card.user_id);
    const ownerDisplay = u?.name && u.name !== card.user_id ? u.name : (u?.display_id || extractNumberFromJid(card.user_id));
    await sendText(from,
      `🗑️ *Card Deleted*\n\n` +
      `*Card:* ${card.card_name}\n` +
      `*Tier:* ${card.tier}\n` +
      `*Copy ID:* ${copyId}\n` +
      `*Owner:* ${ownerDisplay}`
    );
    return;
  }
}

async function getCardImageBuffer(card: any): Promise<Buffer> {
  // 1. Prefer stored blob (custom uploaded cards)
  if (card.image_data) {
    return Buffer.isBuffer(card.image_data) ? card.image_data : Buffer.from(card.image_data);
  }
  // 2. Resolve media_url — may be directly on card OR inside raw_data JSON (scraped cards)
  let mediaUrl: string | null = card.media_url || null;
  if (!mediaUrl && card.raw_data) {
    try {
      const raw = typeof card.raw_data === "string" ? JSON.parse(card.raw_data) : card.raw_data;
      mediaUrl = raw?.media_url || null;
    } catch { /* ignore */ }
  }
  // 3. Build CDN URL from shoob_id as final fallback
  if (!mediaUrl && card.shoob_id) {
    const hasWebm = card.has_webm === 1 || card.has_webm === true;
    mediaUrl = hasWebm
      ? `https://api.shoob.gg/site/api/cardr/${card.shoob_id}?type=webm`
      : `https://api.shoob.gg/site/api/cardr/${card.shoob_id}?size=400`;
  }
  if (mediaUrl) {
    try {
      const res = await fetch(mediaUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        signal: AbortSignal.timeout(12000),
      });
      if (res.ok) {
        const contentType = res.headers.get("content-type") || "";
        const buf = Buffer.from(await res.arrayBuffer());
        // GIF/WebM — return as-is, caller uses VIDEO_TIERS / is_animated to pick send method
        if (contentType.includes("gif") || contentType.includes("webm") || contentType.includes("video")) {
          return buf;
        }
        // Static image — run through sharp to ensure valid JPEG
        return sharp(buf).jpeg({ quality: 88 }).toBuffer();
      }
    } catch {
      // Fall through to placeholder
    }
  }
  // 3. Fallback placeholder SVG
  const svg = `<svg width="900" height="1260" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#111827"/><stop offset="55%" stop-color="#312e81"/><stop offset="100%" stop-color="#020617"/></linearGradient></defs>
    <rect width="900" height="1260" rx="42" fill="url(#bg)"/>
    <rect x="54" y="54" width="792" height="1152" rx="32" fill="none" stroke="#eab308" stroke-width="10"/>
    <text x="450" y="210" fill="#f8fafc" font-size="64" font-family="Arial" font-weight="700" text-anchor="middle">CARD</text>
    <text x="450" y="560" fill="#fde68a" font-size="82" font-family="Arial" font-weight="700" text-anchor="middle">${escapeSvg(card.name || "Unknown Card")}</text>
    <text x="450" y="680" fill="#dbeafe" font-size="48" font-family="Arial" text-anchor="middle">${escapeSvg(card.series || "General")}</text>
    <text x="450" y="930" fill="#f8fafc" font-size="72" font-family="Arial" font-weight="700" text-anchor="middle">${escapeSvg(card.tier || "T?")}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

function escapeSvg(value: string): string {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[ch]!));
}
