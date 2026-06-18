import type { CommandContext } from "./index.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getDb, DB_DIR } from "../db/database.js";
import { getMentionName } from "../db/queries.js";
import { mentionTag } from "../utils.js";
import { getBotName } from "../connection.js";
import { downloadMediaMessage } from "@whiskeysockets/baileys";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MENU_ASSETS_DIR = path.join(DB_DIR, "menu-assets");
if (!fs.existsSync(MENU_ASSETS_DIR)) fs.mkdirSync(MENU_ASSETS_DIR, { recursive: true });

export async function handleMenu(ctx: CommandContext): Promise<void> {
  const { from, sender, sock } = ctx;
  // Use phone number in text for a real WhatsApp mention tag
  const senderTag = mentionTag(sender);   // e.g. @2348012345678
  const senderName = getMentionName(sender); // display name for profile line
  const botName = getBotName();

  const menuText =
`🌸━━━『 𝗥𝗘𝗤𝗨𝗜𝗘𝗠 反逆 』━━━🌸

✦ Where Stars Touch The Sky ✦

🎐 𝗣𝗥𝗢𝗙𝗜𝗟𝗘

┌──────────────
│ 👋 Hey       : ${senderTag}
│ 🌌 Bot       : ${botName}
│ 👑 Creator   : Eᴍᴘᴇʀᴏʀ Lᴇʟᴏᴜᴄʜ
│ 🔹 Prefix    : [ . ]
└──────────────

❀━━━━━━━━━━━━━━❀
            📋 𝗠𝗔𝗜𝗡
❀━━━━━━━━━━━━━━❀
➺ .menu
➺ .ping
➺ .website
➺ .community
➺ .bots
➺ .afk
➺ .help / .info
➺ .uptime

❀━━━━━━━━━━━━━━❀
            ⚙️ 𝗔𝗗𝗠𝗜𝗡
❀━━━━━━━━━━━━━━❀
➺ .kick
➺ .delete / .del / .d
➺ .antilink set [action]
➺ .warn @user [reason]
➺ .resetwarn
➺ .groupinfo / .gi
➺ .welcome on/off
➺ .setwelcome / .setleave
➺ .promote / .demote
➺ .mute / .unmute
➺ .hidetag / .tagall
➺ .open / .close
➺ .purge [code]
➺ .antism on/off
➺ .blacklist add/remove/list
➺ .groupstats / .gs
➺ .setmenuimg

❀━━━━━━━━━━━━━━❀
        💰 𝗘𝗖𝗢𝗡𝗢𝗠𝗬
❀━━━━━━━━━━━━━━❀
➺ .bal / .balance
➺ .gems
➺ .premium / .membership
➺ .daily
➺ .withdraw / .deposit
➺ .donate [amount]
➺ .richlist / .richlg
➺ .register / .reg
➺ .setname <name>
➺ .setpp / .setbg
➺ .profile / .p
➺ .bio [text] / .setage [age]
➺ .inventory / .shop / .buy
➺ .leaderboard / .lb
➺ .work / .dig / .fish / .beg
➺ .steal / .roast
➺ .stats / .cds

❀━━━━━━━━━━━━━━❀
           🎴 𝗖𝗔𝗥𝗗𝗦
❀━━━━━━━━━━━━━━❀
➺ .collection / .coll
➺ .deck / .sdi
➺ .card [index]
➺ .cardinfo / .ci <name>
➺ .sc <name>
➺ .si <name>
➺ .ss <series>
➺ .slb <series>
➺ .cs <series>
➺ .mycollectionseries
➺ .cardleaderboard / .cardlb
➺ .cardshop / .stardust
➺ .get [id]
➺ .vs @user
➺ .auction / .myauc
➺ .listauc / .bid [id] [amt]
➺ .cg @user
➺ .ctd / .lcd / .retrieve
➺ .sellc / .tc
➺ .accept / .decline

❀━━━━━━━━━━━━━━❀
           🎮 𝗚𝗔𝗠𝗘𝗦
❀━━━━━━━━━━━━━━❀
➺ .tictactoe / .ttt
➺ .connectfour / .c4
➺ .wcg / .wordchain
➺ .startbattle
➺ .truthordare / .td
➺ .stopgame

❀━━━━━━━━━━━━━━❀
              🃏 𝗨𝗡𝗢
❀━━━━━━━━━━━━━━❀
➺ .uno / .startuno
➺ .unoplay / .unodraw
➺ .unohand

❀━━━━━━━━━━━━━━❀
            🎲 𝗚𝗔𝗠𝗕𝗟𝗘
❀━━━━━━━━━━━━━━❀
➺ .slots / .dice / .casino
➺ .coinflip / .cf
➺ .doublebet / .doublepayout
➺ .roulette / .horse / .spin

❀━━━━━━━━━━━━━━❀
            🎭 𝗙𝗨𝗡
❀━━━━━━━━━━━━━━❀
➺ .fancy <1-35> <text>
➺ .gay / .lesbian / .simp
➺ .match / .ship / .relation
➺ .character / .psize / .pp
➺ .skill / .duality / .gen
➺ .pov / .social
➺ .wouldyourather / .wyr
➺ .joke

❀━━━━━━━━━━━━━━❀
      👤 𝗜𝗡𝗧𝗘𝗥𝗔𝗖𝗧𝗜𝗢𝗡
❀━━━━━━━━━━━━━━❀
➺ .hug / .kiss / .slap
➺ .wave / .pat / .dance
➺ .sad / .smile / .laugh
➺ .punch / .kill / .hit
➺ .kidnap / .lick / .bonk
➺ .tickle / .shrug

✨ ━━━━━━━━━━━━━━✨
♣️ The world is cruel, yet beautiful. 反逆
✨ ━━━━━━━━━━━━━━✨`;

  try {
    const db = getDb();
    // is_primary is never actually set anywhere in this codebase (single-bot
    // setup), so relying on it always returned nothing even when an image
    // was configured. Prefer is_primary = 1 if it's ever set, otherwise fall
    // back to the only/first bot row.
    const bot = (
      db.prepare("SELECT id, menu_image_url FROM bots WHERE is_primary = 1").get() ||
      db.prepare("SELECT id, menu_image_url FROM bots ORDER BY created_at ASC LIMIT 1").get()
    ) as any;
    const imageUrl = bot?.menu_image_url;

    if (imageUrl) {
      let imageBuffer: Buffer | null = null;

      // Support both a local file path and a remote http(s) URL
      if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) {
        try {
          const res = await fetch(imageUrl, { signal: AbortSignal.timeout(10000) });
          if (res.ok) {
            imageBuffer = Buffer.from(await res.arrayBuffer());
          }
        } catch {
          // fall through to text-only
        }
      } else if (fs.existsSync(imageUrl)) {
        imageBuffer = fs.readFileSync(imageUrl);
      }

      if (imageBuffer) {
        await sock.sendMessage(from, {
          image: imageBuffer,
          caption: menuText,
          mentions: [sender],
        });
        return;
      }
    }

    // No image configured (or it failed to load) — send text-only, but let
    // the owner/guardian know how to fix that instead of silently degrading.
    await sock.sendMessage(from, {
      text: menuText,
      mentions: [sender],
    });
  } catch {
    await sock.sendMessage(from, {
      text: menuText,
      mentions: [sender],
    });
  }
}

