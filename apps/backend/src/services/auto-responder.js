"use strict";
/**
 * Auto-répondeur messages acheteurs LBC/Vinted.
 *
 * Règles absolues :
 *   1. Ne jamais refuser une vente ou une question sèchement
 *   2. Toujours proposer UNIQUEMENT la livraison (jamais retrait en main propre)
 *   3. Si litige/arnaque détecté → escalader à l'opérateur
 *   4. Si offre de prix → moteur de négociation (jamais de refus sec)
 */

const { evaluateOffer, buildReply } = require("./negotiation");

const LIVRAISON_NOTE = "Je propose uniquement la livraison (pas de retrait possible).";

// Mots-clés offre de prix
const OFFER_RE  = /(?:je (?:propose|offre|mets|donne)|offre|pour)\s*[:=]?\s*(\d+(?:[.,]\d+)?)\s*(?:€|euros?)?/i;
const AMOUNT_RE = /(\d+(?:[.,]\d+)?)\s*(?:€|euros?)/i;

// Mots-clés retrait / rencontre → toujours rediriger vers livraison
const RETRAIT_RE = /\b(retrait|récupér|passe[rz]?|venir|chercher|rencontr|en mains? propres?|sur place|rendez.vous|rdv)\b/i;

// Mots-clés litige → escalade opérateur
const LITIGE_RE = /\b(litige|arnaque|escroc|remboursement|plainte|signalement|paypal|fraude)\b/i;

async function generateReply({
  buyerMessage,
  listingPriceEur,
  productTitle,
  variantLabel,
  listingStatus = "active",
}) {
  // Article vendu
  if (listingStatus === "sold" || listingStatus === "closed") {
    return {
      reply: "Bonjour, cet article vient d'être vendu. Merci pour votre intérêt, n'hésitez pas à consulter mes autres annonces !",
      action: "send",
      reason: "listing_sold",
    };
  }

  const lower = buyerMessage.toLowerCase();

  // Litige → escalade obligatoire, pas de réponse auto
  if (LITIGE_RE.test(lower)) {
    return { reply: "", action: "escalate", reason: "litige_detected" };
  }

  // Demande de retrait → rediriger vers livraison uniquement, jamais refuser
  if (RETRAIT_RE.test(lower)) {
    return {
      reply: [
        "Bonjour, merci pour votre message !",
        LIVRAISON_NOTE,
        "L'envoi se fait rapidement après confirmation de la commande.",
      ].join(" "),
      action: "send",
      reason: "retrait_redirected",
    };
  }

  // Offre de prix → négociation (jamais de refus sec)
  const offerEur = _extractOffer(buyerMessage);
  if (offerEur) {
    try {
      const nego = evaluateOffer(listingPriceEur, offerEur);
      const reply = buildReply(nego.decision, nego.counterPriceEur, listingPriceEur);
      return {
        reply,
        action: nego.decision === "accept" ? "escalate" : "send",
        offerEur,
        decision: nego.decision,
        counterPriceEur: nego.counterPriceEur,
        reason: "negotiation",
      };
    } catch (_) {
      // Si le calcul échoue → réponse générique
    }
  }

  // Question générale → Claude API (avec fallback règles)
  const claudeReply = await _askClaude({ buyerMessage, listingPriceEur, productTitle, variantLabel });
  return { reply: claudeReply, action: "send" };
}

function _extractOffer(text) {
  let m = OFFER_RE.exec(text);
  if (!m) m = AMOUNT_RE.exec(text);
  if (!m) return null;
  const val = parseFloat(m[1].replace(",", "."));
  return isNaN(val) || val <= 0 ? null : val;
}

async function _askClaude({ buyerMessage, listingPriceEur, productTitle, variantLabel }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || process.env.NODE_ENV === "test") {
    return _fallbackReply(buyerMessage, listingPriceEur);
  }

  try {
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic.default({ apiKey });

    const systemPrompt = [
      "Tu es l'assistant automatique d'un vendeur particulier sur Leboncoin.",
      `Article : ${productTitle} — ${variantLabel} à ${listingPriceEur.toFixed(2)} €.`,
      "Règle absolue : propose TOUJOURS uniquement la livraison, JAMAIS le retrait en main propre.",
      "Ne refuse jamais une vente — si le prix pose problème, propose une contre-offre polie.",
      "Réponds en français, de façon chaleureuse et concise (max 3 phrases).",
      "Ne fais jamais de promesse sur les délais exacts, garanties ou remboursements.",
      "Si la question dépasse tes capacités, dis que le vendeur revient rapidement.",
    ].join(" ");

    const response = await client.messages.create({
      model: process.env.CLAUDE_MODEL ?? "claude-haiku-5-5",
      max_tokens: 200,
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
    return `Oui, l'article est toujours disponible à ${listingPriceEur.toFixed(2)} €. ${LIVRAISON_NOTE}`;
  }
  if (lower.includes("livrai") || lower.includes("envoi") || lower.includes("expéd")) {
    return `${LIVRAISON_NOTE} Le montant est indiqué dans l'annonce.`;
  }
  if (lower.includes("état") || lower.includes("condition") || lower.includes("neuf")) {
    return "L'article est en excellent état, conforme aux photos. Envoi soigné.";
  }
  if (lower.includes("délai") || lower.includes("quand") || lower.includes("combien de temps")) {
    return `Expédition sous 48h après confirmation. ${LIVRAISON_NOTE}`;
  }
  if (lower.includes("garantie")) {
    return "Pas de garantie constructeur sur cet article, vendu entre particuliers.";
  }

  return `Bonjour, merci pour votre message ! ${LIVRAISON_NOTE} Le vendeur vous répond rapidement.`;
}

module.exports = { generateReply };
