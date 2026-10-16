// Telegram adapter: official Bot API over fetch with long polling. No SDK.
// Create a bot with @BotFather and set TELEGRAM_BOT_TOKEN.
//
// Natural-language mode and BotFather privacy mode: with privacy ON (the default) Telegram
// delivers /commands and replies to the bot's own messages, but may not deliver plain
// @mentions. To use @mentions, disable privacy (/setprivacy > Disable in @BotFather, then
// remove and re-add the bot to the group) or make the bot a group admin.
import { randomBytes } from "node:crypto";
import { parseCommand, type Command } from "../core/commands.js";
import { createEngine, type Actor, type Engine, type IncomingMessage } from "../core/engine.js";
import { createNlu, formatCommand, needsConfirmation, type Nlu } from "../core/nlu.js";
import { DEFAULT_TZ } from "../core/time.js";
import { SendQueue, createAdminChecker, type AdapterBase } from "./shared.js";

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}
export interface TgMessage {
  message_id?: number;
  from?: TgUser;
  chat: { id: number; type: string };
  text?: string;
  entities?: { type: string; offset?: number; length?: number; user?: TgUser }[];
  reply_to_message?: { from?: TgUser };
}
export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  data?: string;
  message?: { message_id: number; chat: { id: number } };
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isGroup = (m: TgMessage) => m.chat.type === "group" || m.chat.type === "supergroup";
const displayName = (u: TgUser) => [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || "";

/** Translate a Telegram message into an engine message, or null if it should be skipped. */
export function toIncoming(m: TgMessage, botUsername: string): IncomingMessage | null {
  if (!isGroup(m)) return null;
  if (!m.from || m.from.is_bot || !m.text) return null;
  // In groups Telegram sends "/bet@mybot yes 50"; strip our own suffix.
  const text = m.text.replace(new RegExp(`^(\\s*/[A-Za-z]+)@${escapeRe(botUsername)}\\b`, "i"), "$1");
  const mentions = (m.entities ?? []).filter((e) => e.type === "text_mention" && e.user).map((e) => `tg:${e.user!.id}`);
  return { groupId: `tg:${m.chat.id}`, userId: `tg:${m.from.id}`, displayName: displayName(m.from), text, mentions };
}

/**
 * Text for the natural-language layer, or null if the message isn't addressed to the bot.
 * Addressed = @mentions the bot, or replies to one of the bot's messages. The @mention is removed.
 */
export function nluText(m: TgMessage, me: { id: number; username: string }): string | null {
  if (!isGroup(m) || !m.from || m.from.is_bot || !m.text) return null;
  const mention = new RegExp(`@${escapeRe(me.username)}\\b`, "gi");
  const mentioned = mention.test(m.text);
  const repliedToBot = m.reply_to_message?.from?.id === me.id;
  if (!mentioned && !repliedToBot) return null;
  const cleaned = m.text.replace(mention, " ").replace(/\s+/g, " ").trim();
  return cleaned || null;
}

export interface OutMessage {
  text: string;
  reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] };
}

/** The network calls the handler needs, injected so the logic can be tested without Telegram. */
export interface TelegramIo {
  send(chatId: number, msg: OutMessage): void;
  answerCallback(id: string, text?: string): Promise<void>;
  clearKeyboard(chatId: number, messageId: number): Promise<void>;
}

interface Pending {
  actor: Actor;
  cmd: Command;
  expires: number;
}

const PENDING_TTL_MS = 2 * 60_000;
const MAX_PENDING = 200;

