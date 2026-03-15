// ---------------------------------------------------------------------------
// Annotation routes  —  mounted at /api
// ---------------------------------------------------------------------------

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { verifyTextAccess } from '../middleware/access.js';
import {
  createAnnotation,
  getAnnotationsByText,
  getAnnotationById,
  updateAnnotationBody,
  resolveAnnotation,
  unresolveAnnotation,
  deleteAnnotation,
  getAnnotationReplies,
} from '../db.js';

const router = Router();

// All routes require authentication
router.use(requireAuth);

// ---- GET /texts/:id/annotations — list annotations for a text --------------
router.get('/texts/:id/annotations', (req, res) => {
  try {
    const result = verifyTextAccess(Number(req.params.id), req.user.id, 'viewer');
    if (result.error) return res.status(result.status).json({ error: result.error });

    const includeResolved = req.query.resolved === '1';
    const annotations = getAnnotationsByText(result.text.id, includeResolved);
    res.json({ annotations });
  } catch (err) {
    console.error('GET /texts/:id/annotations error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- POST /texts/:id/annotations — create an annotation --------------------
router.post('/texts/:id/annotations', (req, res) => {
  try {
    const result = verifyTextAccess(Number(req.params.id), req.user.id, 'viewer');
    if (result.error) return res.status(result.status).json({ error: result.error });

    const { anchor_type, anchor_data, body, parent_id } = req.body || {};

    if (!body || !body.trim()) {
      return res.status(400).json({ error: 'Annotation body is required.' });
    }
    if (!anchor_type || !['range', 'point', 'global'].includes(anchor_type)) {
      return res.status(400).json({ error: 'Valid anchor_type is required (range, point, or global).' });
    }

    const id = createAnnotation(
      result.text.id,
      req.user.id,
      anchor_type,
      anchor_data ? JSON.stringify(anchor_data) : null,
      body.trim(),
      parent_id ? Number(parent_id) : null
    );

    const annotation = getAnnotationById(id);
    res.status(201).json({ annotation });
  } catch (err) {
    console.error('POST /texts/:id/annotations error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- GET /texts/:id/annotations/:annotId — get annotation with replies -----
router.get('/texts/:id/annotations/:annotId', (req, res) => {
  try {
    const result = verifyTextAccess(Number(req.params.id), req.user.id, 'viewer');
    if (result.error) return res.status(result.status).json({ error: result.error });

    const annotation = getAnnotationById(Number(req.params.annotId));
    if (!annotation || annotation.text_id !== result.text.id) {
      return res.status(404).json({ error: 'Annotation not found.' });
    }

    const replies = getAnnotationReplies(annotation.id);
    res.json({ annotation, replies });
  } catch (err) {
    console.error('GET /texts/:id/annotations/:annotId error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- PUT /texts/:id/annotations/:annotId — edit annotation body (own only) -
router.put('/texts/:id/annotations/:annotId', (req, res) => {
  try {
    const result = verifyTextAccess(Number(req.params.id), req.user.id, 'viewer');
    if (result.error) return res.status(result.status).json({ error: result.error });

    const annotation = getAnnotationById(Number(req.params.annotId));
    if (!annotation || annotation.text_id !== result.text.id) {
      return res.status(404).json({ error: 'Annotation not found.' });
    }
    if (annotation.user_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only edit your own annotations.' });
    }

    const { body } = req.body || {};
    if (!body || !body.trim()) {
      return res.status(400).json({ error: 'Annotation body is required.' });
    }

    updateAnnotationBody(annotation.id, body.trim());
    const updated = getAnnotationById(annotation.id);
    res.json({ annotation: updated });
  } catch (err) {
    console.error('PUT /texts/:id/annotations/:annotId error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- POST /texts/:id/annotations/:annotId/resolve — resolve annotation -----
router.post('/texts/:id/annotations/:annotId/resolve', (req, res) => {
  try {
    const result = verifyTextAccess(Number(req.params.id), req.user.id, 'editor');
    if (result.error) return res.status(result.status).json({ error: result.error });

    const annotation = getAnnotationById(Number(req.params.annotId));
    if (!annotation || annotation.text_id !== result.text.id) {
      return res.status(404).json({ error: 'Annotation not found.' });
    }

    resolveAnnotation(annotation.id, req.user.id);
    const updated = getAnnotationById(annotation.id);
    res.json({ annotation: updated });
  } catch (err) {
    console.error('POST /texts/:id/annotations/:annotId/resolve error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- POST /texts/:id/annotations/:annotId/unresolve — unresolve annotation -
router.post('/texts/:id/annotations/:annotId/unresolve', (req, res) => {
  try {
    const result = verifyTextAccess(Number(req.params.id), req.user.id, 'editor');
    if (result.error) return res.status(result.status).json({ error: result.error });

    const annotation = getAnnotationById(Number(req.params.annotId));
    if (!annotation || annotation.text_id !== result.text.id) {
      return res.status(404).json({ error: 'Annotation not found.' });
    }

    unresolveAnnotation(annotation.id);
    const updated = getAnnotationById(annotation.id);
    res.json({ annotation: updated });
  } catch (err) {
    console.error('POST /texts/:id/annotations/:annotId/unresolve error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- DELETE /texts/:id/annotations/:annotId — delete annotation -------------
router.delete('/texts/:id/annotations/:annotId', (req, res) => {
  try {
    const result = verifyTextAccess(Number(req.params.id), req.user.id, 'viewer');
    if (result.error) return res.status(result.status).json({ error: result.error });

    const annotation = getAnnotationById(Number(req.params.annotId));
    if (!annotation || annotation.text_id !== result.text.id) {
      return res.status(404).json({ error: 'Annotation not found.' });
    }

    // Only own annotations or project owner can delete
    if (annotation.user_id !== req.user.id && result.role !== 'owner') {
      return res.status(403).json({ error: 'You can only delete your own annotations.' });
    }

    deleteAnnotation(annotation.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /texts/:id/annotations/:annotId error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- POST /texts/:id/annotations/:annotId/replies — add a reply ------------
router.post('/texts/:id/annotations/:annotId/replies', (req, res) => {
  try {
    const result = verifyTextAccess(Number(req.params.id), req.user.id, 'viewer');
    if (result.error) return res.status(result.status).json({ error: result.error });

    const parent = getAnnotationById(Number(req.params.annotId));
    if (!parent || parent.text_id !== result.text.id) {
      return res.status(404).json({ error: 'Parent annotation not found.' });
    }

    const { body } = req.body || {};
    if (!body || !body.trim()) {
      return res.status(400).json({ error: 'Reply body is required.' });
    }

    const id = createAnnotation(
      result.text.id,
      req.user.id,
      parent.anchor_type,
      parent.anchor_data,
      body.trim(),
      parent.id
    );

    const reply = getAnnotationById(id);
    res.status(201).json({ annotation: reply });
  } catch (err) {
    console.error('POST /texts/:id/annotations/:annotId/replies error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

export default router;
