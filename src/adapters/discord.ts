// Discord adapter: Gateway (WebSocket) + REST, no dependencies. Needs Node 22+ for the global WebSocket.
// Set DISCORD_BOT_TOKEN and enable "Message Content Intent" for the bot in the Developer Portal.
// One Discord server (guild) = one group economy.
import { createEngine, type IncomingMessage } from "../core/engine.js";
import { SendQueue, type AdapterBase } from "./shared.js";

const API = "https://discord.com/api/v10";
const GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";
// GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT
const INTENTS = (1 << 0) | (1 << 9) | (1 << 15);
const ADMINISTRATOR = 0x8n;
const MANAGE_GUILD = 0x20n;

export interface DcMessage {
  channel_id: string;
  guild_id?: string;
  content: string;
  author: { id: string; username: string; global_name?: string | null; bot?: boolean };
  member?: { nick?: string | null };
  mentions?: { id: string }[];
}

export function toIncoming(m: DcMessage): IncomingMessage | null {
  if (!m.guild_id || m.author.bot || !m.content) return null;
  return {
    groupId: `dc:${m.guild_id}`,
    userId: `dc:${m.author.id}`,
    displayName: m.member?.nick || m.author.global_name || m.author.username,
    text: m.content,
    mentions: (m.mentions ?? []).map((u) => `dc:${u.id}`),
  };
}

/** Guild owner, or a member with a role granting Administrator or Manage Server. */
export function isDiscordAdmin(
  guild: { owner_id: string; roles: { id: string; permissions: string }[] },
  member: { user?: { id: string }; roles: string[] },
  userId: string,
): boolean {
  if (guild.owner_id === userId) return true;
  return guild.roles.some(
    (r) => member.roles.includes(r.id) && (BigInt(r.permissions) & (ADMINISTRATOR | MANAGE_GUILD)) !== 0n,
  );
}

export async function runDiscord(base: AdapterBase): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("Set DISCORD_BOT_TOKEN (Discord Developer Portal > Bot).");
  if (typeof WebSocket === "undefined") throw new Error("Discord mode needs Node 22+ (global WebSocket).");

  async function rest<T>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
    const res = await fetch(API + path, {
      method,
      headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && retry) {
      const { retry_after } = (await res.json()) as { retry_after: number };
      await new Promise((r) => setTimeout(r, retry_after * 1000 + 50));
      return rest(method, path, body, false);
    }
    if (!res.ok) throw new Error(`Discord ${method} ${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  const queue = new SendQueue<string>(
    (channel, content) => rest("POST", `/channels/${channel}/messages`, { content, allowed_mentions: { parse: [] } }),
    300,
  );

  const adminCache = new Map<string, { at: number; ok: boolean }>();
  const isAdmin = async (groupId: string, userId: string): Promise<boolean> => {
    const key = `${groupId}/${userId}`;
    const hit = adminCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.ok;
    const guildId = groupId.slice(3);
    const uid = userId.slice(3);
    const [guild, member] = await Promise.all([
      rest<{ owner_id: string; roles: { id: string; permissions: string }[] }>("GET", `/guilds/${guildId}`),
      rest<{ roles: string[] }>("GET", `/guilds/${guildId}/members/${uid}`),
    ]);
    const ok = isDiscordAdmin(guild, member, uid);
    adminCache.set(key, { at: Date.now(), ok });
    return ok;
  };
  const engine = createEngine({ ...base, isAdmin });

  let seq: number | null = null;
  let sessionId: string | undefined;
  let resumeUrl: string | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  function connect(): void {
    const ws = new WebSocket(resumeUrl ? `${resumeUrl}/?v=10&encoding=json` : GATEWAY);
    const send = (op: number, d: unknown) => ws.send(JSON.stringify({ op, d }));
    const identify = () =>
      send(2, { token, intents: INTENTS, properties: { os: process.platform, browser: "betbot", device: "betbot" } });

    ws.onmessage = async (ev) => {
      const p = JSON.parse(String(ev.data)) as { op: number; t?: string; s?: number; d: any };
      if (p.s != null) seq = p.s;
      switch (p.op) {
        case 10:
          clearInterval(heartbeat);
          heartbeat = setInterval(() => send(1, seq), p.d.heartbeat_interval);
          if (sessionId) send(6, { token, session_id: sessionId, seq });
          else identify();
          break;
        case 1:
          send(1, seq);
          break;
        case 7:
          ws.close(4000);
          break;
        case 9:
          if (!p.d) sessionId = resumeUrl = undefined;
          setTimeout(() => (p.d ? send(6, { token, session_id: sessionId, seq }) : identify()), 1500);
          break;
        case 0:
          if (p.t === "READY") {
            sessionId = p.d.session_id;
            resumeUrl = p.d.resume_gateway_url;
            console.log(`[discord] connected as ${p.d.user.username}`);
          } else if (p.t === "MESSAGE_CREATE") {
            const msg = toIncoming(p.d as DcMessage);
            if (!msg) break;
            try {
              const reply = await engine.handleCommand(msg);
              if (reply) void queue.enqueue(p.d.channel_id, reply);
            } catch (err) {
              console.error("[discord] failed to handle message:", err);
            }
          }
          break;
      }
    };

    ws.onclose = (ev) => {
      clearInterval(heartbeat);
      if (ev.code === 4004) {
        console.error("[discord] invalid token.");
        process.exit(1);
      }
      if (ev.code === 4013 || ev.code === 4014) {
        console.error("[discord] intents rejected: enable Message Content Intent for the bot in the Developer Portal.");
        process.exit(1);
      }
      if (ev.code === 4007 || ev.code === 4009) sessionId = resumeUrl = undefined;
      console.warn(`[discord] connection closed (${ev.code}), reconnecting...`);
      setTimeout(connect, 3000);
    };
    ws.onerror = () => {}; // onclose follows and handles reconnecting
  }

  connect();
  await new Promise<never>(() => {});
}
