-- Ownership transfer needs the new owner's consent: the owner offers, the
-- member accepts. At most one pending offer per project. Additive only: an
-- older Worker version ignores this table and the new column.
CREATE TABLE transfer_offers (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects (id) ON DELETE CASCADE,
  from_subject TEXT NOT NULL REFERENCES profiles (subject) ON DELETE CASCADE,
  to_subject TEXT NOT NULL REFERENCES profiles (subject) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  -- Set by the one accepting request, in the same transaction that moves ownership.
  claim_nonce TEXT,
  -- The project's stored bytes, measured inside that transaction.
  claim_bytes INTEGER
);
CREATE INDEX idx_transfer_offers_to ON transfer_offers (to_subject);
-- The nonce of the accept that last moved this project: every follow-up statement of
-- that transaction requires it, so a repeated or concurrent request can never satisfy them.
ALTER TABLE projects ADD COLUMN transfer_nonce TEXT;
