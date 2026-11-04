/**
 * Tyno Connect — content script Vinted
 * Bouton "Synchroniser avec Tyno" sur les fiches article Vinted.
 * Lecture DOM public uniquement — aucune session, aucun cookie collecté.
 */

(function () {
  "use strict";

  const BUTTON_ID = "tyno-vinted-btn";
  const TOAST_ID  = "tyno-vinted-toast";

  function isItemPage() {
    return location.pathname.match(/\/items\/\d+/) !== null;
  }

  function extractItemData() {
    const title =
      document.querySelector("[itemprop='name']")?.textContent?.trim() ||
      document.querySelector("h1")?.textContent?.trim() ||
      document.title;

    const priceEl = document.querySelector("[itemprop='price']") ||
                    document.querySelector("[data-testid='item-price']");
    const priceText = priceEl?.textContent?.trim() ?? "";
    const price = parseFloat(priceText.replace(/[^0-9.,]/g, "").replace(",", ".")) || null;

    const brandEl = document.querySelector("[itemprop='brand']") || document.querySelector("[data-testid='item-brand']");
    const brand = brandEl?.textContent?.trim() ?? null;

    const conditionEl = document.querySelector("[itemprop='itemCondition']") || document.querySelector("[data-testid='item-condition']");
    const condition = conditionEl?.textContent?.trim() ?? null;

    const images = Array.from(document.querySelectorAll("[data-testid='item-photos'] img, .ItemPhotos img, [class*='photo'] img"))
      .map(img => img.src || img.getAttribute("data-src"))
      .filter(src => src && src.startsWith("http"))
      .slice(0, 6);

    const itemId = location.pathname.match(/\/items\/(\d+)/)?.[1] ?? null;

    return { title, price, brand, condition, images, itemId, url: location.href, platform: "vinted", importedAt: new Date().toISOString() };
  }

  function showToast(message, isError = false) {
    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement("div");
      toast.id = TOAST_ID;
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
        const data = extractItemData();
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
          showToast("✅ Article synchronisé avec Tyno !");
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
    if (isItemPage()) injectButton();
  }

  init();
  const observer = new MutationObserver(() => {
    if (isItemPage() && !document.getElementById(BUTTON_ID)) injectButton();
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
