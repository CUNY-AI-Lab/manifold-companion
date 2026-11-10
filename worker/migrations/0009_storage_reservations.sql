-- Storage quota reserved for bytes not yet recorded in a row (an upload or a
-- write in progress). Invariant (docs/DESIGN.md, Storage accounting):
--   profiles.storage_bytes = bytes the owner's project rows account for
--                          + live reservations of that owner.
-- A reservation is created in the same transaction that raises the counter,
-- and deleted in the same transaction that writes the row (commit) or lowers
-- the counter (release). One left by an interrupted Worker expires and the
-- daily sweep releases it. Additive: an older Worker version ignores the table.
CREATE TABLE storage_reservations (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL REFERENCES profiles (subject) ON DELETE CASCADE,
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_storage_reservations_subject ON storage_reservations (subject, expires_at);
