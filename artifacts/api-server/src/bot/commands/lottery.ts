import type { CommandContext } from "./index.js";
import { sendText } from "../connection.js";
import { ensureUser, extractNumberFromJid, getMentionName, getUser, updateUser } from "../db/queries.js";
import { col } from "../db/mongo.js";
import { mentionTag } from "../utils.js";
import sharp from "sharp";

const MAX_PARTICIPANTS = 15;
const AUTO_DRAW_WINNERS = 3;
const TICKET_PRICE = 5000;

export async function handleLottery(ctx: CommandContext): Promise<void> {
  const { from, sender, command: cmd } = ctx;
  const userId = extractNumberFromJid(sender);

  if (cmd === "lottery") {
    await ensureUser(sender);

    const freshUser = await getUser(userId);
    const invRow = await col("inventory").findOne({ user_id: userId, item: { $regex: /^lottery ticket$/i } });
    if (invRow?.quantity > 0) {
      await col("users").updateOne({ _id: userId as any }, { $inc: { lottery_tickets: invRow.quantity } });
      await col("inventory").deleteOne({ _id: invRow._id });
    }
    const updatedUser = await getUser(userId);
    const tickets = (updatedUser as any)?.lottery_tickets || 0;

    if (tickets <= 0) {
      await sendText(from, "🎫 *No Lottery Tickets!*\n\nYou don't have any lottery tickets.\n\nBuy a *Lottery Ticket* from *.shop* for $5,000, then type *.lottery* to enter!\n\n> Type *.ll* to see the current pool status.");
      return;
    }

    let lottery = await col("lotteries").findOne({ active: 1 }, { sort: { created_at: -1 } });
    if (!lottery) {
      const res = await col("lotteries").insertOne({ group_id: "global", pool: 0, active: 1, created_at: Math.floor(Date.now()/1000) });
      lottery = await col("lotteries").findOne({ _id: res.insertedId });
    }

    const existing = await col("lottery_entries").findOne({ lottery_id: lottery!._id, user_id: userId });
    if (existing) {
      await sendText(from, "🎰 *Already Entered!*\n\nYou are already in this drawing. Wait for the results!");
      const image = await buildLotteryImageSafe(String(lottery!._id));
      if (image) await ctx.sock.sendMessage(from, { image, caption: "🎲 *Lottery Pool Status — REQUIEM ORDER 反逆*" });
      return;
    }

    await updateUser(userId, { lottery_tickets: (updatedUser as any)?.lottery_tickets - 1 });
    await col("lottery_entries").insertOne({ lottery_id: lottery!._id, user_id: userId, amount: TICKET_PRICE, created_at: Math.floor(Date.now()/1000) });
    await col("lotteries").updateOne({ _id: lottery!._id }, { $inc: { pool: TICKET_PRICE } });

    const entryCount = await col("lottery_entries").countDocuments({ lottery_id: lottery!._id });

    await sendText(from,
      `🎉 *Lottery Entry Confirmed!*\n\nYou've entered the Global Lottery!\n\n` +
      `🎫 Remaining tickets: *${tickets - 1}*\n` +
      `👥 Participants: *${entryCount}/${MAX_PARTICIPANTS}*\n\n` +
      `_${MAX_PARTICIPANTS - entryCount} spot(s) left until the draw!_`
    );

    const image = await buildLotteryImageSafe(String(lottery!._id));
    if (image) await ctx.sock.sendMessage(from, { image, caption: "🎲 *Lottery Pool Status — REQUIEM ORDER 反逆*" });

    if (entryCount >= MAX_PARTICIPANTS) {
      await performLotteryDraw(ctx, String(lottery!._id), from);
    }
    return;
  }

  if (cmd === "ll") {
    await ensureUser(sender);
    const freshUser = await getUser(userId);
    const lottery = await col("lotteries").findOne({ active: 1 }, { sort: { created_at: -1 } });
    const entryCount = lottery ? await col("lottery_entries").countDocuments({ lottery_id: lottery._id }) : 0;
    const isInLottery = lottery ? !!(await col("lottery_entries").findOne({ lottery_id: lottery._id, user_id: userId })) : false;
    const tickets = (freshUser as any)?.lottery_tickets || 0;
    if (!lottery || entryCount === 0) {
      await sendText(from, `🎰 *Lottery Status — Requiem Order 反逆*\n\n🎫 Your tickets: *${tickets}*\n👥 Participants: *0/${MAX_PARTICIPANTS}*\n\nNo active lottery pool yet. Buy a ticket from *.shop* and type *.lottery* to enter!`);
      return;
    }
    const entries = await col("lottery_entries").aggregate([
      { $match: { lottery_id: lottery._id } },
      { $lookup: { from: "users", localField: "user_id", foreignField: "_id", as: "u" } },
      { $unwind: { path: "$u", preserveNullAndEmpty: true } },
      { $project: { user_id: 1, name: { $ifNull: ["$u.name", "$u._id"] } } },
      { $sort: { created_at: 1 } },
    ]).toArray();
    const participantOptions: string[] = (entries as any[]).slice(0, 12).map((e, i) => e.name || `Shadow ${i + 1}`);
    if (participantOptions.length < 2) participantOptions.push("⏳ Waiting for more players...");
    const poolTotal = lottery.pool ? `$${Number(lottery.pool).toLocaleString()}` : "$0";
    const yourStatus = isInLottery ? "✅ You are IN this drawing" : tickets > 0 ? `🎫 You have ${tickets} ticket(s) — type .lottery to enter!` : "🎫 No tickets — buy one from .shop";
    await ctx.sock.sendMessage(from, { poll: { name: `🎰 Lottery Pool • ${entryCount}/${MAX_PARTICIPANTS} entered • ${yourStatus} • Prize pool: ${poolTotal}`, values: participantOptions, selectableCount: 0 } });
    return;
  }

  if (cmd === "lp") {
    await ensureUser(sender);
    const freshUser2 = await getUser(userId);
    const lottery2 = await col("lotteries").findOne({ active: 1 }, { sort: { created_at: -1 } });
    const entryCount2 = lottery2 ? await col("lottery_entries").countDocuments({ lottery_id: lottery2._id }) : 0;
    const isInLottery2 = lottery2 ? !!(await col("lottery_entries").findOne({ lottery_id: lottery2._id, user_id: userId })) : false;
    const tickets2 = (freshUser2 as any)?.lottery_tickets || 0;
    if (!lottery2 || entryCount2 === 0) {
      await sendText(from, `🎰 *Lottery Status — Requiem Order 反逆*\n\n🎫 Your tickets: *${tickets2}*\n👥 Participants: *0/${MAX_PARTICIPANTS}*\n\nNo active lottery pool yet.`);
      return;
    }
    const entries2 = await col("lottery_entries").aggregate([
      { $match: { lottery_id: lottery2._id } },
      { $lookup: { from: "users", localField: "user_id", foreignField: "_id", as: "u" } },
      { $unwind: { path: "$u", preserveNullAndEmpty: true } },
      { $project: { user_id: 1, name: { $ifNull: ["$u.name", "$u._id"] } } },
      { $sort: { created_at: 1 } },
    ]).toArray();
    const participantOptions2: string[] = (entries2 as any[]).slice(0, 12).map((e, i) => (e as any).name || `Shadow ${i + 1}`);
    if (participantOptions2.length < 2) participantOptions2.push("⏳ Waiting for more players...");
    const poolTotal2 = lottery2.pool ? `$${Number(lottery2.pool).toLocaleString()}` : "$0";
    const yourStatus2 = isInLottery2 ? "✅ You are IN this drawing" : tickets2 > 0 ? `🎫 You have ${tickets2} ticket(s) — type .lottery to enter!` : "🎫 No tickets — buy one from .shop";
    await ctx.sock.sendMessage(from, { poll: { name: `🎰 Lottery Pool • ${entryCount2}/${MAX_PARTICIPANTS} entered • ${yourStatus2} • Prize pool: ${poolTotal2}`, values: participantOptions2, selectableCount: 0 } });
    return;
  }

  if (cmd === "drawlottery") {
    if (!ctx.isAdmin && !ctx.isOwner) { await sendText(from, "❌ Only admins can manually draw the lottery."); return; }
    const lottery = await col("lotteries").findOne({ active: 1 }, { sort: { created_at: -1 } });
    if (!lottery) { await sendText(from, "❌ No active lottery."); return; }
    const entries = await col("lottery_entries").find({ lottery_id: lottery._id }).toArray();
    if (entries.length === 0) { await sendText(from, "❌ No entries yet!"); return; }
    await performLotteryDraw(ctx, String(lottery._id), from);
    return;
  }
}

