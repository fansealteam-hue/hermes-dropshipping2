/**
 * Hermès Telegram Bot — JavaScript runtime (no TS compilation needed on VPS).
 */
require("dotenv").config();
const { Bot, InlineKeyboard, session } = require("grammy");
const { isAllowed, config } = require("./config.js");
const api = require("./api.js");
const msg = require("./messages.js");

// ─── Session ──────────────────────────────────────────────────────────────────

function initial() {
  return { state: "idle", updatedAt: new Date().toISOString() };
}

// Use placeholder token in test mode to allow module loading without real token
const bot = new Bot(config.botToken || (config.nodeEnv === "test" ? "0:test" : ""));
bot.use(session({ initial }));

// ─── Auth ─────────────────────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  const chatId = ctx.chat?.id ?? 0;
  if (!isAllowed(chatId)) { await ctx.reply("⛔ Accès non autorisé."); return; }
  ctx.session.updatedAt = new Date().toISOString();
  await next();
});

// ─── /start & /aide ───────────────────────────────────────────────────────────

const MENU = [
  "👋 *Hermès* — assistant dropshipping",
  "",
  "/lien — analyser un produit Temu",
  "/dashboard — tableau de bord",
  "/commande — référence commande fournisseur",
  "/suivi — numéro de suivi transporteur",
  "/ventes — ventes actives",
].join("\n");

bot.command(["start", "aide"], ctx => ctx.reply(MENU, { parse_mode: "MarkdownV2" }));

// ─── /lien ────────────────────────────────────────────────────────────────────

bot.command("lien", async ctx => {
  const url = ctx.match?.trim();
  if (!url) { ctx.session.state = "awaiting_temu_link"; return ctx.reply("📎 Envoyez le lien Temu :"); }
  return handleTemuUrl(ctx, url);
});

// ─── Free text router ─────────────────────────────────────────────────────────

bot.on("message:text", async ctx => {
  const text = ctx.message.text.trim();
  const { state } = ctx.session;

  if (state === "awaiting_temu_link") { ctx.session.state = "idle"; return handleTemuUrl(ctx, text); }
  if (state === "awaiting_order_ref")  { ctx.session.state = "idle"; const [id, ref] = text.split(" "); return handleOrderRef(ctx, id, ref); }
  if (state === "awaiting_tracking")   { ctx.session.state = "idle"; const [id, carrier, num] = text.split(" "); return handleTracking(ctx, id, carrier, num); }
  if (state === "awaiting_tracking_inline") {
    ctx.session.state = "idle";
    const saleId = ctx.session.pendingTrackingSaleId;
    ctx.session.pendingTrackingSaleId = undefined;
    const parts = text.trim().split(/\s+/);
    const carrier = parts[0];
    const num = parts.slice(1).join(" ");
    return handleTracking(ctx, saleId, carrier, num);
  }
});

// ─── Temu URL handler ────────────────────────────────────────────────────────

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

  const lines = [msg.fmtProduct(product), "", "Choisissez une variante :"].join("\n");
  return ctx.api.editMessageText(ctx.chat.id, status.message_id, lines,
    { parse_mode: "MarkdownV2", reply_markup: kb });
}

// ─── Variant → Price ──────────────────────────────────────────────────────────

bot.callbackQuery(/^variant:(.+)$/, async ctx => {
  const product = ctx.session.pendingProduct;
  if (!product) return ctx.answerCallbackQuery("Session expirée — /lien");

  const variantId = ctx.callbackQuery.data.replace("variant:", "");
  const variant = product.variants.find(v => v.variantId === variantId);
  if (!variant) return ctx.answerCallbackQuery("Variante introuvable");

  ctx.session.pendingVariantId = variantId;
  const suggested = (Math.floor(variant.costEur * 3) + 0.99);
  ctx.session.pendingListingDraft = {
    temuItemId: product.temuItemId,
    variantId,
    costEur: variant.costEur,
    priceEur: suggested,
    mediaUrls: variant.imageUrls,
  };
  ctx.session.state = "awaiting_price_confirm";

  const kb = new InlineKeyboard()
    .text(`✅ Confirmer ${suggested.toFixed(2)} €`, `confirm_price:${suggested}`)
    .row()
    .text("✏️ Modifier", "edit_price");

  await ctx.editMessageText(
    [`📦 *${msg.escMd(variant.label)}*`,
     `Coût : ${variant.costEur.toFixed(2)} €`,
     `Prix suggéré : *${msg.escMd(suggested.toFixed(2))} €*`,
     `Marge : ${(suggested - variant.costEur).toFixed(2)} €`,
     `Photos : ${variant.imageUrls.length} image\\(s\\)`].join("\n"),
    { parse_mode: "MarkdownV2", reply_markup: kb }
  );
  await ctx.answerCallbackQuery();
});

