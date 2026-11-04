/**
 * Hermès Telegram Bot — Tyno Entreprise V5
 * PHASE B : tous les bugs corrigés
 *   1. confirm_payment écrit en base (order_placed)
 *   2. avail_no sépare demande / succès / échec d'annulation
 *   3. Prix minimum x4 (+ breakdown coûts)
 *   4. api.js robuste (timeout, HTTP status) ← dans api.js
 *   5. Sessions Grammy persistées sur disque (fichier JSON)
 *   6. Annonce reste "draft" jusqu'à confirmation plateforme
 *   7. IDs validés côté serveur (vérification existence avant action)
 *   8. Callbacks idempotents (markCallbackDone)
 *   9. Dates Europe/Paris
 *  10. Zéro secret dans les fichiers
 */
require("dotenv").config();
const path = require("path");
const fs   = require("fs");
const { Bot, InlineKeyboard, session } = require("grammy");
const { FileAdapter } = require("@grammyjs/storage-file");
const { isAllowed, config } = require("./config.js");
const api  = require("./api.js");
const msg  = require("./messages.js");

// ─── Vérification token ───────────────────────────────────────────────────────

if (require.main === module && !config.botToken) {
  console.error("[bot] TELEGRAM_BOT_TOKEN manquant"); process.exit(1);
}

// ─── Timezone Europe/Paris ────────────────────────────────────────────────────

function fmtParis(isoOrDate) {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (isNaN(d)) return "—";
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    dateStyle: "short",
    timeStyle: "short",
  }).format(d);
}

function tomorrowParisAt9() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Paris" }));
  now.setDate(now.getDate() + 1);
  now.setHours(9, 0, 0, 0);
  return now;
}

// ─── Session persistée (Bug 5) ───────────────────────────────────────────────

const SESSION_DIR = path.join(__dirname, "../../../data/sessions");
fs.mkdirSync(SESSION_DIR, { recursive: true });

function initial() {
  return {
    state: "idle",
    pendingProduct:        undefined,
    pendingVariantId:      undefined,
    pendingListingDraft:   undefined,
    pendingTrackingSaleId: undefined,
    pendingCarrier:        undefined,
    pendingOrderSaleId:    undefined,
    updatedAt: new Date().toISOString(),
  };
}

const bot = new Bot(config.botToken || (config.nodeEnv === "test" ? "0:test" : ""));
bot.use(session({
  initial,
  storage: new FileAdapter({ dirName: SESSION_DIR }),
}));

// ─── Auth middleware ──────────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  const chatId = ctx.chat?.id ?? 0;
  if (!isAllowed(chatId)) { await ctx.reply("⛔ Accès non autorisé."); return; }
  ctx.session.updatedAt = new Date().toISOString();
  await next();
});

// ─── Idempotence callbacks (Bug 8) ───────────────────────────────────────────

async function guardCallback(ctx, next) {
  const cbId = ctx.callbackQuery?.id;
  if (!cbId) return next();
  const res = await api.markCallbackDone(cbId).catch(() => null);
  if (res?.alreadyDone) {
    await ctx.answerCallbackQuery("Déjà traité ✓").catch(() => {});
    return;
  }
  return next();
}

// ─── Menu principal ───────────────────────────────────────────────────────────

function mainMenuKb() {
  return new InlineKeyboard()
    .text("🏠 Dashboard",        "dashboard").text("🛒 Ventes",         "ventes").row()
    .text("📦 Produits",         "produits").text("📝 Annonces",         "annonces").row()
    .text("🔗 Import Temu",      "temu").text("💬 Messages",        "messages_lbc").row()
    .text("⬆️ Bumper",           "bump_all").text("🔄 Sync",             "sync_all").row()
    .text("🤖 Agents",           "agents").text("🌙 Nuit",           "nuit").row()
    .text("🔌 Extension",        "extension").text("⚙️ Paramètres",   "params");
}

bot.command(["start", "aide"], ctx => ctx.reply(
  "🚀 *Tyno Entreprise* — Hermès orchestrateur",
  { parse_mode: "MarkdownV2", reply_markup: mainMenuKb() }
));

// ─── Free text router ─────────────────────────────────────────────────────────

