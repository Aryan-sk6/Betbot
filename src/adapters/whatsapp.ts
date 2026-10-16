// WhatsApp adapter (unofficial, via Baileys). Translates platform messages to engine calls and back.
// The engine never imports from here.
import makeWASocket, {
  DisconnectReason,
  normalizeMessageContent,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import { createEngine } from "../core/engine.js";
import { SendQueue, type AdapterBase } from "./shared.js";

const AUTH_DIR = process.env.GROUPBET_AUTH_DIR ?? "./auth";

/** Plain text of a message, from `conversation` or `extendedTextMessage.text`. */
export function extractText(m: WAMessage): string {
  const content = normalizeMessageContent(m.message);
  return content?.conversation ?? content?.extendedTextMessage?.text ?? "";
}

export function extractMentions(m: WAMessage): string[] {
  const content = normalizeMessageContent(m.message);
  return content?.extendedTextMessage?.contextInfo?.mentionedJid ?? [];
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

function printQr(qr: string): void {
  console.log("\nScan this QR code with WhatsApp > Linked devices (use a spare number):\n");
  qrcode.generate(qr, { small: true });
}

export async function runWhatsApp(base: AdapterBase): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let sock: WASocket | undefined;
  const queue = new SendQueue((jid, text) => sock!.sendMessage(jid, { text }));
  const engine = createEngine(base);

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
        } else printQr(qr);
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
