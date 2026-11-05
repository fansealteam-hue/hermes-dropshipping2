/**
 * Job handlers — Claude 3 (publish/tracking) and Claude 4 (alert).
 */
const path = require("path");
const queue = require("./queue");
const { getSale } = require("../services/sales");
const { updateListingStatus } = require("../services/listings");
const db = require("../db/db");

const SESSIONS_DIR = process.env.SESSIONS_DIR
  ?? path.join(__dirname, "../../../data/sessions");

// --- Leboncoin connector (Claude 3) ------------------------------------------

/**
 * Simulate or execute a Leboncoin listing publication.
 *
 * In test/dev (NODE_ENV=test or credentials_ref starts with "mock_"):
 *   returns a synthetic leboncoin_ad_id without network calls.
 *
 * In production: Playwright browser automation against Leboncoin.
 *
 * Delivery option is NEVER substituted automatically. If the requested
 * option is absent, the job fails with DELIVERY_OPTION_UNAVAILABLE so the
 * operator decides.
 */
async function handlePublishListing({ listingId }, job) {
  const listing = db.prepare("SELECT * FROM listings WHERE listing_id = ?").get(listingId);
  if (!listing) throw Object.assign(new Error(`Listing ${listingId} introuvable`), { code: "NOT_FOUND" });

  const account = db.prepare("SELECT * FROM seller_accounts WHERE account_id = ?").get(listing.account_id);
  if (!account) throw Object.assign(new Error(`Compte ${listing.account_id} introuvable`), { code: "ACCOUNT_NOT_FOUND" });

  const isMock = process.env.NODE_ENV === "test" || (account.credentials_ref ?? "").startsWith("mock_");

  if (isMock) {
    const fakeAdId = `lbc_${listing.listing_id.replace("lst_", "").slice(0, 12)}`;
    await updateListingStatus(listingId, "published", {
      leboncoinAdId: fakeAdId,
      publishedAt: new Date().toISOString(),
    });
    return { listingId, leboncoinAdId: fakeAdId, status: "published" };
  }

  // Production: Playwright browser automation
  let browser;
  try {
    const { chromium } = require("playwright");
    const fs = require("fs");

    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
      headless: true,
    });

    const sessionPath = `${SESSIONS_DIR}/${account.account_id}.json`;
    const storageState = fs.existsSync(sessionPath) ? JSON.parse(fs.readFileSync(sessionPath, "utf8")) : undefined;
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();

    await page.goto("https://www.leboncoin.fr/deposer-une-annonce", { waitUntil: "domcontentloaded" });

    const currentUrl = page.url();
    if (currentUrl.includes("login") || currentUrl.includes("connexion")) {
      await _pauseAccount(account.account_id, "session_expired");
      await browser.close();
      browser = null;
      return await _rotateAccount(listingId, listing.account_id, "SESSION_EXPIRED");
    }
    if (await page.$('[data-testid="captcha"]').catch(() => null)) {
      await _pauseAccount(account.account_id, "captcha");
      await browser.close();
      browser = null;
      return await _rotateAccount(listingId, listing.account_id, "CAPTCHA");
    }

    await page.fill('[data-testid="subject"]', listing.title);
    await page.fill('[data-testid="body"]', listing.description);
    await page.fill('[data-testid="price"]', String(listing.price_eur_cents / 100));

    // Delivery option: verify present before selecting — NEVER auto-substitute
    const deliveryOption = listing.delivery_option;
    if (deliveryOption) {
      const optionEl = await page.$(`[data-testid="delivery-option"][data-value="${deliveryOption}"]`).catch(() => null);
      if (!optionEl) {
        await updateListingStatus(listingId, "failed", {});
        throw Object.assign(
          new Error(`Option livraison indisponible: ${deliveryOption} — decision operateur requise`),
          { code: "DELIVERY_OPTION_UNAVAILABLE" }
        );
      }
      await optionEl.click();
    }

    await page.click('[data-testid="submit-listing"]');
    await page.waitForURL(/\/annonces\/\d+/, { timeout: 15_000 }).catch(() => null);

    const adUrl = page.url();
    const adIdMatch = adUrl.match(/\/annonces\/(\d+)/);
    if (!adIdMatch) {
      await updateListingStatus(listingId, "uncertain", {});
      throw Object.assign(new Error("Publication soumise mais confirmation non lisible"), { code: "UNCERTAIN" });
    }

    const leboncoinAdId = adIdMatch[1];
    const newState = await context.storageState();
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(sessionPath, JSON.stringify(newState));

    await updateListingStatus(listingId, "published", {
      leboncoinAdId,
      publishedAt: new Date().toISOString(),
    });
    return { listingId, leboncoinAdId, status: "published" };
  } finally {
    await browser?.close();
  }
}

