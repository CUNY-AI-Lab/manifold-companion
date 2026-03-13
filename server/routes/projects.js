// ---------------------------------------------------------------------------
// Project routes  —  mounted at /api/projects
// ---------------------------------------------------------------------------

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
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
} from '../db.js';
import { deleteProjectFiles } from '../services/storage.js';

const router = Router();
const ALLOWED_PROJECT_TYPES = new Set(['image_to_markdown', 'pdf_to_html']);

export { ALLOWED_PROJECT_TYPES };

// All routes require authentication
router.use(requireAuth);

// ---- GET / — list user's projects ----------------------------------------
router.get('/', (req, res) => {
  try {
    const projects = getProjectsByUser(req.user.id);

    // Enrich each project with its text count and page count
    const enriched = projects.map((p) => {
      const texts = getTextsByProject(p.id);
      return { ...p, text_count: texts.length, page_count: getPageCountByProject(p.id) };
    });

    res.json({ projects: enriched, storage_used_bytes: req.user.storage_used_bytes || 0 });
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

// ---- GET /:id — get single project with its texts -------------------------
router.get('/:id', (req, res) => {
  try {
    const project = getProjectById(Number(req.params.id));

    if (!project) {
      return res.status(404).json({ error: 'Project not found.' });
    }

    if (project.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const texts = getTextsByProject(project.id).map((t) => ({
      ...t,
      page_count: getPageCountByText(t.id),
    }));
    res.json({ ...project, texts });
  } catch (err) {
    console.error('GET /api/projects/:id error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- PUT /:id — update project -------------------------------------------
router.put('/:id', (req, res) => {
  try {
    const project = getProjectById(Number(req.params.id));

    if (!project) {
      return res.status(404).json({ error: 'Project not found.' });
    }

    if (project.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied.' });
    }

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

    updateProject(project.id, fields);

    const updated = getProjectById(project.id);
    res.json(updated);
  } catch (err) {
    console.error('PUT /api/projects/:id error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- PUT /:id/texts/reorder — reorder texts within project ----------------
router.put('/:id/texts/reorder', (req, res) => {
  try {
    const project = getProjectById(Number(req.params.id));

    if (!project) {
      return res.status(404).json({ error: 'Project not found.' });
    }

    if (project.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const { textIds } = req.body || {};
    if (!Array.isArray(textIds) || textIds.length === 0) {
      return res.status(400).json({ error: 'textIds array is required.' });
    }

    reorderTexts(project.id, textIds.map(Number));
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/projects/:id/texts/reorder error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- DELETE /:id — delete project + files ---------------------------------
router.delete('/:id', async (req, res) => {
  try {
    const project = getProjectById(Number(req.params.id));

    if (!project) {
      return res.status(404).json({ error: 'Project not found.' });
    }

    if (project.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    // Remove files from disk first
    await deleteProjectFiles(req.user.id, project.id);

    // Then delete from database (cascades to texts, pages, metadata, settings)
    deleteProject(project.id);

    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/projects/:id error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

export default router;
