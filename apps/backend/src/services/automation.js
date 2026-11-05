/**
 * Automatisations « de A à Z » côté serveur :
 *  - facturation automatique (numérotation continue FA-AAAA-NNNN, enregistrée en base)
 *  - avoirs automatiques quand une vente facturée est annulée (AV-AAAA-NNNN)
 *  - préparation de la déclaration URSSAF (CA par mois / trimestre, cotisations, échéance)
 *  - rappels Telegram : commande payée sans numéro de suivi, déclaration à faire
 *
 * Ce qui reste manuel (pas d'accès possible sans tes identifiants) : le paiement sur Temu,
 * la récupération du numéro de suivi chez Temu, l'envoi de la déclaration sur urssaf.fr.
 */
const db = require("../db/db");

const DEFAULT_SETTINGS = {
  seller: { first: "", last: "", company: "", address: "", email: "", siret: "", vatNumber: "", vat: "TVA non applicable, art. 293 B du CGI", prefix: "FA" },
  auto: { invoices: true, creditNotes: true, trackingReminders: true, declarationReminders: true, autoAvailability: true, autoCancelOutOfStock: false },
  maxCostIncreasePct: 15,
  trackingReminderDays: 3,
  urssaf: { mode: "month", rate: 12.3, vl: false },
  templates: {
    shipping: "Bonjour {prenom} ! Votre colis est en route 📦\nN° de suivi : {suivi}{transporteur}\nSuivre le colis : {lien_suivi}\nMerci pour votre achat et bonne journée !",
    cancel: "Bonjour {prenom}, je suis désolé(e) mais « {produit} » n'est plus disponible. Votre paiement ne sera pas débité ou vous sera remboursé par Leboncoin. Toutes mes excuses pour la gêne occasionnée.",
    sold: "Bonjour ! Désolé, « {produit} » vient d'être vendu. N'hésitez pas à regarder mes autres annonces 😊",
    delivered: "Bonjour {prenom}, j'espère que « {produit} » vous plaît ! Si tout est bon, pensez à confirmer la réception sur Leboncoin. Merci et à bientôt !",
  },
};
const TEMPLATE_KEYS = ["shipping", "cancel", "sold", "delivered"];

