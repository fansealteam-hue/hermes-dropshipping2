/**
 * Alerte de vente Telegram + vérification de disponibilité Temu.
 *
 * Le backend et le bot tournent dans des conteneurs séparés : l'alerte est
 * donc envoyée directement via l'API HTTP Telegram (même token que le bot).
 * Les boutons (callback_data) sont traités par le bot (apps/telegram).
 */
const db = require("../db/db");
const { getSale } = require("./sales");

const TEMU_FEE = () => parseFloat(process.env.TEMU_SHIPPING_FEE ?? "2.99");

/**
 * Disponibilité de l'article chez Temu.
 * refresh=true : relit la page Temu (stock + prix à jour), sinon données en cache.
 */
async function checkAvailability(saleId, { refresh = false } = {}) {
  const sale = getSale(saleId);
  if (!sale) throw { code: "NOT_FOUND", message: `Vente ${saleId} introuvable` };
  const product = db.prepare("SELECT * FROM products WHERE temu_item_id = ?").get(sale.temuItemId);
  let error;
  if (refresh && product?.temu_url) {
    try {
      const { fetchProduct } = require("./products");
      await Promise.race([
        fetchProduct(product.temu_url, { force: true }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("Temu ne répond pas (timeout)")), 30_000)),
      ]);
    } catch (e) { error = e.message ?? String(e); }
  }
  const p = db.prepare("SELECT * FROM products WHERE temu_item_id = ?").get(sale.temuItemId);
  const v = db.prepare("SELECT * FROM variants WHERE variant_id = ?").get(sale.variantId);
  const currentCost = v ? v.cost_eur_cents / 100 : undefined;
  return {
    saleId,
    productTitle: p?.title ?? sale.temuItemId,
    variantLabel: v?.label ?? sale.variantId,
    stock: v?.stock ?? null,
    available: v ? v.stock > 0 : null,
    warehouse: p?.warehouse_status ?? "unknown",
    costAtSaleEur: sale.costEur,
    currentCostEur: currentCost,
    costChanged: currentCost != null && Math.abs(currentCost - sale.costEur) >= 0.01,
    checkedAt: p?.fetched_at,
    refreshed: refresh && !error,
    error,
  };
}

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const eur = (n) => (n == null ? "?" : `${n.toFixed(2).replace(".", ",")} €`);

function availabilityLine(a) {
  if (a.available === null) return "❔ Stock Temu inconnu — vérifie avant de commander";
  const wh = a.warehouse === "local" ? " · entrepôt Europe 🇪🇺" : a.warehouse === "china" ? " · expédié de Chine" : "";
  const price = a.costChanged ? `\n⚠️ Prix Temu changé : ${eur(a.costAtSaleEur)} → <b>${eur(a.currentCostEur)}</b>` : "";
  return (a.available ? `🟢 <b>Disponible</b> sur Temu (${a.stock} en stock${wh})` : "🔴 <b>Rupture de stock</b> sur Temu") + price;
}

/** Texte HTML de l'alerte de vente. */
function buildAlertText(sale, a, accountLabel) {
  const cost = (a.currentCostEur ?? sale.costEur) + TEMU_FEE();
  const net = sale.salePriceEur - cost;
  return [
    "🔔 <b>NOUVELLE VENTE</b>",
    "",
    `🏪 Compte : <b>${esc(accountLabel ?? sale.accountId)}</b>`,
    `📦 <b>${esc(a.productTitle)}</b>`,
    a.variantLabel ? `Variante : ${esc(a.variantLabel)}` : "",
    "",
    `💰 Vendu : <b>${eur(sale.salePriceEur)}</b>`,
    `🛒 Coût d'achat Temu : <b>${eur(cost)}</b> (dont ${eur(TEMU_FEE())} de port)`,
    `📈 Bénéfice : <b>${eur(net)}</b>${net < 0 ? " ⚠️ à perte" : ""}`,
    "",
    availabilityLine(a),
    "",
    sale.buyerName ? `👤 Acheteur : ${esc(sale.buyerName)}` : "",
    sale.deliveryAddress ? `📍 Ville : ${esc(sale.deliveryAddress)}` : "",
    sale.supplierUrl ? `🔗 <a href="${esc(sale.supplierUrl)}">Ouvrir le produit sur Temu</a>` : "",
  ].filter((l) => l !== "").join("\n").replace(/\n{3,}/g, "\n\n");
}

function alertKeyboard(saleId) {
  return { inline_keyboard: [
    [{ text: "✅ Disponible", callback_data: `avail_yes:${saleId}` }, { text: "❌ Pas disponible", callback_data: `cancel_ask:${saleId}` }],
    [{ text: "🔄 Revérifier le stock Temu", callback_data: `check_stock:${saleId}` }],
  ] };
}

