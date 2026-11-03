const db = require("../db/db");
const { randomUUID } = require("crypto");
const { validatePrice, DELIVERY_OTHER_FEE } = require("./pricing");

/**
 * Create a listing draft and optionally enqueue publication.
 * Claude 3 implements the actual Leboncoin connector.
 */
function createListing({ temuItemId, variantId, accountId, priceEur, scheduledAt, deliveryOption }) {
  const variant = db.prepare("SELECT * FROM variants WHERE variant_id = ?").get(variantId);
  if (!variant) throw { code: "VARIANT_NOT_FOUND", message: `Variante ${variantId} introuvable` };

  const product = db.prepare("SELECT * FROM products WHERE temu_item_id = ?").get(temuItemId);
  if (!product) throw { code: "PRODUCT_NOT_FOUND", message: `Produit ${temuItemId} introuvable` };

  if (product.warehouse_status !== "local") {
    throw { code: "INELIGIBLE_WAREHOUSE", message: "Produit inéligible : entrepôt non local" };
  }

  const account = db.prepare("SELECT * FROM seller_accounts WHERE account_id = ? AND active = 1").get(accountId);
  if (!account) throw { code: "ACCOUNT_NOT_FOUND", message: `Compte ${accountId} introuvable ou inactif` };

  // +3€ livraison "autre" inclus dans le prix affiché
  const deliveryFeeCents = deliveryOption === "autre" ? Math.round(DELIVERY_OTHER_FEE * 100) : 0;
  const finalPriceEur = priceEur + deliveryFeeCents / 100;

  const priceCheck = validatePrice(variant.cost_eur_cents / 100, finalPriceEur);
  if (!priceCheck.valid) throw { code: "INVALID_PRICE", message: priceCheck.reason };

  const listingId = `lst_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO listings
      (listing_id, channel, account_id, temu_item_id, variant_id, title, description,
       price_eur_cents, cost_eur_cents, media_urls, status, scheduled_at,
       delivery_option, delivery_fee_eur_cents, created_at, updated_at)
    VALUES (?, 'leboncoin', ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    listingId, accountId, temuItemId, variantId,
    product.title + " — " + variant.label,
    Math.round(finalPriceEur * 100),
    variant.cost_eur_cents,
    variant.image_urls,
    scheduledAt ? "scheduled" : "draft",
    scheduledAt ?? null,
    deliveryOption ?? null,
    deliveryFeeCents,
    now, now
  );

  // Enqueue publication job (Claude 3 will process it)
  enqueuePublish(listingId, accountId, scheduledAt);

  return getListing(listingId);
}

function getListing(listingId) {
  const row = db.prepare("SELECT * FROM listings WHERE listing_id = ?").get(listingId);
  if (!row) return null;
  return rowToListing(row);
}

function updateListingStatus(listingId, status, extra = {}) {
  const now = new Date().toISOString();
  const current = db.prepare("SELECT * FROM listings WHERE listing_id = ?").get(listingId);
  if (!current) throw { code: "NOT_FOUND", message: `Listing ${listingId} introuvable` };

  // Log change
  if (current.status !== status) {
    db.prepare("INSERT INTO listing_history (listing_id, field, old_value, new_value, changed_at) VALUES (?,?,?,?,?)").run(
      listingId, "status", current.status, status, now
    );
  }

  const fields = ["status = ?", "updated_at = ?"];
  const values = [status, now];

  if (extra.leboncoinAdId) { fields.push("leboncoin_ad_id = ?"); values.push(extra.leboncoinAdId); }
  if (extra.publishedAt) { fields.push("published_at = ?"); values.push(extra.publishedAt); }

  values.push(listingId);
  db.prepare(`UPDATE listings SET ${fields.join(", ")} WHERE listing_id = ?`).run(...values);
  return getListing(listingId);
}

function enqueuePublish(listingId, accountId, scheduledAt) {
  const { randomUUID } = require("crypto");
  const jobId = `job_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const runAt = scheduledAt ?? new Date().toISOString();
  const key = `publish:${listingId}`;

  db.prepare(`
    INSERT OR IGNORE INTO jobs (job_id, operation, payload, status, account_id, idempotency_key, run_at, created_at)
    VALUES (?, 'publish_listing', ?, 'pending', ?, ?, ?, datetime('now'))
  `).run(jobId, JSON.stringify({ listingId }), accountId, key, runAt);
}

function rowToListing(row) {
  return {
    listingId: row.listing_id,
    channel: row.channel,
    accountId: row.account_id,
    temuItemId: row.temu_item_id,
    variantId: row.variant_id,
    title: row.title,
    description: row.description,
    priceEur: row.price_eur_cents / 100,
    costEur: row.cost_eur_cents / 100,
    mediaUrls: JSON.parse(row.media_urls || "[]"),
    status: row.status,
    scheduledAt: row.scheduled_at ?? undefined,
    publishedAt: row.published_at ?? undefined,
    leboncoinAdId: row.leboncoin_ad_id ?? undefined,
    deliveryOption: row.delivery_option ?? undefined,
    deliveryFeeEur: (row.delivery_fee_eur_cents ?? 0) / 100,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = { createListing, getListing, updateListingStatus };
