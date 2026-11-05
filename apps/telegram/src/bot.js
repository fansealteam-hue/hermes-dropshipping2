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

// ─── Design Tyno (messages HTML) ──────────────────────────────────────────────

const h = (t) => String(t ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const eur = (n) => (n == null || isNaN(n) ? "—" : `${Number(n).toFixed(2).replace(".", ",")} €`);
const eur0 = (n) => `${Math.round(Math.abs(n))} €`;
const SHIP = parseFloat(process.env.TEMU_SHIPPING_FEE ?? "2.99");
const LINE = "━━━━━━━━━━━━━━";
const appUrl = () => (/^https:\/\//.test(config.miniAppUrl ?? "") ? `${config.miniAppUrl.replace(/\/$/, "")}/tg` : null);
const appButton = (label = "📱 Ouvrir Tyno") => (appUrl() ? new InlineKeyboard().webApp(label, appUrl()) : undefined);
function relDay(iso) {
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  const d = new Date(iso); const dd = new Date(d); dd.setHours(0, 0, 0, 0);
  const n = Math.round((d0 - dd) / 86_400_000);
  return n <= 0 ? `aujourd'hui ${d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}` : n === 1 ? "hier" : n === 2 ? "avant-hier" : n < 7 ? `il y a ${n} j` : d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}
/** Frise Payé → Commandé → Expédié → Reçu, comme sur le site. */
function stepsLine(s) {
  if (s.status === "cancelled") return "✅ Payé ─ ❌ Annulée";
  const lvl = ["confirmed", "order_placed", "tracking_added", "delivered"].indexOf(s.status);
  return ["Payé", "Commandé", "Expédié", "Reçu"].map((l, i) => `${i <= lvl ? "✅" : i === lvl + 1 ? "🟠" : "⚪"} ${l}`).join(" ─ ");
}

const MENU = [
  "📦 <b>Tyno Entreprise</b>",
  "Ton assistant dropshipping Temu → Leboncoin",
  LINE,
  "📊 /dashboard — chiffres du mois",
  "🛍️ /ventes — ventes en cours",
  "🔗 /lien — analyser un produit Temu",
  "🧾 /commande — référence de commande Temu",
  "📬 /suivi — numéro de suivi",
  "📱 /app — ouvrir l'application",
].join("\n");

bot.command(["start", "aide"], ctx => ctx.reply(MENU, { parse_mode: "HTML", reply_markup: appButton() }));

bot.command("app", ctx => appUrl()
  ? ctx.reply("📱 <b>Tyno Entreprise</b>\nTes ventes, tes achats Temu et tes comptes, dans Telegram.", { parse_mode: "HTML", reply_markup: appButton() })
  : ctx.reply("⚠️ L'application a besoin d'une adresse HTTPS : renseigne MINI_APP_URL (ex. https://tyno.mondomaine.fr) dans le fichier .env, puis redémarre le bot."));

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
  const [fin, dash] = await Promise.all([api.getFinance("30d"), api.getDashboard()]);
  if (!fin.ok || !dash.ok) return ctx.reply("❌ Tableau de bord indisponible pour le moment.");
  const s = fin.data.summary;
  const sales = dash.data.activeSales ?? [];
  const toOrder = sales.filter((x) => x.status === "confirmed").length;
  const waitTrk = sales.filter((x) => x.status === "order_placed").length;
  const action = (dash.data.salesNeedingAction ?? []).length;
  const net = s.marginEur - s.totalSales * SHIP;
  const lines = [
    "📊 <b>Tyno Entreprise · 30 jours</b>",
    LINE,
    `💶 Chiffre d'affaires : <b>${eur(s.revenueEur)}</b>`,
    `🛒 Achats Temu : ${eur(s.costEur + s.totalSales * SHIP)}`,
    `📈 Bénéfice net : <b>${eur(net)}</b>${s.revenueEur ? ` (${Math.round((net / s.revenueEur) * 100)} %)` : ""}`,
    `🛍️ Ventes : <b>${s.totalSales}</b>`,
    LINE,
    `${toOrder ? "🟠" : "✅"} À commander sur Temu : <b>${toOrder}</b>`,
    `${waitTrk ? "🟠" : "✅"} En attente du suivi : <b>${waitTrk}</b>`,
    `${action ? "⚠️" : "✅"} À traiter : <b>${action}</b>`,
  ];
  return ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: appButton("📱 Tout voir dans Tyno") });
});

