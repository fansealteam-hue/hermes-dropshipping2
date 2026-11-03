import type { TemuProduct, TemuVariant, Sale, Listing, DashboardData } from "../../packages/shared/src/types";

export function fmtProduct(p: TemuProduct): string {
  const warehouse =
    p.warehouseStatus === "local"
      ? "✅ Entrepôt local"
      : p.warehouseStatus === "china"
      ? "🇨🇳 Entrepôt Chine (inéligible)"
      : "❓ Entrepôt inconnu";
  return `📦 *${escMd(p.title)}*\n${warehouse}\n${p.variants.length} variante(s) disponible(s)`;
}

export function fmtVariant(v: TemuVariant, idx: number): string {
  return `${idx + 1}\\. *${escMd(v.label)}* — ${v.costEur.toFixed(2)} €  \\(stock: ${v.stock}\\)`;
}

export function fmtSaleAlert(s: Sale, productTitle: string, variantLabel: string): string {
  return [
    "🔔 *VENTE CONFIRMÉE*",
    `Compte : \`${s.accountId}\``,
    `Produit : ${escMd(productTitle)} — ${escMd(variantLabel)}`,
    `Prix de vente : ${s.salePriceEur.toFixed(2)} €`,
    `Lien fournisseur : ${s.supplierUrl}`,
    s.buyerName ? `Acheteur : ${escMd(s.buyerName)}` : "",
    s.deliveryAddress ? `Adresse : ${escMd(s.deliveryAddress)}` : "",
    "",
    "Effectuez l'achat fournisseur puis transmettez la référence avec /commande",
  ]
    .filter(Boolean)
    .join("\n");
}

export function fmtTrackingAdded(s: Sale): string {
  const delivery = s.leboncoinDeliveryConfirmed
    ? "✅ Réception confirmée par Leboncoin"
    : s.manualActionRequired
    ? `⚠️ Action manuelle requise : ${escMd(s.manualActionNote ?? "")}`
    : "⏳ En attente de confirmation Leboncoin";
  return [
    "📬 *Suivi rattaché*",
    `Commande : \`${s.orderRef}\``,
    `Transporteur : ${escMd(s.trackingCarrier ?? "?")} — \`${s.trackingNumber}\``,
    delivery,
  ].join("\n");
}

export function fmtDashboard(d: DashboardData): string {
  const lines: string[] = ["📊 *Tableau de bord Hermès*", ""];

  if (d.activeSales.length) {
    lines.push(`🛒 *Ventes actives :* ${d.activeSales.length}`);
    d.activeSales.slice(0, 5).forEach((s) => {
      const icon = s.leboncoinDeliveryConfirmed ? "✅" : s.manualActionRequired ? "⚠️" : "⏳";
      lines.push(`  ${icon} \`${s.saleId.slice(0, 8)}\` — ${escMd(s.status)}`);
    });
    lines.push("");
  }

  if (d.salesNeedingAction.length) {
    lines.push(`⚠️ *Actions requises :* ${d.salesNeedingAction.length}`);
    d.salesNeedingAction.forEach((s) => {
      lines.push(`  • \`${s.saleId.slice(0, 8)}\` ${escMd(s.manualActionNote ?? "action requise")}`);
    });
    lines.push("");
  }

  if (d.pendingListings.length) {
    lines.push(`📝 *Annonces en attente :* ${d.pendingListings.length}`);
  }

  if (d.recentActivity.length) {
    lines.push("", "🕐 *Dernières activités :*");
    d.recentActivity.slice(0, 3).forEach((a) => {
      lines.push(`  • ${escMd(a.description)}`);
    });
  }

  return lines.join("\n");
}

export function fmtListing(l: Listing): string {
  const status: Record<string, string> = {
    draft: "📝 Brouillon",
    scheduled: "🕐 Programmé",
    published: "✅ Publié",
    paused: "⏸ Pausé",
    sold: "💰 Vendu",
    archived: "🗄 Archivé",
  };
  return [
    `📋 *Annonce \`${l.listingId.slice(0, 8)}\`*`,
    `Statut : ${status[l.status] ?? l.status}`,
    `Prix : ${l.priceEur.toFixed(2)} € \\(coût : ${l.costEur.toFixed(2)} €\\)`,
    l.scheduledAt ? `Programmé : ${escMd(new Date(l.scheduledAt).toLocaleString("fr-FR"))}` : "",
    l.leboncoinAdId ? `ID Leboncoin : \`${l.leboncoinAdId}\`` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Escape MarkdownV2 special characters */
export function escMd(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}
