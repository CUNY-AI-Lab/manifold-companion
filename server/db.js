import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';
import { mkdirSync } from 'fs';
import { join } from 'path';

let db;

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export function initDatabase(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, 'manifold.db');

  db = new Database(dbPath);

  // Performance and safety pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  createSchema();
  runMigrations();
  seedAdmin();

  return db;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

function createSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'disabled')),
      storage_used_bytes INTEGER NOT NULL DEFAULT 0,
      last_login_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      project_type TEXT NOT NULL DEFAULT 'image_to_markdown' CHECK(project_type IN ('image_to_markdown', 'pdf_to_html')),
      default_language TEXT NOT NULL DEFAULT 'en',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS texts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'ocrd', 'reviewed')),
      summary TEXT,
      translation TEXT,
      source_language TEXT,
      target_language TEXT,
      html_content TEXT,
      source_pdf_name TEXT,
      pdf_meta TEXT,
      formula_repair_status TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      ocr_text TEXT,
      page_number INTEGER,
      processed_at TEXT,
      UNIQUE(text_id, filename),
      FOREIGN KEY (text_id) REFERENCES texts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text_id INTEGER UNIQUE NOT NULL,
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
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (text_id) REFERENCES texts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text_id INTEGER UNIQUE NOT NULL,
      prompt TEXT,
      model TEXT,
      temperature REAL,
      max_tokens INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (text_id) REFERENCES texts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS project_shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('viewer', 'editor')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id, user_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS text_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text_id INTEGER NOT NULL,
      content_type TEXT NOT NULL CHECK(content_type IN ('compiled', 'html', 'page')),
      content TEXT NOT NULL,
      page_filename TEXT,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (text_id) REFERENCES texts(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_text_versions_lookup
      ON text_versions(text_id, content_type, created_at DESC);

    CREATE TABLE IF NOT EXISTS annotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      parent_id INTEGER,
      anchor_type TEXT NOT NULL CHECK(anchor_type IN ('range', 'point', 'global')),
      anchor_data TEXT,
      body TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0,
      resolved_by INTEGER,
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (text_id) REFERENCES texts(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (parent_id) REFERENCES annotations(id) ON DELETE CASCADE,
      FOREIGN KEY (resolved_by) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_annotations_lookup
      ON annotations(text_id, resolved, created_at);

    CREATE TABLE IF NOT EXISTS api_usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      endpoint TEXT NOT NULL,
      model TEXT,
      project_id INTEGER,
      text_id INTEGER,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_api_usage_user ON api_usage_logs(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_api_usage_project ON api_usage_logs(project_id);
  `);
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

function runMigrations() {
  const migrations = [
    "ALTER TABLE projects ADD COLUMN project_type TEXT NOT NULL DEFAULT 'image_to_markdown' CHECK(project_type IN ('image_to_markdown', 'pdf_to_html'))",
    'ALTER TABLE texts ADD COLUMN sort_order INTEGER DEFAULT 0',
    'ALTER TABLE projects ADD COLUMN export_settings TEXT',
    'ALTER TABLE texts ADD COLUMN html_content TEXT',
    'ALTER TABLE texts ADD COLUMN source_pdf_name TEXT',
    'ALTER TABLE texts ADD COLUMN pdf_meta TEXT',
    'ALTER TABLE texts ADD COLUMN formula_repair_status TEXT',
    'ALTER TABLE users ADD COLUMN display_name TEXT',
    'ALTER TABLE users ADD COLUMN token_allowance INTEGER NOT NULL DEFAULT 5000000',
    'ALTER TABLE users ADD COLUMN token_usage_reset_at TEXT',
    "ALTER TABLE annotations ADD COLUMN mentions TEXT DEFAULT '[]'",
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch (_) { /* column already exists */ }
  }
}

// ---------------------------------------------------------------------------
// Admin Seeding (from environment variables)
// ---------------------------------------------------------------------------

const BCRYPT_ROUNDS = 12;
export { BCRYPT_ROUNDS };

function seedAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return; // No admin seed without explicit env config

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (!existing) {
    const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
    db.prepare(
      'INSERT INTO users (email, password_hash, role, status) VALUES (?, ?, ?, ?)'
    ).run(email.toLowerCase().trim(), hash, 'admin', 'approved');
  }
}

// ---------------------------------------------------------------------------
// User Functions
// ---------------------------------------------------------------------------

export function createUser(email, passwordHash, displayName = null) {
  const stmt = db.prepare(
    'INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)'
  );
  const result = stmt.run(email, passwordHash, displayName || null);
  return result.lastInsertRowid;
}

export function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

export function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function updateUserStatus(id, status) {
  return db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, id);
}

export function updateUserRole(id, role) {
  return db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
}

export function updateUserLogin(id) {
  return db.prepare(
    "UPDATE users SET last_login_at = datetime('now') WHERE id = ?"
  ).run(id);
}

export function updateUserStorage(id, bytes) {
  return db.prepare(
    'UPDATE users SET storage_used_bytes = ? WHERE id = ?'
  ).run(bytes, id);
}

export function updateUserPassword(id, passwordHash) {
  return db.prepare(
    'UPDATE users SET password_hash = ? WHERE id = ?'
  ).run(passwordHash, id);
}

export function getAllUsers() {
  return db.prepare('SELECT id, email, display_name, role, status, storage_used_bytes, token_allowance, token_usage_reset_at, last_login_at, created_at FROM users').all();
}

export function updateUserDisplayName(id, displayName) {
  return db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, id);
}

export function updateUserTokenAllowance(id, allowance) {
  return db.prepare('UPDATE users SET token_allowance = ? WHERE id = ?').run(allowance, id);
}

export function resetUserTokenUsage(id) {
  return db.prepare("UPDATE users SET token_usage_reset_at = datetime('now') WHERE id = ?").run(id);
}

export function bulkUpdateUserStatus(userIds, status) {
  const placeholders = userIds.map(() => '?').join(',');
  const txn = db.transaction(() => {
    db.prepare(`UPDATE users SET status = ? WHERE id IN (${placeholders})`).run(status, ...userIds);
  });
  txn();
}

export function searchUsers(query) {
  const pattern = `%${query}%`;
  return db.prepare(`
    SELECT id, email, display_name FROM users
    WHERE status = 'approved' AND (email LIKE ? OR display_name LIKE ?)
    ORDER BY display_name ASC, email ASC
    LIMIT 10
  `).all(pattern, pattern);
}

export function deleteUser(id) {
  return db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// Project Functions
// ---------------------------------------------------------------------------

export function createProject(userId, name, description, language, projectType = 'image_to_markdown') {
  const stmt = db.prepare(
    'INSERT INTO projects (user_id, name, description, default_language, project_type) VALUES (?, ?, ?, ?, ?)'
  );
  const result = stmt.run(userId, name, description || null, language || 'en', projectType);
  return result.lastInsertRowid;
}

export function getProjectsByUser(userId) {
  return db.prepare('SELECT * FROM projects WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
}

export function getProjectById(id) {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

export function updateProject(id, fields) {
  const allowed = ['name', 'description', 'default_language', 'expires_at'];
  const updates = [];
  const values = [];

  for (const key of allowed) {
    if (fields[key] !== undefined) {
      updates.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }

  if (updates.length === 0) return;

  updates.push("updated_at = datetime('now')");
  values.push(id);

  return db.prepare(
    `UPDATE projects SET ${updates.join(', ')} WHERE id = ?`
  ).run(...values);
}

export function deleteProject(id) {
  return db.prepare('DELETE FROM projects WHERE id = ?').run(id);
}

export function getExpiredProjects() {
  return db.prepare(
    "SELECT * FROM projects WHERE expires_at IS NOT NULL AND expires_at < datetime('now')"
  ).all();
}

export function getProjectExportSettings(projectId) {
  const row = db.prepare('SELECT export_settings FROM projects WHERE id = ?').get(projectId);
  if (!row?.export_settings) return null;
  try { return JSON.parse(row.export_settings); } catch { return null; }
}

export function saveProjectExportSettings(projectId, settings) {
  return db.prepare(
    "UPDATE projects SET export_settings = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(JSON.stringify(settings), projectId);
}

// ---------------------------------------------------------------------------
// Text Functions
// ---------------------------------------------------------------------------

export function createText(projectId, name) {
  const stmt = db.prepare(
    'INSERT INTO texts (project_id, name) VALUES (?, ?)'
  );
  const result = stmt.run(projectId, name);
  return result.lastInsertRowid;
}

export function getTextsByProject(projectId) {
  return db.prepare('SELECT * FROM texts WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC').all(projectId);
}

export function getTextById(id) {
  return db.prepare('SELECT * FROM texts WHERE id = ?').get(id);
}

export function updateText(id, fields) {
  const allowed = [
    'name',
    'status',
    'summary',
    'translation',
    'source_language',
    'target_language',
    'html_content',
    'source_pdf_name',
    'pdf_meta',
    'formula_repair_status',
  ];
  const updates = [];
  const values = [];

  for (const key of allowed) {
    if (fields[key] !== undefined) {
      updates.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }

  if (updates.length === 0) return;

  updates.push("updated_at = datetime('now')");
  values.push(id);

  return db.prepare(
    `UPDATE texts SET ${updates.join(', ')} WHERE id = ?`
  ).run(...values);
}

export function deleteText(id) {
  return db.prepare('DELETE FROM texts WHERE id = ?').run(id);
}

export function reorderTexts(projectId, textIds) {
  const stmt = db.prepare('UPDATE texts SET sort_order = ? WHERE id = ? AND project_id = ?');
  const txn = db.transaction((ids) => {
    for (let i = 0; i < ids.length; i++) {
      stmt.run(i, ids[i], projectId);
    }
  });
  txn(textIds);
}

export function setTextStatus(id, status) {
  return db.prepare(
    "UPDATE texts SET status = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(status, id);
}

export function setTextSummary(id, summary) {
  return db.prepare(
    "UPDATE texts SET summary = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(summary, id);
}

export function setTextTranslation(id, translation) {
  return db.prepare(
    "UPDATE texts SET translation = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(translation, id);
}

export function getTextTranslation(id) {
  const row = db.prepare('SELECT translation FROM texts WHERE id = ?').get(id);
  return row ? row.translation : null;
}

export function getTextHtml(id) {
  const row = db.prepare(
    'SELECT html_content, source_pdf_name, pdf_meta, formula_repair_status FROM texts WHERE id = ?'
  ).get(id);
  if (!row) return null;

  let pdfMeta = null;
  if (row.pdf_meta) {
    try {
      pdfMeta = JSON.parse(row.pdf_meta);
    } catch {
      pdfMeta = null;
    }
  }

  return {
    html_content: row.html_content || '',
    source_pdf_name: row.source_pdf_name || null,
    pdf_meta: pdfMeta,
    formula_repair_status: row.formula_repair_status || null,
  };
}

export function saveTextHtml(textId, htmlContent, options = {}) {
  const { sourcePdfName, pdfMeta, formulaRepairStatus } = options;

  return db.prepare(`
    UPDATE texts
    SET html_content = ?,
        source_pdf_name = COALESCE(?, source_pdf_name),
        pdf_meta = COALESCE(?, pdf_meta),
        formula_repair_status = COALESCE(?, formula_repair_status),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    htmlContent,
    sourcePdfName ?? null,
    pdfMeta !== undefined ? JSON.stringify(pdfMeta) : null,
    formulaRepairStatus ?? null,
    textId
  );
}

// ---------------------------------------------------------------------------
// Page Functions
// ---------------------------------------------------------------------------

export function savePageOCR(textId, filename, ocrText, pageNumber = null) {
  const stmt = db.prepare(`
    INSERT INTO pages (text_id, filename, ocr_text, page_number, processed_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(text_id, filename) DO UPDATE SET
      ocr_text = excluded.ocr_text,
      page_number = COALESCE(excluded.page_number, pages.page_number),
      processed_at = excluded.processed_at
  `);
  return stmt.run(textId, filename, ocrText, pageNumber);
}

export function getPagesByText(textId) {
  return db.prepare(
    'SELECT * FROM pages WHERE text_id = ? ORDER BY page_number ASC, filename ASC'
  ).all(textId);
}

export function savePageText(textId, filename, text) {
  const stmt = db.prepare(`
    INSERT INTO pages (text_id, filename, ocr_text, processed_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(text_id, filename) DO UPDATE SET
      ocr_text = excluded.ocr_text,
      processed_at = excluded.processed_at
  `);
  return stmt.run(textId, filename, text);
}

export function reorderPages(textId, pageIds) {
  const stmt = db.prepare('UPDATE pages SET page_number = ? WHERE id = ? AND text_id = ?');
  const txn = db.transaction((ids) => {
    for (let i = 0; i < ids.length; i++) {
      stmt.run(i + 1, ids[i], textId);
    }
  });
  txn(pageIds);
}

export function getMaxPageNumber(textId) {
  const row = db.prepare('SELECT MAX(page_number) as max_num FROM pages WHERE text_id = ?').get(textId);
  return row?.max_num || 0;
}

export function deletePage(id) {
  return db.prepare('DELETE FROM pages WHERE id = ?').run(id);
}

export function getPageById(id) {
  return db.prepare('SELECT * FROM pages WHERE id = ?').get(id);
}

export function getPageCountByProject(projectId) {
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM pages p
    JOIN texts t ON p.text_id = t.id
    WHERE t.project_id = ? AND p.filename != '__compiled__'
  `).get(projectId);
  return row ? row.count : 0;
}

export function getPageCountByText(textId) {
  const row = db.prepare(
    "SELECT COUNT(*) as count FROM pages WHERE text_id = ? AND filename != '__compiled__'"
  ).get(textId);
  return row ? row.count : 0;
}

// ---------------------------------------------------------------------------
// Metadata Functions
// ---------------------------------------------------------------------------

export function getTextMetadata(textId) {
  return db.prepare('SELECT * FROM metadata WHERE text_id = ?').get(textId);
}

export function saveTextMetadata(textId, fields) {
  const dcFields = [
    'dc_title', 'dc_creator', 'dc_subject', 'dc_description',
    'dc_date', 'dc_type', 'dc_format', 'dc_language',
    'dc_source', 'dc_rights', 'dc_coverage', 'dc_contributor',
    'dc_publisher', 'dc_relation', 'dc_identifier'
  ];

  const existing = db.prepare('SELECT id FROM metadata WHERE text_id = ?').get(textId);

  if (existing) {
    const updates = [];
    const values = [];

    for (const key of dcFields) {
      if (fields[key] !== undefined) {
        updates.push(`${key} = ?`);
        values.push(fields[key]);
      }
    }

    if (updates.length === 0) return;

    updates.push("updated_at = datetime('now')");
    values.push(textId);

    return db.prepare(
      `UPDATE metadata SET ${updates.join(', ')} WHERE text_id = ?`
    ).run(...values);
  } else {
    const cols = ['text_id'];
    const placeholders = ['?'];
    const values = [textId];

    for (const key of dcFields) {
      if (fields[key] !== undefined) {
        cols.push(key);
        placeholders.push('?');
        values.push(fields[key]);
      }
    }

    return db.prepare(
      `INSERT INTO metadata (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`
    ).run(...values);
  }
}

// ---------------------------------------------------------------------------
// Settings Functions
// ---------------------------------------------------------------------------

export function getTextSettings(textId) {
  return db.prepare('SELECT * FROM settings WHERE text_id = ?').get(textId);
}

export function saveTextSettings(textId, settings) {
  const allowed = ['prompt', 'model', 'temperature', 'max_tokens'];
  const existing = db.prepare('SELECT id FROM settings WHERE text_id = ?').get(textId);

  if (existing) {
    const updates = [];
    const values = [];

    for (const key of allowed) {
      if (settings[key] !== undefined) {
        updates.push(`${key} = ?`);
        values.push(settings[key]);
      }
    }

    if (updates.length === 0) return;

    updates.push("updated_at = datetime('now')");
    values.push(textId);

    return db.prepare(
      `UPDATE settings SET ${updates.join(', ')} WHERE text_id = ?`
    ).run(...values);
  } else {
    const cols = ['text_id'];
    const placeholders = ['?'];
    const values = [textId];

    for (const key of allowed) {
      if (settings[key] !== undefined) {
        cols.push(key);
        placeholders.push('?');
        values.push(settings[key]);
      }
    }

    return db.prepare(
      `INSERT INTO settings (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`
    ).run(...values);
  }
}

export function deleteTextSettings(textId) {
  return db.prepare('DELETE FROM settings WHERE text_id = ?').run(textId);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export function searchTexts(userId, query) {
  const pattern = `%${query}%`;
  return db.prepare(`
    SELECT t.*, p.name AS project_name, p.project_type,
      CASE WHEN p.user_id = ? THEN 'owner' ELSE ps.role END AS access_role
    FROM texts t
    JOIN projects p ON t.project_id = p.id
    LEFT JOIN project_shares ps ON ps.project_id = p.id AND ps.user_id = ?
    WHERE (p.user_id = ? OR ps.user_id = ?)
      AND (
        t.name LIKE ?
        OR t.summary LIKE ?
        OR p.name LIKE ?
        OR t.html_content LIKE ?
        OR EXISTS (
          SELECT 1 FROM pages pg WHERE pg.text_id = t.id AND pg.ocr_text LIKE ?
        )
        OR EXISTS (
          SELECT 1 FROM metadata m WHERE m.text_id = t.id AND (
            m.dc_title LIKE ? OR m.dc_creator LIKE ? OR m.dc_subject LIKE ? OR m.dc_description LIKE ?
          )
        )
      )
    ORDER BY t.updated_at DESC
    LIMIT 50
  `).all(userId, userId, userId, userId, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern);
}

// ---------------------------------------------------------------------------
// Project Shares
// ---------------------------------------------------------------------------

export function createProjectShare(projectId, userId, role = 'viewer') {
  const stmt = db.prepare(
    'INSERT INTO project_shares (project_id, user_id, role) VALUES (?, ?, ?)'
  );
  const result = stmt.run(projectId, userId, role);
  return result.lastInsertRowid;
}

export function getProjectShares(projectId) {
  return db.prepare(`
    SELECT ps.id, ps.user_id, u.email, u.display_name, ps.role, ps.created_at
    FROM project_shares ps
    JOIN users u ON u.id = ps.user_id
    WHERE ps.project_id = ?
    ORDER BY ps.created_at ASC
  `).all(projectId);
}

export function getProjectShare(projectId, userId) {
  return db.prepare(
    'SELECT * FROM project_shares WHERE project_id = ? AND user_id = ?'
  ).get(projectId, userId);
}

export function updateProjectShareRole(projectId, userId, role) {
  return db.prepare(
    'UPDATE project_shares SET role = ? WHERE project_id = ? AND user_id = ?'
  ).run(role, projectId, userId);
}

export function deleteProjectShare(projectId, userId) {
  return db.prepare(
    'DELETE FROM project_shares WHERE project_id = ? AND user_id = ?'
  ).run(projectId, userId);
}

export function deleteProjectShareById(shareId) {
  return db.prepare('DELETE FROM project_shares WHERE id = ?').run(shareId);
}

export function getProjectShareById(shareId) {
  return db.prepare('SELECT * FROM project_shares WHERE id = ?').get(shareId);
}

export function getSharedProjectsByUser(userId) {
  return db.prepare(`
    SELECT p.*, ps.role AS share_role, u.email AS owner_email, u.display_name AS owner_display_name
    FROM projects p
    JOIN project_shares ps ON ps.project_id = p.id
    JOIN users u ON u.id = p.user_id
    WHERE ps.user_id = ?
    ORDER BY p.updated_at DESC
  `).all(userId);
}

export function getUserProjectRole(projectId, userId) {
  const row = db.prepare(`
    SELECT CASE WHEN p.user_id = ? THEN 'owner' ELSE ps.role END AS role
    FROM projects p
    LEFT JOIN project_shares ps ON ps.project_id = p.id AND ps.user_id = ?
    WHERE p.id = ?
  `).get(userId, userId, projectId);
  return row?.role || null;
}

// ---------------------------------------------------------------------------
// Text Versions
// ---------------------------------------------------------------------------

export function createTextVersion(textId, contentType, content, userId, pageFilename = null) {
  const stmt = db.prepare(
    'INSERT INTO text_versions (text_id, content_type, content, page_filename, user_id) VALUES (?, ?, ?, ?, ?)'
  );
  const result = stmt.run(textId, contentType, content, pageFilename, userId);

  // Prune to keep last 50 versions per text+type
  db.prepare(`
    DELETE FROM text_versions WHERE id IN (
      SELECT id FROM text_versions
      WHERE text_id = ? AND content_type = ?
      ORDER BY created_at DESC
      LIMIT -1 OFFSET 50
    )
  `).run(textId, contentType);

  return result.lastInsertRowid;
}

export function getTextVersions(textId, contentType, limit = 50) {
  return db.prepare(`
    SELECT tv.id, tv.content_type, tv.page_filename, tv.user_id, u.email AS user_email, u.display_name AS user_display_name, tv.created_at
    FROM text_versions tv
    JOIN users u ON u.id = tv.user_id
    WHERE tv.text_id = ? AND tv.content_type = ?
    ORDER BY tv.created_at DESC
    LIMIT ?
  `).all(textId, contentType, limit);
}

export function getTextVersionById(versionId) {
  return db.prepare('SELECT * FROM text_versions WHERE id = ?').get(versionId);
}

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

export function createAnnotation(textId, userId, anchorType, anchorData, body, parentId = null, mentions = []) {
  const stmt = db.prepare(
    'INSERT INTO annotations (text_id, user_id, parent_id, anchor_type, anchor_data, body, mentions) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const result = stmt.run(textId, userId, parentId, anchorType, anchorData ? JSON.stringify(anchorData) : null, body, JSON.stringify(mentions));
  return result.lastInsertRowid;
}

export function getProjectMembers(projectId) {
  // Returns owner + all shared users for a project
  const owner = db.prepare(`
    SELECT u.id, u.email, u.display_name
    FROM projects p
    JOIN users u ON u.id = p.user_id
    WHERE p.id = ?
  `).get(projectId);
  const shared = db.prepare(`
    SELECT u.id, u.email, u.display_name
    FROM project_shares ps
    JOIN users u ON u.id = ps.user_id
    WHERE ps.project_id = ?
    ORDER BY u.display_name ASC, u.email ASC
  `).all(projectId);
  return owner ? [owner, ...shared] : shared;
}

export function getAnnotationsByText(textId, includeResolved = false) {
  const resolvedClause = includeResolved ? '' : 'AND a.resolved = 0';
  return db.prepare(`
    SELECT a.*, u.email AS user_email, u.display_name AS user_display_name,
      (SELECT COUNT(*) FROM annotations r WHERE r.parent_id = a.id) AS reply_count
    FROM annotations a
    JOIN users u ON u.id = a.user_id
    WHERE a.text_id = ? AND a.parent_id IS NULL ${resolvedClause}
    ORDER BY a.created_at ASC
  `).all(textId);
}

export function getAnnotationById(id) {
  return db.prepare(`
    SELECT a.*, u.email AS user_email, u.display_name AS user_display_name
    FROM annotations a
    JOIN users u ON u.id = a.user_id
    WHERE a.id = ?
  `).get(id);
}

export function updateAnnotationBody(id, body) {
  return db.prepare(
    "UPDATE annotations SET body = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(body, id);
}

export function resolveAnnotation(id, userId) {
  return db.prepare(
    "UPDATE annotations SET resolved = 1, resolved_by = ?, resolved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  ).run(userId, id);
}

export function unresolveAnnotation(id) {
  return db.prepare(
    "UPDATE annotations SET resolved = 0, resolved_by = NULL, resolved_at = NULL, updated_at = datetime('now') WHERE id = ?"
  ).run(id);
}

export function deleteAnnotation(id) {
  return db.prepare('DELETE FROM annotations WHERE id = ?').run(id);
}

export function getAnnotationReplies(parentId) {
  return db.prepare(`
    SELECT a.*, u.email AS user_email, u.display_name AS user_display_name
    FROM annotations a
    JOIN users u ON u.id = a.user_id
    WHERE a.parent_id = ?
    ORDER BY a.created_at ASC
  `).all(parentId);
}

// ---------------------------------------------------------------------------
// API Usage Logging
// ---------------------------------------------------------------------------

export function logApiUsage(userId, endpoint, model, projectId, textId, tokensIn, tokensOut) {
  return db.prepare(
    'INSERT INTO api_usage_logs (user_id, endpoint, model, project_id, text_id, tokens_in, tokens_out) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(userId, endpoint, model || null, projectId || null, textId || null, tokensIn || 0, tokensOut || 0);
}

export function getUserTokenUsage(userId) {
  const user = db.prepare('SELECT token_usage_reset_at FROM users WHERE id = ?').get(userId);
  const resetAt = user?.token_usage_reset_at || '1970-01-01';
  const row = db.prepare(
    'SELECT COALESCE(SUM(tokens_in + tokens_out), 0) AS total FROM api_usage_logs WHERE user_id = ? AND created_at > ?'
  ).get(userId, resetAt);
  return row?.total || 0;
}

export function getUsageStats(days = 30) {
  const since = `datetime('now', '-${Math.min(days, 365)} days')`;

  const byEndpoint = db.prepare(`
    SELECT endpoint, COUNT(*) AS calls, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out
    FROM api_usage_logs WHERE created_at > ${since}
    GROUP BY endpoint ORDER BY calls DESC
  `).all();

  const byUser = db.prepare(`
    SELECT a.user_id, u.email, u.display_name, u.storage_used_bytes, u.token_allowance,
      COUNT(*) AS calls, SUM(a.tokens_in + a.tokens_out) AS total_tokens
    FROM api_usage_logs a
    JOIN users u ON u.id = a.user_id
    WHERE a.created_at > ${since}
    GROUP BY a.user_id ORDER BY total_tokens DESC
  `).all();

  const byProject = db.prepare(`
    SELECT a.project_id, p.name AS project_name, u.email AS owner_email,
      COUNT(*) AS calls, SUM(a.tokens_in + a.tokens_out) AS total_tokens
    FROM api_usage_logs a
    JOIN projects p ON p.id = a.project_id
    JOIN users u ON u.id = p.user_id
    WHERE a.created_at > ${since} AND a.project_id IS NOT NULL
    GROUP BY a.project_id ORDER BY calls DESC
    LIMIT 20
  `).all();

  const totals = db.prepare(`
    SELECT COUNT(*) AS total_calls, COALESCE(SUM(tokens_in + tokens_out), 0) AS total_tokens
    FROM api_usage_logs WHERE created_at > ${since}
  `).get();

  return { byEndpoint, byUser, byProject, totals };
}

export function getDatabase() {
  return db;
}