export function createTelegramHandler(opts: {
  engine: Engine;
  io: TelegramIo;
  me: { id: number; username: string };
  nlu?: Nlu | null;
  tz?: string;
  now?: () => number;
}) {
  const { engine, io, me, nlu } = opts;
  const tz = opts.tz ?? DEFAULT_TZ;
  const now = opts.now ?? Date.now;
  const pending = new Map<string, Pending>();

  function remember(p: Omit<Pending, "expires">): string {
    for (const [k, v] of pending) if (v.expires < now()) pending.delete(k);
    if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value!);
    const token = randomBytes(9).toString("base64url");
    pending.set(token, { ...p, expires: now() + PENDING_TTL_MS });
    return token;
  }

  async function handleMessage(m: TgMessage): Promise<void> {
    const chat = m.chat.id;
    const direct = toIncoming(m, me.username);

    // Fast path: "/" commands go straight to the engine and never touch the model.
    if (direct && direct.text.trim().startsWith("/")) {
      const reply = await engine.handleCommand(direct);
      if (reply) io.send(chat, { text: reply });
      return;
    }
    if (!nlu) return;
    const text = nluText(m, me);
    if (!text || !m.from) return;

    // "@bot /balance" is still a plain command.
    const typed = parseCommand(text);
    const actor: Actor = { groupId: `tg:${chat}`, userId: `tg:${m.from.id}`, displayName: displayName(m.from) };
    if (typed) {
      const reply = await engine.execute(actor, typed);
      io.send(chat, { text: reply });
      return;
    }
    if (text.startsWith("/")) return;

    if (!nlu.allow(actor.groupId, actor.userId)) {
      io.send(chat, { text: "Easy there, too many questions. Try again in a minute, or use /help commands." });
      return;
    }
    const ctx = engine.getContext(actor.groupId, actor.userId);
    const result = await nlu.parse(text, {
      openMarkets: ctx.markets.map((x) => ({ id: x.num, question: x.question })),
      now: new Date(now()).toISOString(),
      timezone: tz,
      userDisplayName: actor.displayName,
    });
    if (!result) {
      io.send(chat, { text: "I didn't catch that. Try /help for commands." });
      return;
    }
    if ("clarify" in result) {
      io.send(chat, { text: result.clarify });
      return;
    }
    if (needsConfirmation(result, ctx.balance)) {
      const token = remember({ actor, cmd: result });
      io.send(chat, {
        text: `${actor.displayName}, confirm: ${formatCommand(result)}`,
        reply_markup: { inline_keyboard: [[{ text: "Confirm", callback_data: `nlu:ok:${token}` }, { text: "Cancel", callback_data: `nlu:no:${token}` }]] },
      });
      return;
    }
    io.send(chat, { text: await engine.execute(actor, result) });
  }

  async function handleCallback(q: TgCallbackQuery): Promise<void> {
    const m = q.data?.match(/^nlu:(ok|no):([\w-]+)$/);
    if (!m || !q.message) return;
    const entry = pending.get(m[2]);
    const chat = q.message.chat.id;
    if (!entry || entry.expires < now()) {
      pending.delete(m[2]);
      await io.answerCallback(q.id, "That request expired.");
      await io.clearKeyboard(chat, q.message.message_id);
      return;
    }
    if (entry.actor.userId !== `tg:${q.from.id}`) {
      await io.answerCallback(q.id, "Only the person who asked can confirm this.");
      return;
    }
    pending.delete(m[2]);
    await io.answerCallback(q.id);
    await io.clearKeyboard(chat, q.message.message_id);
    if (m[1] === "no") {
      io.send(chat, { text: "Cancelled." });
      return;
    }
    // Runs through the engine as the original user, so every normal permission check applies.
    io.send(chat, { text: await engine.execute(entry.actor, entry.cmd) });
  }

  return {
    async handleUpdate(u: TgUpdate): Promise<void> {
      if (process.env.LOG_LEVEL === "debug") {
        // Metadata only, never message text.
        const m = u.message;
        console.debug(
          `[telegram] update ${m ? `message chat=${m.chat.type} entities=[${(m.entities ?? []).map((e) => e.type)}] reply_to_bot=${m.reply_to_message?.from?.id === me.id}` : u.callback_query ? "callback_query" : "other"}`,
        );
      }
      try {
        if (u.message) await handleMessage(u.message);
        else if (u.callback_query) await handleCallback(u.callback_query);
      } catch (err) {
        console.error("[telegram] failed to handle update:", err);
      }
    },
  };
}

export async function runTelegram(base: AdapterBase, fetchFn: typeof fetch = fetch): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Set TELEGRAM_BOT_TOKEN (create a bot with @BotFather).");

  async function call<T>(method: string, body: Record<string, unknown> = {}): Promise<T> {
    const res = await fetchFn(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!json.ok) throw new Error(`Telegram ${method}: ${json.description ?? res.status}`);
    return json.result;
  }

  const me = await call<{ id: number; username: string }>("getMe");
  const queue = new SendQueue<OutMessage>((chat, msg) => call("sendMessage", { chat_id: Number(chat), ...msg }), 350);
  const io: TelegramIo = {
    send: (chatId, msg) => void queue.enqueue(String(chatId), msg),
    answerCallback: (id, text) => call<boolean>("answerCallbackQuery", { callback_query_id: id, text }).then(() => {}),
    clearKeyboard: (chat_id, message_id) =>
      call<unknown>("editMessageReplyMarkup", { chat_id, message_id, reply_markup: { inline_keyboard: [] } }).then(() => {}, () => {}),
  };
  const isAdmin = createAdminChecker(async (groupId) => {
    const admins = await call<{ user: TgUser }[]>("getChatAdministrators", { chat_id: Number(groupId.slice(3)) });
    return { participants: admins.map((a) => ({ id: `tg:${a.user.id}`, admin: "admin" })) };
  });
  const engine = createEngine({ ...base, isAdmin });
  const nlu = createNlu();
  const handler = createTelegramHandler({ engine, io, me, nlu, tz: base.tz });

  console.log(`[telegram] connected as @${me.username}${nlu ? ` (natural language: ${nlu.provider})` : ""}`);
  let offset = 0;
  for (;;) {
    try {
      const updates = await call<TgUpdate[]>("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message", "callback_query"],
      });
      for (const u of updates) {
        offset = u.update_id + 1;
        await handler.handleUpdate(u);
      }
    } catch (err) {
      console.error("[telegram] polling error, retrying in 3s:", err);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
