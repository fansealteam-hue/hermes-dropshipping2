/**
 * Rapports financiers Tyno : semaine, mois, trimestre.
 *
 * - Chaque lundi : rapport de la semaine écoulée (PDF) sur Telegram.
 * - Le 1er du mois : rapport du mois écoulé (PDF) + fichier compta (CSV Excel).
 * - Période cochée « Déclaré » : fichier compta de la période renvoyé.
 * Chaque envoi part une seule fois et n'est marqué fait que s'il est vraiment parti.
 *
 * Le rapport compare à la période précédente et donne des pistes concrètes
 * pour augmenter le bénéfice (niches, comptes, annonces sans vente, marge…).
 */
const db = require("../db/db");

const FEE = () => parseFloat(process.env.TEMU_SHIPPING_FEE ?? "2.99");
const pad = (n) => String(n).padStart(2, "0");
const r2 = (n) => Math.round(n * 100) / 100;
const DAY = 86_400_000;
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monday = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const DAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

// ─── Périodes ────────────────────────────────────────────────────────────────

/**
 * "2026-10" ou "month:2026-10" → mois ; "quarter:2026-07" → trimestre ;
 * "week:2026-11-02" → semaine (du lundi au dimanche).
 */
function periodOf(spec) {
  const s = String(spec ?? "");
  const w = /^week:(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (w) {
    const d = new Date(+w[1], +w[2] - 1, +w[3]);
    if (isNaN(d) || d.getMonth() !== +w[2] - 1) throw { code: "BAD_REQUEST", message: "Semaine invalide" };
    const start = monday(d);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
    const last = new Date(end - DAY);
    const f = (x, o) => x.toLocaleDateString("fr-FR", o);
    const label = start.getMonth() === last.getMonth()
      ? `semaine du ${start.getDate()} au ${f(last, { day: "numeric", month: "long", year: "numeric" })}`
      : `semaine du ${f(start, { day: "numeric", month: "long" })} au ${f(last, { day: "numeric", month: "long", year: "numeric" })}`;
    return { kind: "week", key: `week:${ymd(start)}`, slug: `semaine-${ymd(start)}`, label, start, end };
  }
  const m = /^(?:(month|quarter):)?(\d{4})-(\d{2})$/.exec(s);
  if (!m) throw { code: "BAD_REQUEST", message: "Période invalide (attendu AAAA-MM ou week:AAAA-MM-JJ)" };
  const kind = m[1] ?? "month";
  const y = +m[2], mo = +m[3] - 1;
  if (mo < 0 || mo > 11) throw { code: "BAD_REQUEST", message: "Mois invalide" };
  const start = new Date(y, mo, 1);
  const end = new Date(y, mo + (kind === "quarter" ? 3 : 1), 1);
  const label = kind === "quarter" ? `T${Math.floor(mo / 3) + 1} ${y}` : start.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  return { kind, key: `${kind}:${y}-${pad(mo + 1)}`, slug: `${y}-${pad(mo + 1)}${kind === "quarter" ? "-T" + (Math.floor(mo / 3) + 1) : ""}`, label, start, end };
}

/** Période juste avant (même durée). */
function previousSpec(p) {
  if (p.kind === "week") return `week:${ymd(new Date(p.start.getFullYear(), p.start.getMonth(), p.start.getDate() - 7))}`;
  const back = p.kind === "quarter" ? 3 : 1;
  const d = new Date(p.start.getFullYear(), p.start.getMonth() - back, 1);
  return `${p.kind}:${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

const prevMonth = (now = new Date()) => { const d = new Date(now.getFullYear(), now.getMonth() - 1, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const thisMonth = (now = new Date()) => `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
const prevWeek = (now = new Date()) => { const m = monday(now); return `week:${ymd(new Date(m.getFullYear(), m.getMonth(), m.getDate() - 7))}`; };
const thisWeek = (now = new Date()) => `week:${ymd(monday(now))}`;

function settings() {
  try { return require("./automation").getSettings(); } catch { return { urssaf: { rate: 12.3, vl: false }, auto: {} }; }
}

// ─── Chiffres ────────────────────────────────────────────────────────────────

function salesIn(p) {
  return db.prepare(`
    SELECT s.*, COALESCE(l.title, pr.title) AS item_title, a.label AS account_label,
           COALESCE(pr.niche, a.niche) AS niche
    FROM sales s
    LEFT JOIN listings l ON l.listing_id = s.listing_id
    LEFT JOIN products pr ON pr.temu_item_id = s.temu_item_id
    LEFT JOIN seller_accounts a ON a.account_id = s.account_id
    WHERE s.confirmed_at >= ? AND s.confirmed_at < ?
    ORDER BY s.confirmed_at ASC`).all(p.start.toISOString(), p.end.toISOString());
}

function totalsOf(rows, rate) {
  const ok = rows.filter((s) => s.status !== "cancelled");
  const ca = r2(ok.reduce((t, s) => t + s.sale_price_eur_cents / 100, 0));
  const purchases = r2(ok.reduce((t, s) => t + s.cost_eur_cents / 100 + FEE(), 0));
  const urssaf = r2((ca * rate) / 100);
  return { sales: ok.length, cancelled: rows.length - ok.length, caEur: ca, purchasesEur: purchases, urssafEur: urssaf,
    grossProfitEur: r2(ca - purchases), netProfitEur: r2(ca - purchases - urssaf) };
}

const delta = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 100) : cur > 0 ? null : 0); // null = « nouveau »

