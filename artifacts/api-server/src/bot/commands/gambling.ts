import type { CommandContext } from "./index.js";
import { sendText } from "../connection.js";
import { getUser, ensureUser, updateUser, getRpg } from "../db/queries.js";
import { formatNumber, coinFlip, rollDice, spin, checkSlotWin, getRouletteColor } from "../utils.js";
import type { WASocket } from "@whiskeysockets/baileys";

// ── Horse configuration — true RNG odds ──────────────────────────────────────
const HORSES = [
  { name: "Thunder", emoji: "🐎", odds: 1.8,  winProb: 0.30, maxAdv: 5, minAdv: 2 },
  { name: "Storm",   emoji: "🏇", odds: 2.5,  winProb: 0.22, maxAdv: 4, minAdv: 2 },
  { name: "Eclipse", emoji: "🦄", odds: 3.5,  winProb: 0.18, maxAdv: 4, minAdv: 1 },
  { name: "Shadow",  emoji: "🐴", odds: 5.0,  winProb: 0.14, maxAdv: 3, minAdv: 1 },
  { name: "Blaze",   emoji: "🌪️", odds: 7.0,  winProb: 0.10, maxAdv: 3, minAdv: 1 },
  { name: "Phantom", emoji: "👻", odds: 12.0, winProb: 0.06, maxAdv: 2, minAdv: 1 },
] as const;
const TRACK_LEN = 12;
const TICKS = 15;

