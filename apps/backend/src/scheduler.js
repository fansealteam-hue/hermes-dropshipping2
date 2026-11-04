"use strict";
const cron = require("node-cron");
const { enqueueJob } = require("./workers/job-runner");

function parisHour() {
  return parseInt(
    new Intl.DateTimeFormat("fr-FR", {
      timeZone: "Europe/Paris",
      hour: "numeric",
      hour12: false,
    }).format(new Date()),
    10
  );
}

function parisDateHour() {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
  }).format(new Date()).replace(/\//g, "-");
}

function startScheduler() {
  // ── 08h-18h : publication d'annonces (toutes les heures) ─────────────────
  // Enfile un job publish_pending_listings qui prend les annonces draft
  // prêtes et les publie une par une via le worker publish-listing.
  cron.schedule("0 * * * *", () => {
    const h = parisHour();
    if (h < 8 || h >= 18) return;
    const key = `publish_pending:${parisDateHour()}`;
    const jobId = enqueueJob("publish_pending_listings", {}, { idempotencyKey: key });
    if (jobId) console.log(`[scheduler] publish_pending_listings enfilé (${parisDateHour()})`);
  }, { timezone: "Europe/Paris" });

  // ── 18h-08h : recherche nocturne (toutes les heures) ──────────────────────
  // 1. Recherche produits tendance Temu (scraping autorisé, pas d'achat)
  // 2. Recherche prix concurrents LBC/Vinted pour les annonces actives
  // 3. Recherche annonces à republier (non vues depuis >48h)
  cron.schedule("30 * * * *", () => {
    const h = parisHour();
    const isNight = h >= 18 || h < 8;
    if (!isNight) return;
    const dh = parisDateHour();

    const r1 = enqueueJob("research_temu_trends",    {}, { idempotencyKey: `temu_trends:${dh}` });
    const r2 = enqueueJob("research_competitor_prices", {}, { idempotencyKey: `competitor_prices:${dh}` });
    const r3 = enqueueJob("research_republish_candidates", {}, { idempotencyKey: `republish_candidates:${dh}` });
    if (r1 || r2 || r3) console.log(`[scheduler] recherche nocturne enfilée (${dh})`);
  }, { timezone: "Europe/Paris" });

  // ── bump annonces (22h-08h, 1×/h) ────────────────────────────────────────
  cron.schedule("0 * * * *", () => {
    const h = parisHour();
    if (h < 22 && h >= 8) return;
    const key = `bump_all:${parisDateHour()}`;
    const jobId = enqueueJob("bump_all", {}, { idempotencyKey: key });
    if (jobId) console.log(`[scheduler] bump_all enfilé (${parisDateHour()})`);
  }, { timezone: "Europe/Paris" });

  // ── rapport matinal 08h05 ─────────────────────────────────────────────────
  cron.schedule("5 8 * * *", () => {
    const key = `morning_report:${new Date().toISOString().slice(0, 10)}`;
    enqueueJob("morning_report", {}, { idempotencyKey: key });
    console.log("[scheduler] morning_report enfilé");
  }, { timezone: "Europe/Paris" });

  // ── check_stock 09h (tous les jours) ─────────────────────────────────────
  cron.schedule("0 9 * * *", () => {
    const today = new Date().toISOString().slice(0, 10);
    enqueueJob("check_stock", {}, { idempotencyKey: `check_stock:${today}` });
    console.log("[scheduler] check_stock enfilé");
  }, { timezone: "Europe/Paris" });

  // ── auto_reprice 10h (tous les jours) ────────────────────────────────────
  cron.schedule("0 10 * * *", () => {
    const today = new Date().toISOString().slice(0, 10);
    enqueueJob("auto_reprice", {}, { idempotencyKey: `auto_reprice:${today}` });
    console.log("[scheduler] auto_reprice enfilé");
  }, { timezone: "Europe/Paris" });

  // ── rapport hebdomadaire dimanche 20h ─────────────────────────────────────
  cron.schedule("0 20 * * 0", () => {
    const week = new Date().toISOString().slice(0, 10);
    enqueueJob("weekly_report", {}, { idempotencyKey: `weekly_report:${week}` });
    console.log("[scheduler] weekly_report enfilé");
  }, { timezone: "Europe/Paris" });

  console.log("[scheduler] démarré — publication 08h-18h | recherche 18h-08h | bump 22h-08h | rapport 08h05 | stock 09h | reprice 10h | hebdo dim.20h");
}

module.exports = { startScheduler };
