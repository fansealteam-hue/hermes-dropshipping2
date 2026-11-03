/**
 * Claude A — tests : pricing strategies, description generator, photo enhancer.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
process.env.NODE_ENV = "test";

const { suggestPrice, suggestPriceStrategy, validatePrice, margin, DELIVERY_OTHER_FEE } = require("../services/pricing.js");
const { generateDescriptionSync } = require("../services/description-generator.js");
const { enhancePhotos } = require("../services/photo-enhancer.js");

const PERCEUSE = {
  temuItemId: "TEMU-DRILL-001",
  title: "Perceuse sans fil 18V",
  warehouseStatus: "local",
  specs: { battery: "18V Li-ion 2Ah", weight: "1.2kg", dimensions: "30×8×22cm" },
  variants: [
    { variantId: "VAR-DRILL-SOLO", label: "Perceuse seule", costEur: 15.00 },
    { variantId: "VAR-DRILL-PACK", label: "Pack avec batterie", costEur: 22.00 },
  ],
};

describe("Pricing — strategies", () => {
  test("suggestPrice adaptatif x2.5 pour 22€", () => {
    assert.equal(suggestPrice(22), 55.99); // floor(22*2.5)+0.99 = 55.99 (15€<cost<40€ → x2.5)
  });

  test("suggestPrice avec livraison autre +3€", () => {
    const base = suggestPrice(22);
    const withDelivery = suggestPrice(22, { deliveryOther: true });
    assert.equal(withDelivery, base + DELIVERY_OTHER_FEE);
  });

  test("suggestPriceStrategy retourne 3 options", () => {
    const s = suggestPriceStrategy(22);
    assert.ok(s.standard.priceEur > 0);
    assert.ok(s.fast.priceEur > s.standard.priceEur);
    assert.ok(s.premium.priceEur > s.fast.priceEur);
  });

  test("premium x10", () => {
    const s = suggestPriceStrategy(10);
    assert.ok(s.premium.priceEur >= 100); // floor(100)+0.99
  });

  test("validatePrice — marge insuffisante", () => {
    const r = validatePrice(20, 22);
    assert.equal(r.valid, false);
  });

  test("validatePrice — ok", () => {
    const r = validatePrice(22, 65.99);
    assert.equal(r.valid, true);
  });

  test("margin calcul", () => {
    const m = margin(22, 55.99);
    assert.ok(m.absolute > 30);
    assert.ok(m.percent > 50);
  });

  test("petit produit <15€ → x3 minimum", () => {
    // 10€ × 3 = 30 → 30.99
    assert.equal(suggestPrice(10), 30.99);
  });

  test("produit cher >80€ → x1.5", () => {
    // 100€ × 1.5 = 150 → 150.99
    assert.equal(suggestPrice(100), 150.99);
  });
});

describe("Description generator", () => {
  test("génère titre ≤ 70 chars", () => {
    const { listingTitle } = generateDescriptionSync(PERCEUSE, "Pack avec batterie");
    assert.ok(listingTitle.length <= 70);
    assert.ok(listingTitle.includes("Perceuse"));
  });

  test("génère description avec specs", () => {
    const { listingDescription } = generateDescriptionSync(PERCEUSE, "Pack avec batterie");
    assert.ok(listingDescription.length >= 50);
    assert.ok(listingDescription.includes("18V"));
  });

  test("description ≤ 600 chars", () => {
    const { listingDescription } = generateDescriptionSync(PERCEUSE, "Pack avec batterie");
    assert.ok(listingDescription.length <= 600);
  });
});

describe("Photo enhancer", () => {
  test("urls fixture → retournées telles quelles", async () => {
    const urls = ["fixture://img1.jpg", "fixture://img2.jpg"];
    const result = await enhancePhotos(urls, "TEMU-001", "VAR-001");
    assert.deepEqual(result, urls);
  });

  test("tableau vide → tableau vide", async () => {
    const result = await enhancePhotos([], "TEMU-001", "VAR-001");
    assert.deepEqual(result, []);
  });

  test("null → tableau vide", async () => {
    const result = await enhancePhotos(null, "TEMU-001", "VAR-001");
    assert.deepEqual(result, []);
  });
});
