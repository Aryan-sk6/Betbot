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
    expect(parseCommand("  /BET   YES    50  ")).toEqual({ type: "bet", option: "yes", points: 50, marketNum: undefined });
    expect(parseCommand("/Bet No 7")).toMatchObject({ option: "no", points: 7 });
  });

  it("accepts a market id before or after", () => {
    expect(parseCommand("/bet #3 yes 50")).toMatchObject({ marketNum: 3, option: "yes", points: 50 });
    expect(parseCommand("/bet 3 no 10")).toMatchObject({ marketNum: 3, option: "no" });
    expect(parseCommand("/bet yes 50 #3")).toMatchObject({ marketNum: 3, points: 50 });
  });

  it("rejects missing args, negative and non-numeric points", () => {
    for (const t of ["/bet", "/bet yes", "/bet yes -5", "/bet yes abc", "/bet yes 0", "/bet yes 5.5", "/bet yes 1e3"]) {
      expect(parseCommand(t), t).toMatchObject({ type: "invalid", command: "bet" });
    }
  });

  it("takes multi-word option names and option numbers", () => {
    expect(parseCommand("/bet Real Madrid 50")).toMatchObject({ type: "bet", option: "real madrid", points: 50, marketNum: undefined });
    expect(parseCommand("/bet #2 real madrid 50")).toMatchObject({ option: "real madrid", marketNum: 2 });
    expect(parseCommand("/bet 2 real madrid 50")).toMatchObject({ option: "real madrid", marketNum: 2 });
    expect(parseCommand("/bet real madrid 50 #4")).toMatchObject({ option: "real madrid", marketNum: 4 });
    // two words: the number is the option, not a market id
    expect(parseCommand("/bet 2 50")).toMatchObject({ option: "2", points: 50, marketNum: undefined });
    expect(parseCommand("/bet #3 2 50")).toMatchObject({ option: "2", marketNum: 3 });
    expect(parseCommand("/sell aus all")).toMatchObject({ type: "sell", option: "aus", shares: "all" });
    expect(parseCommand("/resolve 2 real madrid")).toEqual({ type: "resolve", marketNum: 2, option: "real madrid" });
    expect(parseCommand("/resolve 2 3")).toEqual({ type: "resolve", marketNum: 2, option: "3" });
  });

  it("parses /new with custom options", () => {
    expect(parseCommand("/new Who wins? | options India, Australia ,  Draw | closes fri 6pm")).toEqual({
      type: "new", question: "Who wins?", closes: "fri 6pm", b: undefined, options: ["India", "Australia", "Draw"],
    });
    expect(parseCommand("/new Q | choices A, B")).toMatchObject({ options: ["A", "B"] });
    expect(parseCommand("/new Q | options Only")).toMatchObject({ type: "invalid", command: "new", reason: expect.stringMatching(/at least 2/i) });
    expect(parseCommand("/new Q | options A, a")).toMatchObject({ type: "invalid", reason: expect.stringMatching(/Duplicate/) });
    expect(parseCommand("/new Q | options A, 3")).toMatchObject({ type: "invalid" });
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
    expect(parseCommand("/resolve #2 YES")).toEqual({ type: "resolve", marketNum: 2, option: "yes" });
    expect(parseCommand("/resolve 2")).toMatchObject({ type: "invalid" });
    expect(parseCommand("/void 4")).toEqual({ type: "void", marketNum: 4 });
    expect(parseCommand("/market x")).toMatchObject({ type: "invalid" });
    expect(parseCommand("/odds")).toEqual({ type: "odds" });
    expect(parseCommand("/odds #2")).toEqual({ type: "odds", marketNum: 2 });
  });
});
