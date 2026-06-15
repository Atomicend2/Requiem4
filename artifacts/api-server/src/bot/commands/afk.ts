import type { CommandContext } from "./index.js";
import { sendText } from "../connection.js";
import { setAfk, removeAfk, getAfk, getMentionName } from "../db/queries.js";
import { timeAgo } from "../utils.js";

export async function handleAfk(ctx: CommandContext): Promise<void> {
  const { from, sender, args } = ctx;
  const reason = args.join(" ") || "AFK";
  setAfk(sender, reason);
  await sendText(from, `You are now AFK: ${reason}`);
}

export async function checkSenderReturnedFromAfk(
  from: string,
  sender: string,
  sock: any,
  msg?: any
): Promise<void> {
  const senderAfk = getAfk(sender);
  if (!senderAfk) return;
  removeAfk(sender);
  const elapsed = timeAgo(senderAfk.started_at);
  const name = getMentionName(sender);
  const msgOpts: any = {
    text: `Welcome back, @${name} Senpai! 🌸\nYou were AFK for ${elapsed}\n\nReason: ${senderAfk.reason}`,
    mentions: [sender],
  };
  if (msg) msgOpts.quoted = msg;
  await sock.sendMessage(from, msgOpts);
}

export async function checkAfkMention(
  from: string,
  sender: string,
  mentioned: string[],
  sock: any
): Promise<void> {
  for (const m of mentioned) {
    if (m === sender) continue;
    const afk = getAfk(m);
    if (afk) {
      await sock.sendMessage(from, {
        text: `🔴 @${getMentionName(m)} is AFK: "${afk.reason}" (since ${timeAgo(afk.started_at)})`,
        mentions: [m],
      });
    }
  }
}