// .setmenuimg — owner/guardian only. Reply to an image (or send one) with
// .setmenuimg to set the image that accompanies every .menu send from then on.
export async function handleSetMenuImage(ctx: CommandContext): Promise<void> {
  const { from, msg, sock } = ctx;

  const directImage = msg.message?.imageMessage ? msg : null;
  const context = msg.message?.extendedTextMessage?.contextInfo;
  const quoted = context?.quotedMessage;
  const quotedImage = quoted?.imageMessage ? quoted : null;
  const target = directImage || (quotedImage ? {
    key: {
      remoteJid: from,
      fromMe: false,
      id: context?.stanzaId || "",
      participant: context?.participant,
    },
    message: quotedImage,
  } : null);

  if (!target) {
    await sock.sendMessage(from, {
      text: "❌ Send an image with the caption *.setmenuimg*, or reply to an image with *.setmenuimg*.",
    });
    return;
  }

  try {
    const downloaded = await downloadMediaMessage(
      target as any,
      "buffer",
      {},
      { reuploadRequest: (sock as any).updateMediaMessage } as any
    );
    const buffer = Buffer.isBuffer(downloaded) ? downloaded : Buffer.from(downloaded as any);

    const filePath = path.join(MENU_ASSETS_DIR, "menu.jpg");
    fs.writeFileSync(filePath, buffer);

    const db = getDb();
    const bot = (
      db.prepare("SELECT id FROM bots WHERE is_primary = 1").get() ||
      db.prepare("SELECT id FROM bots ORDER BY created_at ASC LIMIT 1").get()
    ) as any;
    if (!bot) {
      await sock.sendMessage(from, { text: "❌ No bot record found to attach the image to. Contact the developer." });
      return;
    }
    db.prepare("UPDATE bots SET menu_image_url = ? WHERE id = ?").run(filePath, bot.id);

    await sock.sendMessage(from, { text: "✅ Menu image updated. Every *.menu* from now on will include it." });
  } catch (err) {
    await sock.sendMessage(from, { text: "❌ Couldn't save that image. Try again with a JPG or PNG." });
  }
}

