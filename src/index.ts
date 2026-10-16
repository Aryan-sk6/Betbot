import { openDb } from "./db/db.js";
import { DEFAULT_TZ, isValidTz } from "./core/time.js";

function pickAdapter(): string {
  const i = process.argv.indexOf("--adapter");
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  const flag = process.argv.find((a) => a.startsWith("--adapter="));
  if (flag) return flag.split("=")[1];
  return process.env.GROUPBET_ADAPTER ?? "cli";
}

const adapter = pickAdapter();
const tz = process.env.TZ && isValidTz(process.env.TZ) ? process.env.TZ : DEFAULT_TZ;
const defaultB = process.env.GROUPBET_B ? Number(process.env.GROUPBET_B) : 100;
// The CLI is a throwaway playground unless a DB path is given; WhatsApp mode persists by default.
const dbPath = process.env.GROUPBET_DB ?? (adapter === "cli" ? ":memory:" : "./data/groupbet.db");

if (dbPath !== ":memory:") {
  const { mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(dbPath), { recursive: true });
}
const db = openDb(dbPath);
const base = { db, tz, defaultB };

// Several adapters can share one process and database: --adapter telegram,discord
const runners: Record<string, () => Promise<void>> = {
  cli: async () => (await import("./adapters/cli.js")).runCli(base),
  whatsapp: async () => (await import("./adapters/whatsapp.js")).runWhatsApp(base),
  telegram: async () => (await import("./adapters/telegram.js")).runTelegram(base),
  discord: async () => (await import("./adapters/discord.js")).runDiscord(base),
};
const names = adapter.split(",").map((n) => n.trim());
const unknown = names.find((n) => !runners[n]);
if (unknown) {
  console.error(`Unknown adapter "${unknown}". Use one or more of: ${Object.keys(runners).join(", ")}.`);
  process.exit(1);
}
await Promise.all(names.map((n) => runners[n]()));
