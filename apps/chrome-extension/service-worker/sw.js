/**
 * Tyno Connect — Service Worker (MV3)
 * Relaye les messages des content scripts vers l'API Tyno.
 * Gère les notifications Chrome.
 */

const TIMEOUT_MS = 15_000;

async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["tynoApiUrl", "tynoApiToken"], resolve);
  });
}

async function tynoFetch(path, method, body, config) {
  const { tynoApiUrl: baseUrl, tynoApiToken: token } = config;
  if (!baseUrl || !token) throw new Error("Tyno non configuré — ouvrez les options.");

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const opts = {
      method: method || "GET",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", "X-Tyno-Token": token },
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`${baseUrl}${path}`, opts);
    clearTimeout(tid);

    if (!res.ok) {
      const txt = await res.text().catch(() => res.statusText);
      throw new Error(`HTTP ${res.status}: ${txt}`);
    }
    return await res.json();
  } catch (err) {
    clearTimeout(tid);
    if (err.name === "AbortError") throw new Error("Délai dépassé — serveur inaccessible.");
    throw err;
  }
}

function notifyUser(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "../icons/icon48.png",
    title,
    message,
  });
}

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  const handle = async () => {
    const config = await getConfig();

    if (request.type === "IMPORT_PRODUCT") {
      const result = await tynoFetch("/api/products/import-from-extension", "POST", request.payload, config);
      notifyUser("Tyno Connect", `📦 Produit importé : ${request.payload?.title?.slice(0, 40) ?? ""}`);
      return result;
    }

    if (request.type === "SYNC_LISTING") {
      const result = await tynoFetch("/api/listings/sync-from-extension", "POST", request.payload, config);
      notifyUser("Tyno Connect", `🔄 Synchronisé : ${request.payload?.title?.slice(0, 40) ?? ""}`);
      return result;
    }

    if (request.type === "GET_STATUS") {
      return tynoFetch("/api/status", "GET", null, config);
    }

    return { ok: false, error: `Type de message inconnu : ${request.type}` };
  };

  handle()
    .then(res => sendResponse(res ?? { ok: true }))
    .catch(err => sendResponse({ ok: false, error: err.message }));

  return true; // keep channel open for async response
});

// ─── Install ──────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html") });
  }
});
