-- A reservation belongs to the project whose bytes it holds, so an ownership
-- transfer that commits while an upload to that project is in flight moves the
-- reservation to the new owner in the same transaction (and counts it against
-- the new owner's room). Additive only: a nullable column and an index; an
-- older Worker version ignores both.
ALTER TABLE storage_reservations ADD COLUMN project_id TEXT;
CREATE INDEX idx_storage_reservations_project ON storage_reservations (project_id);
