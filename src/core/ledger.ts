import type { Db } from "../db/db.js";

// TODO(seasons): weekly/seasonal leaderboard reset. The ledger already has a `season` column.
// A season rollover would bump a per-group season counter, grant fresh signups with the new
// season, and make balance()/leaderboard() filter on `season = current`.
export const CURRENT_SEASON = 1;

export type LedgerReason = "signup" | "bet" | "sell" | "payout" | "refund";

export interface LedgerEntry {
  userId: number | null; // null = market maker
  groupId: string;
  delta: number;
  reason: LedgerReason;
  marketId?: number | null;
  ts: number;
}

export function post(db: Db, e: LedgerEntry): void {
  if (!Number.isInteger(e.delta)) throw new Error(`ledger delta must be an integer, got ${e.delta}`);
  db.prepare(
    `INSERT INTO ledger (user_id, group_id, delta, reason, market_id, season, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(e.userId, e.groupId, e.delta, e.reason, e.marketId ?? null, CURRENT_SEASON, e.ts);
}

/**
 * Move points between a user and the market maker as two rows that sum to zero.
 * Positive `userDelta` pays the user; negative charges them.
 */
export function postWithAmm(
  db: Db,
  e: Omit<LedgerEntry, "userId" | "delta"> & { userId: number; userDelta: number },
): void {
  const { userDelta, ...rest } = e;
  post(db, { ...rest, delta: userDelta });
  post(db, { ...rest, userId: null, delta: -userDelta });
}

export function balance(db: Db, groupId: string, userId: number): number {
  const row = db
    .prepare(`SELECT COALESCE(SUM(delta), 0) AS bal FROM ledger WHERE user_id = ? AND group_id = ? AND season = ?`)
    .get(userId, groupId, CURRENT_SEASON) as { bal: number };
  return row.bal;
}

/** Points the user has put into a market, net of what they took out by selling. */
export function netSpend(db: Db, marketId: number, userId: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(-SUM(delta), 0) AS spent FROM ledger
       WHERE market_id = ? AND user_id = ? AND reason IN ('bet','sell')`,
    )
    .get(marketId, userId) as { spent: number };
  return row.spent;
}

export interface LeaderboardRow {
  userId: number;
  displayName: string;
  balance: number;
}

export function leaderboard(db: Db, groupId: string, limit = 10): LeaderboardRow[] {
  return db
    .prepare(
      `SELECT u.id AS userId, u.display_name AS displayName, SUM(l.delta) AS balance
       FROM users u JOIN ledger l ON l.user_id = u.id AND l.season = ?
       WHERE u.group_id = ?
       GROUP BY u.id
       ORDER BY balance DESC, u.id ASC
       LIMIT ?`,
    )
    .all(CURRENT_SEASON, groupId, limit) as LeaderboardRow[];
}

/** Sum of every ledger row in a group, market maker included. Must equal total signup grants. */
export function systemTotal(db: Db, groupId: string): number {
  const row = db
    .prepare(`SELECT COALESCE(SUM(delta), 0) AS t FROM ledger WHERE group_id = ?`)
    .get(groupId) as { t: number };
  return row.t;
}

export function totalSignups(db: Db, groupId: string): number {
  const row = db
    .prepare(`SELECT COALESCE(SUM(delta), 0) AS t FROM ledger WHERE group_id = ? AND reason = 'signup'`)
    .get(groupId) as { t: number };
  return row.t;
}
