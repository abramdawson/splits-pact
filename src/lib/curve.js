// Shared bonding-curve math for the buy and status pages.

// fraction of the project sold once a cumulative $R has been raised along the curve
export function fractionAt(r, R) {
  const cap = r.valuation.effectiveCap, vMin = r.valuation.floor, vMax = r.valuation.ceiling;
  const F = r.maxDilutionPct / 100, rmax = r.raise.max;
  if (R <= 0) return 0;
  if (R >= rmax) return F;
  if (vMax === vMin) return Math.min(R / cap, F);
  const a = (vMax - vMin) / (2 * F);
  return Math.min((-vMin + Math.sqrt(vMin * vMin + 4 * a * R)) / (2 * a), F);
}

export const tokensBetween = (r, R0, R1) => (fractionAt(r, R1) - fractionAt(r, R0)) * r.totalTokens;

export function offeringCurveParams(r) {
  if (r && r.curveParams && Number(r.curveParams.priceStart) > 0) return r.curveParams;
  const floor = Number(r && r.valuation && r.valuation.floor);
  const ceiling = Number(r && r.valuation && r.valuation.ceiling);
  const offeringUnits = Number(r && r.newMoney && r.newMoney.tokens);
  if (!(floor > 0) || !(ceiling >= floor) || !(offeringUnits > 0)) return null;
  const priceStart = Math.max(1, Math.floor(floor * 1000000 / 1000));
  const slopeRaw = Math.floor((ceiling - floor) * 1000000 / 1000 / offeringUnits);
  const priceSlope = ceiling > floor ? Math.max(1, slopeRaw) : 0;
  return { priceStart, priceSlope };
}

export function costForUnits(curve, sold, units) {
  if (!curve || !(units > 0)) return 0;
  return units * Number(curve.priceStart || 0) + Number(curve.priceSlope || 0) * (sold * units + (units * (units - 1)) / 2);
}

export function valuationForUnitIndex(curve, unitIndex, totalTokens) {
  if (!curve) return 0;
  const price = Number(curve.priceStart || 0) + Number(curve.priceSlope || 0) * Math.max(0, Number(unitIndex || 0));
  return price * Number(totalTokens || 0) / 1000000;
}
