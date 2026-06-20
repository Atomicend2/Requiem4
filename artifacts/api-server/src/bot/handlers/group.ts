import type { WASocket } from "@whiskeysockets/baileys";
import { ensureGroup, getGroup, isBanned, updateGroup } from "../db/queries.js";
import { sendText } from "../connection.js";
import { mentionTag } from "../utils.js";
import { checkBlacklistedJoin } from "./antispam.js";
import { logger } from "../../lib/logger.js";
import { generateWelcomeCard } from "./welcomecard.js";

export async function handleGroupUpdate(sock: WASocket, updates: any[]) {
  for (const update of updates) {
    if (!update.id) continue;
    const group = await sock.groupMetadata(update.id).catch(() => null);
    if (!group) continue;
    ensureGroup(update.id, group.subject);
    if (isBanned("group", update.id)) {
      await sock.groupLeave(update.id).catch(() => {});
    }
  }
}

export async function handleGroupParticipantsUpdate(
  sock: WASocket,
  update: { id: string; participants: string[]; action: string }
) {
  const { id: groupId, participants, action } = update;
  // Only handle add/remove/leave — skip promote/demote/etc.
  if (!["add", "remove", "leave"].includes(action)) return;

  let group = getGroup(groupId);
  if (!group) {
    const meta = await sock.groupMetadata(groupId).catch(() => null);
    group = ensureGroup(groupId, meta?.subject);
  }
  if (isBanned("group", groupId)) {
    await sock.groupLeave(groupId).catch(() => {});
    return;
  }

  // Always fetch fresh group metadata so @lid JIDs can be resolved to real phone JIDs
  let groupMeta: any = await sock.groupMetadata(groupId).catch(() => null);

  for (const rawParticipant of participants) {
    // Resolve @lid JIDs to real phone JIDs so mentions actually tag the user
    let participant = rawParticipant;
    if (rawParticipant.endsWith("@lid") && groupMeta) {
      for (const p of groupMeta.participants as any[]) {
        if (p.id === rawParticipant || p.lid === rawParticipant) {
          const real = ([p.id, p.lid] as string[]).find((j: string) => j?.endsWith("@s.whatsapp.net"));
          if (real) { participant = real; break; }
        }
      }
    }

    if (action === "add") {
      // Reject blacklisted phone numbers immediately on join
      const blocked = await checkBlacklistedJoin(sock, groupId, participant).catch(() => false);
      if (blocked) continue;

      // Only flag explicit bot accounts (.bot@ pattern). @lid is how newer
      // WhatsApp clients appear and should NEVER be treated as a bot.
      const isLikelyBot = rawParticipant.includes(".bot@");
      if (isLikelyBot && (group.anti_bot || "off") === "on") {
        try {
          await sock.groupParticipantsUpdate(groupId, [rawParticipant], "remove");
          await sendText(groupId, `🤖 Suspected bot account was automatically removed.`);
        } catch {}
        updateGroup(groupId, { cards_enabled: "off", spawn_enabled: "off" });
        continue;
      }

      if (group.welcome === "on") {
        const template = group.welcome_msg || "Welcome to the group, @user! 👋";
        const memberCount = (groupMeta?.participants?.length ?? 0) || undefined;
        const pushName = groupMeta?.participants?.find((p: any) => p.id === participant)?.name || undefined;
        const displayName = pushName || participant.split("@")[0].split(":")[0];

        // ── Try to build and send a welcome image card ───────────────────────
        const card = await generateWelcomeCard({
          sock,
          type: "welcome",
          participantJid: participant,
          participantName: displayName,
          groupName: groupMeta?.subject || "the group",
          memberCount,
        }).catch((err) => {
          logger.warn({ err, groupId, participant }, "Welcome card render failed");
          return null;
        });

        const msg = replaceWelcomeMention(template, participant);

        if (card) {
          await sock.sendMessage(groupId, {
            image: card,
            caption: msg,
            mentions: [participant],
          }).catch((err) => logger.warn({ err, groupId }, "Failed to send welcome card"));
        } else {
          // Fallback: plain text welcome
          await sendText(groupId, msg, [participant]).catch((err) => {
            logger.warn({ err, groupId, participant }, "Failed to send welcome text");
          });
        }
      }
    } else if (action === "remove" || action === "leave") {
      if (group.leave === "on") {
        const pushName = groupMeta?.participants?.find((p: any) => p.id === participant)?.name || undefined;
        const displayName = pushName || participant.split("@")[0].split(":")[0];
        const memberCount = Math.max(0, (groupMeta?.participants?.length ?? 1) - 1) || undefined;
        const template = group.leave_msg || `Goodbye @user! 👋`;

        // ── Try to build and send a goodbye image card ───────────────────────
        const card = await generateWelcomeCard({
          sock,
          type: "goodbye",
          participantJid: participant,
          participantName: displayName,
          groupName: groupMeta?.subject || "the group",
          memberCount,
        }).catch((err) => {
          logger.warn({ err, groupId, participant }, "Goodbye card render failed");
          return null;
        });

        const msg = replaceWelcomeMention(template, participant);

        if (card) {
          await sock.sendMessage(groupId, {
            image: card,
            caption: msg,
            mentions: [participant],
          }).catch((err) => logger.warn({ err, groupId }, "Failed to send goodbye card"));
        } else {
          // Fallback: plain text goodbye
          await sendText(groupId, msg, [participant]).catch((err) => {
            logger.warn({ err, groupId, participant }, "Failed to send goodbye text");
          });
        }
      }
    }
  }
}

function replaceWelcomeMention(template: string, participant: string): string {
  return template
    .replace(/@user/gi, mentionTag(participant))
    .replace(/@mention/gi, mentionTag(participant));
}
