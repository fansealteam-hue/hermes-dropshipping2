const router = require("express").Router();
const { fetchProduct } = require("../services/products");
const { createListing, getListing } = require("../services/listings");
const { confirmSale, getSale, getActiveSales, getSalesNeedingAction, addTracking } = require("../services/sales");
const { generateReply } = require("../services/auto-responder");
const { evaluateOffer } = require("../services/negotiation");
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

// ─── Dashboard financier (Claude B) ──────────────────────────────────────────

router.get("/finance", (req, res) => {
  const period = req.query.period ?? "30d";
  const days = period === "7d" ? 7 : period === "90d" ? 90 : 30;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  // Revenus et coûts
  const totals = db.prepare(`
    SELECT
      COUNT(*) as total_sales,
      SUM(sale_price_eur_cents) as revenue_cents,
      SUM(cost_eur_cents) as cost_cents,
      SUM(actual_cost_eur_cents) as actual_cost_cents,
      SUM(sale_price_eur_cents - cost_eur_cents) as gross_margin_cents
    FROM sales
    WHERE confirmed_at >= ? AND status != 'closed'
  `).get(since);

  // Par statut
  const byStatus = db.prepare(`
    SELECT status, COUNT(*) as count, SUM(sale_price_eur_cents) as revenue_cents
    FROM sales WHERE confirmed_at >= ?
    GROUP BY status
  `).all(since);

  // Évolution journalière (revenus)
  const daily = db.prepare(`
    SELECT
      date(confirmed_at) as day,
      COUNT(*) as sales,
      SUM(sale_price_eur_cents) as revenue_cents,
      SUM(sale_price_eur_cents - cost_eur_cents) as margin_cents
    FROM sales
    WHERE confirmed_at >= ? AND status != 'closed'
    GROUP BY date(confirmed_at)
    ORDER BY day ASC
  `).all(since);

  // Top produits
  const topProducts = db.prepare(`
    SELECT
      s.temu_item_id,
      p.title,
      COUNT(*) as sales_count,
      SUM(s.sale_price_eur_cents) as revenue_cents,
      SUM(s.sale_price_eur_cents - s.cost_eur_cents) as margin_cents
    FROM sales s
    LEFT JOIN products p ON p.temu_item_id = s.temu_item_id
    WHERE s.confirmed_at >= ? AND s.status != 'closed'
    GROUP BY s.temu_item_id
    ORDER BY revenue_cents DESC
    LIMIT 10
  `).all(since);

  // Jobs en erreur
  const failedJobs = db.prepare(
    "SELECT operation, COUNT(*) as count FROM jobs WHERE status IN ('failed','verify') GROUP BY operation"
  ).all();

  const r = totals ?? {};
  const revenueEur = (r.revenue_cents ?? 0) / 100;
  const costEur = (r.cost_cents ?? 0) / 100;
  const marginEur = (r.gross_margin_cents ?? 0) / 100;

  res.json({
    ok: true,
    data: {
      period,
      summary: {
        totalSales: r.total_sales ?? 0,
        revenueEur,
        costEur,
        marginEur,
        marginPct: revenueEur > 0 ? Math.round((marginEur / revenueEur) * 100) : 0,
      },
      byStatus: byStatus.map(s => ({ status: s.status, count: s.count, revenueEur: s.revenue_cents / 100 })),
      daily: daily.map(d => ({
        day: d.day,
        sales: d.sales,
        revenueEur: d.revenue_cents / 100,
        marginEur: d.margin_cents / 100,
      })),
      topProducts: topProducts.map(p => ({
        temuItemId: p.temu_item_id,
        title: p.title ?? p.temu_item_id,
        salesCount: p.sales_count,
        revenueEur: p.revenue_cents / 100,
        marginEur: p.margin_cents / 100,
      })),
      failedJobs,
    },
  });
});

// ─── Sync tracking to Leboncoin (Claude B) ────────────────────────────────────