async function _pauseAccount(accountId, reason) {
  queue.pauseAccount(accountId);
  db.prepare("UPDATE seller_accounts SET active = 0 WHERE account_id = ?").run(accountId);
  console.warn(`[lbc] Compte ${accountId} pause : ${reason}`);
}

/**
 * Rotation de compte : quand un compte est bloqué (SESSION_EXPIRED / CAPTCHA),
 * tente de re-publier sur un autre compte actif.
 * Si aucun compte disponible → archive le listing.
 */
async function _rotateAccount(listingId, failedAccountId, reason) {
  const { archiveListing } = require("../services/repricing");
  const { randomUUID } = require("crypto");

  const fallback = db.prepare(
    "SELECT * FROM seller_accounts WHERE channel = 'leboncoin' AND active = 1 AND account_id != ? LIMIT 1"
  ).get(failedAccountId);

  if (!fallback) {
    archiveListing(listingId);
    console.warn(`[lbc] Aucun compte de remplacement disponible — ${listingId} archivé (${reason})`);
    return { listingId, status: "archived", reason };
  }

  // Réassigner le listing au compte de remplacement
  db.prepare("UPDATE listings SET account_id = ?, updated_at = ? WHERE listing_id = ?")
    .run(fallback.account_id, new Date().toISOString(), listingId);

  // Re-enqueue la publication sur le nouveau compte
  const jobId = `job_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  db.prepare(
    "INSERT OR IGNORE INTO jobs (job_id, operation, payload, status, account_id, idempotency_key, run_at, created_at) VALUES (?,?,?,?,?,?,datetime('now'),datetime('now'))"
  ).run(jobId, "publish_listing", JSON.stringify({ listingId }), "pending", fallback.account_id, `rotate:${listingId}:${fallback.account_id}`);

  console.warn(`[lbc] ${listingId} rotaté de ${failedAccountId} → ${fallback.account_id} (${reason})`);
  return { listingId, rotatedTo: fallback.account_id, status: "requeued" };
}

/**
 * Sync tracking number to Leboncoin conversation.
 *
 * In test/mock mode: marks leboncoin_delivery_confirmed=1 directly.
 * In production: opens the sale conversation and posts the tracking number.
 */
async function handleSyncTracking({ saleId, trackingNumber, trackingCarrier }, job) {
  const sale = db.prepare("SELECT * FROM sales WHERE sale_id = ?").get(saleId);
  if (!sale) throw Object.assign(new Error(`Vente ${saleId} introuvable`), { code: "NOT_FOUND" });

  const account = db.prepare("SELECT * FROM seller_accounts WHERE account_id = ?").get(sale.account_id);
  const isMock = process.env.NODE_ENV === "test" || (account?.credentials_ref ?? "").startsWith("mock_");
  const auto = require("../services/automation");
  const msg = auto.messageFor("shipping", saleId, { trackingNumber, trackingCarrier });
  const logSent = () => {
    try { require("../services/conversations").logAutoMessage({ listingId: sale.listing_id, accountId: sale.account_id, buyerName: sale.buyer_name, body: msg, kind: "shipping" }); }
    catch (e) { console.warn("[jobs] journal message:", e.message); }
  };

  if (isMock) {
    db.prepare("UPDATE sales SET leboncoin_delivery_confirmed = 1, manual_action_required = 0, updated_at = ? WHERE sale_id = ?")
      .run(new Date().toISOString(), saleId);
    logSent();
    return { saleId, synced: true, message: msg };
  }

  // Production: post tracking in Leboncoin conversation
  let browser;
  try {
    const { chromium } = require("playwright");
    const fs = require("fs");

    const listing = db.prepare("SELECT * FROM listings WHERE listing_id = ?").get(sale.listing_id);
    if (!listing?.leboncoin_ad_id) {
      db.prepare("UPDATE sales SET manual_action_required = 1, manual_action_note = 'leboncoin_ad_id manquant', updated_at = ? WHERE sale_id = ?")
        .run(new Date().toISOString(), saleId);
      return { saleId, synced: false, manual: true };
    }

    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
      headless: true,
    });

    const sessionPath = `${SESSIONS_DIR}/${sale.account_id}.json`;
    const storageState = fs.existsSync(sessionPath) ? JSON.parse(fs.readFileSync(sessionPath, "utf8")) : undefined;
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();

    await page.goto(`https://www.leboncoin.fr/messagerie/${listing.leboncoin_ad_id}`, { waitUntil: "domcontentloaded" });

    await page.fill('[data-testid="message-input"]', msg);
    await page.click('[data-testid="send-message"]');
    logSent();

    const newState = await context.storageState();
    const sessionDir = SESSIONS_DIR;
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(sessionPath, JSON.stringify(newState));

    db.prepare("UPDATE sales SET leboncoin_delivery_confirmed = 1, manual_action_required = 0, updated_at = ? WHERE sale_id = ?")
      .run(new Date().toISOString(), saleId);

    return { saleId, synced: true };
  } catch (err) {
    db.prepare("UPDATE sales SET manual_action_required = 1, manual_action_note = ?, updated_at = ? WHERE sale_id = ?")
      .run(`sync_tracking failed: ${err.message}`, new Date().toISOString(), saleId);
    throw err;
  } finally {
    await browser?.close();
  }
}

