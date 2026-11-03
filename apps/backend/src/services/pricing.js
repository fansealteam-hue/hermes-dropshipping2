/**
 * Pricing service — multiplicateurs adaptatifs + frais Temu intégrés.
 * Coût réel = prix Temu + frais livraison Temu (défaut 2.99€).
 * All amounts in EUR (float at API boundary, cents in DB).
 */

const MULTIPLIERS = {
  standard: parseFloat(process.env.PRICE_MULTIPLIER_DEFAULT ?? "3"),
  fast:     parseFloat(process.env.PRICE_MULTIPLIER_FAST    ?? "4"),
  premium:  parseFloat(process.env.PRICE_MULTIPLIER_PREMIUM ?? "10"),
};

const MIN_MARGIN_EUR     = parseFloat(process.env.MIN_MARGIN_EUR ?? "5.0");
const DELIVERY_OTHER_FEE = parseFloat(process.env.DELIVERY_OTHER_FEE ?? "3.0");
// Frais de livraison Temu (coût réel = prix produit + cette valeur)
const TEMU_SHIPPING_FEE  = parseFloat(process.env.TEMU_SHIPPING_FEE ?? "2.99");

/**
 * Smart multiplier based on cost — always guarantees minimum x3 benefit.
 * < 10 €  → x5   (gadgets, petits articles — marge absolue faible, prix raisonnable)
 * 10-20 € → x4   (petits produits — 40-80€ = très vendable)
 * 20-40 € → x3   (produits moyens — 60-120€ = bon rapport)
 * 40-80 € → x2.5 (bénéfice 60-120€)
 * > 80 €  → x2   (bénéfice 80-200€ — raisonnable pour LBC)
 *
 * Objectif : 350 € bénéfice/jour (~10 ventes × 35 € marge moy.)
 */
function smartMultiplier(costEur) {
  if (costEur < 10)  return 5.0;
  if (costEur < 20)  return 4.0;
  if (costEur < 40)  return 3.0;
  if (costEur < 80)  return 2.5;
  return 2.0;
}

/**
 * Prix suggéré — intègre les frais Temu dans le coût réel.
 * @param {number} costEur       Prix produit Temu (hors livraison)
 * @param {object} opts
 * @param {boolean} opts.deliveryOther  +3€ si livraison "autre" Leboncoin
 * @param {number}  opts.temuShipping   Frais livraison Temu (défaut 2.99€)
 */
function suggestPrice(costEur, { deliveryOther = false, temuShipping = TEMU_SHIPPING_FEE } = {}) {
  const totalCost = costEur + temuShipping;          // coût réel
  const mult = smartMultiplier(totalCost);
  const raw = totalCost * mult;
  const withMin = Math.max(raw, totalCost + MIN_MARGIN_EUR);
  const base = Math.floor(withMin) + 0.99;
  return deliveryOther ? +(base + DELIVERY_OTHER_FEE).toFixed(2) : base;
}

/**
 * Toutes les stratégies de prix avec frais Temu intégrés.
 * @returns {{ standard, fast, premium }} — chacun avec priceEur, marginEur, marginPct
 */
function suggestPriceStrategy(costEur, { deliveryOther = false, temuShipping = TEMU_SHIPPING_FEE } = {}) {
  const fee = deliveryOther ? DELIVERY_OTHER_FEE : 0;
  const totalCost = costEur + temuShipping;          // coût réel
  const mult = smartMultiplier(totalCost);

  const strategies = {
    standard: mult,
    fast:     Math.max(mult, MULTIPLIERS.fast),
    premium:  Math.max(mult, MULTIPLIERS.premium),
  };

  return Object.fromEntries(
    Object.entries(strategies).map(([key, m]) => {
      const raw = totalCost * m;
      const withMin = Math.max(raw, totalCost + MIN_MARGIN_EUR);
      const priceEur = +(Math.floor(withMin) + 0.99 + fee).toFixed(2);
      return [key, {
        priceEur,
        multiplier: m,
        totalCostEur: +totalCost.toFixed(2),
        marginEur: +(priceEur - totalCost).toFixed(2),
        marginPct: +(((priceEur - totalCost) / priceEur) * 100).toFixed(1),
        deliveryFeeIncluded: fee > 0,
      }];
    })
  );
}

function validatePrice(costEur, priceEur) {
  if (priceEur <= 0) return { valid: false, reason: "Prix négatif ou nul" };
  if (priceEur < costEur) return { valid: false, reason: "Prix inférieur au coût" };
  if (priceEur < costEur + MIN_MARGIN_EUR) {
    return { valid: false, reason: `Marge insuffisante (minimum ${MIN_MARGIN_EUR} €)` };
  }
  return { valid: true };
}

function margin(costEur, priceEur) {
  return {
    absolute: +(priceEur - costEur).toFixed(2),
    percent:  +(((priceEur - costEur) / priceEur) * 100).toFixed(1),
  };
}

module.exports = { suggestPrice, suggestPriceStrategy, validatePrice, margin, MULTIPLIERS, DELIVERY_OTHER_FEE, TEMU_SHIPPING_FEE };