let ready = false;
function init() {
  if (ready) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invoices (
      invoice_no    TEXT PRIMARY KEY,
      kind          TEXT NOT NULL DEFAULT 'invoice',   -- invoice | credit
      sale_id       TEXT NOT NULL,
      ref_invoice   TEXT,                              -- facture annulée (pour un avoir)
      amount_cents  INTEGER NOT NULL,
      buyer_name    TEXT,
      buyer_city    TEXT,
      item_title    TEXT,
      account_id    TEXT,
      seller_json   TEXT NOT NULL,                     -- infos vendeur figées au moment de l'émission
      issued_at     TEXT NOT NULL,
      UNIQUE (sale_id, kind)
    );
    CREATE TABLE IF NOT EXISTS declarations (
      period_key   TEXT PRIMARY KEY,                   -- month:2026-10 | quarter:2026-07
      declared_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reminders (
      key     TEXT PRIMARY KEY,                        -- ex. track:<sale>:<date> ou decl:<période>:<date>
      sent_at TEXT NOT NULL
    );
  `);
  ready = true;
}

// ─── Réglages ────────────────────────────────────────────────────────────────

function getSettings() {
  init();
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'automation'").get();
  let v = {};
  try { v = row ? JSON.parse(row.value) : {}; } catch { v = {}; }
  return {
    ...DEFAULT_SETTINGS, ...v,
    seller: { ...DEFAULT_SETTINGS.seller, ...(v.seller ?? {}) },
    auto: { ...DEFAULT_SETTINGS.auto, ...(v.auto ?? {}) },
    urssaf: { ...DEFAULT_SETTINGS.urssaf, ...(v.urssaf ?? {}) },
    templates: { ...DEFAULT_SETTINGS.templates, ...(v.templates ?? {}) },
  };
}

function saveSettings(patch = {}) {
  init();
  const cur = getSettings();
  const clean = (o, allowed) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => allowed.includes(k)));
  const next = {
    ...cur,
    seller: { ...cur.seller, ...clean(patch.seller, Object.keys(DEFAULT_SETTINGS.seller)) },
    auto: { ...cur.auto, ...clean(patch.auto, Object.keys(DEFAULT_SETTINGS.auto)) },
    urssaf: { ...cur.urssaf, ...clean(patch.urssaf, Object.keys(DEFAULT_SETTINGS.urssaf)) },
    templates: { ...cur.templates, ...clean(patch.templates, TEMPLATE_KEYS) },
  };
  for (const k of TEMPLATE_KEYS) {
    const t = String(next.templates[k] ?? "").slice(0, 1000);
    next.templates[k] = t.trim() ? t : DEFAULT_SETTINGS.templates[k]; // vide = modèle par défaut
  }
  if (patch.maxCostIncreasePct !== undefined) next.maxCostIncreasePct = Math.max(0, Math.min(100, parseFloat(patch.maxCostIncreasePct) || 0));
  if (patch.trackingReminderDays !== undefined) next.trackingReminderDays = Math.max(1, Math.min(30, parseInt(patch.trackingReminderDays) || 3));
  for (const k of Object.keys(next.seller)) next.seller[k] = String(next.seller[k] ?? "").trim().slice(0, 200);
  for (const k of Object.keys(next.auto)) next.auto[k] = !!next.auto[k];
  next.urssaf.rate = Math.max(0, Math.min(50, parseFloat(next.urssaf.rate) || 0));
  next.urssaf.vl = !!next.urssaf.vl;
  if (!["month", "quarter"].includes(next.urssaf.mode)) next.urssaf.mode = "month";
  db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('automation', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(JSON.stringify(next), new Date().toISOString());
  return next;
}

const sellerName = (s) => s.company || [s.first, s.last].filter(Boolean).join(" ");

// ─── Factures & avoirs ───────────────────────────────────────────────────────

function nextNumber(prefix, year) {
  const like = `${prefix}-${year}-%`;
  const last = db.prepare("SELECT invoice_no FROM invoices WHERE invoice_no LIKE ? ORDER BY invoice_no DESC LIMIT 1").get(like);
  const n = last ? parseInt(last.invoice_no.split("-").pop(), 10) + 1 : 1;
  return `${prefix}-${year}-${String(n).padStart(4, "0")}`;
}

function saleRow(saleId) {
  return db.prepare(`
    SELECT s.*, COALESCE(l.title, p.title) AS item_title
    FROM sales s
    LEFT JOIN listings l ON l.listing_id = s.listing_id
    LEFT JOIN products p ON p.temu_item_id = s.temu_item_id
    WHERE s.sale_id = ?`).get(saleId);
}

function rowToInvoice(r) {
  let seller = {};
  try { seller = JSON.parse(r.seller_json); } catch { seller = {}; }
  return {
    invoiceNo: r.invoice_no, kind: r.kind, saleId: r.sale_id, refInvoice: r.ref_invoice ?? undefined,
    amountEur: r.amount_cents / 100, buyerName: r.buyer_name ?? undefined, buyerCity: r.buyer_city ?? undefined,
    itemTitle: r.item_title ?? undefined, accountId: r.account_id ?? undefined, seller, issuedAt: r.issued_at,
  };
}

/** Crée la facture d'une vente (idempotent). Retourne null si le vendeur n'a pas de nom. */
function ensureInvoice(saleId, { force = false } = {}) {
  init();
  const existing = db.prepare("SELECT * FROM invoices WHERE sale_id = ? AND kind = 'invoice'").get(saleId);
  if (existing) return rowToInvoice(existing);
  const st = getSettings();
  if (!force && !st.auto.invoices) return null;
  if (!sellerName(st.seller)) return null;
  const s = saleRow(saleId);
  if (!s || s.status === "cancelled") return null;
  const issued = s.confirmed_at ?? new Date().toISOString();
  const no = nextNumber(st.seller.prefix || "FA", new Date().getFullYear());
  db.prepare(`INSERT INTO invoices (invoice_no, kind, sale_id, amount_cents, buyer_name, buyer_city, item_title, account_id, seller_json, issued_at)
              VALUES (?, 'invoice', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(no, saleId, s.sale_price_eur_cents, s.buyer_name, s.delivery_city, s.item_title, s.account_id, JSON.stringify({ ...st.seller, name: sellerName(st.seller) }), new Date().toISOString() > issued ? new Date().toISOString() : issued);
  return rowToInvoice(db.prepare("SELECT * FROM invoices WHERE invoice_no = ?").get(no));
}

/** Avoir pour une vente facturée puis annulée (idempotent). */
function ensureCreditNote(saleId, { force = false } = {}) {
  init();
  const inv = db.prepare("SELECT * FROM invoices WHERE sale_id = ? AND kind = 'invoice'").get(saleId);
  if (!inv) return null;
  const existing = db.prepare("SELECT * FROM invoices WHERE sale_id = ? AND kind = 'credit'").get(saleId);
  if (existing) return rowToInvoice(existing);
  const st = getSettings();
  if (!force && !st.auto.creditNotes) return null;
  const no = nextNumber("AV", new Date().getFullYear());
  db.prepare(`INSERT INTO invoices (invoice_no, kind, sale_id, ref_invoice, amount_cents, buyer_name, buyer_city, item_title, account_id, seller_json, issued_at)
              VALUES (?, 'credit', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(no, saleId, inv.invoice_no, -inv.amount_cents, inv.buyer_name, inv.buyer_city, inv.item_title, inv.account_id, inv.seller_json, new Date().toISOString());
  return rowToInvoice(db.prepare("SELECT * FROM invoices WHERE invoice_no = ?").get(no));
}

function listInvoices() {
  init();
  return db.prepare("SELECT * FROM invoices ORDER BY issued_at DESC, invoice_no DESC").all().map(rowToInvoice);
}

/** Reprise des numéros déjà attribués dans le navigateur (avant la facturation serveur). */
function importInvoices(numbers = {}) {
  init();
  const st = getSettings();
  let imported = 0;
  const ins = db.prepare(`INSERT OR IGNORE INTO invoices (invoice_no, kind, sale_id, amount_cents, buyer_name, buyer_city, item_title, account_id, seller_json, issued_at)
                          VALUES (?, 'invoice', ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const [saleId, no] of Object.entries(numbers)) {
    if (!/^[A-Z0-9]{1,8}-\d{4}-\d{4}$/.test(String(no))) continue;
    if (db.prepare("SELECT 1 FROM invoices WHERE sale_id = ? AND kind = 'invoice'").get(saleId)) continue;
    const s = saleRow(saleId);
    if (!s) continue;
    const r = ins.run(no, saleId, s.sale_price_eur_cents, s.buyer_name, s.delivery_city, s.item_title, s.account_id, JSON.stringify({ ...st.seller, name: sellerName(st.seller) }), s.confirmed_at);
    imported += r.changes;
  }
  return imported;
}

// ─── Déclaration URSSAF ──────────────────────────────────────────────────────

function periodsFor(mode, count = 6, now = new Date()) {
  const out = [];
  for (let i = 0; i < count; i++) {
    let start, end, label;
    if (mode === "quarter") {
      const q = Math.floor(now.getMonth() / 3) - i;
      start = new Date(now.getFullYear(), q * 3, 1);
      end = new Date(now.getFullYear(), q * 3 + 3, 1);
      label = `T${Math.floor(start.getMonth() / 3) + 1} ${start.getFullYear()}`;
    } else {
      start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      label = start.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
    }
    const due = new Date(end.getFullYear(), end.getMonth() + 1, 0, 23, 59); // fin du mois qui suit la période
    const key = `${mode}:${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`;
    out.push({ key, label, start, end, due, current: i === 0 });
  }
  return out;
}

function declarations(now = new Date()) {
  init();
  const st = getSettings();
  const rate = st.urssaf.rate + (st.urssaf.vl ? 1 : 0);
  const sumCa = db.prepare("SELECT COALESCE(SUM(sale_price_eur_cents), 0) AS c FROM sales WHERE status != 'cancelled' AND confirmed_at >= ? AND confirmed_at < ?");
  const done = Object.fromEntries(db.prepare("SELECT * FROM declarations").all().map((r) => [r.period_key, r.declared_at]));
  return periodsFor(st.urssaf.mode, 6, now).map((p) => {
    const caEur = sumCa.get(p.start.toISOString(), p.end.toISOString()).c / 100;
    return {
      key: p.key, label: p.label, current: p.current, caEur, contributionsEur: Math.round(caEur * rate) / 100,
      dueAt: p.due.toISOString(), declaredAt: done[p.key], late: !done[p.key] && !p.current && p.due < now && caEur > 0,
    };
  });
}

function setDeclared(key, declared) {
  init();
  if (!/^(month|quarter):\d{4}-\d{2}$/.test(key)) throw { code: "BAD_REQUEST", message: "Période invalide" };
  if (declared) db.prepare("INSERT OR REPLACE INTO declarations (period_key, declared_at) VALUES (?, ?)").run(key, new Date().toISOString());
  else db.prepare("DELETE FROM declarations WHERE period_key = ?").run(key);
  return declarations().find((d) => d.key === key) ?? null;
}

// ─── Rappels Telegram ────────────────────────────────────────────────────────

async function sendTelegram(text, reply_markup) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chats = (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!token || !chats.length) return 0;
  let n = 0;
  for (const chat_id of chats) {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id, text, parse_mode: "HTML", disable_web_page_preview: true, ...(reply_markup ? { reply_markup } : {}) }),
    }).then((x) => x.json()).catch(() => ({}));
    if (r.ok) n++;
  }
  return n;
}

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const day = (d = new Date()) => d.toISOString().slice(0, 10);
// Un rappel n'est marqué « envoyé » que s'il est vraiment parti (sinon il sera retenté)
const alreadySent = (key) => !!db.prepare("SELECT 1 FROM reminders WHERE key = ?").get(key);
const markSent = (key) => db.prepare("INSERT OR IGNORE INTO reminders (key, sent_at) VALUES (?, ?)").run(key, new Date().toISOString());
const telegramReady = () => !!process.env.TELEGRAM_BOT_TOKEN && !!(process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "").trim();

