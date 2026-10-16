import { describe, expect, it } from "vitest";
import { SendQueue } from "../src/adapters/shared.js";

describe("shared adapter utils", () => {
  it("queue sends in order with a delay between sends", async () => {
    const sent: string[] = [];
    const sleeps: number[] = [];
    const q = new SendQueue(async (_j, t) => void sent.push(t), 700, async (ms) => void sleeps.push(ms));
    await Promise.all([q.enqueue("g", "a"), q.enqueue("g", "b"), q.enqueue("g", "c")]);
    expect(sent).toEqual(["a", "b", "c"]);
    expect(sleeps).toEqual([700, 700, 700]);
  });
});