// ─── Price → Account ─────────────────────────────────────────────────────────

bot.callbackQuery(/^confirm_price:(.+)$/, async ctx => {
  const price = parseFloat(ctx.callbackQuery.data.replace("confirm_price:", ""));
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

  const kb = new InlineKeyboard()
    .text("⚡ Maintenant", "schedule:now").row()
    .text("📅 Dans 1h", `schedule:${Date.now() + 3_600_000}`).row()
    .text("📅 Demain 9h", "schedule:tomorrow");

  await ctx.editMessageText("🕐 Quand publier ?", { reply_markup: kb });
  await ctx.answerCallbackQuery();
});

// ─── Schedule → Create listing ────────────────────────────────────────────────

bot.callbackQuery(/^schedule:(.+)$/, async ctx => {
  const when = ctx.callbackQuery.data.replace("schedule:", "");
  const draft = ctx.session.pendingListingDraft ?? {};

  let scheduledAt;
  if (when !== "now") {
    if (when === "tomorrow") {
      const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
      scheduledAt = d.toISOString();
    } else {
      scheduledAt = new Date(parseInt(when)).toISOString();
    }
  }

  const res = await api.createListing({
    temuItemId: draft.temuItemId,
    variantId: draft.variantId,
    accountId: draft.accountId,
    priceEur: draft.priceEur,
    ...(scheduledAt ? { scheduledAt } : {}),
  });

  ctx.session.state = "idle";
  ctx.session.pendingProduct = undefined;
  ctx.session.pendingListingDraft = undefined;

  if (!res.ok || !res.data) {
    await ctx.editMessageText(`❌ ${msg.escMd(res.error ?? "Erreur")}`, { parse_mode: "MarkdownV2" });
    return ctx.answerCallbackQuery();
  }

  await ctx.editMessageText(msg.fmtListing(res.data), { parse_mode: "MarkdownV2" });
  await ctx.answerCallbackQuery("✅ Annonce créée");
});

// ─── /dashboard ───────────────────────────────────────────────────────────────

bot.command("dashboard", async ctx => {
  const res = await api.getDashboard();
  if (!res.ok || !res.data) return ctx.reply("❌ Tableau de bord indisponible\\.", { parse_mode: "MarkdownV2" });
  return ctx.reply(msg.fmtDashboard(res.data), { parse_mode: "MarkdownV2" });
});

// ─── /ventes ──────────────────────────────────────────────────────────────────

bot.command("ventes", async ctx => {
  const res = await api.getActiveSales();
  if (!res.ok || !res.data?.length) return ctx.reply("Aucune vente active\\.", { parse_mode: "MarkdownV2" });

  const lines = res.data.slice(0, 10).map(s => {
    const icon = s.leboncoinDeliveryConfirmed ? "✅" : s.manualActionRequired ? "⚠️" : "⏳";
    return `${icon} \`${s.saleId.slice(0, 10)}\` — ${msg.escMd(s.status)} — ${s.salePriceEur?.toFixed(2)} €`;
  });
  return ctx.reply(["🛒 *Ventes actives*", ...lines].join("\n"), { parse_mode: "MarkdownV2" });
});

// ─── /commande ────────────────────────────────────────────────────────────────

bot.command("commande", async ctx => {
  const parts = (ctx.match ?? "").trim().split(" ").filter(Boolean);
  if (parts.length < 2) {
    ctx.session.state = "awaiting_order_ref";
    return ctx.reply("📦 Envoyez : `<id_vente> <ref_commande>`", { parse_mode: "MarkdownV2" });
  }
  return handleOrderRef(ctx, parts[0], parts[1]);
});

async function handleOrderRef(ctx, saleId, ref) {
  if (!saleId || !ref) return ctx.reply("❌ Format : `/commande <id_vente> <ref>`", { parse_mode: "MarkdownV2" });
  const res = await api.addTracking(saleId, { orderRef: ref, trackingNumber: "" });
  if (!res.ok) return ctx.reply(`❌ ${msg.escMd(res.error ?? "")}`, { parse_mode: "MarkdownV2" });
  return ctx.reply(`✅ Référence \`${msg.escMd(ref)}\` enregistrée\\.`, { parse_mode: "MarkdownV2" });
}

// ─── /suivi ───────────────────────────────────────────────────────────────────

bot.command("suivi", async ctx => {
  const parts = (ctx.match ?? "").trim().split(" ").filter(Boolean);
  if (parts.length < 3) {
    ctx.session.state = "awaiting_tracking";
    return ctx.reply("📬 Envoyez : `<id_vente> <transporteur> <numéro>`", { parse_mode: "MarkdownV2" });
  }
  return handleTracking(ctx, parts[0], parts[1], parts[2]);
});

