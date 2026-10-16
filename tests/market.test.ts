import { describe, expect, it } from "vitest";
import { applyShares, cost, price, prices, proceedsForShares, sharesForPoints, type MarketState } from "../src/core/market.js";

const fresh = (n = 2, b = 100): MarketState => ({ q: Array(n).fill(0), b });
const sum = (xs: number[]) => xs.reduce((a, x) => a + x, 0);
const YES = 0;
const NO = 1;

describe("LMSR (binary)", () => {
  it("prices sum to 1 and start at 50%", () => {
    expect(price(fresh(), YES)).toBeCloseTo(0.5);
    for (const s of [fresh(), { q: [40, 7], b: 100 }, { q: [-5, 300], b: 25 }]) {
      expect(sum(prices(s))).toBeCloseTo(1, 12);
    }
  });

  it("buying YES raises its price and returns shares >= points", () => {
    const s = fresh();
    const shares = sharesForPoints(s, YES, 50);
    expect(shares).toBeGreaterThan(50);
    expect(price(applyShares(s, YES, shares), YES)).toBeGreaterThan(price(s, YES));
  });

  it("buying NO lowers the YES price", () => {
    const s = fresh();
    expect(price(applyShares(s, NO, sharesForPoints(s, NO, 50)), YES)).toBeLessThan(0.5);
  });

  it("matches the binary closed form", () => {
    // Direct formula: q' = b * ln(e^(target/b) - e^(qn/b)), target = cost + points.
    const s: MarketState = { q: [30, 80], b: 100 };
    const target = cost(s) + 123;
    const expected = 100 * Math.log(Math.exp(target / 100) - Math.exp(80 / 100)) - 30;
    expect(sharesForPoints(s, YES, 123)).toBeCloseTo(expected, 8);
  });

  it("cost difference equals points spent", () => {
    const s: MarketState = { q: [30, 80], b: 100 };
    const shares = sharesForPoints(s, YES, 123);
    expect(cost(applyShares(s, YES, shares)) - cost(s)).toBeCloseTo(123, 8);
  });

  it("buy then sell the same shares round-trips to ~zero", () => {
    for (const side of [YES, NO]) {
      const s: MarketState = { q: [12, 3], b: 100 };
      const shares = sharesForPoints(s, side, 80);
      expect(proceedsForShares(applyShares(s, side, shares), side, shares)).toBeCloseTo(80, 8);
    }
  });

  it("does not overflow with huge q", () => {
    const s: MarketState = { q: [1e6, 0], b: 100 };
    expect(Number.isFinite(cost(s))).toBe(true);
    expect(price(s, YES)).toBe(1);
    const shares = sharesForPoints(s, NO, 10);
    expect(Number.isFinite(shares)).toBe(true);
    expect(shares).toBeGreaterThan(0);
    expect(Number.isFinite(sharesForPoints({ q: [5e5, 5e5 + 20], b: 100 }, YES, 50))).toBe(true);
  });
});

describe("LMSR (N outcomes)", () => {
  it.each([3, 5, 10])("%i outcomes start even and prices sum to 1", (n) => {
    const s = fresh(n);
    for (const p of prices(s)) expect(p).toBeCloseTo(1 / n, 12);
    const bet = applyShares(s, 1, sharesForPoints(s, 1, 200));
    expect(sum(prices(bet))).toBeCloseTo(1, 12);
  });

  it("buying one outcome raises it and lowers every other", () => {
    const s = fresh(4);
    const after = applyShares(s, 2, sharesForPoints(s, 2, 120));
    const before = prices(s);
    const now = prices(after);
    expect(now[2]).toBeGreaterThan(before[2]);
    for (const i of [0, 1, 3]) expect(now[i]).toBeLessThan(before[i]);
    expect(now[0]).toBeCloseTo(now[1], 12); // untouched outcomes stay symmetric
  });

  it("cost difference equals points spent, and sells round-trip", () => {
    const s: MarketState = { q: [10, 55, 3, 20], b: 80 };
    for (const o of [0, 1, 2, 3]) {
      const shares = sharesForPoints(s, o, 90);
      const after = applyShares(s, o, shares);
      expect(cost(after) - cost(s)).toBeCloseTo(90, 8);
      expect(proceedsForShares(after, o, shares)).toBeCloseTo(90, 8);
    }
  });

  it("a uniform shift of q leaves prices and trade sizes unchanged", () => {
    const a: MarketState = { q: [0, 40, 10], b: 100 };
    const b: MarketState = { q: [500, 540, 510], b: 100 };
    expect(prices(a)[1]).toBeCloseTo(prices(b)[1], 10);
    expect(sharesForPoints(a, 2, 70)).toBeCloseTo(sharesForPoints(b, 2, 70), 6);
  });

  it("does not overflow with many outcomes and huge q", () => {
    const s: MarketState = { q: [1e6, 0, 0, 5e5, 1e6 - 3], b: 100 };
    expect(Number.isFinite(cost(s))).toBe(true);
    expect(sum(prices(s))).toBeCloseTo(1, 12);
    for (let o = 0; o < 5; o++) expect(Number.isFinite(sharesForPoints(s, o, 25))).toBe(true);
  });

  it("market maker loss is bounded by b*ln(N) when one option takes all the money", () => {
    for (const n of [2, 3, 6]) {
      const b = 100;
      let s = fresh(n, b);
      let paid = 0;
      for (let i = 0; i < 60; i++) {
        s = applyShares(s, 0, sharesForPoints(s, 0, 40));
        paid += 40;
      }
      expect(s.q[0] - paid).toBeLessThanOrEqual(b * Math.log(n) + 1e-6);
    }
  });
});
