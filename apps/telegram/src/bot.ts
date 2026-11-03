import { Bot, InlineKeyboard, session } from "grammy";
import type { BotSession } from "../../packages/shared/src/types";
import { config, isAllowed } from "./config";
import {
  fetchTemuProduct,
  createListing,
  getDashboard,
  getLeboncoinAccounts,
  addTracking,
} from "./api";
import {
  fmtProduct,
  fmtVariant,
  fmtSaleAlert,
  fmtTrackingAdded,
  fmtDashboard,
  fmtListing,
  escMd,
} from "./messages";

// ─── Session storage (in-memory; Claude 1 will wire a persistent store) ───────

type SessionData = Omit<BotSession, "chatId">;

function initial(): SessionData {
  return { state: "idle", updatedAt: new Date().toISOString() };
}

const bot = new Bot<{ session: SessionData }>(config.botToken);
bot.use(session({ initial }));

// ─── Auth guard ───────────────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  const chatId = ctx.chat?.id ?? 0;
  if (!isAllowed(chatId)) {
    await ctx.reply("⛔ Accès non autorisé.");
    return;
  }
  await next();
});

// ─── /start ───────────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  await ctx.reply(
    [
      "👋 *Hermès* — votre assistant dropshipping",
      "",
      "Commandes disponibles :",
      "/lien — soumettre un lien Temu",
      "/dashboard — voir le tableau de bord",
      "/commande — saisir une référence commande",
      "/suivi — ajouter un numéro de suivi",
      "/ventes — ventes actives",
      "/aide — afficher ce menu",
    ].join("\n"),
    { parse_mode: "MarkdownV2" }
  );
});

bot.command("aide", (ctx) => ctx.reply(
  [
    "📖 *Aide Hermès*",
    "",
    "/lien `<url>` — analyser un produit Temu",
    "/dashboard — tableau de bord global",
    "/commande `<id_vente> <ref>` — enregistrer référence fournisseur",
    "/suivi `<id_vente> <transporteur> <numéro>` — ajouter suivi",
    "/ventes — lister les ventes en cours",
  ].join("\n"),
  { parse_mode: "MarkdownV2" }
));

// ─── /lien — submit Temu URL ──────────────────────────────────────────────────

bot.command("lien", async (ctx) => {
  const url = ctx.match?.trim();
  if (!url) {
    ctx.session.state = "awaiting_temu_link";
    await ctx.reply("📎 Envoyez le lien Temu :");
    return;
  }
  await handleTemuUrl(ctx, url);
});

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();

  if (ctx.session.state === "awaiting_temu_link") {
    ctx.session.state = "idle";
    await handleTemuUrl(ctx, text);
    return;
  }

  if (ctx.session.state === "awaiting_order_ref") {
    ctx.session.state = "idle";
    const [saleId, ref] = text.split(" ");
    await handleOrderRef(ctx, saleId, ref);
    return;
  }

  if (ctx.session.state === "awaiting_tracking") {
    ctx.session.state = "idle";
    const parts = text.split(" ");
    await handleTracking(ctx, parts[0], parts[1], parts[2]);
    return;
  }
});

async function handleTemuUrl(ctx: any, url: string) {
  if (!url.includes("temu.com") && !url.includes("tem.com")) {
    await ctx.reply("❌ Ce lien ne ressemble pas à un produit Temu\\.", { parse_mode: "MarkdownV2" });
    return;
  }

  const msg = await ctx.reply("⏳ Récupération du produit…");
  const res = await fetchTemuProduct(url);

  if (!res.ok || !res.data) {
    await ctx.api.editMessageText(ctx.chat!.id, msg.message_id, `❌ Erreur : ${escMd(res.error ?? "inconnu")}`, { parse_mode: "MarkdownV2" });
    return;
  }

  const product = res.data;

  if (product.warehouseStatus !== "local") {
    await ctx.api.editMessageText(
      ctx.chat!.id,
      msg.message_id,
      `${escMd(fmtProduct(product))}\n\n❌ *Produit inéligible* : expédition hors entrepôt local\\.`,
      { parse_mode: "MarkdownV2" }
    );
    return;
  }

  ctx.session.pendingProduct = product;
  ctx.session.state = "awaiting_variant_choice";

  const kb = new InlineKeyboard();
  product.variants.forEach((v, i) => {
    kb.text(v.label, `variant:${v.variantId}`).row();
  });

  const lines = [
    fmtProduct(product),
    "",
    "Choisissez une variante :",
    ...product.variants.map((v, i) => fmtVariant(v, i)),
  ].join("\n");

  await ctx.api.editMessageText(ctx.chat!.id, msg.message_id, lines, {
    parse_mode: "MarkdownV2",
    reply_markup: kb,
  });
}

