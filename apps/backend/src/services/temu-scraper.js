/**
 * Claude 2 — Temu product scraper.
 * Uses Playwright (pre-installed at /opt/pw-browsers/chromium) for JS-rendered pages.
 * Falls back to fetch for API endpoints when possible.
 */
const { chromium } = require("playwright");
const { randomUUID } = require("crypto");

const BROWSER_PATH = process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const SCRAPE_TIMEOUT_MS = parseInt(process.env.TEMU_SCRAPE_TIMEOUT_MS ?? "20000");

/**
 * Scrape a Temu product page and return structured data.
 * Returns the same shape as the stub in products.js.
 */
async function scrapeTemu(temuUrl) {
  const itemId = extractTemuItemId(temuUrl);

  // Try lightweight API approach first (faster, no browser needed)
  try {
    const apiResult = await fetchTemuApi(itemId, temuUrl);
    if (apiResult) return apiResult;
  } catch (_) {
    // fall through to browser
  }

  // Full browser scrape
  return browserScrape(temuUrl, itemId);
}

/**
 * Attempt to call Temu's internal API (reverse-engineered endpoint).
 * This is fragile — Temu may change or block it.
 */
async function fetchTemuApi(itemId, originalUrl) {
  if (!itemId) return null;

  // Temu uses a goods_detail API with a goods_id parameter
  const apiUrl = `https://www.temu.com/api/phantom/tag/goods/detail?goods_id=${itemId}&language=fr&currency=EUR`;

  const headers = {
    "User-Agent": "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    "Accept": "application/json",
    "Referer": originalUrl,
    "x-luna-tag": "0",
  };

  const resp = await fetch(apiUrl, { headers, signal: AbortSignal.timeout(8000) });
  if (!resp.ok) return null;

  const json = await resp.json();
  const result = json?.result?.goods_detail ?? json?.data;
  if (!result) return null;

  return parseTemuApiResponse(result, itemId, originalUrl);
}

function parseTemuApiResponse(data, itemId, url) {
  const title = data.goods_name ?? data.title ?? "Produit Temu";

  // Warehouse: check if local EU warehouse is available
  const warehouseStatus = detectWarehouse(data);

  // Variants
  const skuList = data.sku_list ?? data.goods_sku_list ?? [];
  const variants = skuList.length > 0
    ? skuList.map(sku => parseSkuToVariant(sku))
    : [{
        variantId: `${itemId}-default`,
        sku: String(itemId),
        label: title,
        costEur: parsePriceCents(data.original_price_cents ?? data.price_cents) / 100,
        stock: data.goods_inventory ?? 99,
        imageUrls: extractImages(data),
      }];

  const specs = extractSpecs(data);

  return {
    temuItemId: String(itemId),
    title,
    warehouseStatus,
    specs,
    variants: variants.filter(v => v.costEur > 0),
  };
}

function parseSkuToVariant(sku) {
  const attrs = (sku.multi_spec_desc ?? []).map(a => a.spec_value).join(" / ");
  return {
    variantId: String(sku.sku_id ?? sku.goods_sku_id ?? randomUUID()),
    sku: String(sku.sku_no ?? sku.sku_id ?? ""),
    label: attrs || sku.sku_name || "Variante",
    costEur: parsePriceCents(sku.price_cents ?? sku.original_price_cents) / 100,
    stock: sku.sku_inventory ?? sku.stock ?? 0,
    imageUrls: sku.thumb_url ? [sku.thumb_url] : [],
  };
}

/** Extract full technical specs from Temu product data */
function extractSpecs(data) {
  const specs = {};

  // From goods_attrs array: [{attr_name, attr_value}]
  const attrs = data.goods_attrs ?? data.attrs ?? data.attributes ?? [];
  for (const a of attrs) {
    const key = (a.attr_name ?? a.name ?? "").toLowerCase();
    const val = a.attr_value ?? a.value ?? "";
    if (!key || !val) continue;
    if (key.includes("batterie") || key.includes("battery")) specs.battery = val;
    else if (key.includes("poids") || key.includes("weight")) specs.weight = val;
    else if (key.includes("taille") || key.includes("size") || key.includes("dimension")) specs.dimensions = val;
    else if (key.includes("couleur") || key.includes("color")) specs.color = val;
    else if (key.includes("matière") || key.includes("material")) specs.material = val;
    else if (key.includes("tension") || key.includes("voltage")) specs.voltage = val;
    else if (key.includes("puissance") || key.includes("power")) specs.power = val;
    else specs[key] = val;
  }

  // Also check top-level fields
  if (!specs.weight && data.weight) specs.weight = `${data.weight}g`;
  if (!specs.dimensions && data.length && data.width) {
    specs.dimensions = `${data.length}×${data.width}×${data.height ?? "?"}cm`;
  }

  return specs;
}

