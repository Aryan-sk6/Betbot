// Telegram adapter: official Bot API over fetch with long polling. No dependencies.
// Create a bot with @BotFather and set TELEGRAM_BOT_TOKEN. In groups the default privacy mode
// delivers /commands, which is all this bot needs.
import { createEngine, type IncomingMessage } from "../core/engine.js";
import { SendQueue, createAdminChecker, type AdapterBase } from "./shared.js";

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}
export interface TgMessage {
  from?: TgUser;
  chat: { id: number; type: string };
  text?: string;
  entities?: { type: string; user?: TgUser }[];
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Translate a Telegram message into an engine message, or null if it should be skipped. */
export function toIncoming(m: TgMessage, botUsername: string): IncomingMessage | null {
  if (m.chat.type !== "group" && m.chat.type !== "supergroup") return null;
  if (!m.from || m.from.is_bot || !m.text) return null;
  // In groups Telegram sends "/bet@mybot yes 50"; strip our own suffix.
  const text = m.text.replace(new RegExp(`^(\\s*/[A-Za-z]+)@${escapeRe(botUsername)}\\b`, "i"), "$1");
  const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(" ") || m.from.username || "";
  const mentions = (m.entities ?? []).filter((e) => e.type === "text_mention" && e.user).map((e) => `tg:${e.user!.id}`);
  return { groupId: `tg:${m.chat.id}`, userId: `tg:${m.from.id}`, displayName: name, text, mentions };
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

  const me = await call<{ username: string }>("getMe");
  const queue = new SendQueue((chat, text) => call("sendMessage", { chat_id: Number(chat), text }), 350);
  const isAdmin = createAdminChecker(async (groupId) => {
    const admins = await call<{ user: TgUser }[]>("getChatAdministrators", { chat_id: Number(groupId.slice(3)) });
    return { participants: admins.map((a) => ({ id: `tg:${a.user.id}`, admin: "admin" })) };
  });
  const engine = createEngine({ ...base, isAdmin });

  console.log(`[telegram] connected as @${me.username}`);
  let offset = 0;
  for (;;) {
    try {
      const updates = await call<TgUpdate[]>("getUpdates", { offset, timeout: 30, allowed_updates: ["message"] });
      for (const u of updates) {
        offset = u.update_id + 1;
        const msg = u.message && toIncoming(u.message, me.username);
        if (!msg) continue;
        try {
          const reply = await engine.handleCommand(msg);
          if (reply) void queue.enqueue(msg.groupId.slice(3), reply);
        } catch (err) {
          console.error("[telegram] failed to handle message:", err);
        }
      }
    } catch (err) {
      console.error("[telegram] polling error, retrying in 3s:", err);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
