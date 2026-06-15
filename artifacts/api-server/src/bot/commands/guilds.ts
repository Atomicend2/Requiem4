import type { CommandContext } from "./index.js";
import { sendText } from "../connection.js";
import {
  getGuild, getUserGuild, createGuild, joinGuild, leaveGuild, getAllGuilds,
  getGuildMembers, kickFromGuild, disbandGuild, ensureUser, getUser, getMentionName,
} from "../db/queries.js";
import { getDb } from "../db/database.js";
import { generateId } from "../utils.js";

export async function handleGuilds(ctx: CommandContext): Promise<void> {
  const { from, sender, args, command, sock, resolvedMentions } = ctx;
  const sub = args[0]?.toLowerCase();
  const user = ensureUser(sender);
  const rpg = getDb().prepare("SELECT * FROM rpg_characters WHERE user_id = ?").get(sender) as any;

  if (command !== "guild") {
    await sendText(from, "❌ Usage: .guild [create/join/leave/info/list/desc/kick/disband]");
    return;
  }

  if (sub === "create") {
    const name = args.slice(1).join(" ");
    if (!name) { await sendText(from, "❌ Usage: .guild create [name]"); return; }
    if (!rpg || rpg.level < 20) {
      await sendText(from, "❌ You need to be Level 20 to create a guild.");
      return;
    }
    const existing = getUserGuild(sender);
    if (existing) { await sendText(from, "❌ You're already in a guild. Leave first with .guild leave"); return; }
    if (getGuild(name)) { await sendText(from, "❌ A guild with that name already exists."); return; }
    const guildId = generateId(8);
    createGuild(guildId, name, sender);
    await sendText(from, `🏰 Guild *${name}* created! You are the owner.`);
    return;
  }

  if (sub === "join") {
    const name = args.slice(1).join(" ");
    if (!name) { await sendText(from, "❌ Usage: .guild join [name]"); return; }
    const g = getGuild(name);
    if (!g) { await sendText(from, "❌ Guild not found."); return; }
    const existing = getUserGuild(sender);
    if (existing) { await sendText(from, "❌ You're already in a guild."); return; }
    joinGuild(sender, g.id);
    await sendText(from, `✅ Joined guild *${g.name}*!`);
    return;
  }

  if (sub === "leave") {
    const g = getUserGuild(sender);
    if (!g) { await sendText(from, "❌ You're not in a guild."); return; }
    if (g.owner_id === sender) {
      await sendText(from, "❌ You're the guild owner. Disband it first with .guild disband");
      return;
    }
    leaveGuild(sender);
    await sendText(from, `✅ Left guild *${g.name}*.`);
    return;
  }

  if (sub === "info") {
    const name = args.slice(1).join(" ");
    const g = name ? getGuild(name) : getUserGuild(sender);
    if (!g) { await sendText(from, "❌ Guild not found."); return; }
    const members = getGuildMembers(g.id);
    await sendText(from,
      `🏰 *Guild: ${g.name}*\n👑 Owner: @${getMentionName(g.owner_id)}\n📝 ${g.description || "(no description)"}\n⭐ Level: ${g.level}\n👥 Members: ${members.length}`,
      [g.owner_id]
    );
    return;
  }

  if (sub === "list") {
    const guilds = getAllGuilds();
    if (guilds.length === 0) { await sendText(from, "❌ No guilds yet."); return; }
    const text = "🏰 *Guild List*\n\n" +
      guilds.map((g, i) => `${i+1}. *${g.name}* (Lv.${g.level}) — ${getGuildMembers(g.id).length} members`).join("\n");
    await sendText(from, text);
    return;
  }

  if (sub === "desc") {
    const g = getUserGuild(sender);
    if (!g || g.owner_id !== sender) { await sendText(from, "❌ Only guild owners can set the description."); return; }
    const desc = args.slice(1).join(" ");
    getDb().prepare("UPDATE guilds SET description = ? WHERE id = ?").run(desc, g.id);
    await sendText(from, `✅ Guild description updated: ${desc}`);
    return;
  }

  if (sub === "kick") {
    const mentioned = resolvedMentions[0];
    if (!mentioned) { await sendText(from, "❌ Mention someone to kick."); return; }
    const g = getUserGuild(sender);
    if (!g || g.owner_id !== sender) { await sendText(from, "❌ Only guild owners can kick members."); return; }
    kickFromGuild(mentioned, g.id);
    await sock.sendMessage(from, {
      text: `🚪 @${getMentionName(mentioned)} was kicked from *${g.name}*!`,
      mentions: [mentioned],
    });
    return;
  }

  if (sub === "disband") {
    const g = getUserGuild(sender);
    if (!g || g.owner_id !== sender) { await sendText(from, "❌ Only the guild owner can disband."); return; }
    disbandGuild(g.id);
    await sendText(from, `✅ Guild *${g.name}* has been disbanded.`);
    return;
  }

  await sendText(from, "Usage: .guild create/join/leave/info/list/desc/kick/disband");
}
