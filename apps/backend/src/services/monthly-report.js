/**
 * Récap compta mensuel + fichier compta (CSV pour Excel / LibreOffice / comptable).
 *
 * - Le 1er de chaque mois : récap du mois écoulé + fichier envoyés sur Telegram.
 * - Quand une période est cochée « Déclaré » : le fichier de la période déclarée
 *   est renvoyé, pour l'archiver avec la déclaration URSSAF.
 * Un envoi n'est marqué fait que s'il est vraiment parti (sinon retenté).
 */
const db = require("../db/db");

const FEE = () => parseFloat(process.env.TEMU_SHIPPING_FEE ?? "2.99");
const pad = (n) => String(n).padStart(2, "0");
const r2 = (n) => Math.round(n * 100) / 100;

/** "2026-10" → bornes du mois ; "quarter:2026-07" → 3 mois ; "month:2026-10" → 1 mois. */
function periodOf(spec) {
  const m = /^(?:(month|quarter):)?(\d{4})-(\d{2})$/.exec(String(spec ?? ""));
  if (!m) throw { code: "BAD_REQUEST", message: "Période invalide (attendu AAAA-MM)" };
  const kind = m[1] ?? "month";
  const y = +m[2], mo = +m[3] - 1;
  if (mo < 0 || mo > 11) throw { code: "BAD_REQUEST", message: "Mois invalide" };
  const start = new Date(y, mo, 1);
  const end = new Date(y, mo + (kind === "quarter" ? 3 : 1), 1);
  const label = kind === "quarter"
    ? `T${Math.floor(mo / 3) + 1} ${y}`
    : start.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  return { kind, key: `${kind}:${y}-${pad(mo + 1)}`, slug: `${y}-${pad(mo + 1)}${kind === "quarter" ? "-T" + (Math.floor(mo / 3) + 1) : ""}`, label, start, end };
}

const prevMonth = (now = new Date()) => {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};

function settings() {
  try { return require("./automation").getSettings(); } catch { return { urssaf: { rate: 12.3, vl: false }, auto: {} }; }
}

/** Toutes les chiffres d'une période, vente par vente. */
function buildReport(spec) {
  const p = periodOf(spec);
  const st = settings();
  const rate = (st.urssaf?.rate ?? 12.3) + (st.urssaf?.vl ? 1 : 0);
  let invoiceNo = () => undefined;
  try {
    const q = db.prepare("SELECT invoice_no FROM invoices WHERE sale_id = ? AND kind = ?");
    invoiceNo = (id, kind) => q.get(id, kind)?.invoice_no;
  } catch { /* table factures pas encore créée */ }

  const rows = db.prepare(`
    SELECT s.*, COALESCE(l.title, pr.title) AS item_title, a.label AS account_label,
           COALESCE(pr.niche, a.niche) AS niche
    FROM sales s
    LEFT JOIN listings l ON l.listing_id = s.listing_id
    LEFT JOIN products pr ON pr.temu_item_id = s.temu_item_id
    LEFT JOIN seller_accounts a ON a.account_id = s.account_id
    WHERE s.confirmed_at >= ? AND s.confirmed_at < ?
    ORDER BY s.confirmed_at ASC`).all(p.start.toISOString(), p.end.toISOString());

  const sales = rows.map((s) => {
    const cancelled = s.status === "cancelled";
    const price = s.sale_price_eur_cents / 100;
    const cost = cancelled ? 0 : s.cost_eur_cents / 100 + FEE();
    return {
      date: s.confirmed_at, saleId: s.sale_id, invoice: invoiceNo(s.sale_id, "invoice"), credit: invoiceNo(s.sale_id, "credit"),
      account: s.account_label ?? s.account_id, niche: s.niche ?? "Sans niche", item: s.item_title ?? s.temu_item_id,
      buyer: s.buyer_name ?? "", city: s.delivery_city ?? "", status: s.status, cancelled,
      priceEur: cancelled ? 0 : price, cancelledEur: cancelled ? price : 0, costEur: r2(cost), profitEur: cancelled ? 0 : r2(price - cost),
    };
  });

  const ok = sales.filter((s) => !s.cancelled);
  const ca = r2(ok.reduce((t, s) => t + s.priceEur, 0));
  const purchases = r2(ok.reduce((t, s) => t + s.costEur, 0));
  const urssaf = r2((ca * rate) / 100);
  const group = (key) => {
    const m = new Map();
    for (const s of ok) {
      const g = m.get(s[key]) ?? { name: s[key], count: 0, caEur: 0, profitEur: 0 };
      g.count++; g.caEur = r2(g.caEur + s.priceEur); g.profitEur = r2(g.profitEur + s.profitEur);
      m.set(s[key], g);
    }
    return [...m.values()].sort((a, b) => b.profitEur - a.profitEur);
  };

  let withdrawnEur = 0;
  try {
    withdrawnEur = db.prepare("SELECT COALESCE(SUM(amount_eur_cents), 0) AS c FROM withdrawals WHERE status = 'done' AND created_at >= ? AND created_at < ?")
      .get(p.start.toISOString(), p.end.toISOString()).c / 100;
  } catch { /* pas de retraits */ }

  let declaredAt;
  try { declaredAt = db.prepare("SELECT declared_at FROM declarations WHERE period_key = ?").get(p.key)?.declared_at; } catch { /* */ }

  return {
    period: { key: p.key, slug: p.slug, label: p.label, start: p.start.toISOString(), end: p.end.toISOString() },
    totals: {
      sales: ok.length, cancelled: sales.length - ok.length, caEur: ca, purchasesEur: purchases,
      grossProfitEur: r2(ca - purchases), urssafRatePct: rate, urssafEur: urssaf, netProfitEur: r2(ca - purchases - urssaf),
      marginPct: ca > 0 ? Math.round(((ca - purchases - urssaf) / ca) * 100) : 0, avgBasketEur: ok.length ? r2(ca / ok.length) : 0,
      cancelledEur: r2(sales.reduce((t, s) => t + s.cancelledEur, 0)), withdrawnEur: r2(withdrawnEur),
    },
    accounts: group("account"), niches: group("niche"), top: group("item").slice(0, 3),
    declaredAt, sales,
  };
}

