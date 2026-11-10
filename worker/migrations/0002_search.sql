-- Search support.
--
-- This migration originally created the FTS5 virtual table and its triggers.
-- FTS5 support on REMOTE D1 is not confirmed by the D1 documentation, and a
-- migration that the deployed D1 refuses would block every later migration and
-- the whole deploy. So the FTS5 objects are created at runtime, idempotently,
-- by ensureSearchIndex() in src/search.ts, and search degrades to a LIKE scan of
-- texts.search_text (0003) when FTS5 is unavailable. This file was rewritten
-- before it was ever applied to a real database (no deploy has happened).
CREATE INDEX IF NOT EXISTS idx_texts_project_updated ON texts (project_id, updated_at);
