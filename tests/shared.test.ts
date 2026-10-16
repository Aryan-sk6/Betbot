import { describe, expect, it, vi } from "vitest";
import { SendQueue, createAdminChecker } from "../src/adapters/shared.js";

describe("shared adapter utils", () => {
  it("queue sends in order with a delay between sends", async () => {
    const sent: string[] = [];
    const sleeps: number[] = [];
    const q = new SendQueue(async (_j, t) => void sent.push(t), 700, async (ms) => void sleeps.push(ms));
    await Promise.all([q.enqueue("g", "a"), q.enqueue("g", "b"), q.enqueue("g", "c")]);
    expect(sent).toEqual(["a", "b", "c"]);
    expect(sleeps).toEqual([700, 700, 700]);
  });

  it("admin checker matches any id form and caches for a minute", async () => {
    let t = 0;
    const get = vi.fn(async () => ({
      participants: [
        { id: "1@lid", phoneNumber: "91@s.whatsapp.net", admin: "admin" as const },
        { id: "2@lid" },
      ],
    }));
    const isAdmin = createAdminChecker(get, 60_000, () => t);
    expect(await isAdmin("g", "1@lid")).toBe(true);
    expect(await isAdmin("g", "91@s.whatsapp.net")).toBe(true);
    expect(await isAdmin("g", "2@lid")).toBe(false);
    expect(get).toHaveBeenCalledTimes(1);
    t = 61_000;
    await isAdmin("g", "1@lid");
    expect(get).toHaveBeenCalledTimes(2);
  });
});
