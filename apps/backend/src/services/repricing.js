/**
 * Repricing service — auto-adjust unsold listings over time.
 *
 * Schedule (configurable via env):
 *   Week 1–2  (REPRICE_DAYS_1 = 7)  : lower price by REPRICE_STEP_PCT (15%)
 *   Week 2–3  (REPRICE_DAYS_2 = 14) : lower price again + new AI photos + new title/description
 *   If margin would go below MIN_MARGIN_EUR after repricing → archive listing
 */
const db = require("../db/db");
const { TEMU_SHIPPING_FEE, DELIVERY_OTHER_FEE } = require("./pricing");

const REPRICE_DAYS_1  = parseInt(process.env.REPRICE_DAYS_1  ?? "7");
const REPRICE_DAYS_2  = parseInt(process.env.REPRICE_DAYS_2  ?? "14");
const REPRICE_STEP_PCT = parseFloat(process.env.REPRICE_STEP_PCT ?? "0.15");
const MIN_MARGIN_EUR  = parseFloat(process.env.MIN_MARGIN_EUR ?? "5.0");

/**
 * Returns listings that are published, unsold, and due for repricing.
 * Only returns listings whose published_at is older than REPRICE_DAYS_1.
 */
function getListingsDueForReprice() {
  return db.prepare(`
    SELECT l.*
    FROM listings l
    WHERE l.status = 'published'
      AND l.published_at IS NOT NULL
      AND datetime(l.published_at) <= datetime('now', '-' || ? || ' days')
      AND NOT EXISTS (
        SELECT 1 FROM sales s
        WHERE s.listing_id = l.listing_id
          AND s.status NOT IN ('cancelled', 'refunded')
      )
    ORDER BY l.published_at ASC
  `).all(REPRICE_DAYS_1);
}

/**
 * Compute repricing action for a listing.
 *
 * @returns {{ action: 'reprice'|'reprice_refresh'|'archive', newPriceEur?: number, repricingCount: number }}
 */
function computeRepriceAction(listing) {
  const publishedAt = new Date(listing.published_at);
  const ageMs = Date.now() - publishedAt.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  const repricingCount = listing.repricing_count ?? 0;
  const currentPriceCents = listing.price_eur_cents;
  const costCents = listing.cost_eur_cents;
  const deliveryFeeCents = listing.delivery_fee_eur_cents ?? 0;

  // Reduce price — keep delivery fee intact (buyer still pays it)
  const basePriceCents = currentPriceCents - deliveryFeeCents;
  const newBaseCents = Math.floor(basePriceCents * (1 - REPRICE_STEP_PCT));
  const newPriceCents = newBaseCents + deliveryFeeCents;
  const newPriceEur = newPriceCents / 100;

  // Check margin: newBasePrice - productCost - temuShipping
  const minMarginCents = Math.round(MIN_MARGIN_EUR * 100);
  const temuCents = Math.round(TEMU_SHIPPING_FEE * 100);
  const marginAfterCents = newBaseCents - costCents - temuCents;

  if (marginAfterCents < minMarginCents) {
    return { action: "archive", repricingCount };
  }

  // Week 2+: refresh photos + description too
  const action = ageDays >= REPRICE_DAYS_2 ? "reprice_refresh" : "reprice";

  return { action, newPriceEur, repricingCount };
}

/**
 * Apply a repricing action to a listing in DB.
 * Returns updated listing row.
 */
function applyReprice(listingId, newPriceEur) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE listings
    SET price_eur_cents = ?,
        repricing_count = repricing_count + 1,
        last_repriced_at = ?,
        updated_at = ?
    WHERE listing_id = ?
  `).run(Math.round(newPriceEur * 100), now, now, listingId);
  return db.prepare("SELECT * FROM listings WHERE listing_id = ?").get(listingId);
}

/**
 * Archive a listing: remove from LBC (via job) and mark archived in DB.
 */
function archiveListing(listingId) {
  const now = new Date().toISOString();
  db.prepare("UPDATE listings SET status = 'archived', updated_at = ? WHERE listing_id = ?").run(now, listingId);
}

module.exports = {
  getListingsDueForReprice,
  computeRepriceAction,
  applyReprice,
  archiveListing,
  REPRICE_DAYS_1,
  REPRICE_DAYS_2,
  REPRICE_STEP_PCT,
  MIN_MARGIN_EUR,
};
