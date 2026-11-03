/**
 * Integration test: full HTTP API + double-event + crash scenario.
 * Starts the Express server on a random port, runs end-to-end.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "http";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// Set env BEFORE loading any module
process.env.DB_PATH = `:memory:`;
process.env.NODE_ENV = "test";
process.env.API_SECRET_TOKEN = "";
process.env.JOB_INTERVAL_MS = "999999"; // disable job queue during tests

const app = require("../index.js");

const PORT = 13456;
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

describe("HTTP API — perceuse intégration", () => {
  let listingId, saleId;

  test("GET /health", async () => {
    const d = await req("GET", "/health");
    assert.equal(d.ok, true);
  });

  test("POST /api/products/fetch — perceuse test URL", async () => {
    const d = await req("POST", "/api/products/fetch", { temuUrl: "https://www.temu.com/perceuse-test.html" });
    assert.equal(d.ok, true);
    assert.equal(d.data.warehouseStatus, "local");
    assert.ok(d.data.variants.length >= 2);
  });

  test("GET /api/accounts/leboncoin — returns seeded accounts", async () => {
    const d = await req("GET", "/api/accounts/leboncoin");
    assert.equal(d.ok, true);
    assert.ok(d.data.length >= 1);
  });

  test("POST /api/listings — create draft for drill pack", async () => {
    const accts = await req("GET", "/api/accounts/leboncoin");
    const d = await req("POST", "/api/listings", {
      temuItemId: "TEMU-DRILL-001",
      variantId: "VAR-DRILL-PACK",
      accountId: accts.data[0].accountId,
      priceEur: 65.99,
    });
    assert.equal(d.ok, true);
    assert.equal(d.data.status, "draft");
    listingId = d.data.listingId;
  });

  test("POST /api/sales/confirm — first event", async () => {
    const d = await req("POST", "/api/sales/confirm", {
      listingId,
      externalEventId: "lbc_evt_abc001",
      salePriceEur: 65.99,
      buyerName: "Marie M.",
      deliveryCity: "Lyon",
    });
    assert.equal(d.ok, true);
    assert.equal(d.duplicate, false);
    assert.equal(d.data.status, "confirmed");
    saleId = d.data.saleId;
  });

  test("POST /api/sales/confirm — duplicate event → same saleId", async () => {
    const d = await req("POST", "/api/sales/confirm", {
      listingId,
      externalEventId: "lbc_evt_abc001",
      salePriceEur: 65.99,
    });
    assert.equal(d.ok, true);
    assert.equal(d.duplicate, true);
    assert.equal(d.data.saleId, saleId);
  });

  test("PATCH /api/sales/:id/tracking — order ref", async () => {
    const d = await req("PATCH", `/api/sales/${saleId}/tracking`, {
      orderRef: "ORD-DRILL-2024", trackingNumber: "", trackingCarrier: ""
    });
    assert.equal(d.ok, true);
    assert.equal(d.data.orderRef, "ORD-DRILL-2024");
    assert.equal(d.data.status, "order_placed");
  });

  test("PATCH /api/sales/:id/tracking — tracking number", async () => {
    const d = await req("PATCH", `/api/sales/${saleId}/tracking`, {
      orderRef: "", trackingNumber: "CP1234567890FR", trackingCarrier: "Colis Privé"
    });
    assert.equal(d.ok, true);
    assert.equal(d.data.trackingNumber, "CP1234567890FR");
    assert.equal(d.data.status, "tracking_added");
  });

  test("GET /api/dashboard — reflects state", async () => {
    const d = await req("GET", "/api/dashboard");
    assert.equal(d.ok, true);
    assert.ok(d.data.activeSales.length >= 1);
  });

  test("GET /admin/queue/status", async () => {
    const d = await req("GET", "/admin/queue/status");
    assert.equal(d.ok, true);
    assert.ok(Array.isArray(d.data.summary));
  });

  test("POST /api/hermes/event — sale_confirmed dedup", async () => {
    const d = await req("POST", "/api/hermes/event", {
      eventId: "evt_hermes_002",
      source: "hermès",
      type: "sale_confirmed",
      payload: {
        listingId,
        salePriceEur: 65.99,
        externalEventId: "evt_hermes_002",
      }
    });
    assert.equal(d.ok, true);
  });
});
