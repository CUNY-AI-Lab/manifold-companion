-- Reply lookups and the cascade from a deleted thread root.
CREATE INDEX idx_annotations_parent ON annotations (parent_id);
