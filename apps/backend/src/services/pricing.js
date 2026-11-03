/**
 * Pricing service — multipliers x3/x4/x10, +3€ livraison autre.
 * All amounts in EUR (float at API boundary, cents in DB).
 */

const MULTIPLIERS = {
  standard: parseFloat(process.env.PRICE_MULTIPLIER_DEFAULT ?? "3"),
  fast:     parseFloat(process.env.PRICE_MULTIPLIER_FAST    ?? "4"),
  premium:  parseFloat(process.env.PRICE_MULTIPLIER_PREMIUM ?? "10"),
};

const MIN_MARGIN_EUR     = parseFloat(process.env.MIN_MARGIN_EUR ?? "5.0");
const DELIVERY_OTHER_FEE = parseFloat(process.env.DELIVERY_OTHER_FEE ?? "3.0");

/**
 * Smart multiplier based on cost — always guarantees minimum x3 benefit.
 * < 15 €  → x3   (petits produits)
 * 15-40 € → x2.5
 * 40-80 € → x2
 * > 80 €  → x1.5 (bénéfice 50-100 € suffit)
 */
function smartMultiplier(costEur) {
  if (costEur < 15)  return 3.0;
  if (costEur < 40)  return 2.5;
  if (costEur < 80)  return 2.0;
  return 1.5;
}

/** Single suggested price — multiplicateur intelligent selon le coût */
function suggestPrice(costEur, { deliveryOther = false } = {}) {
  const mult = smartMultiplier(costEur);
  const raw = costEur * mult;
  const withMin = Math.max(raw, costEur + MIN_MARGIN_EUR);
  const base = Math.floor(withMin) + 0.99;
  return deliveryOther ? +(base + DELIVERY_OTHER_FEE).toFixed(2) : base;
}

/**
 * Return all three price strategies with smart base + fast/premium options.
 * @returns {{ standard, fast, premium }}
 */
function suggestPriceStrategy(costEur, { deliveryOther = false } = {}) {
  const fee = deliveryOther ? DELIVERY_OTHER_FEE : 0;
  const mult = smartMultiplier(costEur);

  const strategies = {
    standard: mult,
    fast:     Math.max(mult, MULTIPLIERS.fast),
    premium:  Math.max(mult, MULTIPLIERS.premium),
  };

  return Object.fromEntries(
    Object.entries(strategies).map(([key, m]) => {
      const raw = costEur * m;
      const withMin = Math.max(raw, costEur + MIN_MARGIN_EUR);
      const priceEur = +(Math.floor(withMin) + 0.99 + fee).toFixed(2);
      return [key, {
        priceEur,
        multiplier: m,
        marginEur: +(priceEur - costEur).toFixed(2),
        marginPct: +(((priceEur - costEur) / priceEur) * 100).toFixed(1),
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

module.exports = { suggestPrice, suggestPriceStrategy, validatePrice, margin, MULTIPLIERS, DELIVERY_OTHER_FEE };
