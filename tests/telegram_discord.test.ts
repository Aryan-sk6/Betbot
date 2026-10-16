import { describe, expect, it } from "vitest";
import { toIncoming as tg } from "../src/adapters/telegram.js";
import { toIncoming as dc, isDiscordAdmin } from "../src/adapters/discord.js";

describe("telegram", () => {
  const base = { from: { id: 7, first_name: "Khush", last_name: "S" }, chat: { id: -100, type: "supergroup" } };
  it("maps a group message and strips the bot suffix", () => {
    expect(tg({ ...base, text: "/bet@GroupBetBot yes 50" }, "groupbetbot")).toMatchObject({
      groupId: "tg:-100", userId: "tg:7", displayName: "Khush S", text: "/bet yes 50",
    });
  });
  it("leaves commands for other bots alone and skips private chats / bots", () => {
    expect(tg({ ...base, text: "/bet@other yes 5" }, "mybot")!.text).toBe("/bet@other yes 5");
    expect(tg({ ...base, chat: { id: 1, type: "private" }, text: "/bal" }, "mybot")).toBeNull();
    expect(tg({ ...base, from: { id: 9, is_bot: true }, text: "/bal" }, "mybot")).toBeNull();
  });
  it("collects text_mention ids", () => {
    const m = tg({ ...base, text: "/balance Bob", entities: [{ type: "text_mention", user: { id: 3 } }] }, "mybot");
    expect(m!.mentions).toEqual(["tg:3"]);
  });
});

describe("discord", () => {
  const msg = { channel_id: "c1", guild_id: "g1", content: "/balance", author: { id: "u1", username: "khush", global_name: "Khush" } };
  it("maps guild messages, preferring nick, and skips DMs and bots", () => {
    expect(dc(msg)).toMatchObject({ groupId: "dc:g1", userId: "dc:u1", displayName: "Khush" });
    expect(dc({ ...msg, member: { nick: "K" } })!.displayName).toBe("K");
    expect(dc({ ...msg, guild_id: undefined })).toBeNull();
    expect(dc({ ...msg, author: { ...msg.author, bot: true } })).toBeNull();
  });
  it("detects admins by owner or permission bits", () => {
    const guild = { owner_id: "o", roles: [{ id: "r1", permissions: "8" }, { id: "r2", permissions: "2048" }] };
    expect(isDiscordAdmin(guild, { roles: [] }, "o")).toBe(true);
    expect(isDiscordAdmin(guild, { roles: ["r1"] }, "u")).toBe(true);
    expect(isDiscordAdmin(guild, { roles: ["r2"] }, "u")).toBe(false);
  });
});
