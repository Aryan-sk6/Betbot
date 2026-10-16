import { createInterface } from "node:readline";
import { createEngine, type EngineOptions } from "../core/engine.js";

const GROUP = "cli-group";
const idOf = (name: string) => `${name}@cli`;

const CLI_HELP = `CLI simulator. One fake group, many fake users.
  as rahul: /bet yes 50   send a message as "rahul" (he's created on first use)
  /bet yes 50             send as the current user (starts as "you")
  :admin <name>           toggle admin for a user ("admin" is admin by default)
  :advance <n>m|h|d       move the fake clock forward (to test auto-close)
  :who                    show users and current user
  :quit                   exit`;

/** Line handler, separated from readline so it can be driven from tests. */
export function createCliSession(base: Omit<EngineOptions, "isAdmin" | "now">) {
  let offset = 0;
  const admins = new Set<string>([idOf("admin")]);
  const users = new Set<string>(["you"]);
  let current = "you";
  const engine = createEngine({
    ...base,
    now: () => Date.now() + offset,
    isAdmin: (_group, userId) => admins.has(userId),
  });

  async function handleLine(line: string): Promise<string | null> {
    const text = line.trim();
    if (!text) return null;
    if (text === ":quit" || text === ":q") return "__quit__";
    if (text === ":help") return CLI_HELP;
    if (text === ":who") return `current: ${current}\nusers: ${[...users].join(", ")}\nadmins: ${[...admins].map((a) => a.replace("@cli", "")).join(", ")}`;
    let m = text.match(/^:admin\s+(\w+)$/);
    if (m) {
      const id = idOf(m[1].toLowerCase());
      if (admins.delete(id)) return `${m[1]} is no longer admin`;
      admins.add(id);
      return `${m[1]} is now admin`;
    }
    m = text.match(/^:advance\s+(\d+)\s*([mhd])$/);
    if (m) {
      offset += Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
      return `clock advanced; now ${new Date(Date.now() + offset).toISOString()}`;
    }
    if (text.startsWith(":")) return "Unknown meta command. :help";

    let name = current;
    let body = text;
    const as = text.match(/^as\s+(\w+)\s*:\s*([\s\S]*)$/i);
    if (as) {
      name = as[1].toLowerCase();
      body = as[2];
      current = name;
    }
    users.add(name);
    const reply = await engine.handleCommand({ groupId: GROUP, userId: idOf(name), displayName: name, text: body });
    return reply;
  }

  return { handleLine, engine };
}

export async function runCli(base: Omit<EngineOptions, "isAdmin" | "now">): Promise<void> {
  const session = createCliSession(base);
  console.log("groupbet CLI. Type :help for meta commands, /help for bot commands.\n");
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  rl.prompt();
  for await (const line of rl) {
    const out = await session.handleLine(line);
    if (out === "__quit__") break;
    if (out) console.log(out.split("\n").map((l) => "  bot| " + l).join("\n"));
    rl.prompt();
  }
  rl.close();
}
