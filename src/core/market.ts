// LMSR pricing for markets with N >= 2 mutually exclusive outcomes. Pure functions, no I/O.
// Binary yes/no is just N = 2.

export interface MarketState {
  /** Shares outstanding per outcome, indexed by outcome. */
  q: number[];
  /** Liquidity parameter. The market maker's worst-case loss is b * ln(N). */
  b: number;
}

/** ln(sum(e^x)) without overflow. */
export function logSumExp(xs: number[]): number {
  const m = Math.max(...xs);
  if (!Number.isFinite(m)) return m;
  return m + Math.log(xs.reduce((acc, x) => acc + Math.exp(x - m), 0));
}

/** LMSR cost function C(q) = b * ln(sum_i e^(q_i/b)). */
export function cost(s: MarketState): number {
  return s.b * logSumExp(s.q.map((x) => x / s.b));
}

/** Softmax of q/b: one price (probability) per outcome, summing to 1. */
export function prices(s: MarketState): number[] {
  const m = Math.max(...s.q);
  const e = s.q.map((x) => Math.exp((x - m) / s.b));
  const total = e.reduce((a, x) => a + x, 0);
  return e.map((x) => x / total);
}

export function price(s: MarketState, outcome: number): number {
  return prices(s)[outcome];
}

/**
 * Shares received for spending `points` on `outcome`.
 * Closed form: q_i' = b * ln(e^(target/b) - sum_{j!=i} e^(q_j/b)), target = C(q) + points.
 * Computed relative to the largest q so big quantities cannot overflow and small trades
 * against a large q keep their precision.
 */
export function sharesForPoints(s: MarketState, outcome: number, points: number): number {
  const m = Math.max(...s.q) / s.b;
  const rel = s.q.map((x) => x / s.b - m);
  const costRel = logSumExp(rel); // C(q)/b - m
  const targetRel = costRel + points / s.b; // target/b - m
  const othersRel = logSumExp(rel.filter((_, j) => j !== outcome)); // ln(sum of the others), shifted
  const newOwnRel = targetRel + Math.log1p(-Math.exp(othersRel - targetRel));
  return s.b * (newOwnRel - rel[outcome]);
}

export function applyShares(s: MarketState, outcome: number, delta: number): MarketState {
  return { ...s, q: s.q.map((x, i) => (i === outcome ? x + delta : x)) };
}

/** Points the market maker pays for `shares` of `outcome` sold back at the LMSR price. */
export function proceedsForShares(s: MarketState, outcome: number, shares: number): number {
  return cost(s) - cost(applyShares(s, outcome, -shares));
}
