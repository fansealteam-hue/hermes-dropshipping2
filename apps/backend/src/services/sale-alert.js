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

function alertKeyboard(saleId, available) {
  const rows = [];
  if (available !== false) rows.push([{ text: "✅ Dispo — je commande", callback_data: `avail_yes:${saleId}` }]);
  rows.push([{ text: "🔄 Revérifier le stock Temu", callback_data: `check_stock:${saleId}` }]);
  rows.push([{ text: "❌ Pas dispo — annuler la vente", callback_data: `cancel_ask:${saleId}` }]);
  return { inline_keyboard: rows };
}

async function tgCall(method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description ?? `Telegram HTTP ${r.status}`);
  return j.result;
}

/** Envoie l'alerte à tous les chats autorisés. Retourne le nombre d'envois. */
async function sendSaleAlert(saleId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatIds = (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!token || !chatIds.length) throw new Error("TELEGRAM_BOT_TOKEN ou TELEGRAM_ALLOWED_CHAT_IDS manquant");
  const sale = getSale(saleId);
  if (!sale) throw new Error(`Vente ${saleId} introuvable`);
  const a = await checkAvailability(saleId, { refresh: process.env.NODE_ENV !== "test" });
  const acc = db.prepare("SELECT label FROM seller_accounts WHERE account_id = ?").get(sale.accountId);
  const text = buildAlertText(sale, a, acc?.label);
  const reply_markup = alertKeyboard(saleId, a.available);
  const v = db.prepare("SELECT image_urls FROM variants WHERE variant_id = ?").get(sale.variantId);
  const photo = (() => { try { return JSON.parse(v?.image_urls ?? "[]")[0]; } catch { return undefined; } })();
  let sent = 0;
  for (const chat_id of chatIds) {
    if (photo && text.length <= 1000) {
      try { await tgCall("sendPhoto", { chat_id, photo, caption: text, parse_mode: "HTML", reply_markup }); sent++; continue; } catch { /* repli texte */ }
    }
    await tgCall("sendMessage", { chat_id, text, parse_mode: "HTML", reply_markup, disable_web_page_preview: true });
    sent++;
  }
  return sent;
}

module.exports = { checkAvailability, buildAlertText, alertKeyboard, sendSaleAlert, availabilityLine };
