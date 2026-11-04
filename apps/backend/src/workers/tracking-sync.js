"use strict";
const db = require("../db/db");

const MAX_DAYS_IN_TRANSIT = 20;

// ─── Stubs transporteurs ──────────────────────────────────────────────────────

async function _queryCarrier(carrier, trackingNumber) {
  void trackingNumber;
  if (carrier === "colissimo") return { delivered: false, status: "en_transit" };
  if (carrier === "mondial_relay") return { delivered: false, status: "en_transit" };
  // Transporteur inconnu → vérification manuelle requise
  return { delivered: false, status: "unknown" };
}

/**
 * Traite un job sync_tracking.
 * @param {{ saleId: string }} payload
 */
async function syncTracking(payload) {
  const { saleId } = payload;
  if (!saleId) return { ok: false, error: "saleId manquant" };

  const sale = db.prepare("SELECT * FROM sales WHERE sale_id = ?").get(saleId);
  if (!sale) return { ok: false, error: `Vente ${saleId} introuvable` };

  if (!sale.tracking_number) {
    return { ok: false, error: `Vente ${saleId} sans numéro de suivi` };
  }

  // Vérifier délai dépassé
  if (sale.tracking_added_at) {
    const addedAt  = new Date(sale.tracking_added_at);
    const daysSince = (Date.now() - addedAt.getTime()) / 86_400_000;
    if (daysSince > MAX_DAYS_IN_TRANSIT && !sale.leboncoin_delivery_confirmed) {
      db.prepare(`
        UPDATE sales
        SET manual_action_required = 1,
            manual_action_note = 'Délai dépassé — vérifier manuellement',
            updated_at = datetime('now')
        WHERE sale_id = ?
      `).run(saleId);
      console.warn(`[tracking-sync] ${saleId} délai >20j — action manuelle requise`);
      return { ok: true, action: "manual_required" };
    }
  }

  const carrier = (sale.tracking_carrier ?? "").toLowerCase();
  const result  = await _queryCarrier(carrier, sale.tracking_number);

  if (result.delivered) {
    db.prepare(`
      UPDATE sales
      SET leboncoin_delivery_confirmed = 1,
          status = 'shipped',
          updated_at = datetime('now')
      WHERE sale_id = ?
    `).run(saleId);
    console.log(`[tracking-sync] ${saleId} → livraison confirmée`);
    return { ok: true, action: "confirmed" };
  }

  if (result.status === "unknown") {
    db.prepare(`
      UPDATE sales
      SET manual_action_required = 1,
          manual_action_note = 'Transporteur inconnu — vérifier manuellement',
          updated_at = datetime('now')
      WHERE sale_id = ?
    `).run(saleId);
    return { ok: true, action: "manual_required" };
  }

  console.log(`[tracking-sync] ${saleId} statut: ${result.status}`);
  return { ok: true, action: "pending", status: result.status };
}

module.exports = { syncTracking };