/** Ventes payées chez Temu sans numéro de suivi depuis N jours → 1 rappel par jour et par vente. */
async function trackingReminders(now = new Date()) {
  const st = getSettings();
  if (!st.auto.trackingReminders || !telegramReady()) return 0;
  const limit = new Date(now.getTime() - st.trackingReminderDays * 86_400_000).toISOString();
  const rows = db.prepare(`
    SELECT s.*, COALESCE(l.title, p.title) AS item_title, a.label AS account_label
    FROM sales s
    LEFT JOIN listings l ON l.listing_id = s.listing_id
    LEFT JOIN products p ON p.temu_item_id = s.temu_item_id
    LEFT JOIN seller_accounts a ON a.account_id = s.account_id
    WHERE s.status = 'order_placed' AND s.tracking_number IS NULL AND COALESCE(s.order_placed_at, s.confirmed_at) <= ?`).all(limit);
  let sent = 0;
  for (const s of rows) {
    const key = `track:${s.sale_id}:${day(now)}`;
    if (alreadySent(key)) continue;
    const days = Math.floor((now - new Date(s.order_placed_at ?? s.confirmed_at)) / 86_400_000);
    const text = [
      "⏳ <b>En attente du numéro de suivi</b>",
      `📦 ${esc(s.item_title ?? s.temu_item_id)}`,
      `🏪 ${esc(s.account_label ?? s.account_id)} · 👤 ${esc(s.buyer_name ?? "Acheteur")}`,
      `Payée sur Temu il y a <b>${days} jour${days > 1 ? "s" : ""}</b>${s.order_ref ? ` · réf. ${esc(s.order_ref)}` : ""}`,
      "",
      "Regarde ta commande Temu et ajoute le numéro de suivi 👇",
    ].join("\n");
    if (await sendTelegram(text, { inline_keyboard: [[{ text: "📦 Ajouter le numéro de suivi", callback_data: `add_tracking:${s.sale_id}` }]] })) { markSent(key); sent++; }
  }
  return sent;
}

