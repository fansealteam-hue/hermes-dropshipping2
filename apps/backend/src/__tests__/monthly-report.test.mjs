/**
 * Récap compta mensuel : chiffres, fichier compta (CSV), envoi Telegram une seule fois.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
process.env.DB_PATH = ":memory:";
process.env.NODE_ENV = "test";
process.env.TEMU_SHIPPING_FEE = "2.99";
process.env.REPORT_PDF = "0"; // pas de Chromium en test : rapport envoyé en HTML

const db = require("../db/db");
require("../db/migrate");
const auto = require("../services/automation");
const report = require("../services/monthly-report");

db.pragma("foreign_keys = OFF");
auto.getSettings(); // crée les tables (factures, rappels…)
db.prepare("INSERT INTO seller_accounts (account_id, channel, label, credentials_ref, active, niche, created_at) VALUES ('acc_a', 'leboncoin', 'Maison #1', 'mock_a', 1, 'Maison', datetime('now'))").run();
const ins = db.prepare(`INSERT INTO sales (sale_id, listing_id, channel, account_id, temu_item_id, variant_id, supplier_url, sale_price_eur_cents, cost_eur_cents,
  status, buyer_name, delivery_city, external_event_id, confirmed_at, updated_at) VALUES (?, 'l', 'leboncoin', 'acc_a', 'tm', 'v', 'u', ?, ?, ?, ?, 'Lyon', ?, ?, ?)`);
const oct = (d) => new Date(2026, 9, d, 12).toISOString();
ins.run("o1", 4000, 1000, "delivered", "=HYPERLINK(\"x\")", "e1", oct(3), oct(3));
ins.run("o2", 2500, 800, "order_placed", "Paul", "e2", oct(20), oct(20));
ins.run("o3", 3000, 900, "cancelled", "Zoé", "e3", oct(25), oct(25));
ins.run("n1", 9900, 100, "confirmed", "Novembre", "e4", new Date(2026, 10, 2).toISOString(), new Date(2026, 10, 2).toISOString());

test("chiffres du mois : CA, achats Temu, URSSAF, bénéfice net, annulations à part", () => {
  const r = report.buildReport("2026-10");
  const t = r.totals;
  assert.equal(t.sales, 2);
  assert.equal(t.cancelled, 1);
  assert.equal(t.caEur, 65);
  assert.equal(t.purchasesEur, 23.98); // 10 + 8 + 2 × 2,99 de port
  assert.equal(t.urssafEur, Math.round(65 * t.urssafRatePct) / 100);
  assert.equal(t.netProfitEur, Math.round((65 - 23.98 - t.urssafEur) * 100) / 100);
  assert.equal(r.accounts[0].name, "Maison #1");
  assert.equal(r.niches[0].name, "Maison");
  assert.ok(!r.sales.some((s) => s.saleId === "n1"), "vente de novembre exclue");
});

test("fichier compta : Excel FR (BOM, « ; », virgule décimale), sans formule exécutable", () => {
  const csv = report.toCsv(report.buildReport("2026-10"));
  assert.ok(csv.startsWith("﻿"));
  assert.match(csv, /Chiffre d'affaires \(à déclarer\);65,00/);
  assert.match(csv, /Annulée/);
  assert.ok(!csv.includes(";=HYPERLINK"), "cellule commençant par = neutralisée");
  assert.match(csv, /'=HYPERLINK/);
});

test("trimestre et périodes invalides", () => {
  assert.equal(report.buildReport("quarter:2026-10").totals.sales, 3); // oct + nov
  assert.throws(() => report.periodOf("2026-13"), (e) => e.code === "BAD_REQUEST");
  assert.throws(() => report.periodOf("n'importe quoi"), (e) => e.code === "BAD_REQUEST");
  assert.equal(report.prevMonth(new Date(2026, 0, 1)), "2025-12");
});

test("le 1er du mois : récap + fichier envoyés une seule fois, retenté si Telegram échoue", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "1:a";
  process.env.TELEGRAM_ALLOWED_CHAT_IDS = "111";
  const orig = globalThis.fetch;
  const calls = [];
  let down = true;
  globalThis.fetch = async (url, opts) => {
    if (down) throw new Error("réseau coupé");
    calls.push({ url: String(url), form: opts.body instanceof FormData ? opts.body : null, json: opts.body instanceof FormData ? null : JSON.parse(opts.body) });
    return { status: 200, json: async () => ({ ok: true, result: {} }) };
  };
  try {
    const nov1 = new Date(2026, 10, 1, 9);
    assert.equal(await report.monthlyRecap(nov1), 0, "Telegram coupé : rien de marqué");
    down = false;
    assert.equal(await report.monthlyRecap(nov1), 1);
    assert.equal(await report.monthlyRecap(nov1), 0, "pas de doublon");
    assert.match(calls[0].json.text, /RÉCAP DU MOIS · OCTOBRE 2026/);
    assert.equal(calls[1].form.get("document").name, "tyno-rapport-2026-10.html");
    assert.equal(calls[2].form.get("document").name, "tyno-compta-2026-10.csv");

    // Coché « Déclaré » → fichier de la période renvoyé (une fois)
    auto.setDeclared("month:2026-10", true);
    assert.equal(await report.declaredRecap("month:2026-10"), 1);
    assert.equal(await report.declaredRecap("month:2026-10"), 0);
    assert.match(calls[3].json.text, /DÉCLARÉ · OCTOBRE 2026/);
    assert.equal(calls[4].form.get("document").name, "tyno-compta-2026-10.csv");

    // Lundi : rapport de la semaine écoulée (message + rapport, sans CSV), une fois
    calls.length = 0;
    const mon = new Date(2026, 9, 26, 8); // lundi 26 octobre → semaine du 19 au 25
    assert.equal(await report.weeklyRecap(mon), 1);
    assert.equal(await report.weeklyRecap(mon), 0);
    assert.match(calls[0].json.text, /RAPPORT DE LA SEMAINE/);
    assert.match(calls[0].json.text, /19 au 25 octobre 2026/);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].form.get("document").name, "tyno-rapport-semaine-2026-10-19.html");
  } finally { globalThis.fetch = orig; }
});

test("semaines : du lundi au dimanche, semaine précédente pour comparer", () => {
  const p = report.periodOf("week:2026-10-21"); // un mercredi → ramené au lundi
  assert.equal(p.key, "week:2026-10-19");
  assert.equal(p.start.getDay(), 1);
  assert.equal((p.end - p.start) / 86_400_000, 7);
  assert.equal(report.previousSpec(p), "week:2026-10-12");
  assert.equal(report.prevWeek(new Date(2026, 10, 1)), "week:2026-10-19"); // dimanche 1er nov
  assert.equal(report.previousSpec(report.periodOf("2026-01")), "month:2025-12");
});

test("vrai rapport : comparaison, conseils, PDF/HTML échappé", () => {
  db.prepare("UPDATE seller_accounts SET label = '<script>x</script>' WHERE account_id = 'acc_a'").run();
  const r = report.buildReport("2026-10");
  assert.equal(r.compare.label, "septembre 2026");
  assert.match(report.buildReport("week:2026-10-19").compare.label, /^la semaine du 12/);
  assert.equal(r.compare.caPct, null, "rien en septembre → « nouveau »");
  assert.ok(r.series.length === 31 && r.series.reduce((t, d) => t + d.caEur, 0) === 65);
  assert.ok(r.advice.length >= 1);
  const html = report.toHtml(r);
  assert.match(html, /Rapport du mois/);
  assert.match(html, /Pour augmenter ton bénéfice/);
  assert.ok(!html.includes("<script>x"), "nom de compte échappé");
  assert.ok(!report.recapText(r).includes("<script>"), "message Telegram échappé");
  const nov = report.buildReport("2026-11");
  assert.equal(nov.compare.caPct, Math.round(((99 - 65) / 65) * 100));
});
