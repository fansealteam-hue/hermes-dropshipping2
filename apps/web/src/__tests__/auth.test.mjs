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
process.env.TELEGRAM_BOT_TOKEN = "123:ABC";
process.env.TELEGRAM_ALLOWED_CHAT_IDS = "777";
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

import crypto from "crypto";
function initData(userId, ageSec = 0, token = "123:ABC") {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000) - ageSec), query_id: "q", user: JSON.stringify({ id: userId, first_name: "T" }) });
  const check = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  p.set("hash", crypto.createHmac("sha256", secret).update(check).digest("hex"));
  return p.toString();
}

test("mini-app Telegram : page publique, API ouverte seulement avec une signature valide du bon compte", async () => {
  assert.equal((await get("/tg")).status, 200);
  const ok = await get("/api/dashboard", { "x-tg-init-data": initData(777) });
  assert.equal(ok.status, 502, "accès autorisé (backend absent dans le test)");
  assert.match(ok.headers.get("set-cookie") ?? "", /tyno_session=/, "session ouverte pour les photos");
  assert.equal((await get("/api/dashboard", { "x-tg-init-data": initData(999) })).status, 401, "autre compte Telegram refusé");
  assert.equal((await get("/api/dashboard", { "x-tg-init-data": initData(777, 0, "999:FAUX") })).status, 401, "signature falsifiée refusée");
  assert.equal((await get("/api/dashboard", { "x-tg-init-data": initData(777, 90000) })).status, 401, "signature trop ancienne refusée");
});
