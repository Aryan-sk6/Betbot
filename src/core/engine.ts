import type { Db } from "../db/db.js";
import { parseCommand, type Command } from "./commands.js";
import * as ledger from "./ledger.js";
import { applyShares, prices, proceedsForShares, sharesForPoints, type MarketState } from "./market.js";
import { display, isYesNo, matchOption, validateOptions } from "./options.js";
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
  markets: { num: number; question: string; status: "open" | "closed"; options: string[] }[];
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
  resolution_idx: number | null;
  b: number;
  closes_at: number | null;
  created_at: number;
}

interface Outcome {
  idx: number;
  label: string;
  q: number;
}

type Market = MarketRow & { outcomes: Outcome[] };

const state = (m: Market): MarketState => ({ q: m.outcomes.map((o) => o.q), b: m.b });
const labels = (m: Market): string[] => m.outcomes.map((o) => o.label);
const pct = (p: number) => `${Math.round(p * 100)}%`;
const fmtShares = (n: number) => String(Math.round(n * 10) / 10);

/** "64% YES / 36% NO" for yes/no markets, "India 55% / Australia 30% / Draw 15%" otherwise. */
function oddsText(m: Market, s: MarketState = state(m)): string {
  const p = prices(s);
  if (isYesNo(labels(m))) return `${pct(p[0])} YES / ${pct(p[1])} NO`;
  return m.outcomes.map((o, i) => `${display(o.label)} ${pct(p[i])}`).join(" / ");
}

/** Compact odds for replies: yes/no markets show just the YES price. */
function shortOdds(m: Market, s: MarketState): string {
  return isYesNo(labels(m)) ? `${pct(prices(s)[0])} YES` : oddsText(m, s);
}