/** Le rapport complet d'une période, vente par vente, avec comparaison et conseils. */
function buildReport(spec) {
  const p = periodOf(spec);
  const st = settings();
  const rate = (st.urssaf?.rate ?? 12.3) + (st.urssaf?.vl ? 1 : 0);
  let invoiceNo = () => undefined;
  try { const q = db.prepare("SELECT invoice_no FROM invoices WHERE sale_id = ? AND kind = ?"); invoiceNo = (id, kind) => q.get(id, kind)?.invoice_no; } catch { /* */ }

  const rows = salesIn(p);
  const sales = rows.map((s) => {
    const cancelled = s.status === "cancelled";
    const price = s.sale_price_eur_cents / 100;
    const cost = cancelled ? 0 : s.cost_eur_cents / 100 + FEE();
    return {
      date: s.confirmed_at, saleId: s.sale_id, invoice: invoiceNo(s.sale_id, "invoice"), credit: invoiceNo(s.sale_id, "credit"),
      account: s.account_label ?? s.account_id, accountId: s.account_id, niche: s.niche ?? "Sans niche", item: s.item_title ?? s.temu_item_id,
      buyer: s.buyer_name ?? "", city: s.delivery_city ?? "", status: s.status, cancelled,
      priceEur: cancelled ? 0 : price, cancelledEur: cancelled ? price : 0, costEur: r2(cost), profitEur: cancelled ? 0 : r2(price - cost),
    };
  });
  const ok = sales.filter((s) => !s.cancelled);
  const base = totalsOf(rows, rate);
  const prevP = periodOf(previousSpec(p));
  const prev = totalsOf(salesIn(prevP), rate);

  const group = (key) => {
    const m = new Map();
    for (const s of ok) {
      const g = m.get(s[key]) ?? { name: s[key], count: 0, caEur: 0, profitEur: 0 };
      g.count++; g.caEur = r2(g.caEur + s.priceEur); g.profitEur = r2(g.profitEur + s.profitEur - (s.priceEur * rate) / 100);
      m.set(s[key], g);
    }
    return [...m.values()].map((g) => ({ ...g, sharePct: base.caEur ? Math.round((g.caEur / base.caEur) * 100) : 0,
      marginPct: g.caEur ? Math.round((g.profitEur / g.caEur) * 100) : 0, perSaleEur: r2(g.profitEur / g.count) }))
      .sort((a, b) => b.profitEur - a.profitEur);
  };

  // Courbe : par jour (semaine, mois) ou par semaine (trimestre)
  const byWeek = (p.end - p.start) / DAY > 45;
  const series = [];
  for (let d = new Date(p.start); d < p.end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + (byWeek ? 7 : 1))) {
    const e = new Date(d.getFullYear(), d.getMonth(), d.getDate() + (byWeek ? 7 : 1));
    const inB = ok.filter((s) => new Date(s.date) >= d && new Date(s.date) < e);
    series.push({ label: byWeek ? `${d.getDate()}/${d.getMonth() + 1}` : p.kind === "week" ? DAYS[d.getDay()].slice(0, 3) : String(d.getDate()),
      caEur: r2(inB.reduce((t, s) => t + s.priceEur, 0)), profitEur: r2(inB.reduce((t, s) => t + s.profitEur, 0)) });
  }
  const weekday = Array.from({ length: 7 }, (_, i) => ({ day: DAYS[i], caEur: 0, count: 0 }));
  for (const s of ok) { const w = weekday[new Date(s.date).getDay()]; w.caEur = r2(w.caEur + s.priceEur); w.count++; }
  const bestDay = [...weekday].sort((a, b) => b.caEur - a.caEur)[0];

  // Argent pas encore encaissé : ventes en cours de livraison (toutes périodes)
  const pend = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(sale_price_eur_cents), 0) AS c FROM sales WHERE status IN ('confirmed', 'order_placed', 'tracking_added')").get();

  // Annonces en ligne depuis +7 jours sans aucune vente sur la période
  let unsold = [];
  try {
    unsold = db.prepare(`
      SELECT l.listing_id, l.title, l.price_eur_cents, l.published_at, a.label AS account_label
      FROM listings l LEFT JOIN seller_accounts a ON a.account_id = l.account_id
      WHERE l.status = 'published' AND COALESCE(l.published_at, l.created_at) <= ?
        AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.listing_id = l.listing_id AND s.confirmed_at >= ? AND s.confirmed_at < ?)
      ORDER BY COALESCE(l.published_at, l.created_at) ASC`).all(new Date(p.end - 7 * DAY).toISOString(), p.start.toISOString(), p.end.toISOString())
      .map((l) => ({ title: l.title, priceEur: l.price_eur_cents / 100, account: l.account_label, days: Math.floor((Date.now() - new Date(l.published_at)) / DAY) || 0 }));
  } catch { /* */ }
  let activeListings = 0;
  try { activeListings = db.prepare("SELECT COUNT(*) AS n FROM listings WHERE status = 'published'").get().n; } catch { /* */ }

  let withdrawnEur = 0;
  try { withdrawnEur = db.prepare("SELECT COALESCE(SUM(amount_eur_cents), 0) AS c FROM withdrawals WHERE status = 'done' AND created_at >= ? AND created_at < ?").get(p.start.toISOString(), p.end.toISOString()).c / 100; } catch { /* */ }
  let declaredAt;
  try { declaredAt = db.prepare("SELECT declared_at FROM declarations WHERE period_key = ?").get(p.key)?.declared_at; } catch { /* */ }

  const accounts = group("account");
  const niches = group("niche");
  const products = group("item");
  const totals = {
    ...base, urssafRatePct: rate,
    marginPct: base.caEur > 0 ? Math.round((base.netProfitEur / base.caEur) * 100) : 0,
    avgBasketEur: base.sales ? r2(base.caEur / base.sales) : 0,
    avgProfitEur: base.sales ? r2(base.netProfitEur / base.sales) : 0,
    cancelledEur: r2(sales.reduce((t, s) => t + s.cancelledEur, 0)),
    cancelRatePct: sales.length ? Math.round((base.cancelled / sales.length) * 100) : 0,
    withdrawnEur: r2(withdrawnEur), pendingEur: r2(pend.c / 100), pendingCount: pend.n, activeListings,
  };
  const compare = {
    label: prevP.kind === "week" ? `la ${prevP.label}` : prevP.label, prev,
    caPct: delta(base.caEur, prev.caEur), netPct: delta(base.netProfitEur, prev.netProfitEur), salesPct: delta(base.sales, prev.sales),
  };
  const lowProfit = ok.filter((s) => s.profitEur < 5).length;
  const rep = {
    period: { kind: p.kind, key: p.key, slug: p.slug, label: p.label, start: p.start.toISOString(), end: p.end.toISOString() },
    totals, compare, accounts, niches, top: products.slice(0, 5), unsold: unsold.slice(0, 6), unsoldCount: unsold.length,
    series, bestDay: bestDay.count ? bestDay : null, lowProfit, declaredAt, sales,
  };
  rep.advice = advice(rep);
  return rep;
}

