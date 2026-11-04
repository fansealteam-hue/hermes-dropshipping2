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

// ─── Stats par compte (dashboard) ────────────────────────────────────────────

router.get("/accounts/stats", (req, res) => {
  const TEMU_SHIPPING_FEE_CENTS = Math.round(parseFloat(process.env.TEMU_SHIPPING_FEE ?? "2.99") * 100);

  const accounts = db.prepare("SELECT account_id, label, active FROM seller_accounts WHERE channel = 'leboncoin'").all();

  const salesByAccount = db.prepare(`
    SELECT
      account_id,
      COUNT(*) as total_sales,
      SUM(sale_price_eur_cents) as revenue_cents,
      SUM(cost_eur_cents) as cost_cents
    FROM sales
    WHERE status NOT IN ('cancelled', 'closed')
    GROUP BY account_id
  `).all();
  const salesMap = Object.fromEntries(salesByAccount.map(r => [r.account_id, r]));

  const listingsByAccount = db.prepare(`
    SELECT account_id,
      COUNT(*) FILTER (WHERE status = 'published') as active_count,
      COUNT(*) FILTER (WHERE status = 'archived') as archived_count
    FROM listings
    GROUP BY account_id
  `).all();
  const listingsMap = Object.fromEntries(listingsByAccount.map(r => [r.account_id, r]));

  const data = accounts.map(a => {
    const s = salesMap[a.account_id] ?? {};
    const l = listingsMap[a.account_id] ?? {};
    const revCents = s.revenue_cents ?? 0;
    const costCents = s.cost_cents ?? 0;
    const totalSales = s.total_sales ?? 0;
    const netMarginCents = revCents - costCents - (totalSales * TEMU_SHIPPING_FEE_CENTS);
    return {
      accountId: a.account_id,
      label: a.label,
      active: a.active === 1,
      totalSales,
      revenueEur: revCents / 100,
      costEur: costCents / 100,
      netMarginEur: netMarginCents / 100,
      activeListings: l.active_count ?? 0,
      archivedListings: l.archived_count ?? 0,
    };
  });

  res.json({ ok: true, data });
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

// All listings with product title + sale info (for dashboard)
router.get("/listings", (req, res) => {
  const { status, accountId, limit = 200, offset = 0 } = req.query;
  let where = "WHERE 1=1";
  const params = [];
  if (status)    { where += " AND l.status = ?";     params.push(status) }
  if (accountId) { where += " AND l.account_id = ?"; params.push(accountId) }
  params.push(parseInt(limit), parseInt(offset));

  const rows = db.prepare(`
    SELECT
      l.listing_id, l.account_id, l.temu_item_id, l.variant_id,
      l.title, l.price_eur_cents, l.cost_eur_cents,
      l.delivery_fee_eur_cents, l.delivery_option,
      l.status, l.published_at, l.created_at,
      l.repricing_count, l.leboncoin_ad_id,
      p.title AS product_title,
      s.sale_id, s.sale_price_eur_cents, s.confirmed_at AS sold_at,
      s.status AS sale_status
    FROM listings l
    LEFT JOIN products p ON p.temu_item_id = l.temu_item_id
    LEFT JOIN sales s ON s.listing_id = l.listing_id
      AND s.status NOT IN ('cancelled')
    ${where}
    ORDER BY l.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params);

  const total = db.prepare(`SELECT COUNT(*) AS n FROM listings l ${where.replace(/LIMIT.*/, '')}`).get(...params.slice(0, -2))?.n ?? 0;

  res.json({ ok: true, data: rows, total });
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
  const { buyerMessage, listingId, conversationId, buyerName, accountId, dryRun } = req.body ?? {};
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
    // Historique (sauf simulation depuis le dashboard)
    if (!dryRun) {
      const conv = require("../services/conversations").logExchange({
        conversationId, accountId: accountId ?? listing.account_id, listingId, buyerName, buyerMessage, result,
      });
      return res.json({ ok: true, data: { ...result, conversationId: conv } });
    }
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

// ─── Retraits porte-monnaie ──────────────────────────────────────────────────

const withdrawals = require("../services/withdrawals");
const wdStatus = (e) => ({ NOT_FOUND: 404, CONFLICT: 409, EMPTY: 422, BAD_REQUEST: 400 }[e.code] ?? 500);

router.get("/withdrawals", (req, res) => {
  res.json({ ok: true, data: withdrawals.overview() });
});

router.patch("/accounts/:id/withdraw-settings", (req, res) => {
  try { res.json({ ok: true, data: withdrawals.updateSettings(req.params.id, req.body ?? {}) }); }
  catch (e) { res.status(wdStatus(e)).json({ ok: false, error: e.message ?? String(e) }); }
});

router.post("/accounts/:id/withdraw", (req, res) => {
  try { res.status(201).json({ ok: true, data: withdrawals.requestWithdrawal(req.params.id) }); }
  catch (e) { res.status(wdStatus(e)).json({ ok: false, error: e.message ?? String(e) }); }
});

router.post("/withdrawals/:id/status", (req, res) => {
  const { status, note } = req.body ?? {};
  if (!["done", "failed", "cancelled"].includes(status)) return res.status(400).json({ ok: false, error: "status: done | failed | cancelled" });
  try { res.json({ ok: true, data: withdrawals.setStatus(req.params.id, status, note) }); }
  catch (e) { res.status(wdStatus(e)).json({ ok: false, error: e.message ?? String(e) }); }
});

// ─── Conversations acheteurs ─────────────────────────────────────────────────

router.get("/conversations", (req, res) => {
  const { listConversations } = require("../services/conversations");
  res.json({ ok: true, data: listConversations({ limit: req.query.limit }) });
});

router.get("/conversations/:id", (req, res) => {
  const { getConversation } = require("../services/conversations");
  const c = getConversation(req.params.id);
  if (!c) return res.status(404).json({ ok: false, error: "Conversation introuvable" });
  res.json({ ok: true, data: c });
});

module.exports = router;
