// ---------------------------------------------------------------------------
// Project routes  —  mounted at /api/projects
// ---------------------------------------------------------------------------

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { verifyProjectAccess } from '../middleware/access.js';
import { ALLOWED_LANGUAGES } from './texts.js';
import {
  createProject,
  getProjectsByUser,
  getProjectById,
  updateProject,
  deleteProject,
  getTextsByProject,
  getPageCountByProject,
  getPageCountByText,
  reorderTexts,
  getSharedProjectsByUser,
  getUserTokenUsage,
  getUserTokenBreakdown,
} from '../db.js';
import { deleteProjectFiles, getUserDir } from '../services/storage.js';
import { readdir, stat } from 'fs/promises';
import { join } from 'path';

const router = Router();
const ALLOWED_PROJECT_TYPES = new Set(['image_to_markdown', 'pdf_to_html']);

export { ALLOWED_PROJECT_TYPES };

// All routes require authentication
router.use(requireAuth);

// ---- GET / — list user's projects + shared projects ----------------------
router.get('/', (req, res) => {
  try {
    const projects = getProjectsByUser(req.user.id);

    // Enrich each project with its text count and page count
    const enriched = projects.map((p) => {
      const texts = getTextsByProject(p.id);
      return { ...p, text_count: texts.length, page_count: getPageCountByProject(p.id) };
    });

    // Get projects shared with this user
    const sharedRaw = getSharedProjectsByUser(req.user.id);
    const shared = sharedRaw.map((p) => {
      const texts = getTextsByProject(p.id);
      return { ...p, text_count: texts.length, page_count: getPageCountByProject(p.id) };
    });

    const tokenUsage = getUserTokenUsage(req.user.id);
    res.json({
      projects: enriched,
      shared,
      storage_used_bytes: req.user.storage_used_bytes || 0,
      token_usage: tokenUsage,
      token_allowance: req.user.token_allowance,
    });
  } catch (err) {
    console.error('GET /api/projects error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- POST / — create a new project ---------------------------------------
router.post('/', (req, res) => {
  try {
    const { name, description, default_language, project_type } = req.body || {};

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Project name is required.' });
    }

    if (project_type && !ALLOWED_PROJECT_TYPES.has(project_type)) {
      return res.status(400).json({ error: 'Invalid project type.' });
    }

    if (default_language && !ALLOWED_LANGUAGES.has(default_language)) {
      return res.status(400).json({ error: 'Invalid language code.' });
    }

    const projectId = createProject(
      req.user.id,
      name.trim(),
      description?.trim() || null,
      default_language || 'en',
      project_type || 'image_to_markdown'
    );

    // Set expiry to 90 days from now (admins are exempt)
    if (req.user.role !== 'admin') {
      const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
      updateProject(projectId, { expires_at: expiresAt });
    }

    const project = getProjectById(projectId);
    res.status(201).json(project);
  } catch (err) {
    console.error('POST /api/projects error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- GET /usage — user's own usage breakdown ------------------------------
router.get('/usage', async (req, res) => {
  try {
    const userId = req.user.id;
    const projects = getProjectsByUser(userId);
    const userDir = getUserDir(userId);

    // Per-project storage
    const storage = [];
    for (const p of projects) {
      const projDir = join(userDir, String(p.id));
      let bytes = 0;
      try {
        const items = await readdir(projDir, { withFileTypes: true, recursive: true });
        for (const item of items) {
          if (!item.isFile()) continue;
          try {
            const parentPath = item.parentPath || item.path;
            const info = await stat(join(parentPath, item.name));
            bytes += info.size;
          } catch {}
        }
      } catch {}
      if (bytes > 0) storage.push({ id: p.id, name: p.name, bytes });
    }

    // Token breakdown
    const { byProject, byEndpoint } = getUserTokenBreakdown(userId);

    res.json({ storage, tokensByProject: byProject, tokensByEndpoint: byEndpoint });
  } catch (err) {
    console.error('GET /usage error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- GET /:id — get single project with its texts -------------------------
router.get('/:id', (req, res) => {
  try {
    const result = verifyProjectAccess(Number(req.params.id), req.user.id, 'viewer');
    if (result.error) return res.status(result.status).json({ error: result.error });

    const texts = getTextsByProject(result.project.id).map((t) => ({
      ...t,
      page_count: getPageCountByText(t.id),
    }));
    res.json({ ...result.project, texts, role: result.role });
  } catch (err) {
    console.error('GET /api/projects/:id error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- PUT /:id — update project (editor+) ---------------------------------
router.put('/:id', (req, res) => {
  try {
    const result = verifyProjectAccess(Number(req.params.id), req.user.id, 'editor');
    if (result.error) return res.status(result.status).json({ error: result.error });

    const { name, description, default_language } = req.body || {};

    const fields = {};
    if (name !== undefined) fields.name = name.trim();
    if (description !== undefined) fields.description = description?.trim() || null;
    if (default_language !== undefined) {
      if (default_language && !ALLOWED_LANGUAGES.has(default_language)) {
        return res.status(400).json({ error: 'Invalid language code.' });
      }
      fields.default_language = default_language;
    }

    updateProject(result.project.id, fields);

    const updated = getProjectById(result.project.id);
    res.json(updated);
  } catch (err) {
    console.error('PUT /api/projects/:id error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- PUT /:id/texts/reorder — reorder texts within project (editor+) -----
router.put('/:id/texts/reorder', (req, res) => {
  try {
    const result = verifyProjectAccess(Number(req.params.id), req.user.id, 'editor');
    if (result.error) return res.status(result.status).json({ error: result.error });

    const { textIds } = req.body || {};
    if (!Array.isArray(textIds) || textIds.length === 0) {
      return res.status(400).json({ error: 'textIds array is required.' });
    }

    reorderTexts(result.project.id, textIds.map(Number));
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/projects/:id/texts/reorder error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- DELETE /:id — delete project + files (owner only) -------------------
router.delete('/:id', async (req, res) => {
  try {
    const result = verifyProjectAccess(Number(req.params.id), req.user.id, 'owner');
    if (result.error) return res.status(result.status).json({ error: result.error });

    // Remove files from disk first (files are in owner's directory)
    await deleteProjectFiles(result.project.user_id, result.project.id);

    // Then delete from database (cascades to texts, pages, metadata, settings, shares)
    deleteProject(result.project.id);

    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/projects/:id error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

export default router;
