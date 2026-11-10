-- Full-text search over extracted PLAIN TEXT (never HTML), replacing the
-- legacy LIKE over HTML. One row per text. The Worker writes `body` (capped)
-- whenever a text's content changes; triggers keep the index from outliving
-- its text, including cascaded deletes from projects and profiles.
CREATE VIRTUAL TABLE text_fts USING fts5 (
  text_id UNINDEXED,
  project_id UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER texts_fts_delete AFTER DELETE ON texts
BEGIN
  DELETE FROM text_fts WHERE text_id = old.id;
END;

CREATE TRIGGER texts_fts_rename AFTER UPDATE OF name ON texts
BEGIN
  UPDATE text_fts SET title = new.name WHERE text_id = new.id;
END;