export async function handleGambling(ctx: CommandContext): Promise<void> {
  const { from, sender, args, command: cmd, sock } = ctx;
  const user = await ensureUser(sender);
  const limit = await checkGamblingAccess(from, sender, user, cmd);
  if (!limit.allowed) return;

  if (cmd === "slots") {
    const amount = parseAmount(args[0], user.balance);
    if (!(await checkBet(from, user, amount))) return;
    const result = spin();
    const multiplier = checkSlotWin(result);
    const slots = result.split(" | ");
    const SYMBOLS = ["🍒","🍋","🍊","🍇","⭐","💎","7️⃣"];
    const randSym = () => SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];

    const spinningMsg = await sock.sendMessage(from, { text: `🎰 *SPINNING...*\n\n⟦ 🎰 ⟧  ⟦ 🎰 ⟧  ⟦ 🎰 ⟧` });
    for (let i = 0; i < 8; i++) {
      await sleep(300);
      if (spinningMsg?.key) {
        await sock.sendMessage(from, {
          text: `🎰 *SPINNING...*\n\n${[randSym(), randSym(), randSym()].map((s) => `⟦ ${s} ⟧`).join("  ")}`,
          edit: spinningMsg.key,
        });
      }
    }

    const resultRow = slots.map((s) => `⟦ ${s} ⟧`).join("  ");
    const reelRow = () => [randSym(), randSym(), randSym()].map((s) => `⟦ ${s} ⟧`).join("  ");
    let winnings = 0;
    let outcome = "";
    if (multiplier === 3) { winnings = amount * 3; outcome = `🎉 JACKPOT! +$${formatNumber(winnings)} (3x)`; }
    else if (multiplier === 2) { winnings = amount * 2; outcome = `✨ Double Win! +$${formatNumber(winnings)} (2x)`; }
    else { winnings = -amount; outcome = `😭 No match. -$${formatNumber(amount)}`; }
    await updateUser(sender, gambleUpdate(limit, { balance: (user.balance || 0) + winnings }));
    const msg =
      `╭─❰ 🎰 𝐒𝐋𝐎𝐓 𝐌𝐀𝐂𝐇𝐈𝐍𝐄 ❱─╮\n│\n│  ${reelRow()}\n│  ${reelRow()}\n│━━━━━━━━━━━━━━━━━━━━━\n│▶ ${resultRow} ◀\n│━━━━━━━━━━━━━━━━━━━━━\n│  ${reelRow()}\n│  ${reelRow()}\n│\n│  🎲 ʙᴇᴛ: $${formatNumber(amount)}\n│  ✨ ᴏᴜᴛᴄᴏᴍᴇ: ${outcome}\n│  💰 ʙᴀʟᴀɴᴄᴇ: $${formatNumber((user.balance || 0) + winnings)}\n╰──────────────────────╯`;
    if (spinningMsg?.key) {
      await sock.sendMessage(from, { text: msg, edit: spinningMsg.key });
    } else {
      await sendText(from, msg);
    }
    return;
  }

  if (cmd === "dice") {
    const amount = parseAmount(args[0], user.balance);
    if (!(await checkBet(from, user, amount))) return;
    const roll = rollDice();
    const win = roll >= 4;
    const winnings = win ? amount : -amount;
    await updateUser(sender, gambleUpdate(limit, { balance: (user.balance || 0) + winnings }));
    await sendText(from,
      `🎲 Rolled: *${roll}* ${["⚀","⚁","⚂","⚃","⚄","⚅"][roll-1]}\n` +
      `${win ? `🎉 Win! +$${formatNumber(amount)}` : `😭 Lose. -$${formatNumber(amount)}`}\n` +
      `Balance: $${formatNumber((user.balance || 0) + winnings)}`
    );
    return;
  }

  if (cmd === "coinflip" || cmd === "cf") {
    const choice = args[0]?.toLowerCase();
    const amount = parseAmount(args[1] || args[0], user.balance);
    if (!choice || !["h","t","heads","tails"].includes(choice)) { await sendText(from, "❌ Usage: .cf [h/t] [amount]"); return; }
    if (!(await checkBet(from, user, amount))) return;
    const result = coinFlip();
    const userPick = choice === "h" || choice === "heads" ? "heads" : "tails";
    const win = userPick === result;
    const winnings = win ? amount : -amount;
    await updateUser(sender, gambleUpdate(limit, { balance: (user.balance || 0) + winnings }));
    await sendText(from,
      `🪙 Coin flip result: *${result === "heads" ? "Heads" : "Tails"}*!\n` +
      (win ? `You won $${formatNumber(amount)}` : `You lost $${formatNumber(amount)}`) +
      `\nBalance: $${formatNumber((user.balance || 0) + winnings)}`
    );
    return;
  }

  if (cmd === "casino") {
    const amount = parseAmount(args[0], user.balance);
    if (!(await checkBet(from, user, amount))) return;
    const win = Math.random() < 0.45;
    const winnings = win ? amount : -amount;
    await updateUser(sender, gambleUpdate(limit, { balance: (user.balance || 0) + winnings }));
    await sendText(from,
      `Outcome: ${win ? "Win" : "Lose"}! 💰You won ${win ? `$${formatNumber(amount * 2)} coins.` : `nothing.`}\nBalance: $${formatNumber((user.balance || 0) + winnings)}`
    );
    return;
  }

  if (cmd === "doublebet" || cmd === "db") {
    const amount = parseAmount(args[0], user.balance);
    if (!(await checkBet(from, user, amount))) return;
    const win = Math.random() < 0.45;
    const winnings = win ? amount : -amount;
    await updateUser(sender, gambleUpdate(limit, { balance: (user.balance || 0) + winnings }));
    await sendText(from,
      `╭─❰ 🎲 ᴅᴏᴜʙʟᴇ ʙᴇᴛ ❱─╮\n│\n│  🎰 Result: ${win ? "🎯 𝗪𝗜𝗡" : "💀 𝗟𝗢𝗦𝗘"}\n│  💰 Amount: $${formatNumber(amount)}\n│  ✨ Outcome: ${win ? `+$${formatNumber(amount * 2)}` : `-$${formatNumber(amount)}`}\n│  🏦 Balance: $${formatNumber((user.balance || 0) + winnings)}\n╰──────────────╯`
    );
    return;
  }

  if (cmd === "doublepayout" || cmd === "dp") {
    const amount = parseAmount(args[0], user.balance);
    if (!(await checkBet(from, user, amount))) return;
    const win = Math.random() < 0.4;
    const payout = win ? amount * 3 : -amount;
    await updateUser(sender, gambleUpdate(limit, { balance: (user.balance || 0) + payout }));
    await sendText(from, win ? `🎰 Triple payout! +$${formatNumber(amount * 3)}` : `😭 Lost. -$${formatNumber(amount)}`);
    return;
  }

  if (cmd === "roulette") {
    const color = args[0]?.toLowerCase();
    const amount = parseAmount(args[1], user.balance);
    if (!["red","black","green"].includes(color)) { await sendText(from, "❌ Usage: .roulette [red/black/green] [amount]"); return; }
    if (!(await checkBet(from, user, amount))) return;
    const num = Math.floor(Math.random() * 37);
    const result = getRouletteColor(num);
    const win = result === color;
    const multiplier = color === "green" ? 14 : 2;
    const winnings = win ? amount * multiplier : -amount;
    await updateUser(sender, gambleUpdate(limit, { balance: (user.balance || 0) + winnings }));
    await sendText(from,
      `🎡 Ball landed on *${num}* (${result})\n` +
      `${win ? `🎉 You picked ${color} — win! +$${formatNumber(amount * multiplier)}` : `😭 You picked ${color} — lose. -$${formatNumber(amount)}`}\n` +
      `Balance: $${formatNumber((user.balance || 0) + winnings)}`
    );
    return;
  }

  // ── Horse Racing — real-time animated, proper RNG odds ────────────────────
  if (cmd === "horse") {
    // Parse args: .horse <name|number> <amount>
    if (!args[0]) {
      const list = HORSES.map((h, i) => `${i+1}. ${h.emoji} ${h.name.padEnd(8)} odds: ${h.odds}x`).join("\n");
      await sendText(from,
        `🏇 *HORSE RACING*\n\n` +
        `Pick a horse and bet!\nUsage: *.horse <name or number> <amount>*\n\nExample: *.horse Thunder 500*\n\n` +
        list + `\n\n_Higher odds = bigger payout = less likely to win_`
      );
      return;
    }

    // Resolve horse pick (by name or number)
    const raw = args[0].toLowerCase();
    let horseIdx = -1;
    const byNum = parseInt(raw);
    if (!isNaN(byNum) && byNum >= 1 && byNum <= HORSES.length) {
      horseIdx = byNum - 1;
    } else {
      horseIdx = HORSES.findIndex(h => h.name.toLowerCase() === raw || h.name.toLowerCase().startsWith(raw));
    }
    if (horseIdx < 0) {
      await sendText(from, `❌ Unknown horse. Choose: ${HORSES.map((h,i)=>`${i+1}.${h.name}`).join(", ")}`);
      return;
    }

    const amount = parseAmount(args[1] || args[0], user.balance);
    if (isNaN(amount) || amount < 50) { await sendText(from, "❌ Minimum bet is $50."); return; }
    if (!(await checkBet(from, user, amount))) return;

    const pick = HORSES[horseIdx];

    // Apply Luck bonus from RPG (if user has an RPG character)
    const rpgChar = await getRpg(sender.split("@")[0].split(":")[0]);
    const luckBonus = rpgChar ? rpgChar.luck * 0.003 : 0; // +0.3% win probability per LCK point

    // Select winner via weighted RNG (odds-based), with Luck nudging the player's horse
    const winnerIdx = selectHorseWinner(horseIdx, luckBonus);
    const winner = HORSES[winnerIdx];

    // ── Animate race ───────────────────────────────────────────────────────
    const pos = [0, 0, 0, 0, 0, 0];

    const raceMsg = await sock.sendMessage(from, {
      text: buildHorseFrame(pos, horseIdx, -1, pick.odds, amount),
    });

    for (let tick = 0; tick < TICKS; tick++) {
      await sleep(700);
      for (let i = 0; i < HORSES.length; i++) {
        const h = HORSES[i];
        let adv = h.minAdv + Math.floor(Math.random() * (h.maxAdv - h.minAdv + 1));
        // In final 4 ticks give winner a consistent small boost
        if (tick >= TICKS - 4 && i === winnerIdx) adv += 1;
        pos[i] = Math.min(TRACK_LEN, pos[i] + adv);
      }
      if (raceMsg?.key) {
        await sock.sendMessage(from, {
          text: buildHorseFrame(pos, horseIdx, -1, pick.odds, amount),
          edit: raceMsg.key,
        });
      }
    }
    // Guarantee winner finishes
    pos[winnerIdx] = TRACK_LEN;

    const win = winnerIdx === horseIdx;
    const winnings = win ? Math.floor(amount * pick.odds) - amount : -amount;
    const newBalance = (user.balance || 0) + winnings;
    await updateUser(sender, gambleUpdate(limit, { balance: newBalance }));

    const finalFrame = buildHorseFrame(pos, horseIdx, winnerIdx, pick.odds, amount);
    const finalMsg =
      finalFrame +
      `\n\n🏆 *${winner.emoji} ${winner.name}* crosses the finish line!` +
      `\n\n${win
        ? `🎉 *You won!* +$${formatNumber(Math.floor(amount * pick.odds))} (${pick.odds}x)`
        : `😭 *${pick.emoji} ${pick.name}* didn't make it. -$${formatNumber(amount)}`}` +
      `\n💰 Balance: $${formatNumber(newBalance)}`;

    if (raceMsg?.key) {
      await sock.sendMessage(from, { text: finalMsg, edit: raceMsg.key });
    } else {
      await sendText(from, finalMsg);
    }
    return;
  }

  if (cmd === "spin") {
    const amount = parseAmount(args[0], user.balance);
    if (!(await checkBet(from, user, amount))) return;
    const outcomes = [
      { label: "💰 2x", multi: 2, chance: 0.2 },
      { label: "💸 1.5x", multi: 1.5, chance: 0.25 },
      { label: "❌ 0x", multi: 0, chance: 0.35 },
      { label: "💥 3x", multi: 3, chance: 0.1 },
      { label: "☠️ -0.5x", multi: -0.5, chance: 0.1 },
    ];
    let rand = Math.random();
    let outcome = outcomes[outcomes.length - 1];
    for (const o of outcomes) { if (rand < o.chance) { outcome = o; break; } rand -= o.chance; }
    const won = Math.floor(amount * outcome.multi);
    const diff = won - amount;
    await updateUser(sender, gambleUpdate(limit, { balance: (user.balance || 0) + diff }));
    await sendText(from,
      `🌀 Spin result: *${outcome.label}*\n${diff >= 0 ? `+$${formatNumber(diff)}` : `-$${formatNumber(-diff)}`}\nBalance: $${formatNumber((user.balance || 0) + diff)}`
    );
    return;
  }
}

