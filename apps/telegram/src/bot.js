/**
 * Hermès Telegram Bot — fusion Hermès + Softnex
 * Meilleur des deux : flow Temu/vente/suivi (Hermès) + menu boutons/bump/sync/agents (Softnex)
 */
require("dotenv").config();
const { Bot, InlineKeyboard, session } = require("grammy");
const { isAllowed, config } = require("./config.js");
const api  = require("./api.js");
const msg  = require("./messages.js");

// ─── Vérification token avant tout ───────────────────────────────────────────

if (require.main === module && !config.botToken) {
  console.error("[bot] TELEGRAM_BOT_TOKEN manquant"); process.exit(1);
}

// ─── Session ──────────────────────────────────────────────────────────────────

function initial() {
  return {
    state: "idle",
    pendingProduct:      undefined,
    pendingVariantId:    undefined,
    pendingListingDraft: undefined,
    pendingTrackingSaleId: undefined,
    pendingCarrier:      undefined,
    updatedAt: new Date().toISOString(),
  };
}

const bot = new Bot(config.botToken || (config.nodeEnv === "test" ? "0:test" : ""));
bot.use(session({ initial }));

// ─── Auth middleware ──────────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  const chatId = ctx.chat?.id ?? 0;
  if (!isAllowed(chatId)) { await ctx.reply("⛔ Accès non autorisé."); return; }
  ctx.session.updatedAt = new Date().toISOString();
  await next();
});

// ─── /start & /aide — boutons inline (Softnex) ───────────────────────────────

function mainMenuKb() {
  return new InlineKeyboard()
    .text("📊 Dashboard",         "dashboard").text("🛒 Ventes",         "ventes").row()
    .text("🔗 Analyser Temu",     "temu").text("💬 Messages LBC",   "messages_lbc").row()
    .text("⬆️ Bumper annonces",   "bump_all").text("🔄 Sync comptes",    "sync_all").row()
    .text("🤖 Agents / Jobs",     "agents");
}

bot.command(["start", "aide"], ctx => ctx.reply(
  "🚀 *Hermès* — dropshipping Temu → Leboncoin",
  { parse_mode: "MarkdownV2", reply_markup: mainMenuKb() }
));

// ─── Free text router ─────────────────────────────────────────────────────────