// --- Mark listing sold on LBC + auto-reply "non disponible" (Claude B) --------

/**
 * Quand une vente est confirmée :
 * 1. Marque l'annonce LBC comme vendue (via Playwright)
 * 2. Active l'auto-reply "non disponible" pour les futurs messages
 */
async function handleMarkListingSold({ listingId, saleId }, job) {
  const listing = db.prepare("SELECT * FROM listings WHERE listing_id = ?").get(listingId);
  if (!listing) return;

  const account = db.prepare("SELECT * FROM seller_accounts WHERE account_id = ?").get(listing.account_id);
  const isMock = process.env.NODE_ENV === "test" || (account?.credentials_ref ?? "").startsWith("mock_");

  if (isMock) {
    db.prepare("UPDATE listings SET status = 'sold', updated_at = ? WHERE listing_id = ?")
      .run(new Date().toISOString(), listingId);
    _enqueueRepublishSold(listing);
    return { listingId, marked: true };
  }

  // Production: clôturer l'annonce sur LBC
  let browser;
  try {
    const { chromium } = require("playwright");
    const fs = require("fs");
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium", headless: true });
    const sessionPath = `${SESSIONS_DIR}/${account.account_id}.json`;
    const storageState = fs.existsSync(sessionPath) ? JSON.parse(fs.readFileSync(sessionPath, "utf8")) : undefined;
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();

    // Marquer vendu sur le gestionnaire d'annonces LBC
    if (listing.leboncoin_ad_id) {
      await page.goto(`https://www.leboncoin.fr/mes-annonces/${listing.leboncoin_ad_id}`, { waitUntil: "domcontentloaded" });
      const markSoldBtn = await page.$('[data-testid="mark-as-sold"]').catch(() => null);
      if (markSoldBtn) await markSoldBtn.click();
    }

    db.prepare("UPDATE listings SET status = 'sold', updated_at = ? WHERE listing_id = ?")
      .run(new Date().toISOString(), listingId);

    const newState = await context.storageState();
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(sessionPath, JSON.stringify(newState));

    // Auto-republier avec nouvelles photos
    _enqueueRepublishSold(listing);

    return { listingId, marked: true };
  } finally {
    await browser?.close();
  }
}

