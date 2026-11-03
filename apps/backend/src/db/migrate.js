#!/usr/bin/env node
require("dotenv").config();
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const DB_PATH = process.env.DB_PATH ?? path.join(__dirname, "../../../data/hermes.db");
const SCHEMA_PATH = path.join(__dirname, "schema.sql");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
const schema = fs.readFileSync(SCHEMA_PATH, "utf8");

// Execute each statement separately
schema.split(";").map(s => s.trim()).filter(Boolean).forEach(stmt => {
  try {
    db.exec(stmt + ";");
  } catch (e) {
    if (!e.message.includes("already exists")) throw e;
  }
});

// Seed test accounts (fictitious)
const insertAccount = db.prepare(`
  INSERT OR IGNORE INTO seller_accounts (account_id, channel, label, active, created_at)
  VALUES (?, 'leboncoin', ?, 1, datetime('now'))
`);
insertAccount.run("lbc_compte_a", "Compte LBC Alpha");
insertAccount.run("lbc_compte_b", "Compte LBC Beta");

console.log("[migrate] Database ready at", DB_PATH);
db.close();
