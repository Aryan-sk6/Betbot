import type { Db } from "../db/db.js";
import { parseCommand, type Command } from "./commands.js";
import * as ledger from "./ledger.js";
import {
  applyShares,
  priceYes,
  proceedsForShares,
  sharesForPoints,
  type MarketState,
  type Side,
} from "./market.js";
import { DEFAULT_TZ, formatWhen, isValidTz, parseWhen } from "./time.js";

export interface IncomingMessage {
  groupId: string;
  userId: string; // opaque platform id (JID / lid)
  displayName: string;
  text: string;
  mentions?: string[]; // opaque platform ids mentioned in the message
}

export interface EngineOptions {
  db: Db;
  now?: () => number;
  tz?: string;
  defaultB?: number;
  startingBalance?: number;
}

export type Actor = Omit<IncomingMessage, "text">;

export interface ChatContext {
  /** Markets that can still be acted on: open, or closed and awaiting resolution. */
  markets: { num: number; question: string; status: "open" | "closed" }[];
  /** The caller's balance (the starting balance if they have not played yet). */
  balance: number;
}

export interface Engine {
  /** Parse and run a "/" command. Returns null for anything that isn't one. */
  handleCommand(msg: IncomingMessage): Promise<string | null>;
  /**
   * Run an already-parsed command as `actor`. Permissions, balances and payouts are decided
   * here, whatever produced the command (e.g. the optional natural-language layer).
   */
  execute(actor: Actor, cmd: Command): Promise<string>;
  /** Read-only snapshot used to build prompts and confirmation rules. */
  getContext(groupId: string, userId: string): ChatContext;
}

class UserError extends Error {}

interface UserRow {
  id: number;
  display_name: string;
}

interface MarketRow {
  id: number;
  group_id: string;
  num: number;
  question: string;
  creator_id: number;
  status: "open" | "closed" | "resolved" | "void";
  resolution: Side | null;
  b: number;
  q_yes: number;
  q_no: number;
  closes_at: number | null;
  created_at: number;
}

const state = (m: MarketRow): MarketState => ({ qYes: m.q_yes, qNo: m.q_no, b: m.b });
const pct = (p: number) => `${Math.round(p * 100)}%`;
const fmtShares = (n: number) => String(Math.round(n * 10) / 10);
const upper = (s: Side) => s.toUpperCase();

const HELP = [
  "Betbot: play-money predictions (no real money, ever)",
  "/new <question> | closes <time>  create a market",
  "/bet [#id] yes|no <points>  buy shares",
  "/sell [#id] yes|no <shares|all>  sell shares back",
  "/odds [#id]  odds and volume",
  "/markets  open markets",
  "/market <#id>  details and top holders",
  "/resolve <#id> yes|no  creator only",
  "/void <#id>  refund everyone, creator only",
  "/balance  your points",
  "/leaderboard  group ranking",
].join("\n");

