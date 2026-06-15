import type { CommandContext } from "./index.js";
import { sendText } from "../connection.js";
import { ensureUser, extractNumberFromJid, getMentionName } from "../db/queries.js";
import { getDb } from "../db/database.js";
import sharp from "sharp";

const MAX_PARTICIPANTS = 15;
const AUTO_DRAW_WINNERS = 3;
const TICKET_PRICE = 5000;

export async function handleLottery(ctx: CommandContext): Promise<void> {
  const { from, sender, command: cmd } = ctx;
  const userId = extractNumberFromJid(sender);
  const db = getDb();

  // ── .lottery — enter the pool ──────────────────────────────────────────────
  if (cmd === "lottery") {
    ensureUser(sender);

    // Migrate any inventory-based tickets into the column (web purchases land here)
    const invRow = db.prepare(
      "SELECT quantity FROM inventory WHERE user_id = ? AND LOWER(item) = 'lottery ticket'"
    ).get(userId) as any;
    if (invRow?.quantity > 0) {
      db.prepare(
        "UPDATE users SET lottery_tickets = COALESCE(lottery_tickets, 0) + ? WHERE id = ?"
      ).run(invRow.quantity, userId);
      db.prepare(
        "DELETE FROM inventory WHERE user_id = ? AND LOWER(item) = 'lottery ticket'"
      ).run(userId);
    }

    const freshUser = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as any;
    const tickets = freshUser?.lottery_tickets || 0;

    if (tickets <= 0) {
      await sendText(
        from,
        "🎫 *No Lottery Tickets!*\n\nYou don't have any lottery tickets.\n\nBuy a *Lottery Ticket* from *.shop* for $5,000, then type *.lottery* to enter!\n\n> Type *.ll* to see the current pool status."
      );
      return;
    }

    // Get or create the active global lottery
    let lottery = db.prepare(
      "SELECT * FROM lotteries WHERE active = 1 ORDER BY created_at DESC LIMIT 1"
    ).get() as any;
    if (!lottery) {
      const result = db.prepare(
        "INSERT INTO lotteries (group_id, pool) VALUES (?, 0)"
      ).run("global");
      lottery = db.prepare("SELECT * FROM lotteries WHERE id = ?").get(result.lastInsertRowid) as any;
    }

    // Check if user already entered
    const existing = db.prepare(
      "SELECT * FROM lottery_entries WHERE lottery_id = ? AND user_id = ?"
    ).get(lottery.id, userId) as any;

    if (existing) {
      await sendText(from, "🎰 *Already Entered!*\n\nYou are already in this drawing. Wait for the results!");
      const image = await buildLotteryImageSafe(lottery.id);
      if (image) {
        await ctx.sock.sendMessage(from, { image, caption: "🎲 *Lottery Pool Status — REQUIEM ORDER 反逆*" });
      }
      return;
    }

    // Deduct 1 ticket, add entry, update pool
    // BUG FIX: lottery_entries.amount is NOT NULL — must be included in INSERT
    db.transaction(() => {
      db.prepare("UPDATE users SET lottery_tickets = lottery_tickets - 1 WHERE id = ?").run(userId);
      db.prepare(
        "INSERT INTO lottery_entries (lottery_id, user_id, amount) VALUES (?, ?, ?)"
      ).run(lottery.id, userId, TICKET_PRICE);
      db.prepare("UPDATE lotteries SET pool = pool + ? WHERE id = ?").run(TICKET_PRICE, lottery.id);
    })();

    const entryCount = (
      db.prepare("SELECT COUNT(*) as cnt FROM lottery_entries WHERE lottery_id = ?").get(lottery.id) as any
    )?.cnt || 0;

    await sendText(
      from,
      `🎉 *Lottery Entry Confirmed!*\n\n` +
      `You've entered the Global Lottery!\n\n` +
      `🎫 Remaining tickets: *${tickets - 1}*\n` +
      `👥 Participants: *${entryCount}/${MAX_PARTICIPANTS}*\n\n` +
      `_${MAX_PARTICIPANTS - entryCount} spot(s) left until the draw!_`
    );

    const image = await buildLotteryImageSafe(lottery.id);
    if (image) {
      await ctx.sock.sendMessage(from, { image, caption: "🎲 *Lottery Pool Status — REQUIEM ORDER 反逆*" });
    }

    // Auto-draw when full
    if (entryCount >= MAX_PARTICIPANTS) {
      await performLotteryDraw(ctx, lottery.id, from);
    }
    return;
  }

  // ── .ll — view current pool status ────────────────────────────────────────
  if (cmd === "ll") {
    ensureUser(sender);
    const freshUser = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as any;
    const lottery = db.prepare(
      "SELECT * FROM lotteries WHERE active = 1 ORDER BY created_at DESC LIMIT 1"
    ).get() as any;
    const entryCount = lottery
      ? ((db.prepare("SELECT COUNT(*) as cnt FROM lottery_entries WHERE lottery_id = ?").get(lottery.id) as any)?.cnt || 0)
      : 0;
    const isInLottery = lottery
      ? !!(db.prepare("SELECT 1 FROM lottery_entries WHERE lottery_id = ? AND user_id = ?").get(lottery.id, userId))
      : false;

    const tickets = freshUser?.lottery_tickets || 0;
    let statusLine = `🎫 Your tickets: *${tickets}*`;
    if (isInLottery) statusLine += "\n✅ You are *in* this drawing";
    else if (tickets > 0) statusLine += "\n💡 Type *.lottery* to enter!";

    await sendText(
      from,
      `🎰 *Lottery Status — Requiem Order 反逆*\n\n${statusLine}\n👥 Participants: *${entryCount}/${MAX_PARTICIPANTS}*`
    );

    if (!lottery || entryCount === 0) {
      await sendText(from, "No active lottery pool yet. Buy a ticket from *.shop* and type *.lottery* to enter!");
      return;
    }

    const image = await buildLotteryImageSafe(lottery.id);
    if (image) {
      await ctx.sock.sendMessage(from, { image, caption: "🎲 *Lottery Pool Status — REQUIEM ORDER 反逆*" });
    }
    return;
  }

  // ── .lp — legacy alias for .ll ────────────────────────────────────────────
  if (cmd === "lp") {
    const lottery = db.prepare(
      "SELECT * FROM lotteries WHERE active = 1 ORDER BY created_at DESC LIMIT 1"
    ).get() as any;
    if (!lottery) {
      await sendText(from, "🎰 No active lottery. Buy a ticket from the shop and type *.lottery* to enter!");
      return;
    }
    const entries = (
      db.prepare("SELECT COUNT(*) as count FROM lottery_entries WHERE lottery_id = ?").get(lottery.id) as any
    )?.count || 0;
    await sendText(
      from,
      `🎰 *Requiem Order 反逆 Lottery*\n\n👥 Participants: ${entries}/${MAX_PARTICIPANTS}\n🏆 Winners drawn when ${MAX_PARTICIPANTS} enter`
    );
    const image = await buildLotteryImageSafe(lottery.id);
    if (image) {
      await ctx.sock.sendMessage(from, { image, caption: "🎲 Lottery Pool Status" });
    }
    return;
  }

  // ── .drawlottery — admin manual draw ──────────────────────────────────────
  if (cmd === "drawlottery") {
    if (!ctx.isAdmin && !ctx.isOwner) {
      await sendText(from, "❌ Only admins can manually draw the lottery.");
      return;
    }
    const lottery = db.prepare(
      "SELECT * FROM lotteries WHERE active = 1 ORDER BY created_at DESC LIMIT 1"
    ).get() as any;
    if (!lottery) { await sendText(from, "❌ No active lottery."); return; }
    const entries = db.prepare("SELECT * FROM lottery_entries WHERE lottery_id = ?").all(lottery.id) as any[];
    if (entries.length === 0) { await sendText(from, "❌ No entries yet!"); return; }
    await performLotteryDraw(ctx, lottery.id, from);
    return;
  }
}

