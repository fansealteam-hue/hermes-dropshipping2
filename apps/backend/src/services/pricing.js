/**
 * Pricing service — Claude 2 provides the rule; this file centralises the calculation.
 * All amounts in EUR (float at API boundary, cents in DB).
 */

/**
 * Suggest a selling price given supplier cost.
 * Claude 2 can override MARGIN_MULTIPLIER and ROUNDING via env or by replacing suggestPrice().
 */
const MARGIN_MULTIPLIER = parseFloat(process.env.PRICE_MULTIPLIER ?? "3.0");
const MIN_MARGIN_EUR = parseFloat(process.env.MIN_MARGIN_EUR ?? "5.0");

function suggestPrice(costEur) {
  const raw = costEur * MARGIN_MULTIPLIER;
  const withMin = Math.max(raw, costEur + MIN_MARGIN_EUR);
  // Round to .99
  return Math.floor(withMin) + 0.99;
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
    absolute: priceEur - costEur,
    percent: ((priceEur - costEur) / priceEur) * 100,
  };
}

module.exports = { suggestPrice, validatePrice, margin };
