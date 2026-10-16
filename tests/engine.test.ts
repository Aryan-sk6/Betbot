import { beforeEach, describe, expect, it } from "vitest";
import { createEngine, type Engine } from "../src/core/engine.js";
import * as ledger from "../src/core/ledger.js";
import { openDb, type Db } from "../src/db/db.js";

const G = "group1@g.us";
let db: Db;
let engine: Engine;
let clock: number;

const say = (user: string, text: string, group = G) =>
  engine.handleCommand({ groupId: group, userId: `${user}@lid`, displayName: user, text });

const uid = (user: string, group = G) =>
  (db.prepare(`SELECT id FROM users WHERE group_id = ? AND platform_id = ?`).get(group, `${user}@lid`) as { id: number }).id;
const bal = (user: string, group = G) => ledger.balance(db, group, uid(user, group));

function invariant(group = G) {
  expect(ledger.systemTotal(db, group)).toBe(ledger.totalSignups(db, group));
}

beforeEach(() => {
  db = openDb(":memory:");
  clock = Date.UTC(2026, 9, 14, 4, 30);
  engine = createEngine({ db, now: () => clock, tz: "Asia/Kolkata" });
});

describe("engine basics", () => {
  it("ignores non-commands without creating users", async () => {
    expect(await say("khush", "hello everyone")).toBeNull();
    expect(db.prepare(`SELECT COUNT(*) c FROM users`).get()).toEqual({ c: 0 });
  });

  it("grants 1000 on first interaction only, and refreshes display name", async () => {
    await say("khush", "/balance");
    await engine.handleCommand({ groupId: G, userId: "khush@lid", displayName: "Khush S", text: "/balance" });
    expect(bal("khush")).toBe(1000);
    const row = db.prepare(`SELECT display_name d FROM users WHERE platform_id = 'khush@lid'`).get() as { d: string };
    expect(row.d).toBe("Khush S");
  });

  it("scopes economy and market numbers per group", async () => {
    await say("a", "/new first | closes in 1h", "g1");
    await say("a", "/new other | closes in 1h", "g2");
    expect(await say("a", "/market 1", "g2")).toContain("other");
    await say("a", "/bet yes 100", "g1");
    expect(bal("a", "g1")).toBe(900);
    expect(bal("a", "g2")).toBe(1000);
  });

  it("returns usage for malformed commands", async () => {
    expect(await say("a", "/bet yes -5")).toContain("Usage: /bet");
  });
});

