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
      (db.prepare(`SELECT shares y FROM holdings WHERE user_id = ? AND outcome_idx = 0`).get(uid(u)) as { y: number }).y;
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

describe("custom options", () => {
  beforeEach(async () => {
    await say("rahul", "/new Who wins the match? | options India, Australia, Real Madrid | closes in 2h");
  });

  it("announces the options and starts them even", async () => {
    await say("x", "/balance");
    const r = (await say("rahul", "/new Pick one | options A, B, C, D"))!;
    expect(r).toContain("Options: 1. A  2. B  3. C  4. D (25% each)");
    expect(await say("rahul", "/odds #2")).toContain("A 25% / B 25% / C 25% / D 25%");
  });

  it("bets by name, by prefix, by number, and by multi-word name", async () => {
    expect(await say("khush", "/bet india 100")).toMatch(/^khush bets India 100 on #1 -> [\d.]+ shares @ avg 0\.\d\d\. Odds now India \d+% \/ Australia \d+% \/ Real Madrid \d+%\. Balance: 900\.$/);
    expect(await say("khush", "/bet aus 50")).toContain("bets Australia 50");
    expect(await say("khush", "/bet 3 50")).toContain("bets Real Madrid 50");
    expect(await say("khush", "/bet Real Madrid 25")).toContain("bets Real Madrid 25");
    expect(await say("khush", "/bet #1 real madrid 25")).toContain("bets Real Madrid 25");
    expect(bal("khush")).toBe(1000 - 100 - 50 - 50 - 25 - 25);
    invariant();
  });

  it("betting on one option moves the others down together", async () => {
    await say("khush", "/bet india 300");
    const odds = (await say("khush", "/odds"))!;
    const [, india, aus, rm] = odds.match(/India (\d+)% \/ Australia (\d+)% \/ Real Madrid (\d+)%/)!.map(Number);
    expect(india).toBeGreaterThan(33);
    expect(aus).toBe(rm);
    expect(india + aus + rm).toBeGreaterThanOrEqual(99);
  });

  it("explains unknown and ambiguous options", async () => {
    await say("rahul", "/new Colors | options Red, Reds, Blue");
    expect(await say("khush", "/bet #2 re 10")).toContain('"re" matches several options in #2: Red, Reds');
    expect(await say("khush", "/bet #2 green 10")).toBe('No option "green" in #2. Options: 1. Red  2. Reds  3. Blue');
    expect(await say("khush", "/bet #2 red 10")).toContain("bets Red 10"); // exact beats prefix
    expect(bal("khush")).toBe(990);
  });

  it("yes and no do not exist on a custom market", async () => {
    expect(await say("khush", "/bet yes 10")).toContain('No option "yes"');
  });

  it("rejects bad option lists", async () => {
    expect(await say("rahul", "/new Q | options Only")).toContain("at least 2");
    expect(await say("rahul", "/new Q | options A, B, a")).toContain("Duplicate");
    expect(await say("rahul", "/new Q | options A, 9")).toContain("number");
    expect(await say("rahul", "/new Q | options " + Array.from({ length: 11 }, (_, i) => `o${i}`).join(","))).toContain("At most 10");
  });

  it("sells a specific option back", async () => {
    await say("khush", "/bet australia 200");
    await say("khush", "/bet india 100");
    expect(await say("khush", "/sell india all")).toMatch(/sells [\d.]+ India on #1 -> \+\d+ points/);
    expect(await say("khush", "/sell india 1")).toContain("hold no India shares");
    expect(await say("khush", "/sell australia 99999")).toContain("only hold");
    invariant();
  });

  it("resolving pays only the winning option and conserves points", async () => {
    await say("khush", "/bet india 200");
    await say("meera", "/bet australia 150");
    await say("meera", "/bet real madrid 100");
    await say("khush", "/bet real madrid 40");
    const holding = (u: string, idx: number) =>
      (db.prepare(`SELECT shares s FROM holdings WHERE user_id = ? AND outcome_idx = ?`).get(uid(u), idx) as { s: number }).s;
    const khushWin = Math.floor(holding("khush", 0) + 1e-9);

    expect(await say("khush", "/resolve 1 india")).toContain("Only the market creator");
    const r = (await say("rahul", "/resolve 1 india"))!;
    expect(r).toContain("resolved India");
    expect(r).toContain(`khush +${khushWin}`);
    expect(r).not.toContain("meera");
    expect(bal("khush")).toBe(1000 - 200 - 40 + khushWin);
    expect(bal("meera")).toBe(1000 - 150 - 100);
    expect(await say("khush", "/market 1")).toContain("Status: resolved India");
    invariant();
  });

  it("can resolve by option number, and rejects an unknown winner", async () => {
    await say("khush", "/bet 2 100");
    expect(await say("rahul", "/resolve 1 spain")).toContain('No option "spain"');
    expect((db.prepare(`SELECT status FROM markets WHERE num = 1`).get() as { status: string }).status).toBe("open");
    expect(await say("rahul", "/resolve 1 2")).toContain("resolved Australia");
    invariant();
  });

  it("void refunds across all options", async () => {
    await say("khush", "/bet india 100");
    await say("meera", "/bet australia 70");
    await say("khush", "/bet real madrid 30");
    await say("rahul", "/void 1");
    expect(bal("khush")).toBe(1000);
    expect(bal("meera")).toBe(1000);
    invariant();
  });

  it("market details list top holders per option", async () => {
    await say("khush", "/bet india 100");
    const d = (await say("meera", "/market 1"))!;
    expect(d).toContain("Top India: khush");
    expect(d).toContain("Top Australia: none");
    expect(d).toContain("Top Real Madrid: none");
  });

  it("the market list shows the leading options", async () => {
    await say("rahul", "/new Five-way | options A, B, C, D, E");
    await say("khush", "/bet #2 d 200");
    const list = (await say("khush", "/markets"))!;
    expect(list).toContain("#2 Five-way — D ");
    expect(list).toContain("+2 more");
    expect(list).toContain("#3 Who wins".replace("#3", "#1"));
  });

  it("yes/no markets are unchanged beside custom ones", async () => {
    await say("rahul", "/new Plain question");
    expect(await say("khush", "/bet #2 yes 50")).toMatch(/bets YES 50 on #2 .* Odds now \d+% YES\./);
    expect(await say("khush", "/odds #2")).toContain("% YES /");
  });
});
