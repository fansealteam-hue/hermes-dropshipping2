/**
 * Parcours complets au bouton, en simulant Telegram et le serveur :
 * nouveau produit (lien → variante → prix → compte → publication), prix libre,
 * « ✅ n commandé » qui se coche, ajout d'un suivi, annulation d'une saisie.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
process.env.NODE_ENV = "test";

const api = require("../api.js");
const { bot } = require("../bot.js");

bot.botInfo = { id: 1, is_bot: true, first_name: "Tyno", username: "tyno_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };
const out = [];
let msgId = 100;
bot.api.config.use(async (prev, method, payload) => {
  out.push({ method, payload });
  if (method === "sendMessage") return { ok: true, result: { message_id: ++msgId, chat: { id: 42 }, date: 0, text: payload.text } };
  return { ok: true, result: true };
});

// Faux serveur
const calls = [];
Object.assign(api, {
  fetchTemuProduct: async () => ({ ok: true, data: { temuItemId: "tm1", title: "Lampe LED <pliable>", warehouseStatus: "local",
    variants: [{ variantId: "v1", label: "Noir", costEur: 10, stock: 12, imageUrls: ["a", "b"] }, { variantId: "v2", label: "Blanc", costEur: 10, stock: 0, imageUrls: [] }] } }),
  getLeboncoinAccounts: async () => ({ ok: true, data: [{ accountId: "a1", label: "Maison #1", niche: "Maison" }] }),
  createListing: async (d) => { calls.push(["createListing", d]); return { ok: true, data: { listingId: "l1" } }; },
  markOrdered: async (id) => { calls.push(["markOrdered", id]); return { ok: true, data: {} }; },
  addTracking: async (id, b) => { calls.push(["addTracking", id, b]); return { ok: true, data: { saleId: id, trackingNumber: b.trackingNumber } }; },
  syncTracking: async () => ({ ok: true }),
  getActiveSales: async () => ({ ok: true, data: [] }),
});

let upd = 1;
const chat = { id: 42, type: "private", first_name: "Moi" };
const from = { id: 42, is_bot: false, first_name: "Moi" };
const text = (t) => bot.handleUpdate({ update_id: upd++, message: { message_id: ++msgId, date: 0, chat, from, text: t } });
const press = (data, message = { message_id: 7, date: 0, chat, text: "x" }) =>
  bot.handleUpdate({ update_id: upd++, callback_query: { id: String(upd), from, chat_instance: "c", data, message } });
const last = (m) => [...out].reverse().find((o) => o.method === m)?.payload;
const buttons = (p) => (p?.reply_markup?.inline_keyboard ?? []).flat();

test("nouveau produit, tout au bouton : lien → variante → prix → compte → publication", async () => {
  await text("🔗 Nouveau produit");
  assert.match(last("sendMessage").text, /Colle le lien du produit Temu/);
  assert.ok(buttons(last("sendMessage")).some((b) => b.callback_data === "flow:cancel"), "bouton Annuler");

  await text("https://www.temu.com/lampe-g-601.html");
  const v = last("editMessageText");
  assert.match(v.text, /Lampe LED &lt;pliable&gt;/, "titre échappé");
  assert.match(v.text, /éligible/);
  const vb = buttons(v).map((b) => b.callback_data);
  assert.ok(vb.includes("variant:v1") && !vb.includes("variant:v2"), "variante en rupture masquée");

  await press("variant:v1");
  const p = last("editMessageText");
  assert.match(p.text, /Choisis ton prix de vente/);
  const prices = buttons(p).filter((b) => b.callback_data?.startsWith("confirm_price:"));
  assert.equal(prices.length, 3);
  assert.ok(buttons(p).some((b) => b.callback_data === "edit_price"), "bouton Autre prix");

  await press(prices[1].callback_data);
  assert.ok(buttons(last("editMessageText")).some((b) => b.callback_data === "account:a1"));
  await press("account:a1");
  assert.match(last("editMessageText").text, /Quand publier/);
  await press("schedule:now");
  assert.match(last("editMessageText").text, /ANNONCE CRÉÉE/);
  const [, d] = calls.find((c) => c[0] === "createListing");
  assert.deepEqual([d.temuItemId, d.variantId, d.accountId, d.priceEur], ["tm1", "v1", "a1", 30.99]);
});

test("« ✏️ Autre prix » marche (il ne faisait rien avant)", async () => {
  await text("https://www.temu.com/lampe-g-601.html");
  await press("variant:v1");
  await press("edit_price");
  assert.match(last("sendMessage").text, /Écris ton prix/);
  await text("abc");
  assert.match(last("sendMessage").text, /Prix non compris/);
  await text("24,90 €");
  assert.ok(buttons(last("sendMessage")).some((b) => b.callback_data === "confirm_price:24.9"));
});

test("liste à commander : le bouton « ✅ 1 commandé » devient « ✔️ 1 fait »", async () => {
  const message = { message_id: 9, date: 0, chat, text: "liste", reply_markup: { inline_keyboard: [
    [{ text: "🛒 1 · Temu", url: "https://www.temu.com/x" }, { text: "✅ 1 commandé", callback_data: "order_one:s1" }],
    [{ text: "🛒 2 · Temu", url: "https://www.temu.com/y" }, { text: "✅ 2 commandé", callback_data: "order_one:s2" }],
    [{ text: "✅ Tout est commandé (2)", callback_data: "bulk_ordered" }]] } };
  await press("order_one:s1", message);
  assert.ok(calls.some((c) => c[0] === "markOrdered" && c[1] === "s1"));
  const kb = last("editMessageReplyMarkup").reply_markup.inline_keyboard.flat();
  assert.ok(kb.some((b) => b.text === "✔️ 1 fait" && b.callback_data === "noop"));
  assert.ok(kb.some((b) => b.callback_data === "order_one:s2"), "les autres restent");
});

test("suivi : on colle le numéro, transporteur reconnu, confirmation au design Tyno", async () => {
  await press("add_tracking:s9");
  assert.ok(buttons(last("sendMessage")).some((b) => b.callback_data === "flow:cancel"));
  await text("LX123456789FR");
  const add = calls.filter((c) => c[0] === "addTracking").at(-1);
  assert.equal(add[1], "s9");
  assert.equal(add[2].trackingCarrier, "Colissimo");
  const sent = last("sendMessage");
  assert.match(sent.text, /SUIVI AJOUTÉ/);
  assert.ok(buttons(sent).some((b) => b.url?.includes("17track")));
});

test("annuler une saisie : plus d'attente de lien", async () => {
  await text("🔗 Nouveau produit");
  await press("flow:cancel");
  await text("bonjour");
  assert.match(last("sendMessage").text, /Utilise les boutons/);
});
