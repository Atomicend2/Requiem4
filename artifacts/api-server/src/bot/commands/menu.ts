import type { CommandContext } from "./index.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getDb } from "../db/database.js";
import { getMentionName } from "../db/queries.js";
import { mentionTag } from "../utils.js";
import { getBotName } from "../connection.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function handleMenu(ctx: CommandContext): Promise<void> {
  const { from, sender, sock } = ctx;
  // Use phone number in text for a real WhatsApp mention tag
  const senderTag = mentionTag(sender);   // e.g. @2348012345678
  const senderName = getMentionName(sender); // display name for profile line
  const botName = getBotName();

  const menuText =
`🌸━━━『 𝗥𝗘𝗤𝗨𝗜𝗘𝗠 𝗢𝗥𝗗𝗘𝗥 反逆 』━━━🌸

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
➺ .menu — Full command list
➺ .ping — Check bot status
➺ .website — Bot website link
➺ .community — Join the community
➺ .bots — List active bots
➺ .afk [reason] — Set yourself AFK
➺ .help / .info — Guide & stats
➺ .uptime — How long the bot's been running

❀━━━━━━━━━━━━━━❀
            ⚙️ 𝗔𝗗𝗠𝗜𝗡
❀━━━━━━━━━━━━━━❀
➺ .kick — Remove a member
➺ .delete / .del / .d — Delete a message
➺ .antilink set [action] — Auto-remove links
➺ .warn @user [reason] — Warn a member (5 = kick)
➺ .resetwarn — Clear warnings
➺ .groupinfo / .gi — Group details
➺ .welcome on/off — Toggle welcome messages
➺ .setwelcome / .setleave — Custom join/leave text
➺ .promote / .demote — Admin management
➺ .mute / .unmute — Silence a member
➺ .hidetag / .tagall — Tag everyone
➺ .open / .close — Open/close the group
➺ .purge [code] — Remove non-admins by country code
➺ .antism on/off — Delete status-mention spam
➺ .blacklist add/remove/list — Block numbers
➺ .groupstats / .gs — Group activity stats

❀━━━━━━━━━━━━━━❀
        💰 𝗘𝗖𝗢𝗡𝗢𝗠𝗬
❀━━━━━━━━━━━━━━❀
➺ .bal / .balance — Wallet & bank
➺ .gems — Card-draw currency
➺ .premium / .membership — Premium status
➺ .daily — Daily reward
➺ .withdraw / .deposit — Move money
➺ .donate [amount] — Donate to another user
➺ .richlist / .richlg — Top balances
➺ .register / .reg — Register / link your account
➺ .setname <name> — Change display name
➺ .setpp / .setbg — Set profile picture / background
➺ .profile / .p — View your profile card
➺ .bio [text] / .setage [age] — Edit profile details
➺ .inventory / .shop / .buy — Browse and buy items
➺ .leaderboard / .lb — Global rankings
➺ .work / .dig / .fish / .beg — Earn money
➺ .steal / .roast — Risk-it activities
➺ .stats / .cds — Your stats & cooldowns

❀━━━━━━━━━━━━━━❀
           🎴 𝗖𝗔𝗥𝗗𝗦
❀━━━━━━━━━━━━━━❀
➺ .collection / .coll — Your card collection
➺ .deck / .sdi — View/manage your deck
➺ .card [index] — View a specific card
➺ .cardinfo / .ci <name> — Card lookup
➺ .sc <name> — Search cards by name
➺ .si <name> — Search index
➺ .ss <series> — All cards in a series
➺ .slb <series> — Series leaderboard
➺ .cs <series> — Your cards from a series
➺ .mycollectionseries — Your collection by series
➺ .cardleaderboard / .cardlb — Top collectors
➺ .cardshop / .stardust — Card shop & currency
➺ .get [id] — Claim a card
➺ .vs @user — Battle another player's deck
➺ .auction / .myauc — Manage auctions
➺ .listauc / .bid [id] [amt] — Browse & bid
➺ .cg @user — Challenge to a card game
➺ .ctd / .lcd / .retrieve — Trade/lend cards
➺ .sellc / .tc — Sell or transfer cards
➺ .accept / .decline — Respond to trade offers

❀━━━━━━━━━━━━━━❀
           🎮 𝗚𝗔𝗠𝗘𝗦
❀━━━━━━━━━━━━━━❀
➺ .tictactoe / .ttt — Tic Tac Toe
➺ .connectfour / .c4 — Connect Four
➺ .wcg / .wordchain — Word Chain (real words only!)
➺ .startbattle — Start a battle game
➺ .truthordare / .td — Truth or Dare
➺ .stopgame — End the current game

❀━━━━━━━━━━━━━━❀
              🃏 𝗨𝗡𝗢
❀━━━━━━━━━━━━━━❀
➺ .uno / .startuno — Start a UNO round
➺ .unoplay / .unodraw — Play / draw a card
➺ .unohand — View your hand

❀━━━━━━━━━━━━━━❀
            🎲 𝗚𝗔𝗠𝗕𝗟𝗘
❀━━━━━━━━━━━━━━❀
➺ .slots / .dice / .casino — Casino games
➺ .coinflip / .cf — Flip a coin
➺ .doublebet / .doublepayout — Double-or-nothing
➺ .roulette / .horse / .spin — More betting games

❀━━━━━━━━━━━━━━❀
            🎭 𝗙𝗨𝗡
❀━━━━━━━━━━━━━━❀
➺ .fancy <1-35> <text> — Stylized text
➺ .gay / .lesbian / .simp — Fun tags
➺ .match / .ship / .relation — Compatibility fun
➺ .character / .psize / .pp — Fun stat generators
➺ .skill / .duality / .gen — More generators
➺ .pov / .social — POV & social prompts
➺ .wouldyourather / .wyr — Would You Rather
➺ .joke — Random joke

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
♣️ A king does not need to be loved —
⭐ only obeyed, or remembered. 反逆
✨ ━━━━━━━━━━━━━━✨`;

  try {
    const db = getDb();
    const bot = db.prepare("SELECT menu_image_url FROM bots WHERE is_primary = 1").get() as any;
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
    `• *.hidetag [text]* — Silently tag all members\n\n` +
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