const HELP = [
  "Betbot: play-money predictions (no real money, ever)",
  "/new <question> | closes <time>  create a yes/no market",
  "/new <question> | options A, B, C | closes <time>  create a market with your own options",
  "/bet [#id] <option> <points>  buy shares (option = yes/no, a name, or its number)",
  "/sell [#id] <option> <shares|all>  sell shares back",
  "/odds [#id]  odds and volume",
  "/markets  open markets",
  "/market <#id>  details and top holders",
  "/resolve <#id> <option>  creator only",
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

  function withOutcomes(row: MarketRow): Market {
    const outcomes = db.prepare(`SELECT idx, label, q FROM outcomes WHERE market_id = ? ORDER BY idx`).all(row.id) as Outcome[];
    return { ...row, outcomes };
  }

  function getMarket(groupId: string, num: number): Market {
    const m = db.prepare(`SELECT * FROM markets WHERE group_id = ? AND num = ?`).get(groupId, num) as MarketRow | undefined;
    if (!m) throw new UserError(`No market #${num} in this group.`);
    return withOutcomes(m);
  }

  /** Resolve what the user typed to one of the market's options. */
  function pickOutcome(m: Market, text: string): Outcome {
    const r = matchOption(labels(m), text);
    if ("index" in r) return m.outcomes[r.index];
    const list = m.outcomes.map((o, i) => `${i + 1}. ${display(o.label)}`).join("  ");
    if (r.error === "ambiguous") {
      throw new UserError(`"${text}" matches several options in #${m.num}: ${r.candidates.map(display).join(", ")}. Be more specific.`);
    }
    throw new UserError(`No option "${text}" in #${m.num}. Options: ${list}`);
  }

  /** Market for /bet and /sell: explicit id, or the only open market. */
  function pickMarket(groupId: string, num: number | undefined, verb: string): Market {
    if (num !== undefined) return getMarket(groupId, num);
    const open = db
      .prepare(`SELECT * FROM markets WHERE group_id = ? AND status = 'open' ORDER BY num`)
      .all(groupId) as MarketRow[];
    if (open.length === 0) throw new UserError("No open markets. Start one with /new <question> | closes <time>");
    if (open.length > 1) {
      const list = open.map((m) => `#${m.num} ${m.question}`).join("\n");
      throw new UserError(`Several open markets, say which one: /${verb} <#id> ...\n${list}`);
    }
    return withOutcomes(open[0]);
  }

  function requireOpen(m: Market): void {
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

  const closesText = (m: Market) => (m.closes_at ? `closes ${formatWhen(m.closes_at, tz)}` : "no deadline");

  function oddsLine(m: Market): string {
    return `#${m.num} ${m.question}\n   ${oddsText(m)} · vol ${volume(m.id)} · ${closesText(m)}`;
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
    const opts = (c.options ?? ["Yes", "No"]).map((o) => o.trim().replace(/\s+/g, " "));
    const problem = validateOptions(opts);
    if (problem) throw new UserError(problem);
    const b = c.b ?? defaultB;
    const next = db.prepare(`SELECT COALESCE(MAX(num), 0) + 1 AS n FROM markets WHERE group_id = ?`).get(g) as { n: number };
    const info = db
      .prepare(`INSERT INTO markets (group_id, num, question, creator_id, b, closes_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(g, next.n, c.question, user.id, b, closesAt, now());
    const insert = db.prepare(`INSERT INTO outcomes (market_id, idx, label, q) VALUES (?, ?, ?, 0)`);
    opts.forEach((label, i) => insert.run(info.lastInsertRowid, i, label));
    const when = closesAt ? `Closes ${formatWhen(closesAt, tz)}.` : "No deadline.";
    const head = `Market #${next.n} created by ${user.display_name}: ${c.question}`;
    if (!c.options) return `${head}\nOdds 50% YES. ${when}\nBet with /bet yes 50 or /bet no 50`;
    const list = opts.map((o, i) => `${i + 1}. ${o}`).join("  ");
    return `${head}\nOptions: ${list} (${pct(1 / opts.length)} each). ${when}\nBet with /bet ${opts[0]} 50 (or /bet 1 50), and use #${next.n} if several markets are open.`;
  }

  function cmdBet(g: string, user: UserRow, c: Extract<Command, { type: "bet" }>): string {
    const m = pickMarket(g, c.marketNum, "bet");
    requireOpen(m);
    const o = pickOutcome(m, c.option);
    const bal = ledger.balance(db, g, user.id);
    if (c.points > bal) throw new UserError(`${user.display_name}, you only have ${bal} points.`);
    const s = state(m);
    const shares = sharesForPoints(s, o.idx, c.points);
    if (!(shares > 0) || !Number.isFinite(shares)) throw new UserError("That bet is too small to buy any shares.");
    const next = applyShares(s, o.idx, shares);
    db.prepare(`UPDATE outcomes SET q = ? WHERE market_id = ? AND idx = ?`).run(next.q[o.idx], m.id, o.idx);
    db.prepare(
      `INSERT INTO holdings (market_id, user_id, outcome_idx, shares) VALUES (?, ?, ?, ?)
       ON CONFLICT (market_id, user_id, outcome_idx) DO UPDATE SET shares = shares + excluded.shares`,
    ).run(m.id, user.id, o.idx, shares);
    ledger.postWithAmm(db, { userId: user.id, groupId: g, userDelta: -c.points, reason: "bet", marketId: m.id, ts: now() });
    return `${user.display_name} bets ${display(o.label)} ${c.points} on #${m.num} -> ${fmtShares(shares)} shares @ avg ${(c.points / shares).toFixed(2)}. Odds now ${shortOdds(m, next)}. Balance: ${bal - c.points}.`;
  }

  function cmdSell(g: string, user: UserRow, c: Extract<Command, { type: "sell" }>): string {
    const m = pickMarket(g, c.marketNum, "sell");
    requireOpen(m);
    const o = pickOutcome(m, c.option);
    const row = db
      .prepare(`SELECT shares FROM holdings WHERE market_id = ? AND user_id = ? AND outcome_idx = ?`)
      .get(m.id, user.id, o.idx) as { shares: number } | undefined;
    const held = row?.shares ?? 0;
    if (held <= 1e-9) throw new UserError(`${user.display_name}, you hold no ${display(o.label)} shares in #${m.num}.`);
    let shares = c.shares === "all" ? held : c.shares;
    // Displayed share counts are rounded, so accept a request slightly above what's held.
    if (shares > held && shares <= held + 0.05) shares = held;
    if (shares > held) throw new UserError(`${user.display_name}, you only hold ${fmtShares(held)} ${display(o.label)} shares in #${m.num}.`);
    const s = state(m);
    const proceeds = Math.floor(proceedsForShares(s, o.idx, shares) + 1e-9);
    if (proceeds < 1) throw new UserError("Those shares are worth less than 1 point right now.");
    const next = applyShares(s, o.idx, -shares);
    db.prepare(`UPDATE outcomes SET q = ? WHERE market_id = ? AND idx = ?`).run(next.q[o.idx], m.id, o.idx);
    db.prepare(`UPDATE holdings SET shares = MAX(0, shares - ?) WHERE market_id = ? AND user_id = ? AND outcome_idx = ?`).run(
      shares,
      m.id,
      user.id,
      o.idx,
    );
    ledger.postWithAmm(db, { userId: user.id, groupId: g, userDelta: proceeds, reason: "sell", marketId: m.id, ts: now() });
    const bal = ledger.balance(db, g, user.id);
    return `${user.display_name} sells ${fmtShares(shares)} ${display(o.label)} on #${m.num} -> +${proceeds} points. Odds now ${shortOdds(m, next)}. Balance: ${bal}.`;
  }

  function cmdOdds(g: string, c: Extract<Command, { type: "odds" }>): string {
    if (c.marketNum !== undefined) return oddsLine(getMarket(g, c.marketNum));
    const open = (db.prepare(`SELECT * FROM markets WHERE group_id = ? AND status = 'open' ORDER BY num`).all(g) as MarketRow[]).map(withOutcomes);
    return open.length ? open.map(oddsLine).join("\n") : "No open markets.";
  }

  function cmdMarkets(g: string): string {
    const rows = (
      db.prepare(`SELECT * FROM markets WHERE group_id = ? AND status IN ('open','closed') ORDER BY status DESC, num`).all(g) as MarketRow[]
    ).map(withOutcomes);
    if (!rows.length) return "No open markets. Start one with /new <question> | closes <time>";
    const lines = rows.map((m) => {
      const tag = m.status === "closed" ? " [closed, awaiting resolution]" : "";
      let odds: string;
      if (isYesNo(labels(m))) odds = `${pct(prices(state(m))[0])} YES`;
      else {
        const p = prices(state(m));
        const ranked = m.outcomes.map((o, i) => ({ o, p: p[i] })).sort((a, b) => b.p - a.p);
        odds = ranked.slice(0, 3).map((r) => `${display(r.o.label)} ${pct(r.p)}`).join(", ") + (ranked.length > 3 ? ` +${ranked.length - 3} more` : "");
      }
      return `#${m.num} ${m.question} — ${odds}${tag}`;
    });
    return lines.join("\n");
  }

  function cmdMarket(g: string, c: Extract<Command, { type: "market" }>): string {
    const m = getMarket(g, c.marketNum);
    const winner = m.resolution_idx === null ? undefined : m.outcomes[m.resolution_idx];
    const status = m.status === "resolved" && winner ? `resolved ${display(winner.label)}` : m.status === "void" ? "void (refunded)" : m.status;
    const holders = (idx: number) =>
      (
        db
          .prepare(
            `SELECT u.display_name AS name, h.shares AS s FROM holdings h JOIN users u ON u.id = h.user_id
             WHERE h.market_id = ? AND h.outcome_idx = ? AND h.shares > 0.05 ORDER BY h.shares DESC LIMIT 3`,
          )
          .all(m.id, idx) as { name: string; s: number }[]
      )
        .map((h) => `${h.name} ${fmtShares(h.s)}`)
        .join(", ") || "none";
    return [
      `#${m.num} ${m.question}`,
      `Status: ${status} · by ${nameOf(m.creator_id)} · ${closesText(m)}`,
      `Odds: ${oddsText(m)} · volume ${volume(m.id)}`,
      ...m.outcomes.map((o) => `Top ${display(o.label)}: ${holders(o.idx)}`),
    ].join("\n");
  }

  /** Only the person who created a market with /new may settle or cancel it. */
  function requireCreator(m: Market, user: UserRow): void {
    if (m.creator_id !== user.id) throw new UserError(`Only the market creator (${nameOf(m.creator_id)}) can do that.`);
  }

  function cmdResolve(g: string, user: UserRow, c: Extract<Command, { type: "resolve" }>): string {
    const m = getMarket(g, c.marketNum);
    requireCreator(m, user);
    if (m.status === "resolved" || m.status === "void") throw new UserError(`Market #${m.num} is already ${m.status}.`);
    const won = pickOutcome(m, c.option);
    const winners = db
      .prepare(`SELECT user_id AS userId, shares FROM holdings WHERE market_id = ? AND outcome_idx = ? AND shares > 0`)
      .all(m.id, won.idx) as { userId: number; shares: number }[];
    let paid = 0;
    const lines: string[] = [];
    for (const w of winners) {
      const payout = Math.floor(w.shares + 1e-9); // 1 point per winning share, whole points
      if (payout < 1) continue;
      ledger.postWithAmm(db, { userId: w.userId, groupId: g, userDelta: payout, reason: "payout", marketId: m.id, ts: now() });
      paid += payout;
      lines.push(`${nameOf(w.userId)} +${payout}`);
    }
    db.prepare(`UPDATE markets SET status = 'resolved', resolution_idx = ? WHERE id = ?`).run(won.idx, m.id);
    const tail = lines.length ? `\nPayouts (${paid} pts): ${lines.join(", ")}` : "\nNo winning shares.";
    return `Market #${m.num} resolved ${display(won.label)}: ${m.question}${tail}`;
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
      .prepare(`SELECT id, num, question, status FROM markets WHERE group_id = ? AND status IN ('open','closed') ORDER BY num`)
      .all(groupId) as { id: number; num: number; question: string; status: "open" | "closed" }[];
    const user = db.prepare(`SELECT id FROM users WHERE group_id = ? AND platform_id = ?`).get(groupId, userId) as
      | { id: number }
      | undefined;
    const optionsOf = db.prepare(`SELECT label FROM outcomes WHERE market_id = ? ORDER BY idx`);
    return {
      markets: markets.map((m) => ({
        num: m.num,
        question: m.question,
        status: m.status,
        options: (optionsOf.all(m.id) as { label: string }[]).map((o) => o.label),
      })),
      balance: user ? ledger.balance(db, groupId, user.id) : startingBalance,
    };
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