async function performLotteryDraw(
  ctx: CommandContext,
  lotteryId: number,
  from: string
): Promise<void> {
  const db = getDb();
  const entries = db.prepare(
    "SELECT * FROM lottery_entries WHERE lottery_id = ?"
  ).all(lotteryId) as any[];
  if (entries.length === 0) return;

  // Pick up to AUTO_DRAW_WINNERS unique random winners
  const shuffled = [...entries].sort(() => Math.random() - 0.5);
  const winners = shuffled.slice(0, Math.min(AUTO_DRAW_WINNERS, entries.length));

  // BUG FIX: Use the real pool total (sum of actual entry amounts) not a synthetic calculation
  const poolRow = db.prepare(
    "SELECT COALESCE(SUM(amount), 0) as total FROM lottery_entries WHERE lottery_id = ?"
  ).get(lotteryId) as any;
  const totalPool = poolRow?.total || entries.length * TICKET_PRICE;
  const perWinner = Math.floor(totalPool / winners.length);

  // BUG FIX: track mention JIDs and display names separately
  const winnerMentions: string[] = [];
  const winnerLines: string[] = [];
  const medals = ["🥇", "🥈", "🥉"];

  for (let i = 0; i < winners.length; i++) {
    const w = winners[i];
    const winnerUser = db.prepare("SELECT * FROM users WHERE id = ?").get(w.user_id) as any;
    if (winnerUser) {
      db.prepare("UPDATE users SET balance = balance + ? WHERE id = ?").run(perWinner, w.user_id);
    }
    // BUG FIX: push full JID for WhatsApp mention — bare phone numbers are not valid mention targets
    const winnerJid = `${w.user_id}@s.whatsapp.net`;
    winnerMentions.push(winnerJid);
    // BUG FIX: use getMentionName to show human-readable name instead of raw phone
    winnerLines.push(`${medals[i] || "🏅"} @${getMentionName(winnerJid)}`);
  }

  // Close lottery
  db.prepare(
    "UPDATE lotteries SET active = 0, winner_id = ?, ended_at = unixepoch() WHERE id = ?"
  ).run(winners[0].user_id, lotteryId);

  const announcement =
    `🎰 *LOTTERY DRAW — REQUIEM ORDER 反逆* 🎰\n\n` +
    `The heavens have chosen!\n\n` +
    `🏆 *Winners:*\n` +
    winnerLines.join("\n") +
    `\n\n💰 *Prize per winner:* $${perWinner.toLocaleString()}\n` +
    `💎 *Total pool:* $${totalPool.toLocaleString()}\n\n` +
    `_A new lottery pool begins now. Buy tickets from *.shop*!_`;

  await ctx.sock.sendMessage(from, {
    text: announcement,
    mentions: winnerMentions,
  });
}

