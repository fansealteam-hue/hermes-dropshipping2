require("dotenv").config();
const express = require("express");
const path = require("path");

// Run migrations on startup
require("./db/migrate");

const app = express();
const PORT = process.env.API_PORT ?? 3001;

app.use(express.json());

// API routes
app.use("/api", require("./routes/api"));
app.use("/admin", require("./routes/admin"));

// Serve local media files
const MEDIA_DIR = process.env.MEDIA_DIR ?? require("path").join(__dirname, "../../data/media");
app.use("/media", require("express").static(MEDIA_DIR));

// Health check (no auth)
app.get("/health", (req, res) => res.json({ ok: true }));

// Start job queue ticker
const queue = require("./jobs/queue");
require("./jobs/handlers"); // register handlers

setInterval(() => queue.tick(), parseInt(process.env.JOB_INTERVAL_MS ?? "5000")).unref();

// On startup, re-queue unsent alerts (survive restart)
const db = require("./db/db");
const { randomUUID } = require("crypto");

function requeuePendingAlerts() {
  const unsent = db.prepare(
    "SELECT sale_id FROM sales WHERE alert_sent = 0 AND status != 'closed'"
  ).all();
  for (const { sale_id } of unsent) {
    const key = `alert:${sale_id}`;
    const existing = db.prepare("SELECT 1 FROM jobs WHERE idempotency_key = ? AND status != 'done'").get(key);
    if (!existing) {
      const jobId = `job_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      db.prepare(`
        INSERT OR IGNORE INTO jobs (job_id, operation, payload, status, idempotency_key, run_at, created_at)
        VALUES (?, 'send_alert', ?, 'pending', ?, datetime('now'), datetime('now'))
      `).run(jobId, JSON.stringify({ saleId: sale_id }), key);
    }
  }
  if (unsent.length) console.log(`[startup] Requeued ${unsent.length} pending sale alerts`);
}

requeuePendingAlerts();

// Schedule daily reprice_check job (runs at next :00 then every 24h)
function scheduleRepriceCheck() {
  const REPRICE_INTERVAL_H = parseInt(process.env.REPRICE_INTERVAL_H ?? "24");
  const key = "reprice_check:daily";
  const existing = db.prepare("SELECT 1 FROM jobs WHERE idempotency_key = ? AND status = 'pending'").get(key);
  if (!existing) {
    const jobId = `job_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    db.prepare(
      "INSERT OR IGNORE INTO jobs (job_id, operation, payload, status, idempotency_key, run_at, created_at) VALUES (?,?,?,?,?,datetime('now'),datetime('now'))"
    ).run(jobId, "reprice_check", "{}", "pending", key);
  }
  // Re-schedule next check after interval
  setTimeout(() => {
    db.prepare("DELETE FROM jobs WHERE idempotency_key = ?").run(key);
    scheduleRepriceCheck();
  }, REPRICE_INTERVAL_H * 60 * 60 * 1000).unref();
}

if (process.env.NODE_ENV !== "test") scheduleRepriceCheck();

/**
 * Auto-publisher : enqueue up to DAILY_LISTING_MAX draft listings per day,
 * spread evenly between PUBLISH_HOUR_START and PUBLISH_HOUR_END (local time).
 *
 * Runs every PUBLISH_TICK_MIN minutes. Each tick picks the next draft listing
 * (oldest scheduled_at or created_at), sets run_at so it fires at the next
 * available slot, and enqueues a publish_listing job.
 *
 * Env vars:
 *   DAILY_LISTING_MAX=100   (0 = unlimited, uses all pending drafts)
 *   PUBLISH_HOUR_START=8    (inclusive, local time)
 *   PUBLISH_HOUR_END=18     (exclusive, local time)
 *   PUBLISH_TICK_MIN=6      (minutes between scheduler ticks)
 */
function scheduleAutoPublisher() {
  if (process.env.NODE_ENV === "test") return;

  const DAILY_MAX       = parseInt(process.env.DAILY_LISTING_MAX  ?? "100");
  const HOUR_START      = parseInt(process.env.PUBLISH_HOUR_START ?? "8");
  const HOUR_END        = parseInt(process.env.PUBLISH_HOUR_END   ?? "18");
  const TICK_MIN        = parseInt(process.env.PUBLISH_TICK_MIN   ?? "6");

  function tick() {
    const now = new Date();
    const hour = now.getHours();

    // Only work during the publishing window
    if (hour < HOUR_START || hour >= HOUR_END) return;

    // How many published/scheduled today?
    const todayStr = now.toISOString().slice(0, 10);
    const alreadyRow = db.prepare(`
      SELECT COUNT(*) AS n FROM listings
      WHERE status IN ('published', 'scheduled')
        AND date(COALESCE(scheduled_at, published_at, created_at)) = ?
    `).get(todayStr);
    const already = alreadyRow?.n ?? 0;
    if (DAILY_MAX > 0 && already >= DAILY_MAX) return;

    // Find the oldest draft listing not yet scheduled today
    const draft = db.prepare(`
      SELECT listing_id FROM listings
      WHERE status = 'draft'
        AND NOT EXISTS (
          SELECT 1 FROM jobs
          WHERE operation = 'publish_listing'
            AND status IN ('pending','running')
            AND json_extract(payload, '$.listingId') = listings.listing_id
        )
      ORDER BY COALESCE(scheduled_at, created_at) ASC
      LIMIT 1
    `).get();

    if (!draft) return;

    // Spread slots evenly across the window
    const windowSec = (HOUR_END - HOUR_START) * 3600;
    const slotSec   = DAILY_MAX > 0 ? Math.floor(windowSec / DAILY_MAX) : TICK_MIN * 60;
    const startOfWindow = new Date(now);
    startOfWindow.setHours(HOUR_START, 0, 0, 0);
    const runAt = new Date(startOfWindow.getTime() + already * slotSec * 1000);
    // If the computed slot is in the past or before now, fire immediately
    const runAtIso = runAt <= now ? now.toISOString() : runAt.toISOString();

    const jobId = `job_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const key   = `auto_publish:${draft.listing_id}`;
    db.prepare(`
      INSERT OR IGNORE INTO jobs
        (job_id, operation, payload, status, idempotency_key, run_at, created_at)
      VALUES (?, 'publish_listing', ?, 'pending', ?, ?, datetime('now'))
    `).run(jobId, JSON.stringify({ listingId: draft.listing_id }), key, runAtIso);

    // Mark listing as scheduled
    db.prepare("UPDATE listings SET status = 'scheduled', scheduled_at = ?, updated_at = ? WHERE listing_id = ?")
      .run(runAtIso, now.toISOString(), draft.listing_id);

    console.log(`[autopub] ${draft.listing_id} → schedulé à ${runAtIso} (slot ${already + 1}/${DAILY_MAX || '∞'})`);
  }

  // First tick after a short delay so DB is fully ready
  setTimeout(tick, 5000);
  setInterval(tick, TICK_MIN * 60 * 1000).unref();
}

scheduleAutoPublisher();

// Only start listening when run directly (not when imported by tests)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[backend] Hermès API running on http://localhost:${PORT}`);
  });
}

module.exports = app;
