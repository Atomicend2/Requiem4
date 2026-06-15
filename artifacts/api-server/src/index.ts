import app from "./app";
import { logger } from "./lib/logger";
import { connectToWhatsApp, gracefulShutdown } from "./bot/connection.js";
import { getDb } from "./bot/db/database.js";
import { seedDefaultFrames } from "./bot/frames.js";
import { loadCardsFromRepo } from "./bot/cards-loader.js";

const rawPort = process.env["PORT"] || "8080";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

getDb();
logger.info("Database initialized");

seedDefaultFrames().catch((err) => {
  logger.error({ err }, "Failed to seed default frames");
});

// Load cards from cards.json (written by GitHub Actions scraper)
loadCardsFromRepo().then((stats) => {
  logger.info(stats, "cards.json → SQLite sync done");
}).catch((err) => {
  logger.warn({ err }, "cards.json loader failed (non-fatal)");
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Graceful shutdown initiated");
  try {
    await gracefulShutdown();
  } catch {}
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

app.listen(port, async (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");

  const phone = process.env["BOT_PHONE_NUMBER"];
  try {
    logger.info("Starting WhatsApp bot...");
    await connectToWhatsApp(phone || undefined, { promptForPhone: false });
  } catch (botErr) {
    logger.error({ botErr }, "Failed to start bot (will retry automatically)");
  }
});
