"use strict";
const db = require("../db/db");
const { randomUUID } = require("crypto");

const { downloadProductPhotos } = require("./photo-pipeline");
const { publishListing }        = require("./publish-listing");
const { syncTracking }          = require("./tracking-sync");

const TICK_MS = 30_000;
const BATCH   = 10;

let _running = false;
let _interval = null;

// ─── Dispatch ─────────────────────────────────────────────────────────────────

async function _dispatch(job) {
  const payload = JSON.parse(job.payload ?? "{}");
  switch (job.operation) {
    case "photo_pipeline":
      return downloadProductPhotos(payload.temuItemId, payload.imageUrls ?? []);
    case "publish_listing":
      return publishListing(payload);
    case "sync_tracking":
      return syncTracking(payload);
    case "process_extension_import":
      // Import depuis l'extension Chrome — traitement minimal : marquer le produit comme importé
      if (!payload.temuUrl) return { ok: false, error: "temuUrl manquant" };
      console.log(`[job-runner] extension_import: ${payload.temuUrl}`);
      return { ok: true };
    case "publish_pending_listings":
      return _publishPendingListings();
    case "bump_all":
      console.log("[job-runner] bump_all — stub");
      return { ok: true };
    case "research_temu_trends":
      return _researchTemuTrends();
    case "research_competitor_prices":
      return _researchCompetitorPrices();
    case "research_republish_candidates":
      return _researchRepublishCandidates();
    case "morning_report":
      return _runMorningReport();
    default:
      return { ok: false, error: `Opération inconnue: ${job.operation}` };
  }
}

// ─── Publication annonces (08h-18h) ──────────────────────────────────────────

async function _publishPendingListings() {
  const drafts = db.prepare(`
    SELECT listing_id, channel, account_id FROM listings
    WHERE status = 'draft'
      AND (scheduled_at IS NULL OR scheduled_at <= datetime('now'))
    LIMIT 20
  `).all();

  let published = 0;
  for (const l of drafts) {
    const jobId = enqueueJob("publish_listing", {
      listingId: l.listing_id,
      channel:   l.channel,
      accountId: l.account_id,
    });
    if (jobId) published++;
  }
  console.log(`[job-runner] publish_pending: ${published} annonce(s) enfilée(s)`);
  return { ok: true, published };
}

// ─── Recherche nocturne (18h-08h) ────────────────────────────────────────────

async function _researchTemuTrends() {
  // Stub : en production, scraper les catégories tendance Temu
  // et enregistrer les nouveaux produits potentiels dans une table
  // research_suggestions (jamais d'achat automatique).
  console.log("[job-runner] research_temu_trends — stub (pas de credentials Temu configurées)");
  return { ok: true, note: "stub — implémenter avec credentials Temu" };
}

async function _researchCompetitorPrices() {
  // Stub : comparer nos prix actifs avec les annonces similaires LBC/Vinted
  const actives = db.prepare(`
    SELECT listing_id, title, price_eur_cents FROM listings WHERE status = 'active' LIMIT 50
  `).all();
  console.log(`[job-runner] research_competitor_prices — ${actives.length} annonce(s) à analyser (stub)`);
  return { ok: true, analyzed: actives.length };
}

async function _researchRepublishCandidates() {
  // Annonces actives non vues depuis >48h → candidats à republier
  const candidates = db.prepare(`
    SELECT listing_id, title, last_repriced_at FROM listings
    WHERE status = 'active'
      AND (last_repriced_at IS NULL OR last_repriced_at < datetime('now', '-48 hours'))
    LIMIT 20
  `).all();

  let enqueued = 0;
  for (const l of candidates) {
    const jobId = enqueueJob("republish_listing", { listingId: l.listing_id });
    if (jobId) enqueued++;
  }
  console.log(`[job-runner] research_republish_candidates: ${enqueued} candidat(s) enfilé(s)`);
  return { ok: true, enqueued };
}

// ─── Rapport matinal ─────────────────────────────────────────────────────────

