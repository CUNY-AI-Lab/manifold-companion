-- Deletion tombstones. Deleting a project or a text removes its D1 rows first
-- (in one transaction that also writes this row), then sweeps its R2 prefix.
-- A sweep that fails, or an object an in-flight upload wrote after the sweep,
-- is caught by the daily cron, which sweeps every tombstone again and forgets
-- it a day after it was created.
CREATE TABLE r2_cleanup (
  prefix TEXT PRIMARY KEY CHECK (prefix GLOB 'p/*/'),
  created_at TEXT NOT NULL,
  swept_at TEXT
);