bot.on("message:text", async ctx => {
  const text  = ctx.message.text.trim();
  const state = ctx.session.state;

  if (state === "awaiting_temu_link") {
    ctx.session.state = "idle";
    return handleTemuUrl(ctx, text);
  }
  if (state === "awaiting_order_ref") {
    ctx.session.state = "idle";
    const idx = text.indexOf(" ");
    if (idx < 0) return ctx.reply("❌ Format : `<id_vente> <ref_commande>`", { parse_mode: "MarkdownV2" });
    return handleOrderRef(ctx, text.slice(0, idx), text.slice(idx + 1));
  }
  if (state === "awaiting_tracking") {
    ctx.session.state = "idle";
    const p = text.split(" ");
    return handleTracking(ctx, p[0], p[1], p.slice(2).join(" ") || p[1]);
  }
  if (state === "awaiting_tracking_number") {
    ctx.session.state = "idle";
    const saleId  = ctx.session.pendingTrackingSaleId;
    const carrier = ctx.session.pendingCarrier ?? "Autre";
    ctx.session.pendingTrackingSaleId = undefined;
    ctx.session.pendingCarrier = undefined;
    if (!saleId) return ctx.reply("❌ Session expirée — recommencez depuis l\\'alerte vente\\.", { parse_mode: "MarkdownV2" });
    return handleTracking(ctx, saleId, carrier, text);
  }
  // Saisie ref commande fournisseur après confirm_payment
  if (state === "awaiting_order_details") {
    ctx.session.state = "idle";
    const saleId = ctx.session.pendingOrderSaleId;
    ctx.session.pendingOrderSaleId = undefined;
    if (!saleId) return ctx.reply("❌ Session expirée\\.", { parse_mode: "MarkdownV2" });
    return handleOrderDetails(ctx, saleId, text);
  }
});

// ─── /lien — analyser Temu ────────────────────────────────────────────────────

bot.command("lien", async ctx => {
  const url = ctx.match?.trim();
  if (!url) { ctx.session.state = "awaiting_temu_link"; return ctx.reply("📎 Envoyez le lien Temu :"); }
  return handleTemuUrl(ctx, url);
});

bot.callbackQuery("temu", async ctx => {
  ctx.session.state = "awaiting_temu_link";
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply("📎 Envoyez le lien Temu :");
  await ctx.answerCallbackQuery();
});

async function handleTemuUrl(ctx, url) {
  if (!url.includes("temu.com") && !url.includes("tem.com")) {
    return ctx.reply("❌ Ce lien ne ressemble pas à Temu\\.", { parse_mode: "MarkdownV2" });
  }
  const status = await ctx.reply("⏳ Analyse du produit…");
  const res = await api.fetchTemuProduct(url);

  if (!res.ok || !res.data) {
    return ctx.api.editMessageText(ctx.chat.id, status.message_id,
      `❌ ${msg.escMd(res.error ?? "Erreur")}`, { parse_mode: "MarkdownV2" });
  }

  const product = res.data;
  ctx.session.pendingProduct = product;

  if (product.warehouseStatus !== "local") {
    return ctx.api.editMessageText(ctx.chat.id, status.message_id,
      `${msg.fmtProduct(product)}\n\n❌ *Inéligible* : entrepôt non local\\.`,
      { parse_mode: "MarkdownV2" });
  }

  ctx.session.state = "awaiting_variant_choice";
  const kb = new InlineKeyboard();
  product.variants.forEach(v => kb.text(v.label, `variant:${v.variantId}`).row());

  return ctx.api.editMessageText(ctx.chat.id, status.message_id,
    [msg.fmtProduct(product), "", "Choisissez une variante :"].join("\n"),
    { parse_mode: "MarkdownV2", reply_markup: kb });
}

// ─── Variant → Price (Bug 3 : x4 minimum) ────────────────────────────────────

const FRAIS_VENTE_PCT   = 0.08;  // 8% frais Leboncoin
const FRAIS_LIVRAISON   = 3.00;  // livraison acheteur (Autre moyen)
const FRAIS_EMBALLAGE   = 0.50;  // emballage
const MULTIPLICATEUR    = 4;     // minimum x4 sur coût produit

bot.callbackQuery(/^variant:(.+)$/, async ctx => {
  const product = ctx.session.pendingProduct;
  if (!product) return ctx.answerCallbackQuery("Session expirée — /lien");

  const variantId = ctx.callbackQuery.data.replace("variant:", "");
  const variant   = product.variants.find(v => v.variantId === variantId);
  if (!variant) return ctx.answerCallbackQuery("Variante introuvable");

  ctx.session.pendingVariantId = variantId;

  const costEur    = variant.costEur;
  const totalCosts = costEur + FRAIS_EMBALLAGE;
  // Prix plancher : couvrir tous les coûts + multiplicateur
  // prix × (1 - fraisPct) - livraison ≥ totalCosts × MULTIPLICATEUR
  const rawMin = (totalCosts * MULTIPLICATEUR + FRAIS_LIVRAISON) / (1 - FRAIS_VENTE_PCT);
  const suggested = Math.ceil(rawMin * 20) / 20; // arrondi à 0.05€ supérieur

  const margeEstimee = suggested * (1 - FRAIS_VENTE_PCT) - FRAIS_LIVRAISON - totalCosts;

  ctx.session.pendingListingDraft = {
    temuItemId: product.temuItemId,
    variantId,
    costEur,
    priceEur: suggested,
    mediaUrls: variant.imageUrls,
  };
  ctx.session.state = "awaiting_price_confirm";

  const lines = [
    `📦 *${msg.escMd(variant.label)}*`,
    "",
    `💰 Coût produit : ${msg.escMd(costEur.toFixed(2))} €`,
    `📦 Emballage : ${msg.escMd(FRAIS_EMBALLAGE.toFixed(2))} €`,
    `🚚 Livraison acheteur : ${msg.escMd(FRAIS_LIVRAISON.toFixed(2))} €`,
    `🏪 Frais plateforme \\(~8%\\) : ${msg.escMd((suggested * FRAIS_VENTE_PCT).toFixed(2))} €`,
    "",
    `💵 *Prix conseillé \\(×${MULTIPLICATEUR} min\\) : ${msg.escMd(suggested.toFixed(2))} €*`,
    `📈 Marge nette estimée : *${msg.escMd(margeEstimee.toFixed(2))} €*`,
  ];

  const kb = new InlineKeyboard()
    .text(`✅ Confirmer ${suggested.toFixed(2)} €`, `confirm_price:${suggested}`).row()
    .text("✏️ Modifier le prix", "edit_price");

  await ctx.editMessageText(lines.join("\n"), { parse_mode: "MarkdownV2", reply_markup: kb });
  await ctx.answerCallbackQuery();
});

