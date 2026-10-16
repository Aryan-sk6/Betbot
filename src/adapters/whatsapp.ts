// WhatsApp adapter (unofficial, via Baileys). Translates platform messages to engine calls and back.
// The engine never imports from here.
import makeWASocket, {
  DisconnectReason,
  normalizeMessageContent,
  useMultiFileAuthState,
  type GroupMetadata,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import { createEngine, type EngineOptions } from "../core/engine.js";

const AUTH_DIR = process.env.GROUPBET_AUTH_DIR ?? "./auth";
const SEND_DELAY_MS = 700;
const ADMIN_CACHE_MS = 60_000;

/** Plain text of a message, from `conversation` or `extendedTextMessage.text`. */
export function extractText(m: WAMessage): string {
  const content = normalizeMessageContent(m.message);
  return content?.conversation ?? content?.extendedTextMessage?.text ?? "";
}

export function extractMentions(m: WAMessage): string[] {
  const content = normalizeMessageContent(m.message);
  return content?.extendedTextMessage?.contextInfo?.mentionedJid ?? [];
}

/** Sends one message at a time with a pause between sends, to avoid bursts. */
export class SendQueue {
  private tail: Promise<void> = Promise.resolve();
  constructor(
    private readonly send: (jid: string, text: string) => Promise<unknown>,
    private readonly delayMs = SEND_DELAY_MS,
    private readonly sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  ) {}

  enqueue(jid: string, text: string): Promise<void> {
    const run = this.tail.then(async () => {
      try {
        await this.send(jid, text);
      } catch (err) {
        console.error("[whatsapp] send failed:", err);
      }
      await this.sleep(this.delayMs);
    });
    this.tail = run;
    return run;
  }
}

/** Admin lookup against group metadata, cached for a minute per group. */
export function createAdminChecker(
  getMetadata: (groupJid: string) => Promise<Pick<GroupMetadata, "participants">>,
  ttlMs = ADMIN_CACHE_MS,
  now: () => number = Date.now,
) {
  const cache = new Map<string, { at: number; admins: Set<string> }>();
  return async (groupJid: string, userId: string): Promise<boolean> => {
    let entry = cache.get(groupJid);
    if (!entry || now() - entry.at > ttlMs) {
      const meta = await getMetadata(groupJid);
      const admins = new Set<string>();
      for (const p of meta.participants) {
        if (!(p.admin || p.isAdmin || p.isSuperAdmin)) continue;
        // A participant can be known by LID or phone-number JID; accept any of them.
        for (const id of [p.id, p.lid, p.phoneNumber]) if (id) admins.add(id);
      }
      entry = { at: now(), admins };
      cache.set(groupJid, entry);
    }
    return entry.admins.has(userId);
  };
}

// Baileys needs a logger; keep it quiet except for warnings and errors.
const logger = {
  level: "warn",
  child() {
    return logger;
  },
  trace() {},
  debug() {},
  info() {},
  warn: (obj: unknown, msg?: string) => console.warn("[baileys]", msg ?? "", obj),
  error: (obj: unknown, msg?: string) => console.error("[baileys]", msg ?? "", obj),
};

async function printQr(qr: string): Promise<void> {
  console.log("\nScan this QR code with WhatsApp > Linked devices (use a spare number):\n");
  try {
    // Optional: renders a scannable QR if `qrcode-terminal` is installed.
    const spec = "qrcode-terminal";
    const mod = await import(/* @vite-ignore */ spec);
    (mod.default ?? mod).generate(qr, { small: true });
  } catch {
    console.log("(Install `qrcode-terminal` to render the QR here.) Raw QR payload:\n" + qr + "\n");
  }
}

export async function runWhatsApp(base: Omit<EngineOptions, "isAdmin" | "now">): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let sock: WASocket | undefined;
  const queue = new SendQueue((jid, text) => sock!.sendMessage(jid, { text }));
  const isAdmin = createAdminChecker((jid) => sock!.groupMetadata(jid));
  const engine = createEngine({ ...base, isAdmin });

  function connect(): void {
    const s = makeWASocket({ auth: state, logger, markOnlineOnConnect: false });
    sock = s;
    s.ev.on("creds.update", saveCreds);

    s.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        const phone = process.env.GROUPBET_PAIR_PHONE?.replace(/\D/g, "");
        if (phone && !state.creds.registered) {
          // Pairing-code login: WhatsApp > Linked devices > Link with phone number instead.
          s.requestPairingCode(phone)
            .then((code) => console.log(`\nPairing code: ${code}\nEnter it on the phone: Linked devices > Link with phone number.\n`))
            .catch((err) => console.error("[whatsapp] pairing code request failed:", err));
        } else void printQr(qr);
      }
      if (connection === "open") console.log("[whatsapp] connected");
      if (connection === "close") {
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          console.error(`[whatsapp] logged out. Delete ${AUTH_DIR} and restart to scan a new QR code.`);
          process.exit(1);
        }
        console.warn(`[whatsapp] connection closed (${code ?? "unknown"}), reconnecting...`);
        setTimeout(connect, code === DisconnectReason.restartRequired ? 0 : 3000);
      }
    });

    s.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;
      for (const m of messages) void handleMessage(m);
    });
  }

  async function handleMessage(m: WAMessage): Promise<void> {
    try {
      const jid = m.key.remoteJid;
      if (!jid || !jid.endsWith("@g.us") || m.key.fromMe) return;
      const sender = m.key.participant;
      if (!sender) return;
      const text = extractText(m);
      if (!text) return;
      const reply = await engine.handleCommand({
        groupId: jid,
        userId: sender,
        displayName: m.pushName ?? "",
        text,
        mentions: extractMentions(m),
      });
      if (reply) void queue.enqueue(jid, reply);
    } catch (err) {
      console.error("[whatsapp] failed to handle message:", err);
    }
  }

  connect();
  await new Promise<never>(() => {}); // run until the process is stopped
}
