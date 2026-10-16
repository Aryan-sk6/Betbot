import { describe, expect, it } from "vitest";
import { display, isYesNo, matchOption, validateOptions } from "../src/core/options.js";

const labels = ["India", "Australia", "Draw", "Real Madrid"];

describe("matchOption", () => {
  it("matches exact names ignoring case and spacing", () => {
    expect(matchOption(labels, "india")).toEqual({ index: 0 });
    expect(matchOption(labels, "  REAL   madrid ")).toEqual({ index: 3 });
  });
  it("matches by 1-based number", () => {
    expect(matchOption(labels, "2")).toEqual({ index: 1 });
    expect(matchOption(labels, "9")).toMatchObject({ error: "none" });
    expect(matchOption(labels, "0")).toMatchObject({ error: "none" });
  });
  it("matches a unique prefix, rejects ambiguous and unknown", () => {
    expect(matchOption(labels, "aus")).toEqual({ index: 1 });
    expect(matchOption(["Red", "Reds", "Blue"], "re")).toEqual({ error: "ambiguous", candidates: ["Red", "Reds"] });
    expect(matchOption(["Red", "Reds", "Blue"], "red")).toEqual({ index: 0 }); // exact wins over prefix
    expect(matchOption(labels, "spain")).toMatchObject({ error: "none" });
    expect(matchOption(labels, "")).toMatchObject({ error: "none" });
  });
  it("lets y and n pick yes/no", () => {
    expect(matchOption(["Yes", "No"], "y")).toEqual({ index: 0 });
    expect(matchOption(["Yes", "No"], "n")).toEqual({ index: 1 });
  });
  it("a name beats a number", () => {
    expect(matchOption(["2024", "x"], "2024")).toEqual({ index: 0 });
  });
});

describe("validateOptions", () => {
  it("accepts 2 to 10 distinct names", () => {
    expect(validateOptions(["A", "B"])).toBeNull();
    expect(validateOptions(Array.from({ length: 10 }, (_, i) => `opt${i}`))).toBeNull();
  });
  it("rejects too few, too many, duplicates, numbers, pipes, long names", () => {
    expect(validateOptions(["A"])).toMatch(/at least 2/i);
    expect(validateOptions(Array.from({ length: 11 }, (_, i) => `o${i}`))).toMatch(/At most 10/);
    expect(validateOptions(["A", " a "])).toMatch(/Duplicate/);
    expect(validateOptions(["A", "7"])).toMatch(/number/);
    expect(validateOptions(["A", "B|C"])).toMatch(/\|/);
    expect(validateOptions(["A", "x".repeat(41)])).toMatch(/40/);
    expect(validateOptions(["A", ""])).toMatch(/empty/);
  });
});

it("display and isYesNo", () => {
  expect(display("yes")).toBe("YES");
  expect(display("Real Madrid")).toBe("Real Madrid");
  expect(isYesNo(["Yes", "No"])).toBe(true);
  expect(isYesNo(["No", "Yes"])).toBe(false);
  expect(isYesNo(["Yes", "No", "Maybe"])).toBe(false);
});
