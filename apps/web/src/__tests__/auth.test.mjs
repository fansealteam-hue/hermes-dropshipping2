/**
 * Site privé : tout est fermé sans mot de passe, la session ouvre l'accès.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "http";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
process.env.WEB_SECRET_TOKEN = "mot-de-passe-tres-long-42";
process.env.API_BASE_URL = "http://127.0.0.1:1";
const app = require("../server.js");

let server, base;
before(async () => { server = createServer(app); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
after(async () => { await new Promise((r) => server.close(r)); });
const get = (path, headers = {}) => fetch(base + path, { redirect: "manual", headers });

test("sans connexion : page → /login, API et photos → 401, fichiers bloqués", async () => {
  const r = await get("/");
  assert.equal(r.status, 302);
  assert.match(r.headers.get("location"), /^\/login\?next=/);
  assert.equal((await get("/api/dashboard")).status, 401);
  assert.equal((await get("/media/x.jpg")).status, 401);
  assert.equal((await get("/index.html")).status, 302);
  assert.equal((await get("/login.html")).status, 302);
});

test("pages publiques : login, logo, robots (noindex)", async () => {
  assert.equal((await get("/login")).status, 200);
  assert.equal((await get("/logo.svg")).status, 200);
  const r = await get("/robots.txt");
  assert.match(await r.text(), /Disallow: \//);
  assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(r.headers.get("x-frame-options"), "DENY");
});

test("mauvais mot de passe refusé, bon mot de passe = session", async () => {
  const bad = await fetch(base + "/login", { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "password=faux&next=/" });
  assert.match(bad.headers.get("location"), /err=1/);
  assert.equal(bad.headers.get("set-cookie"), null);
  const ok = await fetch(base + "/login", { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "password=mot-de-passe-tres-long-42&next=%2F%23compta" });
  assert.equal(ok.headers.get("location"), "/#compta");
  const cookie = ok.headers.get("set-cookie");
  assert.match(cookie, /tyno_session=.+; HttpOnly; SameSite=Strict/);
  const page = await get("/", { cookie: cookie.split(";")[0] });
  assert.equal(page.status, 200);
  assert.equal((await get("/api/dashboard", { cookie: cookie.split(";")[0] })).status, 502, "accès API autorisé (backend absent dans le test)");
  assert.equal((await get("/", { cookie: "tyno_session=v1.9999999999999.faux" })).status, 302, "cookie falsifié refusé");
});

test("redirection après connexion : pas de site externe", async () => {
  const r = await fetch(base + "/login", { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "password=mot-de-passe-tres-long-42&next=//evil.com" });
  assert.equal(r.headers.get("location"), "/");
});

test("anti force brute : bloqué après 8 essais", async () => {
  let last;
  for (let i = 0; i < 9; i++) last = await fetch(base + "/login", { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "password=nope" });
  assert.match(last.headers.get("location"), /err=wait/);
});
