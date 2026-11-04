/**
 * Tyno Connect — options page script
 */

const $url   = document.getElementById("api-url");
const $token = document.getElementById("api-token");
const $save  = document.getElementById("btn-save");
const $disc  = document.getElementById("btn-disconnect");
const $box   = document.getElementById("status-box");
const $icon  = document.getElementById("status-icon");
const $msg   = document.getElementById("status-msg");
const $badge = document.getElementById("saved-badge");

function showStatus(type, icon, text) {
  $box.className = `status-box ${type}`;
  $icon.textContent = icon;
  $msg.textContent = text;
}

function hideStatus() {
  $box.className = "status-box";
}

async function testConnection(url, token) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${url}/api/status`, {
      signal: controller.signal,
      headers: { "X-Tyno-Token": token },
    });
    clearTimeout(tid);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const json = await res.json();
    return { ok: true, data: json };
  } catch (err) {
    clearTimeout(tid);
    if (err.name === "AbortError") return { ok: false, error: "Délai dépassé — serveur inaccessible" };
    return { ok: false, error: err.message };
  }
}

// Load saved config
chrome.storage.sync.get(["tynoApiUrl", "tynoApiToken"], ({ tynoApiUrl, tynoApiToken }) => {
  if (tynoApiUrl)   $url.value   = tynoApiUrl;
  if (tynoApiToken) $token.value = tynoApiToken;
});

$save.addEventListener("click", async () => {
  const url   = $url.value.trim().replace(/\/$/, "");
  const token = $token.value.trim();

  if (!url)   return showStatus("error", "❌", "URL manquante");
  if (!token) return showStatus("error", "❌", "Token manquant");

  $save.disabled = true;
  $save.textContent = "⏳ Test en cours…";
  showStatus("info", "⏳", "Connexion au serveur Tyno…");

  const res = await testConnection(url, token);

  if (res.ok) {
    chrome.storage.sync.set({ tynoApiUrl: url, tynoApiToken: token, connected: true });
    showStatus("ok", "✅", `Connexion réussie — Tyno v${res.data?.version ?? "?"}`);
    $badge.classList.add("show");
    setTimeout(() => $badge.classList.remove("show"), 3000);
  } else {
    showStatus("error", "❌", `Connexion échouée : ${res.error}`);
    chrome.storage.sync.set({ connected: false });
  }

  $save.disabled = false;
  $save.textContent = "💾 Enregistrer et tester";
});

$disc.addEventListener("click", () => {
  chrome.storage.sync.remove(["tynoApiToken", "connected", "lastSync"], () => {
    $token.value = "";
    showStatus("info", "🔌", "Déconnecté — le token a été supprimé");
  });
});
