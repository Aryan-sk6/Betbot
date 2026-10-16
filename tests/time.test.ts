import { describe, expect, it } from "vitest";
import { parseWhen } from "../src/core/time.js";

// Wed 2026-10-14 10:00 in Asia/Kolkata (UTC+5:30) = 04:30 UTC
const NOW = Date.UTC(2026, 9, 14, 4, 30);
const ist = (y: number, m: number, d: number, h: number, min = 0) => Date.UTC(y, m - 1, d, h, min) - 330 * 60_000;

describe("parseWhen", () => {
  it("relative times", () => {
    expect(parseWhen("in 2h", NOW)).toBe(NOW + 7_200_000);
    expect(parseWhen("in 30 min", NOW)).toBe(NOW + 1_800_000);
    expect(parseWhen("in 2 days", NOW)).toBe(NOW + 2 * 86_400_000);
  });
  it("weekday and time", () => {
    expect(parseWhen("fri 6pm", NOW)).toBe(ist(2026, 10, 16, 18));
    expect(parseWhen("Friday 6:30pm", NOW)).toBe(ist(2026, 10, 16, 18, 30));
    expect(parseWhen("wed 9am", NOW)).toBe(ist(2026, 10, 21, 9)); // today 9am already passed
  });
  it("tomorrow / today / bare time", () => {
    expect(parseWhen("tomorrow 9am", NOW)).toBe(ist(2026, 10, 15, 9));
    expect(parseWhen("today 8pm", NOW)).toBe(ist(2026, 10, 14, 20));
    expect(parseWhen("today 8am", NOW)).toBeNull();
    expect(parseWhen("6pm", NOW)).toBe(ist(2026, 10, 14, 18));
    expect(parseWhen("9am", NOW)).toBe(ist(2026, 10, 15, 9));
  });
  it("respects timezone", () => {
    expect(parseWhen("tomorrow 9am", NOW, "UTC")).toBe(Date.UTC(2026, 9, 15, 9));
  });
  it("rejects garbage", () => {
    for (const s of ["", "soon", "6", "25:00", "13pm", "in 0h"]) expect(parseWhen(s, NOW), s).toBeNull();
  });
});
