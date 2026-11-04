"use strict";
const cron = require("node-cron");
const { enqueueJob } = require("./workers/job-runner");

/**
 * Retourne l'heure courante en Europe/Paris (0–23).
 */
function parisHour() {
  return parseInt(
    new Intl.DateTimeFormat("fr-FR", {
      timeZone: "Europe/Paris",
      hour:     "numeric",
      hour12:   false,
    }).format(new Date()),
    10
  );
}

/**
 * Scheduler nocturne — bump toutes les heures entre 22h et 08h Paris.
 * Chaque minute node-cron vérifie l'heure Paris, le bump est enfilé max 1×/h.
 */
function startScheduler() {
  // Bump nocturne : vérifie toutes les heures si on est dans la fenêtre 22h-08h
  cron.schedule("0 * * * *", () => {
    const h = parisHour();
    const isNight = h >= 22 || h < 8;
    if (!isNight) return;

    const dateStr = new Intl.DateTimeFormat("fr-FR", {
      timeZone: "Europe/Paris",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
    }).format(new Date()).replace(/\//g, "-");

    const key = `bump_all:${dateStr}`;
    const jobId = enqueueJob("bump_all", {}, { idempotencyKey: key });
    if (jobId) console.log(`[scheduler] bump_all enfilé (${dateStr})`);
  }, { timezone: "Europe/Paris" });

  // Rapport matinal chaque jour à 08h05 Paris
  cron.schedule("5 8 * * *", () => {
    const key = `morning_report:${new Date().toISOString().slice(0, 10)}`;
    const jobId = enqueueJob("morning_report", {}, { idempotencyKey: key });
    if (jobId) console.log("[scheduler] morning_report enfilé");
  }, { timezone: "Europe/Paris" });

  console.log("[scheduler] démarré — bump nocturne 22h-08h, rapport 08h05 Paris");
}

module.exports = { startScheduler };
