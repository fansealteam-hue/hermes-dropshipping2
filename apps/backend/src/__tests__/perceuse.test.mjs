/**
 * Scenario test: perceuse (drill) — full flow simulation with fictitious data.
 * Run: node --test apps/backend/src/__tests__/perceuse.test.mjs
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Use an in-memory test DB
process.env.DB_PATH = ":memory:";
process.env.NODE_ENV = "test";

const { default: db } = await import("../db/db.js");

// Run migrations on in-memory DB
const schema = fs.readFileSync(path.join(__dirname, "../db/schema.sql"), "utf8");
schema.split(";").map(s => s.trim()).filter(Boolean).forEach(stmt => {
  try { db.exec(stmt + ";"); } catch (e) { if (!e.message.includes("already exists")) throw e; }
});

// Seed test account
db.prepare("INSERT OR IGNORE INTO seller_accounts (account_id, channel, label, active, created_at) VALUES ('lbc_test','leboncoin','Compte Test',1,datetime('now'))").run();

const { fetchProduct } = await import("../services/products.js");
const { createListing } = await import("../services/listings.js");
const { confirmSale, addTracking, confirmDelivery } = await import("../services/sales.js");
const { suggestPrice, validatePrice } = await import("../services/pricing.js");

describe("Perceuse — parcours complet", () => {
  let product, listing, sale;

  test("1. Fetch product (local warehouse)", async () => {
    product = await fetchProduct("https://www.temu.com/perceuse-test.html");
    assert.equal(product.warehouseStatus, "local", "Entrepôt doit être local");
    assert.ok(product.variants.length >= 2, "Doit avoir au moins 2 variantes");
    assert.equal(product.variants[0].label, "Perceuse seule");
    assert.equal(product.variants[1].label, "Pack avec batterie");
  });

  test("2. Price suggestion — perceuse seule", () => {
    const v = product.variants[0]; // Perceuse seule, 15 EUR
    const suggested = suggestPrice(v.costEur);
    assert.ok(suggested > v.costEur, "Prix suggéré > coût");
    const check = validatePrice(v.costEur, suggested);
    assert.ok(check.valid, "Prix suggéré doit être valide");
  });

  test("3. Create listing — pack avec batterie", () => {
    const v = product.variants[1]; // Pack avec batterie, 22 EUR
    listing = createListing({
      temuItemId: product.temuItemId,
      variantId: v.variantId,
      accountId: "lbc_test",
      priceEur: 65.99,
    });
    assert.ok(listing.listingId, "listingId doit être défini");
    assert.equal(listing.status, "draft");
    assert.equal(listing.priceEur, 65.99);
    assert.equal(listing.costEur, 22.00);
  });

  test("4. Duplicate listing rejected (same listing_id / idempotency)", () => {
    // Creating same listing again works (different listing ID), but job is deduped
    const secondListing = createListing({
      temuItemId: product.temuItemId,
      variantId: product.variants[1].variantId,
      accountId: "lbc_test",
      priceEur: 65.99,
    });
    // Both exist — dedup is at the job level
    const jobs = db.prepare("SELECT * FROM jobs WHERE operation = 'publish_listing' AND payload LIKE '%' || ? || '%'").all(listing.listingId);
    assert.equal(jobs.length, 1, "Un seul job de publication par listing");
  });

  test("5. Confirm sale — deduplication on double event", () => {
    const eventId = "evt_lbc_001";
    const r1 = confirmSale({ listingId: listing.listingId, externalEventId: eventId, salePriceEur: 65.99, buyerName: "Jean Dupont", deliveryCity: "Paris" });
    const r2 = confirmSale({ listingId: listing.listingId, externalEventId: eventId, salePriceEur: 65.99 });
    assert.equal(r1.duplicate, false, "Premier appel ne doit pas être un doublon");
    assert.equal(r2.duplicate, true, "Deuxième appel doit être un doublon");
    assert.equal(r1.sale.saleId, r2.sale.saleId, "Les deux retournent la même vente");
    sale = r1.sale;
  });

  test("6. Alert job enqueued (not sent in test — stub)", () => {
    const alertJob = db.prepare("SELECT * FROM jobs WHERE operation = 'send_alert' AND idempotency_key = ?").get(`alert:${sale.saleId}`);
    assert.ok(alertJob, "Job d'alerte doit être créé");
    assert.equal(alertJob.status, "pending");
  });

  test("7. Add order reference", () => {
    const updated = addTracking(sale.saleId, { orderRef: "ORD-DRILL-2024", trackingNumber: "", trackingCarrier: "" });
    assert.equal(updated.orderRef, "ORD-DRILL-2024");
    assert.equal(updated.status, "order_placed");
  });

  test("8. Add tracking number", () => {
    const updated = addTracking(sale.saleId, { orderRef: "", trackingNumber: "CP1234567890FR", trackingCarrier: "Colis Privé" });
    assert.equal(updated.trackingNumber, "CP1234567890FR");
    assert.equal(updated.trackingCarrier, "Colis Privé");
    assert.equal(updated.status, "tracking_added");
  });

  test("9. Confirm delivery via Leboncoin", () => {
    const updated = confirmDelivery(sale.saleId, { confirmed: true });
    assert.equal(updated.leboncoinDeliveryConfirmed, true);
    assert.equal(updated.manualActionRequired, false);
    assert.equal(updated.status, "delivered");
  });

  test("10. No buyer address in history/logs", () => {
    const history = db.prepare("SELECT * FROM sale_history WHERE sale_id = ?").all(sale.saleId);
    const allValues = JSON.stringify(history);
    assert.ok(!allValues.includes("Paris"), "La ville de livraison ne doit pas apparaître dans l'historique");
  });

  test("11. Ineligible warehouse rejected", async () => {
    // Temporarily set warehouse to china
    db.prepare("UPDATE products SET warehouse_status = 'china' WHERE temu_item_id = ?").run(product.temuItemId);
    try {
      createListing({
        temuItemId: product.temuItemId,
        variantId: product.variants[0].variantId,
        accountId: "lbc_test",
        priceEur: 45.99,
      });
      assert.fail("Doit lancer une erreur pour entrepôt non local");
    } catch (e) {
      assert.equal(e.code, "INELIGIBLE_WAREHOUSE");
    } finally {
      db.prepare("UPDATE products SET warehouse_status = 'local' WHERE temu_item_id = ?").run(product.temuItemId);
    }
  });
});
