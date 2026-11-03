/**
 * Repricing service — auto-adjust unsold listings over time.
 *
 * Cycle (repricing_count = nb de baisses déjà effectuées) :
 *   0 → reprice seulement (−15%)
 *   1 → reprice + nouvelles photos IA + nouveau titre
 *   2 → reprice + nouvelles photos IA + nouveau titre (dernière chance)
 *   ≥ 3 (MAX_REPRICE_COUNT) → archivage (retrait LBC)
 *   À tout moment : si marge après baisse < MIN_MARGIN_EUR → archivage
 *
 * Chaque cycle s'enclenche tous les REPRICE_DAYS_1 jours après la dernière baisse
 * (ou après published_at pour le premier cycle).
 */
const db = require("../db/db");
const { TEMU_SHIPPING_FEE } = require("./pricing");

const REPRICE_DAYS_1      = parseInt(process.env.REPRICE_DAYS_1      ?? "7");
const REPRICE_STEP_PCT    = parseFloat(process.env.REPRICE_STEP_PCT   ?? "0.15");
const MIN_MARGIN_EUR      = parseFloat(process.env.MIN_MARGIN_EUR     ?? "5.0");
const MAX_REPRICE_COUNT   = parseInt(process.env.MAX_REPRICE_COUNT    ?? "3");

/**
 * Returns published unsold listings due for their next repricing cycle.
 * Uses last_repriced_at when available, published_at for the first cycle.
 */
function getListingsDueForReprice() {
  return db.prepare(`
    SELECT l.*
    FROM listings l
    WHERE l.status = 'published'
      AND l.published_at IS NOT NULL
      AND datetime(COALESCE(l.last_repriced_at, l.published_at)) <= datetime('now', '-' || ? || ' days')
      AND NOT EXISTS (
        SELECT 1 FROM sales s
        WHERE s.listing_id = l.listing_id
          AND s.status NOT IN ('cancelled', 'refunded')
      )
    ORDER BY l.published_at ASC
  `).all(REPRICE_DAYS_1);
}

/**
 * Compute the repricing action for a listing based on its repricing_count.
 *
 * @returns {{ action: 'reprice'|'reprice_refresh'|'archive', newPriceEur?: number }}
 */
function computeRepriceAction(listing) {
  const repricingCount  = listing.repricing_count ?? 0;
  const currentPriceCents = listing.price_eur_cents;
  const costCents       = listing.cost_eur_cents;
  const deliveryFeeCents = listing.delivery_fee_eur_cents ?? 0;

  // 3 cycles effectués → on supprime
  if (repricingCount >= MAX_REPRICE_COUNT) {
    return { action: "archive" };
  }

  // Baisse de prix (livraison conservée intacte — l'acheteur la paie)
  const basePriceCents = currentPriceCents - deliveryFeeCents;
  const newBaseCents   = Math.floor(basePriceCents * (1 - REPRICE_STEP_PCT));
  const newPriceCents  = newBaseCents + deliveryFeeCents;
  const newPriceEur    = newPriceCents / 100;

  // Vérifier marge après baisse
  const temuCents      = Math.round(TEMU_SHIPPING_FEE * 100);
  const minMarginCents = Math.round(MIN_MARGIN_EUR * 100);
  if (newBaseCents - costCents - temuCents < minMarginCents) {
    return { action: "archive" };
  }

  // Cycle 1+ : refresh photos + titre aussi
  const action = repricingCount >= 1 ? "reprice_refresh" : "reprice";
  return { action, newPriceEur };
}

/**
 * Apply price reduction in DB and increment repricing_count.
 */
function applyReprice(listingId, newPriceEur) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE listings
    SET price_eur_cents  = ?,
        repricing_count  = repricing_count + 1,
        last_repriced_at = ?,
        updated_at       = ?
    WHERE listing_id = ?
  `).run(Math.round(newPriceEur * 100), now, now, listingId);
  return db.prepare("SELECT * FROM listings WHERE listing_id = ?").get(listingId);
}

/**
 * Mark listing archived in DB (Playwright removal enqueued by the job handler).
 */
function archiveListing(listingId) {
  const now = new Date().toISOString();
  db.prepare("UPDATE listings SET status = 'archived', updated_at = ? WHERE listing_id = ?")
    .run(now, listingId);
}

/**
 * Count listings published today (for daily cap).
 */
function countPublishedToday() {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM listings
    WHERE status IN ('published', 'draft', 'scheduled')
      AND date(created_at) = date('now')
  `).get();
  return row?.n ?? 0;
}

module.exports = {
  getListingsDueForReprice,
  computeRepriceAction,
  applyReprice,
  archiveListing,
  countPublishedToday,
  REPRICE_DAYS_1,
  REPRICE_STEP_PCT,
  MIN_MARGIN_EUR,
  MAX_REPRICE_COUNT,
};
