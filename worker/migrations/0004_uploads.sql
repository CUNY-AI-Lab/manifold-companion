-- Uploaded bytes: the sniffed media type is stored (never trusted from the
-- client or the object), and figure crops for PDF-to-HTML texts get a table.
ALTER TABLE pages ADD COLUMN image_type TEXT;
ALTER TABLE texts ADD COLUMN source_pdf_revision TEXT;

CREATE TABLE figures (
  id TEXT PRIMARY KEY,
  text_id TEXT NOT NULL REFERENCES texts (id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  image_key TEXT NOT NULL,
  image_type TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (text_id, filename)
);
CREATE INDEX idx_figures_text ON figures (text_id);