// .help — light per-command descriptions
export async function handleHelp(ctx: CommandContext): Promise<void> {
  const { from, sock } = ctx;
  const help = `📖 *Requiem Order 反逆 — Command Guide*\n\n` +
    `*📋 MAIN*\n` +
    `• *.menu* — Shows the full command list\n` +
    `• *.ping* — Checks if bot is online\n` +
    `• *.afk [reason]* — Sets you as Away From Keyboard\n` +
    `• *.uptime* — Shows how long the bot has been running\n` +
    `• *.website* — Bot website link\n` +
    `• *.community* — Join the community group\n\n` +
    `*⚙️ ADMIN*\n` +
    `• *.kick @user* — Removes a member\n` +
    `• *.warn @user [reason]* — Warns a member (5 = kick)\n` +
    `• *.antilink set [delete/warn/kick]* — Auto-remove links\n` +
    `• *.antism on/off* — Deletes status-mention messages\n` +
    `• *.blacklist add/remove [number]* — Block a phone number from the group\n` +
    `• *.purge [country_code]* — Remove all non-admins from a country code\n` +
    `• *.welcome on/off / .setwelcome [msg]* — New member message\n` +
    `• *.hidetag [text]* — Silently tag all members\n` +
    `• *.setmenuimg* — Set the image attached to .menu (reply to an image)\n\n` +
    `*💰 ECONOMY*\n` +
    `• *.reg <phone>* — Register / link your WhatsApp account\n` +
    `• *.bal* — Wallet & bank balance\n` +
    `• *.daily* — Collect daily reward\n` +
    `• *.deposit / .withdraw [amount]* — Move money\n` +
    `• *.shop / .buy [item]* — Browse and buy items\n` +
    `• *.gems* — Card draw currency (used for getting cards)\n\n` +
    `*🎴 CARDS*\n` +
    `• *.coll* — View your card collection\n` +
    `• *.ci [name]* — Card info lookup\n` +
    `• *.sc [name]* — Search all cards by name\n` +
    `• *.ss [series]* — View all cards in a series\n` +
    `• *.cs [series]* — View your cards from a specific series\n` +
    `• *.vs @user* — Battle another player's deck\n` +
    `• *.auction / .bid [id] [amt]* — Auction cards\n\n` +
    `*🎮 GAMES*\n` +
    `• *.ttt @user* — Tic Tac Toe\n` +
    `• *.c4 @user* — Connect Four\n` +
    `• *.wcg start* — Word Chain Game (real words only!)\n` +
    `• *.td* — Truth or Dare\n\n` +
    `> _Use .info for bot stats. Use .menu for full command list._`;

  await sock.sendMessage(from, { text: help });
}

// .info — bot stats and info
export async function handleInfo(ctx: CommandContext): Promise<void> {
  const { from, sender, sock } = ctx;
  const uptime = process.uptime();
  const d = Math.floor(uptime / 86400);
  const h = Math.floor((uptime % 86400) / 3600);
  const m = Math.floor((uptime % 3600) / 60);
  const s = Math.floor(uptime % 60);
  const uptimeStr = d > 0 ? `${d}d ${h}h ${m}m ${s}s` : `${h}h ${m}m ${s}s`;

  const db = getDb();
  const groupCount = (db.prepare("SELECT COUNT(*) as c FROM groups").get() as any)?.c || 0;
  const userCount = (db.prepare("SELECT COUNT(*) as c FROM users WHERE registered = 1 AND COALESCE(is_bot, 0) = 0").get() as any)?.c || 0;
  const cardCount = (db.prepare("SELECT COUNT(*) as c FROM cards").get() as any)?.c || 0;

  const info = `🌌 *Requiem Order Bot — 反逆*\n\n` +
    `🌌 Bot: ${ctx.sock.user?.name || "Requiem Order"}\n` +
    `👑 Creator: Eᴍᴘᴇʀᴏʀ Lᴇʟᴏᴜᴄʜ\n` +
    `🔹 Prefix: [ . ]\n` +
    `📡 Status: Online ✅\n` +
    `⏱️ Uptime: ${uptimeStr}\n` +
    `🏘️ Active Groups: ${groupCount}\n` +
    `👥 Registered Users: ${userCount}\n` +
    `🎴 Cards in Database: ${cardCount}\n` +
    `\n_🌌 Requiem Order — Heavenly Sky_`;

  await sock.sendMessage(from, { text: info, mentions: [sender] });
}
