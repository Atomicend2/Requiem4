/**
 * identity.ts — Single source of truth for WhatsApp identity resolution.
 *
 * The Rule (tattoo it on your code):
 *   SAVE with plain phone number  →  always extractPhone(jid)
 *   READ from DB                  →  WHERE id = plainPhone
 *   SEND messages                 →  use the original JID (never alter it)
 *
 * WhatsApp gives us two name-tags per user:
 *   JID  → 2547xxxxxxxx@s.whatsapp.net  (phone-based, used for sending)
 *   LID  → 101014040526896@lid          (internal WA identifier)
 *
 * Both represent the same person. We always store the plain phone number
 * as the DB key so the bot and the web site see ONE row, never two.
 */

/**
 * Extract the plain phone number from any WhatsApp JID.
 *
 * Handles:
 *   2547xxxxxxxx@s.whatsapp.net  →  "2547xxxxxxxx"
 *   2547xxxxxxxx:3@s.whatsapp.net (device JID) →  "2547xxxxxxxx"
 *   101014040526896@lid           →  "101014040526896"  (LID number only)
 *   2547xxxxxxxx (bare)           →  "2547xxxxxxxx"
 */
export function extractPhone(jid: string): string {
  if (!jid) return "";
  // Strip @server suffix then strip :device suffix
  return jid.split("@")[0].split(":")[0].replace(/\D/g, "") || jid.split("@")[0];
}

/**
 * True when a JID is a LID (101xxx@lid).
 * LIDs look like very large numbers (>15 digits) at @lid server.
 */
export function isLidJid(jid: string): boolean {
  return typeof jid === "string" && jid.endsWith("@lid");
}

/**
 * Convert a plain phone or JID to the standard sendable JID.
 * Always use this when calling sock.sendMessage — never send to @lid.
 *
 * Example: toSendJid("2547xxxxxxxx") → "2547xxxxxxxx@s.whatsapp.net"
 */
export function toSendJid(phoneOrJid: string): string {
  const phone = extractPhone(phoneOrJid);
  return `${phone}@s.whatsapp.net`;
}

/**
 * Attempt to resolve a @lid JID to a real @s.whatsapp.net JID using
 * the group participants list returned by sock.groupMetadata().
 *
 * Returns the resolved JID if found, or the original lid JID unchanged.
 */
export function resolveLidFromParticipants(
  lidJid: string,
  participants: Array<{ id?: string; lid?: string }>
): string {
  for (const p of participants) {
    if (p.id === lidJid || p.lid === lidJid) {
      const real = [p.id, p.lid].find((j) => j?.endsWith("@s.whatsapp.net"));
      if (real) return real;
    }
  }
  return lidJid; // could not resolve — return as-is
}

/**
 * Resolve any JID — including @lid — using group metadata participants.
 * Non-LID JIDs pass through unchanged. @lid JIDs are resolved to
 * @s.whatsapp.net using the participant list if available.
 *
 * Use this everywhere you read mentionedJid[0] before passing the JID
 * to sock.groupParticipantsUpdate(), DB queries, or display text.
 */
export function resolveMentionedJid(
  jid: string,
  groupMeta: { participants?: Array<{ id?: string; lid?: string }> } | null | undefined
): string {
  if (!jid) return jid;
  if (!jid.endsWith("@lid")) return jid; // already a real JID, no-op
  const participants = groupMeta?.participants || [];
  return resolveLidFromParticipants(jid, participants);
}