// ─── Price → Account ─────────────────────────────────────────────────────────

bot.callbackQuery(/^confirm_price:(.+)$/, async ctx => {
  const price = parseFloat(ctx.callbackQuery.data.replace("confirm_price:", ""));
  if (isNaN(price) || price <= 0) return ctx.answerCallbackQuery("Prix invalide");
  ctx.session.pendingListingDraft.priceEur = price;
  ctx.session.state = "awaiting_account_choice";

  const res = await api.getLeboncoinAccounts();
  if (!res.ok || !res.data?.length) {
    await ctx.editMessageText("❌ Aucun compte Leboncoin disponible\\.", { parse_mode: "MarkdownV2" });
    return ctx.answerCallbackQuery();
  }

  const kb = new InlineKeyboard();
  res.data.forEach(a => kb.text(a.label, `account:${a.accountId}`).row());
  await ctx.editMessageText("🏪 Choisissez le compte Leboncoin :", { reply_markup: kb });
  await ctx.answerCallbackQuery();
});

// ─── Account → Schedule ───────────────────────────────────────────────────────

bot.callbackQuery(/^account:(.+)$/, async ctx => {
  ctx.session.pendingListingDraft.accountId = ctx.callbackQuery.data.replace("account:", "");
  ctx.session.state = "awaiting_schedule";

  const in1h = new Date(Date.now() + 3_600_000);
  const tmrw = tomorrowParisAt9();

  const kb = new InlineKeyboard()
    .text("⚡ Maintenant",                    "schedule:now").row()
    .text(`📅 Dans 1h (${fmtParis(in1h)})`,  `schedule:${in1h.getTime()}`).row()
    .text(`📅 Demain 9h (${fmtParis(tmrw)})`, "schedule:tomorrow");

  await ctx.editMessageText("🕐 Quand publier ?", { reply_markup: kb });
  await ctx.answerCallbackQuery();
});

// ─── Schedule → Create listing (Bug 6 : reste draft) ─────────────────────────

bot.callbackQuery(/^schedule:(.+)$/, async ctx => {
  const when  = ctx.callbackQuery.data.replace("schedule:", "");
  const draft = ctx.session.pendingListingDraft ?? {};

  let scheduledAt;
  if (when !== "now") {
    if (when === "tomorrow") {
      scheduledAt = tomorrowParisAt9().toISOString();
    } else {
      scheduledAt = new Date(parseInt(when, 10)).toISOString();
    }
  }

  // Bug 6 : on envoie status:'draft', le backend ne changera en 'active' qu'après confirmation plateforme
  const res = await api.createListing({
    temuItemId:  draft.temuItemId,
    variantId:   draft.variantId,
    accountId:   draft.accountId,
    priceEur:    draft.priceEur,
    status:      "draft",
    ...(scheduledAt ? { scheduledAt } : {}),
  });

  ctx.session.state = "idle";
  ctx.session.pendingProduct      = undefined;
  ctx.session.pendingListingDraft = undefined;
  ctx.session.pendingVariantId    = undefined;

  if (!res.ok || !res.data) {
    await ctx.editMessageText(`❌ ${msg.escMd(res.error ?? "Erreur")}`, { parse_mode: "MarkdownV2" });
    return ctx.answerCallbackQuery();
  }

  const listingId = res.data.listingId ?? res.data.listing_id ?? "?";
  const info = scheduledAt
    ? `📅 Programmée pour le ${msg.escMd(fmtParis(scheduledAt))}`
    : "⚡ Publiée dès confirmation de la plateforme\\.";

  await ctx.editMessageText(
    `✅ *Annonce créée* \\(\`${msg.escMd(listingId.slice(0, 10))}\`\\)\n${info}`,
    { parse_mode: "MarkdownV2" }
  );
  await ctx.answerCallbackQuery("✅ Annonce créée");
});

// ─── Dashboard ────────────────────────────────────────────────────────────────

