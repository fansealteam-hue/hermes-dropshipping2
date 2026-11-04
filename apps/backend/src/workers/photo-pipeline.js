"use strict";
const fs   = require("fs");
const path = require("path");
const sharp = require("sharp");

const DATA_DIR   = process.env.DATA_DIR ?? path.join(__dirname, "../../../../data");
const TIMEOUT_MS = 20_000;

/**
 * Télécharge jusqu'à 3 images, les traite (800×800 max, JPEG q85, sans metadata)
 * et les enregistre dans data/photos/<temuItemId>/01.jpg … 03.jpg.
 * Idempotent : saute les fichiers déjà présents.
 */
async function downloadProductPhotos(temuItemId, imageUrls) {
  if (!temuItemId || !Array.isArray(imageUrls) || imageUrls.length === 0) {
    return { ok: false, error: "temuItemId et imageUrls requis" };
  }

  const outDir = path.join(DATA_DIR, "photos", temuItemId);
  fs.mkdirSync(outDir, { recursive: true });

  const urls   = imageUrls.slice(0, 3);
  const paths  = [];
  const errors = [];

  for (let i = 0; i < urls.length; i++) {
    const filename = `0${i + 1}.jpg`;
    const outPath  = path.join(outDir, filename);

    if (fs.existsSync(outPath)) {
      paths.push(outPath);
      continue;
    }

    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(urls[i], { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} sur ${urls[i]}`);

      const buffer = Buffer.from(await res.arrayBuffer());
      await sharp(buffer)
        .resize(800, 800, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .withMetadata(false)
        .toFile(outPath);

      paths.push(outPath);
    } catch (e) {
      const msg = e.name === "AbortError" ? `Timeout image ${i + 1}` : e.message;
      errors.push(msg);
      console.error(`[photo-pipeline] ${temuItemId} img${i + 1}: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }

  if (paths.length === 0) return { ok: false, error: errors.join("; ") };
  return { ok: true, paths, errors: errors.length ? errors : undefined };
}

/**
 * Génère un titre (≤300 chars) et une description SEO (≤2000 chars)
 * pour LBC/Vinted à partir des données produit et variante.
 */
function generateSeoDescription(product, variant) {
  const title = [
    product.title,
    variant?.label ? `— ${variant.label}` : "",
  ].filter(Boolean).join(" ").slice(0, 300);

  const price = variant?.costEur != null
    ? `Prix : ${variant.costEur.toFixed(2)} €`
    : "";

  const description = [
    `📦 ${product.title}`,
    variant?.label ? `Variante : ${variant.label}` : "",
    "",
    price,
    "",
    "✅ Article neuf, expédition rapide.",
    "🚚 Livraison disponible (Mondial Relay, Colissimo).",
    "💬 N'hésitez pas à poser vos questions.",
    "",
    product.title.toLowerCase().split(" ").slice(0, 8).join(" "),
  ].filter(l => l !== undefined).join("\n").slice(0, 2000);

  return { title, description };
}

module.exports = { downloadProductPhotos, generateSeoDescription };
