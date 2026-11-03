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

// Only start listening when run directly (not when imported by tests)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[backend] Hermès API running on http://localhost:${PORT}`);
  });
}

module.exports = app;