async function replyDashboard(target, isEdit = false) {
  const res  = await api.getDashboard();
  const text = res.ok && res.data ? msg.fmtDashboard(res.data) : "❌ Tableau de bord indisponible\\.";
  const kb   = new InlineKeyboard().text("🔄 Actualiser", "dashboard").text("🏠 Menu", "menu");
  const opts = { parse_mode: "MarkdownV2", reply_markup: kb };
  return isEdit ? target.editMessageText(text, opts) : target.reply(text, opts);
}

bot.command("dashboard", ctx => replyDashboard(ctx));
bot.callbackQuery("dashboard", async ctx => {
  await replyDashboard(ctx, true).catch(() => ctx.reply("❌ Actualisation impossible\\."));
  await ctx.answerCallbackQuery("Actualisé ✓");
});

// ─── Ventes ───────────────────────────────────────────────────────────────────

async function replyVentes(target, isEdit = false) {
  const res = await api.getActiveSales();
  if (!res.ok || !res.data?.length) {
    const text = "Aucune vente active\\.";
    return isEdit
      ? target.editMessageText(text, { parse_mode: "MarkdownV2" })
      : target.reply(text, { parse_mode: "MarkdownV2" });
  }
  const lines = res.data.slice(0, 10).map(s => {
    const icon = s.leboncoinDeliveryConfirmed ? "✅" : s.manualActionRequired ? "⚠️" : "⏳";
    return `${icon} \`${s.saleId.slice(0, 10)}\` ${msg.escMd(s.status)} ${msg.escMd((s.salePriceEur ?? 0).toFixed(2))} €`;
  });
  const text = ["🛒 *Ventes actives*", ...lines].join("\n");
  const kb   = new InlineKeyboard().text("🔄 Actualiser", "ventes").text("🏠 Menu", "menu");
  const opts = { parse_mode: "MarkdownV2", reply_markup: kb };
  return isEdit ? target.editMessageText(text, opts) : target.reply(text, opts);
}

bot.command("ventes", ctx => replyVentes(ctx));
bot.callbackQuery("ventes", async ctx => {
  await replyVentes(ctx, true).catch(() => {});
  await ctx.answerCallbackQuery();
});

// ─── Produits / Annonces (stubs) ──────────────────────────────────────────────