// ── Horse winner selection (RNG with odds + luck bonus) ──────────────────────
function selectHorseWinner(playerPick: number, luckBonus: number): number {
  const probs = HORSES.map((h, i) => {
    let p = h.winProb;
    if (i === playerPick) p = Math.min(p + luckBonus, p * 1.3);
    return p;
  });
  const total = probs.reduce((a, b) => a + b, 0);
  let rand = Math.random() * total;
  for (let i = 0; i < probs.length; i++) {
    rand -= probs[i];
    if (rand <= 0) return i;
  }
  return HORSES.length - 1;
}

// ── Race frame renderer ───────────────────────────────────────────────────────
function buildHorseFrame(pos: number[], pick: number, winner: number, odds: number, amount: number): string {
  const lines = pos.map((p, i) => {
    const h = HORSES[i];
    const filled = "─".repeat(p);
    const empty = "─".repeat(Math.max(0, TRACK_LEN - p));
    const track = `${filled}${h.emoji}${empty}`;
    const myTag = i === pick ? "◀" : "";
    const winTag = winner >= 0 && i === winner ? "🏆" : "";
    return `${(i + 1)}.${h.name.slice(0,6).padEnd(6)}|${track}|${myTag}${winTag}`;
  });
  const header = `🏇 *HORSE RACE*\nPick:${HORSES[pick].emoji}${HORSES[pick].name}(${odds}x) $${formatNumber(amount)}\n\n`;
  return header + lines.join("\n");
}