// ─── /ventes ──────────────────────────────────────────────────────────────────

bot.command("ventes", async ctx => {
  const [res, lst, acc, inv] = await Promise.all([api.getActiveSales(), api.getListings(), api.getAccountsStats(), api.getInvoices()]);
  if (!res.ok) return ctx.reply("❌ Ventes indisponibles pour le moment.");
  const sales = (res.data ?? []).filter((s) => s.status !== "delivered" && s.status !== "cancelled");
  if (!sales.length) return ctx.reply("✅ Aucune vente en attente : tout est livré.", { reply_markup: appButton() });
  const titleOf = Object.fromEntries((lst.data ?? []).map((l) => [l.listing_id, l.title || l.product_title]));
  const accOf = Object.fromEntries((acc.data ?? []).map((a) => [a.accountId, a.label]));
  const invOf = Object.fromEntries((inv.data ?? []).filter((i) => i.kind === "invoice").map((i) => [i.saleId, i.invoiceNo]));
  const cards = sales.slice(0, 8).map((s) => {
    const profit = s.salePriceEur - (s.actualCostEur ?? s.costEur) - SHIP;
    return [
      `<b>${h(titleOf[s.listingId] ?? "Produit")}</b>`,
      `🏪 ${h(accOf[s.accountId] ?? s.accountId)} · ${relDay(s.confirmedAt)}`,
      stepsLine(s),
      `🕐 En attente · <b>+${eur0(profit)}</b>${invOf[s.saleId] ? ` · 🧾 <code>${h(invOf[s.saleId])}</code>` : ""}${s.manualActionRequired ? "\n⚠️ " + h(s.manualActionNote ?? "Action requise") : ""}`,
    ].join("\n");
  });
  const more = sales.length > 8 ? `\n${LINE}\n+ ${sales.length - 8} autre(s) dans l'application` : "";
  return ctx.reply([`🛍️ <b>Ventes en attente · ${sales.length}</b>`, LINE, cards.join(`\n${LINE}\n`)].join("\n") + more, { parse_mode: "HTML", reply_markup: appButton("📱 Ouvrir les ventes") });
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

  return ctx.reply(
    msg.fmtTrackingAdded(res.data) + "\n\n" + syncStatus,
    { parse_mode: "MarkdownV2" }
  );
}

// ─── Error handler ────────────────────────────────────────────────────────────

bot.catch(err => console.error("[bot]", err.message));

// ─── Sale alert : photo + OUI DISPONIBLE / NON PLUS DISPO ────────────────────

async function sendSaleAlert(chatId, { sale, productTitle, variantLabel, imageUrls = [], variantOptions = "" }) {
  const text = msg.fmtSaleAlert(sale, productTitle, variantLabel, variantOptions);
  const kb = new InlineKeyboard()
    .text("✅ Disponible", `avail_yes:${sale.saleId}`)
    .text("❌ Pas disponible", `cancel_ask:${sale.saleId}`).row()
    .text("🔄 Revérifier le stock Temu", `check_stock:${sale.saleId}`);

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
    "1️⃣ Commande sur Temu avec l'adresse de l'acheteur",
    "2️⃣ Puis appuie sur *VALIDER*",
  ].filter(Boolean).join("\n");

  const kb = new InlineKeyboard();
  if (/^https:\/\//.test(sale.supplierUrl ?? "")) kb.url("🛒 Commander sur Temu", sale.supplierUrl).row();
  kb.text("✅ VALIDER — j'ai commandé", `confirm_payment:${saleId}`).row()
    .text("❌ Finalement annuler", `cancel_ask:${saleId}`);

  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply(info, { parse_mode: "MarkdownV2", reply_markup: kb });
  await ctx.answerCallbackQuery("Article disponible ✅");
});

