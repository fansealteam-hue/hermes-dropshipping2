/**
 * Automatisations : factures, avoirs, numérotation, déclaration URSSAF, rappels Telegram.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
process.env.DB_PATH = ":memory:";
process.env.NODE_ENV = "test";

const db = require("../db/db");
require("../db/migrate");
const auto = require("../services/automation");

db.pragma("foreign_keys = OFF");
const ins = db.prepare(`INSERT INTO sales (sale_id, listing_id, channel, account_id, temu_item_id, variant_id, supplier_url, sale_price_eur_cents, cost_eur_cents,
  status, buyer_name, delivery_city, external_event_id, confirmed_at, updated_at, order_placed_at) VALUES (?, 'l', 'leboncoin', 'lbc_compte_a', 'tm', 'v', 'u', ?, 1000, ?, 'Julie', 'Lyon', ?, ?, ?, ?)`);
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
ins.run("s1", 4500, "confirmed", "e1", iso(2), iso(2), null);
ins.run("s2", 3000, "order_placed", "e2", iso(6), iso(6), iso(5));
ins.run("s3", 2000, "cancelled", "e3", iso(1), iso(1), null);

test("sans nom de vendeur : aucune facture automatique", async () => {
  const r = await auto.runAutomation();
  assert.equal(r.invoices, 0);
  assert.equal(auto.listInvoices().length, 0);
});

test("facturation auto : numéros continus, ventes annulées ignorées", async () => {
  auto.saveSettings({ seller: { first: "Jean", last: "Dupont", prefix: "FA" } });
  const r = await auto.runAutomation();
  assert.equal(r.invoices, 2);
  const y = new Date().getFullYear();
  const nos = auto.listInvoices().map((i) => i.invoiceNo).sort();
  assert.deepEqual(nos, [`FA-${y}-0001`, `FA-${y}-0002`]);
  assert.equal(auto.listInvoices().find((i) => i.saleId === "s2").seller.name, "Jean Dupont");
  assert.equal((await auto.runAutomation()).invoices, 0, "idempotent");
});

test("avoir auto quand une vente facturée est annulée", async () => {
  db.prepare("UPDATE sales SET status = 'cancelled' WHERE sale_id = 's1'").run();
  const r = await auto.runAutomation();
  assert.equal(r.credits, 1);
  const cn = auto.listInvoices().find((i) => i.kind === "credit");
  assert.equal(cn.saleId, "s1");
  assert.equal(cn.amountEur, -45);
  assert.match(cn.refInvoice, /^FA-/);
  assert.match(cn.invoiceNo, /^AV-\d{4}-0001$/);
});

test("reprise des numéros du navigateur + désactivation", async () => {
  ins.run("s4", 1500, "delivered", "e4", iso(3), iso(3), null);
  assert.equal(auto.importInvoices({ s4: "FA-2026-0042", s2: "FA-2026-0099", bad: "x" }), 1, "seule la vente sans facture est reprise");
  auto.saveSettings({ auto: { invoices: false } });
  ins.run("s5", 1500, "confirmed", "e5", iso(0), iso(0), null);
  assert.equal((await auto.runAutomation()).invoices, 0);
  assert.ok(auto.ensureInvoice("s5", { force: true }), "facture manuelle toujours possible");
});

test("déclaration : CA du mois, cotisations, marquer déclaré", () => {
  auto.saveSettings({ urssaf: { mode: "month", rate: 12.3, vl: false } });
  const cur = auto.declarations()[0];
  assert.equal(cur.current, true);
  assert.ok(cur.caEur >= 0);
  const d = auto.setDeclared(cur.key, true);
  assert.ok(d.declaredAt);
  assert.throws(() => auto.setDeclared("n'importe", true), (e) => e.code === "BAD_REQUEST");
});

test("rappel Telegram : payée sans suivi depuis N jours, une fois par jour", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "1:a";
  process.env.TELEGRAM_ALLOWED_CHAT_IDS = "7";
  auto.saveSettings({ auto: { trackingReminders: true }, trackingReminderDays: 3 });
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, o) => { calls.push(JSON.parse(o.body)); return { json: async () => ({ ok: true }) }; };
  try {
    assert.equal(await auto.trackingReminders(), 1);
    assert.equal(await auto.trackingReminders(), 0, "pas deux fois le même jour");
  } finally { globalThis.fetch = orig; }
  assert.match(calls[0].text, /En attente du numéro de suivi/);
  assert.equal(calls[0].reply_markup.inline_keyboard[0][0].callback_data, "add_tracking:s2");
});

test("rappel URSSAF : mois passé non déclaré avec du CA → rappel avec lien urssaf.fr", async () => {
  const now = new Date();
  // vente le mois dernier
  ins.run("s6", 9900, "delivered", "e6", new Date(now.getFullYear(), now.getMonth() - 1, 10).toISOString(), now.toISOString(), null);
  // on se place le 1er du mois pour déclencher le rappel
  const first = new Date(now.getFullYear(), now.getMonth(), 1, 10);
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, o) => { calls.push(JSON.parse(o.body)); return { json: async () => ({ ok: true }) }; };
  try { assert.ok(await auto.declarationReminders(first) >= 1); } finally { globalThis.fetch = orig; }
  assert.match(calls[0].text, /Déclaration URSSAF/);
  assert.match(calls[0].reply_markup.inline_keyboard[0][0].url, /urssaf\.fr/);
});

test("sans Telegram configuré, le rappel n'est pas consommé", async () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  db.prepare("DELETE FROM reminders").run();
  assert.equal(await auto.trackingReminders(), 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reminders").get().n, 0);
});

test("modèles de messages : variables remplies, prénom manquant géré, vide = défaut", () => {
  const t = auto.renderTemplate("Bonjour {prenom} ! Suivi {suivi}{transporteur} → {lien_suivi} · {inconnu}", { buyerName: "Julie Martin", trackingNumber: "LX1FR", trackingCarrier: "Colissimo" });
  assert.equal(t, "Bonjour Julie ! Suivi LX1FR (Colissimo) → https://t.17track.net/fr#nums=LX1FR · {inconnu}");
  assert.equal(auto.renderTemplate("Bonjour {prenom} !", {}), "Bonjour !");
  auto.saveSettings({ templates: { shipping: "Colis parti : {suivi}", cancel: "   " } });
  const st = auto.getSettings();
  assert.equal(st.templates.shipping, "Colis parti : {suivi}");
  assert.match(st.templates.cancel, /n'est plus disponible/, "modèle vide → défaut");
  assert.equal(auto.messageFor("shipping", "s2", { trackingNumber: "ZZ9" }), "Colis parti : ZZ9");
});

test("suivi ajouté → message d'expédition envoyé et visible dans les conversations", async () => {
  require("../services/conversations");
  const handlersQueue = require("../jobs/queue");
  require("../jobs/handlers");
  db.prepare(`INSERT INTO jobs (job_id, operation, payload, status, idempotency_key, run_at, created_at)
              VALUES ('jt', 'sync_tracking', ?, 'pending', 'k-jt', datetime('now'), datetime('now'))`).run(JSON.stringify({ saleId: "s2", trackingNumber: "ZZ9", trackingCarrier: "Colissimo" }));
  await handlersQueue.tick();
  await new Promise((r) => setTimeout(r, 50));
  const conv = require("../services/conversations").listConversations().find((c) => c.lastMessage?.body === "Colis parti : ZZ9");
  assert.ok(conv, "message auto journalisé");
  assert.equal(conv.lastMessage.action, "auto");
  assert.equal(conv.needsYou, false);
});