bot.on("message:text", async ctx => {
  const text = ctx.message.text.trim();
  const { state } = ctx.session;

  if (state === "awaiting_temu_link") {
    ctx.session.state = "idle";
    return handleTemuUrl(ctx, text);
  }
  if (state === "awaiting_order_ref") {
    ctx.session.state = "idle";
    const spaceIdx = text.indexOf(" ");
    if (spaceIdx < 0) return ctx.reply("❌ Format : `<id_vente> <ref_commande>`", { parse_mode: "MarkdownV2" });
    return handleOrderRef(ctx, text.slice(0, spaceIdx), text.slice(spaceIdx + 1));
  }
  if (state === "awaiting_tracking") {
    ctx.session.state = "idle";
    const parts = text.split(" ");
    return handleTracking(ctx, parts[0], parts[1], parts.slice(2).join(" ") || parts[1]);
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
});

// ─── /lien — analyser un produit Temu ────────────────────────────────────────

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

// ─── Variant → Price ──────────────────────────────────────────────────────────

bot.callbackQuery(/^variant:(.+)$/, async ctx => {
  const product = ctx.session.pendingProduct;
  if (!product) return ctx.answerCallbackQuery("Session expirée — /lien");

  const variantId = ctx.callbackQuery.data.replace("variant:", "");
  const variant   = product.variants.find(v => v.variantId === variantId);
  if (!variant) return ctx.answerCallbackQuery("Variante introuvable");

  ctx.session.pendingVariantId = variantId;
  const suggested = (Math.floor(variant.costEur * 3) + 0.99);
  ctx.session.pendingListingDraft = {
    temuItemId: product.temuItemId,
    variantId,
    costEur:  variant.costEur,
    priceEur: suggested,
    mediaUrls: variant.imageUrls,
  };
  ctx.session.state = "awaiting_price_confirm";

  const kb = new InlineKeyboard()
    .text(`✅ Confirmer ${suggested.toFixed(2)} €`, `confirm_price:${suggested}`).row()
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
    .text("⚡ Maintenant",  "schedule:now").row()
    .text("📅 Dans 1h",     `schedule:${Date.now() + 3_600_000}`).row()
    .text("📅 Demain 9h",   "schedule:tomorrow");

  await ctx.editMessageText("🕐 Quand publier ?", { reply_markup: kb });
  await ctx.answerCallbackQuery();
});

// ─── Schedule → Create listing ────────────────────────────────────────────────

bot.callbackQuery(/^schedule:(.+)$/, async ctx => {
  const when  = ctx.callbackQuery.data.replace("schedule:", "");
  const draft = ctx.session.pendingListingDraft ?? {};

  let scheduledAt;
  if (when !== "now") {
    if (when === "tomorrow") {
      const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
      scheduledAt = d.toISOString();
    } else {
      scheduledAt = new Date(parseInt(when, 10)).toISOString();
    }
  }

  const res = await api.createListing({
    temuItemId: draft.temuItemId,
    variantId:  draft.variantId,
    accountId:  draft.accountId,
    priceEur:   draft.priceEur,
    ...(scheduledAt ? { scheduledAt } : {}),
  });

  // Réinitialiser la session de création
  ctx.session.state = "idle";
  ctx.session.pendingProduct      = undefined;
  ctx.session.pendingListingDraft = undefined;
  ctx.session.pendingVariantId    = undefined;

  if (!res.ok || !res.data) {
    await ctx.editMessageText(`❌ ${msg.escMd(res.error ?? "Erreur")}`, { parse_mode: "MarkdownV2" });
    return ctx.answerCallbackQuery();
  }

  await ctx.editMessageText(msg.fmtListing(res.data), { parse_mode: "MarkdownV2" });
  await ctx.answerCallbackQuery("✅ Annonce créée");
});

// ─── /dashboard — bouton Actualiser (Softnex) ─────────────────────────────────

async function replyDashboard(target, isEdit = false) {
  const res = await api.getDashboard();
  const text = res.ok && res.data
    ? msg.fmtDashboard(res.data)
    : "❌ Tableau de bord indisponible\\.";
  const kb = new InlineKeyboard()
    .text("🔄 Actualiser", "dashboard").text("🏠 Menu", "menu");
  const opts = { parse_mode: "MarkdownV2", reply_markup: kb };
  return isEdit ? target.editMessageText(text, opts) : target.reply(text, opts);
}

bot.command("dashboard", ctx => replyDashboard(ctx));
bot.callbackQuery("dashboard", async ctx => {
  await replyDashboard(ctx, true).catch(() => ctx.reply("❌ Actualisation impossible\\."));
  await ctx.answerCallbackQuery("Actualisé ✓");
});

// ─── /ventes ──────────────────────────────────────────────────────────────────

async function replyVentes(target, isEdit = false) {
  const res = await api.getActiveSales();
  if (!res.ok || !res.data?.length) {
    const text = "Aucune vente active\\.";
    return isEdit ? target.editMessageText(text, { parse_mode: "MarkdownV2" }) : target.reply(text, { parse_mode: "MarkdownV2" });
  }
  const lines = res.data.slice(0, 10).map(s => {
    const icon = s.leboncoinDeliveryConfirmed ? "✅" : s.manualActionRequired ? "⚠️" : "⏳";
    return `${icon} \`${s.saleId.slice(0, 10)}\` — ${msg.escMd(s.status)} — ${(s.salePriceEur ?? 0).toFixed(2)} €`;
  });
  const text = ["🛒 *Ventes actives*", ...lines].join("\n");
  const kb = new InlineKeyboard().text("🔄 Actualiser", "ventes").text("🏠 Menu", "menu");
  const opts = { parse_mode: "MarkdownV2", reply_markup: kb };
  return isEdit ? target.editMessageText(text, opts) : target.reply(text, opts);
}

bot.command("ventes", ctx => replyVentes(ctx));
bot.callbackQuery("ventes", async ctx => {
  await replyVentes(ctx, true).catch(() => {});
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
  return handleTracking(ctx, parts[0], parts[1], parts.slice(2).join(" "));
});

async function handleTracking(ctx, saleId, carrier, tracking) {
  if (!saleId || !tracking) return ctx.reply("❌ Format : `/suivi <id_vente> <transporteur> <numéro>`", { parse_mode: "MarkdownV2" });
  const res = await api.addTracking(saleId, { orderRef: "", trackingNumber: tracking, trackingCarrier: carrier });
  if (!res.ok || !res.data) return ctx.reply(`❌ ${msg.escMd(res.error ?? "")}`, { parse_mode: "MarkdownV2" });

  const syncRes = await api.syncTracking(saleId);
  const syncStatus = syncRes?.ok
    ? "✅ Transmis automatiquement à l'acheteur Leboncoin\\."
    : "⚠️ Transmission automatique échouée — à envoyer manuellement sur Leboncoin\\.";

  await ctx.reply(
    msg.fmtTrackingAdded(res.data) + "\n\n" + syncStatus,
    { parse_mode: "MarkdownV2" }
  );

  const saleData = await api.getSale(saleId);
  const titre    = saleData?.data?.productTitle ?? "Article";
  await sendVenduConfirm(ctx.chat.id, saleId, titre);
}

// ─── /bump — bumper les annonces (Softnex) ───────────────────────────────────

bot.command("bump", async ctx => {
  const kb = new InlineKeyboard()
    .text("⬆️ Bumper toutes les annonces", "confirm_bump").row()
    .text("❌ Annuler", "menu");
  await ctx.reply(
    "⬆️ *Bumper les annonces*\n_Remet toutes vos annonces LBC en tête de liste\\._",
    { parse_mode: "MarkdownV2", reply_markup: kb }
  );
});

bot.callbackQuery("bump_all", async ctx => {
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  const kb = new InlineKeyboard()
    .text("✅ Confirmer le bump", "confirm_bump").row()
    .text("❌ Annuler", "menu");
  await ctx.reply(
    "⬆️ Bumper toutes les annonces LBC ?",
    { parse_mode: "MarkdownV2", reply_markup: kb }
  );
  await ctx.answerCallbackQuery();
});

bot.callbackQuery("confirm_bump", async ctx => {
  await ctx.answerCallbackQuery("Bump en cours…");
  const res = await api.bumpAll().catch(() => null);
  const ok  = res?.ok;
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply(
    ok
      ? `⬆️ *Bump lancé \\!* ${msg.escMd(String(res.data?.jobsCreated ?? 0))} job\\(s\\) créé\\(s\\)\\.`
      : "⚠️ Bump échoué — relancez depuis le dashboard\\.",
    { parse_mode: "MarkdownV2" }
  );
});

// ─── /sync — forcer la synchronisation (Softnex) ─────────────────────────────

bot.command("sync", async ctx => {
  await ctx.reply("🔄 Synchronisation lancée…");
  const res = await api.syncAll().catch(() => null);
  const ok  = res?.ok;
  await ctx.reply(
    ok
      ? `🔄 *Sync terminée \\!* ${msg.escMd(String(res.data?.jobsCreated ?? 0))} job\\(s\\) créé\\(s\\)\\.`
      : "⚠️ Sync échouée — vérifiez les comptes dans le dashboard\\.",
    { parse_mode: "MarkdownV2" }
  );
});

bot.callbackQuery("sync_all", async ctx => {
  await ctx.answerCallbackQuery("Sync en cours…");
  const res = await api.syncAll().catch(() => null);
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply(
    res?.ok ? "🔄 *Synchronisation lancée\\.* " : "⚠️ Sync échouée\\.",
    { parse_mode: "MarkdownV2" }
  );
});

// ─── /agents — état des jobs (Softnex) ───────────────────────────────────────

async function replyAgents(target, isEdit = false) {
  const res = await api.getAgents().catch(() => null);
  let text;
  if (res?.ok && res.data) {
    const j = res.data;
    text = [
      "🤖 *État des agents*", "",
      `⏳ En attente : *${j.pending ?? 0}*`,
      `▶️ En cours : *${j.running ?? 0}*`,
      `✅ Terminés \\(24h\\) : *${j.done24h ?? 0}*`,
      `❌ Échoués \\(24h\\) : *${j.failed24h ?? 0}*`,
    ].join("\n");
  } else {
    text = "⚠️ Agents inaccessibles\\.";
  }
  const kb  = new InlineKeyboard().text("🔄 Actualiser", "agents").text("🏠 Menu", "menu");
  const opts = { parse_mode: "MarkdownV2", reply_markup: kb };
  return isEdit ? target.editMessageText(text, opts) : target.reply(text, opts);
}

bot.command("agents", ctx => replyAgents(ctx));
bot.callbackQuery("agents", async ctx => {
  await replyAgents(ctx, true).catch(() => {});
  await ctx.answerCallbackQuery();
});

// ─── Messages LBC (Softnex) ───────────────────────────────────────────────────

bot.callbackQuery("messages_lbc", async ctx => {
  await ctx.answerCallbackQuery();
  const res = await api.getUnreadMessages().catch(() => null);
  if (!res?.ok || !res.data?.length) {
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    await ctx.reply("💬 Aucun message non lu\\. ✅", { parse_mode: "MarkdownV2" });
    return;
  }
  const lines = res.data.slice(0, 5).map(m =>
    `💬 *${msg.escMd(m.senderName ?? "?")}* : _${msg.escMd((m.preview ?? "").slice(0, 60))}_`
  );
  const text = [`💬 *Messages non lus* \\(${res.data.length}\\)`, ...lines].join("\n");
  const kb   = new InlineKeyboard().text("🔄 Actualiser", "messages_lbc").text("🏠 Menu", "menu");
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply(text, { parse_mode: "MarkdownV2", reply_markup: kb });
});

// ─── Menu callback ────────────────────────────────────────────────────────────

bot.callbackQuery("menu", async ctx => {
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply(
    "🚀 *Hermès* — dropshipping Temu → Leboncoin",
    { parse_mode: "MarkdownV2", reply_markup: mainMenuKb() }
  );
  await ctx.answerCallbackQuery();
});

// ─── Sale alert : photo + OUI / NON ──────────────────────────────────────────

async function sendSaleAlert(chatId, { sale, productTitle, variantLabel, imageUrls = [], variantOptions = "" }) {
  const text = msg.fmtSaleAlert(sale, productTitle, variantLabel, variantOptions);
  const kb   = new InlineKeyboard()
    .text("✅ OUI, disponible", `avail_yes:${sale.saleId}`).row()
    .text("❌ NON, plus dispo",  `avail_no:${sale.saleId}`);

  const photoUrl = imageUrls?.[0];
  if (photoUrl) {
    try {
      await bot.api.sendPhoto(chatId, photoUrl, { caption: text, parse_mode: "MarkdownV2", reply_markup: kb });
      return;
    } catch (_) { /* fallback texte */ }
  }
  await bot.api.sendMessage(chatId, text, { parse_mode: "MarkdownV2", reply_markup: kb });
}

// ─── OUI → infos acheteur ────────────────────────────────────────────────────

bot.callbackQuery(/^avail_yes:(.+)$/, async ctx => {
  const saleId = ctx.callbackQuery.data.replace("avail_yes:", "");
  const res    = await api.getSale(saleId);
  if (!res.ok || !res.data) { await ctx.answerCallbackQuery("Vente introuvable"); return; }

  const sale = res.data;
  const info = [
    "✅ *Article disponible — infos acheteur*", "",
    sale.buyerName       ? `👤 Acheteur : ${msg.escMd(sale.buyerName)}`        : "",
    sale.deliveryAddress ? `📍 Adresse : ${msg.escMd(sale.deliveryAddress)}`   : "",
    `💰 Prix payé : *${msg.escMd((sale.salePriceEur ?? 0).toFixed(2))} €*`,
    sale.costEur != null ? `Coût estimé : ${msg.escMd(sale.costEur.toFixed(2))} €` : "",
    "",
    "🛒 *Lien fournisseur :*",
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

// ─── NON → annulation ────────────────────────────────────────────────────────

bot.callbackQuery(/^avail_no:(.+)$/, async ctx => {
  const saleId = ctx.callbackQuery.data.replace("avail_no:", "");
  await ctx.answerCallbackQuery("Annulation en cours…");

  const res     = await api.cancelSale(saleId);
  const okText  = res?.ok
    ? "✅ Annulation envoyée à l'acheteur sur Leboncoin \\(message automatique\\)\\."
    : "⚠️ Annulation enregistrée, message LBC à envoyer manuellement\\.";

  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply(`❌ *Vente annulée*\n\n${okText}`, { parse_mode: "MarkdownV2" });
});

// ─── VALIDER → bouton suivi ───────────────────────────────────────────────────

bot.callbackQuery(/^confirm_payment:(.+)$/, async ctx => {
  const saleId = ctx.callbackQuery.data.replace("confirm_payment:", "");
  const res    = await api.getSale(saleId);
  if (!res.ok || !res.data) { await ctx.answerCallbackQuery("Vente introuvable"); return; }

  const lines = [
    "✅ *Commande validée \\!*", "",
    `🔗 ${msg.escMd(res.data.supplierUrl ?? "Lien manquant")}`, "",
    "Dès que vous avez le numéro de suivi, appuyez sur le bouton ci\\-dessous\\.",
  ].join("\n");

  const kb = new InlineKeyboard().text("📦 Ajouter le numéro de suivi", `add_tracking:${saleId}`);

  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply(lines, { parse_mode: "MarkdownV2", reply_markup: kb });
  await ctx.answerCallbackQuery("✅ Commande enregistrée !");
});

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

  const carrierLabel = CARRIERS.find(([, c]) => c === carrier)?.[0] ?? carrier;
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply(
    `${carrierLabel} sélectionné\\.\n\n📬 Envoyez le *numéro de suivi* :`,
    { parse_mode: "MarkdownV2" }
  );
  await ctx.answerCallbackQuery();
});

// ─── Post-vente : Republier / Archiver / Annuler ──────────────────────────────

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
  const res   = await api.republishSale(saleId);
  const texte = res?.ok
    ? "✅ *Annonce republiée \\!*\nUne nouvelle annonce a été créée automatiquement\\."
    : "⚠️ Republication échouée — relancez manuellement depuis le dashboard\\.";
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply(texte, { parse_mode: "MarkdownV2" });
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
  const res   = await api.cancelSale(saleId);
  const texte = res?.ok
    ? "↩️ *Vente annulée\\.* L'annonce est de nouveau active sur Leboncoin\\."
    : "⚠️ Annulation enregistrée — vérifiez manuellement sur Leboncoin\\.";
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply(texte, { parse_mode: "MarkdownV2" });
});

// ─── Notifications push depuis l'API (Softnex) ───────────────────────────────

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

bot.catch(err => console.error("[bot]", err.message));

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { bot, sendSaleAlert, sendVenduConfirm, sendNotification };

// ─── Start ────────────────────────────────────────────────────────────────────

if (require.main === module) {
  bot.start();
  console.log("[bot] Hermès Telegram bot démarré (long polling)");
}
