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

test("numéro de suivi : transporteur reconnu tout seul", () => {
  const { parseTracking } = require("../bot.js");
  assert.deepEqual(parseTracking("LX123456789FR"), { carrier: "Colissimo", number: "LX123456789FR" });
  assert.equal(parseTracking("1Z999AA10123456784").carrier, "UPS");
  assert.deepEqual(parseTracking("Mondial Relay 12345678"), { carrier: "Mondial Relay", number: "12345678" });
});

test("boutons en bas, pas de commandes", () => {
  const { mainKeyboard, BTN } = require("../bot.js");
  const kb = mainKeyboard();
  const labels = kb.keyboard.flat().map(b => (typeof b === "string" ? b : b.text));
  for (const l of [BTN.dash, BTN.sales, BTN.order, BTN.track, BTN.product]) assert.ok(labels.includes(l));
  assert.ok(labels.every(l => !l.startsWith("/")));
});

test("fiche de vente : le statut est remplacé, le gras au-dessus est gardé", () => {
  const { cardText, SEP } = require("../bot.js");
  const body = `🔔 NOUVELLE VENTE\n${SEP}\n📦 Perceuse\n${SEP}\nancien statut`;
  const card = { photo: true, body, entities: [{ type: "bold", offset: 3, length: 14 }, { type: "bold", offset: body.length - 6, length: 6 }] };
  const { text, entities } = cardText(card, "✅ Commandé");
  assert.ok(text.endsWith(`${SEP}\n✅ Commandé`));
  assert.ok(!text.includes("ancien statut"));
  assert.equal(entities.length, 1);
});
