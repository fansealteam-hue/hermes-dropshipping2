require("dotenv").config();
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.WEB_PORT ?? 3000;
const API_BASE = process.env.API_BASE_URL ?? "http://localhost:3001";
const SECRET_TOKEN = process.env.WEB_SECRET_TOKEN ?? "";
const BACKEND_TOKEN = process.env.API_SECRET_TOKEN ?? "";

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ─── Site privé : mot de passe obligatoire (WEB_SECRET_TOKEN) ────────────────
const crypto = require("crypto");
const SESSION_DAYS = 30;
const PUBLIC_PATHS = new Set(["/login", "/logout", "/logo.svg", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/robots.txt"]);
const IS_PROD = process.env.NODE_ENV === "production";
if (!SECRET_TOKEN) console.warn(`[web] ⚠️  WEB_SECRET_TOKEN vide : ${IS_PROD ? "site bloqué tant qu'il n'est pas défini" : "site ouvert (développement)"}`);
else if (SECRET_TOKEN.length < 12 || /changeme/i.test(SECRET_TOKEN)) console.warn("[web] ⚠️  WEB_SECRET_TOKEN trop faible : choisis un mot de passe long et unique");

const sha = (v) => crypto.createHash("sha256").update(String(v)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const sign = (v) => crypto.createHmac("sha256", SECRET_TOKEN).update(v).digest("base64url");
function makeSession() {
  const v = `v1.${Date.now() + SESSION_DAYS * 86_400_000}`;
  return `${v}.${sign(v)}`;
}
function validSession(c) {
  const p = String(c ?? "").split(".");
  if (p.length !== 3 || !(Number(p[1]) > Date.now())) return false;
  const a = Buffer.from(sign(`${p[0]}.${p[1]}`)), b = Buffer.from(p[2]);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie ?? "").split(";").map((x) => x.trim().split("=")).filter((x) => x[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]));
}
function setSession(req, res) {
  const secure = req.secure ? "; Secure" : "";
  res.setHeader("Set-Cookie", `tyno_session=${makeSession()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}
function isAuthed(req) {
  if (!SECRET_TOKEN) return !IS_PROD;
  if (validSession(cookies(req).tyno_session)) return true;
  const t = req.headers["x-hermes-token"];
  return !!t && safeEq(t, SECRET_TOKEN);
}
const safeNext = (n) => (typeof n === "string" && n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/login") ? n : "/");

// En-têtes de sécurité + pas d'indexation
app.use((req, res, next) => {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  next();
});
app.get("/robots.txt", (req, res) => res.type("text/plain").send("User-agent: *\nDisallow: /\n"));

// Anti-force brute : 8 essais par 15 min et par adresse IP
const attempts = new Map();
function tooMany(ip) {
  const now = Date.now(), a = (attempts.get(ip) ?? []).filter((t) => now - t < 15 * 60_000);
  attempts.set(ip, a);
  return a.length >= 8;
}
app.get("/login", (req, res) => {
  if (isAuthed(req) && SECRET_TOKEN) return res.redirect(safeNext(req.query.next));
  res.sendFile(path.join(__dirname, "../public/login.html"));
});
app.post("/login", (req, res) => {
  const next = safeNext(req.body?.next);
  if (!SECRET_TOKEN) return res.redirect(`/login?err=config`);
  if (tooMany(req.ip)) return res.redirect(`/login?err=wait&next=${encodeURIComponent(next)}`);
  if (!safeEq(req.body?.password ?? "", SECRET_TOKEN)) {
    attempts.get(req.ip).push(Date.now());
    return res.redirect(`/login?err=1&next=${encodeURIComponent(next)}`);
  }
  attempts.delete(req.ip);
  setSession(req, res);
  res.redirect(next);
});
app.get("/logout", (req, res) => {
  res.setHeader("Set-Cookie", "tyno_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  res.redirect("/login");
});
app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path)) return next();
  // ancien lien « ?token=… » : on ouvre une session puis on retire le mot de passe de l'URL
  if (SECRET_TOKEN && typeof req.query.token === "string" && safeEq(req.query.token, SECRET_TOKEN)) {
    setSession(req, res);
    const u = new URL(req.originalUrl, "http://x"); u.searchParams.delete("token");
    return res.redirect(u.pathname + u.search);
  }
  if (isAuthed(req)) return next();
  if (req.path.startsWith("/api/") || req.path.startsWith("/media/")) return res.status(401).json({ ok: false, error: "Connexion requise" });
  if (!SECRET_TOKEN && IS_PROD) return res.status(503).type("text/plain").send("Site verrouillé : définis WEB_SECRET_TOKEN (mot de passe du site) dans le fichier .env puis redémarre.");
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
});

app.use(express.static(path.join(__dirname, "../public"), { index: "index.html" }));

// three.js servi en local (vue 3D du dashboard), sinon la page bascule sur le CDN
try {
  app.use("/vendor/three", express.static(path.dirname(require.resolve("three/build/three.min.js"))));
} catch {
  console.warn("[web] three non installé — la vue 3D utilisera le CDN");
}

// ─── Simple token auth middleware ─────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!isAuthed(req)) return res.status(401).json({ ok: false, error: "Connexion requise" });
  next();
}

// ─── Proxy to backend API ────────────────────────────────────────────────────
async function proxyApi(req, res, backendPath, method = "GET", body = null) {
  try {
    const opts = {
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (BACKEND_TOKEN) opts.headers.Authorization = `Bearer ${BACKEND_TOKEN}`;
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(`${API_BASE}${backendPath}`, opts);
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e) });
  }
}

// ─── Photos produits (servies par le backend dans /media) ─────────────────────
app.get("/media/:file", async (req, res) => {
  if (!/^[\w.-]+$/.test(req.params.file)) return res.status(400).end();
  try {
    const r = await fetch(`${API_BASE}/media/${req.params.file}`);
    if (!r.ok) return res.status(r.status).end();
    res.set("Content-Type", r.headers.get("content-type") ?? "image/jpeg");
    res.set("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.status(502).end();
  }
});

// ─── API routes ───────────────────────────────────────────────────────────────

app.get("/api/dashboard", requireAuth, (req, res) =>
  proxyApi(req, res, "/api/dashboard")
);

app.post("/api/products/fetch", requireAuth, (req, res) =>
  proxyApi(req, res, "/api/products/fetch", "POST", req.body)
);

app.get("/api/listings", requireAuth, (req, res) =>
  proxyApi(req, res, `/api/listings?${new URLSearchParams(req.query).toString()}`)
);

app.get("/api/accounts/stats", requireAuth, (req, res) =>
  proxyApi(req, res, "/api/accounts/stats")
);

app.post("/api/listings", requireAuth, (req, res) =>
  proxyApi(req, res, "/api/listings", "POST", req.body)
);

app.get("/api/accounts/leboncoin", requireAuth, (req, res) =>
  proxyApi(req, res, "/api/accounts/leboncoin")
);

app.get("/api/sales", requireAuth, (req, res) =>
  proxyApi(req, res, `/api/sales?${new URLSearchParams(req.query).toString()}`)
);

app.get("/api/sales/:id", requireAuth, (req, res) =>
  proxyApi(req, res, `/api/sales/${req.params.id}`)
);

app.patch("/api/sales/:id/tracking", requireAuth, (req, res) =>
  proxyApi(req, res, `/api/sales/${req.params.id}/tracking`, "PATCH", req.body)
);

app.get("/api/finance", requireAuth, (req, res) =>
  proxyApi(req, res, `/api/finance?${new URLSearchParams(req.query).toString()}`)
);

app.post("/api/sales/:id/sync-tracking", requireAuth, (req, res) =>
  proxyApi(req, res, `/api/sales/${req.params.id}/sync-tracking`, "POST")
);

app.get("/api/withdrawals", requireAuth, (req, res) =>
  proxyApi(req, res, "/api/withdrawals")
);

app.patch("/api/accounts/:id/withdraw-settings", requireAuth, (req, res) =>
  proxyApi(req, res, `/api/accounts/${encodeURIComponent(req.params.id)}/withdraw-settings`, "PATCH", req.body)
);

app.post("/api/accounts/:id/withdraw", requireAuth, (req, res) =>
  proxyApi(req, res, `/api/accounts/${encodeURIComponent(req.params.id)}/withdraw`, "POST")
);

app.post("/api/withdrawals/:id/status", requireAuth, (req, res) =>
  proxyApi(req, res, `/api/withdrawals/${encodeURIComponent(req.params.id)}/status`, "POST", req.body)
);

app.get("/api/conversations", requireAuth, (req, res) =>
  proxyApi(req, res, `/api/conversations?${new URLSearchParams(req.query).toString()}`)
);

app.post("/api/conversations/:id/reply", requireAuth, (req, res) =>
  proxyApi(req, res, `/api/conversations/${encodeURIComponent(req.params.id)}/reply`, "POST", req.body)
);

app.get("/api/conversations/:id", requireAuth, (req, res) =>
  proxyApi(req, res, `/api/conversations/${encodeURIComponent(req.params.id)}`)
);

app.post("/api/messages/reply", requireAuth, (req, res) =>
  proxyApi(req, res, "/api/messages/reply", "POST", req.body)
);

app.get("/api/sales/:id/availability", requireAuth, (req, res) =>
  proxyApi(req, res, `/api/sales/${encodeURIComponent(req.params.id)}/availability?${new URLSearchParams(req.query).toString()}`)
);

app.post("/api/sales/:id/resend-alert", requireAuth, (req, res) =>
  proxyApi(req, res, `/api/sales/${encodeURIComponent(req.params.id)}/resend-alert`, "POST")
);

app.patch("/api/accounts/:id/label", requireAuth, (req, res) =>
  proxyApi(req, res, `/api/accounts/${encodeURIComponent(req.params.id)}/label`, "PATCH", req.body)
);

app.patch("/api/products/:id/niche", requireAuth, (req, res) =>
  proxyApi(req, res, `/api/products/${encodeURIComponent(req.params.id)}/niche`, "PATCH", req.body)
);

app.patch("/api/accounts/:id/niche", requireAuth, (req, res) =>
  proxyApi(req, res, `/api/accounts/${encodeURIComponent(req.params.id)}/niche`, "PATCH", req.body)
);

// Automatisations (facturation, déclaration, rappels)
app.get("/api/automation/settings", requireAuth, (req, res) => proxyApi(req, res, "/api/automation/settings"));
app.put("/api/automation/settings", requireAuth, (req, res) => proxyApi(req, res, "/api/automation/settings", "PUT", req.body));
app.post("/api/automation/run", requireAuth, (req, res) => proxyApi(req, res, "/api/automation/run", "POST"));
app.get("/api/invoices", requireAuth, (req, res) => proxyApi(req, res, "/api/invoices"));
app.post("/api/invoices/import", requireAuth, (req, res) => proxyApi(req, res, "/api/invoices/import", "POST", req.body));
app.post("/api/sales/:id/invoice", requireAuth, (req, res) => proxyApi(req, res, `/api/sales/${encodeURIComponent(req.params.id)}/invoice`, "POST"));
app.post("/api/sales/:id/credit-note", requireAuth, (req, res) => proxyApi(req, res, `/api/sales/${encodeURIComponent(req.params.id)}/credit-note`, "POST"));
app.get("/api/declarations", requireAuth, (req, res) => proxyApi(req, res, "/api/declarations"));
app.post("/api/declarations/:key", requireAuth, (req, res) => proxyApi(req, res, `/api/declarations/${encodeURIComponent(req.params.key)}`, "POST", req.body));

// ─── SPA fallback ────────────────────────────────────────────────────────────
app.get("*", (req, res) =>
  res.sendFile(path.join(__dirname, "../public/index.html"))
);

if (require.main === module) {
  app.listen(PORT, () => console.log(`[web] Tyno Entreprise : http://localhost:${PORT}${SECRET_TOKEN ? " (protégé par mot de passe)" : ""}`));
}

module.exports = app;
