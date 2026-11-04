/**
 * Retraits du porte-monnaie Leboncoin, par compte vendeur.
 *
 * - Réglages par compte : retrait auto on/off, seuil minimum, fréquence.
 * - Solde "disponible" estimé = ventes livrées − retraits déjà effectués/en cours.
 * - Chaque demande crée une ligne `withdrawals` + un job `withdraw_funds`.
 *
 * Le virement réel côté Leboncoin n'est pas encore automatisé : en production
 * le job passe la demande en statut `verify` (à faire depuis Leboncoin puis à
 * confirmer sur le dashboard). En mode mock/test, il est marqué `done`.
 */
const db = require("../db/db");
const { randomUUID } = require("crypto");

const FREQUENCIES = { daily: 1, weekly: 7, monthly: 30 };

function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS withdrawals (
      withdrawal_id    TEXT PRIMARY KEY,
      account_id       TEXT NOT NULL REFERENCES seller_accounts(account_id),
      amount_eur_cents INTEGER NOT NULL,
      status           TEXT NOT NULL DEFAULT 'pending',  -- pending | verify | done | failed | cancelled
      trigger          TEXT NOT NULL DEFAULT 'manual',   -- manual | auto
      note             TEXT,
      job_id           TEXT,
      created_at       TEXT NOT NULL,
      completed_at     TEXT
    );
  `);
  const addColumn = (sql) => { try { db.exec(sql); } catch (e) { if (!e.message.includes("duplicate column")) throw e; } };
  addColumn("ALTER TABLE seller_accounts ADD COLUMN auto_withdraw INTEGER NOT NULL DEFAULT 0");
  addColumn("ALTER TABLE seller_accounts ADD COLUMN withdraw_threshold_cents INTEGER NOT NULL DEFAULT 2000");
  addColumn("ALTER TABLE seller_accounts ADD COLUMN withdraw_frequency TEXT NOT NULL DEFAULT 'weekly'");
}
let ready = false;
function init() { if (!ready) { ensureSchema(); ready = true; } }

function balances(accountId) {
  init();
  const delivered = db.prepare(
    "SELECT COALESCE(SUM(sale_price_eur_cents), 0) AS c FROM sales WHERE account_id = ? AND status IN ('delivered', 'closed')"
  ).get(accountId).c;
  const pending = db.prepare(
    "SELECT COALESCE(SUM(sale_price_eur_cents), 0) AS c FROM sales WHERE account_id = ? AND status IN ('confirmed', 'order_placed', 'tracking_added')"
  ).get(accountId).c;
  const withdrawn = db.prepare(
    "SELECT COALESCE(SUM(amount_eur_cents), 0) AS c FROM withdrawals WHERE account_id = ? AND status IN ('pending', 'verify', 'done')"
  ).get(accountId).c;
  return { availableCents: Math.max(0, delivered - withdrawn), pendingCents: pending, withdrawnCents: withdrawn };
}

function rowToWithdrawal(r) {
  return {
    withdrawalId: r.withdrawal_id,
    accountId: r.account_id,
    amountEur: r.amount_eur_cents / 100,
    status: r.status,
    trigger: r.trigger,
    note: r.note ?? undefined,
    createdAt: r.created_at,
    completedAt: r.completed_at ?? undefined,
  };
}

function overview() {
  init();
  const accounts = db.prepare("SELECT * FROM seller_accounts WHERE channel = 'leboncoin'").all();
  const history = db.prepare("SELECT * FROM withdrawals ORDER BY created_at DESC LIMIT 200").all().map(rowToWithdrawal);
  return {
    accounts: accounts.map((a) => {
      const b = balances(a.account_id);
      const last = db.prepare("SELECT created_at FROM withdrawals WHERE account_id = ? ORDER BY created_at DESC LIMIT 1").get(a.account_id);
      return {
        accountId: a.account_id,
        label: a.label,
        active: a.active === 1,
        autoWithdraw: a.auto_withdraw === 1,
        thresholdEur: a.withdraw_threshold_cents / 100,
        frequency: a.withdraw_frequency,
        availableEur: b.availableCents / 100,
        pendingEur: b.pendingCents / 100,
        withdrawnEur: b.withdrawnCents / 100,
        lastWithdrawalAt: last?.created_at,
        nextCheckAt: a.auto_withdraw === 1 ? nextCheck(a, last?.created_at) : undefined,
      };
    }),
    history,
  };
}

function nextCheck(account, lastAt) {
  const days = FREQUENCIES[account.withdraw_frequency] ?? 7;
  if (!lastAt) return new Date().toISOString();
  return new Date(new Date(lastAt).getTime() + days * 86_400_000).toISOString();
}

function updateSettings(accountId, { autoWithdraw, thresholdEur, frequency }) {
  init();
  const a = db.prepare("SELECT * FROM seller_accounts WHERE account_id = ?").get(accountId);
  if (!a) throw { code: "NOT_FOUND", message: `Compte ${accountId} introuvable` };
  if (frequency !== undefined && !FREQUENCIES[frequency]) throw { code: "BAD_REQUEST", message: "Fréquence invalide (daily, weekly, monthly)" };
  const threshold = thresholdEur !== undefined ? Math.round(Math.max(0, Number(thresholdEur)) * 100) : a.withdraw_threshold_cents;
  if (Number.isNaN(threshold)) throw { code: "BAD_REQUEST", message: "Seuil invalide" };
  db.prepare("UPDATE seller_accounts SET auto_withdraw = ?, withdraw_threshold_cents = ?, withdraw_frequency = ? WHERE account_id = ?").run(
    autoWithdraw !== undefined ? (autoWithdraw ? 1 : 0) : a.auto_withdraw,
    threshold,
    frequency ?? a.withdraw_frequency,
    accountId
  );
  return overview().accounts.find((x) => x.accountId === accountId);
}

function requestWithdrawal(accountId, { trigger = "manual" } = {}) {
  init();
  const a = db.prepare("SELECT * FROM seller_accounts WHERE account_id = ?").get(accountId);
  if (!a) throw { code: "NOT_FOUND", message: `Compte ${accountId} introuvable` };
  const open = db.prepare("SELECT 1 FROM withdrawals WHERE account_id = ? AND status = 'pending'").get(accountId);
  if (open) throw { code: "CONFLICT", message: "Un retrait est déjà en cours pour ce compte" };
  const { availableCents } = balances(accountId);
  if (availableCents <= 0) throw { code: "EMPTY", message: "Rien à retirer sur ce compte" };

  const now = new Date().toISOString();
  const withdrawalId = `wd_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const jobId = `job_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  db.prepare(`INSERT INTO withdrawals (withdrawal_id, account_id, amount_eur_cents, status, trigger, job_id, created_at)
              VALUES (?, ?, ?, 'pending', ?, ?, ?)`).run(withdrawalId, accountId, availableCents, trigger, jobId, now);
  db.prepare(`INSERT INTO jobs (job_id, operation, account_id, payload, status, idempotency_key, run_at, created_at)
              VALUES (?, 'withdraw_funds', ?, ?, 'pending', ?, datetime('now'), datetime('now'))`)
    .run(jobId, accountId, JSON.stringify({ withdrawalId }), `withdraw:${withdrawalId}`);
  return rowToWithdrawal(db.prepare("SELECT * FROM withdrawals WHERE withdrawal_id = ?").get(withdrawalId));
}

function setStatus(withdrawalId, status, note) {
  init();
  const w = db.prepare("SELECT * FROM withdrawals WHERE withdrawal_id = ?").get(withdrawalId);
  if (!w) throw { code: "NOT_FOUND", message: `Retrait ${withdrawalId} introuvable` };
  const done = ["done", "failed", "cancelled"].includes(status) ? new Date().toISOString() : null;
  db.prepare("UPDATE withdrawals SET status = ?, note = COALESCE(?, note), completed_at = ? WHERE withdrawal_id = ?").run(status, note ?? null, done, withdrawalId);
  return rowToWithdrawal(db.prepare("SELECT * FROM withdrawals WHERE withdrawal_id = ?").get(withdrawalId));
}

/** Appelé périodiquement : déclenche les retraits auto qui ont atteint seuil + fréquence. */
function runAutoWithdrawals() {
  init();
  const accounts = db.prepare("SELECT * FROM seller_accounts WHERE channel = 'leboncoin' AND active = 1 AND auto_withdraw = 1").all();
  const created = [];
  for (const a of accounts) {
    const last = db.prepare("SELECT created_at FROM withdrawals WHERE account_id = ? ORDER BY created_at DESC LIMIT 1").get(a.account_id);
    if (new Date(nextCheck(a, last?.created_at)) > new Date()) continue;
    const { availableCents } = balances(a.account_id);
    if (availableCents < a.withdraw_threshold_cents || availableCents <= 0) continue;
    try { created.push(requestWithdrawal(a.account_id, { trigger: "auto" })); } catch { /* déjà en cours */ }
  }
  return created;
}

module.exports = { overview, updateSettings, requestWithdrawal, setStatus, runAutoWithdrawals, balances };