async function tgCall(method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, isForm
    ? { method: "POST", body }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description ?? `Telegram HTTP ${r.status}`);
  return j.result;
}

/** Photos candidates de l'article : variante Temu → annonce Leboncoin → produit Temu. */
function photoCandidates(sale) {
  const parse = (x) => { try { const v = JSON.parse(x ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };
  const out = [];
  const v = db.prepare("SELECT image_urls FROM variants WHERE variant_id = ?").get(sale.variantId);
  out.push(...parse(v?.image_urls));
  const l = sale.listingId ? db.prepare("SELECT media_urls FROM listings WHERE listing_id = ?").get(sale.listingId) : null;
  out.push(...parse(l?.media_urls));
  const p = db.prepare("SELECT raw_json FROM products WHERE temu_item_id = ?").get(sale.temuItemId);
  try {
    const raw = JSON.parse(p?.raw_json ?? "{}");
    out.push(...(raw.imageUrls ?? []), ...((raw.variants ?? []).flatMap((x) => x.imageUrls ?? [])));
  } catch { /* raw_json illisible */ }
  return [...new Set(out.map((x) => (typeof x === "string" ? x : x?.url)).filter(Boolean))].slice(0, 6);
}

/** Envoie une photo : par URL, sinon téléchargée puis uploadée, sinon fichier local. */
async function sendPhotoAny(chat_id, src, extra) {
  const fs = require("fs");
  const path = require("path");
  if (/^https?:\/\//i.test(src)) {
    try { return await tgCall("sendPhoto", { chat_id, photo: src, ...extra }); } catch { /* Telegram n'a pas pu charger l'URL */ }
    const r = await fetch(src);
    if (!r.ok) throw new Error(`image HTTP ${r.status}`);
    const blob = new Blob([await r.arrayBuffer()], { type: r.headers.get("content-type") ?? "image/jpeg" });
    return tgUpload(chat_id, blob, "photo.jpg", extra);
  }
  const mediaDir = process.env.MEDIA_DIR ?? path.join(__dirname, "../../../data/media");
  const file = path.isAbsolute(src) ? src : path.join(mediaDir, src);
  if (!fs.existsSync(file)) throw new Error("fichier photo introuvable");
  return tgUpload(chat_id, new Blob([fs.readFileSync(file)]), path.basename(file), extra);
}
function tgUpload(chat_id, blob, name, extra) {
  const fd = new FormData();
  fd.append("chat_id", String(chat_id));
  fd.append("photo", blob, name);
  for (const [k, v] of Object.entries(extra)) fd.append(k, typeof v === "string" ? v : JSON.stringify(v));
  return tgCall("sendPhoto", fd);
}
const visibleLength = (html) => html.replace(/<[^>]+>/g, "").replace(/&(lt|gt|amp);/g, "x").length;

/** Envoie l'alerte (photo de l'article + infos + boutons) à tous les chats autorisés. */
async function sendSaleAlert(saleId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatIds = (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!token || !chatIds.length) throw new Error("TELEGRAM_BOT_TOKEN ou TELEGRAM_ALLOWED_CHAT_IDS manquant");
  const sale = getSale(saleId);
  if (!sale) throw new Error(`Vente ${saleId} introuvable`);
  const a = await checkAvailability(saleId, { refresh: process.env.NODE_ENV !== "test" });
  const acc = db.prepare("SELECT label FROM seller_accounts WHERE account_id = ?").get(sale.accountId);
  const text = buildAlertText(sale, a, acc?.label);
  const reply_markup = alertKeyboard(saleId);
  const photos = photoCandidates(sale);
  const fits = visibleLength(text) <= 1024; // limite Telegram d'une légende
  let sent = 0;
  for (const chat_id of chatIds) {
    let photoSent = false;
    for (const src of photos) {
      try {
        await sendPhotoAny(chat_id, src, fits
          ? { caption: text, parse_mode: "HTML", reply_markup }
          : { caption: `📦 ${a.productTitle}`.slice(0, 1000) });
        photoSent = true;
        break;
      } catch { /* photo suivante */ }
    }
    if (!(photoSent && fits)) {
      await tgCall("sendMessage", { chat_id, text: photos.length && !photoSent ? `${text}\n\n<i>(photo indisponible)</i>` : text,
        parse_mode: "HTML", reply_markup, disable_web_page_preview: true });
    }
    sent++;
  }
  return sent;
}

module.exports = { checkAvailability, buildAlertText, alertKeyboard, sendSaleAlert, availabilityLine, photoCandidates };