describe("betting", () => {
  beforeEach(async () => {
    await say("khush", "/new Will it rain? | closes in 2h");
  });

  it("replies in the documented format", async () => {
    const r = (await say("khush", "/bet yes 50"))!;
    expect(r).toMatch(/^khush bets YES 50 on #1 -> [\d.]+ shares @ avg 0\.\d\d\. Odds now \d+% YES\. Balance: 950\.$/);
  });

  it("rejects bets over balance and after close", async () => {
    expect(await say("khush", "/bet yes 5000")).toContain("only have 1000");
    clock += 3 * 3_600_000;
    expect(await say("khush", "/bet 1 yes 10")).toContain("closed");
    expect(bal("khush")).toBe(1000);
    expect(await say("khush", "/markets")).toContain("awaiting resolution");
  });

  it("requires an id when several markets are open", async () => {
    await say("khush", "/new Second");
    expect(await say("khush", "/bet yes 10")).toContain("say which one");
    expect(await say("khush", "/bet #2 yes 10")).toContain("on #2");
  });

  it("sell returns about what was paid, and 'all' empties the position", async () => {
    await say("khush", "/bet yes 100");
    const r = (await say("khush", "/sell yes all"))!;
    expect(r).toContain("+100 points"); // round trip returns what was paid
    expect(bal("khush")).toBe(1000);
    expect(await say("khush", "/sell yes 1")).toContain("no YES shares");
    invariant();
  });

  it("cannot sell more than held", async () => {
    await say("khush", "/bet yes 50");
    expect(await say("khush", "/sell yes 500")).toContain("only hold");
  });
});

describe("conservation", () => {
  it("holds across bet, sell, resolve and void", async () => {
    await say("a", "/new M1 | closes in 1h");
    await say("a", "/new M2 | closes in 1h");
    await say("b", "/bet #1 yes 300");
    await say("c", "/bet #1 no 200");
    await say("a", "/bet #1 yes 77");
    await say("c", "/sell #1 no 30");
    invariant();
    await say("a", "/bet #2 yes 150");
    await say("b", "/bet #2 no 90");
    await say("b", "/sell #2 no all");
    invariant();
    await say("a", "/resolve 1 yes");
    invariant();
    await say("a", "/void 2");
    invariant();
    const all = db.prepare(`SELECT SUM(delta) s FROM ledger WHERE user_id IS NOT NULL`).get() as { s: number };
    const amm = db.prepare(`SELECT SUM(delta) s FROM ledger WHERE user_id IS NULL`).get() as { s: number };
    expect(all.s + amm.s).toBe(3000);
  });

  it("balance equals the sum of ledger deltas", async () => {
    await say("a", "/new Q");
    await say("a", "/bet yes 123");
    const sum = db.prepare(`SELECT SUM(delta) s FROM ledger WHERE user_id = ?`).get(uid("a")) as { s: number };
    expect(bal("a")).toBe(sum.s);
    expect(bal("a")).toBe(877);
  });

  it("ledger is append-only", async () => {
    await say("a", "/balance");
    expect(() => db.prepare(`UPDATE ledger SET delta = 5`).run()).toThrow(/append-only/);
    expect(() => db.prepare(`DELETE FROM ledger`).run()).toThrow(/append-only/);
  });
});

describe("resolve and void", () => {
  beforeEach(async () => {
    await say("rahul", "/new Test | closes in 1h");
    await say("khush", "/bet yes 100");
    await say("meera", "/bet no 100");
  });

  it("only the creator may resolve or void, nobody else", async () => {
    expect(await say("khush", "/resolve 1 yes")).toBe("Only the market creator (rahul) can do that.");
    expect(await say("meera", "/void 1")).toContain("Only the market creator");
    expect(await say("khush", "/resolve 1 yes")).not.toContain("resolved"); // still refused
    expect((db.prepare(`SELECT status FROM markets WHERE num = 1`).get() as { status: string }).status).toBe("open");
    expect(bal("khush")).toBe(900);
    expect(await say("rahul", "/resolve 1 yes")).toContain("resolved YES");
  });

  it("cannot resolve twice; resolved markets stop trading", async () => {
    await say("rahul", "/resolve 1 no");
    expect(await say("rahul", "/resolve 1 yes")).toContain("already resolved");
    expect(await say("khush", "/bet 1 yes 10")).toContain("resolved");
  });

  it("can resolve after auto-close", async () => {
    clock += 2 * 3_600_000;
    expect(await say("rahul", "/resolve 1 yes")).toContain("resolved YES");
  });

  it("void refunds net spend", async () => {
    await say("khush", "/bet yes 50");
    await say("rahul", "/void 1");
    expect(bal("khush")).toBe(1000);
    expect(bal("meera")).toBe(1000);
    invariant();
  });

  it("void does not claw back profit from a cashed-out seller", async () => {
    await say("meera", "/bet yes 200");
    await say("khush", "/bet yes 300"); // pushes YES up
    await say("meera", "/sell yes all");
    await say("rahul", "/void 1");
    expect(bal("meera")).toBeGreaterThanOrEqual(1000 - 100 + 100 - 1);
    invariant();
  });
});

describe("full scenario", () => {
  it("3 users, both sides, resolve, balances and leaderboard", async () => {
    await say("rahul", "/new Will India win? | closes fri 6pm");
    await say("khush", "/bet yes 200");
    await say("meera", "/bet no 100");
    await say("rahul", "/bet yes 100");

    // Exact payouts: each winning share pays 1 point (floored).
    const sharesOf = (u: string) =>
      (db.prepare(`SELECT yes_shares y FROM positions WHERE user_id = ?`).get(uid(u)) as { y: number }).y;
    const khushPayout = Math.floor(sharesOf("khush") + 1e-9);
    const rahulPayout = Math.floor(sharesOf("rahul") + 1e-9);

    const r = (await say("rahul", "/resolve 1 yes"))!;
    expect(r).toContain("resolved YES");

    expect(bal("khush")).toBe(800 + khushPayout);
    expect(bal("rahul")).toBe(900 + rahulPayout);
    expect(bal("meera")).toBe(900);
    expect(khushPayout).toBeGreaterThan(200); // bought below 1.0 average
    invariant();

    const lb = (await say("meera", "/leaderboard"))!;
    const order = lb.split("\n").slice(1).map((l) => l.replace(/^\S+ /, "").split(" — ")[0]);
    const ranked = [["khush", bal("khush")], ["rahul", bal("rahul")], ["meera", bal("meera")]].sort((a, b) => (b[1] as number) - (a[1] as number));
    expect(order).toEqual(ranked.map((r) => r[0]));
    expect(order[2]).toBe("meera");
    expect(await say("meera", "/balance")).toBe("meera: 900 points.");
  });

  it("market details show holders", async () => {
    await say("rahul", "/new Q");
    await say("khush", "/bet yes 100");
    const d = (await say("meera", "/market 1"))!;
    expect(d).toContain("Top YES: khush");
    expect(d).toContain("Top NO: none");
    expect(await say("meera", "/odds")).toContain("YES");
  });
});