async function _runMorningReport() {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    return { ok: false, error: "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID non configurés" };
  }

  try {
    const activeSales = db.prepare(
      "SELECT COUNT(*) AS n FROM sales WHERE status NOT IN ('closed','cancelled')"
    ).get().n;

    const failedJobs = db.prepare(`
      SELECT COUNT(*) AS n FROM jobs
      WHERE status = 'failed' AND date(completed_at) = date('now','-1 day')
    `).get().n;

    const draftListings = db.prepare(
      "SELECT COUNT(*) AS n FROM listings WHERE status = 'draft'"
    ).get().n;

    const text = [
      "☀️ *Rapport matinal Tyno*",
      "",
      `🛒 Ventes actives : *${activeSales}*`,
      `📋 Annonces draft : *${draftListings}*`,
      failedJobs > 0 ? `⚠️ Jobs échoués hier : *${failedJobs}*` : "✅ Aucun job échoué hier",
    ].join("\n");

    const { sendNotification } = require("../../telegram/src/bot");
    await sendNotification(text);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── Tick principal ───────────────────────────────────────────────────────────

async function _tick() {
  if (_running) return;
  _running = true;

  try {
    const jobs = db.prepare(`
      SELECT * FROM jobs
      WHERE status = 'pending' AND run_at <= datetime('now')
      ORDER BY run_at ASC
      LIMIT ${BATCH}
    `).all();

    for (const job of jobs) {
      // Acquisition atomique : évite le double-traitement
      const acquired = db.prepare(`
        UPDATE jobs SET status = 'running', started_at = datetime('now'), attempts = attempts + 1
        WHERE job_id = ? AND status = 'pending'
      `).run(job.job_id);

      if (acquired.changes === 0) continue; // déjà pris par un autre tick

      let result;
      try {
        result = await _dispatch(job);
      } catch (e) {
        result = { ok: false, error: e.message };
      }

      if (result.ok) {
        db.prepare(`
          UPDATE jobs SET status = 'done', completed_at = datetime('now'), last_error = NULL
          WHERE job_id = ?
        `).run(job.job_id);
      } else {
        const attempts = job.attempts + 1; // après incrément
        if (attempts >= job.max_attempts) {
          db.prepare(`
            UPDATE jobs SET status = 'failed', completed_at = datetime('now'), last_error = ?
            WHERE job_id = ?
          `).run(result.error ?? "unknown", job.job_id);
          console.error(`[job-runner] FAILED ${job.job_id} (${job.operation}): ${result.error}`);
        } else {
          db.prepare(`
            UPDATE jobs
            SET status = 'pending', last_error = ?, run_at = datetime('now', '+30 minutes')
            WHERE job_id = ?
          `).run(result.error ?? "unknown", job.job_id);
          console.warn(`[job-runner] retry ${job.job_id} (${job.operation}) — tentative ${attempts}/${job.max_attempts}`);
        }
      }
    }
  } finally {
    _running = false;
  }
}

function startJobRunner() {
  if (_interval) return;
  _interval = setInterval(_tick, TICK_MS);
  _interval.unref();
  console.log(`[job-runner] démarré (tick toutes les ${TICK_MS / 1000}s)`);
}

function stopJobRunner() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

/** Enfile un job en vérifiant l'idempotency_key. */
function enqueueJob(operation, payload, { runAt = "now", idempotencyKey, maxAttempts = 3 } = {}) {
  const key = idempotencyKey ?? `${operation}:${randomUUID()}`;
  const existing = db.prepare(
    "SELECT 1 FROM jobs WHERE idempotency_key = ? AND status IN ('pending','running')"
  ).get(key);
  if (existing) return null;

  const jobId = `job_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const runAtSql = runAt === "now" ? "datetime('now')" : `datetime('${runAt}')`;
  db.prepare(`
    INSERT OR IGNORE INTO jobs
      (job_id, operation, payload, status, idempotency_key, max_attempts, run_at, created_at)
    VALUES (?, ?, ?, 'pending', ?, ?, ${runAtSql}, datetime('now'))
  `).run(jobId, operation, JSON.stringify(payload), key, maxAttempts);
  return jobId;
}

module.exports = { startJobRunner, stopJobRunner, enqueueJob };
