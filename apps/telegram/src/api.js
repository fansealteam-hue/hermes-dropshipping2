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
};