async function performLotteryDraw(ctx: CommandContext, lotteryId: string, from: string): Promise<void> {
  const { ObjectId } = await import("mongodb");
  let lotteryObjId: any;
  try { lotteryObjId = new ObjectId(lotteryId); } catch { lotteryObjId = lotteryId; }
  const entries = await col("lottery_entries").find({ lottery_id: lotteryObjId }).toArray();
  if (entries.length === 0) return;

  const shuffled = [...entries].sort(() => Math.random() - 0.5);
  const winners = shuffled.slice(0, Math.min(AUTO_DRAW_WINNERS, entries.length));

  const poolRow = await col("lottery_entries").aggregate([
    { $match: { lottery_id: lotteryObjId } },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]).toArray();
  const totalPool = (poolRow[0] as any)?.total || entries.length * TICKET_PRICE;
  const perWinner = Math.floor(totalPool / winners.length);

  const winnerMentions: string[] = [];
  const winnerLines: string[] = [];
  const medals = ["🥇","🥈","🥉"];

  for (let i = 0; i < winners.length; i++) {
    const w = winners[i] as any;
    const winnerUser = await getUser(w.user_id);
    if (winnerUser) {
      await updateUser(w.user_id, { balance: ((winnerUser as any).balance || 0) + perWinner });
    }
    const winnerJid = `${w.user_id}@s.whatsapp.net`;
    winnerMentions.push(winnerJid);
    winnerLines.push(`${medals[i] || "🏅"} ${mentionTag(winnerJid)}`);
  }

  await col("lotteries").updateOne(
    { _id: lotteryObjId },
    { $set: { active: 0, winner_id: (winners[0] as any).user_id, ended_at: Math.floor(Date.now()/1000) } }
  );

  const announcement =
    `🎰 *LOTTERY DRAW — REQUIEM ORDER 反逆* 🎰\n\nThe heavens have chosen!\n\n` +
    `🏆 *Winners:*\n${winnerLines.join("\n")}\n\n` +
    `💰 *Prize per winner:* $${perWinner.toLocaleString()}\n` +
    `💎 *Total pool:* $${totalPool.toLocaleString()}\n\n` +
    `_A new lottery pool begins now. Buy tickets from *.shop*!_`;

  await ctx.sock.sendMessage(from, { text: announcement, mentions: winnerMentions });
}

