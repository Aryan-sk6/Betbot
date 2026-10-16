// LMSR pricing. Pure functions, no I/O.

export type Side = "yes" | "no";

export interface MarketState {
  qYes: number;
  qNo: number;
  b: number;
}

/** ln(e^a + e^b) without overflow. */
export function logSumExp(a: number, b: number): number {
  const m = Math.max(a, b);
  if (!Number.isFinite(m)) return m;
  return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
}

/** LMSR cost function C(q) = b * ln(e^(qy/b) + e^(qn/b)). */
export function cost(s: MarketState): number {
  return s.b * logSumExp(s.qYes / s.b, s.qNo / s.b);
}

export function priceYes(s: MarketState): number {
  // 1 / (1 + e^((qn - qy)/b)), stable at both extremes.
  return 1 / (1 + Math.exp((s.qNo - s.qYes) / s.b));
}

export function priceNo(s: MarketState): number {
  return 1 - priceYes(s);
}

export function price(s: MarketState, side: Side): number {
  return side === "yes" ? priceYes(s) : priceNo(s);
}

/**
 * Shares received for spending `points` on `side`.
 * Closed form: q' = b * ln(e^(target/b) - e^(qOther/b)), target = C(q) + points.
 * Everything is computed relative to the larger quantity so large q cannot overflow
 * and small trades against a large q keep their precision.
 */
export function sharesForPoints(s: MarketState, side: Side, points: number): number {
  const own = side === "yes" ? s.qYes : s.qNo;
  const other = side === "yes" ? s.qNo : s.qYes;
  const m = Math.max(s.qYes, s.qNo) / s.b;
  const costRel = Math.log1p(Math.exp(-Math.abs(s.qYes - s.qNo) / s.b)); // C(q)/b - m
  const targetRel = costRel + points / s.b; // target/b - m
  const newOwnRel = targetRel + Math.log1p(-Math.exp(other / s.b - m - targetRel));
  return s.b * (newOwnRel - (own / s.b - m));
}

/** Points the market maker pays for `shares` of `side` sold back at the LMSR price. */
export function proceedsForShares(s: MarketState, side: Side, shares: number): number {
  const after: MarketState =
    side === "yes" ? { ...s, qYes: s.qYes - shares } : { ...s, qNo: s.qNo - shares };
  return cost(s) - cost(after);
}

export function applyShares(s: MarketState, side: Side, delta: number): MarketState {
  return side === "yes" ? { ...s, qYes: s.qYes + delta } : { ...s, qNo: s.qNo + delta };
}