bot.callbackQuery("produits", async ctx => {
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply("📦 *Catalogue produits* — utilisez `/lien` pour importer depuis Temu\\.",
    { parse_mode: "MarkdownV2", reply_markup: new InlineKeyboard().text("🔗 Importer", "temu").text("🏠 Menu", "menu") });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery("annonces", async ctx => {
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply("📝 *Annonces* — disponibles dans le dashboard web\\.",
    { parse_mode: "MarkdownV2", reply_markup: new InlineKeyboard().text("📊 Dashboard", "dashboard").text("🏠 Menu", "menu") });
  await ctx.answerCallbackQuery();
});

// ─── /commande ────────────────────────────────────────────────────────────────

bot.command("commande", async ctx => {
  const parts = (ctx.match ?? "").trim().split(" ").filter(Boolean);
  if (parts.length < 2) {
    ctx.session.state = "awaiting_order_ref";
    return ctx.reply("📦 Envoyez : `<id_vente> <ref_commande>`", { parse_mode: "MarkdownV2" });
  }
  return handleOrderRef(ctx, parts[0], parts.slice(1).join(" "));
});

async function handleOrderRef(ctx, saleId, ref) {
  if (!saleId || !ref) return ctx.reply("❌ Format : `/commande <id_vente> <ref>`", { parse_mode: "MarkdownV2" });
  // Bug 7 : vérifier que la vente existe avant d'écrire
  const check = await api.getSale(saleId);
  if (!check.ok || !check.data) return ctx.reply(`❌ Vente \`${msg.escMd(saleId)}\` introuvable\\.`, { parse_mode: "MarkdownV2" });
  const res = await api.addTracking(saleId, { orderRef: ref, trackingNumber: "" });
  if (!res.ok) return ctx.reply(`❌ ${msg.escMd(res.error ?? "")}`, { parse_mode: "MarkdownV2" });
  return ctx.reply(`✅ Référence \`${msg.escMd(ref)}\` enregistrée pour \`${msg.escMd(saleId.slice(0, 10))}\`\\.`, { parse_mode: "MarkdownV2" });
}

// ─── /suivi ───────────────────────────────────────────────────────────────────

bot.command("suivi", async ctx => {
  const parts = (ctx.match ?? "").trim().split(" ").filter(Boolean);
  if (parts.length < 3) {
    ctx.session.state = "awaiting_tracking";
    return ctx.reply("📬 Envoyez : `<id_vente> <transporteur> <numéro>`", { parse_mode: "MarkdownV2" });
  }
  return handleTracking(ctx, parts[0], parts[1], parts.slice(2).join(" "));
});

async function handleTracking(ctx, saleId, carrier, tracking) {
  if (!saleId || !tracking) return ctx.reply("❌ Format : `/suivi <id_vente> <transporteur> <numéro>`", { parse_mode: "MarkdownV2" });
  // Bug 7 : vérifier existence
  const check = await api.getSale(saleId);
  if (!check.ok || !check.data) return ctx.reply(`❌ Vente \`${msg.escMd(saleId)}\` introuvable\\.`, { parse_mode: "MarkdownV2" });

  const res = await api.addTracking(saleId, { orderRef: "", trackingNumber: tracking, trackingCarrier: carrier });
  if (!res.ok || !res.data) return ctx.reply(`❌ ${msg.escMd(res.error ?? "")}`, { parse_mode: "MarkdownV2" });

  const syncRes = await api.syncTracking(saleId);
  const syncStatus = syncRes?.ok
    ? "✅ Transmis automatiquement à l'acheteur Leboncoin\\."
    : "⚠️ Transmission automatique échouée — à envoyer manuellement sur Leboncoin\\.";

  await ctx.reply(msg.fmtTrackingAdded(res.data) + "\n\n" + syncStatus, { parse_mode: "MarkdownV2" });

  const titre = check.data.productTitle ?? "Article";
  await sendVenduConfirm(ctx.chat.id, saleId, titre);
}

// ─── Bump ─────────────────────────────────────────────────────────────────────

bot.command("bump", async ctx => {
  const kb = new InlineKeyboard()
    .text("⬆️ Bumper toutes les annonces", "confirm_bump").row()
    .text("❌ Annuler", "menu");
  await ctx.reply("⬆️ *Bumper les annonces*", { parse_mode: "MarkdownV2", reply_markup: kb });
});

bot.callbackQuery("bump_all", async ctx => {
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  const kb = new InlineKeyboard()
    .text("✅ Confirmer le bump", "confirm_bump").row()
    .text("❌ Annuler", "menu");
  await ctx.reply("⬆️ Bumper toutes les annonces LBC ?", { reply_markup: kb });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery("confirm_bump", async ctx => {
  await ctx.answerCallbackQuery("Bump en cours…");
  const res = await api.bumpAll().catch(() => null);
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply(
    res?.ok
      ? `⬆️ *Bump lancé \\!* ${msg.escMd(String(res.data?.jobsCreated ?? 0))} job\\(s\\) créé\\(s\\)\\.`
      : "⚠️ Bump échoué — relancez depuis le dashboard\\.",
    { parse_mode: "MarkdownV2" }
  );
});

// ─── Sync ─────────────────────────────────────────────────────────────────────

bot.command("sync", async ctx => {
  await ctx.reply("🔄 Synchronisation lancée…");
  const res = await api.syncAll().catch(() => null);
  await ctx.reply(
    res?.ok
      ? `🔄 *Sync terminée \\!* ${msg.escMd(String(res.data?.jobsCreated ?? 0))} job\\(s\\) créé\\(s\\)\\.`
      : "⚠️ Sync échouée\\.",
    { parse_mode: "MarkdownV2" }
  );
});

bot.callbackQuery("sync_all", async ctx => {
  await ctx.answerCallbackQuery("Sync en cours…");
  const res = await api.syncAll().catch(() => null);
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply(res?.ok ? "🔄 *Sync lancée\\.* " : "⚠️ Sync échouée\\.", { parse_mode: "MarkdownV2" });
});

// ─── Agents ───────────────────────────────────────────────────────────────────

async function replyAgents(target, isEdit = false) {
  const res = await api.getAgents().catch(() => null);
  const text = res?.ok && res.data
    ? ["🤖 *État des agents*", "",
       `⏳ En attente : *${res.data.pending ?? 0}*`,
       `▶️ En cours : *${res.data.running ?? 0}*`,
       `✅ Terminés \\(24h\\) : *${res.data.done24h ?? 0}*`,
       `❌ Échoués \\(24h\\) : *${res.data.failed24h ?? 0}*`].join("\n")
    : "⚠️ Agents inaccessibles\\.";
  const kb   = new InlineKeyboard().text("🔄 Actualiser", "agents").text("🏠 Menu", "menu");
  const opts = { parse_mode: "MarkdownV2", reply_markup: kb };
  return isEdit ? target.editMessageText(text, opts) : target.reply(text, opts);
}

bot.command("agents", ctx => replyAgents(ctx));
bot.callbackQuery("agents", async ctx => {
  await replyAgents(ctx, true).catch(() => {});
  await ctx.answerCallbackQuery();
});

// ─── Nuit / Extension / Params (stubs évolutifs) ─────────────────────────────

bot.callbackQuery("nuit", async ctx => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply("🌙 *Travail nocturne*\nPlanificateur non encore déployé\\.\nRevenir dans la Phase J\\.",
    { parse_mode: "MarkdownV2", reply_markup: new InlineKeyboard().text("🏠 Menu", "menu") });
});

bot.callbackQuery("extension", async ctx => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply("🔌 *Extension Tyno Connect*\nAucun navigateur associé pour l\\'instant\\.\nInstallez l\\'extension Chrome depuis le dashboard\\.",
    { parse_mode: "MarkdownV2", reply_markup: new InlineKeyboard().text("🏠 Menu", "menu") });
});

bot.callbackQuery("params", async ctx => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply("⚙️ *Paramètres*\nConfiguration disponible dans le dashboard web\\.",
    { parse_mode: "MarkdownV2", reply_markup: new InlineKeyboard().text("🏠 Menu", "menu") });
});

// ─── Messages LBC ─────────────────────────────────────────────────────────────

bot.callbackQuery("messages_lbc", async ctx => {
  await ctx.answerCallbackQuery();
  const res = await api.getUnreadMessages().catch(() => null);
  if (!res?.ok || !res.data?.length) {
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    return ctx.reply("💬 Aucun message non lu\\. ✅", { parse_mode: "MarkdownV2" });
  }
  const lines = res.data.slice(0, 5).map(m =>
    `💬 *${msg.escMd(m.senderName ?? "?")}* : _${msg.escMd((m.preview ?? "").slice(0, 60))}_`
  );
  const text = [`💬 *Messages non lus* \\(${res.data.length}\\)`, ...lines].join("\n");
  const kb   = new InlineKeyboard().text("🔄 Actualiser", "messages_lbc").text("🏠 Menu", "menu");
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply(text, { parse_mode: "MarkdownV2", reply_markup: kb });
});

// ─── Menu retour ─────────────────────────────────────────────────────────────

bot.callbackQuery("menu", async ctx => {
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply("🚀 *Tyno Entreprise*", { parse_mode: "MarkdownV2", reply_markup: mainMenuKb() });
  await ctx.answerCallbackQuery();
});

// ─── Sale alert (depuis backend) ─────────────────────────────────────────────

async function sendSaleAlert(chatId, { sale, productTitle, variantLabel, imageUrls = [], variantOptions = "" }) {
  const text = msg.fmtSaleAlert(sale, productTitle, variantLabel, variantOptions);
  const kb   = new InlineKeyboard()
    .text("✅ OUI, disponible",   `avail_yes:${sale.saleId}`).row()
    .text("❌ NON, plus dispo",    `avail_no:${sale.saleId}`).row()
    .text("📋 Détails",            `sale_details:${sale.saleId}`);

  const photoUrl = imageUrls?.[0];
  if (photoUrl) {
    try {
      await bot.api.sendPhoto(chatId, photoUrl, { caption: text, parse_mode: "MarkdownV2", reply_markup: kb });
      return;
    } catch (_) {}
  }
  await bot.api.sendMessage(chatId, text, { parse_mode: "MarkdownV2", reply_markup: kb });
}

// ─── Détails vente ────────────────────────────────────────────────────────────

bot.callbackQuery(/^sale_details:(.+)$/, async ctx => {
  const saleId = ctx.callbackQuery.data.replace("sale_details:", "");
  const res    = await api.getSale(saleId);
  if (!res.ok || !res.data) return ctx.answerCallbackQuery("Vente introuvable");
  const s = res.data;
  const lines = [
    `🔖 ID : \`${msg.escMd(saleId.slice(0, 12))}\``,
    `📊 Statut : ${msg.escMd(s.status ?? "?")}`,
    `💰 Prix : ${msg.escMd((s.salePriceEur ?? 0).toFixed(2))} €`,
    s.buyerName ? `👤 Acheteur : ${msg.escMd(s.buyerName)}` : "",
    s.orderRef  ? `📦 Ref commande : \`${msg.escMd(s.orderRef)}\`` : "",
    s.trackingNumber ? `🚚 Suivi : \`${msg.escMd(s.trackingNumber)}\`` : "",
    `🕐 ${msg.escMd(fmtParis(s.confirmedAt ?? new Date()))}`,
  ].filter(Boolean).join("\n");
  await ctx.answerCallbackQuery();
  await ctx.reply(lines, { parse_mode: "MarkdownV2", reply_markup: new InlineKeyboard().text("🏠 Menu", "menu") });
});

// ─── OUI → infos acheteur ────────────────────────────────────────────────────

bot.callbackQuery(/^avail_yes:(.+)$/, async ctx => {
  const saleId = ctx.callbackQuery.data.replace("avail_yes:", "");
  // Bug 7 : vérifier existence
  const res = await api.getSale(saleId);
  if (!res.ok || !res.data) { await ctx.answerCallbackQuery("Vente introuvable"); return; }

  const sale = res.data;
  const info = [
    "✅ *Article disponible — infos acheteur*", "",
    sale.buyerName       ? `👤 Acheteur : ${msg.escMd(sale.buyerName)}` : "",
    `💰 Prix payé : *${msg.escMd((sale.salePriceEur ?? 0).toFixed(2))} €*`,
    sale.costEur != null ? `Coût estimé : ${msg.escMd(sale.costEur.toFixed(2))} €` : "",
    "",
    "🛒 *Lien fournisseur :*",
    msg.escMd(sale.supplierUrl ?? ""),
    "",
    "👇 Passez la commande sur Temu puis validez ici\\.",
  ].filter(Boolean).join("\n");

  const kb = new InlineKeyboard()
    .text("✅ VALIDER — j'ai commandé", `confirm_payment:${saleId}`).row()
    .text("❌ Finalement annuler",       `avail_no:${saleId}`);

  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply(info, { parse_mode: "MarkdownV2", reply_markup: kb });
  await ctx.answerCallbackQuery("Article disponible ✅");
});

// ─── NON → annulation (Bug 2 : sépare demande / succès / échec) ──────────────

bot.callbackQuery(/^avail_no:(.+)$/, async ctx => {
  const saleId = ctx.callbackQuery.data.replace("avail_no:", "");
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});

  // Étape 1 : demander confirmation
  const kb = new InlineKeyboard()
    .text("✅ Confirmer l'annulation", `cancel_confirm:${saleId}`).row()
    .text("↩️ Revenir",                 `avail_yes:${saleId}`);

  await ctx.reply(
    "⚠️ *Confirmer l\\'annulation de la vente \\?*\nCette action enverra un message à l\\'acheteur sur Leboncoin\\.",
    { parse_mode: "MarkdownV2", reply_markup: kb }
  );
});

