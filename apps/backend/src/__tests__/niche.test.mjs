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
