#!/usr/bin/env node
require("dotenv").config();
const fs = require("fs");
const path = require("path");

const DB_PATH = process.env.DB_PATH ?? path.join(__dirname, "../../../data/hermes.db");

// When called as a module, use the shared db connection to support :memory: in tests
function runMigrations(db) {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  schema.split(";").map(s => s.trim()).filter(Boolean).forEach(stmt => {
    try { db.exec(stmt + ";"); } catch (e) { if (!e.message.includes("already exists")) throw e; }
  });
  const ins = db.prepare("INSERT OR IGNORE INTO seller_accounts (account_id, channel, label, active, created_at) VALUES (?, 'leboncoin', ?, 1, datetime('now'))");
  ins.run("lbc_compte_a", "Compte LBC Alpha");
  ins.run("lbc_compte_b", "Compte LBC Beta");

  // Incremental column additions (idempotent — ignore "duplicate column" errors)
  const addColumn = (sql) => { try { db.exec(sql); } catch (e) { if (!e.message.includes("duplicate column")) throw e; } };
  addColumn("ALTER TABLE listings ADD COLUMN delivery_option TEXT");
  addColumn("ALTER TABLE listings ADD COLUMN delivery_fee_eur_cents INTEGER NOT NULL DEFAULT 0");
  addColumn("ALTER TABLE listings ADD COLUMN repricing_count INTEGER NOT NULL DEFAULT 0");
  addColumn("ALTER TABLE listings ADD COLUMN last_repriced_at TEXT");

  // Performance indexes (idempotent — CREATE INDEX IF NOT EXISTS)
  db.exec("CREATE INDEX IF NOT EXISTS idx_listings_status     ON listings(status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_listings_account_id ON listings(account_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_sales_listing_id    ON sales(listing_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_status_run_at  ON jobs(status, run_at)");
}

if (require.main === module) {
  // Standalone script: create own DB connection
  const Database = require("better-sqlite3");
  if (DB_PATH !== ":memory:") fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  console.log("[migrate] Database ready at", DB_PATH);
  db.close();
} else {
  // Loaded as module: migrate the shared db singleton
  const db = require("./db");
  runMigrations(db);
  console.log("[migrate] Migrations applied");
}

module.exports = { runMigrations };