// BUG FIX: Wrapped in try/catch so one image failure never crashes the command
async function buildLotteryImageSafe(lotteryId: number): Promise<Buffer | null> {
  try {
    return await buildLotteryImage(lotteryId);
  } catch (err) {
    return null;
  }
}

async function buildLotteryImage(lotteryId: number): Promise<Buffer> {
  const db = getDb();
  const entries = db.prepare(
    `SELECT le.user_id, u.name
     FROM lottery_entries le
     LEFT JOIN users u ON u.id = le.user_id
     WHERE le.lottery_id = ?
     ORDER BY le.created_at ASC`
  ).all(lotteryId) as any[];
  const participantCount = entries.length;

  const W = 800;
  const H = 460;
  const barTrackW = 600;
  const participantPct = Math.min(participantCount / MAX_PARTICIPANTS, 1);
  const reqBarW = barTrackW;
  const partBarW = Math.max(8, Math.round(barTrackW * participantPct));

  const nameList = entries.slice(0, 5).map(
    (e: any, i: number) => e.name || `Shadow ${i + 1}`
  );
  const extraCount = participantCount > 5 ? participantCount - 5 : 0;

  // Safely escape SVG text
  const esc = (s: string) =>
    s.replace(/[<>&"']/g, (c) =>
      ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c] || c)
    );

  const namesSvg = nameList
    .map((name: string, i: number) => {
      const y = 310 + i * 22;
      return `<text x="100" y="${y}" fill="rgba(255,255,255,0.65)" font-size="14" font-family="Arial, sans-serif">• ${esc(name)}</text>`;
    })
    .join("");

  const extraText =
    extraCount > 0
      ? `<text x="100" y="${310 + nameList.length * 22}" fill="rgba(255,255,255,0.45)" font-size="13" font-family="Arial, sans-serif">...and ${extraCount} more</text>`
      : "";

  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bgGrad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#0a0a0f"/>
        <stop offset="100%" stop-color="#1a0a2e"/>
      </linearGradient>
      <linearGradient id="reqBar" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#7c3aed"/>
        <stop offset="100%" stop-color="#a855f7"/>
      </linearGradient>
      <linearGradient id="partBar" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#d97706"/>
        <stop offset="100%" stop-color="#f59e0b"/>
      </linearGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#bgGrad)" rx="16"/>
    <rect width="${W}" height="4" fill="#7c3aed" rx="2"/>
    <circle cx="720" cy="80" r="120" fill="rgba(168,85,247,0.06)"/>
    <circle cx="80" cy="380" r="80" fill="rgba(245,158,11,0.05)"/>
    <text x="50%" y="52" text-anchor="middle" fill="rgba(255,255,255,0.5)" font-size="13" font-family="Arial, sans-serif" font-weight="bold" letter-spacing="4">REQUIEM ORDER 反逆</text>
    <text x="50%" y="90" text-anchor="middle" fill="white" font-size="26" font-family="Georgia, serif" font-weight="bold" letter-spacing="2">Lottery Pool</text>
    <line x1="50" y1="110" x2="${W - 50}" y2="110" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
    <text x="100" y="150" fill="rgba(255,255,255,0.9)" font-size="15" font-family="Arial, sans-serif" font-weight="bold">Required</text>
    <text x="${W - 100}" y="150" text-anchor="end" fill="#a855f7" font-size="15" font-family="Arial, sans-serif" font-weight="bold">${MAX_PARTICIPANTS}</text>
    <rect x="100" y="158" width="${barTrackW}" height="30" rx="6" fill="rgba(255,255,255,0.06)"/>
    <rect x="100" y="158" width="${reqBarW}" height="30" rx="6" fill="url(#reqBar)"/>
    <text x="${100 + reqBarW / 2}" y="178" text-anchor="middle" fill="white" font-size="13" font-family="Arial, sans-serif" font-weight="bold">${MAX_PARTICIPANTS} spots</text>
    <text x="100" y="225" fill="rgba(255,255,255,0.9)" font-size="15" font-family="Arial, sans-serif" font-weight="bold">Participants</text>
    <text x="${W - 100}" y="225" text-anchor="end" fill="#f59e0b" font-size="15" font-family="Arial, sans-serif" font-weight="bold">${participantCount}</text>
    <rect x="100" y="233" width="${barTrackW}" height="30" rx="6" fill="rgba(255,255,255,0.06)"/>
    <rect x="100" y="233" width="${partBarW}" height="30" rx="6" fill="url(#partBar)"/>
    <text x="${100 + Math.max(partBarW / 2, 40)}" y="253" text-anchor="middle" fill="white" font-size="13" font-family="Arial, sans-serif" font-weight="bold">${participantCount}/${MAX_PARTICIPANTS}</text>
    <line x1="50" y1="290" x2="${W - 50}" y2="290" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
    ${participantCount > 0
      ? `<text x="100" y="308" fill="rgba(255,255,255,0.4)" font-size="12" font-family="Arial, sans-serif" letter-spacing="2">ENTERED:</text>${namesSvg}${extraText}`
      : `<text x="50%" y="330" text-anchor="middle" fill="rgba(255,255,255,0.3)" font-size="14" font-family="Arial, sans-serif">No participants yet. Type .lottery to enter!</text>`
    }
    <rect x="0" y="${H - 44}" width="${W}" height="44" fill="rgba(0,0,0,0.3)" rx="16"/>
    <text x="50%" y="${H - 18}" text-anchor="middle" fill="rgba(255,255,255,0.35)" font-size="12" font-family="Arial, sans-serif">3 winners drawn automatically • .lottery to enter • .ll to check status</text>
  </svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}