// ─── Revérifier le stock Temu ────────────────────────────────────────────────

bot.callbackQuery(/^check_stock:(.+)$/, async ctx => {
  const saleId = ctx.callbackQuery.data.replace("check_stock:", "");
  await ctx.answerCallbackQuery("Vérification sur Temu…");
  const res = await api.checkAvailability(saleId);
  if (!res.ok || !res.data) {
    await ctx.reply(`⚠️ Impossible de vérifier : ${res.error ?? "erreur"}`);
    return;
  }
  const a = res.data;
  const esc = (t) => String(t ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const eur = (n) => (n == null ? "?" : `${n.toFixed(2).replace(".", ",")} €`);
  const line = a.available === null ? "❔ Stock inconnu"
    : a.available ? `🟢 <b>Disponible</b> — ${a.stock} en stock` : "🔴 <b>Rupture de stock</b>";
  const lines = [
    `📦 <b>${esc(a.productTitle)}</b>${a.variantLabel ? ` · ${esc(a.variantLabel)}` : ""}`,
    line,
    a.costChanged ? `⚠️ Prix Temu : ${eur(a.costAtSaleEur)} → <b>${eur(a.currentCostEur)}</b>` : `Prix Temu : ${eur(a.currentCostEur ?? a.costAtSaleEur)}`,
    a.error ? `<i>Lecture Temu impossible (${esc(a.error)}) — données du ${esc(a.checkedAt ?? "?")}</i>` : "<i>Vérifié à l'instant</i>",
  ];
  const kb = new InlineKeyboard()
    .text("✅ Disponible", `avail_yes:${saleId}`)
    .text("❌ Pas disponible", `cancel_ask:${saleId}`);
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
});

// ─── Annuler → confirmation (l'annulation prévient l'acheteur) ───────────────

bot.callbackQuery(/^cancel_ask:(.+)$/, async ctx => {
  const saleId = ctx.callbackQuery.data.replace("cancel_ask:", "");
  const kb = new InlineKeyboard()
    .text("Oui, annuler et prévenir l'acheteur", `avail_no:${saleId}`).row()
    .text("Non, garder la vente", `cancel_keep:${saleId}`);
  await ctx.answerCallbackQuery();
  await ctx.reply("❌ Article pas disponible ? La vente sera annulée et l'acheteur prévenu sur Leboncoin.", { reply_markup: kb });
});

bot.callbackQuery(/^cancel_keep:(.+)$/, async ctx => {
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.answerCallbackQuery("Vente conservée 👍");
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
  // Enregistre la commande Temu → la vente passe en « Commandée » sur le dashboard
  const ord = await api.markOrdered(saleId);
  if (!ord.ok) { await ctx.answerCallbackQuery(`Erreur : ${ord.error ?? "commande non enregistrée"}`); return; }
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

module.exports = { bot, sendSaleAlert, stepsLine, relDay };

// ─── Start ────────────────────────────────────────────────────────────────────

if (require.main === module) {
  if (!config.botToken) { console.error("[bot] TELEGRAM_BOT_TOKEN manquant"); process.exit(1); }
  // Bouton « Tyno » à côté du champ de saisie (ouvre la mini-app) + liste des commandes
  if (appUrl()) bot.api.setChatMenuButton({ menu_button: { type: "web_app", text: "Tyno", web_app: { url: appUrl() } } }).catch((e) => console.warn("[bot] menu app:", e.message));
  bot.api.setMyCommands([
    { command: "dashboard", description: "Chiffres du mois" }, { command: "ventes", description: "Ventes en cours" },
    { command: "app", description: "Ouvrir l'application" }, { command: "lien", description: "Analyser un produit Temu" },
    { command: "commande", description: "Référence de commande Temu" }, { command: "suivi", description: "Numéro de suivi" },
  ]).catch(() => {});
  bot.start();
  console.log("[bot] Tyno Entreprise — bot Telegram démarré (long polling)");
}
