/**
 * Pricing service — multipliers x3/x4/x10, +3€ livraison autre.
 * All amounts in EUR (float at API boundary, cents in DB).
 */

const MULTIPLIERS = {
  standard: parseFloat(process.env.PRICE_MULTIPLIER_DEFAULT ?? "3"),
  fast:     parseFloat(process.env.PRICE_MULTIPLIER_FAST    ?? "4"),
  premium:  parseFloat(process.env.PRICE_MULTIPLIER_PREMIUM ?? "10"),
};

const MIN_MARGIN_EUR    = parseFloat(process.env.MIN_MARGIN_EUR ?? "5.0");
const DELIVERY_OTHER_FEE = parseFloat(process.env.DELIVERY_OTHER_FEE ?? "3.0");

/** Single suggested price (default x3) */
function suggestPrice(costEur, { deliveryOther = false } = {}) {
  const raw = costEur * MULTIPLIERS.standard;
  const withMin = Math.max(raw, costEur + MIN_MARGIN_EUR);
  const base = Math.floor(withMin) + 0.99;
  return deliveryOther ? base + DELIVERY_OTHER_FEE : base;
}

/**
 * Return all three price strategies.
 * @returns {{ standard, fast, premium }} — each { priceEur, margin, multiplier }
 */
function suggestPriceStrategy(costEur, { deliveryOther = false } = {}) {
  const fee = deliveryOther ? DELIVERY_OTHER_FEE : 0;
  return Object.fromEntries(
    Object.entries(MULTIPLIERS).map(([key, mult]) => {
      const raw = costEur * mult;
      const withMin = Math.max(raw, costEur + MIN_MARGIN_EUR);
      const priceEur = Math.floor(withMin) + 0.99 + fee;
      return [key, {
        priceEur,
        multiplier: mult,
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
