/**
 * Claude A — tests : pricing strategies, description generator, photo enhancer.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
process.env.NODE_ENV = "test";

const { suggestPrice, suggestPriceStrategy, validatePrice, margin, DELIVERY_OTHER_FEE, TEMU_SHIPPING_FEE } = require("../services/pricing.js");
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
  test("suggestPrice inclut frais Temu (22€ produit + 2.99 frais = 24.99 → x3 = 74.99)", () => {
    // totalCost = 24.99, tranche 20-40 → x3, floor(74.97)+0.99 = 74.99
    assert.equal(suggestPrice(22), 74.99);
  });

  test("suggestPrice avec livraison autre +3€", () => {
    const base = suggestPrice(22);
    const withDelivery = suggestPrice(22, { deliveryOther: true });
    assert.equal(withDelivery, +(base + DELIVERY_OTHER_FEE).toFixed(2));
  });

  test("suggestPriceStrategy retourne 3 options avec marginEur", () => {
    const s = suggestPriceStrategy(22);
    assert.ok(s.standard.priceEur > 0);
    assert.ok(s.standard.marginEur > 0);
    assert.ok(s.fast.priceEur >= s.standard.priceEur);
    assert.ok(s.premium.priceEur >= s.fast.priceEur);
  });

  test("stratégie expose totalCostEur (produit + livraison Temu)", () => {
    const s = suggestPriceStrategy(15);
    assert.equal(s.standard.totalCostEur, +(15 + TEMU_SHIPPING_FEE).toFixed(2));
  });

  test("premium x10", () => {
    const s = suggestPriceStrategy(10);
    // totalCost = 12.99, premium = max(x4, x10) = x10 → floor(129.9)+0.99 = 129.99
    assert.ok(s.premium.priceEur >= 100);
  });

  test("validatePrice — marge insuffisante", () => {
    const r = validatePrice(20, 22);
    assert.equal(r.valid, false);
  });

  test("validatePrice — ok", () => {
    const r = validatePrice(22, 74.99);
    assert.equal(r.valid, true);
  });

  test("margin calcul", () => {
    const m = margin(22, 74.99);
    assert.ok(m.absolute > 50);
    assert.ok(m.percent > 60);
  });

  test("exemple réel : table 15€ + 2.99 frais vendue, prix suggéré couvre le coût", () => {
    // Exemple concret du user : table 15€ coût + 2.99 frais = 17.99€ coût réel
    const price = suggestPrice(15);
    const profit = price - (15 + TEMU_SHIPPING_FEE);
    assert.ok(profit > 30, `Bénéfice ${profit.toFixed(2)}€ doit dépasser 30€`);
  });

  test("petit produit <10€ hors frais → ~13€ coût réel → x4", () => {
    // 8€ + 2.99 = 10.99 → tranche 10-20 → x4, floor(43.96)+0.99 = 43.99
    assert.equal(suggestPrice(8), 43.99);
  });

  test("produit cher >80€ → x2", () => {
    // 100€ + 2.99 = 102.99 → tranche >80 → x2, floor(205.98)+0.99 = 205.99
    assert.equal(suggestPrice(100), 205.99);
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
