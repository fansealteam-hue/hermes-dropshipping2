"use strict";
/**
 * Moteur de négociation — règles automatiques de réponse aux offres.
 *
 * Principe : NE JAMAIS refuser une vente sèchement.
 *   - Offre ≥ 95% → acceptée
 *   - Offre ≥ 85% → contre-proposition à 95%
 *   - Offre ≥ 70% → contre-proposition au prix affiché
 *   - Offre < 70% → contre-proposition au prix affiché (jamais de refus)
 *
 * Mode livraison : TOUJOURS proposer uniquement la livraison (jamais le retrait).
 */

const ACCEPT_THRESHOLD  = parseFloat(process.env.NEGO_ACCEPT_PCT  ?? "0.95");
const COUNTER_THRESHOLD = parseFloat(process.env.NEGO_COUNTER_PCT ?? "0.85");

function evaluateOffer(listingPriceEur, offerPriceEur) {
  if (!listingPriceEur || listingPriceEur <= 0)
    throw Object.assign(new Error("Prix annonce invalide"), { code: "INVALID_PRICE" });
  if (!offerPriceEur || offerPriceEur <= 0)
    throw Object.assign(new Error("Offre invalide"), { code: "INVALID_OFFER" });

  const ratio = offerPriceEur / listingPriceEur;

  if (ratio >= ACCEPT_THRESHOLD) {
    return { decision: "accept", ratio };
  }

  if (ratio >= COUNTER_THRESHOLD) {
    return { decision: "counter", counterPriceEur: _round(listingPriceEur * ACCEPT_THRESHOLD), ratio };
  }

  // Offre basse ou très basse → on contre-propose au prix affiché, jamais de refus
  return { decision: "counter", counterPriceEur: listingPriceEur, ratio };
}

function buildReply(decision, counterPriceEur, listingPriceEur) {
  // Toutes les réponses précisent : livraison uniquement (jamais retrait)
  const livraisonNote = "Je propose uniquement la livraison (pas de remise en main propre).";

  switch (decision) {
    case "accept":
      return [
        "Bonjour, votre offre est acceptée !",
        livraisonNote,
        "Je vous contacte pour finaliser.",
      ].join(" ");

    case "counter":
      if (counterPriceEur < listingPriceEur) {
        return [
          `Bonjour, je peux faire un effort à ${counterPriceEur.toFixed(2)} €, c'est mon dernier prix.`,
          livraisonNote,
        ].join(" ");
      }
      return [
        `Bonjour, le prix est à ${listingPriceEur.toFixed(2)} €, c'est déjà le minimum.`,
        livraisonNote,
        "N'hésitez pas si vous êtes intéressé(e) !",
      ].join(" ");

    default:
      return [
        "Bonjour, merci pour votre message.",
        livraisonNote,
        "Le vendeur vous répond rapidement.",
      ].join(" ");
  }
}

function _round(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { evaluateOffer, buildReply, ACCEPT_THRESHOLD, COUNTER_THRESHOLD };
