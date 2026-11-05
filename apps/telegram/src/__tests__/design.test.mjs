/** Messages du bot au design Tyno : frise des étapes et dates en mots. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
process.env.NODE_ENV = "test";
const { stepsLine, relDay } = require("../bot.js");

test("frise Payé → Commandé → Expédié → Reçu", () => {
  assert.equal(stepsLine({ status: "confirmed" }), "✅ Payé ─ 🟠 Commandé ─ ⚪ Expédié ─ ⚪ Reçu");
  assert.equal(stepsLine({ status: "tracking_added" }), "✅ Payé ─ ✅ Commandé ─ ✅ Expédié ─ 🟠 Reçu");
  assert.equal(stepsLine({ status: "delivered" }), "✅ Payé ─ ✅ Commandé ─ ✅ Expédié ─ ✅ Reçu");
  assert.equal(stepsLine({ status: "cancelled" }), "✅ Payé ─ ❌ Annulée");
});

test("dates en mots", () => {
  assert.match(relDay(new Date().toISOString()), /^aujourd'hui \d\d:\d\d$/);
  assert.equal(relDay(new Date(Date.now() - 864e5).toISOString()), "hier");
  assert.equal(relDay(new Date(Date.now() - 2 * 864e5).toISOString()), "avant-hier");
});
