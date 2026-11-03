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

  // Mode IA (première image seulement) : génère 3 angles, sauvegarde tous
  if (process.env.OPENAI_API_KEY && process.env.NODE_ENV !== "test" && index === 0) {
    try {
      const aiBuffers = await regenerateAsSellerPhotos(buffer, productTitle);
      // Sauvegarde les 3 angles : _0.jpg, _ai1.jpg, _ai2.jpg
      fs.writeFileSync(outPath, aiBuffers[0]);
      const suffixes = ["ai1", "ai2"];
      for (let i = 0; i < suffixes.length; i++) {
        const extraPath = path.join(MEDIA_DIR, `${itemId}_${variantId}_${suffixes[i]}.jpg`);
        fs.writeFileSync(extraPath, aiBuffers[i + 1]);
      }
      return `/media/${filename}`;
    } catch (e) {
      console.warn(`[photo-enhancer] IA failed, fallback sharp: ${e.message}`);
    }
  }

  // Fallback : sharp (crop watermarks + resize + normalise)
  await sharpEnhance(buffer, outPath);
  return `/media/${filename}`;
}

// 3 prises de vue style "vrai vendeur particulier"
const ANGLES = [
  {
    label: "vue principale",
    hint: [
      "photo de face, posé sur une table en bois dans un salon.",
      "Une main du vendeur tient légèrement l'objet sur le côté.",
      "Fond légèrement flou avec des éléments de maison (canapé, étagère).",
      "Lumière de fenêtre naturelle, légère ombre portée.",
      "Style selfie de vente — naturel, spontané, pas mis en scène.",
    ].join(" "),
  },
  {
    label: "vue de côté en contexte",
    hint: [
      "Photo depuis un angle de trois-quarts.",
      "Produit posé sur un sol carrelé ou parquet, comme si quelqu'un venait de le sortir.",
      "On voit un peu l'environnement autour — pas tout propre et rangé.",
      "Lumière d'intérieur réaliste.",
    ].join(" "),
  },
  {
    label: "vue de détail rapprochée",
    hint: [
      "Zoom sur la partie principale ou le détail clé du produit.",
      "Tenu dans une main, gros plan, légèrement de biais.",
      "Flou de fond, mise au point nette sur le détail.",
      "Comme une photo de téléphone prise rapidement pour montrer l'état.",
    ].join(" "),
  },
];

/**
 * Régénère 3 photos via gpt-image-1 (OpenAI omni) —
 * même fond naturel, 3 angles différents.
 * Retourne un tableau de 3 Buffers JPEG.
 */
async function regenerateAsSellerPhotos(imageBuffer, productTitle) {
  const { default: OpenAI } = require("openai");
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const product = productTitle || "produit";

  // Lance les 3 générations en parallèle
  const generations = await Promise.all(
    ANGLES.map(({ label, hint }) => {
      const prompt = [
        `Photo réaliste prise au smartphone d'un(e) ${product}.`,
        hint,
        `Style annonce Leboncoin — vendeur particulier, ambiance vraie maison française.`,
        `Pas de fond blanc, pas de studio, pas de mise en scène parfaite.`,
        `Légères imperfections naturelles (angle pas parfait, lumière un peu chaude).`,
        `Pas de texte, watermark ou logo. Photo nette et lisible malgré le style naturel.`,
      ].join(" ");

      return client.images.generate({
        model: "gpt-image-1",
        prompt,
        n: 1,
        size: "1024x1024",
        quality: "medium",
      });
    })
  );

  // Récupère et recompresse chaque image
  const buffers = await Promise.all(
    generations.map(async (resp) => {
      // gpt-image-1 retourne b64_json ou url selon la config
      const item = resp.data[0];
      let rawBuffer;
      if (item.b64_json) {
        rawBuffer = Buffer.from(item.b64_json, "base64");
      } else {
        const r = await fetch(item.url, { signal: AbortSignal.timeout(30000) });
        if (!r.ok) throw new Error(`download failed: ${r.status}`);
        rawBuffer = Buffer.from(await r.arrayBuffer());
      }
      return sharp(rawBuffer).jpeg({ quality: 88, progressive: true }).toBuffer();
    })
  );

  return buffers; // [frontBuffer, threeQuarterBuffer, detailBuffer]
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
