-- Why a version was saved: the action that replaced this content.
-- save (a person saved an edit), ocr (a model read the page again),
-- conversion (a PDF conversion replaced the HTML), restore (an older version
-- was restored over it). NULL for versions saved before this column existed.
ALTER TABLE text_versions ADD COLUMN reason TEXT CHECK (reason IS NULL OR reason IN ('save', 'ocr', 'conversion', 'restore'));
-- Page versions are kept per page (pruned per page_filename).
CREATE INDEX idx_text_versions_page ON text_versions (text_id, page_filename, created_at DESC) WHERE content_type = 'page';