// ─── Fichier compta (CSV « ; » + BOM : s'ouvre direct dans Excel en français) ─

const num = (n) => (n == null ? "" : n.toFixed(2).replace(".", ","));
const cell = (v) => {
  const s = String(v ?? "");
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // pas de formule exécutée à l'ouverture
  return /[;"\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const STATUS = { confirmed: "Payée", order_placed: "Commandée", tracking_added: "Expédiée", delivered: "Livrée", cancelled: "Annulée" };

function toCsv(rep) {
  const t = rep.totals;
  const L = [];
  const row = (...c) => L.push(c.map(cell).join(";"));
  row(`Tyno Entreprise — Fichier compta ${rep.period.label}`);
  row("Généré le", new Date().toLocaleDateString("fr-FR"));
  row(rep.declaredAt ? "Déclaré à l'URSSAF le" : "Déclaration URSSAF", rep.declaredAt ? new Date(rep.declaredAt).toLocaleDateString("fr-FR") : "à faire");
  row("");
  row("RÉCAP", "Montant (€)");
  row("Chiffre d'affaires (à déclarer)", num(t.caEur));
  row("Achats Temu (port inclus)", num(t.purchasesEur));
  row("Bénéfice brut", num(t.grossProfitEur));
  row(`Cotisations URSSAF estimées (${String(t.urssafRatePct).replace(".", ",")} %)`, num(t.urssafEur));
  row("Bénéfice net", num(t.netProfitEur));
  row("Ventes", t.sales);
  row("Annulations", t.cancelled, num(t.cancelledEur));
  row("Argent retiré des comptes", num(t.withdrawnEur));
  row("");
  row("PAR COMPTE", "Ventes", "CA (€)", "Bénéfice (€)");
  for (const a of rep.accounts) row(a.name, a.count, num(a.caEur), num(a.profitEur));
  row("");
  row("PAR NICHE", "Ventes", "CA (€)", "Bénéfice (€)");
  for (const a of rep.niches) row(a.name, a.count, num(a.caEur), num(a.profitEur));
  row("");
  row("DÉTAIL DES VENTES");
  row("Date", "N° facture", "N° avoir", "Compte", "Niche", "Article", "Acheteur", "Ville", "Statut", "Vendu (€)", "Achat Temu (€)", "Bénéfice (€)");
  for (const s of rep.sales) {
    row(new Date(s.date).toLocaleDateString("fr-FR"), s.invoice ?? "", s.credit ?? "", s.account, s.niche, s.item, s.buyer, s.city,
      STATUS[s.status] ?? s.status, num(s.cancelled ? s.cancelledEur : s.priceEur), num(s.costEur), num(s.profitEur));
  }
  return "﻿" + L.join("\r\n") + "\r\n";
}

// ─── Récap Telegram ──────────────────────────────────────────────────────────

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const eur = (n) => `${(n ?? 0).toFixed(2).replace(".", ",")} €`;

function recapText(rep, { declared = false } = {}) {
  const t = rep.totals;
  const lines = [
    declared ? `✅ <b>DÉCLARÉ · ${esc(rep.period.label.toUpperCase())}</b>` : `📑 <b>RÉCAP DU MOIS · ${esc(rep.period.label.toUpperCase())}</b>`,
    "━━━━━━━━━━━━━━",
    `💰 Chiffre d'affaires : <b>${eur(t.caEur)}</b>`,
    `🛒 Achats Temu : ${eur(t.purchasesEur)}`,
    `🧾 URSSAF (${String(t.urssafRatePct).replace(".", ",")} %) : ${eur(t.urssafEur)}`,
    `📈 Bénéfice net : <b>${eur(t.netProfitEur)}</b> · marge ${t.marginPct} %`,
    `🛍️ ${t.sales} vente${t.sales > 1 ? "s" : ""} · panier moyen ${eur(t.avgBasketEur)}${t.cancelled ? ` · ${t.cancelled} annulée${t.cancelled > 1 ? "s" : ""}` : ""}`,
  ];
  if (rep.accounts.length) {
    lines.push("", "🏪 <b>Par compte</b>");
    for (const a of rep.accounts.slice(0, 5)) lines.push(`• ${esc(a.name)} : ${a.count} · ${eur(a.caEur)} · <b>+${eur(a.profitEur)}</b>`);
  }
  if (rep.top.length) lines.push("", `🏆 Top : ${esc(rep.top[0].name)} (${rep.top[0].count} vente${rep.top[0].count > 1 ? "s" : ""})`);
  lines.push("", declared
    ? "📎 Ton fichier compta de la période est ci-dessous, garde-le avec ta déclaration."
    : rep.declaredAt ? "✅ Déjà déclaré à l'URSSAF." : `🧾 À déclarer : <b>${Math.round(t.caEur)} €</b> de CA. 📎 Fichier compta ci-dessous.`);
  return lines.join("\n");
}

async function tg(method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const isForm = body instanceof FormData;
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, isForm
    ? { method: "POST", body } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description ?? `Telegram HTTP ${r.status}`);
  return j.result;
}

/** Envoie le récap + le fichier à tous les chats autorisés. Retourne le nombre de chats servis. */
async function sendReport(spec, { declared = false } = {}) {
  const chats = (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!process.env.TELEGRAM_BOT_TOKEN || !chats.length) return 0;
  const rep = buildReport(spec);
  const text = recapText(rep, { declared });
  const csv = toCsv(rep);
  let sent = 0;
  for (const chat_id of chats) {
    try {
      await tg("sendMessage", { chat_id, text, parse_mode: "HTML", disable_web_page_preview: true });
      const fd = new FormData();
      fd.append("chat_id", String(chat_id));
      fd.append("document", new Blob([csv], { type: "text/csv" }), `tyno-compta-${rep.period.slug}.csv`);
      fd.append("caption", `📎 Fichier compta ${rep.period.label} (s'ouvre dans Excel)`);
      await tg("sendDocument", fd);
      sent++;
    } catch (e) { console.warn("[recap]", e.message); }
  }
  return sent;
}

const sentKey = (k) => { try { return !!db.prepare("SELECT 1 FROM reminders WHERE key = ?").get(k); } catch { return false; } };
const markKey = (k) => db.prepare("INSERT OR IGNORE INTO reminders (key, sent_at) VALUES (?, ?)").run(k, new Date().toISOString());

/** Appelé à chaque tour d'automatisation : récap du mois écoulé, une seule fois. */
async function monthlyRecap(now = new Date()) {
  const st = settings();
  if (st.auto?.monthlyRecap === false) return 0;
  const month = prevMonth(now);
  const key = `recap:${month}`;
  if (sentKey(key)) return 0;
  const rep = buildReport(month);
  if (!rep.sales.length) { markKey(key); return 0; } // rien vendu : pas de message
  const n = await sendReport(month);
  if (n) markKey(key);
  return n;
}

/** Période cochée « Déclaré » : on renvoie son fichier compta (une fois). */
async function declaredRecap(periodKey) {
  const st = settings();
  if (st.auto?.monthlyRecap === false) return 0;
  const key = `recapdecl:${periodKey}`;
  if (sentKey(key)) return 0;
  const n = await sendReport(periodKey, { declared: true });
  if (n) markKey(key);
  return n;
}

module.exports = { periodOf, prevMonth, buildReport, toCsv, recapText, sendReport, monthlyRecap, declaredRecap };
