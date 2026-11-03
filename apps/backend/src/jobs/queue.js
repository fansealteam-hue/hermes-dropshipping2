/**
 * Persistent job queue with bounded retries and global/per-account pause.
 * Claude 3 (publish_listing) and Claude 4 (send_alert) implement the handlers.
 */
const db = require("../db/db");
const { randomUUID } = require("crypto");

const MAX_CONCURRENT = parseInt(process.env.JOB_CONCURRENCY ?? "2");
let running = 0;

const handlers = {};

function register(operation, handler) {
  handlers[operation] = handler;
}

async function tick() {
  if (running >= MAX_CONCURRENT) return;

  const paused = db.prepare("SELECT 1 FROM jobs WHERE paused_global = 1 LIMIT 1").get();
  if (paused) return;

  const jobs = db.prepare(`
    SELECT * FROM jobs
    WHERE status = 'pending'
      AND run_at <= datetime('now')
      AND paused_global = 0
      AND attempts < max_attempts
    ORDER BY run_at ASC
    LIMIT ?
  `).all(MAX_CONCURRENT - running);

  for (const job of jobs) {
    running++;
    runJob(job).finally(() => running--);
  }
}

async function runJob(job) {
  const now = new Date().toISOString();
  db.prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = ? WHERE job_id = ?").run(now, job.job_id);

  const handler = handlers[job.operation];
  if (!handler) {
    db.prepare("UPDATE jobs SET status = 'failed', last_error = ? WHERE job_id = ?").run("No handler registered", job.job_id);
    return;
  }

  try {
    const payload = JSON.parse(job.payload);
    await handler(payload, job);
    db.prepare("UPDATE jobs SET status = 'done', completed_at = ? WHERE job_id = ?").run(new Date().toISOString(), job.job_id);
  } catch (err) {
    const attempts = job.attempts + 1;
    const newStatus = attempts >= job.max_attempts ? "failed" : "pending";
    // Exponential backoff: 2^attempt minutes
    const delayMs = Math.pow(2, attempts) * 60_000;
    const runAt = new Date(Date.now() + delayMs).toISOString();

    // After send → before receive: mark as 'verify' to check remote state
    const isExternalOp = ["publish_listing", "sync_tracking"].includes(job.operation);
    const status = isExternalOp && attempts >= 1 ? "verify" : newStatus;

    db.prepare("UPDATE jobs SET status = ?, last_error = ?, run_at = ? WHERE job_id = ?").run(
      status, err.message ?? String(err), runAt, job.job_id
    );

    if (status === "verify") {
      console.warn(`[queue] Job ${job.job_id} (${job.operation}) needs verification after failure`);
    }
  }
}

function pauseGlobal() {
  db.prepare("UPDATE jobs SET paused_global = 1 WHERE status = 'pending'").run();
}

function resumeGlobal() {
  db.prepare("UPDATE jobs SET paused_global = 0 WHERE status = 'pending'").run();
}

function pauseAccount(accountId) {
  db.prepare("UPDATE jobs SET paused_global = 1 WHERE account_id = ? AND status = 'pending'").run(accountId);
}

function getVerifyJobs() {
  return db.prepare("SELECT * FROM jobs WHERE status = 'verify'").all();
}

module.exports = { register, tick, pauseGlobal, resumeGlobal, pauseAccount, getVerifyJobs };