export function createEngine(opts: EngineOptions): Engine {
  const { db } = opts;
  const now = opts.now ?? Date.now;
  const tz = opts.tz && isValidTz(opts.tz) ? opts.tz : DEFAULT_TZ;
  const defaultB = opts.defaultB ?? 100;
  const startingBalance = opts.startingBalance ?? 1000;

  // ---- helpers ----------------------------------------------------------

  function ensureUser(groupId: string, platformId: string, displayName: string): UserRow {
    const name = displayName.trim() || `user-${platformId.replace(/\D/g, "").slice(-4) || "anon"}`;
    return db.transaction(() => {
      let user = db
        .prepare(`SELECT id, display_name FROM users WHERE group_id = ? AND platform_id = ?`)
        .get(groupId, platformId) as UserRow | undefined;
      if (!user) {
        const info = db
          .prepare(`INSERT INTO users (platform_id, group_id, display_name) VALUES (?, ?, ?)`)
          .run(platformId, groupId, name);
        user = { id: Number(info.lastInsertRowid), display_name: name };
        ledger.post(db, { userId: user.id, groupId, delta: startingBalance, reason: "signup", ts: now() });
      } else if (user.display_name !== name && displayName.trim()) {
        db.prepare(`UPDATE users SET display_name = ? WHERE id = ?`).run(name, user.id);
        user.display_name = name;
      }
      return user;
    }).immediate();
  }

  /** Lazy auto-close: no cron, just check on every command. */
  function closeExpired(groupId: string): void {
    db.prepare(
      `UPDATE markets SET status = 'closed'
       WHERE group_id = ? AND status = 'open' AND closes_at IS NOT NULL AND closes_at <= ?`,
    ).run(groupId, now());
  }

  function getMarket(groupId: string, num: number): MarketRow {
    const m = db.prepare(`SELECT * FROM markets WHERE group_id = ? AND num = ?`).get(groupId, num) as
      | MarketRow
      | undefined;
    if (!m) throw new UserError(`No market #${num} in this group.`);
    return m;
  }

  /** Market for /bet and /sell: explicit id, or the only open market. */
  function pickMarket(groupId: string, num: number | undefined, verb: string): MarketRow {
    if (num !== undefined) return getMarket(groupId, num);
    const open = db
      .prepare(`SELECT * FROM markets WHERE group_id = ? AND status = 'open' ORDER BY num`)
      .all(groupId) as MarketRow[];
    if (open.length === 0) throw new UserError("No open markets. Start one with /new <question> | closes <time>");
    if (open.length > 1) {
      const list = open.map((m) => `#${m.num} ${m.question}`).join("\n");
      throw new UserError(`Several open markets, say which one: /${verb} <#id> ...\n${list}`);
    }
    return open[0];
  }

  function requireOpen(m: MarketRow): void {
    if (m.status === "open" && (m.closes_at === null || m.closes_at > now())) return;
    const why = m.status === "open" ? "closed" : m.status;
    throw new UserError(`Market #${m.num} is ${why}, no more trading.`);
  }

  function volume(marketId: number): number {
    const row = db
      .prepare(`SELECT COALESCE(SUM(ABS(delta)), 0) AS v FROM ledger WHERE market_id = ? AND user_id IS NOT NULL AND reason IN ('bet','sell')`)
      .get(marketId) as { v: number };
    return row.v;
  }

  function nameOf(userId: number): string {
    return (db.prepare(`SELECT display_name FROM users WHERE id = ?`).get(userId) as { display_name: string }).display_name;
  }

  const closesText = (m: MarketRow) => (m.closes_at ? `closes ${formatWhen(m.closes_at, tz)}` : "no deadline");

  function oddsLine(m: MarketRow): string {
    const p = priceYes(state(m));
    return `#${m.num} ${m.question}\n   ${pct(p)} YES / ${pct(1 - p)} NO · vol ${volume(m.id)} · ${closesText(m)}`;
  }

  // ---- command handlers (each runs synchronously inside one transaction) -----

  function cmdNew(g: string, user: UserRow, c: Extract<Command, { type: "new" }>): string {
    let closesAt: number | null = null;
    if (c.closes) {
      closesAt = parseWhen(c.closes, now(), tz);
      if (closesAt === null) {
        throw new UserError(`Couldn't read the close time "${c.closes}" (or it's in the past). Try "fri 6pm", "in 2h", "tomorrow 9am".`);
      }
    }
    const b = c.b ?? defaultB;
    const next = db.prepare(`SELECT COALESCE(MAX(num), 0) + 1 AS n FROM markets WHERE group_id = ?`).get(g) as { n: number };
    db.prepare(
      `INSERT INTO markets (group_id, num, question, creator_id, b, closes_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(g, next.n, c.question, user.id, b, closesAt, now());
    const when = closesAt ? `Closes ${formatWhen(closesAt, tz)}.` : "No deadline.";
    return `Market #${next.n} created by ${user.display_name}: ${c.question}\nOdds 50% YES. ${when}\nBet with /bet yes 50 or /bet no 50`;
  }

  function cmdBet(g: string, user: UserRow, c: Extract<Command, { type: "bet" }>): string {
    const m = pickMarket(g, c.marketNum, "bet");
    requireOpen(m);
    const bal = ledger.balance(db, g, user.id);
    if (c.points > bal) throw new UserError(`${user.display_name}, you only have ${bal} points.`);
    const s = state(m);
    const shares = sharesForPoints(s, c.side, c.points);
    if (!(shares > 0) || !Number.isFinite(shares)) throw new UserError("That bet is too small to buy any shares.");
    const next = applyShares(s, c.side, shares);
    db.prepare(`UPDATE markets SET q_yes = ?, q_no = ? WHERE id = ?`).run(next.qYes, next.qNo, m.id);
    const col = c.side === "yes" ? "yes_shares" : "no_shares";
    db.prepare(
      `INSERT INTO positions (market_id, user_id, ${col}) VALUES (?, ?, ?)
       ON CONFLICT (market_id, user_id) DO UPDATE SET ${col} = ${col} + excluded.${col}`,
    ).run(m.id, user.id, shares);
    ledger.postWithAmm(db, { userId: user.id, groupId: g, userDelta: -c.points, reason: "bet", marketId: m.id, ts: now() });
    return `${user.display_name} bets ${upper(c.side)} ${c.points} on #${m.num} -> ${fmtShares(shares)} shares @ avg ${(c.points / shares).toFixed(2)}. Odds now ${pct(priceYes(next))} YES. Balance: ${bal - c.points}.`;
  }

  function cmdSell(g: string, user: UserRow, c: Extract<Command, { type: "sell" }>): string {
    const m = pickMarket(g, c.marketNum, "sell");
    requireOpen(m);
    const pos = db.prepare(`SELECT yes_shares, no_shares FROM positions WHERE market_id = ? AND user_id = ?`).get(m.id, user.id) as
      | { yes_shares: number; no_shares: number }
      | undefined;
    const held = pos ? (c.side === "yes" ? pos.yes_shares : pos.no_shares) : 0;
    if (held <= 1e-9) throw new UserError(`${user.display_name}, you hold no ${upper(c.side)} shares in #${m.num}.`);
    let shares = c.shares === "all" ? held : c.shares;
    // Displayed share counts are rounded, so accept a request slightly above what's held.
    if (shares > held && shares <= held + 0.05) shares = held;
    if (shares > held) throw new UserError(`${user.display_name}, you only hold ${fmtShares(held)} ${upper(c.side)} shares in #${m.num}.`);
    const s = state(m);
    const proceeds = Math.floor(proceedsForShares(s, c.side, shares) + 1e-9);
    if (proceeds < 1) throw new UserError("Those shares are worth less than 1 point right now.");
    const next = applyShares(s, c.side, -shares);
    db.prepare(`UPDATE markets SET q_yes = ?, q_no = ? WHERE id = ?`).run(next.qYes, next.qNo, m.id);
    const col = c.side === "yes" ? "yes_shares" : "no_shares";
    db.prepare(`UPDATE positions SET ${col} = MAX(0, ${col} - ?) WHERE market_id = ? AND user_id = ?`).run(shares, m.id, user.id);
    ledger.postWithAmm(db, { userId: user.id, groupId: g, userDelta: proceeds, reason: "sell", marketId: m.id, ts: now() });
    const bal = ledger.balance(db, g, user.id);
    return `${user.display_name} sells ${fmtShares(shares)} ${upper(c.side)} on #${m.num} -> +${proceeds} points. Odds now ${pct(priceYes(next))} YES. Balance: ${bal}.`;
  }

  function cmdOdds(g: string, c: Extract<Command, { type: "odds" }>): string {
    if (c.marketNum !== undefined) return oddsLine(getMarket(g, c.marketNum));
    const open = db.prepare(`SELECT * FROM markets WHERE group_id = ? AND status = 'open' ORDER BY num`).all(g) as MarketRow[];
    return open.length ? open.map(oddsLine).join("\n") : "No open markets.";
  }

  function cmdMarkets(g: string): string {
    const rows = db
      .prepare(`SELECT * FROM markets WHERE group_id = ? AND status IN ('open','closed') ORDER BY status DESC, num`)
      .all(g) as MarketRow[];
    if (!rows.length) return "No open markets. Start one with /new <question> | closes <time>";
    const lines = rows.map((m) => {
      const tag = m.status === "closed" ? " [closed, awaiting resolution]" : "";
      return `#${m.num} ${m.question} — ${pct(priceYes(state(m)))} YES${tag}`;
    });
    return lines.join("\n");
  }

  function cmdMarket(g: string, c: Extract<Command, { type: "market" }>): string {
    const m = getMarket(g, c.marketNum);
    const status =
      m.status === "resolved" ? `resolved ${upper(m.resolution!)}` : m.status === "void" ? "void (refunded)" : m.status;
    const holders = (col: "yes_shares" | "no_shares") =>
      (
        db
          .prepare(
            `SELECT u.display_name AS name, p.${col} AS s FROM positions p JOIN users u ON u.id = p.user_id
             WHERE p.market_id = ? AND p.${col} > 0.05 ORDER BY p.${col} DESC LIMIT 3`,
          )
          .all(m.id) as { name: string; s: number }[]
      )
        .map((h) => `${h.name} ${fmtShares(h.s)}`)
        .join(", ") || "none";
    return [
      `#${m.num} ${m.question}`,
      `Status: ${status} · by ${nameOf(m.creator_id)} · ${closesText(m)}`,
      `Odds: ${pct(priceYes(state(m)))} YES / ${pct(1 - priceYes(state(m)))} NO · volume ${volume(m.id)}`,
      `Top YES: ${holders("yes_shares")}`,
      `Top NO: ${holders("no_shares")}`,
    ].join("\n");
  }

  /** Only the person who created a market with /new may settle or cancel it. */
  function requireCreator(m: MarketRow, user: UserRow): void {
    if (m.creator_id !== user.id) throw new UserError(`Only the market creator (${nameOf(m.creator_id)}) can do that.`);
  }

  function cmdResolve(g: string, user: UserRow, c: Extract<Command, { type: "resolve" }>): string {
    const m = getMarket(g, c.marketNum);
    requireCreator(m, user);
    if (m.status === "resolved" || m.status === "void") throw new UserError(`Market #${m.num} is already ${m.status}.`);
    const col = c.outcome === "yes" ? "yes_shares" : "no_shares";
    const winners = db
      .prepare(`SELECT p.user_id AS userId, p.${col} AS shares FROM positions p WHERE p.market_id = ? AND p.${col} > 0`)
      .all(m.id) as { userId: number; shares: number }[];
    let paid = 0;
    const lines: string[] = [];
    for (const w of winners) {
      const payout = Math.floor(w.shares + 1e-9); // 1 point per winning share, whole points
      if (payout < 1) continue;
      ledger.postWithAmm(db, { userId: w.userId, groupId: g, userDelta: payout, reason: "payout", marketId: m.id, ts: now() });
      paid += payout;
      lines.push(`${nameOf(w.userId)} +${payout}`);
    }
    db.prepare(`UPDATE markets SET status = 'resolved', resolution = ? WHERE id = ?`).run(c.outcome, m.id);
    const tail = lines.length ? `\nPayouts (${paid} pts): ${lines.join(", ")}` : "\nNo winning shares.";
    return `Market #${m.num} resolved ${upper(c.outcome)}: ${m.question}${tail}`;
  }

  function cmdVoid(g: string, user: UserRow, c: Extract<Command, { type: "void" }>): string {
    const m = getMarket(g, c.marketNum);
    requireCreator(m, user);
    if (m.status === "resolved" || m.status === "void") throw new UserError(`Market #${m.num} is already ${m.status}.`);
    const users = db
      .prepare(`SELECT DISTINCT user_id AS userId FROM ledger WHERE market_id = ? AND user_id IS NOT NULL AND reason IN ('bet','sell')`)
      .all(m.id) as { userId: number }[];
    let refunded = 0;
    for (const u of users) {
      // Net spend, never negative: someone who already cashed out ahead keeps their gains.
      const refund = Math.max(0, ledger.netSpend(db, m.id, u.userId));
      if (refund < 1) continue;
      ledger.postWithAmm(db, { userId: u.userId, groupId: g, userDelta: refund, reason: "refund", marketId: m.id, ts: now() });
      refunded += refund;
    }
    db.prepare(`UPDATE markets SET status = 'void' WHERE id = ?`).run(m.id);
    return `Market #${m.num} voided: ${m.question}\nRefunded ${refunded} points to ${users.length} player(s).`;
  }

  function cmdBalance(g: string, user: UserRow, mentions: string[] | undefined): string {
    const target = mentions?.[0];
    if (target) {
      const row = db.prepare(`SELECT id, display_name FROM users WHERE group_id = ? AND platform_id = ?`).get(g, target) as UserRow | undefined;
      if (row) return `${row.display_name}: ${ledger.balance(db, g, row.id)} points.`;
    }
    return `${user.display_name}: ${ledger.balance(db, g, user.id)} points.`;
  }

  function cmdLeaderboard(g: string): string {
    const rows = ledger.leaderboard(db, g, 10);
    const medals = ["🥇", "🥈", "🥉"];
    return "Leaderboard\n" + rows.map((r, i) => `${medals[i] ?? `${i + 1}.`} ${r.displayName} — ${r.balance}`).join("\n");
  }

  // ---- entry point ---------------------------------------------------------

  async function handleCommand(msg: IncomingMessage): Promise<string | null> {
    const cmd = parseCommand(msg.text);
    if (!cmd) return null;
    return execute(msg, cmd);
  }

  function getContext(groupId: string, userId: string): ChatContext {
    closeExpired(groupId);
    const markets = db
      .prepare(`SELECT num, question, status FROM markets WHERE group_id = ? AND status IN ('open','closed') ORDER BY num`)
      .all(groupId) as ChatContext["markets"];
    const user = db.prepare(`SELECT id FROM users WHERE group_id = ? AND platform_id = ?`).get(groupId, userId) as
      | { id: number }
      | undefined;
    return { markets, balance: user ? ledger.balance(db, groupId, user.id) : startingBalance };
  }

  async function execute(msg: Actor, cmd: Command): Promise<string> {
    const g = msg.groupId;
    try {
      const user = ensureUser(g, msg.userId, msg.displayName);
      if (cmd.type === "invalid") {
        return `${cmd.reason ? cmd.reason + "\n" : ""}Usage: ${cmd.usage}`;
      }
      if (cmd.type === "help") return HELP;

      return db.transaction((): string => {
        closeExpired(g);
        switch (cmd.type) {
          case "new": return cmdNew(g, user, cmd);
          case "bet": return cmdBet(g, user, cmd);
          case "sell": return cmdSell(g, user, cmd);
          case "odds": return cmdOdds(g, cmd);
          case "markets": return cmdMarkets(g);
          case "market": return cmdMarket(g, cmd);
          case "resolve": return cmdResolve(g, user, cmd);
          case "void": return cmdVoid(g, user, cmd);
          case "balance": return cmdBalance(g, user, msg.mentions);
          case "leaderboard": return cmdLeaderboard(g);
        }
      }).immediate();
    } catch (err) {
      if (err instanceof UserError) return err.message;
      throw err;
    }
  }

  return { handleCommand, execute, getContext };
}
