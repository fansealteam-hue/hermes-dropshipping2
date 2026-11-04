const db = require("../db/db");
const { randomUUID } = require("crypto");

/**
 * Confirm a sale from an external event (Leboncoin webhook or manual input).
 * Deduplicates by externalEventId.
 */
function confirmSale({
  listingId,
  externalEventId,
  salePriceEur,
  buyerName,
  deliveryCity,
}) {
  // Deduplication
  if (externalEventId) {
    const existing = db.prepare("SELECT * FROM sales WHERE external_event_id = ?").get(externalEventId);
    if (existing) return { sale: rowToSale(existing), duplicate: true };
  }

  const listing = db.prepare("SELECT * FROM listings WHERE listing_id = ?").get(listingId);
  if (!listing) throw { code: "LISTING_NOT_FOUND", message: `Listing ${listingId} introuvable` };

  const product = db.prepare("SELECT * FROM products WHERE temu_item_id = ?").get(listing.temu_item_id);
  const variant = db.prepare("SELECT * FROM variants WHERE variant_id = ?").get(listing.variant_id);

  const saleId = `sale_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO sales
      (sale_id, listing_id, channel, account_id, temu_item_id, variant_id,
       supplier_url, sale_price_eur_cents, cost_eur_cents,
       status, buyer_name, delivery_city,
       external_event_id, confirmed_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,'confirmed',?,?,?,?,?)
  `).run(
    saleId, listingId, listing.channel, listing.account_id,
    listing.temu_item_id, listing.variant_id,
    product?.temu_url ?? "",
    Math.round(salePriceEur * 100),
    listing.cost_eur_cents,
    buyerName ?? null,
    deliveryCity ?? null,
    externalEventId ?? null,
    now, now
  );

  // Update listing status
  db.prepare("UPDATE listings SET status = 'sold', updated_at = ? WHERE listing_id = ?").run(now, listingId);

  // Enqueue alert job
  const jobId = `job_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  db.prepare(`
    INSERT OR IGNORE INTO jobs (job_id, operation, payload, status, idempotency_key, run_at, created_at)
    VALUES (?, 'send_alert', ?, 'pending', ?, datetime('now'), datetime('now'))
  `).run(jobId, JSON.stringify({ saleId }), `alert:${saleId}`);

  // Enqueue mark_listing_sold — ferme l'annonce LBC + active auto-reply "non disponible"
  const soldJobId = `job_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  db.prepare(`
    INSERT OR IGNORE INTO jobs (job_id, operation, payload, status, idempotency_key, run_at, created_at)
    VALUES (?, 'mark_listing_sold', ?, 'pending', ?, datetime('now'), datetime('now'))
  `).run(soldJobId, JSON.stringify({ listingId, saleId }), `sold:${listingId}`);

  return { sale: getSale(saleId), duplicate: false };
}

function getSale(saleId) {
  const row = db.prepare("SELECT * FROM sales WHERE sale_id = ?").get(saleId);
  if (!row) return null;
  return rowToSale(row);
}

function getActiveSales() {
  return db.prepare(
    "SELECT * FROM sales WHERE status NOT IN ('closed') ORDER BY confirmed_at DESC"
  ).all().map(rowToSale);
}

function getAllSales() {
  return db.prepare("SELECT * FROM sales ORDER BY confirmed_at DESC").all().map(rowToSale);
}

function getSalesNeedingAction() {
  return db.prepare(
    "SELECT * FROM sales WHERE manual_action_required = 1 AND status != 'closed'"
  ).all().map(rowToSale);
}

/** Validation depuis Telegram : commande passée chez Temu (réf. facultative). */
function markOrdered(saleId, { orderRef } = {}) {
  const sale = db.prepare("SELECT * FROM sales WHERE sale_id = ?").get(saleId);
  if (!sale) throw { code: "NOT_FOUND", message: `Vente ${saleId} introuvable` };
  if (sale.status === "cancelled") throw { code: "CANCELLED", message: "Vente annulée" };
  if (sale.status !== "confirmed") return getSale(saleId); // déjà commandée ou plus loin : rien à faire
  const now = new Date().toISOString();
  db.prepare("UPDATE sales SET status = 'order_placed', order_ref = COALESCE(?, order_ref), order_placed_at = ?, manual_action_required = 0, updated_at = ? WHERE sale_id = ?")
    .run(orderRef ?? null, now, now, saleId);
  logChange(saleId, "status", sale.status, "order_placed", now);
  return getSale(saleId);
}

