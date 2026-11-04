"use strict";
/**
 * Auto-répondeur — ton humain, chaleureux, comme un ami qui vend.
 *
 * Règles absolues :
 *   1. Jamais de refus sec — toujours une porte ouverte
 *   2. Uniquement la livraison (jamais retrait — article non stocké)
 *   3. Litige détecté → escalade opérateur
 *   4. Ton naturel, pas corporatif
 */

const { evaluateOffer, buildReply } = require("./negotiation");

// Mots-clés offre de prix
const OFFER_RE  = /(?:je (?:propose|offre|mets|donne)|offre|pour)\s*[:=]?\s*(\d+(?:[.,]\d+)?)\s*(?:€|euros?)?/i;
const AMOUNT_RE = /(\d+(?:[.,]\d+)?)\s*(?:€|euros?)/i;

// Retrait / rencontre → rediriger livraison
const RETRAIT_RE = /\b(retrait|récupér|passe[rz]?|venir|chercher|rencontr|en mains? propres?|sur place|rendez.vous|rdv)\b/i;

// Litige → escalade
const LITIGE_RE = /\b(litige|arnaque|escroc|remboursement|plainte|signalement|paypal|fraude)\b/i;

// Variantes aléatoires pour paraître naturel
function _pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

const SALUTATIONS = ["Bonjour !", "Salut !", "Bonjour 😊", "Coucou !"];
const MERCI       = ["Merci pour votre message !", "Merci de votre intérêt !", "Merci pour votre retour !"];
const DISPO_OUI   = ["Oui oui, toujours dispo !", "Yep, encore disponible !", "Oui, c'est toujours là !"];
const CONCLU      = ["N'hésitez pas si vous avez d'autres questions 😊", "Je suis dispo si vous voulez en savoir plus !", "On peut se faire ça facilement !"];

const NOTE_LIVRAISON = "Je fais uniquement en livraison (je n'ai pas la possibilité de faire du retrait).";

async function generateReply({
  buyerMessage,
  listingPriceEur,
  productTitle,
  variantLabel,
  listingStatus = "active",
}) {
  if (listingStatus === "sold" || listingStatus === "closed") {
    return {
      reply: _pick([
        "Ah dommage, il vient juste d'être vendu ! Jetez un œil à mes autres annonces, j'ai peut-être quelque chose qui vous plaira 😊",
        "Oh nooon, il part d'être vendu ! Désolé, regardez mes autres annonces 🙂",
        "Malheureusement vendu il y a peu ! N'hésitez pas à voir mes autres annonces.",
      ]),
      action: "send",
      reason: "listing_sold",
    };
  }

  const lower = buyerMessage.toLowerCase();

  if (LITIGE_RE.test(lower)) {
    return { reply: "", action: "escalate", reason: "litige_detected" };
  }

  if (RETRAIT_RE.test(lower)) {
    return {
      reply: [
        _pick(SALUTATIONS),
        _pick(MERCI),
        NOTE_LIVRAISON,
        "L'envoi se passe très bien, je prépare le colis soigneusement 📦",
        _pick(CONCLU),
      ].join(" "),
      action: "send",
      reason: "retrait_redirected",
    };
  }

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
    } catch (_) {}
  }

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
      "Tu es un vendeur particulier sympathique sur Leboncoin, tu réponds comme un ami normal, pas comme un robot ni une entreprise.",
      `Tu vends : ${productTitle} — ${variantLabel} à ${listingPriceEur.toFixed(2)} €.`,
      "RÈGLE : tu fais UNIQUEMENT la livraison, jamais de retrait en main propre. Mentionne-le naturellement si c'est pertinent.",
      "RÈGLE : ne refuse jamais une vente — si le prix pose problème, propose une contre-offre sympa.",
      "Réponds en français naturel et chaleureux, max 2-3 phrases courtes.",
      "Pas de formules corporatives. Pas de 'Cordialement'. Tu peux mettre un emoji si ça semble naturel.",
      "Ne promets jamais de délais précis ni de garanties.",
    ].join(" ");

    const response = await client.messages.create({
      model: process.env.CLAUDE_MODEL ?? "claude-haiku-5-5",
      max_tokens: 180,
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

  if (lower.includes("disponible") || lower.includes("encore") || lower.includes("toujours")) {
    return [
      _pick(DISPO_OUI),
      `C'est à ${listingPriceEur.toFixed(2)} €.`,
      NOTE_LIVRAISON,
      _pick(CONCLU),
    ].join(" ");
  }

  if (lower.includes("livrai") || lower.includes("envoi") || lower.includes("expéd") || lower.includes("coliss") || lower.includes("mondial")) {
    return [
      _pick(SALUTATIONS),
      NOTE_LIVRAISON,
      "Je prépare le colis avec soin, le montant de la livraison est indiqué dans l'annonce 📦",
    ].join(" ");
  }

  if (lower.includes("état") || lower.includes("condition") || lower.includes("neuf") || lower.includes("occasion")) {
    return [
      _pick(SALUTATIONS),
      "C'est en très bon état, conforme aux photos !",
      "Je peux vous envoyer d'autres photos si vous voulez 😊",
    ].join(" ");
  }

  if (lower.includes("délai") || lower.includes("quand") || lower.includes("combien de temps") || lower.includes("vite")) {
    return [
      _pick(SALUTATIONS),
      "J'expédie rapidement après paiement, en général sous 24-48h.",
      NOTE_LIVRAISON,
    ].join(" ");
  }

  if (lower.includes("garantie")) {
    return "Pas de garantie constructeur, c'est une vente entre particuliers — mais l'article est en bon état 🙂";
  }

  if (lower.includes("photo") || lower.includes("image") || lower.includes("voir")) {
    return "Je peux vous envoyer d'autres photos si vous voulez, dites-moi ! 😊";
  }

  return [
    _pick(SALUTATIONS),
    _pick(MERCI),
    NOTE_LIVRAISON,
    _pick(CONCLU),
  ].join(" ");
}

module.exports = { generateReply };
