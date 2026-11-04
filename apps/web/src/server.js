require("dotenv").config();
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.WEB_PORT ?? 3000;
const API_BASE = process.env.API_BASE_URL ?? "http://localhost:3001";
const SECRET_TOKEN = process.env.WEB_SECRET_TOKEN ?? "";
const BACKEND_TOKEN = process.env.API_SECRET_TOKEN ?? "";

app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// three.js servi en local (vue 3D du dashboard), sinon la page bascule sur le CDN
try {
  app.use("/vendor/three", express.static(path.dirname(require.resolve("three/build/three.min.js"))));
} catch {
  console.warn("[web] three non installé — la vue 3D utilisera le CDN");
}

// ─── Simple token auth middleware ─────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!SECRET_TOKEN) return next(); // dev: no auth
  const token = req.headers["x-hermes-token"] ?? req.query.token;
  if (token !== SECRET_TOKEN) return res.status(401).json({ ok: false, error: "Unauthorized" });
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

app.patch("/api/accounts/:id/niche", requireAuth, (req, res) =>
  proxyApi(req, res, `/api/accounts/${encodeURIComponent(req.params.id)}/niche`, "PATCH", req.body)
);

// ─── SPA fallback ────────────────────────────────────────────────────────────
app.get("*", (req, res) =>
  res.sendFile(path.join(__dirname, "../public/index.html"))
);

app.listen(PORT, () =>
  console.log(`[web] Hermès site running on http://localhost:${PORT}`)
);

module.exports = app;
