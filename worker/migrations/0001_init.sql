-- Manifold Companion on the CAIL stack: core relational schema.
-- Everything is keyed on `subject`, the opaque CAIL subject from the verified
-- identity assertion. There are no passwords, sessions, approvals or token
-- ledger. Timestamps are UTC ISO-8601 strings written by the Worker.
--
-- Cascade rule (fixes the legacy bug where deleting a user with data failed):
-- every reference to profiles(subject) is either ON DELETE CASCADE (rows that
-- only make sense for that person) or ON DELETE SET NULL (rows that belong to
-- somebody else's project but record who touched them).

CREATE TABLE profiles (
  subject TEXT PRIMARY KEY CHECK (subject GLOB 'cail-*'),
  display_name TEXT,
  theme_preference TEXT NOT NULL DEFAULT 'system' CHECK (theme_preference IN ('system', 'light', 'dark')),
  onboarded INTEGER NOT NULL DEFAULT 0 CHECK (onboarded IN (0, 1)),
  -- Bytes of R2 content in projects this person OWNS. Charged to the owner so a
  -- collaborator cannot exhaust anyone else's quota, and so deleting the owner
  -- accounts for everything stored under their projects.
  storage_bytes INTEGER NOT NULL DEFAULT 0 CHECK (storage_bytes >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  owner_subject TEXT NOT NULL REFERENCES profiles (subject) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  project_type TEXT NOT NULL DEFAULT 'image_to_markdown' CHECK (project_type IN ('image_to_markdown', 'pdf_to_html')),
  default_language TEXT NOT NULL DEFAULT 'en',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Retention clock: bumped by any content edit. Projects are deleted
  -- RETENTION_DAYS after this.
  last_edited_at TEXT NOT NULL,
  -- Set when the in-app deletion warning was issued; cleared by any edit.
  retention_warned_at TEXT
);
CREATE INDEX idx_projects_owner ON projects (owner_subject);
CREATE INDEX idx_projects_last_edited ON projects (last_edited_at);

CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  subject TEXT NOT NULL REFERENCES profiles (subject) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, subject)
);
CREATE INDEX idx_members_subject ON project_members (subject);
-- Exactly one owner per project.
CREATE UNIQUE INDEX idx_members_one_owner ON project_members (project_id) WHERE role = 'owner';

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  -- SHA-256 of the random token, hex. The token itself is shown once.
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  created_by TEXT NOT NULL REFERENCES profiles (subject) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  redeemed_by TEXT REFERENCES profiles (subject) ON DELETE SET NULL,
  redeemed_at TEXT
);
CREATE INDEX idx_invites_project ON invites (project_id);

CREATE TABLE texts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'ocrd', 'reviewed')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  -- Short, bounded text stays in D1 (a row may not exceed 2,000,000 bytes).
  summary TEXT,
  source_language TEXT,
  target_language TEXT,
  source_pdf_name TEXT,
  pdf_meta TEXT,
  formula_repair_status TEXT,
  -- Large text lives in R2; D1 keeps the pointer, size and digest.
  html_key TEXT,
  html_bytes INTEGER NOT NULL DEFAULT 0,
  translation_key TEXT,
  translation_bytes INTEGER NOT NULL DEFAULT 0,
  source_pdf_key TEXT,
  source_pdf_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_texts_project ON texts (project_id, sort_order);

CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  text_id TEXT NOT NULL REFERENCES texts (id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  page_number INTEGER,
  -- One page of OCR output is a few KB; the route caps it far below the row limit.
  ocr_text TEXT,
  ocr_model TEXT,
  processed_at TEXT,
  image_key TEXT,
  image_bytes INTEGER NOT NULL DEFAULT 0,
  UNIQUE (text_id, filename)
);
CREATE INDEX idx_pages_text ON pages (text_id, page_number);

CREATE TABLE text_versions (
  id TEXT PRIMARY KEY,
  text_id TEXT NOT NULL REFERENCES texts (id) ON DELETE CASCADE,
  content_type TEXT NOT NULL CHECK (content_type IN ('compiled', 'html', 'page')),
  page_filename TEXT,
  -- The snapshot body is an R2 object; D1 holds only the pointer.
  r2_key TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  created_by TEXT REFERENCES profiles (subject) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_text_versions_lookup ON text_versions (text_id, content_type, created_at DESC);

CREATE TABLE metadata (
  text_id TEXT PRIMARY KEY REFERENCES texts (id) ON DELETE CASCADE,
  dc_title TEXT,
  dc_creator TEXT,
  dc_subject TEXT,
  dc_description TEXT,
  dc_date TEXT,
  dc_type TEXT,
  dc_format TEXT,
  dc_language TEXT,
  dc_source TEXT,
  dc_rights TEXT,
  dc_coverage TEXT,
  dc_contributor TEXT,
  dc_publisher TEXT,
  dc_relation TEXT,
  dc_identifier TEXT,
  updated_at TEXT NOT NULL
);

-- Per-text model task settings. Model ids are Gateway catalog ids
-- (prefix-free). math_model is the optional stronger vision+reasoning model
-- used for mathematics/table pages in PDF-to-HTML.
CREATE TABLE text_settings (
  text_id TEXT PRIMARY KEY REFERENCES texts (id) ON DELETE CASCADE,
  prompt TEXT,
  model TEXT,
  math_model TEXT,
  temperature REAL,
  max_tokens INTEGER,
  updated_at TEXT NOT NULL
);

CREATE TABLE export_settings (
  project_id TEXT PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  settings_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE annotations (
  id TEXT PRIMARY KEY,
  text_id TEXT NOT NULL REFERENCES texts (id) ON DELETE CASCADE,
  author_subject TEXT NOT NULL REFERENCES profiles (subject) ON DELETE CASCADE,
  parent_id TEXT REFERENCES annotations (id) ON DELETE CASCADE,
  anchor_type TEXT NOT NULL CHECK (anchor_type IN ('range', 'point', 'global')),
  anchor_data TEXT,
  body TEXT NOT NULL,
  mentions TEXT NOT NULL DEFAULT '[]',
  resolved INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0, 1)),
  resolved_by TEXT REFERENCES profiles (subject) ON DELETE SET NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_annotations_lookup ON annotations (text_id, resolved, created_at);
CREATE INDEX idx_annotations_author ON annotations (author_subject);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL REFERENCES profiles (subject) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  read INTEGER NOT NULL DEFAULT 0 CHECK (read IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_notifications_subject ON notifications (subject, read, created_at DESC);

CREATE TABLE notification_preferences (
  subject TEXT PRIMARY KEY REFERENCES profiles (subject) ON DELETE CASCADE,
  inapp_ocr_complete INTEGER NOT NULL DEFAULT 1,
  inapp_project_shared INTEGER NOT NULL DEFAULT 1,
  inapp_comment_reply INTEGER NOT NULL DEFAULT 1,
  inapp_comment_mention INTEGER NOT NULL DEFAULT 1,
  -- Reserved for the email design (docs/DESIGN.md); nothing reads these yet.
  email_enabled INTEGER NOT NULL DEFAULT 0
);
