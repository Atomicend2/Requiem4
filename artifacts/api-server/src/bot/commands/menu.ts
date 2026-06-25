import type { CommandContext } from "./index.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DB_DIR } from "../db/database.js";
import { col } from "../db/mongo.js";
import { getMentionName, getStaff } from "../db/queries.js";
import { mentionTag } from "../utils.js";
import { getBotName } from "../connection.js";
import { downloadMediaMessage } from "@whiskeysockets/baileys";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MENU_ASSETS_DIR = path.join(DB_DIR, "menu-assets");
if (!fs.existsSync(MENU_ASSETS_DIR)) fs.mkdirSync(MENU_ASSETS_DIR, { recursive: true });

export async function handleStaffMenu(ctx: CommandContext): Promise<void> {
  const { from, sender, sock, isOwner } = ctx;
  const staff = await getStaff(sender);
  const role = isOwner ? "owner" : (staff as any)?.role;
  if (!role || !["owner", "guardian", "mod"].includes(role)) {
    await sock.sendMessage(from, { text: "❌ This command is for staff only." });
    return;
  }

  const staffMenu =
`🌸━━━『 反逆 』━━━🌸
✦ Staff Command Reference ✦
👑 Your role: ${role.toUpperCase()}

❀━━━━━━━━━━━━━━❀
        👮 MODERATION
❀━━━━━━━━━━━━━━❀
➺ .ban @user [reason] — Ban a user globally
➺ .unban @user — Lift a global ban
➺ .banlist — View all banned users
➺ .warn @user [reason] — Warn a member (group-level)
➺ .resetwarn — Clear a member's warnings

❀━━━━━━━━━━━━━━❀
       🛡️ STAFF MANAGEMENT
❀━━━━━━━━━━━━━━❀
➺ .bots — List all managed bot instances
➺ .modlist / .mods / .modslist / .cardmakers — List all staff
➺ .addmod @user — Promote to mod (guardian/owner only)
➺ .addguardian @user — Promote to guardian (owner only)
➺ .removemod @user — Demote a mod
➺ .removeguardian @user — Demote a guardian
➺ .recruit @user — Mark a user as a recruit
➺ .addpremium @user [days] — Grant premium
➺ .removepremium @user — Remove premium
➺ .addrole @user [role] — Set a custom display role
➺ .restart — Restart the bot process

❀━━━━━━━━━━━━━━❀
      🃏 CARD MANAGEMENT
❀━━━━━━━━━━━━━━❀
➺ .upload — Upload a new card (reply to image/video)
➺ .fetchcards — Re-sync cards from unified_cards.jsonl
➺ .summon [tier] [@user] — Force-spawn a card
➺ .dc — Disable card spawning in this group
➺ .ac — Enable card spawning in this group
➺ .rc — Toggle card spawning in this group
➺ .frame delete <code or number> — Delete a frame (staff)
➺ .delcard / .deletecard <copy_id> — Permanently delete a player's card copy

❀━━━━━━━━━━━━━━❀
      📢 GROUPS / BROADCAST
❀━━━━━━━━━━━━━━❀
➺ .post <text> — Broadcast a message to all groups
➺ .join <invite link> — Make the bot join a group
➺ .exit — Make the bot leave the current group
➺ .show — Show all groups the bot is in
➺ .setms <key> <value> — Set a bot setting
➺ .delms <key> — Delete a bot setting
➺ .rules [text] — Set this group's staff-managed rules
➺ .website — Show the website link (staff variant)

❀━━━━━━━━━━━━━━❀
       💰 USER MANAGEMENT
❀━━━━━━━━━━━━━━❀
➺ .resetbal @user — Reset a user's balance to 0
➺ .reset @user — Fully reset a user's profile (owner only)
➺ .addinv @user <item> [qty] — Give a user an inventory item

✨ ━━━━━━━━━━━━━━✨
This list is staff-only — regular players see *.menu* instead.
✨ ━━━━━━━━━━━━━━✨`;

  await sock.sendMessage(from, { text: staffMenu, mentions: [sender] });
}

