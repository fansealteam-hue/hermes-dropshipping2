/**
 * Media service — downloads and stores product images.
 * Claude 2 calls prepareMedia() before creating a listing.
 */
const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");

const MEDIA_DIR = process.env.MEDIA_DIR ?? path.join(__dirname, "../../../data/media");

function ensureDir() {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

/**
 * Download images from Temu CDN and return local paths + public URLs.
 * In prod these are served by nginx; in dev they're returned as file:// paths.
 */
async function prepareMedia(imageUrls, temuItemId, variantId) {
  ensureDir();
  const results = [];

  for (let i = 0; i < Math.min(imageUrls.length, 8); i++) {
    const url = imageUrls[i];
    if (!url || url.startsWith("https://img.temu.com/drill/")) {
      // Test fixture URL — skip download
      results.push(url);
      continue;
    }

    try {
      const hash = createHash("sha1").update(url).digest("hex").slice(0, 12);
      const ext = url.includes(".webp") ? "webp" : "jpg";
      const filename = `${temuItemId}_${variantId}_${i}_${hash}.${ext}`;
      const localPath = path.join(MEDIA_DIR, filename);

      if (!fs.existsSync(localPath)) {
        const resp = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible)" },
          signal: AbortSignal.timeout(10000),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buffer = Buffer.from(await resp.arrayBuffer());
        fs.writeFileSync(localPath, buffer);
      }

      const publicUrl = `/media/${filename}`;
      results.push(publicUrl);
    } catch (e) {
      console.warn(`[media] Failed to download ${url}: ${e.message}`);
      results.push(url); // keep original URL as fallback
    }
  }

  return results;
}

module.exports = { prepareMedia };
