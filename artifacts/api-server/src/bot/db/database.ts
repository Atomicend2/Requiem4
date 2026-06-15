import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

// DATA_DIR env var lets you point the database at a persistent mount (e.g. Render Disk at /data).
// On Render: set DATA_DIR=/data and add a Persistent Disk mounted at /data in the dashboard.
// Locally: defaults to ./data (same as before, no change needed).
const DB_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(process.cwd(), "data");

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const DB_PATH = path.join(DB_DIR, "bot.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
    initSchema(_db);
  }
  return _db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT,
      phone TEXT,
      balance INTEGER DEFAULT 0,
      bank INTEGER DEFAULT 0,
      gems INTEGER DEFAULT 0,
      premium_balance INTEGER DEFAULT 0,
      premium INTEGER DEFAULT 0,
      premium_expiry INTEGER DEFAULT 0,
      xp INTEGER DEFAULT 0,
      level INTEGER DEFAULT 1,
      bio TEXT DEFAULT '',
      age TEXT DEFAULT '',
      profile_picture BLOB,
      profile_background BLOB,
      last_daily INTEGER DEFAULT 0,
      warn_count INTEGER DEFAULT 0,
      registered INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS warnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      reason TEXT,
      warned_by TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT,
      antilink TEXT DEFAULT 'off',
      antilink_action TEXT DEFAULT 'delete',
      antispam TEXT DEFAULT 'off',
      anti_admin TEXT DEFAULT 'off',
      anti_bot TEXT DEFAULT 'off',
      anti_camping TEXT DEFAULT 'off',
      welcome TEXT DEFAULT 'off',
      welcome_msg TEXT DEFAULT '',
      leave TEXT DEFAULT 'off',
      leave_msg TEXT DEFAULT '',
      muted INTEGER DEFAULT 0,
      cards_enabled TEXT DEFAULT 'on',
      spawn_enabled TEXT DEFAULT 'on',
      games_enabled TEXT DEFAULT 'on',
      gambling_enabled TEXT DEFAULT 'on',
      blacklist TEXT DEFAULT '[]',
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS message_counts (
      user_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      last_message INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (user_id, group_id)
    );

    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      tier TEXT NOT NULL,
      series TEXT DEFAULT 'General',
      image_url TEXT DEFAULT '',
      image_data BLOB,
      description TEXT DEFAULT '',
      attack INTEGER DEFAULT 50,
      defense INTEGER DEFAULT 50,
      speed INTEGER DEFAULT 50,
      uploaded_by TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS user_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      card_id TEXT NOT NULL,
      obtained_at INTEGER DEFAULT (unixepoch()),
      lent_to TEXT DEFAULT NULL,
      lent_at INTEGER DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS card_deck (
      user_id TEXT NOT NULL,
      slot INTEGER NOT NULL,
      user_card_id INTEGER NOT NULL,
      PRIMARY KEY (user_id, slot)
    );

    CREATE TABLE IF NOT EXISTS deck_backgrounds (
      user_id TEXT PRIMARY KEY,
      background TEXT DEFAULT 'default'
    );

    CREATE TABLE IF NOT EXISTS auctions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seller_id TEXT NOT NULL,
      user_card_id INTEGER NOT NULL,
      price INTEGER NOT NULL,
      active INTEGER DEFAULT 1,
      buyer_id TEXT DEFAULT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      sold_at INTEGER DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS card_spawns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      card_id TEXT NOT NULL,
      message_id TEXT,
      spawned_at INTEGER DEFAULT (unixepoch()),
      claimed_by TEXT DEFAULT NULL,
      claimed_at INTEGER DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS trade_offers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_user TEXT NOT NULL,
      to_user TEXT NOT NULL,
      from_card INTEGER NOT NULL,
      to_card INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS sell_offers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seller_id TEXT NOT NULL,
      buyer_id TEXT NOT NULL,
      user_card_id INTEGER NOT NULL,
      price INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS guild_members (
      user_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      joined_at INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (user_id)
    );

    CREATE TABLE IF NOT EXISTS guilds (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      description TEXT DEFAULT '',
      level INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS lotteries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT,
      pool INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      winner_id TEXT DEFAULT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      ended_at INTEGER DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS lottery_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lottery_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS afk_users (
      user_id TEXT PRIMARY KEY,
      reason TEXT DEFAULT '',
      started_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      group_id TEXT NOT NULL,
      player1 TEXT NOT NULL,
      player2 TEXT,
      state TEXT NOT NULL,
      current_turn TEXT,
      status TEXT DEFAULT 'waiting',
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS uno_games (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      players TEXT NOT NULL,
      deck TEXT NOT NULL,
      discard TEXT NOT NULL,
      current_player INTEGER DEFAULT 0,
      direction INTEGER DEFAULT 1,
      status TEXT DEFAULT 'waiting',
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS uno_hands (
      game_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      cards TEXT NOT NULL,
      PRIMARY KEY (game_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS word_chain (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      players TEXT NOT NULL,
      last_word TEXT DEFAULT '',
      used_words TEXT DEFAULT '[]',
      current_player INTEGER DEFAULT 0,
      status TEXT DEFAULT 'waiting',
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS rpg_characters (
      user_id TEXT PRIMARY KEY,
      class TEXT DEFAULT 'Warrior',
      hp INTEGER DEFAULT 100,
      max_hp INTEGER DEFAULT 100,
      attack INTEGER DEFAULT 20,
      defense INTEGER DEFAULT 10,
      speed INTEGER DEFAULT 15,
      level INTEGER DEFAULT 1,
      xp INTEGER DEFAULT 0,
      quest_active TEXT DEFAULT NULL,
      dungeon_floor INTEGER DEFAULT 1,
      last_adventure INTEGER DEFAULT 0,
      last_quest INTEGER DEFAULT 0,
      last_raid INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      item TEXT NOT NULL,
      quantity INTEGER DEFAULT 1,
      acquired_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS shop_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      price INTEGER NOT NULL,
      effect TEXT DEFAULT '',
      category TEXT DEFAULT 'general'
    );

    CREATE TABLE IF NOT EXISTS battle_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      challenger TEXT NOT NULL,
      challenged TEXT NOT NULL,
      group_id TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS summer_tokens (
      user_id TEXT PRIMARY KEY,
      tokens INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS staff (
      user_id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      added_by TEXT,
      added_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS mods (
      user_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      added_by TEXT,
      added_at INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (user_id, group_id)
    );

    CREATE TABLE IF NOT EXISTS banned_entities (
      type TEXT NOT NULL,
      target TEXT NOT NULL,
      display TEXT DEFAULT '',
      reason TEXT DEFAULT '',
      added_by TEXT,
      added_at INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (type, target)
    );

    CREATE TABLE IF NOT EXISTS muted_users (
      user_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      muted_by TEXT,
      expires_at INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (user_id, group_id)
    );

    CREATE TABLE IF NOT EXISTS bot_settings (
      key TEXT PRIMARY KEY,
      value BLOB NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch())
    );

    INSERT OR IGNORE INTO shop_items (name, description, price, effect, category) VALUES
      ('Health Potion', 'Restores 50 HP in battle', 500, 'heal:50', 'rpg'),
      ('Elixir', 'Fully restores HP', 2000, 'heal:full', 'rpg'),
      ('Sword', 'Increases attack by 10', 3000, 'attack:10', 'rpg'),
      ('Shield', 'Increases defense by 10', 3000, 'defense:10', 'rpg'),
      ('Speed Boots', 'Increases speed by 10', 3000, 'speed:10', 'rpg'),
      ('Lucky Charm', 'Boosts daily rewards', 1500, 'daily_boost', 'general'),
      ('Guild License', 'Required to create a guild', 11000000, 'guild_license', 'general'),
      ('Rename Sheet', 'Allows you to change your name once', 91000, 'rename', 'general'),
      ('Pistol', 'Required to steal from other players', 15000, 'steal', 'general'),
      ('Iron Helmet', 'Dungeon equipment: reduces dmg by 5', 8000, 'dungeon:helmet:5', 'rpg'),
      ('Iron Chestplate', 'Dungeon equipment: reduces dmg by 10', 18000, 'dungeon:chest:10', 'rpg'),
      ('Iron Sword', 'Dungeon equipment: increases atk by 15', 12000, 'dungeon:sword:15', 'rpg'),
      ('Shadow Cloak', 'Dungeon equipment: increases speed by 8', 10000, 'dungeon:cloak:8', 'rpg'),
      ('Dungeon Key', 'Unlocks special dungeon floors', 5000, 'dungeon_key', 'rpg');
  `);

  db.prepare("UPDATE shop_items SET price = 11000000, description = 'Required to create a guild', effect = 'guild_license', category = 'general' WHERE LOWER(name) = 'guild license'").run();

  // Bank Note system — tiered passive items that expand bank storage capacity
  db.prepare(`
    INSERT OR IGNORE INTO shop_items (name, description, price, effect, category) VALUES
      ('10K Bank Note', 'A certified Requiem Order treasury note bearing the seal of 反逆. Permanently expands your maximum bank storage.', 10000, 'bank_cap:50000', 'passive'),
      ('50K Bank Note', 'A high-value Requiem Order treasury note. Issued to elite operatives of the rebellion. Major bank expansion.', 50000, 'bank_cap:250000', 'passive'),
      ('100K Bank Note', 'A sovereign-grade imperial note. Only the wealthiest members of Requiem Order possess one.', 100000, 'bank_cap:750000', 'passive')
  `).run();

  // Lottery Ticket — used with .lottery command (max 5 per day)
  db.prepare(`
    INSERT OR IGNORE INTO shop_items (name, description, price, effect, category) VALUES
      ('Lottery Ticket', 'A golden ticket to enter the Requiem Order 反逆 global lottery pool. Type .lottery to enter. Max 5 purchases per day.', 5000, 'lottery_ticket', 'lottery')
  `).run();
  db.prepare("DELETE FROM shop_items WHERE LOWER(name) IN ('card pack', 'premium card pack', 'vip pass', 'vip access')").run();
  db.prepare("DELETE FROM inventory WHERE LOWER(item) IN ('card pack', 'premium card pack', 'vip pass', 'vip access')").run();
  // Refresh Requiem Order-rebranded descriptions on existing rows (INSERT OR IGNORE won't update already-seeded items)
  db.prepare("UPDATE shop_items SET description = 'A certified Requiem Order treasury note bearing the seal of 反逆. Permanently expands your maximum bank storage.' WHERE name = '10K Bank Note'").run();
  db.prepare("UPDATE shop_items SET description = 'A high-value Requiem Order treasury note. Issued to elite operatives of the rebellion. Major bank expansion.' WHERE name = '50K Bank Note'").run();
  db.prepare("UPDATE shop_items SET description = 'A sovereign-grade imperial note. Only the wealthiest members of Requiem Order possess one.' WHERE name = '100K Bank Note'").run();
  db.prepare("UPDATE shop_items SET description = 'A golden ticket to enter the Requiem Order 反逆 global lottery pool. Type .lottery to enter. Max 5 purchases per day.' WHERE name = 'Lottery Ticket'").run();

  ensureColumn(db, "users", "last_work", "INTEGER DEFAULT 0");
  ensureColumn(db, "users", "last_dig", "INTEGER DEFAULT 0");
  ensureColumn(db, "users", "last_fish", "INTEGER DEFAULT 0");
  ensureColumn(db, "users", "last_beg", "INTEGER DEFAULT 0");
  ensureColumn(db, "users", "last_gamble", "INTEGER DEFAULT 0");
  ensureColumn(db, "users", "last_slots", "INTEGER DEFAULT 0");
  ensureColumn(db, "users", "last_dice", "INTEGER DEFAULT 0");
  ensureColumn(db, "users", "last_coinflip", "INTEGER DEFAULT 0");
  ensureColumn(db, "users", "last_casino", "INTEGER DEFAULT 0");
  ensureColumn(db, "users", "last_doublebet", "INTEGER DEFAULT 0");
  ensureColumn(db, "users", "last_doublepayout", "INTEGER DEFAULT 0");
  ensureColumn(db, "users", "last_roulette", "INTEGER DEFAULT 0");
  ensureColumn(db, "users", "last_horse", "INTEGER DEFAULT 0");
  ensureColumn(db, "users", "last_spin", "INTEGER DEFAULT 0");
  ensureColumn(db, "users", "dig_uses", "INTEGER DEFAULT 0");
  ensureColumn(db, "users", "dig_date", "TEXT DEFAULT ''");
  ensureColumn(db, "users", "fish_uses", "INTEGER DEFAULT 0");
  ensureColumn(db, "users", "fish_date", "TEXT DEFAULT ''");
  ensureColumn(db, "users", "gamble_uses", "INTEGER DEFAULT 0");
  ensureColumn(db, "users", "gamble_date", "TEXT DEFAULT ''");
  ensureColumn(db, "users", "borrowed_cash", "INTEGER DEFAULT 0");
  ensureColumn(db, "users", "lent_cash", "INTEGER DEFAULT 0");
  ensureColumn(db, "users", "premium_balance", "INTEGER DEFAULT 0");
  ensureColumn(db, "users", "premium", "INTEGER DEFAULT 0");
  ensureColumn(db, "users", "premium_expiry", "INTEGER DEFAULT 0");
  ensureColumn(db, "users", "registered", "INTEGER DEFAULT 0");
  ensureColumn(db, "users", "warn_count", "INTEGER DEFAULT 0");
  ensureColumn(db, "users", "profile_picture", "BLOB");
  ensureColumn(db, "users", "profile_background", "BLOB");
  ensureColumn(db, "users", "profile_picture_video", "BLOB");
  ensureColumn(db, "users", "profile_background_video", "BLOB");
  ensureColumn(db, "groups", "ai_chat", "TEXT DEFAULT 'off'");
  ensureColumn(db, "groups", "echidna_chat", "TEXT DEFAULT 'off'"); // Echidna auto-reply toggle
  ensureColumn(db, "groups", "antilink_action", "TEXT DEFAULT 'delete'");
  ensureColumn(db, "groups", "antispam", "TEXT DEFAULT 'off'");
  ensureColumn(db, "groups", "anti_admin", "TEXT DEFAULT 'off'");
  ensureColumn(db, "groups", "anti_bot", "TEXT DEFAULT 'off'");
  ensureColumn(db, "groups", "anti_camping", "TEXT DEFAULT 'off'");
  ensureColumn(db, "groups", "welcome", "TEXT DEFAULT 'off'");
  ensureColumn(db, "groups", "welcome_msg", "TEXT DEFAULT ''");
  ensureColumn(db, "groups", "leave", "TEXT DEFAULT 'off'");
  ensureColumn(db, "groups", "leave_msg", "TEXT DEFAULT ''");
  ensureColumn(db, "groups", "muted", "INTEGER DEFAULT 0");
  ensureColumn(db, "groups", "cards_enabled", "TEXT DEFAULT 'on'");
  ensureColumn(db, "groups", "spawn_enabled", "TEXT DEFAULT 'on'");
  ensureColumn(db, "groups", "games_enabled", "TEXT DEFAULT 'on'");
  ensureColumn(db, "groups", "gambling_enabled", "TEXT DEFAULT 'on'");
  ensureColumn(db, "groups", "blacklist", "TEXT DEFAULT '[]'");
  ensureColumn(db, "cards", "series", "TEXT DEFAULT 'General'");
  ensureColumn(db, "cards", "image_url", "TEXT DEFAULT ''");
  ensureColumn(db, "cards", "image_data", "BLOB");
  ensureColumn(db, "cards", "description", "TEXT DEFAULT ''");
  ensureColumn(db, "cards", "attack", "INTEGER DEFAULT 50");
  ensureColumn(db, "cards", "defense", "INTEGER DEFAULT 50");
  ensureColumn(db, "cards", "speed", "INTEGER DEFAULT 50");
  ensureColumn(db, "cards", "uploaded_by", "TEXT");
  ensureColumn(db, "staff", "added_by", "TEXT");
  ensureColumn(db, "staff", "added_at", "INTEGER DEFAULT 0");
  ensureColumn(db, "banned_entities", "display", "TEXT DEFAULT ''");
  ensureColumn(db, "banned_entities", "reason", "TEXT DEFAULT ''");
  ensureColumn(db, "banned_entities", "added_by", "TEXT");
  ensureColumn(db, "banned_entities", "added_at", "INTEGER DEFAULT 0");
  ensureColumn(db, "muted_users", "muted_by", "TEXT");
  ensureColumn(db, "muted_users", "expires_at", "INTEGER DEFAULT 0");
  ensureColumn(db, "muted_users", "created_at", "INTEGER DEFAULT 0");
  ensureColumn(db, "rpg_characters", "last_dungeon", "INTEGER DEFAULT 0");
  ensureColumn(db, "groups", "recent_msg_count", "INTEGER DEFAULT 0");
  ensureColumn(db, "groups", "recent_msg_window", "INTEGER DEFAULT 0");
  ensureColumn(db, "groups", "next_spawn_time", "INTEGER DEFAULT 0");
  ensureColumn(db, "groups", "spawn_count_today", "INTEGER DEFAULT 0");
  ensureColumn(db, "groups", "spawn_date", "TEXT DEFAULT ''");
  ensureColumn(db, "groups", "last_spawned_card_id", "TEXT DEFAULT ''");
  ensureColumn(db, "groups", "recent_spawned_cards", "TEXT DEFAULT '[]'");
  ensureColumn(db, "groups", "rpg_enabled", "TEXT DEFAULT 'on'");
  ensureColumn(db, "card_spawns", "spawn_token", "TEXT");
  ensureColumn(db, "users", "is_bot", "INTEGER DEFAULT 0");
  ensureColumn(db, "users", "last_steal", "INTEGER DEFAULT 0");
  ensureColumn(db, "groups", "last_gcl", "INTEGER DEFAULT 0");
  ensureColumn(db, "rpg_characters", "skill_points", "INTEGER DEFAULT 0");
  ensureColumn(db, "cards", "is_animated", "INTEGER DEFAULT 0");
  ensureColumn(db, "users", "gym_badges", "TEXT DEFAULT 'None'");

  // WhatsApp account-linking OTPs — separate from web login OTPs.
  // Keyed by the sender's resolved phone (not JID) so lookups survive LID changes.
  db.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_link_otps (
      wa_sender TEXT PRIMARY KEY,
      phone     TEXT NOT NULL,
      code      TEXT NOT NULL,
      name      TEXT DEFAULT '',
      expires_at INTEGER NOT NULL
    );
  `);

  // whatsapp_id — the sender's resolved phone number as seen by the bot
  // (stored in addition to id which is ALSO the phone, but this column lets
  //  us quickly answer "which user owns WhatsApp number X").
  ensureColumn(db, "users", "whatsapp_id", "TEXT DEFAULT NULL");
  ensureColumn(db, "users", "lottery_tickets_bought_today", "INTEGER DEFAULT 0");
  ensureColumn(db, "users", "lottery_tickets_reset_date", "TEXT DEFAULT ''");
  ensureColumn(db, "users", "registered_at", "INTEGER DEFAULT 0");
  // LID cross-reference: stores the @lid identifier (digits only) so we can
  // look up a user by LID when the bot sees 101xxx@lid before resolving to phone
  ensureColumn(db, "users", "lid", "TEXT DEFAULT NULL");
  // Create index for fast LID lookups (only if not already present)
  try {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_lid ON users (lid) WHERE lid IS NOT NULL");
  } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS bots (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      auth_dir TEXT NOT NULL,
      status TEXT DEFAULT 'disconnected',
      roles TEXT DEFAULT '[]',
      image_url TEXT DEFAULT '',
      pairing_phone TEXT DEFAULT '',
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY,
      created_at INTEGER DEFAULT (unixepoch()),
      expires_at INTEGER NOT NULL
    );
  `);

  // These columns may not exist on older bots table rows — safe to add now that the table exists
  ensureColumn(db, "bots", "is_primary", "INTEGER DEFAULT 0");
  ensureColumn(db, "bots", "menu_image_url", "TEXT DEFAULT ''");
  // Which AI companion personality this bot uses — see bot/commands/personas.ts
  ensureColumn(db, "bots", "persona", "TEXT DEFAULT 'echidna'");

  // Deduplicate shop items — keep only the first row per unique name
  db.exec(`
    DELETE FROM shop_items WHERE id NOT IN (
      SELECT MIN(id) FROM shop_items GROUP BY LOWER(name)
    )
  `);

  ensureColumn(db, "word_chain", "join_deadline", "INTEGER DEFAULT 0");
  ensureColumn(db, "word_chain", "word_deadline", "INTEGER DEFAULT 0");
  ensureColumn(db, "word_chain", "eliminated", "TEXT DEFAULT '[]'");
  // WCG: track round number so we can reduce the time limit as game progresses
  ensureColumn(db, "word_chain", "round_number", "INTEGER DEFAULT 0");

  // UNO: wild card color choice state + Draw4 pending state
  ensureColumn(db, "uno_games", "wild_color", "TEXT DEFAULT ''");
  ensureColumn(db, "uno_games", "pending_draw4", "INTEGER DEFAULT 0");
  ensureColumn(db, "uno_games", "uno_called", "TEXT DEFAULT '[]'");

  // Cards: source tag for API-imported cards
  ensureColumn(db, "cards", "source", "TEXT DEFAULT ''");

  db.exec(`
    CREATE TABLE IF NOT EXISTS frames (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      theme TEXT DEFAULT 'custom',
      svg TEXT,
      image BLOB,
      uploaded_by TEXT NOT NULL DEFAULT 'system',
      created_at INTEGER DEFAULT (unixepoch())
    );
  `);

  ensureColumn(db, "users", "frame_id", "INTEGER DEFAULT NULL");
  ensureColumn(db, "users", "display_id", "TEXT");
  ensureColumn(db, "user_cards", "copy_id", "TEXT");

  // Rename "Rename Sheet📃" → "Rename Sheet" in shop and existing inventories
  db.prepare("UPDATE shop_items SET name = 'Rename Sheet' WHERE name = 'Rename Sheet📃'").run();
  db.prepare("UPDATE inventory SET item = 'Rename Sheet' WHERE item = 'Rename Sheet📃'").run();

  // Back-fill display_id for any existing users that don't have one yet
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const usersWithoutId = db.prepare("SELECT id FROM users WHERE display_id IS NULL OR display_id = ''").all() as Array<{ id: string }>;
  const insertDisplayId = db.prepare("UPDATE users SET display_id = ? WHERE id = ?");
  const usedIds = new Set<string>((db.prepare("SELECT display_id FROM users WHERE display_id IS NOT NULL AND display_id != ''").all() as Array<{ display_id: string }>).map(r => r.display_id));
  for (const row of usersWithoutId) {
    let did = "";
    do { did = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join(""); } while (usedIds.has(did));
    usedIds.add(did);
    insertDisplayId.run(did, row.id);
  }

  // Back-fill copy_id for existing user_cards without one
  const cardsWithoutCopyId = db.prepare("SELECT id FROM user_cards WHERE copy_id IS NULL OR copy_id = ''").all() as Array<{ id: number }>;
  const updateCopyId = db.prepare("UPDATE user_cards SET copy_id = ? WHERE id = ?");
  const usedCopyIds = new Set<string>((db.prepare("SELECT copy_id FROM user_cards WHERE copy_id IS NOT NULL AND copy_id != ''").all() as Array<{ copy_id: string }>).map(r => r.copy_id));
  const cpChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  for (const row of cardsWithoutCopyId) {
    let cid = "";
    do { cid = Array.from({ length: 5 }, () => cpChars[Math.floor(Math.random() * cpChars.length)]).join(""); } while (usedCopyIds.has(cid));
    usedCopyIds.add(cid);
    updateCopyId.run(cid, row.id);
  }

  // ── Shoob card sync tracking ──────────────────────────────────────────────
  // shoob_imported_ids: tracks every Shoob _id / id we have already pulled
  // so .synccards only imports cards we haven't seen before.
  db.exec(`
    CREATE TABLE IF NOT EXISTS shoob_imported_ids (
      shoob_id TEXT PRIMARY KEY,
      local_card_id TEXT NOT NULL,
      imported_at INTEGER DEFAULT (unixepoch())
    );
  `);

  // shoob_sync_log: one row per sync run for .cardlogs to display statistics
  db.exec(`
    CREATE TABLE IF NOT EXISTS shoob_sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_type TEXT NOT NULL,
      started_by TEXT,
      imported INTEGER DEFAULT 0,
      updated INTEGER DEFAULT 0,
      skipped INTEGER DEFAULT 0,
      errors INTEGER DEFAULT 0,
      total_seen INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      ran_at INTEGER DEFAULT (unixepoch())
    );
  `);

  // cards: Shoob identity + full raw card object + media metadata
  // shoob_id  — MongoDB _id from Shoob, used as the ONLY relationship key
  // source    — 'shoob' | 'manual'
  // is_animated — 1 if GIF/WebM/patched card
  // raw_data  — full JSON string of the Shoob card object, stored exactly as returned
  // file_hash — the `file` field from Shoob (e.g. "abc123...f.png" or "...gif")
  // has_webm  — mirrors Shoob has_webm flag
  // has_webp  — mirrors Shoob has_webp flag
  // slug      — Shoob slug field for reference only (never used as key)
  ensureColumn(db, "cards", "shoob_id",    "TEXT DEFAULT NULL");
  ensureColumn(db, "cards", "source",      "TEXT DEFAULT 'manual'");
  ensureColumn(db, "cards", "is_animated", "INTEGER DEFAULT 0");
  ensureColumn(db, "cards", "raw_data",    "TEXT DEFAULT NULL");
  ensureColumn(db, "cards", "file_hash",   "TEXT DEFAULT NULL");
  ensureColumn(db, "cards", "has_webm",    "INTEGER DEFAULT 0");
  ensureColumn(db, "cards", "has_webp",    "INTEGER DEFAULT 0");
  ensureColumn(db, "cards", "slug",        "TEXT DEFAULT NULL");

  // Create index on shoob_id for fast lookup during incremental sync
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cards_shoob_id ON cards (shoob_id) WHERE shoob_id IS NOT NULL;`);

}

function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
