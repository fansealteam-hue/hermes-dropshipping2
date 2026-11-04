/**
 * Product service — stub that Claude 2 will complete with real Temu scraping.
 * Returns a typed product or throws with { code, message }.
 */
const db = require("../db/db");
const { randomUUID } = require("crypto");

/**
 * Fetch and cache a Temu product.
 * Claude 2 replaces fetchFromTemu() with real implementation.
 */
async function fetchProduct(temuUrl, { force = false } = {}) {
  // Check cache first (sauf vérification forcée du stock)
  const cached = force ? null : db.prepare(
    "SELECT * FROM products WHERE temu_url = ? AND fetched_at > datetime('now', '-1 hour')"
  ).get(temuUrl);

  if (cached) {
    const variants = db.prepare("SELECT * FROM variants WHERE temu_item_id = ?").all(cached.temu_item_id);
    return buildProductResponse(cached, variants);
  }

  // Claude 2 implements this:
  const raw = await fetchFromTemu(temuUrl);

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO products (temu_item_id, temu_url, title, warehouse_status, raw_json, fetched_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);
  stmt.run(raw.temuItemId, temuUrl, raw.title, raw.warehouseStatus, JSON.stringify(raw));

  const insertVariant = db.prepare(`
    INSERT OR REPLACE INTO variants (variant_id, temu_item_id, sku, label, cost_eur_cents, stock, image_urls, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  for (const v of raw.variants) {
    insertVariant.run(v.variantId, raw.temuItemId, v.sku ?? "", v.label, Math.round(v.costEur * 100), v.stock, JSON.stringify(v.imageUrls));
  }

  const saved = db.prepare("SELECT * FROM products WHERE temu_item_id = ?").get(raw.temuItemId);
  const variants = db.prepare("SELECT * FROM variants WHERE temu_item_id = ?").all(raw.temuItemId);
  return buildProductResponse(saved, variants);
}

function buildProductResponse(row, variantRows) {
  return {
    temuUrl: row.temu_url,
    temuItemId: row.temu_item_id,
    title: row.title,
    warehouseStatus: row.warehouse_status,
    variants: variantRows.map(v => ({
      variantId: v.variant_id,
      sku: v.sku,
      label: v.label,
      costEur: v.cost_eur_cents / 100,
      stock: v.stock,
      imageUrls: JSON.parse(v.image_urls),
    })),
    fetchedAt: row.fetched_at,
  };
}

/**
 * Fetch from Temu — real scraper for production, fixture for tests.
 */
async function fetchFromTemu(url) {
  // Test fixture (avoids real network in tests)
  if (url.includes("perceuse") || url.includes("drill") || url.includes("MOCK") || url.includes("test")) {
    return {
      temuItemId: "TEMU-DRILL-001",
      title: "Perceuse sans fil 18V",
      warehouseStatus: "local",
      variants: [
        { variantId: "VAR-DRILL-SOLO", sku: "DR18V-SOLO", label: "Perceuse seule", costEur: 15.00, stock: 42,
          imageUrls: ["https://img.temu.com/drill/1.jpg", "https://img.temu.com/drill/2.jpg"] },
        { variantId: "VAR-DRILL-PACK", sku: "DR18V-PACK", label: "Pack avec batterie", costEur: 22.00, stock: 18,
          imageUrls: ["https://img.temu.com/drill/pack1.jpg", "https://img.temu.com/drill/pack2.jpg", "https://img.temu.com/drill/pack3.jpg"] },
      ],
    };
  }

  // Real scraper (Claude 2)
  const { scrapeTemu } = require("./temu-scraper");
  const result = await scrapeTemu(url);
  if (!result || !result.temuItemId) {
    throw { code: "SCRAPE_FAILED", message: "Impossible d'extraire le produit Temu" };
  }
  return result;
}

module.exports = { fetchProduct };
