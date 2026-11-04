/**
 * Historique des conversations : enregistrement, regroupement, "à toi de répondre".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
process.env.DB_PATH = ":memory:";
process.env.NODE_ENV = "test";

require("../db/db");
require("../db/migrate");
const conv = require("../services/conversations");

test("un échange auto-répondu crée un fil avec 2 messages", () => {
  const id = conv.logExchange({ listingId: "lst_1", buyerName: "Julie M.", accountId: "lbc_compte_a",
    buyerMessage: "Toujours dispo ?", result: { reply: "Oui, toujours disponible !", action: "send" } });
  const list = conv.listConversations();
  assert.equal(list.length, 1);
  assert.equal(list[0].conversationId, id);
  assert.equal(list[0].messageCount, 2);
  assert.equal(list[0].autoReplies, 1);
  assert.equal(list[0].needsYou, false);
  const full = conv.getConversation(id);
  assert.deepEqual(full.messages.map((m) => m.direction), ["in", "out"]);
});

test("même acheteur + même annonce → même fil ; litige escaladé → à toi de répondre", () => {
  conv.logExchange({ listingId: "lst_1", buyerName: "Julie M.", buyerMessage: "C'est une arnaque ?", result: { reply: "", action: "escalate" } });
  const c = conv.listConversations()[0];
  assert.equal(c.messageCount, 3);
  assert.equal(c.needsYou, true);
});

test("une offre est comptée et stocke le montant", () => {
  const id = conv.logExchange({ conversationId: "lbc-123", listingId: "lst_2", buyerName: "Karim",
    buyerMessage: "je propose 20€", result: { reply: "Je peux faire 24 €", action: "send", offerEur: 20, decision: "counter" } });
  const c = conv.listConversations().find((x) => x.conversationId === id);
  assert.equal(c.offers, 1);
  const m = conv.getConversation(id).messages;
  assert.equal(m[0].offerEur, 20);
  assert.equal(m[1].decision, "counter");
  assert.equal(conv.getConversation("nope"), null);
});