// ─── Variant selection ────────────────────────────────────────────────────────

bot.callbackQuery(/^variant:(.+)$/, async (ctx) => {
  const variantId = ctx.match[1];
  const product = ctx.session.pendingProduct;
  if (!product) {
    await ctx.answerCallbackQuery("Session expirée, relancez /lien");
    return;
  }

  const variant = product.variants.find((v) => v.variantId === variantId);
  if (!variant) {
    await ctx.answerCallbackQuery("Variante introuvable");
    return;
  }

  ctx.session.pendingVariantId = variantId;

  // Suggest price: cost × 3, rounded to .99
  const suggested = Math.floor(variant.costEur * 3) + 0.99;
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
    .text("✏️ Modifier le prix", "edit_price");

  await ctx.editMessageText(
    [
      `📦 *${escMd(variant.label)}*`,
      `Coût : ${variant.costEur.toFixed(2)} €`,
      `Prix suggéré : *${suggested.toFixed(2)} €*`,
      `Marge : ${(suggested - variant.costEur).toFixed(2)} €`,
      `Photos : ${variant.imageUrls.length} image\\(s\\)`,
    ].join("\n"),
    { parse_mode: "MarkdownV2", reply_markup: kb }
  );
  await ctx.answerCallbackQuery();
});

// ─── Price confirmation ───────────────────────────────────────────────────────

bot.callbackQuery(/^confirm_price:(.+)$/, async (ctx) => {
  const price = parseFloat(ctx.match[1]);
  ctx.session.pendingListingDraft!.priceEur = price;
  ctx.session.state = "awaiting_account_choice";

  const res = await getLeboncoinAccounts();
  if (!res.ok || !res.data?.length) {
    await ctx.editMessageText("❌ Impossible de récupérer les comptes Leboncoin\\.", { parse_mode: "MarkdownV2" });
    await ctx.answerCallbackQuery();
    return;
  }

  const kb = new InlineKeyboard();
  res.data.forEach((acc) => {
    kb.text(acc.label, `account:${acc.accountId}`).row();
  });

  await ctx.editMessageText("🏪 Choisissez le compte Leboncoin :", { reply_markup: kb });
  await ctx.answerCallbackQuery();
});

// ─── Account selection ────────────────────────────────────────────────────────

bot.callbackQuery(/^account:(.+)$/, async (ctx) => {
  const accountId = ctx.match[1];
  ctx.session.pendingListingDraft!.accountId = accountId;
  ctx.session.state = "awaiting_schedule";

  const kb = new InlineKeyboard()
    .text("⚡ Publier maintenant", "schedule:now")
    .row()
    .text("📅 Dans 1h", `schedule:${Date.now() + 3600_000}`)
    .row()
    .text("📅 Demain 9h", `schedule:tomorrow`);

  await ctx.editMessageText("🕐 Quand publier l'annonce ?", { reply_markup: kb });
  await ctx.answerCallbackQuery();
});

// ─── Schedule ────────────────────────────────────────────────────────────────

bot.callbackQuery(/^schedule:(.+)$/, async (ctx) => {
  const when = ctx.match[1];
  const draft = ctx.session.pendingListingDraft!;
  const product = ctx.session.pendingProduct!;

  let scheduledAt: string | undefined;
  if (when === "now") {
    scheduledAt = undefined;
  } else if (when === "tomorrow") {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    scheduledAt = d.toISOString();
  } else {
    scheduledAt = new Date(parseInt(when)).toISOString();
  }

  const res = await createListing({
    temuItemId: draft.temuItemId!,
    variantId: draft.variantId!,
    accountId: draft.accountId!,
    priceEur: draft.priceEur!,
    ...(scheduledAt ? { scheduledAt } : {}),
  });

  ctx.session.state = "idle";
  ctx.session.pendingProduct = undefined;
  ctx.session.pendingListingDraft = undefined;

  if (!res.ok || !res.data) {
    await ctx.editMessageText(`❌ Erreur création annonce : ${escMd(res.error ?? "inconnu")}`, { parse_mode: "MarkdownV2" });
    await ctx.answerCallbackQuery();
    return;
  }

  await ctx.editMessageText(fmtListing(res.data), { parse_mode: "MarkdownV2" });
  await ctx.answerCallbackQuery("Annonce créée ✅");
});

