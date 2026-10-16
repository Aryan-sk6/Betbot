-- Migration 2: markets with N named outcomes instead of fixed YES/NO.
-- Existing YES/NO markets are converted in place: outcome 0 = Yes, outcome 1 = No.

CREATE TABLE outcomes (
  market_id INTEGER NOT NULL REFERENCES markets(id),
  idx       INTEGER NOT NULL,              -- position, 0-based; users may refer to it as idx + 1
  label     TEXT    NOT NULL,
  q         REAL    NOT NULL DEFAULT 0,    -- LMSR shares outstanding
  PRIMARY KEY (market_id, idx)
);

CREATE TABLE holdings (
  market_id   INTEGER NOT NULL REFERENCES markets(id),
  user_id     INTEGER NOT NULL REFERENCES users(id),
  outcome_idx INTEGER NOT NULL,
  shares      REAL    NOT NULL DEFAULT 0,
  PRIMARY KEY (market_id, user_id, outcome_idx)
);

INSERT INTO outcomes (market_id, idx, label, q) SELECT id, 0, 'Yes', q_yes FROM markets;
INSERT INTO outcomes (market_id, idx, label, q) SELECT id, 1, 'No',  q_no  FROM markets;
INSERT INTO holdings (market_id, user_id, outcome_idx, shares) SELECT market_id, user_id, 0, yes_shares FROM positions WHERE yes_shares > 0;
INSERT INTO holdings (market_id, user_id, outcome_idx, shares) SELECT market_id, user_id, 1, no_shares  FROM positions WHERE no_shares  > 0;

ALTER TABLE markets ADD COLUMN resolution_idx INTEGER;   -- winning outcome idx once resolved
UPDATE markets SET resolution_idx = CASE resolution WHEN 'yes' THEN 0 WHEN 'no' THEN 1 END WHERE resolution IS NOT NULL;

DROP TABLE positions;
ALTER TABLE markets DROP COLUMN q_yes;
ALTER TABLE markets DROP COLUMN q_no;
ALTER TABLE markets DROP COLUMN resolution;
