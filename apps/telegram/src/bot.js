/**
 * Hermès Telegram Bot — JavaScript runtime (no TS compilation needed on VPS).
 */
require("dotenv").config();
const { Bot, InlineKeyboard, Keyboard, session } = require("grammy");
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

// Boutons permanents en bas de Telegram (aucune commande à taper)
const BTN = {
  dash: "📊 Tableau de bord", sales: "🛍️ Ventes", order: "🛒 À commander",
  track: "📬 Ajouter un suivi", product: "🔗 Nouveau produit", app: "📱 Ouvrir Tyno",
};
function mainKeyboard() {
  const kb = new Keyboard().text(BTN.dash).text(BTN.sales).row().text(BTN.order).text(BTN.track).row().text(BTN.product);
  if (appUrl()) kb.webApp(BTN.app, appUrl());
  return kb.resized().persistent();
}
const navButtons = () => new InlineKeyboard().text("📊 Tableau", "nav:dash").text("🛍️ Ventes", "nav:sales").text("🛒 À commander", "nav:order");

const MENU = [
  "📦 <b>Tyno Entreprise</b>",
  "Ton assistant dropshipping Temu → Leboncoin",
  LINE,
  "Tout se fait avec les <b>boutons en bas</b> 👇",
  "Les nouvelles ventes arrivent ici toutes seules.",
].join("\n");

const showMenu = (ctx) => ctx.reply(MENU, { parse_mode: "HTML", reply_markup: mainKeyboard() });
bot.command(["start", "aide", "menu"], showMenu);

async function openApp(ctx) {
  return appUrl()
    ? ctx.reply("📱 <b>Tyno Entreprise</b>\nTes ventes, tes achats Temu et tes comptes, dans Telegram.", { parse_mode: "HTML", reply_markup: appButton() })
    : ctx.reply("⚠️ L'application a besoin d'une adresse HTTPS : renseigne MINI_APP_URL (ex. https://tyno.mondomaine.fr) dans le fichier .env, puis redémarre le bot.");
}
bot.command("app", openApp);

// ─── /lien ────────────────────────────────────────────────────────────────────

async function askProduct(ctx) { ctx.session.state = "awaiting_temu_link"; return ctx.reply("🔗 Colle le lien du produit Temu 👇"); }
bot.command("lien", async ctx => {
  const url = ctx.match?.trim();
  return url ? handleTemuUrl(ctx, url) : askProduct(ctx);
});

// ─── Free text router ─────────────────────────────────────────────────────────

bot.on("message:text", async ctx => {
  const text = ctx.message.text.trim();
  const BTN_ACTIONS = {
    [BTN.dash]: showDashboard, [BTN.sales]: showSales, [BTN.order]: showToOrder,
    [BTN.track]: showTrackingList, [BTN.product]: askProduct, [BTN.app]: openApp,
  };
  if (BTN_ACTIONS[text]) { ctx.session.state = "idle"; return BTN_ACTIONS[text](ctx); }
  const { state } = ctx.session;

  if (state === "awaiting_temu_link") { ctx.session.state = "idle"; return handleTemuUrl(ctx, text); }
  if (state === "awaiting_order_ref")  { ctx.session.state = "idle"; const [id, ref] = text.split(" "); return handleOrderRef(ctx, id, ref); }
  if (state === "awaiting_tracking")   { ctx.session.state = "idle"; const [id, carrier, num] = text.split(" "); return handleTracking(ctx, id, carrier, num); }
  if (state === "awaiting_tracking_inline") {
    ctx.session.state = "idle";
    const saleId = ctx.session.pendingTrackingSaleId;
    ctx.session.pendingTrackingSaleId = undefined;
    const { carrier, number } = parseTracking(text);
    return handleTracking(ctx, saleId, carrier, number);
  }
  // Message libre : un lien Temu lance l'analyse, sinon on remontre les boutons
  if (/temu\.com/i.test(text)) return handleTemuUrl(ctx, text);
  return ctx.reply("👇 Utilise les boutons en bas pour tout faire.", { reply_markup: mainKeyboard() });
});

