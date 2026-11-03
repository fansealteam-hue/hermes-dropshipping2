/**
 * Negotiation engine — automatic price negotiation rules.
 *
 * Rules:
 *   offer >= 95% of listing price → accept
 *   offer >= 85% of listing price → counter-propose at 95%
 *   offer >= 70% of listing price → counter-propose at listing price
 *   offer < 70%                   → refuse
 */

const ACCEPT_THRESHOLD = parseFloat(process.env.NEGO_ACCEPT_PCT ?? "0.95");
const COUNTER_THRESHOLD = parseFloat(process.env.NEGO_COUNTER_PCT ?? "0.85");
const REFUSE_THRESHOLD = parseFloat(process.env.NEGO_REFUSE_PCT ?? "0.70");

/**
 * @param {number} listingPriceEur
 * @param {number} offerPriceEur
 * @returns {{ decision: 'accept'|'counter'|'refuse', counterPriceEur?: number, ratio: number }}
 */
function evaluateOffer(listingPriceEur, offerPriceEur) {
  if (!listingPriceEur || listingPriceEur <= 0) {
    throw Object.assign(new Error("Prix annonce invalide"), { code: "INVALID_PRICE" });
  }
  if (!offerPriceEur || offerPriceEur <= 0) {
    throw Object.assign(new Error("Offre invalide"), { code: "INVALID_OFFER" });
  }

  const ratio = offerPriceEur / listingPriceEur;

  if (ratio >= ACCEPT_THRESHOLD) {
    return { decision: "accept", ratio };
  }

  if (ratio >= COUNTER_THRESHOLD) {
    const counterPriceEur = _round(listingPriceEur * ACCEPT_THRESHOLD);
    return { decision: "counter", counterPriceEur, ratio };
  }

  if (ratio >= REFUSE_THRESHOLD) {
    return { decision: "counter", counterPriceEur: listingPriceEur, ratio };
  }

  return { decision: "refuse", ratio };
}

/**
 * Build a polite reply message for the negotiation outcome.
 */
function buildReply(decision, counterPriceEur, listingPriceEur) {
  switch (decision) {
    case "accept":
      return "Parfait, votre offre est acceptée ! Je vous contacte pour finaliser la transaction.";

    case "counter":
      return counterPriceEur < listingPriceEur
        ? `Je peux faire un effort et descendre à ${counterPriceEur.toFixed(2)} €. C'est mon dernier prix.`
        : `Je maintiens le prix à ${listingPriceEur.toFixed(2)} €, c'est déjà le prix le plus bas que je peux faire.`;

    case "refuse":
      return `Désolé, je ne peux pas descendre en dessous de ${listingPriceEur.toFixed(2)} €. Le prix est ferme.`;

    default:
      return "Je reviens vers vous rapidement.";
  }
}

function _round(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { evaluateOffer, buildReply, ACCEPT_THRESHOLD, COUNTER_THRESHOLD, REFUSE_THRESHOLD };