async function handleTracking(ctx, saleId, carrier, tracking) {
  if (!saleId || !tracking) return ctx.reply("❌ Format : `/suivi <id_vente> <transporteur> <numéro>`", { parse_mode: "MarkdownV2" });
  const res = await api.addTracking(saleId, { orderRef: "", trackingNumber: tracking, trackingCarrier: carrier });
  if (!res.ok || !res.data) return ctx.reply(`❌ ${msg.escMd(res.error ?? "")}`, { parse_mode: "MarkdownV2" });

  // Auto-transmission du suivi à l'acheteur Leboncoin via le job queue
  const syncRes = await api.syncTracking(saleId);
  const syncStatus = syncRes?.ok
    ? "✅ Transmis automatiquement à l'acheteur Leboncoin\\."
    : "⚠️ Transmission automatique échouée — à envoyer manuellement sur Leboncoin\\.";

  await ctx.reply(
    msg.fmtTrackingAdded(res.data) + "\n\n" + syncStatus,
    { parse_mode: "MarkdownV2" }
  );

  // Demander ce qu'on fait de l'annonce maintenant
  const saleData = await api.getSale(saleId);
  const titre = saleData?.data?.productTitle ?? "Article";
  await sendVenduConfirm(ctx.chat.id, saleId, titre);
}

// ─── Error handler ────────────────────────────────────────────────────────────

bot.catch(err => console.error("[bot]", err.message));

// ─── Sale alert : photo + OUI DISPONIBLE / NON PLUS DISPO ────────────────────

async function sendSaleAlert(chatId, { sale, productTitle, variantLabel, imageUrls = [], variantOptions = "" }) {
  const text = msg.fmtSaleAlert(sale, productTitle, variantLabel, variantOptions);
  const kb = new InlineKeyboard()
    .text("✅ OUI, disponible", `avail_yes:${sale.saleId}`).row()
    .text("❌ NON, plus dispo", `avail_no:${sale.saleId}`);

  const photoUrl = imageUrls?.[0];
  if (photoUrl) {
    try {
      await bot.api.sendPhoto(chatId, photoUrl, { caption: text, parse_mode: "MarkdownV2", reply_markup: kb });
      return;
    } catch (_) { /* fallback texte */ }
  }
  await bot.api.sendMessage(chatId, text, { parse_mode: "MarkdownV2", reply_markup: kb });
}

// ─── OUI → infos acheteur + lien Temu + VALIDER ──────────────────────────────

bot.callbackQuery(/^avail_yes:(.+)$/, async ctx => {
  const saleId = ctx.callbackQuery.data.replace("avail_yes:", "");
  const res = await api.getSale(saleId);
  if (!res.ok || !res.data) { await ctx.answerCallbackQuery("Vente introuvable"); return; }

  const sale = res.data;
  const info = [
    "✅ *Article disponible — infos acheteur*",
    "",
    sale.buyerName        ? `👤 Acheteur : ${msg.escMd(sale.buyerName)}` : "",
    sale.deliveryAddress  ? `📍 Adresse : ${msg.escMd(sale.deliveryAddress)}` : "",
    `💰 Prix payé : *${msg.escMd((sale.salePriceEur ?? 0).toFixed(2))} €*`,
    sale.costEur != null  ? `Coût estimé : ${msg.escMd(sale.costEur.toFixed(2))} €` : "",
    "",
    "🛒 *Lien fournisseur à commander :*",
    msg.escMd(sale.supplierUrl ?? ""),
    "",
    "👇 Validez après avoir passé la commande Temu",
  ].filter(Boolean).join("\n");

  const kb = new InlineKeyboard()
    .text("✅ VALIDER — j'ai commandé", `confirm_payment:${saleId}`).row()
    .text("❌ Finalement annuler", `avail_no:${saleId}`);

  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply(info, { parse_mode: "MarkdownV2", reply_markup: kb });
  await ctx.answerCallbackQuery("Article disponible ✅");
});

// ─── NON → annulation LBC + message acheteur + confirmation Telegram ─────────

bot.callbackQuery(/^avail_no:(.+)$/, async ctx => {
  const saleId = ctx.callbackQuery.data.replace("avail_no:", "");
  await ctx.answerCallbackQuery("Annulation en cours…");

  const res = await api.cancelSale(saleId);
  const okText = res?.ok
    ? "✅ Annulation envoyée à l'acheteur sur Leboncoin \\(message automatique\\)\\."
    : "⚠️ Annulation enregistrée, message LBC à envoyer manuellement\\.";

  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply(
    `❌ *Vente annulée*\n\n${okText}`,
    { parse_mode: "MarkdownV2" }
  );
});