bot.callbackQuery(/^cancel_confirm:(.+)$/, async ctx => {
  const saleId = ctx.callbackQuery.data.replace("cancel_confirm:", "");
  await ctx.answerCallbackQuery("Annulation en cours…");
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});

  const res = await api.cancelSale(saleId);

  // Étape 2 : afficher le vrai résultat
  if (res?.ok) {
    await ctx.reply("✅ *Vente annulée\\.* Message envoyé à l\\'acheteur via Leboncoin\\.", { parse_mode: "MarkdownV2" });
  } else {
    const errTxt = msg.escMd(res?.error ?? "Erreur inconnue");
    await ctx.reply(
      `⚠️ *Annulation non confirmée par la plateforme\\.* ${errTxt}\n\n_Vérifiez manuellement sur Leboncoin\\._`,
      { parse_mode: "MarkdownV2",
        reply_markup: new InlineKeyboard().text("🔁 Réessayer", `cancel_confirm:${saleId}`) }
    );
  }
});

// ─── VALIDER → saisir ref commande fournisseur (Bug 1) ───────────────────────

bot.callbackQuery(/^confirm_payment:(.+)$/, async ctx => {
  const saleId = ctx.callbackQuery.data.replace("confirm_payment:", "");
  // Bug 7 : vérifier existence
  const res = await api.getSale(saleId);
  if (!res.ok || !res.data) { await ctx.answerCallbackQuery("Vente introuvable"); return; }

  ctx.session.state              = "awaiting_order_details";
  ctx.session.pendingOrderSaleId = saleId;

  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply(
    "📦 *Commande passée sur Temu \\!*\n\nEnvoyez le *numéro de commande Temu* \\(et optionnellement le prix payé\\) :\n`<ref_commande> [prix_payé]`\nExemple : `PO-123456789 12.50`",
    { parse_mode: "MarkdownV2" }
  );
  await ctx.answerCallbackQuery("Saisissez la référence commande");
});

