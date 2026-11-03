/**
 * Test: Telegram message formatters
 * Run: node --test apps/telegram/src/__tests__/messages.test.mjs
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { escMd, fmtSaleAlert, fmtTrackingAdded, fmtDashboard } from "../messages.js";

describe("escMd", () => {
  test("escapes special MarkdownV2 chars", () => {
    const result = escMd("Hello (world) 3.5€");
    assert.ok(result.includes("\\("), "Parenthèse ouvrante doit être backslashée");
    assert.ok(result.includes("\\)"), "Parenthèse fermante doit être backslashée");
    assert.ok(result.includes("\\."), "Point doit être backslashé");
  });
});

describe("fmtSaleAlert", () => {
  const fakeSale = {
    saleId: "sale_abc123",
    accountId: "lbc_compte_a",
    salePriceEur: 65.99,
    supplierUrl: "https://www.temu.com/perceuse-test.html",
    buyerName: "Jean D.",
    deliveryAddress: "Paris 75001",
    status: "confirmed",
  };

  test("contains account ID", () => {
    const msg = fmtSaleAlert(fakeSale, "Perceuse sans fil 18V", "Pack avec batterie");
    assert.ok(msg.includes("lbc_compte_a"));
  });

  test("contains supplier URL", () => {
    const msg = fmtSaleAlert(fakeSale, "Perceuse", "Pack");
    assert.ok(msg.includes("temu.com"));
  });

  test("contains /commande instruction", () => {
    const msg = fmtSaleAlert(fakeSale, "Perceuse", "Pack");
    assert.ok(msg.includes("/commande"));
  });
});

describe("fmtTrackingAdded", () => {
  test("shows delivery confirmed", () => {
    const sale = {
      orderRef: "ORD-001",
      trackingNumber: "CP123FR",
      trackingCarrier: "Colis Privé",
      leboncoinDeliveryConfirmed: true,
      manualActionRequired: false,
    };
    const msg = fmtTrackingAdded(sale);
    assert.ok(msg.includes("confirmée"));
  });

  test("shows manual action when needed", () => {
    const sale = {
      orderRef: "ORD-002",
      trackingNumber: "CP456FR",
      trackingCarrier: "La Poste",
      leboncoinDeliveryConfirmed: false,
      manualActionRequired: true,
      manualActionNote: "Vérifier sur LBC",
    };
    const msg = fmtTrackingAdded(sale);
    assert.ok(msg.includes("manuelle"));
  });
});
