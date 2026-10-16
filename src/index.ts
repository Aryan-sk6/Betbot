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

switch (adapter) {
  case "cli": {
    const { runCli } = await import("./adapters/cli.js");
    await runCli(base);
    break;
  }
  case "whatsapp": {
    const { runWhatsApp } = await import("./adapters/whatsapp.js");
    await runWhatsApp(base);
    break;
  }
  default:
    console.error(`Unknown adapter "${adapter}". Use --adapter cli or --adapter whatsapp.`);
    process.exit(1);
}