function addTracking(saleId, { orderRef, trackingNumber, trackingCarrier }) {
  const sale = db.prepare("SELECT * FROM sales WHERE sale_id = ?").get(saleId);
  if (!sale) throw { code: "NOT_FOUND", message: `Vente ${saleId} introuvable` };

  const now = new Date().toISOString();
  const fields = ["updated_at = ?"];
  const values = [now];

  if (orderRef) {
    fields.push("order_ref = ?", "status = 'order_placed'", "order_placed_at = ?");
    values.push(orderRef, now);
    logChange(saleId, "order_ref", sale.order_ref, orderRef, now);
  }
  if (trackingNumber) {
    fields.push("tracking_number = ?", "tracking_carrier = ?", "status = 'tracking_added'", "tracking_added_at = ?");
    values.push(trackingNumber, trackingCarrier ?? null, now);
    logChange(saleId, "tracking_number", sale.tracking_number, trackingNumber, now);

    // Enqueue tracking sync
    const jobId = `job_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    db.prepare(`
      INSERT OR IGNORE INTO jobs (job_id, operation, payload, status, idempotency_key, run_at, created_at)
      VALUES (?, 'sync_tracking', ?, 'pending', ?, datetime('now'), datetime('now'))
    `).run(jobId, JSON.stringify({ saleId, trackingNumber, trackingCarrier }), `tracking:${saleId}:${trackingNumber}`);
  }

  values.push(saleId);
  db.prepare(`UPDATE sales SET ${fields.join(", ")} WHERE sale_id = ?`).run(...values);
  return getSale(saleId);
}

function confirmDelivery(saleId, { confirmed, manualNote }) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE sales SET
      leboncoin_delivery_confirmed = ?,
      manual_action_required = ?,
      manual_action_note = ?,
      status = CASE WHEN ? = 1 THEN 'delivered' ELSE status END,
      updated_at = ?
    WHERE sale_id = ?
  `).run(confirmed ? 1 : 0, confirmed ? 0 : 1, manualNote ?? null, confirmed ? 1 : 0, now, saleId);
  return getSale(saleId);
}

function logChange(saleId, field, oldValue, newValue, now) {
  db.prepare("INSERT INTO sale_history (sale_id, field, old_value, new_value, changed_at) VALUES (?,?,?,?,?)").run(
    saleId, field, oldValue ?? null, newValue ?? null, now
  );
}

function rowToSale(row) {
  return {
    saleId: row.sale_id,
    listingId: row.listing_id,
    channel: row.channel,
    accountId: row.account_id,
    temuItemId: row.temu_item_id,
    variantId: row.variant_id,
    supplierUrl: row.supplier_url,
    salePriceEur: row.sale_price_eur_cents / 100,
    costEur: row.cost_eur_cents / 100,
    actualCostEur: row.actual_cost_eur_cents != null ? row.actual_cost_eur_cents / 100 : undefined,
    status: row.status,
    buyerName: row.buyer_name ?? undefined,
    deliveryAddress: row.delivery_city ?? undefined,
    orderRef: row.order_ref ?? undefined,
    trackingNumber: row.tracking_number ?? undefined,
    trackingCarrier: row.tracking_carrier ?? undefined,
    leboncoinDeliveryConfirmed: !!row.leboncoin_delivery_confirmed,
    manualActionRequired: !!row.manual_action_required,
    manualActionNote: row.manual_action_note ?? undefined,
    confirmedAt: row.confirmed_at,
    updatedAt: row.updated_at,
  };
}

module.exports = { confirmSale, getSale, getActiveSales, getSalesNeedingAction, addTracking, confirmDelivery, markOrdered, getAllSales };
