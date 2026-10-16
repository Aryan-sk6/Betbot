import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openDb } from "../src/db/db.js";

it("migration 2 converts an existing version-1 database in place", () => {
  const dir = mkdtempSync(join(tmpdir(), "betbot-"));
  const path = join(dir, "old.db");
  try {
    const old = new Database(path);
    old.exec(readFileSync("src/db/schema.sql", "utf8"));
    old.pragma("user_version = 1");
    old.exec(`
      INSERT INTO users (id, platform_id, group_id, display_name) VALUES (1, 'a', 'g', 'A'), (2, 'b', 'g', 'B');
      INSERT INTO markets (id, group_id, num, question, creator_id, status, resolution, b, q_yes, q_no, created_at)
        VALUES (1, 'g', 1, 'Old resolved', 1, 'resolved', 'no', 100, 30, 10, 0),
               (2, 'g', 2, 'Old open', 1, 'open', NULL, 100, 5, 0, 0);
      INSERT INTO positions VALUES (1, 1, 30, 0), (1, 2, 0, 10), (2, 1, 5, 0);
      INSERT INTO ledger (user_id, group_id, delta, reason, ts) VALUES (1, 'g', 1000, 'signup', 0);
    `);
    old.close();

    const db = openDb(path);
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    expect(db.prepare(`SELECT market_id m, idx, label, q FROM outcomes ORDER BY m, idx`).all()).toEqual([
      { m: 1, idx: 0, label: "Yes", q: 30 },
      { m: 1, idx: 1, label: "No", q: 10 },
      { m: 2, idx: 0, label: "Yes", q: 5 },
      { m: 2, idx: 1, label: "No", q: 0 },
    ]);
    expect(db.prepare(`SELECT market_id m, user_id u, outcome_idx o, shares s FROM holdings ORDER BY m, u, o`).all()).toEqual([
      { m: 1, u: 1, o: 0, s: 30 },
      { m: 1, u: 2, o: 1, s: 10 },
      { m: 2, u: 1, o: 0, s: 5 },
    ]);
    expect(db.prepare(`SELECT id, resolution_idx r FROM markets ORDER BY id`).all()).toEqual([
      { id: 1, r: 1 },
      { id: 2, r: null },
    ]);
    expect(db.prepare(`SELECT SUM(delta) s FROM ledger`).get()).toEqual({ s: 1000 }); // ledger untouched
    db.close();
    openDb(path).close(); // re-opening an up-to-date db is a no-op
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