// ── Utilities ────────────────────────────────────────────────────────────────
function parseAmount(raw: string | undefined, balance: number): number {
  if (!raw) return 100;
  if (raw === "all" || raw === "max") return Math.min(balance, 100000);
  if (raw === "half") return Math.floor(balance / 2);
  const n = parseInt(raw.replace(/,/g, ""));
  return isNaN(n) ? 100 : n;
}

async function checkBet(from: string, user: any, amount: number): Promise<boolean> {
  if (amount < 50) { await sendText(from, "❌ Minimum bet is $50."); return false; }
  if ((user.balance || 0) < amount) { await sendText(from, `❌ Not enough coins. Balance: $${formatNumber(user.balance || 0)}`); return false; }
  return true;
}

async function checkGamblingAccess(from: string, sender: string, user: any, cmd: string): Promise<any> {
  const label = resolveLabel(cmd);
  const day = new Date().toISOString().split("T")[0];
  const field = `gamble_${label}_date`;
  const countField = `gamble_${label}_count`;
  const DAILY_LIMIT = 20;

  const count = user[field] === day ? (user[countField] || 0) : 0;
  if (count >= DAILY_LIMIT) {
    await sendText(from, `🎲 Daily ${label} limit reached (${DAILY_LIMIT}/day). Come back tomorrow!`);
    return { allowed: false };
  }
  return { allowed: true, now: day, day, count, field: countField, dateField: field, label };
}

function gambleUpdate(limit: any, extra: Record<string, any>): Record<string, any> {
  if (!limit?.field) return extra;
  return { ...extra, [limit.field]: (limit.count || 0) + 1, [limit.dateField]: limit.day, last_gamble: Date.now() };
}

function resolveLabel(cmd: string): string {
  if (cmd === "cf") return "coinflip";
  if (cmd === "db") return "doublebet";
  if (cmd === "dp") return "doublepayout";
  return cmd;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
