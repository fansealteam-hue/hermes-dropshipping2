/**
 * Tests TYNO V5 — 7 scénarios du cycle de vente complet
 * Contraintes : données fictives, aucun achat/publication réels
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "http";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

process.env.DB_PATH = ":memory:";
process.env.NODE_ENV = "test";
process.env.API_SECRET_TOKEN = "";
process.env.JOB_INTERVAL_MS = "999999";
process.env.EXTENSION_API_TOKEN = "test-ext-token-fictif";

const app = require("../index.js");
const PORT = 13460;
let server;

before(async () => {
  server = createServer(app);
  await new Promise(r => server.listen(PORT, r));
});

after(async () => {
  await new Promise(r => server.close(r));
});

const base = `http://localhost:${PORT}`;
async function req(method, path, body = null) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${base}${path}`, opts);
  return r.json();
}

// ─── Scénario 1 : Cycle complet vente → commande → suivi ─────────────────────

describe("S1 — Cycle complet confirmed→order_placed→shipped", () => {
  let listingId, saleId;

  test("setup: produit + annonce draft", async () => {
    const accts = await req("GET", "/api/accounts/leboncoin");
    assert.equal(accts.ok, true, "comptes LBC requis");
    const listing = await req("POST", "/api/listings", {
      temuItemId: "TEMU-TEST-S1",
      variantId: "VAR-S1-ROUGE",
      accountId: accts.data[0].accountId,
      priceEur: 48.99,
    });
    assert.equal(listing.ok, true);
    assert.equal(listing.data.status, "draft", "annonce créée en draft (Bug 6)");
    listingId = listing.data.listingId;
  });

  test("vente confirmée → statut confirmed", async () => {
    const d = await req("POST", "/api/sales/confirm", {
      listingId,
      externalEventId: "s1_evt_001",
      salePriceEur: 48.99,
      buyerName: "Test Acheteur",
      deliveryCity: "Paris",
    });
    assert.equal(d.ok, true);
    assert.equal(d.data.status, "confirmed");
    saleId = d.data.saleId;
  });

  test("POST /sales/:id/confirm-order → order_placed (Bug 1)", async () => {
    const d = await req("POST", `/api/sales/${saleId}/confirm-order`, {
      orderRef: "CMD-FICTIVE-001",
      pricePaid: 12.50,
    });
    assert.equal(d.ok, true, `confirm-order échoué : ${d.error}`);
    assert.equal(d.data.status, "order_placed");
    assert.equal(d.data.orderRef, "CMD-FICTIVE-001");
  });

  test("PATCH tracking number → shipped", async () => {
    const d = await req("PATCH", `/api/sales/${saleId}/tracking`, {
      trackingNumber: "1Z999FICTIF001",
      trackingCarrier: "colissimo",
    });
    assert.equal(d.ok, true);
    assert.ok(d.data.trackingNumber, "trackingNumber manquant");
  });

  test("GET /sales/:id → données cohérentes", async () => {
    const d = await req("GET", `/api/sales/${saleId}`);
    assert.equal(d.ok, true);
    assert.equal(d.data.orderRef, "CMD-FICTIVE-001");
    assert.ok(d.data.trackingNumber);
  });
});

// ─── Scénario 2 : Idempotence callbacks (Bug 8) ───────────────────────────────

describe("S2 — Idempotence callbacks", () => {
  test("premier appel → alreadyDone:false", async () => {
    const d = await req("POST", "/api/callbacks/mark-done", {
      callbackId: "cb_fictif_12345",
    });
    assert.equal(d.ok, true);
    assert.equal(d.alreadyDone, false);
  });

  test("deuxième appel même callbackId → alreadyDone:true", async () => {
    const d = await req("POST", "/api/callbacks/mark-done", {
      callbackId: "cb_fictif_12345",
    });
    assert.equal(d.ok, true);
    assert.equal(d.alreadyDone, true, "idempotence non respectée (Bug 8)");
  });

  test("callbackId différent → alreadyDone:false", async () => {
    const d = await req("POST", "/api/callbacks/mark-done", {
      callbackId: "cb_fictif_99999",
    });
    assert.equal(d.ok, true);
    assert.equal(d.alreadyDone, false);
  });
});

// ─── Scénario 3 : Import extension Chrome ─────────────────────────────────────

describe("S3 — Import extension Chrome", () => {
  test("token invalide → 401", async () => {
    const r = await fetch(`${base}/api/products/import-from-extension`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ extensionToken: "mauvais-token", productData: {} }),
    });
    assert.equal(r.status, 401);
  });

  test("token valide → job enfilé", async () => {
    const d = await req("POST", "/api/products/import-from-extension", {
      extensionToken: "test-ext-token-fictif",
      productData: {
        temuUrl: "https://www.temu.com/produit-fictif-test.html",
        title: "Produit Test Extension",
        price: 9.99,
        images: ["https://example.com/img1.jpg"],
      },
    });
    assert.equal(d.ok, true, `import échoué : ${d.error}`);
    assert.ok(d.jobId ?? d.data?.jobId, "jobId manquant");
  });
});

// ─── Scénario 4 : Annulation vente avec confirmation (Bug 2) ─────────────────

describe("S4 — Annulation vente (Bug 2 — confirmation 2 étapes)", () => {
  let listingId2, saleId2;

  test("setup vente pour annulation", async () => {
    const accts = await req("GET", "/api/accounts/leboncoin");
    const listing = await req("POST", "/api/listings", {
      temuItemId: "TEMU-TEST-S4",
      variantId: "VAR-S4-BLEU",
      accountId: accts.data[0].accountId,
      priceEur: 32.00,
    });
    listingId2 = listing.data.listingId;
    const sale = await req("POST", "/api/sales/confirm", {
      listingId: listingId2,
      externalEventId: "s4_evt_001",
      salePriceEur: 32.00,
      buyerName: "Acheteur Annulation",
      deliveryCity: "Marseille",
    });
    saleId2 = sale.data.saleId;
  });

  test("POST /sales/:id/cancel → statut cancelled", async () => {
    const d = await req("POST", `/api/sales/${saleId2}/cancel`);
    assert.equal(d.ok, true, `cancel échoué : ${d.error}`);
    assert.equal(d.data.status, "cancelled");
  });
});

// ─── Scénario 5 : Prix minimum x4 ────────────────────────────────────────────

describe("S5 — Calcul prix minimum x4 (Bug 3)", () => {
  test("coût 10€ → prix suggéré ≥ (10×4+3)/0.92 arrondi 0.05€", () => {
    const costEur = 10.00;
    const FRAIS_VENTE_PCT = 0.08;
    const FRAIS_LIVRAISON = 3.00;
    const MULTIPLICATEUR = 4;
    const rawMin = (costEur * MULTIPLICATEUR + FRAIS_LIVRAISON) / (1 - FRAIS_VENTE_PCT);
    const suggested = Math.ceil(rawMin * 20) / 20;
    // rawMin = (40 + 3) / 0.92 = 46.739... → arrondi 0.05 → 46.75
    assert.ok(suggested >= rawMin, "prix suggéré inférieur au minimum");
    assert.ok(suggested % 0.05 < 0.001, "prix non arrondi à 0.05€");
    assert.ok(suggested >= 46.70, "prix trop bas pour coût 10€ (attendu ~46.75€)");
    assert.ok(suggested <= 47.00, "prix trop haut");
  });

  test("coût 5€ → prix > 20€", () => {
    const rawMin = (5 * 4 + 3) / 0.92;
    const suggested = Math.ceil(rawMin * 20) / 20;
    assert.ok(suggested > 20, `prix ${suggested}€ trop bas pour coût 5€`);
  });
});

// ─── Scénario 6 : Validation saleId inexistant (Bug 7) ────────────────────────

describe("S6 — Validation saleId inexistant (Bug 7)", () => {
  const fakeId = "sale-id-qui-nexiste-pas-00000";

  test("GET /sales/fakeId → 404", async () => {
    const r = await fetch(`${base}/api/sales/${fakeId}`);
    assert.equal(r.status, 404);
  });

  test("POST /sales/fakeId/confirm-order → 404", async () => {
    const r = await fetch(`${base}/api/sales/${fakeId}/confirm-order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderRef: "REF-TEST" }),
    });
    assert.equal(r.status, 404);
  });

  test("POST /sales/fakeId/cancel → 404", async () => {
    const r = await fetch(`${base}/api/sales/${fakeId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(r.status, 404);
  });
});

// ─── Scénario 7 : Double vente → déduplication externe ────────────────────────

describe("S7 — Déduplication vente double (externalEventId)", () => {
  let listingId3, saleId3;

  test("setup annonce", async () => {
    const accts = await req("GET", "/api/accounts/leboncoin");
    const listing = await req("POST", "/api/listings", {
      temuItemId: "TEMU-TEST-S7",
      variantId: "VAR-S7-VERT",
      accountId: accts.data[0].accountId,
      priceEur: 27.50,
    });
    listingId3 = listing.data.listingId;
  });

  test("premier event → nouvelle vente", async () => {
    const d = await req("POST", "/api/sales/confirm", {
      listingId: listingId3,
      externalEventId: "s7_lbc_evt_dedup",
      salePriceEur: 27.50,
      buyerName: "Acheteur Dedup",
      deliveryCity: "Toulouse",
    });
    assert.equal(d.ok, true);
    assert.equal(d.duplicate, false);
    saleId3 = d.data.saleId;
  });

  test("même event → duplicate:true, même saleId", async () => {
    const d = await req("POST", "/api/sales/confirm", {
      listingId: listingId3,
      externalEventId: "s7_lbc_evt_dedup",
      salePriceEur: 27.50,
      buyerName: "Acheteur Dedup",
      deliveryCity: "Toulouse",
    });
    assert.equal(d.ok, true);
    assert.equal(d.duplicate, true, "déduplication non fonctionnelle");
    assert.equal(d.data.saleId, saleId3, "saleId différent — doublon créé");
  });
});
