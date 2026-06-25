import { MongoClient, Db, ObjectId, Collection } from "mongodb";
export { ObjectId };

let _client: MongoClient | null = null;
let _db: Db | null = null;

export async function connectMongo(): Promise<void> {
  if (_db) return;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI environment variable is not set");
  _client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  await _client.connect();
  _db = _client.db();
  await ensureIndexes(_db);
  console.log("[MongoDB] Connected successfully");
}

export function getMongoDb(): Db {
  if (!_db) throw new Error("MongoDB not initialized — call connectMongo() first");
  return _db;
}

export function col(name: string): Collection {
  return getMongoDb().collection(name);
}

async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection("users").createIndex({ lid: 1 }, { sparse: true }),
    db.collection("users").createIndex({ display_id: 1 }, { sparse: true }),
    db.collection("users").createIndex({ level: -1, xp: -1 }),
    db.collection("users").createIndex({ balance: -1 }),
    db.collection("groups").createIndex({ name: 1 }, { sparse: true }),
    db.collection("user_cards").createIndex({ user_id: 1 }),
    db.collection("user_cards").createIndex({ card_id: 1 }),
    db.collection("user_cards").createIndex({ copy_id: 1 }, { unique: true }),
    db.collection("card_deck").createIndex({ user_id: 1, slot: 1 }),
    db.collection("card_spawns").createIndex({ group_id: 1 }),
    db.collection("auctions").createIndex({ active: 1, created_at: -1 }),
    db.collection("message_counts").createIndex({ group_id: 1 }),
    db.collection("lotteries").createIndex({ active: 1 }),
    db.collection("banned_entities").createIndex({ type: 1 }),
    db.collection("muted_users").createIndex({ group_id: 1 }),
    db.collection("mods").createIndex({ group_id: 1 }),
    db.collection("staff").createIndex({ role: 1 }),
    db.collection("frames").createIndex({ name: 1 }),
    db.collection("wa_auth").createIndex({ bot_id: 1 }),
    db.collection("shoob_imported_ids").createIndex({ imported_at: -1 }),
    db.collection("world_events").createIndex({ created_at: -1 }),
    db.collection("world_events").createIndex({ type: 1 }),
    db.collection("world_history").createIndex({ created_at: -1 }),
    db.collection("rumors").createIndex({ created_at: -1, credibility: 1 }),
    db.collection("territories").createIndex({ controller: 1 }),
    // Fast full-text card search across name + series (50k+ cards)
    db.collection("cards").createIndex(
      { name: "text", series: "text" },
      { name: "cards_text_search", weights: { name: 2, series: 1 } }
    ),
    // Prevent duplicate card entries from concurrent sync runs
    db.collection("cards").createIndex({ shoob_id: 1 }, { sparse: true, unique: true, name: "cards_shoob_id_unique" }),
    db.collection("cards").createIndex({ mazoku_id: 1 }, { sparse: true, unique: true, name: "cards_mazoku_id_unique" }),
  ]).catch((e) => {
    // Log index errors but don't crash — some may already exist with different options
    console.warn("[MongoDB] Index setup warning:", e?.message || e);
  });
}
