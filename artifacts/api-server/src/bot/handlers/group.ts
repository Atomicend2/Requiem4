import type { WASocket } from "@whiskeysockets/baileys";
import { ensureGroup, getGroup, isBanned, updateGroup } from "../db/queries.js";
import { sendText } from "../connection.js";
import { mentionTag } from "../utils.js";
import { checkBlacklistedJoin } from "./antispam.js";

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
      // WhatsApp clients appear and should NEVER be treated as a bot — we
      // already resolved the real JID above.
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
        const template = group.welcome_msg || "Welcome to the group, @mention! 👋";
        const msg = replaceWelcomeMention(template, participant);
        await sendText(groupId, msg, [participant]).catch(() => {});
      }
    } else if (action === "remove" || action === "leave") {
      if (group.leave === "on") {
        const name = mentionTag(participant);
        const template = group.leave_msg || `Goodbye ${name}! 👋`;
        const msg = replaceWelcomeMention(template, participant);
        await sendText(groupId, msg, [participant]).catch(() => {});
      }
    }
  }
}

function replaceWelcomeMention(template: string, participant: string): string {
  return template
    .replace(/@user/gi, mentionTag(participant))
    .replace(/@mention/gi, mentionTag(participant));
}
