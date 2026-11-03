/**
 * Admin routes — operator tools: queue management, job status, account management.
 */
const router = require("express").Router();
const db = require("../db/db");
const queue = require("../jobs/queue");

// ─── Queue controls ───────────────────────────────────────────────────────────

router.post("/queue/pause", (req, res) => {
  queue.pauseGlobal();
  res.json({ ok: true, message: "File en pause globale" });
});

router.post("/queue/resume", (req, res) => {
  queue.resumeGlobal();
  res.json({ ok: true, message: "File reprise" });
});

router.post("/queue/pause-account/:accountId", (req, res) => {
  queue.pauseAccount(req.params.accountId);
  res.json({ ok: true, message: `Compte ${req.params.accountId} en pause` });
});

// ─── Queue status ─────────────────────────────────────────────────────────────

router.get("/queue/status", (req, res) => {
  const summary = db.prepare(`
    SELECT status, COUNT(*) as count FROM jobs GROUP BY status
  `).all();
  const verifyJobs = queue.getVerifyJobs();
  res.json({
    ok: true,
    data: { summary, verifyJobs }
  });
});

router.get("/queue/jobs", (req, res) => {
  const status = req.query.status ?? "pending";
  const jobs = db.prepare(
    "SELECT job_id, operation, status, attempts, last_error, run_at, created_at FROM jobs WHERE status = ? ORDER BY run_at ASC LIMIT 50"
  ).all(status);
  res.json({ ok: true, data: jobs });
});

// Force retry a verify job
router.post("/queue/jobs/:jobId/retry", (req, res) => {
  const job = db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, error: "Job introuvable" });
  db.prepare("UPDATE jobs SET status = 'pending', run_at = datetime('now') WHERE job_id = ?").run(req.params.jobId);
  res.json({ ok: true });
});

// ─── Accounts ────────────────────────────────────────────────────────────────

router.get("/accounts", (req, res) => {
  const accounts = db.prepare("SELECT * FROM seller_accounts ORDER BY created_at DESC").all();
  res.json({ ok: true, data: accounts });
});

router.post("/accounts", (req, res) => {
  const { accountId, channel = "leboncoin", label } = req.body ?? {};
  if (!accountId || !label) return res.status(400).json({ ok: false, error: "accountId et label requis" });
  const { randomUUID } = require("crypto");
  db.prepare(
    "INSERT OR IGNORE INTO seller_accounts (account_id, channel, label, active, created_at) VALUES (?,?,?,1,datetime('now'))"
  ).run(accountId, channel, label);
  res.status(201).json({ ok: true });
});

router.patch("/accounts/:id/toggle", (req, res) => {
  db.prepare("UPDATE seller_accounts SET active = 1 - active WHERE account_id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ─── Events log ──────────────────────────────────────────────────────────────

router.get("/events", (req, res) => {
  const events = db.prepare(
    "SELECT event_id, source, type, processed, received_at FROM events ORDER BY received_at DESC LIMIT 50"
  ).all();
  res.json({ ok: true, data: events });
});

module.exports = router;
