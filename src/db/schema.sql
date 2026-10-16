-- Betbot schema (migration 1). Applied by db.ts via PRAGMA user_version.

CREATE TABLE users (
  id           INTEGER PRIMARY KEY,
  platform_id  TEXT    NOT NULL,           -- opaque (WhatsApp JID / lid); never a display name
  group_id     TEXT    NOT NULL,
  display_name TEXT    NOT NULL,
  UNIQUE (group_id, platform_id)
);

CREATE TABLE markets (
  id         INTEGER PRIMARY KEY,
  group_id   TEXT    NOT NULL,
  num        INTEGER NOT NULL,             -- short per-group sequential id shown as #num
  question   TEXT    NOT NULL,
  creator_id INTEGER NOT NULL REFERENCES users(id),
  status     TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','resolved','void')),
  resolution TEXT             CHECK (resolution IN ('yes','no')),
  b          REAL    NOT NULL,             -- LMSR liquidity parameter
  q_yes      REAL    NOT NULL DEFAULT 0,
  q_no       REAL    NOT NULL DEFAULT 0,
  closes_at  INTEGER,                      -- epoch ms, NULL = no deadline
  created_at INTEGER NOT NULL,
  UNIQUE (group_id, num)
);

CREATE TABLE positions (
  market_id  INTEGER NOT NULL REFERENCES markets(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  yes_shares REAL    NOT NULL DEFAULT 0,
  no_shares  REAL    NOT NULL DEFAULT 0,
  PRIMARY KEY (market_id, user_id)
);

-- Append-only. Balance = SUM(delta) per user per group. Never stored anywhere else.
-- user_id NULL rows belong to the automated market maker (AMM): every bet/sell/payout/refund
-- is written as a pair (user, AMM) so SUM(delta) over a whole group always equals the
-- signup grants. That is the conservation invariant.
-- `season` is reserved for seasonal leaderboards (see TODO in core/ledger.ts).
CREATE TABLE ledger (
  id        INTEGER PRIMARY KEY,
  user_id   INTEGER REFERENCES users(id),
  group_id  TEXT    NOT NULL,
  delta     INTEGER NOT NULL,
  reason    TEXT    NOT NULL CHECK (reason IN ('signup','bet','sell','payout','refund')),
  market_id INTEGER REFERENCES markets(id),
  season    INTEGER NOT NULL DEFAULT 1,
  ts        INTEGER NOT NULL
);

CREATE INDEX idx_ledger_user   ON ledger (user_id, group_id);
CREATE INDEX idx_ledger_market ON ledger (market_id);
CREATE INDEX idx_markets_group ON markets (group_id, status);

-- Append-only guard.
CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
