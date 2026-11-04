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

function _pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function buildReply(decision, counterPriceEur, listingPriceEur) {
  const livraisonNote = "Je fais uniquement en livraison btw 📦";

  switch (decision) {
    case "accept":
      return _pick([
        `Top, c'est ok pour moi ! ${livraisonNote} On finalise comment ?`,
        `Marché conclu ! ${livraisonNote} Dites-moi comment vous voulez procéder 😊`,
        `C'est bon pour moi ! ${livraisonNote} On règle ça comment ?`,
      ]);

    case "counter":
      if (counterPriceEur < listingPriceEur) {
        return _pick([
          `Honnêtement je peux faire ${counterPriceEur.toFixed(2)} € et c'est vraiment mon max. ${livraisonNote}`,
          `Je peux descendre à ${counterPriceEur.toFixed(2)} €, c'est le mieux que je puisse faire 🙂 ${livraisonNote}`,
          `${counterPriceEur.toFixed(2)} € c'est mon dernier prix, je ne peux pas aller plus bas. ${livraisonNote}`,
        ]);
      }
      return _pick([
        `Ah c'est difficile, j'en suis déjà à ${listingPriceEur.toFixed(2)} € qui est mon minimum. ${livraisonNote} Toujours intéressé(e) ?`,
        `Je suis déjà au plus bas à ${listingPriceEur.toFixed(2)} €, j'ai pas vraiment de marge. ${livraisonNote} 😊`,
        `${listingPriceEur.toFixed(2)} € c'est vraiment mon prix plancher malheureusement. ${livraisonNote} Dites-moi si ça vous va !`,
      ]);

    default:
      return `Merci pour votre intérêt ! ${livraisonNote} Dites-moi si vous avez des questions 😊`;
  }
}

function _round(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { evaluateOffer, buildReply, ACCEPT_THRESHOLD, COUNTER_THRESHOLD };
