import app from "./app";
import { logger } from "./lib/logger";
import { connectToWhatsApp, gracefulShutdown } from "./bot/connection.js";
import { initDb } from "./bot/db/database.js";
import { seedDefaultFrames, seedTensuraFrames } from "./bot/frames.js";
import { loadCardsFromRepo } from "./bot/cards-loader.js";
import { loadMazokuCards } from "./bot/mazoku-cards-loader.js";
import { initManagedBots } from "./bot/bot-manager.js";

const rawPort = process.env["PORT"] || "5000";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

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

/**
 * Global safety nets. Without these, Node terminates the whole process
 * (often with exit code 134 / SIGABRT) the moment any promise rejects
 * without a .catch() anywhere in the chain — e.g. a stray fire-and-forget
 * call inside a Baileys event listener, a background timer, etc. This is
 * the most likely cause of "bot stops responding after one card command
 * and the instance restarts" — a single unhandled rejection took down the
 * entire server, not just that one command.
 *
 * These handlers must never themselves throw or exit; they only log.
 */
process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled promise rejection — process kept alive");
});

process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception — process kept alive");
});

/** Retry MongoDB + bot init in the background — never crash the HTTP server */
async function initDbWithRetry(maxAttempts = 10, delayMs = 5000): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await initDb();
      logger.info("MongoDB initialized");
      return;
    } catch (err) {
      logger.error({ err, attempt, maxAttempts }, "MongoDB connection failed — retrying...");
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  logger.error("MongoDB failed after all retries — bot features unavailable but HTTP server is still running");
}

async function main() {
  // Start HTTP server FIRST so Render's health check passes immediately.
  const server = app.listen(port, "0.0.0.0", (err?: Error) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }
    logger.info({ port }, "Server listening");
    server.keepAliveTimeout = 120000;
    server.headersTimeout   = 125000;
  });

  // Connect to MongoDB + start bot in background — failures won't kill the server.
  setImmediate(async () => {
    await initDbWithRetry();

    await seedDefaultFrames().catch((err) => {
      logger.error({ err }, "Failed to seed default frames");
    });

    await seedTensuraFrames().catch((err) => {
      logger.error({ err }, "Failed to seed Tensura community frames");
    });

    loadCardsFromRepo().then((stats) => {
      logger.info(stats, "unified_cards.jsonl → MongoDB sync done");
    }).catch((err) => {
      logger.warn({ err }, "unified card loader failed (non-fatal)");
    });

    // Auto-start any managed bots that were previously connected (session restore).
    // This ensures paired bots reconnect without needing to re-pair.
    try {
      logger.info("Restoring managed bot sessions...");
      await initManagedBots();
    } catch (botErr) {
      logger.error({ botErr }, "Failed to restore managed bot sessions");
    }

    // Also start the primary connection (handles the case where no managed bots exist yet)
    const phone = process.env["BOT_PHONE_NUMBER"];
    try {
      logger.info("Starting WhatsApp primary connection...");
      await connectToWhatsApp(phone || undefined, { promptForPhone: false });
    } catch (botErr) {
      logger.error({ botErr }, "Failed to start bot (will retry automatically)");
    }
  });
}

main().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});
