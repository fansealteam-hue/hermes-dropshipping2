/**
 * Client API Hermès — toutes les méthodes avec timeout, vérification HTTP et retry.
 */
require("dotenv").config();
const { config } = require("./config.js");

const TIMEOUT_MS = 15_000;

async function apiFetch(path, method = "GET", body = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const opts = {
      method,
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
    };
    if (body !== null) opts.body = JSON.stringify(body);

    const r = await fetch(`${config.apiBaseUrl}${path}`, opts);

    if (!r.ok) {
      let errMsg = `HTTP ${r.status}`;
      try { const j = await r.json(); errMsg = j.error ?? j.message ?? errMsg; } catch (_) {}
      return { ok: false, error: errMsg, status: r.status };
    }

    const contentType = r.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return { ok: false, error: `Réponse non-JSON : ${contentType}` };
    }

    const data = await r.json();
    if (data === null || typeof data !== "object") {
      return { ok: false, error: "Réponse JSON invalide" };
    }

    // Les routes renvoient soit { ok, data } soit { ok, error }
    if ("ok" in data) return data;
    return { ok: true, data };

  } catch (e) {
    if (e.name === "AbortError") return { ok: false, error: "Timeout — API injoignable" };
    return { ok: false, error: String(e.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  // ─── Produits Temu ──────────────────────────────────────────────────────────
  fetchTemuProduct: url => apiFetch("/api/products/fetch", "POST", { temuUrl: url }),
  importProductFromExtension: data => apiFetch("/api/products/import-from-extension", "POST", data),

  // ─── Annonces ───────────────────────────────────────────────────────────────
  createListing: data => apiFetch("/api/listings", "POST", data),
  getListing: id => apiFetch(`/api/listings/${id}`),
  bumpAll: () => apiFetch("/api/listings/bump-all", "POST"),

  // ─── Comptes ────────────────────────────────────────────────────────────────
  getLeboncoinAccounts: () => apiFetch("/api/accounts/leboncoin"),
  syncAll: () => apiFetch("/api/accounts/sync-all", "POST"),

  // ─── Ventes ─────────────────────────────────────────────────────────────────
  getSale: id => apiFetch(`/api/sales/${id}`),
  getActiveSales: () => apiFetch("/api/sales"),
  cancelSale: saleId => apiFetch(`/api/sales/${saleId}/cancel`, "POST"),
  confirmAvailable: saleId => apiFetch(`/api/sales/${saleId}/confirm-available`, "POST"),
  republishSale: saleId => apiFetch(`/api/sales/${saleId}/republish`, "POST"),
  closeSale: saleId => apiFetch(`/api/sales/${saleId}/close`, "POST"),

  // ─── Commandes fournisseur ───────────────────────────────────────────────────
  /**
   * Enregistre qu'une commande fournisseur a été passée.
   * Transitions sale.status → "order_placed"
   */
  confirmOrderPlaced: (saleId, { orderRef, pricePaid }) =>
    apiFetch(`/api/sales/${saleId}/confirm-order`, "POST", { orderRef, pricePaid }),

  // ─── Suivi ───────────────────────────────────────────────────────────────────
  addTracking: (id, data) => apiFetch(`/api/sales/${id}/tracking`, "PATCH", data),
  syncTracking: saleId => apiFetch(`/api/sales/${saleId}/sync-tracking`, "POST"),

  // ─── Messages ───────────────────────────────────────────────────────────────
  autoReply: (listingId, buyerMessage) =>
    apiFetch("/api/messages/reply", "POST", { listingId, buyerMessage }),
  negotiate: (listingId, offerEur) =>
    apiFetch("/api/negotiate", "POST", { listingId, offerEur }),
  getUnreadMessages: () => apiFetch("/api/messages/unread"),

  // ─── Dashboard & agents ─────────────────────────────────────────────────────
  getDashboard: () => apiFetch("/api/dashboard"),
  getAgents: () => apiFetch("/api/agents/status"),

  // ─── Idempotence callbacks ───────────────────────────────────────────────────
  /**
   * Marque un callback comme traité pour éviter le double-déclenchement.
   * Renvoie { ok: true, alreadyDone: true } si déjà traité.
   */
  markCallbackDone: (callbackId) =>
    apiFetch("/api/callbacks/mark-done", "POST", { callbackId }),
};
