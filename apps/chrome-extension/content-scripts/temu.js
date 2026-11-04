/**
 * Tyno Connect — content script Temu
 * Injecte un bouton "Importer dans Tyno" sur les fiches produit.
 * Action uniquement sur clic explicite — aucune collecte automatique.
 * Ne collecte jamais cookies, tokens ou sessions.
 */

(function () {
  "use strict";

  const BUTTON_ID = "tyno-import-btn";
  const TOAST_ID  = "tyno-toast";

  function isProductPage() {
    return (
      location.pathname.includes("/goods/") ||
      location.pathname.includes("/listing/") ||
      document.querySelector('[data-testid="product-title"]') !== null ||
      document.querySelector(".goods-title") !== null
    );
  }

  function extractProductData() {
    const title =
      document.querySelector('[data-testid="product-title"]')?.textContent?.trim() ||
      document.querySelector(".goods-title")?.textContent?.trim() ||
      document.title;

    const priceEl =
      document.querySelector('[data-testid="product-price"]') ||
      document.querySelector(".price-current") ||
      document.querySelector("[class*='price']");
    const priceText = priceEl?.textContent?.trim() ?? "";
    const price = parseFloat(priceText.replace(/[^0-9.,]/g, "").replace(",", ".")) || null;

    const images = Array.from(
      document.querySelectorAll("img[src*='goods'], img[src*='product'], .product-image img, [class*='gallery'] img")
    )
      .map(img => img.src)
      .filter(src => src && src.startsWith("http") && !src.includes("placeholder"))
      .slice(0, 6);

    const url = location.href;

    return { title, price, images, url, importedAt: new Date().toISOString() };
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
    btn.textContent = "📦 Importer dans Tyno";
    btn.style.cssText = `
      position: fixed; bottom: 20px; right: 20px; z-index: 999999;
      background: #f97316; color: #fff; border: none; border-radius: 10px;
      padding: 12px 20px; font-size: 15px; font-weight: 600; cursor: pointer;
      box-shadow: 0 4px 20px rgba(249,115,22,0.5); font-family: system-ui, sans-serif;
      transition: transform 0.15s, box-shadow 0.15s;
    `;
    btn.addEventListener("mouseenter", () => {
      btn.style.transform = "scale(1.05)";
      btn.style.boxShadow = "0 6px 25px rgba(249,115,22,0.7)";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.transform = "scale(1)";
      btn.style.boxShadow = "0 4px 20px rgba(249,115,22,0.5)";
    });

    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "⏳ Import en cours…";
      try {
        const data = extractProductData();
        if (!data.title) throw new Error("Titre introuvable — êtes-vous sur une fiche produit ?");

        // Envoyer via le service worker (MV3)
        const response = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage(
            { type: "IMPORT_PRODUCT", payload: data },
            (res) => {
              if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
              resolve(res);
            }
          );
        });

        if (response?.ok) {
          showToast("✅ Produit importé dans Tyno !");
          btn.textContent = "✅ Importé";
          setTimeout(() => { btn.textContent = "📦 Importer dans Tyno"; btn.disabled = false; }, 3000);
        } else {
          throw new Error(response?.error ?? "Erreur inconnue");
        }
      } catch (err) {
        showToast(`❌ ${err.message}`, true);
        btn.textContent = "📦 Importer dans Tyno";
        btn.disabled = false;
      }
    });

    document.body.appendChild(btn);
  }

  function init() {
    if (isProductPage()) injectButton();
  }

  // Init + observer pour SPA navigation
  init();
  const observer = new MutationObserver(() => {
    if (isProductPage() && !document.getElementById(BUTTON_ID)) injectButton();
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
