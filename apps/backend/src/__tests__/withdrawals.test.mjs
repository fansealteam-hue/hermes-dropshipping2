/**
 * Retraits porte-monnaie : solde estimé, réglages, demande manuelle, auto, job.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
process.env.DB_PATH = ":memory:";
process.env.NODE_ENV = "test";

const db = require("../db/db");
require("../db/migrate");
const wd = require("../services/withdrawals");
const queue = require("../jobs/queue");
require("../jobs/handlers");

db.pragma("foreign_keys = OFF");
const insSale = db.prepare(`INSERT INTO sales (sale_id, listing_id, channel, account_id, temu_item_id, variant_id, supplier_url,
  sale_price_eur_cents, cost_eur_cents, status, external_event_id, confirmed_at, updated_at)
  VALUES (?, 'lst', 'leboncoin', ?, 'tm', 'v', 'u', ?, 1000, ?, ?, datetime('now'), datetime('now'))`);
insSale.run("s1", "lbc_compte_a", 3000, "delivered", "e1");
insSale.run("s2", "lbc_compte_a", 2500, "delivered", "e2");
insSale.run("s3", "lbc_compte_a", 4000, "tracking_added", "e3");

test("solde disponible = ventes livrées, en attente = ventes en cours", () => {
  const b = wd.balances("lbc_compte_a");
  assert.equal(b.availableCents, 5500);
  assert.equal(b.pendingCents, 4000);
});

test("retrait manuel : crée le retrait + le job, bloque un doublon, vide le solde", () => {
  const w = wd.requestWithdrawal("lbc_compte_a");
  assert.equal(w.amountEur, 55);
  assert.equal(w.status, "pending");
  const job = db.prepare("SELECT * FROM jobs WHERE operation = 'withdraw_funds'").get();
  assert.ok(job);
  assert.throws(() => wd.requestWithdrawal("lbc_compte_a"), (e) => e.code === "CONFLICT");
  assert.equal(wd.balances("lbc_compte_a").availableCents, 0);
});

test("le job withdraw_funds passe le retrait en done en mode test", async () => {
  await queue.tick();
  await new Promise((r) => setTimeout(r, 50));
  const w = db.prepare("SELECT * FROM withdrawals").get();
  assert.equal(w.status, "done");
  assert.throws(() => wd.requestWithdrawal("lbc_compte_a"), (e) => e.code === "EMPTY");
});

test("retrait auto : respecte le seuil puis la fréquence", () => {
  insSale.run("s4", "lbc_compte_b", 1500, "delivered", "e4");
  wd.updateSettings("lbc_compte_b", { autoWithdraw: true, thresholdEur: 20, frequency: "weekly" });
  assert.equal(wd.runAutoWithdrawals().length, 0, "sous le seuil");
  insSale.run("s5", "lbc_compte_b", 1000, "delivered", "e5");
  const created = wd.runAutoWithdrawals();
  assert.equal(created.length, 1);
  assert.equal(created[0].trigger, "auto");
  assert.equal(created[0].amountEur, 25);
  wd.setStatus(created[0].withdrawalId, "done");
  insSale.run("s6", "lbc_compte_b", 5000, "delivered", "e6");
  assert.equal(wd.runAutoWithdrawals().length, 0, "fréquence hebdo pas encore écoulée");
});

test("réglages invalides refusés", () => {
  assert.throws(() => wd.updateSettings("lbc_compte_a", { frequency: "hourly" }), (e) => e.code === "BAD_REQUEST");
  assert.throws(() => wd.updateSettings("nope", {}), (e) => e.code === "NOT_FOUND");
});
