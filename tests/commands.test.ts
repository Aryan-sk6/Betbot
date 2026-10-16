import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/core/commands.js";

describe("parseCommand", () => {
  it("ignores non-commands and unknown commands", () => {
    expect(parseCommand("hello")).toBeNull();
    expect(parseCommand("bet yes 50")).toBeNull();
    expect(parseCommand("")).toBeNull();
    expect(parseCommand("/unknown thing")).toBeNull();
    expect(parseCommand("see /bet yes 50")).toBeNull();
  });

  it("handles extra spaces and uppercase", () => {
    expect(parseCommand("  /BET   YES    50  ")).toEqual({ type: "bet", side: "yes", points: 50, marketNum: undefined });
    expect(parseCommand("/Bet No 7")).toMatchObject({ side: "no", points: 7 });
  });

  it("accepts a market id before or after", () => {
    expect(parseCommand("/bet #3 yes 50")).toMatchObject({ marketNum: 3, side: "yes", points: 50 });
    expect(parseCommand("/bet 3 no 10")).toMatchObject({ marketNum: 3, side: "no" });
    expect(parseCommand("/bet yes 50 #3")).toMatchObject({ marketNum: 3, points: 50 });
  });

  it("rejects missing args, bad sides, negative and non-numeric points", () => {
    for (const t of ["/bet", "/bet yes", "/bet maybe 5", "/bet yes -5", "/bet yes abc", "/bet yes 0", "/bet yes 5.5", "/bet yes 1e3"]) {
      expect(parseCommand(t), t).toMatchObject({ type: "invalid", command: "bet" });
    }
  });

  it("parses /sell with decimals and 'all'", () => {
    expect(parseCommand("/sell yes 12.5")).toMatchObject({ type: "sell", shares: 12.5 });
    expect(parseCommand("/sell no ALL")).toMatchObject({ type: "sell", shares: "all" });
    expect(parseCommand("/sell yes -1")).toMatchObject({ type: "invalid" });
  });

  it("parses /new with closes and b", () => {
    expect(parseCommand("/new Will it rain? | closes fri 6pm")).toEqual({ type: "new", question: "Will it rain?", closes: "fri 6pm", b: undefined });
    expect(parseCommand("/new Q | closes in 2h | b 200")).toMatchObject({ closes: "in 2h", b: 200 });
    expect(parseCommand("/new Just a question")).toMatchObject({ type: "new", closes: undefined });
    expect(parseCommand("/new")).toMatchObject({ type: "invalid" });
    expect(parseCommand("/new Q | b 5")).toMatchObject({ type: "invalid" });
  });

  it("parses resolve, void, market, odds", () => {
    expect(parseCommand("/resolve #2 YES")).toEqual({ type: "resolve", marketNum: 2, outcome: "yes" });
    expect(parseCommand("/resolve 2")).toMatchObject({ type: "invalid" });
    expect(parseCommand("/void 4")).toEqual({ type: "void", marketNum: 4 });
    expect(parseCommand("/market x")).toMatchObject({ type: "invalid" });
    expect(parseCommand("/odds")).toEqual({ type: "odds" });
    expect(parseCommand("/odds #2")).toEqual({ type: "odds", marketNum: 2 });
  });
});
