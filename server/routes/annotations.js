// ---------------------------------------------------------------------------
// Annotation routes  —  mounted at /api
// ---------------------------------------------------------------------------

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { verifyTextAccess } from '../middleware/access.js';
import { notifyCommentReply, notifyMention } from '../services/notify.js';
import {
  createAnnotation,
  getAnnotationsByText,
  getAnnotationById,
  updateAnnotationBody,
  resolveAnnotation,
  unresolveAnnotation,
  deleteAnnotation,
  getAnnotationReplies,
  getProjectMembers,
  getUserProjectRole,
} from '../db.js';

const router = Router();

// All routes require authentication
router.use(requireAuth);

// ---- GET /texts/:id/mentions/users — project members for @mention autocomplete
router.get('/texts/:id/mentions/users', (req, res) => {
  try {
    const result = verifyTextAccess(Number(req.params.id), req.user.id, 'viewer');
    if (result.error) return res.status(result.status).json({ error: result.error });

    const users = getProjectMembers(result.project.id);
    res.json({ users });
  } catch (err) {
    console.error('GET /texts/:id/mentions/users error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

function parseMentions(raw) {
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

// ---- GET /texts/:id/annotations — list annotations for a text --------------
router.get('/texts/:id/annotations', (req, res) => {
  try {
    const result = verifyTextAccess(Number(req.params.id), req.user.id, 'viewer');
    if (result.error) return res.status(result.status).json({ error: result.error });

    const includeResolved = req.query.resolved === '1';
    const annotations = getAnnotationsByText(result.text.id, includeResolved);

    // Parse mentions and build mentioned_users map from project members
    const members = getProjectMembers(result.project.id);
    const memberMap = {};
    for (const m of members) memberMap[m.id] = { display_name: m.display_name, email: m.email };

    const parsed = annotations.map(a => ({
      ...a,
      mentions: parseMentions(a.mentions),
    }));

    res.json({ annotations: parsed, mentioned_users: memberMap });
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

    const { anchor_type, anchor_data, body, parent_id, mentions } = req.body || {};

    if (!body || !body.trim()) {
      return res.status(400).json({ error: 'Annotation body is required.' });
    }
    if (!anchor_type || !['range', 'point', 'global'].includes(anchor_type)) {
      return res.status(400).json({ error: 'Valid anchor_type is required (range, point, or global).' });
    }

    // Validate mentions — must be project members
    let validMentions = [];
    if (Array.isArray(mentions) && mentions.length > 0) {
      const members = getProjectMembers(result.project.id);
      const memberIds = new Set(members.map(m => m.id));
      validMentions = mentions.filter(id => memberIds.has(Number(id))).map(Number);
    }

    const id = createAnnotation(
      result.text.id,
      req.user.id,
      anchor_type,
      anchor_data ? JSON.stringify(anchor_data) : null,
      body.trim(),
      parent_id ? Number(parent_id) : null,
      validMentions
    );

    // Notify mentioned users
    if (validMentions.length > 0) {
      try { notifyMention(validMentions, body.trim(), req.user.id, result.text.id, result.text.name); } catch (e) { console.error('Mention notification error:', e.message); }
    }

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
    res.json({
      annotation: { ...annotation, mentions: parseMentions(annotation.mentions) },
      replies: replies.map(r => ({ ...r, mentions: parseMentions(r.mentions) })),
    });
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

    const { body, mentions } = req.body || {};
    if (!body || !body.trim()) {
      return res.status(400).json({ error: 'Reply body is required.' });
    }

    // Validate mentions
    let validMentions = [];
    if (Array.isArray(mentions) && mentions.length > 0) {
      const members = getProjectMembers(result.project.id);
      const memberIds = new Set(members.map(m => m.id));
      validMentions = mentions.filter(id => memberIds.has(Number(id))).map(Number);
    }

    const id = createAnnotation(
      result.text.id,
      req.user.id,
      parent.anchor_type,
      parent.anchor_data,
      body.trim(),
      parent.id,
      validMentions
    );

    // Notify parent comment author of the reply
    try { notifyCommentReply(parent, body.trim(), req.user.id, result.text.id, result.text.name); } catch (e) { console.error('Reply notification error:', e.message); }

    // Notify mentioned users
    if (validMentions.length > 0) {
      try { notifyMention(validMentions, body.trim(), req.user.id, result.text.id, result.text.name); } catch (e) { console.error('Mention notification error:', e.message); }
    }

    const reply = getAnnotationById(id);
    res.status(201).json({ annotation: reply });
  } catch (err) {
    console.error('POST /texts/:id/annotations/:annotId/replies error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

export default router;
