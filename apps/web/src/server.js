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

// ─── SPA fallback ────────────────────────────────────────────────────────────
app.get("*", (req, res) =>
  res.sendFile(path.join(__dirname, "../public/index.html"))
);

app.listen(PORT, () =>
  console.log(`[web] Hermès site running on http://localhost:${PORT}`)
);

module.exports = app;