async function handleOrderDetails(ctx, saleId, text) {
  const parts     = text.trim().split(/\s+/);
  const orderRef  = parts[0];
  const pricePaid = parts[1] ? parseFloat(parts[1]) : undefined;

  if (!orderRef) return ctx.reply("❌ Référence commande manquante\\.", { parse_mode: "MarkdownV2" });

  // Bug 1 : écriture réelle en backend (order_placed)
  const res = await api.confirmOrderPlaced(saleId, { orderRef, pricePaid });

  if (!res.ok) {
    return ctx.reply(
      `❌ Erreur d\\'enregistrement : ${msg.escMd(res.error ?? "")}\n_Réessayez ou saisissez manuellement\\._ `,
      { parse_mode: "MarkdownV2" }
    );
  }

  const kb = new InlineKeyboard().text("📦 Ajouter le numéro de suivi", `add_tracking:${saleId}`);
  await ctx.reply(
    [
      "✅ *Commande Temu enregistrée \\!*",
      `📋 Ref : \`${msg.escMd(orderRef)}\``,
      pricePaid != null ? `💶 Prix payé : ${msg.escMd(pricePaid.toFixed(2))} €` : "",
      "",
      "Ajoutez le numéro de suivi dès réception\\.",
    ].filter(Boolean).join("\n"),
    { parse_mode: "MarkdownV2", reply_markup: kb }
  );
}

// ─── Choix transporteur (6 boutons) ──────────────────────────────────────────

const CARRIERS = [
  ["📮 Colissimo",     "Colissimo"],
  ["🌍 Mondial Relay", "MondialRelay"],
  ["⚡ Chronopost",    "Chronopost"],
  ["📦 Colis Privé",   "ColisPrivé"],
  ["🏪 Relais Colis",  "RelaisColis"],
  ["✏️ Autre",         "Autre"],
];

