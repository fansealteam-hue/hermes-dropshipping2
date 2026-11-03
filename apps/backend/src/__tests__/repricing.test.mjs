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
  countPublishedToday,
  REPRICE_DAYS_1,
  MAX_REPRICE_COUNT,
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

function makeListing({ listingId = "lst_reprice1", priceCents = 7499, costCents = 2200, publishedDaysAgo = 8, repricingCount = 0, deliveryFeeCents = 300, lastRepricedDaysAgo = null, status = "published" } = {}) {
  const publishedAt = new Date(Date.now() - publishedDaysAgo * 24 * 3600 * 1000).toISOString();
  const lastRepricedAt = lastRepricedDaysAgo != null
    ? new Date(Date.now() - lastRepricedDaysAgo * 24 * 3600 * 1000).toISOString()
    : null;
  db.prepare(`
    INSERT OR REPLACE INTO listings
      (listing_id, channel, account_id, temu_item_id, variant_id, title, description,
       price_eur_cents, cost_eur_cents, media_urls, status, published_at,
       delivery_option, delivery_fee_eur_cents, repricing_count, last_repriced_at, created_at, updated_at)
    VALUES (?, 'leboncoin', 'lbc_compte_a', 'item_reprice', 'var_reprice', 'Test', '',
            ?, ?, '[]', ?, ?, 'autre', ?, ?, ?, datetime('now'), datetime('now'))
  `).run(listingId, priceCents, costCents, status, publishedAt, deliveryFeeCents, repricingCount, lastRepricedAt);
}

before(() => {
  makeProduct();
  makeVariant();
});

// ─── computeRepriceAction ────────────────────────────────────────────────────

describe("computeRepriceAction", () => {
  it("cycle 0 → reprice seulement", () => {
    makeListing({ listingId: "lst_r1", repricingCount: 0 });
    const row = db.prepare("SELECT * FROM listings WHERE listing_id = ?").get("lst_r1");
    const result = computeRepriceAction(row);
    assert.equal(result.action, "reprice");
    assert.ok(result.newPriceEur < 74.99, "Prix doit être baissé");
  });

  it("cycle 1 → reprice_refresh (nouvelles photos)", () => {
    makeListing({ listingId: "lst_r2", repricingCount: 1 });
    const row = db.prepare("SELECT * FROM listings WHERE listing_id = ?").get("lst_r2");
    assert.equal(computeRepriceAction(row).action, "reprice_refresh");
  });

  it("cycle 2 → reprice_refresh (nouvelles photos)", () => {
    makeListing({ listingId: "lst_r2b", repricingCount: 2 });
    const row = db.prepare("SELECT * FROM listings WHERE listing_id = ?").get("lst_r2b");
    assert.equal(computeRepriceAction(row).action, "reprice_refresh");
  });

  it(`cycle ${MAX_REPRICE_COUNT} → archive (3 cycles épuisés)`, () => {
    makeListing({ listingId: "lst_r3", repricingCount: MAX_REPRICE_COUNT });
    const row = db.prepare("SELECT * FROM listings WHERE listing_id = ?").get("lst_r3");
    assert.equal(computeRepriceAction(row).action, "archive");
  });

  it("archive si marge insuffisante après baisse (même cycle 0)", () => {
    // 32€ base, coût 20€ : après -15% → 27.2€, marge = 27.2-20-2.99 = 4.21€ < 5€ → archive
    makeListing({ listingId: "lst_r4", priceCents: 3200, costCents: 2000, deliveryFeeCents: 0, repricingCount: 0 });
    const row = db.prepare("SELECT * FROM listings WHERE listing_id = ?").get("lst_r4");
    assert.equal(computeRepriceAction(row).action, "archive");
  });
});

// ─── applyReprice ─────────────────────────────────────────────────────────────

describe("applyReprice", () => {
  it("stocke le nouveau prix et incrémente repricing_count", () => {
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
  it("passe le statut à archived", () => {
    makeListing({ listingId: "lst_r6", status: "published" });
    archiveListing("lst_r6");
    const row = db.prepare("SELECT * FROM listings WHERE listing_id = ?").get("lst_r6");
    assert.equal(row.status, "archived");
  });
});

// ─── getListingsDueForReprice ─────────────────────────────────────────────────

describe("getListingsDueForReprice", () => {
  it("retourne les annonces publiées depuis > REPRICE_DAYS_1 jours", () => {
    makeListing({ listingId: "lst_old", publishedDaysAgo: 8, status: "published" });
    makeListing({ listingId: "lst_new", publishedDaysAgo: 3, status: "published" });
    const due = getListingsDueForReprice();
    const ids = due.map(l => l.listing_id);
    assert.ok(ids.includes("lst_old"));
    assert.ok(!ids.includes("lst_new"));
  });

  it("utilise last_repriced_at si disponible (pas published_at)", () => {
    // publiée il y a 20 jours mais reproposée il y a 3 jours seulement → pas due
    makeListing({ listingId: "lst_recently_repriced", publishedDaysAgo: 20, lastRepricedDaysAgo: 3, repricingCount: 1, status: "published" });
    const due = getListingsDueForReprice();
    assert.ok(!due.find(l => l.listing_id === "lst_recently_repriced"), "ne doit pas être due (reproposée récemment)");
  });

  it("n'inclut pas les annonces vendues", () => {
    makeListing({ listingId: "lst_sold_old", publishedDaysAgo: 10, status: "published" });
    db.prepare("INSERT OR IGNORE INTO sales (sale_id, listing_id, channel, temu_item_id, variant_id, account_id, supplier_url, sale_price_eur_cents, cost_eur_cents, status, confirmed_at, updated_at) VALUES (?,?,'leboncoin',?,?,?,?,?,?,'confirmed',datetime('now'),datetime('now'))")
      .run("sale_x1", "lst_sold_old", "item_reprice", "var_reprice", "lbc_compte_a", "https://temu.com", 7499, 2200);
    const due = getListingsDueForReprice();
    assert.ok(!due.find(l => l.listing_id === "lst_sold_old"));
  });
});

// ─── countPublishedToday ─────────────────────────────────────────────────────

describe("countPublishedToday", () => {
  it("compte les annonces créées aujourd'hui", () => {
    const before = countPublishedToday();
    makeListing({ listingId: "lst_today1", status: "published" });
    makeListing({ listingId: "lst_today2", status: "draft" });
    assert.equal(countPublishedToday(), before + 2);
  });
});
