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
  const prompt = `Tu es un expert en vente sur Leboncoin France. Génère un titre et une description optimisés pour cette annonce.

Produit : ${product.title}
Variante : ${variantLabel}
Specs : ${specsText}
État : Neuf sous emballage (expédié depuis entrepôt ${product.warehouseStatus === "local" ? "Europe" : "Chine"})

Règles :
- Titre : max 70 caractères, format "[Produit] [spec principale] — Neuf"
- Description : 400-600 caractères
  * Accroche percutante (1 ligne)
  * Specs clés : ${Object.keys(product.specs ?? {}).slice(0, 4).join(", ") || "taille, poids, couleur"}
  * État et livraison (Colissimo suivi ou Mondial Relay)
  * Finir par : "Prix ferme. Sérieux uniquement."
- Aucune faute d'orthographe
- Ton : direct, honnête, professionnel

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

  const description = [
    `✅ ${product.title} — NEUF sous emballage`,
    "",
    `📦 Variante : ${variantLabel}`,
    specParts.length ? `🔧 Caractéristiques : ${specParts.join(" | ")}` : "",
    `🏭 Stock : entrepôt ${product.warehouseStatus === "local" ? "Europe (livraison rapide)" : "Asie"}`,
    "",
    `🚚 Expédition Colissimo suivi sous 48h`,
    `💰 Prix ferme. Sérieux uniquement.`,
  ].filter(Boolean).join("\n").slice(0, 600);

  return { listingTitle: title, listingDescription: description };
}

function formatSpecsForPrompt(specs) {
  return Object.entries(specs)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ") || "non renseignées";
}

module.exports = { generateDescription, generateDescriptionSync };
