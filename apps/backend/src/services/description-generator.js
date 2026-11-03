/**
 * Claude A — Description generator using Claude API.
 * Produces optimised Leboncoin title + description from product specs.
 */
const Anthropic = require("@anthropic-ai/sdk");

let _client;
function getClient() {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY manquant");
    _client = new Anthropic.default({ apiKey });
  }
  return _client;
}

/**
 * Generate optimised title + description for Leboncoin.
 * @param {{ title, specs, variants, warehouseStatus }} product
 * @param {string} variantLabel — selected variant label
 * @returns {{ listingTitle: string, listingDescription: string }}
 */
async function generateDescription(product, variantLabel) {
  // In test mode, return fixture without API call
  if (process.env.NODE_ENV === "test" || !process.env.ANTHROPIC_API_KEY) {
    return generateDescriptionSync(product, variantLabel);
  }

  const specsText = formatSpecsForPrompt(product.specs ?? {});
  // Format appris depuis annonces Leboncoin réelles :
  // - Titre naturel sans tiret ni majuscules excessives (ex: "Table d'appoint ronde deux plateaux bois blanc neuf")
  // - Description commence par "Bonjour, je vends..." — ton naturel et conversationnel
  // - Infos clés structurées : Matière, Couleur, Dimensions, État
  const prompt = `Tu es un vendeur particulier sur Leboncoin France. Génère un titre et une description naturels.

Produit : ${product.title}
Variante : ${variantLabel}
Specs techniques : ${specsText}
État : Neuf sous emballage
Livraison : Colissimo suivi (entrepôt ${product.warehouseStatus === "local" ? "Europe" : "Asie"})

Règles strictes :
- Titre : max 70 caractères, style naturel comme "Perceuse sans fil 18V pack batterie neuf" (pas de majuscules inutiles, pas de tiret)
- Description : 400-500 caractères, commencer par "Bonjour, je vends..."
  * Décrire le produit naturellement (2-3 phrases)
  * Mentionner : ${Object.entries(product.specs ?? {}).slice(0, 3).map(([k,v]) => `${k}: ${v}`).join(", ") || "les specs principales"}
  * "Article neuf, jamais utilisé."
  * "Expédition Colissimo suivi sous 48h."
  * Finir par : "Prix ferme."
- Ton : naturel, honnête, comme un vrai particulier
- Aucune faute

Réponds en JSON : {"title": "...", "description": "..."}`;

  const client = getClient();
  const msg = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
  });

  const text = msg.content[0]?.text ?? "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Réponse Claude invalide");

  const parsed = JSON.parse(jsonMatch[0]);
  return {
    listingTitle: (parsed.title ?? "").slice(0, 70),
    listingDescription: parsed.description ?? "",
  };
}

/** Synchronous fallback (test / no API key) */
function generateDescriptionSync(product, variantLabel) {
  const specs = product.specs ?? {};
  const specParts = [];
  if (specs.battery) specParts.push(specs.battery);
  if (specs.dimensions) specParts.push(specs.dimensions);
  if (specs.weight) specParts.push(specs.weight);

  const title = `${product.title}${variantLabel ? ` — ${variantLabel}` : ""} — Neuf`.slice(0, 70);

  // Style Leboncoin réel : ton naturel et conversationnel
  const specLine = specParts.length ? `${specParts.join(", ")}.` : "";
  const description = [
    `Bonjour, je vends ${product.title.toLowerCase()}${variantLabel ? ` (${variantLabel})` : ""}.`,
    "",
    specLine,
    `Article neuf, jamais utilisé, encore sous emballage d'origine.`,
    `Expédition Colissimo suivi sous 48h depuis entrepôt ${product.warehouseStatus === "local" ? "Europe" : "Asie"}.`,
    "",
    `Prix ferme.`,
  ].filter(Boolean).join("\n").slice(0, 600);

  return { listingTitle: title, listingDescription: description };
}

function formatSpecsForPrompt(specs) {
  return Object.entries(specs)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ") || "non renseignées";
}

module.exports = { generateDescription, generateDescriptionSync };
