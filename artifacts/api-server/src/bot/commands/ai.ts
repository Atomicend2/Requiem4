import type { CommandContext } from "./index.js";
import { sendText } from "../connection.js";
import { updateGroup } from "../db/queries.js";
import axios from "axios";

const chatSessions: Map<string, Array<{ role: string; content: string }>> = new Map();

export async function handleAI(ctx: CommandContext): Promise<void> {
  const { from, sender, args, command: cmd } = ctx;

  if (cmd === "chat") {
    const val = args[0]?.toLowerCase();
    if (from.endsWith("@g.us")) {
      updateGroup(from, { ai_chat: val === "on" ? "on" : "off" });
      await sendText(from, `🤖 AI Chat ${val === "on" ? "enabled" : "disabled"}.`);
    } else {
      await sendText(from, "❌ This command is for groups.");
    }
    return;
  }

  if (cmd === "ai" || cmd === "gpt") {
    const question = args.join(" ");
    if (!question) {
      await sendText(from, "❌ Usage: .ai [question]");
      return;
    }
    await sendText(from, "🤖 Thinking...");
    try {
      const response = await getAIResponse(question, sender);
      await sendText(from, `🤖 *AI Response:*\n\n${response}`);
    } catch (err) {
      await sendText(from, "❌ AI is unavailable right now. Try again later.");
    }
    return;
  }

  if (cmd === "translate" || cmd === "tt") {
    const lang = args[0];
    const text = args.slice(1).join(" ");
    if (!lang || !text) {
      await sendText(from, "❌ Usage: .translate [lang] [text]\nExample: .translate es Hello world");
      return;
    }
    await sendText(from, "🌐 Translating...");
    try {
      const response = await getAIResponse(`Translate this to ${lang}, respond with only the translation: "${text}"`, sender);
      await sendText(from, `🌐 *Translation (${lang}):*\n\n${response}`);
    } catch {
      await sendText(from, "❌ Translation failed. Try again later.");
    }
    return;
  }
}

async function getAIResponse(prompt: string, userId: string): Promise<string> {
  const PROMPT_URL = "https://api.openai.com/v1/chat/completions";
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    const fallbacks: Record<string, string> = {
      "hello": "Hello! How can I help you today? 👋",
      "hi": "Hey there! 🌟",
      "how are you": "I'm doing great! Ready to help you! 😊",
    };
    const lower = prompt.toLowerCase();
    for (const [key, val] of Object.entries(fallbacks)) {
      if (lower.includes(key)) return val;
    }
    return "I'm here to help! (AI service not configured — contact the bot owner to enable AI)";
  }

  const messages = chatSessions.get(userId) || [];
  messages.push({ role: "user", content: prompt });
  if (messages.length > 10) messages.splice(0, messages.length - 10);

  const resp = await axios.post(PROMPT_URL, {
    model: "gpt-3.5-turbo",
    messages: [
      { role: "system", content: "You are Requiem Order, a helpful WhatsApp bot assistant for Requiem Order (反逆) — the Heavenly Sky community. Be concise and friendly. Use emojis sparingly." },
      ...messages,
    ],
    max_tokens: 300,
  }, {
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    timeout: 15000,
  });

  const reply = resp.data.choices[0].message.content;
  messages.push({ role: "assistant", content: reply });
  chatSessions.set(userId, messages);
  return reply;
}
