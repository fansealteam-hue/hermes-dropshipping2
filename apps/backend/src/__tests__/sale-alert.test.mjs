/**
 * Alerte de vente Telegram : contenu, disponibilité Temu, boutons, validation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
process.env.DB_PATH = ":memory:";
process.env.NODE_ENV = "test";
process.env.TEMU_SHIPPING_FEE = "2.99";

const db = require("../db/db");
require("../db/migrate");
const alert = require("../services/sale-alert");
const { markOrdered, getSale } = require("../services/sales");

db.pragma("foreign_keys = OFF");
db.prepare("INSERT INTO products (temu_item_id, temu_url, title, warehouse_status, raw_json, fetched_at) VALUES ('tm1', 'https://www.temu.com/p.html', 'Perceuse <21V>', 'local', '{}', datetime('now'))").run();
db.prepare("INSERT INTO variants (variant_id, temu_item_id, sku, label, cost_eur_cents, stock, image_urls, created_at) VALUES ('v1', 'tm1', 's', 'Noir', 1800, 12, '[]', datetime('now'))").run();
db.prepare("INSERT INTO variants (variant_id, temu_item_id, sku, label, cost_eur_cents, stock, image_urls, created_at) VALUES ('v2', 'tm1', 's2', 'Blanc', 1500, 0, '[]', datetime('now'))").run();
const ins = db.prepare(`INSERT INTO sales (sale_id, listing_id, channel, account_id, temu_item_id, variant_id, supplier_url, sale_price_eur_cents, cost_eur_cents,
  status, buyer_name, delivery_city, external_event_id, confirmed_at, updated_at) VALUES (?, 'l', 'leboncoin', 'lbc_compte_a', 'tm1', ?, 'https://www.temu.com/p.html', ?, ?, 'confirmed', 'Julie', 'Lyon', ?, datetime('now'), datetime('now'))`);
ins.run("s_ok", "v1", 4500, 1500, "e1");
ins.run("s_out", "v2", 4000, 1500, "e2");

test("disponibilité : stock, entrepôt et changement de prix Temu", async () => {
  const a = await alert.checkAvailability("s_ok");
  assert.equal(a.available, true);
  assert.equal(a.stock, 12);
  assert.equal(a.warehouse, "local");
  assert.equal(a.costChanged, true); // 15 € à la vente → 18 € maintenant
  const b = await alert.checkAvailability("s_out");
  assert.equal(b.available, false);
  await assert.rejects(alert.checkAvailability("nope"), (e) => e.code === "NOT_FOUND");
});

test("message : compte, article, coût d'achat, bénéfice, dispo ; texte échappé", async () => {
  const a = await alert.checkAvailability("s_ok");
  const txt = alert.buildAlertText(getSale("s_ok"), a, "Compte LBC Alpha");
  assert.match(txt, /Compte LBC Alpha/);
  assert.match(txt, /Perceuse &lt;21V&gt;/);
  assert.match(txt, /Achat Temu : <b>20,99 €/); // 18 € + 2,99 € de port
  assert.match(txt, /Bénéfice : <b>24,01 €/);
  assert.match(txt, /Disponible/);
  assert.match(txt, /Prix Temu changé/);
});

test("fiche courte : même avec un titre très long, tout tient dans la légende de la photo", async () => {
  const a = await alert.checkAvailability("s_ok");
  const sale = { ...getSale("s_ok"), buyerName: "Jean ".repeat(40), deliveryAddress: "12 rue ".repeat(60) };
  const txt = alert.buildAlertText(sale, { ...a, productTitle: "Perceuse ".repeat(80), variantLabel: "Bleu ".repeat(50) }, "Compte ".repeat(30));
  const visible = (txt + "\n✅ Payé ─ 🟠 Commandé ─ ⚪ Expédié ─ ⚪ Reçu\n👉 À valider : prix Temu +20 %").replace(/<[^>]+>/g, "").replace(/&(lt|gt|amp);/g, "x");
  assert.ok(visible.length <= 1024, `légende trop longue : ${visible.length}`);
  assert.ok(txt.trimEnd().endsWith(alert.SEP)); // le statut (mis à jour par le bot) vient après
});

test("boutons : Disponible / Pas disponible (avec confirmation) + revérifier", () => {
  const ok = alert.alertKeyboard("s_ok").inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(ok, ["avail_yes:s_ok", "cancel_ask:s_ok", "check_stock:s_ok"]);
});

test("valider depuis Telegram passe la vente en « commandée » (idempotent)", () => {
  assert.equal(markOrdered("s_ok").status, "order_placed");
  assert.equal(markOrdered("s_ok", { orderRef: "PO-1" }).status, "order_placed");
  assert.throws(() => markOrdered("nope"), (e) => e.code === "NOT_FOUND");
});

test("photos : annonce Leboncoin d'abord, puis variante Temu, sans doublon", () => {
  db.prepare("UPDATE variants SET image_urls = ? WHERE variant_id = 'v1'").run(JSON.stringify(["https://img/v1.jpg"]));
  db.prepare("INSERT INTO listings (listing_id, channel, account_id, temu_item_id, variant_id, title, price_eur_cents, cost_eur_cents, status, media_urls, created_at, updated_at) VALUES ('l', 'leboncoin', 'lbc_compte_a', 'tm1', 'v1', 't', 4500, 1500, 'sold', ?, datetime('now'), datetime('now'))")
    .run(JSON.stringify(["https://img/lbc.jpg", "https://img/v1.jpg"]));
  assert.deepEqual(alert.photoCandidates(getSale("s_ok")), ["https://img/lbc.jpg", "https://img/v1.jpg"]);
});

test("envoi avec photo : sendPhoto avec légende + boutons ; repli si l'URL échoue", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:abc";
  process.env.TELEGRAM_ALLOWED_CHAT_IDS = "111";
  const calls = [];
  const orig = globalThis.fetch;
  let failUrlOnce = true;
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith("https://img/")) return { ok: true, headers: { get: () => "image/jpeg" }, arrayBuffer: async () => new ArrayBuffer(8) };
    const isForm = opts.body instanceof FormData;
    const body = isForm ? Object.fromEntries([...opts.body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : "<file>"])) : JSON.parse(opts.body);
    calls.push({ url, body });
    if (!isForm && body.photo && failUrlOnce) { failUrlOnce = false; return { status: 400, json: async () => ({ ok: false, description: "wrong file identifier" }) }; }
    return { status: 200, json: async () => ({ ok: true, result: {} }) };
  };
  try { assert.equal(await alert.sendSaleAlert("s_ok"), 1); } finally { globalThis.fetch = orig; }
  assert.equal(calls.length, 2, "URL refusée puis upload");
  assert.match(calls[1].url, /sendPhoto$/);
  assert.equal(calls[1].body.photo, "<file>");
  assert.match(calls[1].body.caption, /NOUVELLE VENTE/);
  assert.match(calls[1].body.reply_markup, /avail_yes:s_ok/);
});

test("envoi : appelle l'API Telegram pour chaque chat autorisé", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:abc";
  process.env.TELEGRAM_ALLOWED_CHAT_IDS = "111,222";
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { status: 200, json: async () => ({ ok: true, result: {} }) }; };
  try {
    assert.equal(await alert.sendSaleAlert("s_out"), 2);
  } finally { globalThis.fetch = orig; }
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /bot123:abc\/sendPhoto$/); // photo de l'annonce
  assert.equal(calls[0].body.chat_id, "111");
  assert.equal(calls[0].body.parse_mode, "HTML");
  assert.match(calls[0].body.caption, /Rupture de stock/);
});

test("photo /media/… de l'annonce : lue dans MEDIA_DIR puis uploadée", async () => {
  const fs = require("fs"), os = require("os"), path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "media-"));
  fs.writeFileSync(path.join(dir, "annonce.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
  process.env.MEDIA_DIR = dir;
  process.env.TELEGRAM_BOT_TOKEN = "123:abc";
  process.env.TELEGRAM_ALLOWED_CHAT_IDS = "111";
  db.prepare("UPDATE listings SET media_urls = ? WHERE listing_id = 'l'").run(JSON.stringify(["/media/annonce.jpg"]));
  db.prepare("UPDATE variants SET image_urls = '[]'").run();
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { calls.push({ url, form: opts.body instanceof FormData }); return { status: 200, json: async () => ({ ok: true, result: {} }) }; };
  try { await alert.sendSaleAlert("s_out"); } finally { globalThis.fetch = orig; delete process.env.MEDIA_DIR; }
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /sendPhoto$/);
  assert.equal(calls[0].form, true, "fichier local envoyé en upload");
});

test("décision auto : en stock + rentable + prix stable → commande directe ; sinon on demande", () => {
  const sale = { salePriceEur: 45, costEur: 15 };
  const on = { auto: { autoAvailability: true, autoCancelOutOfStock: false }, maxCostIncreasePct: 15 };
  assert.equal(alert.decide(sale, { available: true, costChanged: false, currentCostEur: 15 }, on).kind, "order");
  assert.equal(alert.decide(sale, { available: true, costChanged: true, currentCostEur: 18 }, on).kind, "ask", "prix +20 % > 15 %");
  assert.match(alert.decide(sale, { available: true, costChanged: true, currentCostEur: 18 }, on).reason, /\+20 %/);
  assert.equal(alert.decide({ salePriceEur: 10, costEur: 15 }, { available: true, currentCostEur: 15 }, on).kind, "ask", "à perte");
  assert.equal(alert.decide(sale, { available: false }, on).kind, "ask");
  assert.equal(alert.decide(sale, { available: false }, { ...on, auto: { ...on.auto, autoCancelOutOfStock: true } }).kind, "cancel");
  assert.equal(alert.decide(sale, { available: true, currentCostEur: 15 }, { ...on, auto: { autoAvailability: false } }).kind, "ask", "désactivé");
  const kb = alert.orderKeyboard("sX", "https://www.temu.com/p.html").inline_keyboard;
  assert.equal(kb[0][0].url, "https://www.temu.com/p.html");
  assert.deepEqual(kb[1].map((b) => b.callback_data), ["confirm_payment:sX", "cancel_ask:sX"]);
});

test("validation groupée : seules les ventes « à commander » passent en commandées", () => {
  const { markOrderedBulk } = require("../services/sales");
  db.prepare(`INSERT INTO sales (sale_id, listing_id, channel, account_id, temu_item_id, variant_id, supplier_url, sale_price_eur_cents, cost_eur_cents,
    status, external_event_id, confirmed_at, updated_at) VALUES ('b1', 'l', 'leboncoin', 'lbc_compte_a', 'tm1', 'v1', 'u', 3000, 1000, 'confirmed', 'eb1', datetime('now'), datetime('now'))`).run();
  const r = markOrderedBulk(["b1", "s_ok", "inconnu", "b1"]);
  assert.deepEqual(r.done, ["b1"]);
  assert.deepEqual(r.skipped.sort(), ["inconnu", "s_ok"]);
  assert.equal(getSale("b1").status, "order_placed");
});

test("annulation automatique en cas de rupture (si activée)", async () => {
  require("../services/automation").saveSettings({ auto: { autoCancelOutOfStock: true } });
  db.prepare(`INSERT INTO sales (sale_id, listing_id, channel, account_id, temu_item_id, variant_id, supplier_url, sale_price_eur_cents, cost_eur_cents,
    status, external_event_id, confirmed_at, updated_at) VALUES ('r1', 'l', 'leboncoin', 'lbc_compte_a', 'tm1', 'v2', 'u', 3000, 1500, 'confirmed', 'er1', datetime('now'), datetime('now'))`).run();
  process.env.TELEGRAM_BOT_TOKEN = "123:abc"; process.env.TELEGRAM_ALLOWED_CHAT_IDS = "111";
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, o) => { calls.push(o.body instanceof FormData ? Object.fromEntries(o.body) : JSON.parse(o.body)); return { status: 200, json: async () => ({ ok: true, result: {} }) }; };
  try { await alert.sendSaleAlert("r1"); } finally { globalThis.fetch = orig; }
  assert.equal(getSale("r1").status, "cancelled");
  assert.ok(db.prepare("SELECT 1 FROM jobs WHERE operation = 'cancel_sale_lbc' AND payload LIKE '%r1%'").get(), "message d'annulation programmé");
  const sent = calls.at(-1);
  assert.match(sent.caption ?? sent.text, /Annulée automatiquement/);
  assert.equal(sent.reply_markup, undefined, "pas de boutons");
  require("../services/automation").saveSettings({ auto: { autoCancelOutOfStock: false } });
});

test("Telegram injoignable : erreur (la file réessaie), la vente n'est pas perdue", async () => {
  process.env.TELEGRAM_BOT_TOKEN = "123:abc";
  process.env.TELEGRAM_ALLOWED_CHAT_IDS = "111";
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("réseau coupé"); };
  try { await assert.rejects(alert.sendSaleAlert("s_ok"), /Alerte non envoyée/); } finally { globalThis.fetch = orig; }
});

test("notification de vente : bouton « Voir la vente sur le site » si SITE_URL est réglé", () => {
  const old = process.env.SITE_URL;
  try {
    delete process.env.SITE_URL;
    assert.ok(!JSON.stringify(alert.alertKeyboard("sX")).includes("Voir la vente"));
    process.env.SITE_URL = "https://tyno.exemple.fr";
    const kb = alert.orderKeyboard("sX", "https://www.temu.com/p.html").inline_keyboard.flat();
    assert.equal(kb.find((b) => b.url?.includes("tyno"))?.url, "https://tyno.exemple.fr/#ventes");
  } finally { if (old === undefined) delete process.env.SITE_URL; else process.env.SITE_URL = old; }
});