async function buildLotteryImageSafe(lotteryId: string): Promise<Buffer | null> {
  try { return await buildLotteryImage(lotteryId); } catch { return null; }
}

async function buildLotteryImage(lotteryId: string): Promise<Buffer> {
  const { ObjectId } = await import("mongodb");
  let lotteryObjId: any;
  try { lotteryObjId = new ObjectId(lotteryId); } catch { lotteryObjId = lotteryId; }
  const entries = await col("lottery_entries").aggregate([
    { $match: { lottery_id: lotteryObjId } },
    { $lookup: { from: "users", localField: "user_id", foreignField: "_id", as: "u" } },
    { $unwind: { path: "$u", preserveNullAndEmpty: true } },
    { $project: { user_id: 1, name: { $ifNull: ["$u.name", "$u._id"] } } },
    { $sort: { created_at: 1 } },
  ]).toArray();
  const participantCount = entries.length;
  const W = 800, H = 460, barTrackW = 600;
  const participantPct = Math.min(participantCount / MAX_PARTICIPANTS, 1);
  const partBarW = Math.max(8, Math.round(barTrackW * participantPct));
  const nameList = entries.slice(0, 5).map((e: any, i) => e.name || `Shadow ${i + 1}`);
  const extraCount = participantCount > 5 ? participantCount - 5 : 0;
  const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;","'":"&apos;"}[c] || c));
  const namesSvg = nameList.map((name: string, i: number) => `<text x="100" y="${310 + i * 22}" fill="rgba(255,255,255,0.65)" font-size="14" font-family="Arial, sans-serif">• ${esc(name)}</text>`).join("");
  const extraText = extraCount > 0 ? `<text x="100" y="${310 + nameList.length * 22}" fill="rgba(255,255,255,0.45)" font-size="13" font-family="Arial, sans-serif">...and ${extraCount} more</text>` : "";
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bgGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0a0f"/><stop offset="100%" stop-color="#1a0a2e"/></linearGradient>
      <linearGradient id="reqBar" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#7c3aed"/><stop offset="100%" stop-color="#a855f7"/></linearGradient>
      <linearGradient id="partBar" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#d97706"/><stop offset="100%" stop-color="#f59e0b"/></linearGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#bgGrad)" rx="16"/>
    <rect width="${W}" height="4" fill="#7c3aed" rx="2"/>
    <text x="50%" y="52" text-anchor="middle" fill="rgba(255,255,255,0.5)" font-size="13" font-family="Arial, sans-serif" font-weight="bold" letter-spacing="4">REQUIEM ORDER 反逆</text>
    <text x="50%" y="90" text-anchor="middle" fill="white" font-size="26" font-family="Georgia, serif" font-weight="bold" letter-spacing="2">Lottery Pool</text>
    <line x1="50" y1="110" x2="${W-50}" y2="110" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
    <text x="100" y="150" fill="rgba(255,255,255,0.9)" font-size="15" font-family="Arial, sans-serif" font-weight="bold">Required</text>
    <text x="${W-100}" y="150" text-anchor="end" fill="#a855f7" font-size="15" font-family="Arial, sans-serif" font-weight="bold">${MAX_PARTICIPANTS}</text>
    <rect x="100" y="158" width="${barTrackW}" height="30" rx="6" fill="rgba(255,255,255,0.06)"/>
    <rect x="100" y="158" width="${barTrackW}" height="30" rx="6" fill="url(#reqBar)"/>
    <text x="${100 + barTrackW / 2}" y="178" text-anchor="middle" fill="white" font-size="13" font-family="Arial, sans-serif" font-weight="bold">${MAX_PARTICIPANTS} spots</text>
    <text x="100" y="225" fill="rgba(255,255,255,0.9)" font-size="15" font-family="Arial, sans-serif" font-weight="bold">Participants</text>
    <text x="${W-100}" y="225" text-anchor="end" fill="#f59e0b" font-size="15" font-family="Arial, sans-serif" font-weight="bold">${participantCount}</text>
    <rect x="100" y="233" width="${barTrackW}" height="30" rx="6" fill="rgba(255,255,255,0.06)"/>
    <rect x="100" y="233" width="${partBarW}" height="30" rx="6" fill="url(#partBar)"/>
    <text x="${100 + Math.max(partBarW/2,40)}" y="253" text-anchor="middle" fill="white" font-size="13" font-family="Arial, sans-serif" font-weight="bold">${participantCount}/${MAX_PARTICIPANTS}</text>
    <line x1="50" y1="290" x2="${W-50}" y2="290" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
    ${participantCount > 0 ? `<text x="100" y="308" fill="rgba(255,255,255,0.4)" font-size="12" font-family="Arial, sans-serif" letter-spacing="2">ENTERED:</text>${namesSvg}${extraText}` : `<text x="50%" y="330" text-anchor="middle" fill="rgba(255,255,255,0.3)" font-size="14" font-family="Arial, sans-serif">No participants yet. Type .lottery to enter!</text>`}
    <rect x="0" y="${H-44}" width="${W}" height="44" fill="rgba(0,0,0,0.3)" rx="16"/>
    <text x="50%" y="${H-18}" text-anchor="middle" fill="rgba(255,255,255,0.35)" font-size="12" font-family="Arial, sans-serif">3 winners drawn automatically • .lottery to enter • .ll to check status</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
