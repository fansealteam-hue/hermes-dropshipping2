/**
 * Auto-responder for Leboncoin buyer messages.
 * Uses Claude API to generate context-aware replies.
 * Falls back to rule-based replies when API is unavailable.
 */

const { evaluateOffer, buildReply } = require("./negotiation");

// Price offer patterns (e.g. "50€", "50 euros", "je propose 50")
const OFFER_RE = /(?:je (?:propose|offre|mets)|offre|pour)\s*[:=]?\s*(\d+(?:[.,]\d+)?)\s*(?:€|euros?)?/i;
const AMOUNT_RE = /(\d+(?:[.,]\d+)?)\s*(?:€|euros?)/i;

/**
 * Generate an automatic reply to a buyer message.
 *
 * @param {object} opts
 * @param {string} opts.buyerMessage   - Raw message from buyer
 * @param {number} opts.listingPriceEur
 * @param {string} opts.productTitle
 * @param {string} opts.variantLabel
 * @param {boolean} [opts.hasShipping] - Whether shipping is included
 * @returns {Promise<{ reply: string, action: 'send'|'escalate'|'suspend', offerEur?: number, decision?: string }>}
 */
async function generateReply({
  buyerMessage,
  listingPriceEur,
  productTitle,
  variantLabel,
  hasShipping = false,
}) {
  const lower = buyerMessage.toLowerCase();

  // Litige keywords → always escalate to operator
  const LITIGE_KEYWORDS = ["litige", "arnaque", "escroc", "remboursement", "plainte", "signalement"];
  if (LITIGE_KEYWORDS.some(k => lower.includes(k))) {
    return { reply: "", action: "escalate", reason: "litige_detected" };
  }

  // Extract price offer
  const offerEur = _extractOffer(buyerMessage);
  if (offerEur) {
    const nego = evaluateOffer(listingPriceEur, offerEur);
    const reply = buildReply(nego.decision, nego.counterPriceEur, listingPriceEur);
    return {
      reply,
      action: nego.decision === "accept" ? "escalate" : "send",
      offerEur,
      decision: nego.decision,
      counterPriceEur: nego.counterPriceEur,
    };
  }

  // Use Claude API for general questions
  const claudeReply = await _askClaude({ buyerMessage, listingPriceEur, productTitle, variantLabel, hasShipping });
  return { reply: claudeReply, action: "send" };
}

function _extractOffer(text) {
  let m = OFFER_RE.exec(text);
  if (!m) m = AMOUNT_RE.exec(text);
  if (!m) return null;
  const val = parseFloat(m[1].replace(",", "."));
  return isNaN(val) || val <= 0 ? null : val;
}

async function _askClaude({ buyerMessage, listingPriceEur, productTitle, variantLabel, hasShipping }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || process.env.NODE_ENV === "test") {
    return _fallbackReply(buyerMessage, listingPriceEur);
  }

  try {
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic.default({ apiKey });

    const systemPrompt = [
      "Tu es l'assistant automatique d'un vendeur sur Leboncoin.",
      `Article en vente : ${productTitle} — ${variantLabel} à ${listingPriceEur.toFixed(2)} €.`,
      hasShipping ? "La livraison est incluse." : "La livraison est en sus.",
      "Réponds en français, de façon courtoise et concise (max 3 phrases).",
      "Ne fais jamais de promesse sur les délais ou les remboursements.",
      "Si la question dépasse tes capacités, dis que le vendeur revient rapidement.",
    ].join(" ");

    const response = await client.messages.create({
      model: process.env.CLAUDE_MODEL ?? "claude-haiku-5-5",
      max_tokens: 256,
      system: systemPrompt,
      messages: [{ role: "user", content: buyerMessage }],
    });

    return response.content[0]?.text?.trim() ?? _fallbackReply(buyerMessage, listingPriceEur);
  } catch (err) {
    console.warn(`[auto-responder] Claude API error: ${err.message}`);
    return _fallbackReply(buyerMessage, listingPriceEur);
  }
}

function _fallbackReply(message, listingPriceEur) {
  const lower = message.toLowerCase();

  if (lower.includes("disponible") || lower.includes("encore")) {
    return "Oui, l'article est toujours disponible. N'hésitez pas à faire une offre !";
  }
  if (lower.includes("livrai") || lower.includes("envoi") || lower.includes("expéd")) {
    return "La livraison est disponible, le montant est indiqué dans l'annonce.";
  }
  if (lower.includes("état") || lower.includes("condition") || lower.includes("neuf")) {
    return "L'article est en bon état, conforme aux photos de l'annonce.";
  }
  if (lower.includes("garantie")) {
    return "Pas de garantie sur cet article vendu entre particuliers.";
  }
  return "Bonjour, merci pour votre message. Le vendeur vous répond rapidement.";
}

module.exports = { generateReply };
