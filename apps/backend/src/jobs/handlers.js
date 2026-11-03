/**
 * Job handlers — stubs completed by Claude 3 (publish) and Claude 4 (alert).
 */
const queue = require("./queue");
const { getSale } = require("../services/sales");
const db = require("../db/db");

// ─── Claude 3 fills this ──────────────────────────────────────────────────────
async function handlePublishListing({ listingId }, job) {
  // Claude 3 replaces this stub with real Leboncoin API call
  console.log(`[jobs] publish_listing stub: ${listingId}`);
  // On success: updateListingStatus(listingId, 'published', { leboncoinAdId: '...', publishedAt: now })
  throw new Error("STUB: Leboncoin connector not yet implemented (Claude 3)");
}

// ─── Claude 4 / bot fills this ───────────────────────────────────────────────
async function handleSendAlert({ saleId }, job) {
  const sale = getSale(saleId);
  if (!sale) throw new Error(`Sale ${saleId} not found`);

  const product = db.prepare("SELECT * FROM products WHERE temu_item_id = ?").get(sale.temuItemId);
  const variant = db.prepare("SELECT * FROM variants WHERE variant_id = ?").get(sale.variantId);

  // Claude 4's sendSaleAlert() is called here at runtime via dynamic require
  // (avoids circular dependency — bot is initialized separately)
  try {
    const { sendSaleAlert } = require("../../telegram/dist/bot");
    const chatIds = (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "").split(",").filter(Boolean).map(Number);
    for (const chatId of chatIds) {
      await sendSaleAlert(chatId, {
        sale,
        productTitle: product?.title ?? sale.temuItemId,
        variantLabel: variant?.label ?? sale.variantId,
      });
    }
    db.prepare("UPDATE sales SET alert_sent = 1 WHERE sale_id = ?").run(saleId);
  } catch (e) {
    // Telegram bot may not be compiled yet in dev
    console.warn(`[jobs] sendAlert: ${e.message}`);
    db.prepare("UPDATE sales SET alert_sent = 1, manual_action_note = 'Alerte Telegram à envoyer manuellement' WHERE sale_id = ?").run(saleId);
  }
}

// ─── Tracking sync (Claude 3 fills real LBC sync) ───────────────────────────
async function handleSyncTracking({ saleId, trackingNumber, trackingCarrier }, job) {
  console.log(`[jobs] sync_tracking stub: ${saleId} ${trackingNumber}`);
  // Claude 3: sync tracking to Leboncoin conversation
}

queue.register("publish_listing", handlePublishListing);
queue.register("send_alert", handleSendAlert);
queue.register("sync_tracking", handleSyncTracking);