export async function handleMenu(ctx: CommandContext): Promise<void> {
  const { from, sender, sock } = ctx;
  const senderTag = mentionTag(sender);
  const botName = getBotName();

  const menuText =
`🌸━━━『 反逆 』━━━🌸

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
➺ .antibot on/off
➺ .blacklist add/remove/list
➺ .groupstats / .gs
➺ .activity
➺ .active / .inactive
➺ .gclink / .gcl
➺ .rules
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
➺ .frame [id]

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
➺ .tier — Your cards grouped by tier
➺ .myseries — Your cards grouped by series
➺ .fuse / .fusion / .forge <tier> — Fuse duplicates into a higher tier
➺ .cardleaderboard / .cardlb
➺ .cardshop / .stardust
➺ .get [id]
➺ .vs @user
➺ .auction / .auctions
➺ .myauc / .listauc [index] [price] [h]
➺ .bid [id] [amount]
➺ .remauc <auction_id> — Cancel your own auction
➺ .cg @user
➺ .ctd / .lcd / .retrieve
➺ .sellc / .tc
➺ .accept / .decline

❀━━━━━━━━━━━━━━❀
         ⚔️ 𝗥𝗣𝗚
❀━━━━━━━━━━━━━━❀
➺ .rpg — View your RPG stats
➺ .rpgstats — Full stats breakdown
➺ .class — Choose/view your class
➺ .adventure — Go on an adventure
➺ .achievements / .achieve
➺ .explore — Explore new areas
➺ .rest — Rest to recover
➺ .territory / .claim — View, claim, or set tax on world territories

❀━━━━━━━━━━━━━━❀
        🏰 𝗗𝗨𝗡𝗚𝗘𝗢𝗡
❀━━━━━━━━━━━━━━❀
➺ .dungeon — Enter a dungeon
➺ .attack — Attack in a dungeon battle
➺ .heavy — Heavy attack (slower, harder hit)
➺ .defend — Defend, reducing incoming damage
➺ .flee — Flee from a dungeon battle
➺ .quest — View active quests
➺ .raid — Raid an enemy boss
➺ .boss — Challenge a boss
➺ .heal — Heal your character

❀━━━━━━━━━━━━━━❀
           🤖 𝗔𝗜
❀━━━━━━━━━━━━━━❀
➺ .ai / .gpt / .chat <text>
➺ .translate / .tt <text>
➺ .mood — Check Echidna's mood

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
           🎟️ 𝗟𝗢𝗧𝗧𝗘𝗥𝗬
❀━━━━━━━━━━━━━━❀
➺ .lottery — View lottery info
➺ .ll — Buy a lottery ticket
➺ .lp — Check your tickets
➺ .drawlottery — Draw lottery (if eligible)

❀━━━━━━━━━━━━━━❀
    🌐 𝗪𝗘𝗕 / 𝗔𝗖𝗖𝗢𝗨𝗡𝗧
❀━━━━━━━━━━━━━━❀
➺ .website — Open the web dashboard
➺ .reg <phone> — Register your account
➺ .verify <code> — Verify OTP

❀━━━━━━━━━━━━━━❀
          🖼️ 𝗠𝗘𝗗𝗜𝗔
❀━━━━━━━━━━━━━━❀
➺ .sticker / .s — Convert to sticker
➺ .toimg / .turnimg — Sticker to image
➺ .take — Take a screenshot
➺ .pintimg — Save an image

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
    const bot = await col("bots").findOne(
      {},
      { sort: { is_primary: -1, created_at: 1 } }
    );
    const imageUrl = bot?.menu_image_url;

    if (imageUrl) {
      let imageBuffer: Buffer | null = null;

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

export async function handleSetMenuImage(ctx: CommandContext): Promise<void> {
  const { from, sock, msg } = ctx;

  const quoted = (msg.message as any)?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!quoted?.imageMessage) {
    await sock.sendMessage(from, { text: "❌ Reply to an image with *.setmenuimg* to set it as the menu image." });
    return;
  }

  try {
    const downloaded = await downloadMediaMessage(
      { message: quoted, key: msg.key } as any,
      "buffer",
      { reuploadRequest: (sock as any).updateMediaMessage } as any
    );
    const buffer = Buffer.isBuffer(downloaded) ? downloaded : Buffer.from(downloaded as any);

    const filePath = path.join(MENU_ASSETS_DIR, "menu.jpg");
    fs.writeFileSync(filePath, buffer);

    const bot = await col("bots").findOne(
      {},
      { sort: { is_primary: -1, created_at: 1 } }
    );
    if (!bot) {
      await sock.sendMessage(from, { text: "❌ No bot record found to attach the image to. Contact the developer." });
      return;
    }
    await col("bots").updateOne({ _id: bot._id }, { $set: { menu_image_url: filePath } });

    await sock.sendMessage(from, { text: "✅ Menu image updated. Every *.menu* from now on will include it." });
  } catch {
    await sock.sendMessage(from, { text: "❌ Couldn't save that image. Try again with a JPG or PNG." });
  }
}

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
    `• *.antibot on/off* — Auto-remove bot accounts\n` +
    `• *.blacklist add/remove [number]* — Block a phone number from the group\n` +
    `• *.purge [country_code]* — Remove all non-admins from a country code\n` +
    `• *.welcome on/off / .setwelcome [msg]* — New member message\n` +
    `• *.hidetag [text]* — Silently tag all members\n` +
    `• *.activity* — Check group activity score\n` +
    `• *.gclink* — Get the group invite link\n` +
    `• *.rules* — View group rules\n` +
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
    `• *.auction / .bid [id] [amt]* — Auction cards\n` +
    `• *.mzsearch [name]* — Search Mazoku cards by name\n` +
    `• *.mzseries [series]* — Browse Mazoku cards by series\n\n` +
    `*⚔️ RPG*\n` +
    `• *.rpg* — View your RPG character\n` +
    `• *.adventure* — Go on an adventure\n` +
    `• *.quest* — View active quests\n` +
    `• *.dungeon* — Enter a dungeon\n\n` +
    `*🎮 GAMES*\n` +
    `• *.ttt @user* — Tic Tac Toe\n` +
    `• *.c4 @user* — Connect Four\n` +
    `• *.wcg start* — Word Chain Game (real words only!)\n` +
    `• *.td* — Truth or Dare\n\n` +
    `> _Use .info for bot stats. Use .menu for full command list._`;

  await sock.sendMessage(from, { text: help });
}

export async function handleInfo(ctx: CommandContext): Promise<void> {
  const { from, sender, sock } = ctx;
  const uptime = process.uptime();
  const d = Math.floor(uptime / 86400);
  const h = Math.floor((uptime % 86400) / 3600);
  const m = Math.floor((uptime % 3600) / 60);
  const s = Math.floor(uptime % 60);
  const uptimeStr = d > 0 ? `${d}d ${h}h ${m}m ${s}s` : `${h}h ${m}m ${s}s`;

  const [groupCount, userCount, cardCount] = await Promise.all([
    col("groups").countDocuments({}),
    col("users").countDocuments({ registered: 1, is_bot: { $ne: 1 } }),
    col("cards").countDocuments({}),
  ]);

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
