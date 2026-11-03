const router = require("express").Router();
const { fetchProduct } = require("../services/products");
const { createListing, getListing } = require("../services/listings");
const { confirmSale, getSale, getActiveSales, getSalesNeedingAction, addTracking } = require("../services/sales");
const db = require("../db/db");

// ─── Auth (internal — same VPS, or bearer token) ──────────────────────────────
const API_TOKEN = process.env.API_SECRET_TOKEN ?? "";

router.use((req, res, next) => {
  if (!API_TOKEN) return next(); // dev: no auth
  const bearer = req.headers.authorization?.replace("Bearer ", "") ?? req.headers["x-api-key"];
  if (bearer !== API_TOKEN) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
});

// ─── Health ───────────────────────────────────────────────────────────────────

router.get("/health", (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// ─── Products ────────────────────────────────────────────────────────────────

router.post("/products/fetch", async (req, res) => {
  const { temuUrl } = req.body ?? {};
  if (!temuUrl) return res.status(400).json({ ok: false, error: "temuUrl requis" });
  try {
    const product = await fetchProduct(temuUrl);
    res.json({ ok: true, data: product });
  } catch (e) {
    res.status(422).json({ ok: false, error: e.message ?? String(e) });
  }
});

// ─── Accounts ────────────────────────────────────────────────────────────────

router.get("/accounts/leboncoin", (req, res) => {
  const accounts = db.prepare(
    "SELECT account_id, label FROM seller_accounts WHERE channel = 'leboncoin' AND active = 1"
  ).all();
  res.json({ ok: true, data: accounts.map(a => ({ accountId: a.account_id, label: a.label })) });
});

// ─── Listings ────────────────────────────────────────────────────────────────

router.post("/listings", (req, res) => {
  try {
    const listing = createListing(req.body);
    res.status(201).json({ ok: true, data: listing });
  } catch (e) {
    const status = e.code === "INELIGIBLE_WAREHOUSE" ? 422 : 400;
    res.status(status).json({ ok: false, error: e.message ?? String(e) });
  }
});

router.get("/listings/:id", (req, res) => {
  const l = getListing(req.params.id);
  if (!l) return res.status(404).json({ ok: false, error: "Listing introuvable" });
  res.json({ ok: true, data: l });
});

// ─── Sales ────────────────────────────────────────────────────────────────────

router.get("/sales", (req, res) => {
  const sales = getActiveSales();
  res.json({ ok: true, data: sales });
});

router.get("/sales/:id", (req, res) => {
  const s = getSale(req.params.id);
  if (!s) return res.status(404).json({ ok: false, error: "Vente introuvable" });
  res.json({ ok: true, data: s });
});

// Confirm sale (from Leboncoin webhook — Claude 3 calls this)
router.post("/sales/confirm", (req, res) => {
  try {
    const result = confirmSale(req.body);
    const status = result.duplicate ? 200 : 201;
    res.status(status).json({ ok: true, data: result.sale, duplicate: result.duplicate });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message ?? String(e) });
  }
});

// Add tracking (user sends order ref + carrier tracking)
router.patch("/sales/:id/tracking", (req, res) => {
  try {
    const sale = addTracking(req.params.id, req.body);
    res.json({ ok: true, data: sale });
  } catch (e) {
    res.status(e.code === "NOT_FOUND" ? 404 : 400).json({ ok: false, error: e.message ?? String(e) });
  }
});

// ─── Dashboard ────────────────────────────────────────────────────────────────

router.get("/dashboard", (req, res) => {
  const pendingListings = db.prepare(
    "SELECT * FROM listings WHERE status IN ('draft','scheduled') ORDER BY created_at DESC LIMIT 20"
  ).all();

  const activeSales = getActiveSales();
  const salesNeedingAction = getSalesNeedingAction();

  const recentActivity = db.prepare(`
    SELECT 'sale_confirmed' as type, confirmed_at as timestamp,
           'Vente confirmée — ' || sale_id as description, sale_id, NULL as listing_id
    FROM sales
    UNION ALL
    SELECT 'listing_published', published_at, 'Annonce publiée — ' || listing_id, NULL, listing_id
    FROM listings WHERE status = 'published' AND published_at IS NOT NULL
    ORDER BY timestamp DESC LIMIT 10
  `).all();

  const { rowToListing } = require("../services/listings");

  res.json({
    ok: true,
    data: {
      pendingListings: pendingListings.map(r => ({
        listingId: r.listing_id,
        title: r.title,
        status: r.status,
        priceEur: r.price_eur_cents / 100,
        costEur: r.cost_eur_cents / 100,
        scheduledAt: r.scheduled_at,
        createdAt: r.created_at,
      })),
      activeSales,
      salesNeedingAction,
      recentActivity: recentActivity.map(r => ({
        timestamp: r.timestamp,
        type: r.type,
        description: r.description,
        saleId: r.sale_id ?? undefined,
        listingId: r.listing_id ?? undefined,
      })),
    },
  });
});

// ─── Hermès webhook (events from Hermès task runner) ─────────────────────────

router.post("/hermes/event", (req, res) => {
  const { eventId, source, type, payload } = req.body ?? {};
  if (!eventId || !type) return res.status(400).json({ ok: false, error: "eventId and type required" });

  // Dedup
  const existing = db.prepare("SELECT 1 FROM events WHERE event_id = ?").get(eventId);
  if (existing) return res.json({ ok: true, duplicate: true });

  // Sanitise — never log buyer personal data
  const safePayload = { ...payload };
  delete safePayload.buyerEmail;
  delete safePayload.buyerPhone;
  delete safePayload.deliveryAddress;

  db.prepare(
    "INSERT INTO events (event_id, source, type, payload, received_at) VALUES (?,?,?,?,datetime('now'))"
  ).run(eventId, source ?? "unknown", type, JSON.stringify(safePayload));

  // Dispatch
  if (type === "sale_confirmed") {
    try {
      confirmSale({
        listingId: payload.listingId,
        externalEventId: eventId,
        salePriceEur: payload.salePriceEur,
        buyerName: payload.buyerName,
        deliveryCity: payload.deliveryCity,
      });
    } catch (e) {
      console.error("[hermes] confirmSale:", e.message);
    }
  }

  db.prepare("UPDATE events SET processed = 1, processed_at = datetime('now') WHERE event_id = ?").run(eventId);
  res.json({ ok: true });
});

module.exports = router;
