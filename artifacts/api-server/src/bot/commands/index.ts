import type { WASocket, proto } from "@whiskeysockets/baileys";

export interface CommandContext {
  sock: WASocket;
  msg: proto.IWebMessageInfo;
  from: string;
  sender: string;
  /**
   * The raw, un-resolved sender JID as received from WhatsApp (may be @lid
   * on newer clients). Used by .reg / .verify to derive an OTP target that
   * matches the actual WhatsApp identity before LID→phone resolution.
   */
  senderRaw: string;
  command: string;
  args: string[];
  isAdmin: boolean;
  isBotAdmin: boolean;
  isOwner: boolean;
  isGroupAdmin: boolean;
  groupMeta: any;
  prefix: string;
  body: string;
  /**
   * All @mentioned JIDs from the message, pre-resolved from @lid to
   * @s.whatsapp.net using the group participant list. Use resolvedMentions[0]
   * instead of msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
   * in every command so @lid mentions work correctly.
   */
  resolvedMentions: string[];
  /**
   * When group metadata lookup fails and sender is still an @lid JID, this
   * holds the real phone-keyed user id resolved from the DB. Empty string if
   * not applicable. Used by dispatch() to avoid false "not registered" errors.
   */
  lidFallbackPhone: string;
}
