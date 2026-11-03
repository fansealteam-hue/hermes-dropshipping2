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
  const rawLimit  = parseInt(req.query.limit  ?? "200");
  const rawOffset = parseInt(req.query.offset ?? "0");
  const limitVal  = Math.min(Math.max(rawLimit,  1), 1000);
  const offsetVal = Math.max(rawOffset, 0);
  const { status, accountId } = req.query;

  let where = "WHERE 1=1";
  const filterParams = [];
  if (status)    { where += " AND l.status = ?";     filterParams.push(status) }
  if (accountId) { where += " AND l.account_id = ?"; filterParams.push(accountId) }

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
  `).all(...filterParams, limitVal, offsetVal);

  const total = db.prepare(`SELECT COUNT(*) AS n FROM listings l ${where}`).get(...filterParams)?.n ?? 0;

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
  res.json({ ok: true });
});

// ─── Republier annonce après vente (bouton 🔁 Republier) ─────────────────────

router.post("/sales/:id/republish", (req, res) => {
  const { randomUUID } = require("crypto");
  const sale = getSale(req.params.id);
  if (!sale) return res.status(404).json({ ok: false, error: "Vente introuvable" });

  // Marquer la vente comme closed
  db.prepare("UPDATE sales SET status = 'closed', updated_at = datetime('now') WHERE sale_id = ?")
    .run(sale.saleId);

  // Enqueue republish job (supprime cache photo + recrée annonce)
  const jobId = `job_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const key = `republish:${sale.listingId}:${Date.now()}`;
  db.prepare(`
    INSERT OR IGNORE INTO jobs (job_id, operation, payload, status, idempotency_key, run_at, created_at)
    VALUES (?, 'republish_listing', ?, 'pending', ?, datetime('now'), datetime('now'))
  `).run(jobId, JSON.stringify({ listingId: sale.listingId, saleId: sale.saleId }), key);

  res.json({ ok: true, data: { jobId, status: "enqueued" } });
});

// ─── Clore une vente sans republication (bouton 📦 Archiver) ─────────────────

router.post("/sales/:id/close", (req, res) => {
  const sale = getSale(req.params.id);
  if (!sale) return res.status(404).json({ ok: false, error: "Vente introuvable" });

  db.prepare("UPDATE sales SET status = 'closed', updated_at = datetime('now') WHERE sale_id = ?")
    .run(sale.saleId);

  // Archive l'annonce aussi
  db.prepare("UPDATE listings SET status = 'archived', updated_at = datetime('now') WHERE listing_id = ?")
    .run(sale.listingId);

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

// ─── Bump all listings ────────────────────────────────────────────────────────

router.post("/listings/bump-all", (req, res) => {
  const rows = db.prepare(
    "SELECT listing_id FROM listings WHERE status = 'active' AND account_id IS NOT NULL"
  ).all();
  let jobsCreated = 0;
  for (const row of rows) {
    const key = `bump_listing:${row.listing_id}`;
    const existing = db.prepare(
      "SELECT 1 FROM jobs WHERE idempotency_key = ? AND status = 'pending'"
    ).get(key);
    if (!existing) {
      const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      db.prepare(
        `INSERT INTO jobs (job_id, operation, payload, status, idempotency_key, run_at, created_at)
         VALUES (?, 'bump_listing', ?, 'pending', ?, datetime('now'), datetime('now'))`
      ).run(jobId, JSON.stringify({ listingId: row.listing_id }), key);
      jobsCreated++;
    }
  }
  res.json({ ok: true, data: { jobsCreated } });
});

// ─── Sync all accounts ────────────────────────────────────────────────────────

router.post("/accounts/sync-all", (req, res) => {
  const accounts = db.prepare(
    "SELECT account_id FROM seller_accounts WHERE active = 1"
  ).all();
  let jobsCreated = 0;
  for (const acc of accounts) {
    const key = `sync_account:${acc.account_id}`;
    const existing = db.prepare(
      "SELECT 1 FROM jobs WHERE idempotency_key = ? AND status = 'pending'"
    ).get(key);
    if (!existing) {
      const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      db.prepare(
        `INSERT INTO jobs (job_id, operation, payload, status, idempotency_key, run_at, created_at)
         VALUES (?, 'sync_account', ?, 'pending', ?, datetime('now'), datetime('now'))`
      ).run(jobId, JSON.stringify({ accountId: acc.account_id }), key);
      jobsCreated++;
    }
  }
  res.json({ ok: true, data: { jobsCreated } });
});

// ─── Agents status ────────────────────────────────────────────────────────────

router.get("/agents/status", (req, res) => {
  const pending   = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'").get().n;
  const running   = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'running'").get().n;
  const done24h   = db.prepare(
    "SELECT COUNT(*) AS n FROM jobs WHERE status = 'done' AND created_at >= datetime('now', '-24 hours')"
  ).get().n;
  const failed24h = db.prepare(
    "SELECT COUNT(*) AS n FROM jobs WHERE status = 'failed' AND created_at >= datetime('now', '-24 hours')"
  ).get().n;
  res.json({ ok: true, data: { pending, running, done24h, failed24h } });
});

// ─── Unread messages ──────────────────────────────────────────────────────────

router.get("/messages/unread", (req, res) => {
  // table créée à la migration si absente
  db.prepare(`CREATE TABLE IF NOT EXISTS lbc_messages (
    id          TEXT PRIMARY KEY,
    listing_id  TEXT,
    sender_name TEXT,
    preview     TEXT,
    full_text   TEXT,
    read        INTEGER NOT NULL DEFAULT 0,
    received_at TEXT NOT NULL
  )`).run();
  const rows = db.prepare(
    "SELECT id, sender_name AS senderName, preview, received_at FROM lbc_messages WHERE read = 0 ORDER BY received_at DESC LIMIT 20"
  ).all();
  res.json({ ok: true, data: rows });
});

module.exports = router;
