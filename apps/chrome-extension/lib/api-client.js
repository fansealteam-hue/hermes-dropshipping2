/**
 * Tyno Connect — client API sécurisé
 * - Token lu depuis chrome.storage.sync, jamais hardcodé
 * - Timeout 15s sur chaque requête
 * - Aucune donnée de session tierce collectée
 */

const TIMEOUT_MS = 15_000;

async function tynoFetch(path, method = "GET", body = null) {
  const { url: baseUrl, token } = await TynoStorage.getApiConfig();
  if (!baseUrl) throw new Error("URL API Tyno non configurée — ouvrez les options.");
  if (!token)   throw new Error("Token API Tyno manquant — ouvrez les options.");

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const opts = {
      method,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Tyno-Token": token,
      },
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`${baseUrl}${path}`, opts);
    clearTimeout(tid);

    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new Error(`HTTP ${res.status}: ${errText}`);
    }
    return await res.json();
  } catch (err) {
    clearTimeout(tid);
    if (err.name === "AbortError") throw new Error("Délai dépassé — le serveur Tyno est inaccessible.");
    throw err;
  }
}

async function tynoGetStatus() {
  return tynoFetch("/api/status");
}

async function tynoImportProduct(data) {
  return tynoFetch("/api/products/import-from-extension", "POST", data);
}

async function tynoSyncListing(data) {
  return tynoFetch("/api/listings/sync-from-extension", "POST", data);
}

async function tynoGetDashboard() {
  return tynoFetch("/api/dashboard");
}

window.TynoApi = {
  fetch: tynoFetch,
  getStatus: tynoGetStatus,
  importProduct: tynoImportProduct,
  syncListing: tynoSyncListing,
  getDashboard: tynoGetDashboard,
};
