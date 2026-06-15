import type { CommandContext } from "./index.js";
import { sendText } from "../connection.js";
import { getBotSetting, getStaff, setBotSetting, getMentionName } from "../db/queries.js";
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import { logger } from "../../lib/logger.js";

export const INTERACTION_NAMES = new Set([
  "hug","kiss","slap","pat","punch","kill","hit","kidnap","lick","bonk","tickle",
  "wave","dance","sad","smile","laugh","shrug",
]);

const ACTIONS: Record<string, { with: string[]; self: string[] }> = {
  hug: {
    with: ["hugs {target} tightly! 🤗", "wraps {target} in a warm hug 💕"],
    self: ["wants a hug... 🥺"],
  },
  kiss: {
    with: ["kisses {target}! 💋", "gives {target} a little kiss 😘"],
    self: ["kissed the mirror again 😚"],
  },
  slap: {
    with: ["slaps {target}! SMACK! 👋", "gave {target} a reality check 🖐️"],
    self: ["slapped themselves... are you okay? 🤔"],
  },
  pat: {
    with: ["pats {target} on the head 🥰", "gives {target} a gentle pat 👋"],
    self: ["pats themselves... hang in there 💪"],
  },
  punch: {
    with: ["punches {target}! POW! 👊", "sends a punch flying at {target} 🥊"],
    self: ["punched themselves. Ouch?"],
  },
  kill: {
    with: ["eliminated {target}! 💀", "got rid of {target}. RIP 🪦"],
    self: ["tried self-deletion but respawned 😂"],
  },
  hit: {
    with: ["hits {target}! 💢", "smacks {target} 🏏"],
    self: ["hit themselves... 😬"],
  },
  kidnap: {
    with: ["kidnapped {target}! 🎭", "snatched {target} away! 😈"],
    self: ["tried to kidnap themselves. Failed 🕵️"],
  },
  lick: {
    with: ["licked {target}! 😛", "gives {target} a lick for some reason... 👅"],
    self: ["licked themselves 😂"],
  },
  bonk: {
    with: ["bonks {target} on the head! 🔨", "sends {target} to horny jail 🚔"],
    self: ["self-bonked 💥"],
  },
  tickle: {
    with: ["tickles {target}! Hehehe! 😂", "attacks {target}'s weak spot 🤣"],
    self: ["tried to tickle themselves 🤷"],
  },
  wave: {
    with: ["waved at {target}! 👋", "waves to {target}~ 🌊", "gives {target} a friendly wave! 👋"],
    self: ["waves hello! 👋", "waves at everyone~ 🌊"],
  },
};

const SOLO_ACTIONS: Record<string, string[]> = {
  dance: ["is dancing! 💃", "starts busting moves! 🕺"],
  sad: ["is feeling sad right now... 😢", "needs some comfort 🥺"],
  smile: ["smiles brightly! 😊", "gives you a warm smile ☺️"],
  laugh: ["bursts out laughing! 😂", "can't stop laughing 🤣"],
  shrug: ["shrugs. ¯\\_(ツ)_/¯", "doesn't know either 🤷"],
};

export async function handleInteraction(ctx: CommandContext): Promise<void> {
  const { from, sender, args, command: cmd, msg, sock, isOwner, resolvedMentions } = ctx;
  const name = getMentionName(sender);
  const info = msg.message?.extendedTextMessage?.contextInfo;
  const mentioned = resolvedMentions[0] || info?.participant || undefined;

  if (args[0]?.toLowerCase() === "upload") {
    if (!isOwner && !getStaff(sender)) {
      await sendText(from, "❌ Only staff can upload interaction GIFs.");
      return;
    }
    const uploaded = await getInteractionUpload(ctx).catch((err) => {
      logger.error({ err, cmd }, "Failed to download interaction GIF");
      return null;
    });
    if (!uploaded) {
      await sendText(from, `❌ Reply to a GIF/video with .${cmd} upload to save it.\n\nMake sure you're replying to a GIF or video message.`);
      return;
    }
    setBotSetting(`interaction_gif:${cmd}`, uploaded);
    await sendText(from, `✅ GIF saved for *.${cmd}*! It will now be sent whenever someone uses this interaction.`);
    return;
  }

  if (SOLO_ACTIONS[cmd]) {
    const actions = SOLO_ACTIONS[cmd];
    const action = actions[Math.floor(Math.random() * actions.length)];
    await sendInteractionResult(ctx, `@${name} ${action}`, [sender]);
    return;
  }

  if (ACTIONS[cmd]) {
    const actions = ACTIONS[cmd];
    if (mentioned) {
      const templates = actions.with;
      const tmpl = templates[Math.floor(Math.random() * templates.length)];
      const text = `@${name} ${tmpl.replace("{target}", `@${getMentionName(mentioned)}`)}`;
      await sendInteractionResult(ctx, text, [sender, mentioned]);
    } else {
      const texts = actions.self;
      await sendInteractionResult(ctx, `@${name} ${texts[Math.floor(Math.random() * texts.length)]}`, [sender]);
    }
    return;
  }
}

async function sendInteractionResult(ctx: CommandContext, text: string, mentions: string[]): Promise<void> {
  const gif = getBotSetting(`interaction_gif:${ctx.command}`);
  if (gif && Buffer.isBuffer(gif)) {
    await ctx.sock.sendMessage(ctx.from, {
      video: gif,
      gifPlayback: true,
      caption: text,
      mentions,
      mimetype: "video/mp4",
    });
    return;
  }
  await ctx.sock.sendMessage(ctx.from, { text, mentions });
}

export async function uploadInteractionGif(ctx: CommandContext, interactionName: string): Promise<void> {
  const { from, sender, isOwner } = ctx;
  if (!isOwner && !getStaff(sender)) {
    await sendText(from, "❌ Only staff can upload interaction GIFs.");
    return;
  }
  const uploaded = await getInteractionUpload(ctx).catch(() => null);
  if (!uploaded) {
    await sendText(from, `❌ Reply to a GIF/video with .upload ${interactionName} to save it.`);
    return;
  }
  setBotSetting(`interaction_gif:${interactionName}`, uploaded);
  await sendText(from, `✅ GIF saved for *.${interactionName}*! It will now be sent whenever someone uses this interaction.`);
}

async function getInteractionUpload(ctx: CommandContext): Promise<Buffer | null> {
  const info = ctx.msg.message?.extendedTextMessage?.contextInfo;
  const quoted = info?.quotedMessage;

  const directMsg = ctx.msg.message;
  const directMedia = directMsg?.videoMessage || directMsg?.imageMessage || directMsg?.documentMessage || directMsg?.stickerMessage;
  const quotedMedia = quoted?.videoMessage || quoted?.imageMessage || quoted?.documentMessage || quoted?.stickerMessage;

  if (!directMedia && !quotedMedia) return null;

  const target = directMedia
    ? ctx.msg
    : {
        key: {
          remoteJid: ctx.from,
          fromMe: false,
          id: info?.stanzaId || "",
          participant: info?.participant,
        },
        message: quoted,
      };

  const downloaded = await downloadMediaMessage(
    target as any,
    "buffer",
    {},
    { reuploadRequest: (ctx.sock as any).updateMediaMessage } as any
  );
  const buf = Buffer.isBuffer(downloaded) ? downloaded : Buffer.from(downloaded as any);
  return buf.length > 0 ? buf : null;
}