function detectWarehouse(data) {
  // Temu marks local EU warehouse with warehouse_id or shipping_time
  const warehouseId = data.warehouse_id ?? data.shipping_from;
  if (!warehouseId) {
    // Heuristic: if standard delivery < 8 days, likely EU local
    const days = data.delivery_days ?? data.min_delivery_days ?? 99;
    if (days <= 7) return "local";
    return "unknown";
  }
  // Known EU warehouse IDs (update as discovered)
  const euWarehouseIds = ["eu_warehouse", "fr_warehouse", "de_warehouse", "1", "EU"];
  if (euWarehouseIds.some(id => String(warehouseId).toLowerCase().includes(id.toLowerCase()))) {
    return "local";
  }
  return "china";
}

function parsePriceCents(raw) {
  if (!raw) return 0;
  // Temu sometimes returns price in cents (EUR cents), sometimes in decimal
  const n = parseFloat(String(raw));
  if (n > 10000) return n; // already cents
  return Math.round(n * 100); // decimal EUR → cents
}

function extractImages(data) {
  const images = data.goods_imgs ?? data.goods_image_url ?? [];
  if (Array.isArray(images)) return images.slice(0, 5).map(img => img?.url ?? img).filter(Boolean);
  if (typeof images === "string") return [images];
  return [];
}

/**
 * Browser-based scrape using Playwright.
 * Launches headless Chromium, navigates to product page, extracts data from JS state.
 */
async function browserScrape(temuUrl, itemId) {
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: BROWSER_PATH,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
      locale: "fr-FR",
      viewport: { width: 390, height: 844 },
    });

    const page = await context.newPage();

    // Intercept API responses from Temu's internal XHR
    let capturedData = null;
    page.on("response", async response => {
      const url = response.url();
      if (url.includes("goods_detail") || url.includes("goods/detail")) {
        try {
          const json = await response.json();
          if (json?.result?.goods_detail || json?.data) {
            capturedData = json?.result?.goods_detail ?? json?.data;
          }
        } catch (_) {}
      }
    });

    await page.goto(temuUrl, { waitUntil: "networkidle", timeout: SCRAPE_TIMEOUT_MS });

    // Extract serialised state exposed by Temu's SSR (read-only JS properties, no eval of user data)
    const pageData = await page.evaluate(() => {
      // These are read-only window properties set by Temu's own bundle — not eval of external input
      const store = window.__STORE__ ?? window.__INITIAL_STATE__ ?? window.__REDUX_STATE__;
      if (store) return JSON.stringify(store);
      const meta = document.querySelector('meta[name="goods_id"]');
      if (meta) return JSON.stringify({ goods_id: meta.getAttribute("content") });
      return null;
    });

    if (capturedData) {
      return parseTemuApiResponse(capturedData, itemId ?? extractTemuItemId(temuUrl), temuUrl);
    }

    // Fallback: extract from page DOM
    const title = await page.title();
    const priceEl = await page.$("[data-spm-anchor-id*='price'], .price, [class*='price']");
    const priceText = priceEl ? await priceEl.textContent() : "0";
    const priceEur = parseFloat(priceText.replace(/[^0-9.]/g, "")) || 0;

    const images = await page.$$eval("img[src*='temu']", imgs =>
      imgs.slice(0, 5).map(img => img.src).filter(s => s.includes("goods"))
    );

    return {
      temuItemId: itemId ?? `scraped-${Date.now()}`,
      title: title.replace(" | Temu France", "").trim(),
      warehouseStatus: "unknown",
      variants: [{
        variantId: `${itemId}-default`,
        sku: "",
        label: "Variante unique",
        costEur: priceEur,
        stock: 1,
        imageUrls: images,
      }],
    };
  } finally {
    await browser?.close();
  }
}

function extractTemuItemId(url) {
  // Match goods_id= in URL
  const m = url.match(/goods.id=(\d+)/i) ?? url.match(/goods[_-]detail[_-](.+?)\.html/i);
  if (m) return m[1];
  // Match numeric segment in URL
  const numMatch = url.match(/(\d{15,})/);
  return numMatch?.[1] ?? null;
}

module.exports = { scrapeTemu, extractTemuItemId };
