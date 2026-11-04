/**
 * Tyno Connect — content script Leboncoin
 * Bouton "Synchroniser avec Tyno" sur les pages d'annonce.
 * Lecture DOM public uniquement — aucune session, aucun cookie collecté.
 */

(function () {
  "use strict";

  const BUTTON_ID = "tyno-lbc-btn";
  const TOAST_ID  = "tyno-lbc-toast";

  function isListingPage() {
    return (
      location.pathname.match(/\/ad\/[^/]+\/\d+/) ||
      document.querySelector("[data-qa-id='adview_title']") !== null
    );
  }

  function isSalesPage() {
    return location.pathname.includes("/mes-annonces") || location.pathname.includes("/compte");
  }

  function extractListingData() {
    const title =
      document.querySelector("[data-qa-id='adview_title']")?.textContent?.trim() ||
      document.querySelector("h1")?.textContent?.trim() ||
      document.title;

    const priceEl = document.querySelector("[data-qa-id='adview_price']") ||
                    document.querySelector("[itemprop='price']");
    const priceText = priceEl?.textContent?.trim() ?? "";
    const price = parseFloat(priceText.replace(/[^0-9.,]/g, "").replace(",", ".")) || null;

    const statusEl = document.querySelector("[data-qa-id='adview_ad_state']");
    const status = statusEl?.textContent?.trim() ?? null;

    const images = Array.from(document.querySelectorAll("[data-testid='image'] img, .AdviewImages img"))
      .map(img => img.src || img.getAttribute("data-src"))
      .filter(Boolean)
      .slice(0, 6);

    const adId = location.pathname.match(/\/(\d+)\/?$/)?.[1] ?? null;

    return { title, price, status, images, adId, url: location.href, platform: "leboncoin", importedAt: new Date().toISOString() };
  }

  function showToast(message, isError = false, containerId = TOAST_ID) {
    let toast = document.getElementById(containerId);
    if (!toast) {
      toast = document.createElement("div");
      toast.id = containerId;
      toast.style.cssText = `
        position: fixed; bottom: 80px; right: 20px; z-index: 999999;
        padding: 12px 20px; border-radius: 8px; font-size: 14px; font-weight: 500;
        color: #fff; max-width: 300px; box-shadow: 0 4px 20px rgba(0,0,0,0.4);
        transition: opacity 0.3s; font-family: system-ui, sans-serif;
      `;
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.style.background = isError ? "#dc2626" : "#16a34a";
    toast.style.opacity = "1";
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.style.opacity = "0"; }, 3500);
  }

  function injectButton() {
    if (document.getElementById(BUTTON_ID)) return;

    const btn = document.createElement("button");
    btn.id = BUTTON_ID;
    btn.textContent = "🔄 Synchroniser avec Tyno";
    btn.style.cssText = `
      position: fixed; bottom: 20px; right: 20px; z-index: 999999;
      background: #f97316; color: #fff; border: none; border-radius: 10px;
      padding: 12px 20px; font-size: 15px; font-weight: 600; cursor: pointer;
      box-shadow: 0 4px 20px rgba(249,115,22,0.5); font-family: system-ui, sans-serif;
    `;

    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "⏳ Sync en cours…";
      try {
        const data = extractListingData();
        const response = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage(
            { type: "SYNC_LISTING", payload: data },
            (res) => {
              if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
              resolve(res);
            }
          );
        });
        if (response?.ok) {
          showToast("✅ Annonce synchronisée avec Tyno !");
          btn.textContent = "✅ Synchronisé";
          setTimeout(() => { btn.textContent = "🔄 Synchroniser avec Tyno"; btn.disabled = false; }, 3000);
        } else {
          throw new Error(response?.error ?? "Erreur");
        }
      } catch (err) {
        showToast(`❌ ${err.message}`, true);
        btn.textContent = "🔄 Synchroniser avec Tyno";
        btn.disabled = false;
      }
    });

    document.body.appendChild(btn);
  }

  function init() {
    if (isListingPage() || isSalesPage()) injectButton();
  }

  init();
  const observer = new MutationObserver(() => {
    if ((isListingPage() || isSalesPage()) && !document.getElementById(BUTTON_ID)) injectButton();
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