/** Déclaration URSSAF non faite : rappel le 1er, le 15 et les 3 derniers jours avant l'échéance. */
async function declarationReminders(now = new Date()) {
  const st = getSettings();
  if (!st.auto.declarationReminders || !telegramReady()) return 0;
  let sent = 0;
  for (const d of declarations(now)) {
    if (d.current || d.declaredAt || d.caEur <= 0) continue;
    const due = new Date(d.dueAt);
    const daysLeft = Math.ceil((due - now) / 86_400_000);
    const dom = now.getDate();
    if (!(dom === 1 || dom === 15 || (daysLeft >= 0 && daysLeft <= 3) || d.late)) continue;
    const key = `decl:${d.key}:${day(now)}`;
    if (alreadySent(key)) continue;
    const text = [
      d.late ? "🚨 <b>Déclaration URSSAF en retard</b>" : "🧾 <b>Déclaration URSSAF à faire</b>",
      `Période : <b>${esc(d.label)}</b>`,
      `Chiffre d'affaires à déclarer : <b>${Math.round(d.caEur)} €</b>`,
      `Cotisations estimées : ${d.contributionsEur.toFixed(2).replace(".", ",")} €`,
      d.late ? "La date limite est passée : déclare au plus vite." : `À faire avant le <b>${due.toLocaleDateString("fr-FR", { day: "numeric", month: "long" })}</b> (${daysLeft} j).`,
      "",
      "Une fois déclaré, coche « Déclaré » sur le dashboard (Facturation).",
    ].join("\n");
    if (await sendTelegram(text, { inline_keyboard: [[{ text: "Déclarer sur autoentrepreneur.urssaf.fr", url: "https://www.autoentrepreneur.urssaf.fr" }]] })) { markSent(key); sent++; }
  }
  return sent;
}

