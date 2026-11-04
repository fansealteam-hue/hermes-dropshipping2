-- Hermès database schema
-- All amounts in EUR cents to avoid float issues

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- ─── Products (owned by Claude 2) ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS products (
  temu_item_id    TEXT PRIMARY KEY,
  temu_url        TEXT NOT NULL,
  title           TEXT NOT NULL,
  warehouse_status TEXT NOT NULL DEFAULT 'unknown', -- local | china | unknown
  raw_json        TEXT,  -- full Temu API response
  fetched_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS variants (
  variant_id      TEXT PRIMARY KEY,
  temu_item_id    TEXT NOT NULL REFERENCES products(temu_item_id),
  sku             TEXT,
  label           TEXT NOT NULL,
  cost_eur_cents  INTEGER NOT NULL,  -- fournisseur observé à la préparation
  stock           INTEGER NOT NULL DEFAULT 0,
  image_urls      TEXT NOT NULL,     -- JSON array
  created_at      TEXT NOT NULL
);

-- ─── Seller accounts ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS seller_accounts (
  account_id      TEXT PRIMARY KEY,
  channel         TEXT NOT NULL DEFAULT 'leboncoin',
  label           TEXT NOT NULL,
  active          INTEGER NOT NULL DEFAULT 1,
  credentials_ref TEXT,  -- pointer to secrets store, never stored in plain text
  created_at      TEXT NOT NULL
);

-- ─── Listings ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS listings (
  listing_id          TEXT PRIMARY KEY,
  channel             TEXT NOT NULL DEFAULT 'leboncoin',
  account_id          TEXT NOT NULL REFERENCES seller_accounts(account_id),
  temu_item_id        TEXT NOT NULL REFERENCES products(temu_item_id),
  variant_id          TEXT NOT NULL REFERENCES variants(variant_id),
  title               TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  price_eur_cents     INTEGER NOT NULL,
  cost_eur_cents      INTEGER NOT NULL,  -- preserved at time of listing creation
  media_urls          TEXT NOT NULL DEFAULT '[]',  -- JSON array
  status              TEXT NOT NULL DEFAULT 'draft',
  scheduled_at        TEXT,
  published_at        TEXT,
  leboncoin_ad_id     TEXT,
  external_id         TEXT,  -- platform-specific ID
  channel_active      INTEGER NOT NULL DEFAULT 1,  -- 0 = channel retired (e.g. Vinted)
  delivery_option     TEXT,  -- 'autre' | 'mondial_relay' | 'colissimo' | null
  delivery_fee_eur_cents INTEGER NOT NULL DEFAULT 0,  -- +300 when delivery_option='autre'
  repricing_count     INTEGER NOT NULL DEFAULT 0,    -- nb of times price was lowered
  last_repriced_at    TEXT,                          -- ISO timestamp of last reprice
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_listings_status     ON listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_account_id ON listings(account_id);

CREATE TABLE IF NOT EXISTS listing_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id  TEXT NOT NULL REFERENCES listings(listing_id),
  field       TEXT NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  changed_at  TEXT NOT NULL
);

-- ─── Sales ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sales (
  sale_id                     TEXT PRIMARY KEY,
  listing_id                  TEXT NOT NULL REFERENCES listings(listing_id),
  channel                     TEXT NOT NULL,
  account_id                  TEXT NOT NULL,
  temu_item_id                TEXT NOT NULL,
  variant_id                  TEXT NOT NULL,
  supplier_url                TEXT NOT NULL,
  sale_price_eur_cents        INTEGER NOT NULL,
  cost_eur_cents              INTEGER NOT NULL,  -- supplier cost at time of sale
  actual_cost_eur_cents       INTEGER,           -- amount actually paid (set after purchase)
  status                      TEXT NOT NULL DEFAULT 'confirmed',
  -- delivery (minimal — no full address in logs)
  buyer_name                  TEXT,
  delivery_city               TEXT,  -- city only for internal use
  -- supplier order
  order_ref                   TEXT,
  order_placed_at             TEXT,
  -- tracking
  tracking_number             TEXT,
  tracking_carrier            TEXT,
  tracking_added_at           TEXT,
  -- confirmation
  leboncoin_delivery_confirmed INTEGER NOT NULL DEFAULT 0,
  manual_action_required      INTEGER NOT NULL DEFAULT 0,
  manual_action_note          TEXT,
  -- dedup
  external_event_id           TEXT UNIQUE,  -- platform event ID for deduplication
  alert_sent                  INTEGER NOT NULL DEFAULT 0,
  confirmed_at                TEXT NOT NULL,
  updated_at                  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sales_listing_id ON sales(listing_id);

CREATE TABLE IF NOT EXISTS sale_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id     TEXT NOT NULL REFERENCES sales(sale_id),
  field       TEXT NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  -- no buyer data in history
  changed_at  TEXT NOT NULL
);

-- ─── Job queue ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jobs (
  job_id          TEXT PRIMARY KEY,
  operation       TEXT NOT NULL,   -- publish_listing | send_alert | sync_tracking
  payload         TEXT NOT NULL,   -- JSON
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | failed | verify
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  last_error      TEXT,
  idempotency_key TEXT UNIQUE,     -- prevents re-enqueue of same op
  account_id      TEXT,            -- for per-account pause
  paused_global   INTEGER NOT NULL DEFAULT 0,
  run_at          TEXT NOT NULL,
  started_at      TEXT,
  completed_at    TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_run_at ON jobs(status, run_at);

-- ─── Events (Hermès / webhooks) ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS events (
  event_id        TEXT PRIMARY KEY,
  source          TEXT NOT NULL,   -- hermès | leboncoin | manual
  type            TEXT NOT NULL,
  payload         TEXT NOT NULL,   -- JSON (sanitised — no PII)
  processed       INTEGER NOT NULL DEFAULT 0,
  processed_at    TEXT,
  received_at     TEXT NOT NULL
);

-- ─── Bot sessions ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bot_sessions (
  chat_id     INTEGER PRIMARY KEY,
  state       TEXT NOT NULL DEFAULT 'idle',
  session_json TEXT NOT NULL DEFAULT '{}',
  updated_at  TEXT NOT NULL
);

-- ─── Callback deduplication ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS callback_log (
  callback_id   TEXT PRIMARY KEY,     -- Telegram callback_query.id (unique per query)
  processed_at  TEXT NOT NULL
);

-- ─── LBC messages (inbound buyer messages) ───────────────────────────────────

CREATE TABLE IF NOT EXISTS lbc_messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id    TEXT NOT NULL,
  buyer_name    TEXT,
  message       TEXT NOT NULL,
  received_at   TEXT NOT NULL,
  replied       INTEGER NOT NULL DEFAULT 0,
  replied_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_lbc_messages_listing ON lbc_messages(listing_id);
CREATE INDEX IF NOT EXISTS idx_lbc_messages_replied ON lbc_messages(replied);

-- ─── Vinted archive (preserved, not active) ──────────────────────────────────

CREATE TABLE IF NOT EXISTS vinted_listings_archive (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  original_id     TEXT,
  data_json       TEXT,
  archived_at     TEXT NOT NULL
);
