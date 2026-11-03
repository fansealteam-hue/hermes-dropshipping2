// Plain JS version for testing without TypeScript compilation

function escMd(s) {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

function fmtProduct(p) {
  const warehouse =
    p.warehouseStatus === "local"
      ? "✅ Entrepôt local"
      : p.warehouseStatus === "china"
      ? "🇨🇳 Entrepôt Chine (inéligible)"
      : "❓ Entrepôt inconnu";
  return `📦 *${escMd(p.title)}*\n${warehouse}\n${p.variants.length} variante(s) disponible(s)`;
}

function fmtVariant(v, idx) {
  return `${idx + 1}\\. *${escMd(v.label)}* — ${v.costEur.toFixed(2)} €  \\(stock: ${v.stock}\\)`;
}

function fmtSaleAlert(s, productTitle, variantLabel) {
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
  ].filter(Boolean).join("\n");
}

function fmtTrackingAdded(s) {
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

function fmtDashboard(d) {
  const lines = ["📊 *Tableau de bord Hermès*", ""];
  if (d.activeSales?.length) {
    lines.push(`🛒 *Ventes actives :* ${d.activeSales.length}`);
  }
  if (d.salesNeedingAction?.length) {
    lines.push(`⚠️ *Actions requises :* ${d.salesNeedingAction.length}`);
  }
  return lines.join("\n");
}

function fmtListing(l) {
  return `📋 Annonce \`${l.listingId?.slice(0, 8)}\` — ${l.status} — ${l.priceEur?.toFixed(2)} €`;
}

export { escMd, fmtProduct, fmtVariant, fmtSaleAlert, fmtTrackingAdded, fmtDashboard, fmtListing };