/**
 * Envoie alerte Telegram avec boutons VALIDER / ANNULER VENTE
 * puis déclenche paiement fournisseur quand opérateur valide.
 */
async function handleSendAlertWithValidation({ saleId }, job) {
  const sale = getSale(saleId);
  if (!sale) throw new Error(`Sale ${saleId} not found`);
  try {
    // Envoi direct via l'API Telegram (le bot tourne dans un autre conteneur)
    const { sendSaleAlert } = require("../services/sale-alert");
    if (process.env.NODE_ENV !== "test") await sendSaleAlert(saleId);
    db.prepare("UPDATE sales SET alert_sent = 1 WHERE sale_id = ?").run(saleId);
  } catch (e) {
    console.warn(`[jobs] sendAlert: ${e.message}`);
    // Une vente ne doit jamais passer inaperçue : on réessaie (2, 4, 8 min…)
    // et on ne la signale « à traiter à la main » qu'au dernier essai.
    const last = !job || (job.attempts ?? 0) + 1 >= (job.max_attempts ?? 1);
    if (!last) throw e;
    db.prepare("UPDATE sales SET alert_sent = 1, manual_action_required = 1, manual_action_note = ? WHERE sale_id = ?")
      .run(`Alerte Telegram non envoyée : ${e.message}`, saleId);
  }
}

// ─── Annulation LBC : message acheteur + retrait annonce ──────────────────────

async function handleCancelSaleLbc({ saleId, listingId }, job) {
  const sale = db.prepare("SELECT * FROM sales WHERE sale_id = ?").get(saleId);
  if (!sale) return;

  const listing = listingId ? db.prepare("SELECT * FROM listings WHERE listing_id = ?").get(listingId) : null;
  const account = listing
    ? db.prepare("SELECT * FROM seller_accounts WHERE account_id = ?").get(listing.account_id)
    : null;
  const isMock = process.env.NODE_ENV === "test" || (account?.credentials_ref ?? "").startsWith("mock_");

  const cancelMsg = require("../services/automation").messageFor("cancel", saleId);
  const logCancel = () => {
    try { require("../services/conversations").logAutoMessage({ listingId: sale.listing_id, accountId: sale.account_id, buyerName: sale.buyer_name, body: cancelMsg, kind: "cancel" }); }
    catch (e) { console.warn("[jobs] journal message:", e.message); }
  };

  if (isMock) {
    if (listing) {
      db.prepare("UPDATE listings SET status = 'cancelled', updated_at = ? WHERE listing_id = ?")
        .run(new Date().toISOString(), listingId);
    }
    logCancel();
    return { saleId, cancelled: true, message: cancelMsg };
  }

  let browser;
  try {
    const { chromium } = require("playwright");
    const fs = require("fs");
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium", headless: true });
    const sessionPath = `${SESSIONS_DIR}/${account.account_id}.json`;
    const storageState = fs.existsSync(sessionPath) ? JSON.parse(fs.readFileSync(sessionPath, "utf8")) : undefined;
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();

    // Envoyer message à l'acheteur dans la conversation LBC
    if (listing?.leboncoin_ad_id) {
      await page.goto(`https://www.leboncoin.fr/messagerie/${listing.leboncoin_ad_id}`, { waitUntil: "domcontentloaded" });
      await page.fill('[data-testid="message-input"]', cancelMsg);
      await page.click('[data-testid="send-message"]');
      logCancel();

      // Supprimer l'annonce
      await page.goto(`https://www.leboncoin.fr/mes-annonces/${listing.leboncoin_ad_id}`, { waitUntil: "domcontentloaded" });
      const deleteBtn = await page.$('[data-testid="delete-listing"], [data-testid="mark-as-sold"]').catch(() => null);
      if (deleteBtn) await deleteBtn.click();
    }

    if (listing) {
      db.prepare("UPDATE listings SET status = 'cancelled', updated_at = ? WHERE listing_id = ?")
        .run(new Date().toISOString(), listingId);
    }

    const newState = await context.storageState();
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(sessionPath, JSON.stringify(newState));
    return { saleId, cancelled: true };
  } finally {
    await browser?.close();
  }
}

