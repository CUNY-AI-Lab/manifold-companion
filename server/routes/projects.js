// ---------------------------------------------------------------------------
// Project routes  —  mounted at /api/projects
// ---------------------------------------------------------------------------

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  createProject,
  getProjectsByUser,
  getProjectById,
  updateProject,
  deleteProject,
  getTextsByProject,
} from '../db.js';
import { deleteProjectFiles } from '../services/storage.js';

const router = Router();

// All routes require authentication
router.use(requireAuth);

// ---- GET / — list user's projects ----------------------------------------
router.get('/', (req, res) => {
  try {
    const projects = getProjectsByUser(req.user.id);

    // Enrich each project with its text count
    const enriched = projects.map((p) => {
      const texts = getTextsByProject(p.id);
      return { ...p, text_count: texts.length };
    });

    res.json(enriched);
  } catch (err) {
    console.error('GET /api/projects error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- POST / — create a new project ---------------------------------------
router.post('/', (req, res) => {
  try {
    const { name, description, default_language } = req.body || {};

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Project name is required.' });
    }

    const projectId = createProject(
      req.user.id,
      name.trim(),
      description?.trim() || null,
      default_language || 'en'
    );

    // Set expiry to 90 days from now
    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    updateProject(projectId, { expires_at: expiresAt });

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

    const texts = getTextsByProject(project.id);
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
    if (default_language !== undefined) fields.default_language = default_language;

    updateProject(project.id, fields);

    const updated = getProjectById(project.id);
    res.json(updated);
  } catch (err) {
    console.error('PUT /api/projects/:id error:', err);
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