/** Tour d'automatisation (appelé périodiquement et au démarrage). */
async function runAutomation(now = new Date()) {
  init();
  const st = getSettings();
  let invoices = 0, credits = 0;
  if (st.auto.invoices && sellerName(st.seller)) {
    const todo = db.prepare("SELECT s.sale_id FROM sales s LEFT JOIN invoices i ON i.sale_id = s.sale_id AND i.kind = 'invoice' WHERE i.invoice_no IS NULL AND s.status != 'cancelled' ORDER BY s.confirmed_at ASC").all();
    for (const { sale_id } of todo) if (ensureInvoice(sale_id)) invoices++;
  }
  if (st.auto.creditNotes) {
    const todo = db.prepare("SELECT s.sale_id FROM sales s JOIN invoices i ON i.sale_id = s.sale_id AND i.kind = 'invoice' LEFT JOIN invoices c ON c.sale_id = s.sale_id AND c.kind = 'credit' WHERE s.status = 'cancelled' AND c.invoice_no IS NULL").all();
    for (const { sale_id } of todo) if (ensureCreditNote(sale_id)) credits++;
  }
  let reminders = 0;
  try { reminders += await trackingReminders(now); reminders += await declarationReminders(now); } catch (e) { console.warn("[auto] rappels:", e.message); }
  return { invoices, credits, reminders };
}

// ─── Messages automatiques (modèles) ─────────────────────────────────────────

const trackingUrl = (n) => (n ? `https://t.17track.net/fr#nums=${encodeURIComponent(n)}` : "");

/** Remplit un modèle : {prenom} {produit} {suivi} {transporteur} {lien_suivi} {prix} {boutique}. */
function renderTemplate(template, ctx = {}) {
  const first = String(ctx.buyerName ?? "").trim().split(/\s+/)[0] ?? "";
  const vars = {
    prenom: first, produit: ctx.itemTitle ?? "l'article", suivi: ctx.trackingNumber ?? "",
    transporteur: ctx.trackingCarrier ? ` (${ctx.trackingCarrier})` : "", lien_suivi: trackingUrl(ctx.trackingNumber),
    prix: ctx.priceEur != null ? `${Number(ctx.priceEur).toFixed(2).replace(".", ",")} €` : "", boutique: ctx.shop ?? "",
  };
  return String(template)
    .replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m))
    .replace(/Bonjour\s+!/g, "Bonjour !") // prénom inconnu
    .replace(/[ \t]+\n/g, "\n").trim();
}

/** Message prêt à envoyer pour une vente (kind : shipping | cancel | sold | delivered). */
function messageFor(kind, saleId, extra = {}) {
  init();
  const st = getSettings();
  const s = saleId ? saleRow(saleId) : null;
  const acc = s ? db.prepare("SELECT label FROM seller_accounts WHERE account_id = ?").get(s.account_id) : null;
  return renderTemplate(st.templates[kind] ?? DEFAULT_SETTINGS.templates[kind], {
    buyerName: s?.buyer_name, itemTitle: s?.item_title ?? extra.itemTitle, trackingNumber: extra.trackingNumber ?? s?.tracking_number,
    trackingCarrier: extra.trackingCarrier ?? s?.tracking_carrier, priceEur: s ? s.sale_price_eur_cents / 100 : undefined, shop: acc?.label, ...extra,
  });
}

module.exports = {
  renderTemplate, messageFor, TEMPLATE_KEYS,
  getSettings, saveSettings, ensureInvoice, ensureCreditNote, listInvoices, importInvoices,
  declarations, setDeclared, trackingReminders, declarationReminders, runAutomation, periodsFor,
};