/** « LX123456789FR » ou « Colissimo LX123456789FR » → transporteur deviné si absent. */
function parseTracking(text) {
  const parts = String(text).trim().split(/\s+/).filter(Boolean);
  const number = (parts.find((p) => /\d/.test(p) && p.length >= 6) ?? parts.at(-1) ?? "").toUpperCase();
  const named = parts.filter((p) => p.toUpperCase() !== number).join(" ");
  let carrier = named || "";
  if (!carrier) {
    if (/^[A-Z]{2}\d{9}FR$/.test(number)) carrier = /^(6|8|C|L)/.test(number) ? "Colissimo" : "La Poste";
    else if (/^\d{8}$/.test(number) || /^\d{12}$/.test(number)) carrier = "Mondial Relay";
    else if (/^1Z/.test(number)) carrier = "UPS";
    else if (/^(XW|XY|XS)\d+/.test(number)) carrier = "Chronopost";
    else if (/^(YT|YW)\d+/.test(number)) carrier = "Yanwen";
    else if (/^(LP|CN)\d+/.test(number)) carrier = "Cainiao";
  }
  return { carrier, number };
}

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

async function showDashboard(ctx) {
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
  const kb = new InlineKeyboard();
  if (toOrder) kb.text(`🛒 Commander (${toOrder})`, "nav:order");
  if (waitTrk) kb.text(`📬 Ajouter les suivis (${waitTrk})`, "nav:track");
  kb.row().text("🛍️ Voir les ventes", "nav:sales");
  if (appUrl()) kb.webApp("📱 Tyno", appUrl());
  return ctx.reply(lines.join("\n"), { parse_mode: "HTML", reply_markup: kb });
}
bot.command("dashboard", showDashboard);

// ─── /ventes ──────────────────────────────────────────────────────────────────

async function showSales(ctx) {
  const [res, lst, acc, inv] = await Promise.all([api.getActiveSales(), api.getListings(), api.getAccountsStats(), api.getInvoices()]);
  if (!res.ok) return ctx.reply("❌ Ventes indisponibles pour le moment.");
  const sales = (res.data ?? []).filter((s) => s.status !== "delivered" && s.status !== "cancelled");
  if (!sales.length) return ctx.reply("✅ Aucune vente en attente : tout est livré.", { reply_markup: navButtons() });
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
  const kb = new InlineKeyboard();
  const toOrder = sales.filter((s) => s.status === "confirmed").length, waitTrk = sales.filter((s) => s.status === "order_placed").length;
  if (toOrder) kb.text(`🛒 Commander (${toOrder})`, "nav:order");
  if (waitTrk) kb.text(`📬 Ajouter les suivis (${waitTrk})`, "nav:track");
  if (appUrl()) kb.row().webApp("📱 Tout voir dans Tyno", appUrl());
  return ctx.reply([`🛍️ <b>Ventes en attente · ${sales.length}</b>`, LINE, cards.join(`\n${LINE}\n`)].join("\n") + more, { parse_mode: "HTML", reply_markup: kb });
}
bot.command("ventes", showSales);

// ─── /acommander : tout valider d'un coup ─────────────────────────────────────

