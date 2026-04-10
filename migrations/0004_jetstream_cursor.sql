-- Singleton-row table for persistent background-task state. Currently holds
-- the jetstream cursor (microseconds-since-epoch) used by the cron to resume
-- draining `garden.atmo.submission` events across runs. CHECK constraint
-- enforces that only one row ever exists.
CREATE TABLE IF NOT EXISTS sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  jetstream_cursor INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
