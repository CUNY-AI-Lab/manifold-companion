-- Content pointers and the search fallback column.
--
-- compiled_*: the user-edited full Markdown of an image project (the legacy
-- `__compiled__` sentinel page row is gone; it is an R2 object with a pointer).
-- search_text: capped extracted PLAIN text (title excluded). It is what FTS5
-- indexes AND what the LIKE fallback searches, so search keeps working if FTS5
-- is unavailable on the deployed D1 (see src/search.ts).
ALTER TABLE texts ADD COLUMN compiled_key TEXT;
ALTER TABLE texts ADD COLUMN compiled_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE texts ADD COLUMN search_text TEXT;
