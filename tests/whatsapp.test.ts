import { describe, expect, it, vi } from "vitest";
import type { WAMessage } from "@whiskeysockets/baileys";
import { extractMentions, extractText } from "../src/adapters/whatsapp.js";

const msg = (message: WAMessage["message"]) => ({ key: {}, message }) as WAMessage;

describe("whatsapp helpers", () => {
  it("extracts text from conversation and extendedTextMessage", () => {
    expect(extractText(msg({ conversation: "/balance" }))).toBe("/balance");
    expect(extractText(msg({ extendedTextMessage: { text: "/odds" } }))).toBe("/odds");
    expect(extractText(msg({ imageMessage: {} }))).toBe("");
    expect(extractMentions(msg({ extendedTextMessage: { text: "x", contextInfo: { mentionedJid: ["1@lid"] } } }))).toEqual(["1@lid"]);
  });
});
