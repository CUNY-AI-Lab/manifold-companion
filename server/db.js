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

export function createUser(email, passwordHash) {
  const stmt = db.prepare(
    'INSERT INTO users (email, password_hash) VALUES (?, ?)'
  );
  const result = stmt.run(email, passwordHash);
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
  return db.prepare('SELECT id, email, role, status, storage_used_bytes, last_login_at, created_at FROM users').all();
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
    SELECT t.*, p.name AS project_name
    FROM texts t
    JOIN projects p ON t.project_id = p.id
    WHERE p.user_id = ?
      AND (
        t.name LIKE ?
        OR t.summary LIKE ?
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
  `).all(userId, pattern, pattern, pattern, pattern, pattern, pattern, pattern);
}
