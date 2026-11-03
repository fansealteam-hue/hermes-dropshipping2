/**
 * Tests Claude B: negotiation + auto-responder
 * Run: DB_PATH=:memory: NODE_ENV=test node --test apps/backend/src/__tests__/claude-b.test.mjs
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.DB_PATH = ":memory:";

const { evaluateOffer, buildReply, ACCEPT_THRESHOLD, COUNTER_THRESHOLD, REFUSE_THRESHOLD } = await import("../services/negotiation.js");
const { generateReply } = await import("../services/auto-responder.js");

// ─── Negotiation engine ───────────────────────────────────────────────────────

describe("Negotiation — evaluateOffer", () => {
  const price = 100;

  test("offer >= 95% → accept", () => {
    const r = evaluateOffer(price, 95);
    assert.equal(r.decision, "accept");
    assert.ok(r.ratio >= ACCEPT_THRESHOLD);
  });

  test("offer = 100% → accept", () => {
    const r = evaluateOffer(price, 100);
    assert.equal(r.decision, "accept");
  });

  test("offer = 90% → counter at 95€", () => {
    const r = evaluateOffer(price, 90);
    assert.equal(r.decision, "counter");
    assert.ok(r.counterPriceEur < price, "Counter doit être inférieur au prix");
    assert.ok(r.counterPriceEur >= 90, "Counter doit être >= offre");
  });

  test("offer = 75% → counter at listing price", () => {
    const r = evaluateOffer(price, 75);
    assert.equal(r.decision, "counter");
    assert.equal(r.counterPriceEur, price);
  });

  test("offer < 70% → refuse", () => {
    const r = evaluateOffer(price, 60);
    assert.equal(r.decision, "refuse");
  });

  test("offer = 0 → throw INVALID_OFFER", () => {
    assert.throws(() => evaluateOffer(price, 0), { code: "INVALID_OFFER" });
  });

  test("listing price = 0 → throw INVALID_PRICE", () => {
    assert.throws(() => evaluateOffer(0, 50), { code: "INVALID_PRICE" });
  });

  test("thresholds: 85% is counter, 84% is counter at listing price", () => {
    const r85 = evaluateOffer(100, 85);
    assert.equal(r85.decision, "counter");
    const r84 = evaluateOffer(100, 84);
    assert.equal(r84.decision, "counter");
    assert.equal(r84.counterPriceEur, 100);
  });
});

describe("Negotiation — buildReply", () => {
  test("accept message contains confirmation", () => {
    const r = buildReply("accept", undefined, 100);
    assert.ok(r.length > 0);
    assert.ok(r.toLowerCase().includes("accept") || r.toLowerCase().includes("offre"));
  });

  test("counter message contains counter price", () => {
    const r = buildReply("counter", 95, 100);
    assert.ok(r.includes("95.00") || r.includes("95,00") || r.includes("95"));
  });

  test("refuse message contains listing price", () => {
    const r = buildReply("refuse", undefined, 100);
    assert.ok(r.includes("100"));
  });
});

// ─── Auto-responder ────────────────────────────────────────────────────────────

describe("Auto-responder — generateReply", () => {
  const base = {
    listingPriceEur: 65.99,
    productTitle: "Perceuse sans fil 18V",
    variantLabel: "Pack avec batterie",
  };

  test("litige keyword → escalate, no reply", async () => {
    const r = await generateReply({ ...base, buyerMessage: "C'est une arnaque !" });
    assert.equal(r.action, "escalate");
    assert.equal(r.reply, "");
    assert.equal(r.reason, "litige_detected");
  });

  test("price offer extracted and evaluated (accept 95%+)", async () => {
    const r = await generateReply({ ...base, buyerMessage: "Je propose 63€", listingPriceEur: 65 });
    assert.ok(r.offerEur > 0, "Offre doit être extraite");
    assert.equal(r.decision, "accept");
  });

  test("price offer below 70% → refuse", async () => {
    const r = await generateReply({ ...base, buyerMessage: "40€ ça te va ?", listingPriceEur: 65.99 });
    assert.equal(r.decision, "refuse");
    assert.equal(r.action, "send");
  });

  test("price offer 85-95% → counter", async () => {
    const r = await generateReply({ ...base, buyerMessage: "je propose 58 euros", listingPriceEur: 65.99 });
    assert.equal(r.decision, "counter");
    assert.ok(r.reply.length > 0);
  });

  test("non-offer question → fallback reply in test mode", async () => {
    const r = await generateReply({ ...base, buyerMessage: "L'article est encore disponible ?" });
    assert.equal(r.action, "send");
    assert.ok(r.reply.length > 0);
    assert.ok(r.reply.toLowerCase().includes("disponible") || r.reply.toLowerCase().includes("vendeur"));
  });

  test("livraison question → fallback reply", async () => {
    const r = await generateReply({ ...base, buyerMessage: "C'est combien pour la livraison ?" });
    assert.equal(r.action, "send");
    assert.ok(r.reply.toLowerCase().includes("livraison") || r.reply.toLowerCase().includes("vendeur"));
  });
});
