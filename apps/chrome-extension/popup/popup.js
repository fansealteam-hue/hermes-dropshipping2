/**
 * Tyno Connect — popup script
 */

const $ = id => document.getElementById(id);

const dot        = $("status-dot");
const statusText = $("status-text");
const lastSync   = $("last-sync");
const pageBadge  = $("page-platform");
const pageTitle  = $("page-title");
const btnImport  = $("btn-import");
const btnSync    = $("btn-sync");

function setStatus(state, text) {
  dot.className = `status-dot ${state}`;
  statusText.textContent = text;
}

function formatDate(iso) {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  } catch (_) { return ""; }
}

async function checkConnection() {
  setStatus("checking", "Connexion…");
  try {
    const res = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "GET_STATUS" }, (r) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(r);
      });
    });
    if (res?.ok) {
      setStatus("connected", "Connecté à Tyno");
      chrome.storage.sync.set({ connected: true });
    } else {
      setStatus("disconnected", res?.error ?? "Non connecté");
    }
  } catch (err) {
    setStatus("disconnected", err.message.includes("configuré") ? "Non configuré" : "Hors ligne");
  }
}

async function loadLastSync() {
  const { lastSync: ls } = await new Promise(r => chrome.storage.sync.get(["lastSync"], r));
  if (ls) lastSync.textContent = `Sync ${formatDate(ls)}`;
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function detectPlatform(url) {
  if (!url) return null;
  if (url.includes("temu.com")) return "temu";
  if (url.includes("leboncoin.fr")) return "leboncoin";
  if (url.includes("vinted.fr")) return "vinted";
  return null;
}

async function updatePageInfo() {
  const tab = await getCurrentTab();
  const platform = detectPlatform(tab?.url);
  if (platform) {
    const labels = { temu: "Temu", leboncoin: "Leboncoin", vinted: "Vinted" };
    pageBadge.textContent = labels[platform];
    pageTitle.textContent = tab.title?.slice(0, 50) ?? "";
    if (platform === "temu") {
      btnImport.disabled = false;
      btnImport.textContent = "📦 Importer ce produit";
    }
  } else {
    pageBadge.textContent = "Autre page";
    pageTitle.textContent = "";
  }
}

btnImport.addEventListener("click", async () => {
  const tab = await getCurrentTab();
  btnImport.disabled = true;
  btnImport.textContent = "⏳ Import…";
  try {
    // Injecter et déclencher l'import via le content script
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => { document.getElementById("tyno-import-btn")?.click(); },
    });
    btnImport.textContent = "✅ Importé";
    setTimeout(() => { btnImport.textContent = "📦 Importer ce produit"; btnImport.disabled = false; }, 2500);
  } catch (err) {
    btnImport.textContent = "❌ Erreur";
    setTimeout(() => { btnImport.textContent = "📦 Importer ce produit"; btnImport.disabled = false; }, 2000);
  }
});

btnSync.addEventListener("click", async () => {
  btnSync.disabled = true;
  btnSync.textContent = "⏳ Sync…";
  await checkConnection();
  await loadLastSync();
  chrome.storage.sync.set({ lastSync: new Date().toISOString() });
  btnSync.disabled = false;
  btnSync.textContent = "🔄 Synchroniser";
});

$("btn-dashboard").addEventListener("click", async () => {
  const { tynoApiUrl } = await new Promise(r => chrome.storage.sync.get(["tynoApiUrl"], r));
  if (tynoApiUrl) chrome.tabs.create({ url: `${tynoApiUrl}/dashboard` });
  else chrome.runtime.openOptionsPage();
});

$("btn-options").addEventListener("click", () => chrome.runtime.openOptionsPage());

// Init
(async () => {
  await Promise.all([checkConnection(), loadLastSync(), updatePageInfo()]);
})();