// ─── Conseils pour augmenter le bénéfice ─────────────────────────────────────

function advice(r) {
  const t = r.totals, out = [];
  const e = (n) => `${Math.round(n)} €`;
  if (!t.sales) {
    out.push({ icon: "🚀", text: t.activeListings ? `Aucune vente sur la période avec ${t.activeListings} annonces en ligne : baisse de 5 à 10 % les prix des annonces les plus anciennes et ajoute de nouveaux produits.` : "Aucune annonce en ligne : publie tes premiers produits pour lancer les ventes." });
    return out;
  }
  const [bestNiche] = r.niches;
  if (bestNiche && r.niches.length > 1) out.push({ icon: "🎯", text: `La niche <b>${esc(bestNiche.name)}</b> rapporte ${e(bestNiche.perSaleEur)} par vente (${bestNiche.marginPct} % de marge) : c'est là qu'il faut publier plus d'annonces.` });
  else if (bestNiche) out.push({ icon: "🎯", text: `Tout ton bénéfice vient de <b>${esc(bestNiche.name)}</b> : teste une 2ᵉ niche sur un autre compte pour grandir sans dépendre d'une seule.` });
  if (r.compare.caPct != null && r.compare.caPct <= -10) out.push({ icon: "📉", text: `CA en baisse de ${Math.abs(r.compare.caPct)} % par rapport à ${r.compare.label} : remets des annonces en ligne et republie tes meilleures ventes.` });
  else if (r.compare.caPct != null && r.compare.caPct >= 10) out.push({ icon: "📈", text: `CA en hausse de ${r.compare.caPct} % : ce qui marche, c'est ${r.top[0] ? `<b>${esc(r.top[0].name)}</b>` : "ton catalogue actuel"} — duplique-le sur tes autres comptes.` });
  if (r.unsoldCount) out.push({ icon: "🏷️", text: `${r.unsoldCount} annonce${r.unsoldCount > 1 ? "s" : ""} en ligne depuis plus de 7 jours sans vente : baisse le prix de 5 à 10 % ou remplace-les par des produits de ta meilleure niche.` });
  if (t.marginPct < 30) out.push({ icon: "💶", text: `Marge nette de ${t.marginPct} % seulement : vise des produits revendus au moins 2,5 × leur prix Temu.` });
  else if (r.lowProfit) out.push({ icon: "💶", text: `${r.lowProfit} vente${r.lowProfit > 1 ? "s" : ""} à moins de 5 € de bénéfice : remonte un peu ces prix, l'effort ne vaut pas le coup en dessous.` });
  if (t.cancelRatePct >= 10) out.push({ icon: "⚠️", text: `${t.cancelled} annulation${t.cancelled > 1 ? "s" : ""} (${t.cancelRatePct} %) : vérifie le stock Temu avant de publier, chaque annulation fait perdre une vente et abîme le compte.` });
  const weak = r.accounts.length > 1 ? r.accounts[r.accounts.length - 1] : null;
  if (weak && weak.profitEur < r.accounts[0].profitEur / 3) out.push({ icon: "🏪", text: `Le compte <b>${esc(weak.name)}</b> rapporte 3× moins que <b>${esc(r.accounts[0].name)}</b> : copie-lui les produits qui marchent ou change sa niche.` });
  if (r.bestDay && r.period.kind !== "week") out.push({ icon: "📅", text: `Ton meilleur jour est le <b>${r.bestDay.day}</b> : publie tes nouvelles annonces la veille au soir.` });
  if (t.pendingEur > 0) out.push({ icon: "⏳", text: `${e(t.pendingEur)} encore en attente (${t.pendingCount} vente${t.pendingCount > 1 ? "s" : ""} pas livrée${t.pendingCount > 1 ? "s" : ""}) : ajoute vite les numéros de suivi pour être payé plus tôt.` });
  return out.slice(0, 5);
}

