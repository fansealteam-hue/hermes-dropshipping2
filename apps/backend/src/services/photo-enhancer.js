/**
 * Claude A — Photo enhancement service.
 * Downloads Temu images, removes watermarks, crops cleanly, saves to data/media/.
 */
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const MEDIA_DIR = process.env.MEDIA_DIR ?? path.join(__dirname, "../../../../data/media");

/**
 * Download + enhance images for a product variant.
 * Returns array of local file paths.
 */
async function enhancePhotos(imageUrls, temuItemId, variantId) {
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
      const localPath = await downloadAndEnhance(url, temuItemId, variantId, i);
      results.push(localPath);
    } catch (e) {
      console.warn(`[photo-enhancer] Failed ${url}: ${e.message}`);
      results.push(url); // fallback to original URL
    }
  }
  return results;
}

async function downloadAndEnhance(url, itemId, variantId, index) {
  const ext = "jpg";
  const filename = `${itemId}_${variantId}_${index}.${ext}`;
  const outPath = path.join(MEDIA_DIR, filename);

  // Skip if already processed
  if (fs.existsSync(outPath)) return `/media/${filename}`;

  // Download
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());

  // Enhance with sharp:
  // 1. Resize to max 1200px maintaining aspect ratio
  // 2. Crop a 5% border to remove typical Temu watermark zones
  // 3. Normalize colors for clean look
  // 4. Convert to JPEG
  const img = sharp(buffer);
  const meta = await img.metadata();
  const { width = 1000, height = 1000 } = meta;

  // Crop 3% from each side to remove watermarks
  const cropX = Math.floor(width * 0.03);
  const cropY = Math.floor(height * 0.03);
  const cropW = width - cropX * 2;
  const cropH = height - cropY * 2;

  await img
    .extract({ left: cropX, top: cropY, width: cropW, height: cropH })
    .resize(1200, 1200, { fit: "inside", withoutEnlargement: true })
    .normalise()
    .jpeg({ quality: 88, progressive: true })
    .toFile(outPath);

  return `/media/${filename}`;
}

module.exports = { enhancePhotos };
