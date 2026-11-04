/**
 * Migrations incrémentales pour la base SQLite existante.
 * Idempotentes — peuvent être relancées sans risque.
 *
 * Usage: node src/db/migrate.js [--db <path>]
 */
"use strict";
const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = (() => {
  const idx = process.argv.indexOf("--db");
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return path.join(__dirname, "../../../../data/hermes.db");
})();

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const migrations = [
  {
    id: "001_callback_log",
    up: `CREATE TABLE IF NOT EXISTS callback_log (
      callback_id   TEXT PRIMARY KEY,
      processed_at  TEXT NOT NULL
    )`,
  },
  {
    id: "002_lbc_messages",
    up: `
      CREATE TABLE IF NOT EXISTS lbc_messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        listing_id  TEXT NOT NULL,
        buyer_name  TEXT,
        message     TEXT NOT NULL,
        received_at TEXT NOT NULL,
        replied     INTEGER NOT NULL DEFAULT 0,
        replied_at  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_lbc_messages_listing ON lbc_messages(listing_id);
      CREATE INDEX IF NOT EXISTS idx_lbc_messages_replied ON lbc_messages(replied);
    `,
  },
  {
    id: "003_sales_order_columns",
    up: `
      ALTER TABLE sales ADD COLUMN order_ref TEXT;
      ALTER TABLE sales ADD COLUMN order_placed_at TEXT;
      ALTER TABLE sales ADD COLUMN actual_cost_eur_cents INTEGER;
    `,
    skipIfColumnExists: { table: "sales", column: "order_ref" },
  },
  {
    id: "004_jobs_idempotency_key",
    up: `ALTER TABLE jobs ADD COLUMN idempotency_key TEXT UNIQUE`,
    skipIfColumnExists: { table: "jobs", column: "idempotency_key" },
  },
];

// ─── migration tracker ────────────────────────────────────────────────────────

db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
  id         TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
)`);

function hasColumn(table, column) {
  const info = db.pragma(`table_info(${table})`);
  return info.some((r) => r.name === column);
}

function alreadyApplied(id) {
  return !!db.prepare("SELECT 1 FROM _migrations WHERE id = ?").get(id);
}

for (const m of migrations) {
  if (alreadyApplied(m.id)) {
    console.log(`  skip  ${m.id}`);
    continue;
  }
  if (m.skipIfColumnExists) {
    const { table, column } = m.skipIfColumnExists;
    if (hasColumn(table, column)) {
      db.prepare("INSERT INTO _migrations (id, applied_at) VALUES (?, datetime('now'))").run(m.id);
      console.log(`  skip  ${m.id} (column already exists)`);
      continue;
    }
  }
  try {
    db.exec(m.up);
    db.prepare("INSERT INTO _migrations (id, applied_at) VALUES (?, datetime('now'))").run(m.id);
    console.log(`  apply ${m.id} ✓`);
  } catch (e) {
    console.error(`  FAIL  ${m.id}: ${e.message}`);
    process.exit(1);
  }
}

console.log("Migrations terminées.");
db.close();
