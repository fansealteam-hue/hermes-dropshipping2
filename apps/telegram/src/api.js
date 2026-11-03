const { config } = require("./config.js");

async function apiFetch(path, method = "GET", body = null) {
  try {
    const opts = { method, headers: { "Content-Type": "application/json" } };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(`${config.apiBaseUrl}${path}`, opts);
    return r.json();
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

module.exports = {
  fetchTemuProduct: url => apiFetch("/api/products/fetch", "POST", { temuUrl: url }),
  createListing: data => apiFetch("/api/listings", "POST", data),
  getDashboard: () => apiFetch("/api/dashboard"),
  getLeboncoinAccounts: () => apiFetch("/api/accounts/leboncoin"),
  addTracking: (id, data) => apiFetch(`/api/sales/${id}/tracking`, "PATCH", data),
  getSale: id => apiFetch(`/api/sales/${id}`),
  getActiveSales: () => apiFetch("/api/sales"),
  syncTracking: saleId => apiFetch(`/api/sales/${saleId}/sync-tracking`, "POST"),
  autoReply: (listingId, buyerMessage) => apiFetch("/api/messages/reply", "POST", { listingId, buyerMessage }),
  negotiate: (listingId, offerEur) => apiFetch("/api/negotiate", "POST", { listingId, offerEur }),
  cancelSale: saleId => apiFetch(`/api/sales/${saleId}/cancel`, "POST"),
  confirmAvailable: saleId => apiFetch(`/api/sales/${saleId}/confirm-available`, "POST"),
  republishSale: saleId => apiFetch(`/api/sales/${saleId}/republish`, "POST"),
  closeSale: saleId => apiFetch(`/api/sales/${saleId}/close`, "POST"),
};
