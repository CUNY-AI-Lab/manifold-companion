-- Pages of a PDF conversion in progress, so a reload or a stopped run resumes
-- instead of paying for the same pages again. A cache, not content: one row per
-- converted page of the run in progress, keyed to the PDF it came from
-- (`source`, a fingerprint the browser sends), cleared when the conversion is
-- saved, when the source PDF is replaced, after 7 days (retention sweep), and
-- with the text (cascade; a moved text starts a new run). No person column.
-- Additive only: an older Worker version ignores the table.
CREATE TABLE conversion_pages (
  text_id TEXT NOT NULL REFERENCES texts (id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  source TEXT NOT NULL,
  total_pages INTEGER NOT NULL,
  math INTEGER NOT NULL DEFAULT 0,
  html TEXT NOT NULL,
  warnings TEXT NOT NULL DEFAULT '[]',
  model TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (text_id, page_number)
);
CREATE INDEX idx_conversion_pages_created ON conversion_pages (created_at);