router.post("/sales/:id/sync-tracking", (req, res) => {
  const sale = getSale(req.params.id);
  if (!sale) return res.status(404).json({ ok: false, error: "Vente introuvable" });
  if (!sale.trackingNumber) return res.status(422).json({ ok: false, error: "Numéro de suivi manquant" });

  // Enqueue sync_tracking job (processed by handleSyncTracking in handlers.js)
  const { randomUUID } = require("crypto");
  const jobId = `job_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const key = `tracking:${sale.saleId}:${sale.trackingNumber}`;
  db.prepare(`
    INSERT OR IGNORE INTO jobs (job_id, operation, payload, status, idempotency_key, run_at, created_at)
    VALUES (?, 'sync_tracking', ?, 'pending', ?, datetime('now'), datetime('now'))
  `).run(jobId, JSON.stringify({ saleId: sale.saleId, trackingNumber: sale.trackingNumber, trackingCarrier: sale.trackingCarrier }), key);

  res.json({ ok: true, data: { jobId, status: "enqueued" } });
});

// ─── Auto-responder (Claude B) ────────────────────────────────────────────────

router.post("/messages/reply", async (req, res) => {
  const { buyerMessage, listingId } = req.body ?? {};
  if (!buyerMessage || !listingId) {
    return res.status(400).json({ ok: false, error: "buyerMessage et listingId requis" });
  }
  const listing = db.prepare("SELECT * FROM listings WHERE listing_id = ?").get(listingId);
  if (!listing) return res.status(404).json({ ok: false, error: "Listing introuvable" });

  const variant = db.prepare("SELECT * FROM variants WHERE variant_id = ?").get(listing.variant_id);
  const product = db.prepare("SELECT * FROM products WHERE temu_item_id = ?").get(listing.temu_item_id);

  try {
    const result = await generateReply({
      buyerMessage,
      listingPriceEur: listing.price_eur_cents / 100,
      productTitle: product?.title ?? listing.temu_item_id,
      variantLabel: variant?.label ?? listing.variant_id,
      listingStatus: listing.status,
    });
    res.json({ ok: true, data: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Negotiation (Claude B) ───────────────────────────────────────────────────

router.post("/negotiate", (req, res) => {
  const { listingId, offerEur } = req.body ?? {};
  if (!listingId || !offerEur) {
    return res.status(400).json({ ok: false, error: "listingId et offerEur requis" });
  }
  const listing = db.prepare("SELECT * FROM listings WHERE listing_id = ?").get(listingId);
  if (!listing) return res.status(404).json({ ok: false, error: "Listing introuvable" });

  try {
    const result = evaluateOffer(listing.price_eur_cents / 100, parseFloat(offerEur));
    const { buildReply } = require("../services/negotiation");
    const reply = buildReply(result.decision, result.counterPriceEur, listing.price_eur_cents / 100);
    res.json({ ok: true, data: { ...result, reply } });
  } catch (e) {
    res.status(422).json({ ok: false, error: e.message });
  }
});

// ─── Annuler vente (NON bouton Telegram) ─────────────────────────────────────

router.post("/sales/:id/cancel", (req, res) => {
  const sale = getSale(req.params.id);
  if (!sale) return res.status(404).json({ ok: false, error: "Vente introuvable" });

  const { randomUUID } = require("crypto");
  // Marquer annulée en DB
  db.prepare("UPDATE sales SET status = 'cancelled', updated_at = datetime('now') WHERE sale_id = ?").run(sale.saleId);

  // Job pour envoyer message LBC à l'acheteur + annuler sur LBC
  const jobId = `job_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  db.prepare(`
    INSERT OR IGNORE INTO jobs (job_id, operation, payload, status, idempotency_key, run_at, created_at)
    VALUES (?, 'cancel_sale_lbc', ?, 'pending', ?, datetime('now'), datetime('now'))
  `).run(jobId, JSON.stringify({ saleId: sale.saleId, listingId: sale.listingId }), `cancel:${sale.saleId}`);

  res.json({ ok: true, data: { jobId, status: "enqueued" } });
});

// ─── Confirmer disponibilité (OUI bouton Telegram) ───────────────────────────

router.post("/sales/:id/confirm-available", (req, res) => {
  const sale = getSale(req.params.id);
  if (!sale) return res.status(404).json({ ok: false, error: "Vente introuvable" });
  // Déjà confirmed — rien à faire côté DB, juste ack
  res.json({ ok: true });
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