// ─── Fichier compta (CSV « ; » + BOM : s'ouvre direct dans Excel en français) ─

const num = (n) => (n == null ? "" : n.toFixed(2).replace(".", ","));
const cell = (v) => {
  const s = String(v ?? "");
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // pas de formule exécutée à l'ouverture
  return /[;"\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const STATUS = { confirmed: "Payée", order_placed: "Commandée", tracking_added: "Expédiée", delivered: "Livrée", cancelled: "Annulée" };
const strip = (h) => String(h).replace(/<[^>]+>/g, "");

function toCsv(rep) {
  const t = rep.totals;
  const L = [];
  const row = (...c) => L.push(c.map(cell).join(";"));
  row(`Tyno Entreprise — Fichier compta ${rep.period.label}`);
  row("Généré le", new Date().toLocaleDateString("fr-FR"));
  if (rep.period.kind !== "week") row(rep.declaredAt ? "Déclaré à l'URSSAF le" : "Déclaration URSSAF", rep.declaredAt ? new Date(rep.declaredAt).toLocaleDateString("fr-FR") : "à faire");
  row("");
  row("RÉCAP", "Montant (€)", `Période précédente (${rep.compare.label})`);
  row("Chiffre d'affaires (à déclarer)", num(t.caEur), num(rep.compare.prev.caEur));
  row("Achats Temu (port inclus)", num(t.purchasesEur), num(rep.compare.prev.purchasesEur));
  row("Bénéfice brut", num(t.grossProfitEur), num(rep.compare.prev.grossProfitEur));
  row(`Cotisations URSSAF estimées (${String(t.urssafRatePct).replace(".", ",")} %)`, num(t.urssafEur), num(rep.compare.prev.urssafEur));
  row("Bénéfice net", num(t.netProfitEur), num(rep.compare.prev.netProfitEur));
  row("Ventes", t.sales, rep.compare.prev.sales);
  row("Annulations", t.cancelled, num(t.cancelledEur));
  row("Argent retiré des comptes", num(t.withdrawnEur));
  row("");
  row("PAR COMPTE", "Ventes", "CA (€)", "Bénéfice (€)", "Part du CA (%)");
  for (const a of rep.accounts) row(a.name, a.count, num(a.caEur), num(a.profitEur), a.sharePct);
  row("");
  row("PAR NICHE", "Ventes", "CA (€)", "Bénéfice (€)", "Marge (%)");
  for (const a of rep.niches) row(a.name, a.count, num(a.caEur), num(a.profitEur), a.marginPct);
  row("");
  row("DÉTAIL DES VENTES");
  row("Date", "N° facture", "N° avoir", "Compte", "Niche", "Article", "Acheteur", "Ville", "Statut", "Vendu (€)", "Achat Temu (€)", "Bénéfice (€)");
  for (const s of rep.sales) {
    row(new Date(s.date).toLocaleDateString("fr-FR"), s.invoice ?? "", s.credit ?? "", s.account, s.niche, s.item, s.buyer, s.city,
      STATUS[s.status] ?? s.status, num(s.cancelled ? s.cancelledEur : s.priceEur), num(s.costEur), num(s.profitEur));
  }
  if (rep.advice?.length) { row(""); row("CONSEILS"); for (const a of rep.advice) row(strip(a.text)); }
  return "﻿" + L.join("\r\n") + "\r\n";
}

// ─── Rapport PDF (HTML noir & orange, rendu par Chromium) ────────────────────

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const eur = (n) => `${(n ?? 0).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/\u202f/g, " ")} €`;
const eur0 = (n) => `${Math.round(n ?? 0).toLocaleString("fr-FR").replace(/\u202f/g, " ")} €`;
const deltaHtml = (pct) => (pct == null ? '<span class="d up">nouveau</span>' : pct === 0 ? '<span class="d">= stable</span>'
  : `<span class="d ${pct > 0 ? "up" : "down"}">${pct > 0 ? "▲ +" : "▼ −"}${Math.abs(pct)} %</span>`);
const title = (rep) => (rep.period.kind === "week" ? "Rapport de la semaine" : rep.period.kind === "quarter" ? "Rapport du trimestre" : "Rapport du mois");

function chartSvg(series) {
  const W = 700, H = 170, n = series.length || 1;
  const max = Math.max(1, ...series.map((s) => s.caEur));
  const bw = Math.min(46, (W / n) * 0.62);
  const x = (i) => (W / n) * i + (W / n - bw) / 2;
  const y = (v) => H - 22 - (v / max) * (H - 40);
  const bars = series.map((s, i) => `
    <rect x="${x(i)}" y="${y(s.caEur)}" width="${bw}" height="${Math.max(0, H - 22 - y(s.caEur))}" rx="3" fill="#ff7a1a" opacity=".9"/>
    <rect x="${x(i) + bw * 0.28}" y="${y(Math.max(0, s.profitEur))}" width="${bw * 0.44}" height="${Math.max(0, H - 22 - y(Math.max(0, s.profitEur)))}" rx="2" fill="#2fd27a"/>
    ${n <= 16 || i % Math.ceil(n / 16) === 0 ? `<text x="${x(i) + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(s.label)}</text>` : ""}`).join("");
  const grid = [0.25, 0.5, 0.75, 1].map((f) => `<line x1="0" x2="${W}" y1="${y(max * f)}" y2="${y(max * f)}" stroke="#2a2a2a"/><text x="2" y="${y(max * f) - 3}" text-anchor="start">${eur0(max * f)}</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="chart">${grid}${bars}</svg>`;
}

function table(rows, cols) {
  if (!rows.length) return '<div class="empty">Rien sur la période</div>';
  return `<table><thead><tr>${cols.map((c) => `<th class="${c.num ? "r" : ""}">${c.h}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td class="${c.num ? "r" : ""}">${c.v(r)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function toHtml(rep) {
  const t = rep.totals, c = rep.compare;
  const flow = Math.max(t.caEur, 1);
  const seg = (v, color, label) => (v > 0 ? `<div style="width:${(v / flow) * 100}%;background:${color}" title="${label}"></div>` : "");
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tyno · ${esc(title(rep))} · ${esc(rep.period.label)}</title>
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b0b0c; color: #f3f1ee; font: 12.5px/1.45 "Liberation Sans", "Helvetica Neue", Arial, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .page { max-width: 794px; margin: 0 auto; padding: 34px 38px 30px; }
  .head { display: flex; align-items: center; gap: 14px; padding-bottom: 18px; border-bottom: 1px solid #262626; }
  .logo { width: 42px; height: 42px; border-radius: 11px; background: linear-gradient(135deg, #ff9a3c, #ff6a00); display: grid; place-items: center; font-weight: 800; font-size: 22px; color: #111; }
  .brand { font-size: 12px; letter-spacing: .14em; text-transform: uppercase; color: #ff8a2a; font-weight: 700; }
  h1 { margin: 2px 0 0; font-size: 24px; font-weight: 800; letter-spacing: -.01em; }
  .period { margin-left: auto; text-align: right; color: #a8a29e; font-size: 12px; }
  .period b { display: block; color: #f3f1ee; font-size: 14px; } .period b::first-letter { text-transform: uppercase; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 20px 0 10px; }
  .kpi { background: #151515; border: 1px solid #262626; border-radius: 12px; padding: 12px 13px; }
  .kpi.hero { background: linear-gradient(160deg, #2a1607, #151515 70%); border-color: #5a2d0c; }
  .kpi .l { color: #a8a29e; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
  .kpi .v { font-size: 22px; font-weight: 800; margin: 3px 0 2px; }
  .kpi .v.green { color: #2fd27a; } .kpi .v.red { color: #ff5a4f; }
  .d { font-size: 11px; color: #a8a29e; } .d.up { color: #2fd27a; } .d.down { color: #ff5a4f; }
  .mini { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin-bottom: 18px; }
  .mini div { background: #121212; border: 1px solid #222; border-radius: 10px; padding: 8px 10px; }
  .mini span { display: block; color: #8f8a85; font-size: 10.5px; } .mini b { font-size: 14px; }
  h2 { font-size: 14px; margin: 20px 0 9px; display: flex; align-items: center; gap: 8px; }
  h2:before { content: ""; width: 4px; height: 15px; border-radius: 2px; background: #ff7a1a; }
  .card { background: #131313; border: 1px solid #242424; border-radius: 12px; padding: 13px 14px; }
  .chart { width: 100%; height: auto; display: block; } .chart text { fill: #8f8a85; font-size: 10px; }
  .legend { display: flex; gap: 14px; color: #a8a29e; font-size: 11px; margin-top: 6px; } .legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
  .flow { display: flex; height: 16px; border-radius: 8px; overflow: hidden; background: #222; margin: 6px 0 8px; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  table { width: 100%; border-collapse: collapse; } th { text-align: left; color: #8f8a85; font-weight: 600; font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; padding: 0 6px 6px; border-bottom: 1px solid #262626; }
  td { padding: 6px; border-bottom: 1px solid #1d1d1d; } tr:last-child td { border-bottom: 0; } .r { text-align: right; white-space: nowrap; }
  .pos { color: #2fd27a; font-weight: 700; } .neg { color: #ff5a4f; font-weight: 700; } .muted { color: #8f8a85; }
  .bar { height: 5px; border-radius: 3px; background: #262626; margin-top: 4px; } .bar i { display: block; height: 100%; border-radius: 3px; background: #ff7a1a; }
  .advice { display: grid; gap: 8px; } .advice > .tip { display: flex; gap: 10px; align-items: flex-start; background: linear-gradient(90deg, #1d1209, #131313); border: 1px solid #3a210d; border-radius: 10px; padding: 9px 12px; break-inside: avoid; }
  .advice .ic { font-size: 16px; line-height: 1.2; flex: none; } .advice .tx { flex: 1; min-width: 0; } .advice b { color: #ffb070; }
  .card, .kpi, .decl, .two > div { break-inside: avoid; page-break-inside: avoid; } h2 { break-after: avoid; page-break-after: avoid; }
  .empty { color: #8f8a85; padding: 8px 0; }
  .foot { margin-top: 22px; padding-top: 12px; border-top: 1px solid #262626; color: #77716b; font-size: 10.5px; display: flex; justify-content: space-between; }
  .decl { margin-top: 12px; padding: 10px 13px; border-radius: 10px; background: #151515; border: 1px dashed #5a2d0c; }
  @media (max-width: 640px) { .page { padding: 20px 16px; } .kpis { grid-template-columns: 1fr 1fr; } .mini { grid-template-columns: 1fr 1fr; } .two { grid-template-columns: 1fr; } .period { display: none; } }
</style></head><body><div class="page">
  <div class="head"><div class="logo">T</div><div><div class="brand">Tyno Entreprise</div><h1>${esc(title(rep))}</h1></div>
    <div class="period"><b>${esc(rep.period.label)}</b>généré le ${new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })}</div></div>

  <div class="kpis">
    <div class="kpi hero"><div class="l">Chiffre d'affaires</div><div class="v">${eur0(t.caEur)}</div>${deltaHtml(c.caPct)} <span class="d">vs ${esc(c.label)}</span></div>
    <div class="kpi"><div class="l">Bénéfice net</div><div class="v ${t.netProfitEur >= 0 ? "green" : "red"}">${eur0(t.netProfitEur)}</div>${deltaHtml(c.netPct)}</div>
    <div class="kpi"><div class="l">Ventes</div><div class="v">${t.sales}</div>${deltaHtml(c.salesPct)}</div>
    <div class="kpi"><div class="l">Marge nette</div><div class="v">${t.marginPct} %</div><span class="d">${eur(t.avgProfitEur)} par vente</span></div>
  </div>
  <div class="mini">
    <div><span>Achats Temu</span><b>${eur0(t.purchasesEur)}</b></div>
    <div><span>URSSAF (${String(t.urssafRatePct).replace(".", ",")} %)</span><b>${eur0(t.urssafEur)}</b></div>
    <div><span>Panier moyen</span><b>${eur(t.avgBasketEur)}</b></div>
    <div><span>Annulations</span><b>${t.cancelled}${t.cancelled ? ` · ${t.cancelRatePct} %` : ""}</b></div>
    <div><span>En attente</span><b>${eur0(t.pendingEur)}</b></div>
  </div>

  <h2>Évolution ${rep.period.kind === "quarter" ? "par semaine" : "jour par jour"}</h2>
  <div class="card">${chartSvg(rep.series)}
    <div class="legend"><span><i style="background:#ff7a1a"></i>Chiffre d'affaires</span><span><i style="background:#2fd27a"></i>Bénéfice</span>${rep.bestDay ? `<span style="margin-left:auto">Meilleur jour : <b style="color:#f3f1ee">${rep.bestDay.day}</b></span>` : ""}</div></div>

  <h2>Où va l'argent</h2>
  <div class="card">
    <div class="flow">${seg(t.purchasesEur, "#ffb347", "Achats Temu")}${seg(t.urssafEur, "#8b5cf6", "URSSAF")}${seg(Math.max(0, t.netProfitEur), "#2fd27a", "Bénéfice net")}</div>
    <div class="legend"><span><i style="background:#ffb347"></i>Achats Temu ${eur0(t.purchasesEur)}</span><span><i style="background:#8b5cf6"></i>URSSAF ${eur0(t.urssafEur)}</span><span><i style="background:#2fd27a"></i>Bénéfice net ${eur0(t.netProfitEur)}</span></div>
  </div>

  <div class="two">
    <div><h2>Par compte</h2><div class="card">${table(rep.accounts, [
      { h: "Compte", v: (a) => `${esc(a.name)}<div class="bar"><i style="width:${a.sharePct}%"></i></div>` },
      { h: "Ventes", num: 1, v: (a) => a.count },
      { h: "Bénéfice", num: 1, v: (a) => `<span class="${a.profitEur >= 0 ? "pos" : "neg"}">${eur0(a.profitEur)}</span>` }])}</div></div>
    <div><h2>Par niche</h2><div class="card">${table(rep.niches, [
      { h: "Niche", v: (a) => esc(a.name) },
      { h: "Marge", num: 1, v: (a) => `${a.marginPct} %` },
      { h: "Bénéfice", num: 1, v: (a) => `<span class="${a.profitEur >= 0 ? "pos" : "neg"}">${eur0(a.profitEur)}</span>` }])}</div></div>
  </div>

  <div class="two">
    <div><h2>Ce qui se vend</h2><div class="card">${table(rep.top, [
      { h: "Produit", v: (a) => esc(a.name.length > 38 ? a.name.slice(0, 37) + "…" : a.name) },
      { h: "Ventes", num: 1, v: (a) => a.count },
      { h: "Bénéfice", num: 1, v: (a) => `<span class="${a.profitEur >= 0 ? "pos" : "neg"}">${eur0(a.profitEur)}</span>` }])}</div></div>
    <div><h2>Ce qui ne se vend pas</h2><div class="card">${table(rep.unsold, [
      { h: `Annonce${rep.unsoldCount > rep.unsold.length ? ` (${rep.unsoldCount} au total)` : ""}`, v: (a) => esc(a.title.length > 34 ? a.title.slice(0, 33) + "…" : a.title) },
      { h: "Prix", num: 1, v: (a) => eur0(a.priceEur) },
      { h: "En ligne", num: 1, v: (a) => `<span class="muted">${a.days} j</span>` }])}</div></div>
  </div>

  <h2>Pour augmenter ton bénéfice</h2>
  <div class="advice">${rep.advice.map((a) => `<div class="tip"><span class="ic">${a.icon}</span><div class="tx">${a.text}</div></div>`).join("") || '<div class="empty">Rien à signaler.</div>'}</div>

  ${rep.period.kind !== "week" ? `<div class="decl">🧾 <b>URSSAF</b> : chiffre d'affaires à déclarer <b>${eur0(t.caEur)}</b> · cotisations estimées ${eur(t.urssafEur)} · ${rep.declaredAt ? `déclaré le ${new Date(rep.declaredAt).toLocaleDateString("fr-FR")} ✅` : "pas encore déclaré"}</div>` : ""}
  <div class="foot"><span>Tyno Entreprise · rapport généré automatiquement</span><span>Chiffres estimés à partir des ventes enregistrées · port Temu ${eur(FEE())} par commande</span></div>
</div></body></html>`;
}

/** HTML → PDF avec le Chromium du serveur. Retourne null si indisponible. */
async function toPdf(html) {
  if (process.env.REPORT_PDF === "0") return null;
  let browser;
  try {
    const { chromium } = require("playwright");
    const fs = require("fs");
    const exe = [process.env.CHROMIUM_PATH, "/usr/bin/chromium", "/opt/pw-browsers/chromium"].find((p) => p && fs.existsSync(p) && fs.statSync(p).isFile());
    browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}), args: ["--no-sandbox"] });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    return await page.pdf({ format: "A4", printBackground: true, margin: { top: "0", bottom: "0", left: "0", right: "0" } });
  } catch (e) {
    console.warn("[rapport] PDF impossible, envoi en HTML :", e.message);
    return null;
  } finally { await browser?.close().catch(() => {}); }
}

// ─── Message Telegram ────────────────────────────────────────────────────────

const tgDelta = (pct) => (pct == null ? " 🆕" : pct === 0 ? " (=)" : ` (${pct > 0 ? "▲ +" : "▼ −"}${Math.abs(pct)} %)`);

function recapText(rep, { declared = false } = {}) {
  const t = rep.totals, c = rep.compare;
  const head = declared ? `✅ <b>DÉCLARÉ · ${esc(rep.period.label.toUpperCase())}</b>`
    : rep.period.kind === "week" ? `📊 <b>RAPPORT DE LA SEMAINE</b>\n<i>${esc(rep.period.label)}</i>`
    : `📑 <b>RÉCAP DU MOIS · ${esc(rep.period.label.toUpperCase())}</b>`;
  const lines = [
    head,
    "━━━━━━━━━━━━━━",
    `💰 CA : <b>${eur(t.caEur)}</b>${tgDelta(c.caPct)}`,
    `📈 Bénéfice net : <b>${eur(t.netProfitEur)}</b>${tgDelta(c.netPct)}`,
    `🛍️ ${t.sales} vente${t.sales > 1 ? "s" : ""}${tgDelta(c.salesPct)} · marge ${t.marginPct} %`,
    `🛒 Achats Temu ${eur0(t.purchasesEur)} · 🧾 URSSAF ${eur0(t.urssafEur)}`,
  ];
  if (t.pendingEur > 0) lines.push(`⏳ En attente : ${eur0(t.pendingEur)} (${t.pendingCount} vente${t.pendingCount > 1 ? "s" : ""})`);
  if (rep.accounts.length) {
    lines.push("", "🏪 <b>Par compte</b>");
    for (const a of rep.accounts.slice(0, 4)) lines.push(`• ${esc(a.name)} : ${a.count} · <b>${a.profitEur >= 0 ? "+" : ""}${eur0(a.profitEur)}</b>`);
  }
  if (rep.top.length) lines.push(`🏆 Top : ${esc(rep.top[0].name)} (${rep.top[0].count})`);
  if (rep.advice?.length && !declared) {
    lines.push("", "💡 <b>Pour gagner plus</b>");
    for (const a of rep.advice.slice(0, 2)) lines.push(`${a.icon} ${a.text}`);
  }
  lines.push("", declared ? "📎 Ton fichier compta est ci-dessous, garde-le avec ta déclaration."
    : rep.period.kind === "week" ? "📎 Rapport complet ci-dessous."
    : rep.declaredAt ? "✅ Déjà déclaré · 📎 rapport + fichier compta ci-dessous."
    : `🧾 À déclarer : <b>${Math.round(t.caEur)} €</b> · 📎 rapport + fichier compta ci-dessous.`);
  const text = lines.join("\n");
  return text.length > 4000 ? text.slice(0, 3990) + "…" : text;
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
async function sendDoc(chat_id, data, type, name, caption) {
  const fd = new FormData();
  fd.append("chat_id", String(chat_id));
  fd.append("document", new Blob([data], { type }), name);
  fd.append("caption", caption);
  return tg("sendDocument", fd);
}

/**
 * Envoie le rapport à tous les chats autorisés : message + PDF (ou HTML) + CSV
 * (le CSV seulement pour un mois / trimestre / une déclaration).
 */
async function sendReport(spec, { declared = false } = {}) {
  const chats = (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!process.env.TELEGRAM_BOT_TOKEN || !chats.length) return 0;
  const rep = buildReport(spec);
  const text = recapText(rep, { declared });
  const withCsv = declared || rep.period.kind !== "week";
  const csv = withCsv ? toCsv(rep) : null;
  const html = declared ? null : toHtml(rep);
  const pdf = html ? await toPdf(html) : null;
  let sent = 0;
  for (const chat_id of chats) {
    try {
      await tg("sendMessage", { chat_id, text, parse_mode: "HTML", disable_web_page_preview: true });
      if (html) {
        if (pdf) await sendDoc(chat_id, pdf, "application/pdf", `tyno-rapport-${rep.period.slug}.pdf`, `📊 ${title(rep)} · ${rep.period.label}`);
        else await sendDoc(chat_id, html, "text/html", `tyno-rapport-${rep.period.slug}.html`, `📊 ${title(rep)} · ${rep.period.label} (à ouvrir dans le navigateur)`);
      }
      if (csv) await sendDoc(chat_id, csv, "text/csv", `tyno-compta-${rep.period.slug}.csv`, `📎 Fichier compta ${rep.period.label} (s'ouvre dans Excel)`);
      sent++;
    } catch (e) { console.warn("[rapport]", e.message); }
  }
  return sent;
}

const sentKey = (k) => { try { return !!db.prepare("SELECT 1 FROM reminders WHERE key = ?").get(k); } catch { return false; } };
const markKey = (k) => db.prepare("INSERT OR IGNORE INTO reminders (key, sent_at) VALUES (?, ?)").run(k, new Date().toISOString());

async function autoSend(key, spec, enabled) {
  if (!enabled || sentKey(key)) return 0;
  const rep = buildReport(spec);
  if (!rep.sales.length && !rep.compare.prev.sales) { markKey(key); return 0; } // rien à raconter
  const n = await sendReport(spec);
  if (n) markKey(key);
  return n;
}

/** Le 1er du mois : rapport du mois écoulé, une seule fois. */
async function monthlyRecap(now = new Date()) {
  const month = prevMonth(now);
  return autoSend(`recap:${month}`, month, settings().auto?.monthlyRecap !== false);
}

/** Le lundi : rapport de la semaine écoulée, une seule fois. */
async function weeklyRecap(now = new Date()) {
  const week = prevWeek(now);
  return autoSend(`recap:${week}`, week, settings().auto?.weeklyRecap !== false);
}

/** Période cochée « Déclaré » : on renvoie son fichier compta (une fois). */
async function declaredRecap(periodKey) {
  if (settings().auto?.monthlyRecap === false) return 0;
  const key = `recapdecl:${periodKey}`;
  if (sentKey(key)) return 0;
  const n = await sendReport(periodKey, { declared: true });
  if (n) markKey(key);
  return n;
}

module.exports = {
  periodOf, previousSpec, prevMonth, thisMonth, prevWeek, thisWeek,
  buildReport, advice, toCsv, toHtml, toPdf, recapText, sendReport, monthlyRecap, weeklyRecap, declaredRecap,
};
