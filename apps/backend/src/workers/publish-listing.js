"use strict";
const db = require("../db/db");

// ─── Stubs plateforme ─────────────────────────────────────────────────────────
// Remplacer par l'intégration réelle quand les credentials LBC/Vinted sont configurés.

async function _publishToLbc(listing) {
  void listing;
  return { ok: false, error: "LBC API non configurée — credentials requises" };
}

async function _publishToVinted(listing) {
  void listing;
  return { ok: false, error: "Vinted API non configurée — credentials requises" };
}

function _logHistory(listingId, field, oldVal, newVal) {
  db.prepare(`
    INSERT INTO listing_history (listing_id, field, old_value, new_value, changed_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(listingId, field, String(oldVal ?? ""), String(newVal ?? ""));
}

/**
 * Traite un job publish_listing.
 * @param {{ listingId: string, channel?: string, accountId?: string }} payload
 * @returns {{ ok: boolean, error?: string }}
 */
async function publishListing(payload) {
  const { listingId } = payload;
  if (!listingId) return { ok: false, error: "listingId manquant" };

  const listing = db.prepare("SELECT * FROM listings WHERE listing_id = ?").get(listingId);
  if (!listing) return { ok: false, error: `Annonce ${listingId} introuvable` };

  if (listing.status !== "draft" && listing.status !== "scheduled") {
    return { ok: false, error: `Annonce ${listingId} en status '${listing.status}', ignorée` };
  }

  const channel = payload.channel ?? listing.channel ?? "leboncoin";

  let result;
  if (channel === "vinted") {
    result = await _publishToVinted(listing);
  } else {
    result = await _publishToLbc(listing);
  }

  if (result.ok) {
    const prevStatus = listing.status;
    db.prepare(`
      UPDATE listings
      SET status = 'active', published_at = datetime('now'), updated_at = datetime('now')
      WHERE listing_id = ?
    `).run(listingId);
    _logHistory(listingId, "status", prevStatus, "active");
    console.log(`[publish-listing] ${listingId} → active (${channel})`);
    return { ok: true };
  }

  // Échec — incrémenter les tentatives depuis le job appelant
  _logHistory(listingId, "publish_attempt", null, result.error);
  console.warn(`[publish-listing] ${listingId} échec: ${result.error}`);
  return { ok: false, error: result.error };
}

module.exports = { publishListing };
