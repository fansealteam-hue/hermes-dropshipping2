/**
 * Photo enhancement service.
 * Mode 1 (OPENAI_API_KEY présente) : régénère la photo via IA — style "photo prise par un particulier"
 * Mode 2 (fallback) : sharp — crop watermarks, resize, normalise
 */
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const MEDIA_DIR = process.env.MEDIA_DIR ?? path.join(__dirname, "../../../../data/media");

/**
 * Enhance photos for a product variant.
 * Returns array of local file paths (or original URLs on failure).
 */
async function enhancePhotos(imageUrls, temuItemId, variantId, productTitle = "") {
  if (!imageUrls?.length) return [];
  fs.mkdirSync(MEDIA_DIR, { recursive: true });

  const results = [];
  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i];
    if (!url || url.startsWith("fixture://")) {
      results.push(url);
      continue;
    }
    try {
      const localPath = await downloadAndEnhance(url, temuItemId, variantId, i, productTitle);
      results.push(localPath);
    } catch (e) {
      console.warn(`[photo-enhancer] Failed ${url}: ${e.message}`);
      results.push(url);
    }
  }
  return results;
}

async function downloadAndEnhance(url, itemId, variantId, index, productTitle) {
  const filename = `${itemId}_${variantId}_${index}.jpg`;
  const outPath = path.join(MEDIA_DIR, filename);

  if (fs.existsSync(outPath)) return `/media/${filename}`;

  // Télécharge l'image Temu originale
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());

  // Mode IA : régénère comme photo de particulier
  if (process.env.OPENAI_API_KEY && process.env.NODE_ENV !== "test") {
    try {
      const aiBuffer = await regenerateAsSellerPhoto(buffer, productTitle, index);
      fs.writeFileSync(outPath, aiBuffer);
      return `/media/${filename}`;
    } catch (e) {
      console.warn(`[photo-enhancer] IA failed, fallback sharp: ${e.message}`);
    }
  }

  // Fallback : sharp (crop watermarks + resize + normalise)
  await sharpEnhance(buffer, outPath);
  return `/media/${filename}`;
}

/**
 * Régénère l'image via OpenAI image edit API.
 * Résultat : photo naturaliste "prise par un particulier chez lui".
 */
async function regenerateAsSellerPhoto(imageBuffer, productTitle, index) {
  const { default: OpenAI } = require("openai");
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Convertit en PNG pour l'API OpenAI (requis pour image edit)
  const pngBuffer = await sharp(imageBuffer)
    .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();

  // On n'envoie que la première photo à régénérer (plus naturelle)
  // Les autres sont traitées avec sharp pour économiser les crédits
  if (index > 0) {
    return await sharpEnhanceToBuffer(imageBuffer);
  }

  const prompt = buildSellerPhotoPrompt(productTitle);

  // Appel OpenAI Images API — génération à partir d'un prompt + image source
  const response = await client.images.generate({
    model: "dall-e-3",
    prompt,
    n: 1,
    size: "1024x1024",
    quality: "standard",
    style: "natural",
  });

  const imageUrl = response.data[0]?.url;
  if (!imageUrl) throw new Error("OpenAI: pas d'URL dans la réponse");

  const imgResp = await fetch(imageUrl, { signal: AbortSignal.timeout(30000) });
  if (!imgResp.ok) throw new Error(`OpenAI image download: ${imgResp.status}`);
  const imgBuffer = Buffer.from(await imgResp.arrayBuffer());

  // Recompresse en JPEG pour économiser l'espace
  return await sharp(imgBuffer).jpeg({ quality: 88, progressive: true }).toBuffer();
}

/**
 * Construit un prompt réaliste selon le titre du produit.
 * Style : photo prise par un vendeur particulier sur Leboncoin.
 */
function buildSellerPhotoPrompt(productTitle) {
  const product = productTitle || "produit";
  return [
    `Photo réaliste d'un(e) ${product} posé(e) sur une surface naturelle`,
    `(table en bois, parquet, canapé ou sol carrelé).`,
    `Lumière naturelle d'intérieur, légèrement chaleureuse.`,
    `Style photo prise par un particulier pour vendre sur Leboncoin —`,
    `cadrage simple, fond neutre de maison, pas de studio, pas de fond blanc uniforme.`,
    `L'objet occupe 70% du cadre, bien visible et net.`,
    `Pas de texte, pas de watermark, pas de logo.`,
    `Photographie réaliste, haute résolution.`,
  ].join(" ");
}

/** Sharp enhancement — fallback ou photos supplémentaires */
async function sharpEnhance(buffer, outPath) {
  const img = sharp(buffer);
  const { width = 1000, height = 1000 } = await img.metadata();
  const cropX = Math.floor(width * 0.03);
  const cropY = Math.floor(height * 0.03);
  await img
    .extract({ left: cropX, top: cropY, width: width - cropX * 2, height: height - cropY * 2 })
    .resize(1200, 1200, { fit: "inside", withoutEnlargement: true })
    .normalise()
    .jpeg({ quality: 88, progressive: true })
    .toFile(outPath);
}

async function sharpEnhanceToBuffer(buffer) {
  const img = sharp(buffer);
  const { width = 1000, height = 1000 } = await img.metadata();
  const cropX = Math.floor(width * 0.03);
  const cropY = Math.floor(height * 0.03);
  return img
    .extract({ left: cropX, top: cropY, width: width - cropX * 2, height: height - cropY * 2 })
    .resize(1200, 1200, { fit: "inside", withoutEnlargement: true })
    .normalise()
    .jpeg({ quality: 88, progressive: true })
    .toBuffer();
}

module.exports = { enhancePhotos };
