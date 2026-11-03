import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.DB_PATH = ":memory:";

const { runMigrations } = await import("../db/migrate.js");
const db = (await import("../db/db.js")).default;
runMigrations(db);

const {
  computeRepriceAction,
  applyReprice,
  archiveListing,
  getListingsDueForReprice,
  REPRICE_DAYS_1,
  REPRICE_STEP_PCT,
  MIN_MARGIN_EUR,
} = await import("../services/repricing.js");

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeProduct(id = "item_reprice") {
  db.prepare("INSERT OR IGNORE INTO products (temu_item_id, temu_url, title, warehouse_status, fetched_at) VALUES (?,?,?,?,datetime('now'))")
    .run(id, "https://temu.com/p/" + id, "Perceuse test", "local");
}

function makeVariant(itemId = "item_reprice", variantId = "var_reprice") {
  db.prepare("INSERT OR IGNORE INTO variants (variant_id, temu_item_id, sku, label, cost_eur_cents, stock, image_urls, created_at) VALUES (?,?,?,?,?,?,?,datetime('now'))")
    .run(variantId, itemId, "sku1", "Standard", 2200, 10, "[]");
}

function makeListing({ listingId = "lst_reprice1", priceCents = 7499, costCents = 2200, publishedDaysAgo = 8, repricingCount = 0, deliveryFeeCents = 300, status = "published" } = {}) {
  const publishedAt = new Date(Date.now() - publishedDaysAgo * 24 * 3600 * 1000).toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO listings
      (listing_id, channel, account_id, temu_item_id, variant_id, title, description,
       price_eur_cents, cost_eur_cents, media_urls, status, published_at,
       delivery_option, delivery_fee_eur_cents, repricing_count, created_at, updated_at)
    VALUES (?, 'leboncoin', 'lbc_compte_a', 'item_reprice', 'var_reprice', 'Test', '',
            ?, ?, '[]', ?, ?, 'autre', ?, ?, datetime('now'), datetime('now'))
  `).run(listingId, priceCents, costCents, status, publishedAt, deliveryFeeCents, repricingCount);
}

before(() => {
  makeProduct();
  makeVariant();
});

// ─── computeRepriceAction ────────────────────────────────────────────────────

describe("computeRepriceAction", () => {
  it("returns reprice action after 8 days", () => {
    makeListing({ listingId: "lst_r1", priceCents: 7499, costCents: 2200, publishedDaysAgo: 8 });
    const listing = db.prepare("SELECT * FROM listings WHERE listing_id = ?").get("lst_r1");
    const result = computeRepriceAction(listing);
    assert.equal(result.action, "reprice");
    // new base = (7499 - 300) * 0.85 = 6118.15 → floor = 6118, + 300 = 6418 → 64.18€
    assert.ok(result.newPriceEur < 74.99, "Prix doit être baissé");
    assert.ok(result.newPriceEur > 0);
  });

  it("returns reprice_refresh action after 15 days", () => {
    makeListing({ listingId: "lst_r2", priceCents: 7499, costCents: 2200, publishedDaysAgo: 15 });
    const listing = db.prepare("SELECT * FROM listings WHERE listing_id = ?").get("lst_r2");
    const result = computeRepriceAction(listing);
    assert.equal(result.action, "reprice_refresh");
  });

  it("returns archive when margin would go negative", () => {
    // Prix très bas : 8€ base + 3€ livraison = 11€, coût 22€ → archiver
    makeListing({ listingId: "lst_r3", priceCents: 1100, costCents: 2200, publishedDaysAgo: 8 });
    const listing = db.prepare("SELECT * FROM listings WHERE listing_id = ?").get("lst_r3");
    const result = computeRepriceAction(listing);
    assert.equal(result.action, "archive");
  });

  it("returns archive when repricing would fall below MIN_MARGIN_EUR", () => {
    // coût 20€, temu shipping 2.99€, min margin 5€ → prix plancher = 27.99€
    // pour archiver après -15% : prix actuel doit être < 27.99 / 0.85 = 32.93€
    // on prend 32€ : après -15% → 27.2€ → marge = 27.2 - 20 - 2.99 = 4.21€ < 5€ → archive
    makeListing({ listingId: "lst_r4", priceCents: 3200, costCents: 2000, deliveryFeeCents: 0, publishedDaysAgo: 8 });
    const listing = db.prepare("SELECT * FROM listings WHERE listing_id = ?").get("lst_r4");
    const result = computeRepriceAction(listing);
    assert.equal(result.action, "archive");
  });
});

// ─── applyReprice ─────────────────────────────────────────────────────────────

describe("applyReprice", () => {
  it("stores new price and increments repricing_count", () => {
    makeListing({ listingId: "lst_r5", priceCents: 7499, repricingCount: 0 });
    applyReprice("lst_r5", 63.99);
    const row = db.prepare("SELECT * FROM listings WHERE listing_id = ?").get("lst_r5");
    assert.equal(row.price_eur_cents, 6399);
    assert.equal(row.repricing_count, 1);
    assert.ok(row.last_repriced_at);
  });
});

// ─── archiveListing ──────────────────────────────────────────────────────────

describe("archiveListing", () => {
  it("marks listing as archived", () => {
    makeListing({ listingId: "lst_r6", status: "published" });
    archiveListing("lst_r6");
    const row = db.prepare("SELECT * FROM listings WHERE listing_id = ?").get("lst_r6");
    assert.equal(row.status, "archived");
  });
});

// ─── getListingsDueForReprice ─────────────────────────────────────────────────

describe("getListingsDueForReprice", () => {
  it("returns published listings older than REPRICE_DAYS_1", () => {
    makeListing({ listingId: "lst_old", publishedDaysAgo: 8, status: "published" });
    makeListing({ listingId: "lst_new", publishedDaysAgo: 3, status: "published" });
    const due = getListingsDueForReprice();
    const ids = due.map(l => l.listing_id);
    assert.ok(ids.includes("lst_old"), "listing de 8 jours doit être dans la liste");
    assert.ok(!ids.includes("lst_new"), "listing de 3 jours ne doit pas être dans la liste");
  });

  it("ne retourne pas les annonces déjà vendues", () => {
    makeListing({ listingId: "lst_sold_old", publishedDaysAgo: 10, status: "published" });
    db.prepare("INSERT OR IGNORE INTO sales (sale_id, listing_id, channel, temu_item_id, variant_id, account_id, supplier_url, sale_price_eur_cents, cost_eur_cents, status, confirmed_at, updated_at) VALUES (?,?,'leboncoin',?,?,?,?,?,?,'confirmed',datetime('now'),datetime('now'))")
      .run("sale_x1", "lst_sold_old", "item_reprice", "var_reprice", "lbc_compte_a", "https://temu.com", 7499, 2200);
    const due = getListingsDueForReprice();
    assert.ok(!due.find(l => l.listing_id === "lst_sold_old"), "annonce vendue ne doit pas être reproposée");
  });
});
