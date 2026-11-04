/**
 * Niche des comptes : enregistrement, effacement, présence dans /accounts/stats.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "http";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
process.env.DB_PATH = ":memory:";
process.env.NODE_ENV = "test";
process.env.API_SECRET_TOKEN = "";
process.env.JOB_INTERVAL_MS = "999999";
const app = require("../index.js");

let server, base;
before(async () => { server = createServer(app); await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`; });
after(async () => { await new Promise((r) => server.close(r)); });
const req = async (method, path, body) => (await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).json();

test("définir puis effacer la niche d'un compte", async () => {
  const r = await req("PATCH", "/api/accounts/lbc_compte_a/niche", { niche: "  Bricolage  " });
  assert.equal(r.ok, true);
  assert.equal(r.data.niche, "Bricolage");
  let stats = await req("GET", "/api/accounts/stats");
  assert.equal(stats.data.find((a) => a.accountId === "lbc_compte_a").niche, "Bricolage");
  await req("PATCH", "/api/accounts/lbc_compte_a/niche", { niche: "" });
  stats = await req("GET", "/api/accounts/stats");
  assert.equal(stats.data.find((a) => a.accountId === "lbc_compte_a").niche, undefined);
});

test("compte inconnu → 404", async () => {
  const r = await req("PATCH", "/api/accounts/nope/niche", { niche: "Tech" });
  assert.equal(r.ok, false);
});

test("renommer un compte (nom vide refusé)", async () => {
  const r = await req("PATCH", "/api/accounts/lbc_compte_b/label", { label: "  Julie Martin  " });
  assert.equal(r.data.label, "Julie Martin");
  const stats = await req("GET", "/api/accounts/stats");
  assert.equal(stats.data.find((a) => a.accountId === "lbc_compte_b").label, "Julie Martin");
  assert.equal((await req("PATCH", "/api/accounts/lbc_compte_b/label", { label: " " })).ok, false);
  assert.equal((await req("PATCH", "/api/accounts/nope/label", { label: "X" })).ok, false);
});

test("niche d'un produit : enregistrée et renvoyée avec les annonces", async () => {
  const db = require("../db/db");
  db.pragma("foreign_keys = OFF");
  db.prepare("INSERT OR IGNORE INTO products (temu_item_id, temu_url, title, warehouse_status, raw_json, fetched_at) VALUES ('tmN', 'https://x', 'Lampe', 'local', '{}', datetime('now'))").run();
  db.prepare("INSERT OR IGNORE INTO listings (listing_id, channel, account_id, temu_item_id, variant_id, title, price_eur_cents, cost_eur_cents, status, created_at, updated_at) VALUES ('lN', 'leboncoin', 'lbc_compte_a', 'tmN', 'v', 'Lampe', 2000, 500, 'published', datetime('now'), datetime('now'))").run();
  const r = await req("PATCH", "/api/products/tmN/niche", { niche: "Jardin" });
  assert.equal(r.data.niche, "Jardin");
  const l = await req("GET", "/api/listings");
  assert.equal(l.data.find((x) => x.listing_id === "lN").product_niche, "Jardin");
  assert.equal((await req("PATCH", "/api/products/inconnu/niche", { niche: "X" })).ok, false);
});
