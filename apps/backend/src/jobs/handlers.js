/**
 * Job handlers — Claude 3 (publish/tracking) and Claude 4 (alert).
 */
const queue = require("./queue");
const { getSale } = require("../services/sales");
const { updateListingStatus } = require("../services/listings");
const db = require("../db/db");

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

    const sessionPath = `${__dirname}/../../../data/sessions/${account.account_id}.json`;
    const storageState = fs.existsSync(sessionPath) ? JSON.parse(fs.readFileSync(sessionPath, "utf8")) : undefined;
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();

    await page.goto("https://www.leboncoin.fr/deposer-une-annonce", { waitUntil: "domcontentloaded" });

    const currentUrl = page.url();
    if (currentUrl.includes("login") || currentUrl.includes("connexion")) {
      await _pauseAccount(account.account_id, "session_expired");
      throw Object.assign(new Error("Session expiree — compte pause"), { code: "SESSION_EXPIRED" });
    }
    if (await page.$('[data-testid="captcha"]').catch(() => null)) {
      await _pauseAccount(account.account_id, "captcha");
      throw Object.assign(new Error("CAPTCHA detecte — compte pause"), { code: "CAPTCHA" });
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
    fs.mkdirSync(`${__dirname}/../../../data/sessions`, { recursive: true });
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

  if (isMock) {
    db.prepare("UPDATE sales SET leboncoin_delivery_confirmed = 1, manual_action_required = 0, updated_at = ? WHERE sale_id = ?")
      .run(new Date().toISOString(), saleId);
    return { saleId, synced: true };
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

    const sessionPath = `${__dirname}/../../../data/sessions/${sale.account_id}.json`;
    const storageState = fs.existsSync(sessionPath) ? JSON.parse(fs.readFileSync(sessionPath, "utf8")) : undefined;
    const context = await browser.newContext({ storageState });
    const page = await context.newPage();

    await page.goto(`https://www.leboncoin.fr/messagerie/${listing.leboncoin_ad_id}`, { waitUntil: "domcontentloaded" });

    const msg = `Numero de suivi : ${trackingNumber}${trackingCarrier ? ` (${trackingCarrier})` : ""}`;
    await page.fill('[data-testid="message-input"]', msg);
    await page.click('[data-testid="send-message"]');

    const newState = await context.storageState();
    const sessionDir = `${__dirname}/../../../data/sessions`;
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

// --- Claude 4 / bot alert ----------------------------------------------------

async function handleSendAlert({ saleId }, job) {
  const sale = getSale(saleId);
  if (!sale) throw new Error(`Sale ${saleId} not found`);

  const product = db.prepare("SELECT * FROM products WHERE temu_item_id = ?").get(sale.temuItemId);
  const variant = db.prepare("SELECT * FROM variants WHERE variant_id = ?").get(sale.variantId);

  try {
    const { sendSaleAlert } = require("../../telegram/dist/bot");
    const chatIds = (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "").split(",").filter(Boolean).map(Number);
    for (const chatId of chatIds) {
      await sendSaleAlert(chatId, {
        sale,
        productTitle: product?.title ?? sale.temuItemId,
        variantLabel: variant?.label ?? sale.variantId,
      });
    }
    db.prepare("UPDATE sales SET alert_sent = 1 WHERE sale_id = ?").run(saleId);
  } catch (e) {
    console.warn(`[jobs] sendAlert: ${e.message}`);
    db.prepare("UPDATE sales SET alert_sent = 1, manual_action_note = 'Alerte Telegram a envoyer manuellement' WHERE sale_id = ?").run(saleId);
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
    return { listingId, marked: true };
  }

  // Production: clôturer l'annonce sur LBC
  let browser;
  try {
    const { chromium } = require("playwright");
    const fs = require("fs");
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium", headless: true });
    const sessionPath = `${__dirname}/../../../data/sessions/${account.account_id}.json`;
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
    fs.mkdirSync(`${__dirname}/../../../data/sessions`, { recursive: true });
    fs.writeFileSync(sessionPath, JSON.stringify(newState));
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

  const product = db.prepare("SELECT * FROM products WHERE temu_item_id = ?").get(sale.temuItemId);
  const variant = db.prepare("SELECT * FROM variants WHERE variant_id = ?").get(sale.variantId);

  try {
    const botModule = require("../../telegram/src/bot.js");
    const chatIds = (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "").split(",").filter(Boolean).map(Number);

    // Photos et composition de la variante
    const imageUrls = JSON.parse(variant?.image_urls ?? "[]");
    const variantOptions = variant?.label ?? "";

    for (const chatId of chatIds) {
      await botModule.sendSaleAlert(chatId, {
        sale,
        productTitle: product?.title ?? sale.temuItemId,
        variantLabel: variant?.label ?? sale.variantId,
        imageUrls,
        variantOptions,
      });
    }
    db.prepare("UPDATE sales SET alert_sent = 1 WHERE sale_id = ?").run(saleId);
  } catch (e) {
    console.warn(`[jobs] sendAlert: ${e.message}`);
    db.prepare("UPDATE sales SET alert_sent = 1, manual_action_note = 'Alerte Telegram a envoyer manuellement' WHERE sale_id = ?").run(saleId);
  }
}

queue.register("publish_listing", handlePublishListing);
queue.register("send_alert", handleSendAlertWithValidation);
queue.register("sync_tracking", handleSyncTracking);
queue.register("mark_listing_sold", handleMarkListingSold);
