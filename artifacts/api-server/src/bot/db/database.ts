/**
 * MongoDB initialization — replaces better-sqlite3.
 * Call initDb() once at startup. All query functions in queries.ts use
 * the shared MongoDB connection established here.
 */
import { connectMongo, col } from "./mongo.js";

export const DB_DIR = process.env.DATA_DIR || "./data";

export async function initDb(): Promise<void> {
  await connectMongo();
  await ensureIndexes();
  await seedShopItems();
}

async function ensureIndexes(): Promise<void> {
  await Promise.all([
    col("cards").createIndex({ tier: -1, name: 1 }),
    col("cards").createIndex({ source: 1 }),
    col("cards").createIndex({ shoob_id: 1 }, { sparse: true }),
    col("cards").createIndex({ mazoku_id: 1 }, { sparse: true }),
    col("cards").createIndex({ name: "text", series: "text" }, { name: "cards_text_search" }),
    col("user_cards").createIndex({ user_id: 1 }),
    col("user_cards").createIndex({ card_id: 1 }),
    col("users").createIndex({ level: -1, xp: -1 }),
    col("admin_sessions").createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
  ]).catch(() => {});
}

/** Kept for backward compat — throws a clear error instead of a silent bug */
export function getDb(): never {
  throw new Error(
    "getDb() is no longer available — the database is now MongoDB. " +
    "Use the async query functions from queries.ts instead."
  );
}

async function seedShopItems(): Promise<void> {
  const existing = await col("shop_items").countDocuments();
  if (existing === 0) {
    const items = [
      { name: "Fishing Rod", category: "tools", price: 500, description: "Needed to fish", effect: "unlock_fish" },
      { name: "Shovel", category: "tools", price: 500, description: "Needed to dig", effect: "unlock_dig" },
      { name: "Pistol", category: "tools", price: 15000, description: "Required to use .steal", effect: "unlock_steal" },
      { name: "Lottery Ticket", category: "general", price: 500, description: "Enter the weekly lottery draw", effect: "lottery_entry" },
      { name: "Health Pack", category: "rpg", price: 1500, description: "Fully restores HP outside dungeon", effect: "heal:full" },
      { name: "Shield", category: "protection", price: 2000, description: "Protects from theft", effect: "anti_steal" },
      { name: "Lucky Coin", category: "boost", price: 3000, description: "Doubles next daily reward", effect: "double_daily" },
      { name: "Energy Drink", category: "boost", price: 1500, description: "Halves work cooldown", effect: "half_work_cd" },
      { name: "Rope", category: "tools", price: 100, description: "Useful for various tasks", effect: "utility" },
      { name: "Lockpick", category: "tools", price: 800, description: "Improves steal chance", effect: "steal_boost" },
      { name: "Bank Upgrade I", category: "bank", price: 5000, description: "Increases bank limit by $5,000", effect: "bank_cap:5000" },
      { name: "Bank Upgrade II", category: "bank", price: 15000, description: "Increases bank limit by $20,000", effect: "bank_cap:20000" },
      { name: "Bank Upgrade III", category: "bank", price: 50000, description: "Increases bank limit by $100,000", effect: "bank_cap:100000" },
      { name: "XP Boost", category: "boost", price: 2500, description: "2x XP for 1 hour", effect: "xp_boost" },
      { name: "Resurrection Stone", category: "rpg", price: 8000, description: "Revives you in battle with 50% HP", effect: "resurrect" },
      { name: "Mana Potion", category: "rpg", price: 2000, description: "Restores mana in battle", effect: "restore_mana" },
      { name: "Strength Elixir", category: "rpg", price: 3000, description: "Temporarily boosts Strength", effect: "str_boost" },
    ];
    const now = Math.floor(Date.now() / 1000);
    await col("shop_items").insertMany(
      items.map((item) => ({ ...item, created_at: now }))
    );
  }

  // Migration: fix old bank_cap+N format to bank_cap:N so the aggregation regex matches
  await col("shop_items").updateMany(
    { effect: /^bank_cap\+/ },
    [{ $set: { effect: { $replaceAll: { input: "$effect", find: "bank_cap+", replacement: "bank_cap:" } } } }]
  ).catch(() => {});

  // Add new shop items that might not exist yet (idempotent upserts)
  const newItems = [
    { name: "Pistol", category: "tools", price: 15000, description: "Required to use .steal", effect: "unlock_steal" },
    { name: "Lottery Ticket", category: "general", price: 500, description: "Enter the weekly lottery draw", effect: "lottery_entry" },
    { name: "Health Pack", category: "rpg", price: 1500, description: "Fully restores HP outside dungeon", effect: "heal:full" },
  ];
  const now2 = Math.floor(Date.now() / 1000);
  for (const item of newItems) {
    await col("shop_items").updateOne(
      { name: item.name },
      { $setOnInsert: { ...item, created_at: now2 } },
      { upsert: true }
    ).catch(() => {});
  }
}