async function showToOrder(ctx) {
  const [res, lst, acc] = await Promise.all([api.getActiveSales(), api.getListings(), api.getAccountsStats()]);
  if (!res.ok) return ctx.reply("❌ Ventes indisponibles pour le moment.");
  const todo = (res.data ?? []).filter((s) => s.status === "confirmed").sort((a, b) => a.confirmedAt.localeCompare(b.confirmedAt));
  if (!todo.length) return ctx.reply("✅ Rien à commander sur Temu : tout est à jour.", { reply_markup: navButtons() });
  ctx.session.bulkIds = todo.map((s) => s.saleId);
  const titleOf = Object.fromEntries((lst.data ?? []).map((l) => [l.listing_id, l.title || l.product_title]));
  const accOf = Object.fromEntries((acc.data ?? []).map((a) => [a.accountId, a.label]));
  const total = todo.reduce((t, s) => t + s.costEur + SHIP, 0);
  const lines = todo.slice(0, 12).map((s, i) => [
    `<b>${i + 1}. ${h(titleOf[s.listingId] ?? "Produit")}</b>`,
    `   🏪 ${h(accOf[s.accountId] ?? s.accountId)} · 👤 ${h(s.buyerName ?? "Acheteur")}${s.deliveryAddress ? `, ${h(s.deliveryAddress)}` : ""}`,
    `   💶 ${eur(s.salePriceEur)} · 🛒 Temu ${eur(s.costEur + SHIP)} · ${relDay(s.confirmedAt)}`,
  ].join("\n"));
  const kb = new InlineKeyboard();
  todo.slice(0, 12).forEach((s, i) => {
    if (/^https:\/\//.test(s.supplierUrl ?? "")) kb.url(`🛒 ${i + 1} · Temu`, s.supplierUrl);
    kb.text(`✅ ${i + 1} commandé`, `order_one:${s.saleId}`).row();
  });
  if (todo.length > 1) kb.text(`✅ Tout est commandé (${todo.length})`, "bulk_ordered");
  return ctx.reply([
    `🛒 <b>À commander sur Temu · ${todo.length}</b>`, LINE, lines.join("\n\n"),
    todo.length > 12 ? `\n+ ${todo.length - 12} autre(s)` : "", LINE,
    `💳 Total à payer sur Temu : <b>${eur(total)}</b>`,
    "Commande avec les boutons 🛒, puis valide une par une ou tout d'un coup 👇",
  ].filter(Boolean).join("\n"), { parse_mode: "HTML", reply_markup: kb });
}
bot.command(["acommander", "valider"], showToOrder);

// Valider une seule vente depuis la liste
bot.callbackQuery(/^order_one:(.+)$/, async ctx => {
  const saleId = ctx.callbackQuery.data.replace("order_one:", "");
  const r = await api.markOrdered(saleId);
  if (!r.ok) { await ctx.answerCallbackQuery(`Erreur : ${r.error ?? "non enregistré"}`); return; }
  ctx.session.bulkIds = (ctx.session.bulkIds ?? []).filter((x) => x !== saleId);
  await ctx.answerCallbackQuery("✅ Commandée — pense au suivi");
});

bot.callbackQuery("bulk_ordered", async ctx => {
  const ids = ctx.session.bulkIds ?? [];
  if (!ids.length) { await ctx.answerCallbackQuery("Liste expirée : relance /acommander"); return; }
  const r = await api.markOrderedBulk(ids);
  if (!r.ok) { await ctx.answerCallbackQuery(`Erreur : ${r.error ?? "non enregistré"}`); return; }
  ctx.session.bulkIds = [];
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.answerCallbackQuery(`✅ ${r.data.done.length} validée(s)`);
  await ctx.reply([
    `✅ <b>${r.data.done.length} vente${r.data.done.length > 1 ? "s" : ""} passée${r.data.done.length > 1 ? "s" : ""} en « Commandée »</b>`,
    r.data.skipped.length ? `${r.data.skipped.length} déjà traitée(s) entre-temps.` : "",
    "📬 Ajoute les numéros de suivi dès que Temu les donne : l'acheteur reçoit ton message d'expédition automatiquement (rappel si oubli).",
  ].filter(Boolean).join("\n"), { parse_mode: "HTML" });
});

// ─── Ajouter un suivi : choisir la vente avec un bouton ───────────────────────

async function showTrackingList(ctx) {
  const [res, lst] = await Promise.all([api.getActiveSales(), api.getListings()]);
  if (!res.ok) return ctx.reply("❌ Ventes indisponibles pour le moment.");
  const waiting = (res.data ?? []).filter((s) => s.status === "order_placed" && !s.trackingNumber)
    .sort((a, b) => (a.orderPlacedAt ?? a.confirmedAt).localeCompare(b.orderPlacedAt ?? b.confirmedAt));
  if (!waiting.length) return ctx.reply("✅ Aucune commande en attente de suivi.", { reply_markup: navButtons() });
  const titleOf = Object.fromEntries((lst.data ?? []).map((l) => [l.listing_id, l.title || l.product_title]));
  const kb = new InlineKeyboard();
  waiting.slice(0, 15).forEach((s) => {
    const t = (titleOf[s.listingId] ?? "Produit").slice(0, 26);
    kb.text(`📦 ${t} · ${s.buyerName ?? "acheteur"}`, `add_tracking:${s.saleId}`).row();
  });
  return ctx.reply(`📬 <b>Ajouter un numéro de suivi</b>\nChoisis la commande (${waiting.length} en attente) 👇`, { parse_mode: "HTML", reply_markup: kb });
}

// Navigation par boutons (sous les messages)
bot.callbackQuery(/^nav:(\w+)$/, async ctx => {
  await ctx.answerCallbackQuery();
  const k = ctx.callbackQuery.data.slice(4);
  return ({ dash: showDashboard, sales: showSales, order: showToOrder, track: showTrackingList })[k]?.(ctx);
});

// Boutons permanents
bot.hears(BTN.dash, showDashboard);
bot.hears(BTN.sales, showSales);
bot.hears(BTN.order, showToOrder);
bot.hears(BTN.track, showTrackingList);
bot.hears(BTN.product, askProduct);
bot.hears(BTN.app, openApp);

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
  if (!saleId || !tracking) return ctx.reply("❌ Numéro de suivi manquant : appuie sur « 📬 Ajouter un suivi » et colle le numéro.", { reply_markup: mainKeyboard() });
  const res = await api.addTracking(saleId, { orderRef: "", trackingNumber: tracking, trackingCarrier: carrier || undefined });
  if (!res.ok || !res.data) return ctx.reply(`❌ ${msg.escMd(res.error ?? "")}`, { parse_mode: "MarkdownV2" });

  // Auto-transmission du suivi à l'acheteur Leboncoin via le job queue
  const syncRes = await api.syncTracking(saleId);
  const syncStatus = syncRes?.ok
    ? "✅ Transmis automatiquement à l'acheteur Leboncoin\\."
    : "⚠️ Transmission automatique échouée — à envoyer manuellement sur Leboncoin\\.";

  const card = ctx.session.trackingCard;
  ctx.session.trackingCard = null;
  if (card && String(ctx.session.pendingTrackingSaleId ?? saleId) === String(saleId)) {
    const line = `📬 Expédié · ${carrier ? `${carrier} ` : ""}${tracking}\n${syncRes?.ok ? "✅ Suivi envoyé à l'acheteur sur Leboncoin" : "⚠️ Suivi à envoyer à la main sur Leboncoin"}`;
    if (await updateCard(ctx, card, `${STEPS.shipped}\n${line}`)) return ctx.reply("✅ Suivi ajouté — la fiche de la vente est à jour ☝️", { reply_markup: mainKeyboard() });
  }
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

// ─── Fiche de vente : UN message (photo + infos + boutons) mis à jour en place ─
const SEP = "━━━━━━━━━━━━━━";
const STEPS = {
  ordered: "✅ Payé ─ ✅ Commandé ─ 🟠 Expédié ─ ⚪ Reçu",
  toOrder: "✅ Payé ─ 🟠 Commandé ─ ⚪ Expédié ─ ⚪ Reçu",
  shipped: "✅ Payé ─ ✅ Commandé ─ ✅ Expédié ─ 🟠 Reçu",
  cancelled: "✅ Payé ─ ❌ Annulée",
};
/** Copie minimale d'un message (pour le retrouver plus tard, ex. après le suivi). */
function cardRef(m) {
  if (!m) return null;
  const photo = Array.isArray(m.photo) && m.photo.length > 0;
  return { chatId: m.chat.id, messageId: m.message_id, photo,
    body: (photo ? m.caption : m.text) ?? "", entities: (photo ? m.caption_entities : m.entities) ?? [] };
}
/** Remplace le bloc statut (après le dernier séparateur) en gardant le gras/liens au-dessus. */
function cardText(card, status) {
  const i = card.body.lastIndexOf(SEP);
  const head = i >= 0 ? card.body.slice(0, i + SEP.length) : `${card.body}\n${SEP}`;
  const max = card.photo ? 1024 : 4096;
  return { text: `${head}\n${status}`.slice(0, max), entities: card.entities.filter((e) => e.offset + e.length <= head.length) };
}
async function updateCard(ctx, card, status, kb) {
  if (!card) return false;
  const { text, entities } = cardText(card, status);
  const reply_markup = kb ?? { inline_keyboard: [] };
  try {
    if (card.photo) await ctx.api.editMessageCaption(card.chatId, card.messageId, { caption: text, caption_entities: entities, reply_markup });
    else await ctx.api.editMessageText(card.chatId, card.messageId, text, { entities, reply_markup, link_preview_options: { is_disabled: true } });
    card.body = text; card.entities = entities;
    return true;
  } catch (e) {
    return /not modified/i.test(e?.description ?? e?.message ?? "");
  }
}
const orderKb = (saleId, url) => {
  const kb = new InlineKeyboard();
  if (/^https:\/\//.test(url ?? "")) kb.url("🛒 Commander sur Temu", url).row();
  return kb.text("✅ J'ai commandé", `confirm_payment:${saleId}`).text("❌ Annuler", `cancel_ask:${saleId}`);
};

// ─── OUI disponible → la fiche passe en « à commander » ───────────────────────

bot.callbackQuery(/^avail_yes:(.+)$/, async ctx => {
  const saleId = ctx.callbackQuery.data.replace("avail_yes:", "");
  const res = await api.getSale(saleId);
  if (!res.ok || !res.data) { await ctx.answerCallbackQuery("Vente introuvable"); return; }
  const sale = res.data;
  const status = [STEPS.toOrder, "👍 Disponible → commande sur Temu avec ces infos :",
    sale.buyerName ? `👤 ${sale.buyerName}` : "", sale.deliveryAddress ? `📍 ${sale.deliveryAddress}` : ""].filter(Boolean).join("\n");
  const ok = await updateCard(ctx, cardRef(ctx.callbackQuery.message), status, orderKb(saleId, sale.supplierUrl));
  if (!ok) await ctx.reply(status, { reply_markup: orderKb(saleId, sale.supplierUrl) });
  await ctx.answerCallbackQuery("Disponible ✅ — à commander");
});

// ─── Revérifier le stock Temu → petite fenêtre, la fiche reste propre ────────

bot.callbackQuery(/^check_stock:(.+)$/, async ctx => {
  const saleId = ctx.callbackQuery.data.replace("check_stock:", "");
  const res = await api.checkAvailability(saleId);
  if (!res.ok || !res.data) { await ctx.answerCallbackQuery({ text: `⚠️ Impossible de vérifier : ${res.error ?? "erreur"}`, show_alert: true }); return; }
  const a = res.data;
  const eur = (n) => (n == null ? "?" : `${n.toFixed(2).replace(".", ",")} €`);
  const lines = [
    a.available === null ? "❔ Stock inconnu" : a.available ? `🟢 Disponible — ${a.stock} en stock` : "🔴 Rupture de stock",
    a.costChanged ? `⚠️ Prix Temu : ${eur(a.costAtSaleEur)} → ${eur(a.currentCostEur)}` : `Prix Temu : ${eur(a.currentCostEur ?? a.costAtSaleEur)}`,
    a.error ? "(Temu illisible, dernières données connues)" : "Vérifié à l'instant",
  ];
  await ctx.answerCallbackQuery({ text: lines.join("\n").slice(0, 200), show_alert: true });
});

// ─── NON → confirmation dans la même fiche ───────────────────────────────────

bot.callbackQuery(/^cancel_ask:(.+)$/, async ctx => {
  const saleId = ctx.callbackQuery.data.replace("cancel_ask:", "");
  const kb = new InlineKeyboard()
    .text("❌ Oui, annuler la vente", `avail_no:${saleId}`).row()
    .text("↩️ Non, garder la vente", `cancel_keep:${saleId}`);
  await ctx.editMessageReplyMarkup({ reply_markup: kb }).catch(() => ctx.reply("Annuler la vente ? L'acheteur sera prévenu sur Leboncoin.", { reply_markup: kb }));
  await ctx.answerCallbackQuery("L'acheteur sera prévenu sur Leboncoin");
});

bot.callbackQuery(/^cancel_keep:(.+)$/, async ctx => {
  const saleId = ctx.callbackQuery.data.replace("cancel_keep:", "");
  const res = await api.getSale(saleId);
  const sale = res?.data ?? {};
  const kb = sale.status === "order_placed" ? new InlineKeyboard().text("📬 Ajouter le suivi", `add_tracking:${saleId}`) : orderKb(saleId, sale.supplierUrl);
  await ctx.editMessageReplyMarkup({ reply_markup: kb }).catch(() => {});
  await ctx.answerCallbackQuery("Vente conservée 👍");
});

bot.callbackQuery(/^avail_no:(.+)$/, async ctx => {
  const saleId = ctx.callbackQuery.data.replace("avail_no:", "");
  await ctx.answerCallbackQuery("Annulation en cours…");
  const res = await api.cancelSale(saleId);
  const status = [STEPS.cancelled, res?.ok ? "❌ Vente annulée · acheteur prévenu sur Leboncoin" : "⚠️ Annulée — message Leboncoin à envoyer à la main"].join("\n");
  const ok = await updateCard(ctx, cardRef(ctx.callbackQuery.message), status);
  if (!ok) await ctx.reply(status);
});

// ─── J'ai commandé → la fiche passe en « commandé » + bouton suivi ───────────

bot.callbackQuery(/^confirm_payment:(.+)$/, async ctx => {
  const saleId = ctx.callbackQuery.data.replace("confirm_payment:", "");
  const ord = await api.markOrdered(saleId);
  if (!ord.ok) { await ctx.answerCallbackQuery(`Erreur : ${ord.error ?? "commande non enregistrée"}`); return; }
  const kb = new InlineKeyboard().text("📬 Ajouter le numéro de suivi", `add_tracking:${saleId}`);
  const status = `${STEPS.ordered}\n🛒 Commandé sur Temu · en attente du suivi`;
  const ok = await updateCard(ctx, cardRef(ctx.callbackQuery.message), status, kb);
  if (!ok) await ctx.reply(status, { reply_markup: kb });
  await ctx.answerCallbackQuery("✅ Commande enregistrée !");
});

// ─── Ajouter le suivi → on retient la fiche pour la mettre à jour ensuite ────

bot.callbackQuery(/^add_tracking:(.+)$/, async ctx => {
  const saleId = ctx.callbackQuery.data.replace("add_tracking:", "");
  ctx.session.state = "awaiting_tracking_inline";
  ctx.session.pendingTrackingSaleId = saleId;
  const m = ctx.callbackQuery.message;
  ctx.session.trackingCard = m && (m.photo || (m.text ?? "").includes(SEP)) ? cardRef(m) : null;
  await ctx.reply("📬 Colle le <b>numéro de suivi</b> 👇\n<i>Le transporteur est reconnu tout seul.</i>", { parse_mode: "HTML" });
  await ctx.answerCallbackQuery();
});

module.exports = { bot, sendSaleAlert, stepsLine, relDay, parseTracking, mainKeyboard, BTN, cardRef, cardText, SEP };

// ─── Start ────────────────────────────────────────────────────────────────────

if (require.main === module) {
  if (!config.botToken) { console.error("[bot] TELEGRAM_BOT_TOKEN manquant"); process.exit(1); }
  // Bouton « Tyno » à côté du champ de saisie (ouvre la mini-app) + liste des commandes
  if (appUrl()) bot.api.setChatMenuButton({ menu_button: { type: "web_app", text: "Tyno", web_app: { url: appUrl() } } }).catch((e) => console.warn("[bot] menu app:", e.message));
  // Tout passe par les boutons : on retire la liste des commandes « / »
  bot.api.deleteMyCommands().catch(() => {});
  if (!appUrl()) bot.api.setChatMenuButton({ menu_button: { type: "default" } }).catch(() => {});
  bot.start();
  console.log("[bot] Tyno Entreprise — bot Telegram démarré (long polling)");
}