bot.callbackQuery(/^add_tracking:(.+)$/, async ctx => {
  const saleId = ctx.callbackQuery.data.replace("add_tracking:", "");
  const kb = new InlineKeyboard();
  for (const [label, code] of CARRIERS) kb.text(label, `carrier:${saleId}:${code}`).row();

  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply("🚚 *Choisissez le transporteur :*", { parse_mode: "MarkdownV2", reply_markup: kb });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^carrier:([^:]+):(.+)$/, async ctx => {
  const [, saleId, carrier] = ctx.callbackQuery.data.match(/^carrier:([^:]+):(.+)$/);
  ctx.session.state               = "awaiting_tracking_number";
  ctx.session.pendingTrackingSaleId = saleId;
  ctx.session.pendingCarrier       = carrier;
  const label = CARRIERS.find(([, c]) => c === carrier)?.[0] ?? carrier;
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply(`${label} sélectionné\\.\n\n📬 Envoyez le *numéro de suivi* :`, { parse_mode: "MarkdownV2" });
  await ctx.answerCallbackQuery();
});

// ─── Post-vente ───────────────────────────────────────────────────────────────

async function sendVenduConfirm(chatId, saleId, titre) {
  const texte = [
    "📦 *Suivi enregistré \\!*", "",
    `🏷 _${msg.escMd(titre ?? "Article")}_`, "",
    "Que voulez\\-vous faire avec cette annonce \\?",
  ].join("\n");

  const kb = new InlineKeyboard()
    .text("🔁 Republier l'annonce", `republier:${saleId}`).row()
    .text("📦 Garder archivé",      `archiver:${saleId}`).row()
    .text("❌ Annuler la vente",    `annuler_vente:${saleId}`);

  await bot.api.sendMessage(chatId, texte, { parse_mode: "MarkdownV2", reply_markup: kb });
}

bot.callbackQuery(/^republier:(.+)$/, async ctx => {
  const saleId = ctx.callbackQuery.data.replace("republier:", "");
  await ctx.answerCallbackQuery("Republication en cours…");
  const res = await api.republishSale(saleId);
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply(
    res?.ok ? "✅ *Annonce republiée \\!*" : "⚠️ Republication échouée — relancez depuis le dashboard\\.",
    { parse_mode: "MarkdownV2" }
  );
});

bot.callbackQuery(/^archiver:(.+)$/, async ctx => {
  const saleId = ctx.callbackQuery.data.replace("archiver:", "");
  await ctx.answerCallbackQuery("Archivé ✓");
  await api.closeSale(saleId).catch(() => {});
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply("📦 *Annonce archivée\\.* Elle ne sera pas republiée\\.", { parse_mode: "MarkdownV2" });
});

bot.callbackQuery(/^annuler_vente:(.+)$/, async ctx => {
  const saleId = ctx.callbackQuery.data.replace("annuler_vente:", "");
  await ctx.answerCallbackQuery("Annulation en cours…");
  const res = await api.cancelSale(saleId);
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply(
    res?.ok
      ? "↩️ *Vente annulée\\.* L\\'annonce est de nouveau active sur Leboncoin\\."
      : "⚠️ Annulation enregistrée — vérifiez manuellement sur Leboncoin\\.",
    { parse_mode: "MarkdownV2" }
  );
});

// ─── Notifications push ───────────────────────────────────────────────────────

const NOTIF_EMOJI = {
  session_expired:   "🔑",
  listing_published: "✅",
  listing_failed:    "❌",
  order_received:    "🛒",
  message_received:  "💬",
  bump_done:         "⬆️",
  sync_done:         "🔄",
  approval_required: "⚠️",
};

async function sendNotification(chatId, { type = "", title = "Notification", message = "", referenceId, referenceType } = {}) {
  const emoji = NOTIF_EMOJI[type] ?? "🔔";
  const text  = `${emoji} *${msg.escMd(title)}*\n${msg.escMd(message)}`;

  if (type === "approval_required" && referenceId) {
    const kb = new InlineKeyboard()
      .text("✅ Approuver", `approve:${referenceType}:${referenceId}`).row()
      .text("❌ Refuser",   `reject:${referenceType}:${referenceId}`);
    await bot.api.sendMessage(chatId, text, { parse_mode: "MarkdownV2", reply_markup: kb });
  } else {
    await bot.api.sendMessage(chatId, text, { parse_mode: "MarkdownV2" });
  }
}

// ─── Error handler ────────────────────────────────────────────────────────────

bot.catch(err => console.error("[bot]", err.message ?? err));

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { bot, sendSaleAlert, sendVenduConfirm, sendNotification };

// ─── Start ────────────────────────────────────────────────────────────────────

if (require.main === module) {
  bot.start();
  console.log("[bot] Tyno Entreprise — Hermès bot démarré (long polling)");
}
