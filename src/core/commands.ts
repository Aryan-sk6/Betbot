import { MAX_LABEL, MAX_OPTIONS, validateOptions } from "./options.js";

export type Command =
  | { type: "new"; question: string; closes?: string; b?: number; options?: string[] }
  | { type: "bet"; option: string; points: number; marketNum?: number }
  | { type: "sell"; option: string; shares: number | "all"; marketNum?: number }
  | { type: "odds"; marketNum?: number }
  | { type: "markets" }
  | { type: "market"; marketNum: number }
  | { type: "resolve"; marketNum: number; option: string }
  | { type: "void"; marketNum: number }
  | { type: "balance" }
  | { type: "leaderboard" }
  | { type: "help" }
  | { type: "invalid"; command: string; usage: string; reason?: string };

const USAGE = {
  new: "/new <question> | closes <time>   or   /new <question> | options A, B, C | closes <time>",
  bet: "/bet [#id] <option> <points>   (option: yes, no, or a name/number from the market)",
  sell: "/sell [#id] <option> <shares|all>",
  odds: "/odds [#id]",
  market: "/market <#id>",
  resolve: "/resolve <#id> <option>",
  void: "/void <#id>",
} as const;

export const MAX_POINTS = 1_000_000_000;

function invalid(command: string, usage: string, reason?: string): Command {
  return { type: "invalid", command, usage, reason };
}

function parseId(tok: string | undefined): number | null {
  const m = tok?.match(/^#?(\d{1,9})$/);
  return m ? Number(m[1]) : null;
}

/**
 * Parse a chat line. Returns null when the text is not a command we know about
 * (no "/" prefix, or an unknown command): the bot stays silent for those.
 */
export function parseCommand(text: string): Command | null {
  const trimmed = text.replace(/[ ​]/g, " ").trim();
  if (!trimmed.startsWith("/")) return null;
  const m = trimmed.match(/^\/([A-Za-z]+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const rest = (m[2] ?? "").trim();
  const args = rest === "" ? [] : rest.toLowerCase().split(/\s+/);

  switch (name) {
    case "new":
      return parseNew(rest);
    case "bet":
      return parseTrade("bet", args);
    case "sell":
      return parseTrade("sell", args);
    case "odds": {
      if (args.length === 0) return { type: "odds" };
      const id = args.length === 1 ? parseId(args[0]) : null;
      return id === null ? invalid("odds", USAGE.odds) : { type: "odds", marketNum: id };
    }
    case "markets":
      return { type: "markets" };
    case "market": {
      const id = args.length === 1 ? parseId(args[0]) : null;
      return id === null ? invalid("market", USAGE.market) : { type: "market", marketNum: id };
    }
    case "resolve": {
      const id = parseId(args[0]);
      if (id === null || args.length < 2) return invalid("resolve", USAGE.resolve);
      return { type: "resolve", marketNum: id, option: args.slice(1).join(" ") };
    }
    case "void": {
      const id = args.length === 1 ? parseId(args[0]) : null;
      return id === null ? invalid("void", USAGE.void) : { type: "void", marketNum: id };
    }
    case "balance":
    case "bal":
      return { type: "balance" };
    case "leaderboard":
    case "lb":
      return { type: "leaderboard" };
    case "help":
      return { type: "help" };
    default:
      return null;
  }
}

function parseNew(rest: string): Command {
  const parts = rest.split("|").map((p) => p.trim());
  const question = parts[0];
  if (!question) return invalid("new", USAGE.new, "Give the market a question.");
  let closes: string | undefined;
  let b: number | undefined;
  let options: string[] | undefined;
  for (const part of parts.slice(1)) {
    const closesMatch = part.match(/^closes?\s+(.+)$/i);
    const bMatch = part.match(/^b\s*[=:]?\s*(\d+(?:\.\d+)?)$/i);
    const optMatch = part.match(/^(?:options?|opts?|choices?)\s*[:=]?\s*(.+)$/i);
    if (closesMatch) closes = closesMatch[1].trim();
    else if (bMatch) b = Number(bMatch[1]);
    else if (optMatch) {
      options = optMatch[1].split(",").map((o) => o.trim().replace(/\s+/g, " "));
      const problem = validateOptions(options);
      if (problem) return invalid("new", USAGE.new, problem);
    } else if (part) return invalid("new", USAGE.new, `Don't understand "${part}".`);
  }
  if (b !== undefined && (b < 10 || b > 10_000)) {
    return invalid("new", USAGE.new, "Liquidity b must be between 10 and 10000.");
  }
  return { type: "new", question, closes, b, options };
}

/**
 * /bet and /sell: `[#id] <option> <amount>` or `<option> <amount> #id`.
 * The option is everything between the optional id and the amount, so names may contain spaces.
 * A bare leading number is a market id only when something else follows besides the amount
 * ("/bet 2 yes 50"); with just two words ("/bet 2 50") it is option number 2.
 */
function parseTrade(kind: "bet" | "sell", args: string[]): Command {
  const usage = USAGE[kind];
  let marketNum: number | undefined;
  let rest = [...args];
  const trailing = rest.length >= 3 ? rest[rest.length - 1].match(/^#(\d{1,9})$/) : null;
  if (trailing) {
    marketNum = Number(trailing[1]);
    rest.pop();
  } else if (rest.length >= 3 && parseId(rest[0]) !== null) {
    marketNum = parseId(rest[0])!;
    rest.shift();
  }
  if (rest.length < 2) return invalid(kind, usage);
  const amount = rest[rest.length - 1];
  const option = rest.slice(0, -1).join(" ");
  if (option.length > MAX_LABEL * 2 || rest.length > MAX_OPTIONS + 6) return invalid(kind, usage);

  if (kind === "bet") {
    if (!/^\d+$/.test(amount)) return invalid(kind, usage, "Points must be a positive whole number.");
    const points = Number(amount);
    if (points < 1 || points > MAX_POINTS) return invalid(kind, usage, "Points must be a positive whole number.");
    return { type: "bet", option, points, marketNum };
  }
  if (amount === "all") return { type: "sell", option, shares: "all", marketNum };
  if (!/^\d+(\.\d+)?$/.test(amount)) return invalid(kind, usage, "Shares must be a positive number (or 'all').");
  const shares = Number(amount);
  if (!(shares > 0) || shares > MAX_POINTS) return invalid(kind, usage, "Shares must be a positive number (or 'all').");
  return { type: "sell", option, shares, marketNum };
}