// ─── /dashboard ───────────────────────────────────────────────────────────────

bot.command("dashboard", async (ctx) => {
  const res = await getDashboard();
  if (!res.ok || !res.data) {
    await ctx.reply("❌ Impossible de récupérer le tableau de bord\\.", { parse_mode: "MarkdownV2" });
    return;
  }
  await ctx.reply(fmtDashboard(res.data), { parse_mode: "MarkdownV2" });
});

// ─── /commande ────────────────────────────────────────────────────────────────

bot.command("commande", async (ctx) => {
  const parts = ctx.match?.trim().split(" ") ?? [];
  if (parts.length < 2) {
    ctx.session.state = "awaiting_order_ref";
    await ctx.reply("📦 Envoyez : `<id_vente> <ref_commande>`", { parse_mode: "MarkdownV2" });
    return;
  }
  await handleOrderRef(ctx, parts[0], parts[1]);
});

async function handleOrderRef(ctx: any, saleId?: string, ref?: string) {
  if (!saleId || !ref) {
    await ctx.reply("❌ Format : `/commande <id_vente> <ref>`", { parse_mode: "MarkdownV2" });
    return;
  }
  // Store order ref via tracking endpoint (order ref only, no tracking yet)
  const res = await addTracking(saleId, { orderRef: ref, trackingNumber: "" });
  if (!res.ok) {
    await ctx.reply(`❌ Erreur : ${escMd(res.error ?? "")}`, { parse_mode: "MarkdownV2" });
    return;
  }
  await ctx.reply(`✅ Référence \`${escMd(ref)}\` enregistrée pour la vente \`${escMd(saleId)}\``, { parse_mode: "MarkdownV2" });
}

// ─── /suivi ───────────────────────────────────────────────────────────────────

bot.command("suivi", async (ctx) => {
  const parts = ctx.match?.trim().split(" ") ?? [];
  if (parts.length < 3) {
    ctx.session.state = "awaiting_tracking";
    await ctx.reply("📬 Envoyez : `<id_vente> <transporteur> <numéro>`", { parse_mode: "MarkdownV2" });
    return;
  }
  await handleTracking(ctx, parts[0], parts[1], parts[2]);
});

async function handleTracking(ctx: any, saleId?: string, carrier?: string, tracking?: string) {
  if (!saleId || !carrier || !tracking) {
    await ctx.reply("❌ Format : `/suivi <id_vente> <transporteur> <numéro>`", { parse_mode: "MarkdownV2" });
    return;
  }
  const res = await addTracking(saleId, {
    orderRef: "",
    trackingNumber: tracking,
    trackingCarrier: carrier,
  });
  if (!res.ok || !res.data) {
    await ctx.reply(`❌ Erreur : ${escMd(res.error ?? "")}`, { parse_mode: "MarkdownV2" });
    return;
  }
  await ctx.reply(fmtTrackingAdded(res.data), { parse_mode: "MarkdownV2" });
}

// ─── Error handler ────────────────────────────────────────────────────────────

bot.catch((err) => {
  console.error("[bot] Error:", err.message);
});

// ─── Export for testing and for external sale alerts ─────────────────────────

export { bot };

export async function sendSaleAlert(
  chatId: number,
  saleAlert: { sale: import("../../packages/shared/src/types").Sale; productTitle: string; variantLabel: string }
) {
  await bot.api.sendMessage(
    chatId,
    fmtSaleAlert(saleAlert.sale, saleAlert.productTitle, saleAlert.variantLabel),
    { parse_mode: "MarkdownV2" }
  );
}

// ─── Start (only when run directly) ──────────────────────────────────────────

if (require.main === module) {
  bot.start();
  console.log("[bot] Hermès Telegram bot started");
}