// ─── VALIDER → instructions suivi + bouton inline ────────────────────────────

bot.callbackQuery(/^confirm_payment:(.+)$/, async ctx => {
  const saleId = ctx.callbackQuery.data.replace("confirm_payment:", "");
  const res = await api.getSale(saleId);
  if (!res.ok || !res.data) { await ctx.answerCallbackQuery("Vente introuvable"); return; }

  const sale = res.data;
  const lines = [
    "✅ *Commande validée \\!*",
    "",
    `🔗 ${msg.escMd(sale.supplierUrl ?? "Lien manquant")}`,
    "",
    "Dès que vous avez le numéro de suivi, appuyez sur le bouton ci\\-dessous\\.",
  ].join("\n");

  const kb = new InlineKeyboard()
    .text("📦 Ajouter le numéro de suivi", `add_tracking:${saleId}`);

  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply(lines, { parse_mode: "MarkdownV2", reply_markup: kb });
  await ctx.answerCallbackQuery("✅ Commande enregistrée !");
});

// ─── Bouton "Ajouter suivi" → demande transporteur + numéro ──────────────────

bot.callbackQuery(/^add_tracking:(.+)$/, async ctx => {
  const saleId = ctx.callbackQuery.data.replace("add_tracking:", "");
  ctx.session.state = "awaiting_tracking_inline";
  ctx.session.pendingTrackingSaleId = saleId;

  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply(
    `📬 Envoyez : \`<transporteur> <numéro>\`\n_Ex : LaPoste 1Z12345_`,
    { parse_mode: "MarkdownV2" }
  );
  await ctx.answerCallbackQuery();
});

// ─── Après ajout du suivi → demande si vendu définitif ───────────────────────
// Appelé depuis le handler awaiting_tracking (messages.js envoie tracking_done)

async function sendVenduConfirm(chatId, saleId, titre) {
  const texte = [
    "📦 *Suivi enregistré \\!*",
    "",
    `🏷 _${msg.escMd(titre ?? "Article")}_`,
    "",
    "Que voulez\\-vous faire avec cette annonce \\?",
  ].join("\n");

  const kb = new InlineKeyboard()
    .text("🔁 Republier l'annonce", `republier:${saleId}`).row()
    .text("📦 Garder archivé", `archiver:${saleId}`).row()
    .text("❌ Annuler la vente", `annuler_vente:${saleId}`);

  await bot.api.sendMessage(chatId, texte, { parse_mode: "MarkdownV2", reply_markup: kb });
}

// ─── 🔁 REPUBLIER → supprime cache photo + recrée l'annonce ─────────────────

bot.callbackQuery(/^republier:(.+)$/, async ctx => {
  const saleId = ctx.callbackQuery.data.replace("republier:", "");
  await ctx.answerCallbackQuery("Republication en cours…");

  const res = await api.republishSale(saleId);
  const ok = res?.ok;

  const texte = ok
    ? "✅ *Annonce republiée \\!*\nUne nouvelle annonce a été créée automatiquement\\."
    : "⚠️ Republication échouée — relancez manuellement depuis le dashboard\\.";

  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply(texte, { parse_mode: "MarkdownV2" });
});

// ─── 📦 ARCHIVER → garde l'annonce archivée, pas de republication ────────────

bot.callbackQuery(/^archiver:(.+)$/, async ctx => {
  const saleId = ctx.callbackQuery.data.replace("archiver:", "");
  await ctx.answerCallbackQuery("Archivé ✓");

  await api.closeSale(saleId).catch(() => {});

  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply(
    "📦 *Annonce archivée\\.* Elle ne sera pas republiée\\.",
    { parse_mode: "MarkdownV2" }
  );
});

// ─── ❌ ANNULER LA VENTE → remet l'annonce active ────────────────────────────

bot.callbackQuery(/^annuler_vente:(.+)$/, async ctx => {
  const saleId = ctx.callbackQuery.data.replace("annuler_vente:", "");
  await ctx.answerCallbackQuery("Annulation en cours…");

  const res = await api.cancelSale(saleId);
  const ok = res?.ok;

  const texte = ok
    ? "↩️ *Vente annulée\\.* L'annonce est de nouveau active sur Leboncoin\\."
    : "⚠️ Annulation enregistrée — vérifiez manuellement sur Leboncoin\\.";

  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply(texte, { parse_mode: "MarkdownV2" });
});

module.exports = { bot, sendSaleAlert, sendVenduConfirm };

// ─── Start ────────────────────────────────────────────────────────────────────

if (require.main === module) {
  if (!config.botToken) { console.error("[bot] TELEGRAM_BOT_TOKEN manquant"); process.exit(1); }
  bot.start();
  console.log("[bot] Hermès Telegram bot démarré (long polling)");
}
