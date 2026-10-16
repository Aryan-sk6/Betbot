import { describe, expect, it } from "vitest";
import { cost, priceNo, priceYes, proceedsForShares, sharesForPoints, applyShares, type MarketState } from "../src/core/market.js";

const fresh = (b = 100): MarketState => ({ qYes: 0, qNo: 0, b });

describe("LMSR", () => {
  it("prices sum to 1 and start at 50%", () => {
    expect(priceYes(fresh())).toBeCloseTo(0.5);
    for (const s of [fresh(), { qYes: 40, qNo: 7, b: 100 }, { qYes: -5, qNo: 300, b: 25 }]) {
      expect(priceYes(s) + priceNo(s)).toBeCloseTo(1, 12);
    }
  });

  it("buying YES raises priceYes and returns shares >= points", () => {
    const s = fresh();
    const shares = sharesForPoints(s, "yes", 50);
    expect(shares).toBeGreaterThan(50);
    expect(priceYes(applyShares(s, "yes", shares))).toBeGreaterThan(priceYes(s));
  });

  it("buying NO lowers priceYes", () => {
    const s = fresh();
    const shares = sharesForPoints(s, "no", 50);
    expect(priceYes(applyShares(s, "no", shares))).toBeLessThan(0.5);
  });

  it("cost difference equals points spent", () => {
    const s: MarketState = { qYes: 30, qNo: 80, b: 100 };
    const shares = sharesForPoints(s, "yes", 123);
    expect(cost(applyShares(s, "yes", shares)) - cost(s)).toBeCloseTo(123, 8);
  });

  it("buy then sell the same shares round-trips to ~zero", () => {
    for (const side of ["yes", "no"] as const) {
      const s: MarketState = { qYes: 12, qNo: 3, b: 100 };
      const shares = sharesForPoints(s, side, 80);
      const after = applyShares(s, side, shares);
      expect(proceedsForShares(after, side, shares)).toBeCloseTo(80, 8);
    }
  });

  it("does not overflow with huge q", () => {
    const s: MarketState = { qYes: 1e6, qNo: 0, b: 100 };
    expect(Number.isFinite(cost(s))).toBe(true);
    expect(priceYes(s)).toBe(1);
    const shares = sharesForPoints(s, "no", 10);
    expect(Number.isFinite(shares)).toBe(true);
    expect(shares).toBeGreaterThan(0);
    const big: MarketState = { qYes: 5e5, qNo: 5e5 + 20, b: 100 };
    expect(Number.isFinite(sharesForPoints(big, "yes", 50))).toBe(true);
  });

  it("market maker loss is bounded by b*ln2", () => {
    const b = 100;
    let s = fresh(b);
    let paid = 0;
    for (let i = 0; i < 50; i++) {
      const sh = sharesForPoints(s, "yes", 40);
      s = applyShares(s, "yes", sh);
      paid += 40;
    }
    // YES wins: AMM pays qYes, collected `paid`.
    expect(s.qYes - paid).toBeLessThanOrEqual(b * Math.LN2 + 1e-6);
  });
});