// ─── Repricing : baisse de prix + refresh photos/titre semaine 2 ─────────────

async function handleRepriceCheck(_, job) {
  const { getListingsDueForReprice, computeRepriceAction, applyReprice, archiveListing } = require("../services/repricing");
  const listings = getListingsDueForReprice();

  for (const listing of listings) {
    const { action, newPriceEur } = computeRepriceAction(listing);
    const isMock = process.env.NODE_ENV === "test";

    if (action === "archive") {
      archiveListing(listing.listing_id);
      if (!isMock && listing.leboncoin_ad_id) {
        // Enqueue LBC removal
        const { randomUUID } = require("crypto");
        const jobId = `job_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
        db.prepare(
          "INSERT OR IGNORE INTO jobs (job_id, operation, payload, status, account_id, idempotency_key, run_at, created_at) VALUES (?,?,?,?,?,?,datetime('now'),datetime('now'))"
        ).run(jobId, "cancel_sale_lbc", JSON.stringify({ listingId: listing.listing_id }), "pending", listing.account_id, `archive:${listing.listing_id}`);
      }
      console.log(`[reprice] ${listing.listing_id} → archivé (marge insuffisante)`);
      continue;
    }

    // Appliquer la baisse de prix en DB
    applyReprice(listing.listing_id, newPriceEur);

    if (!isMock && listing.leboncoin_ad_id) {
      // Mettre à jour le prix sur LBC via Playwright
      let browser;
      try {
        const { chromium } = require("playwright");
        const account = db.prepare("SELECT * FROM seller_accounts WHERE account_id = ?").get(listing.account_id);
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium", headless: true });
        const sessionPath = `${SESSIONS_DIR}/${listing.account_id}.json`;
        const fs = require("fs");
        const storageState = fs.existsSync(sessionPath) ? JSON.parse(fs.readFileSync(sessionPath, "utf8")) : undefined;
        const context = await browser.newContext({ storageState });
        const page = await context.newPage();
        await page.goto(`https://www.leboncoin.fr/mes-annonces/${listing.leboncoin_ad_id}/modifier`, { waitUntil: "domcontentloaded" });
        const priceInput = await page.$('[data-testid="price"]').catch(() => null);
        if (priceInput) {
          await priceInput.fill(String(newPriceEur));
          await page.click('[data-testid="submit-listing"]').catch(() => null);
        }
        if (account) {
          const newState = await context.storageState();
          fs.mkdirSync(SESSIONS_DIR, { recursive: true });
          fs.writeFileSync(sessionPath, JSON.stringify(newState));
        }
      } catch (e) {
        console.warn(`[reprice] Playwright price update failed for ${listing.listing_id}: ${e.message}`);
      } finally {
        await browser?.close();
      }
    }

    // Semaine 2+ : nouvelles photos + titre/description
    if (action === "reprice_refresh") {
      const { randomUUID } = require("crypto");
      const jobId = `job_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      db.prepare(
        "INSERT OR IGNORE INTO jobs (job_id, operation, payload, status, account_id, idempotency_key, run_at, created_at) VALUES (?,?,?,?,?,?,datetime('now'),datetime('now'))"
      ).run(jobId, "refresh_listing_media", JSON.stringify({ listingId: listing.listing_id }), "pending", listing.account_id, `refresh:${listing.listing_id}:${listing.repricing_count ?? 0}`);
      console.log(`[reprice] ${listing.listing_id} → prix ${newPriceEur}€ + refresh photos enqueué`);
    } else {
      console.log(`[reprice] ${listing.listing_id} → prix ${newPriceEur}€`);
    }
  }

  return { checked: listings.length };
}

async function handleRefreshListingMedia({ listingId }, job) {
  const listing = db.prepare("SELECT * FROM listings WHERE listing_id = ?").get(listingId);
  if (!listing) return;

  const product = db.prepare("SELECT * FROM products WHERE temu_item_id = ?").get(listing.temu_item_id);
  const variant = db.prepare("SELECT * FROM variants WHERE variant_id = ?").get(listing.variant_id);
  if (!product || !variant) return;

  const isMock = process.env.NODE_ENV === "test";
  const now = new Date().toISOString();

  // Nouvelles photos IA
  if (!isMock && process.env.OPENAI_API_KEY) {
    try {
      const { enhancePhotos } = require("../services/photo-enhancer");
      const imageUrls = JSON.parse(variant.image_urls ?? "[]");
      // Forcer la regeneration en supprimant le cache
      const fs = require("fs");
      const path = require("path");
      const MEDIA_DIR = process.env.MEDIA_DIR ?? path.join(__dirname, "../../../data/media");
      const cached = path.join(MEDIA_DIR, `${listing.temu_item_id}_${listing.variant_id}_0.jpg`);
      if (fs.existsSync(cached)) fs.unlinkSync(cached);
      const newPaths = await enhancePhotos(imageUrls, listing.temu_item_id, listing.variant_id, product.title);
      db.prepare("UPDATE listings SET media_urls = ?, updated_at = ? WHERE listing_id = ?")
        .run(JSON.stringify(newPaths), now, listingId);
    } catch (e) {
      console.warn(`[refresh] photo regen failed: ${e.message}`);
    }
  }

  // Nouveau titre + description IA
  if (!isMock && process.env.ANTHROPIC_API_KEY) {
    try {
      const { generateDescription } = require("../services/description-generator");
      const specs = product.specs ? JSON.parse(product.specs) : {};
      const { title, description } = await generateDescription({ ...specs, title: product.title, costEur: listing.cost_eur_cents / 100 });
      db.prepare("UPDATE listings SET title = ?, description = ?, updated_at = ? WHERE listing_id = ?")
        .run(title, description, now, listingId);
    } catch (e) {
      console.warn(`[refresh] description regen failed: ${e.message}`);
    }
  }

  // Republier sur LBC avec nouveau titre/description/photos
  if (!isMock && listing.leboncoin_ad_id) {
    const { randomUUID } = require("crypto");
    const jobId = `job_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    db.prepare(
      "INSERT OR IGNORE INTO jobs (job_id, operation, payload, status, account_id, idempotency_key, run_at, created_at) VALUES (?,?,?,?,?,?,datetime('now'),datetime('now'))"
    ).run(jobId, "publish_listing", JSON.stringify({ listingId }), "pending", listing.account_id, `republish:${listingId}:${now}`);
  }

  return { listingId, refreshed: true };
}

// ─── Auto-republication après vente (nouvelles photos, même produit) ─────────

/**
 * Quand un article est vendu, crée un nouveau listing draft pour le même produit/variante
 * et force la regénération des photos (supprime le cache) pour avoir un nouveau fond.
 * Respecte la limite journalière DAILY_LISTING_MAX.
 */
function _enqueueRepublishSold(soldListing) {
  const DAILY_MAX = parseInt(process.env.DAILY_LISTING_MAX ?? "0"); // 0 = illimité
  if (DAILY_MAX > 0) {
    const { countPublishedToday } = require("../services/repricing");
    if (countPublishedToday() >= DAILY_MAX) {
      console.log(`[republish] Limite journalière atteinte (${DAILY_MAX}) — republication reportée`);
      return;
    }
  }

  const { randomUUID } = require("crypto");
  const jobId = `job_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const key = `republish_sold:${soldListing.listing_id}`;

  // Job de refresh photos d'abord (force regen), puis publish_listing sera enqueué par handleRefreshListingMedia
  db.prepare(
    "INSERT OR IGNORE INTO jobs (job_id, operation, payload, status, account_id, idempotency_key, run_at, created_at) VALUES (?,?,?,?,?,?,datetime('now'),datetime('now'))"
  ).run(
    jobId,
    "republish_sold",
    JSON.stringify({ temuItemId: soldListing.temu_item_id, variantId: soldListing.variant_id, accountId: soldListing.account_id, sourcePriceCents: soldListing.price_eur_cents, deliveryOption: soldListing.delivery_option, deliveryFeeCents: soldListing.delivery_fee_eur_cents ?? 0 }),
    "pending",
    soldListing.account_id,
    key
  );
  console.log(`[republish] Annonce vendue ${soldListing.listing_id} → republication programmée`);
}

async function handleRepublishSold({ temuItemId, variantId, accountId, sourcePriceCents, deliveryOption, deliveryFeeCents }, job) {
  const isMock = process.env.NODE_ENV === "test";
  const { randomUUID } = require("crypto");
  const fs = require("fs");
  const path = require("path");

  // Forcer la regénération des photos (supprimer le cache de la photo principale)
  if (!isMock) {
    const MEDIA_DIR = process.env.MEDIA_DIR ?? path.join(__dirname, "../../../data/media");
    const cached = path.join(MEDIA_DIR, `${temuItemId}_${variantId}_0.jpg`);
    if (fs.existsSync(cached)) fs.unlinkSync(cached);
    // Supprimer aussi les angles IA
    for (const suf of ["ai1", "ai2"]) {
      const p = path.join(MEDIA_DIR, `${temuItemId}_${variantId}_${suf}.jpg`);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  }

  // Créer un nouveau listing draft avec le même prix
  const { createListing } = require("../services/listings");
  const priceEur = (sourcePriceCents - (deliveryFeeCents ?? 0)) / 100;

  try {
    const newListing = createListing({
      temuItemId,
      variantId,
      accountId,
      priceEur,
      deliveryOption: deliveryOption ?? undefined,
    });
    console.log(`[republish] Nouveau listing créé : ${newListing.listingId}`);
    return { newListingId: newListing.listingId };
  } catch (e) {
    console.warn(`[republish] createListing failed: ${e.message}`);
    return { error: e.message };
  }
}

// --- Retraits porte-monnaie Leboncoin ----------------------------------------

/**
 * Exécute une demande de retrait.
 * Mock/test : marque le retrait comme effectué.
 * Production : le virement Leboncoin n'est pas encore automatisé (sélecteurs du
 * porte-monnaie non vérifiés) — on passe en `verify` pour action manuelle,
 * plutôt que de cliquer à l'aveugle sur une opération financière.
 */
async function handleWithdrawFunds({ withdrawalId }) {
  const withdrawals = require("../services/withdrawals");
  const w = db.prepare("SELECT * FROM withdrawals WHERE withdrawal_id = ?").get(withdrawalId);
  if (!w) throw Object.assign(new Error(`Retrait ${withdrawalId} introuvable`), { code: "NOT_FOUND" });
  if (w.status !== "pending") return { withdrawalId, skipped: true };
  const account = db.prepare("SELECT * FROM seller_accounts WHERE account_id = ?").get(w.account_id);
  const isMock = process.env.NODE_ENV === "test" || (account?.credentials_ref ?? "").startsWith("mock_");
  if (isMock) {
    withdrawals.setStatus(withdrawalId, "done", "Retrait simulé (compte mock)");
    return { withdrawalId, done: true };
  }
  withdrawals.setStatus(withdrawalId, "verify", "À faire depuis Leboncoin (Porte-monnaie → Virer), puis confirmer sur le dashboard");
  return { withdrawalId, manual: true };
}

queue.register("withdraw_funds", handleWithdrawFunds);
queue.register("publish_listing", handlePublishListing);
queue.register("send_alert", handleSendAlertWithValidation);
queue.register("sync_tracking", handleSyncTracking);
queue.register("mark_listing_sold", handleMarkListingSold);
queue.register("cancel_sale_lbc", handleCancelSaleLbc);
queue.register("reprice_check", handleRepriceCheck);
queue.register("refresh_listing_media", handleRefreshListingMedia);
queue.register("republish_sold", handleRepublishSold);
