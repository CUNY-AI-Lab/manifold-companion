// ---------------------------------------------------------------------------
// Project share routes  —  mounted at /api/projects/:projectId/shares
// ---------------------------------------------------------------------------

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { verifyProjectAccess } from '../middleware/access.js';
import { notifyProjectShared } from '../services/notify.js';
import {
  getUserByEmail,
  createProjectShare,
  getProjectShares,
  getProjectShareById,
  updateProjectShareRole,
  deleteProjectShareById,
} from '../db.js';

const router = Router({ mergeParams: true });

router.use(requireAuth);

// ---- GET / — list shares (owner only) ------------------------------------
router.get('/', (req, res) => {
  try {
    const result = verifyProjectAccess(Number(req.params.projectId), req.user.id, 'owner');
    if (result.error) return res.status(result.status).json({ error: result.error });

    const shares = getProjectShares(result.project.id);
    res.json({ shares });
  } catch (err) {
    console.error('GET /shares error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- POST / — add share (owner only) ------------------------------------
router.post('/', (req, res) => {
  try {
    const result = verifyProjectAccess(Number(req.params.projectId), req.user.id, 'owner');
    if (result.error) return res.status(result.status).json({ error: result.error });

    const { email, role } = req.body || {};
    if (!email || !email.trim()) {
      return res.status(400).json({ error: 'Email is required.' });
    }
    if (role && !['viewer', 'editor'].includes(role)) {
      return res.status(400).json({ error: 'Role must be viewer or editor.' });
    }

    const targetUser = getUserByEmail(email.toLowerCase().trim());
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found.' });
    }
    if (targetUser.id === req.user.id) {
      return res.status(400).json({ error: 'Cannot share with yourself.' });
    }

    try {
      const shareId = createProjectShare(result.project.id, targetUser.id, role || 'viewer');

      // Notify the shared user
      try {
        notifyProjectShared(result.project.id, result.project.name, targetUser.id, role || 'viewer', req.user.id);
      } catch (e) { console.error('Share notification error:', e.message); }

      res.status(201).json({ id: shareId, user_id: targetUser.id, email: targetUser.email, role: role || 'viewer' });
    } catch (err) {
      if (err.message?.includes('UNIQUE constraint')) {
        return res.status(409).json({ error: 'Project is already shared with this user.' });
      }
      throw err;
    }
  } catch (err) {
    console.error('POST /shares error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- PUT /:shareId — update share role (owner only) ----------------------
router.put('/:shareId', (req, res) => {
  try {
    const result = verifyProjectAccess(Number(req.params.projectId), req.user.id, 'owner');
    if (result.error) return res.status(result.status).json({ error: result.error });

    const share = getProjectShareById(Number(req.params.shareId));
    if (!share || share.project_id !== result.project.id) {
      return res.status(404).json({ error: 'Share not found.' });
    }

    const { role } = req.body || {};
    if (!role || !['viewer', 'editor'].includes(role)) {
      return res.status(400).json({ error: 'Role must be viewer or editor.' });
    }

    updateProjectShareRole(result.project.id, share.user_id, role);
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /shares/:shareId error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- DELETE /:shareId — revoke share (owner only) ------------------------
router.delete('/:shareId', (req, res) => {
  try {
    const result = verifyProjectAccess(Number(req.params.projectId), req.user.id, 'owner');
    if (result.error) return res.status(result.status).json({ error: result.error });

    const share = getProjectShareById(Number(req.params.shareId));
    if (!share || share.project_id !== result.project.id) {
      return res.status(404).json({ error: 'Share not found.' });
    }

    deleteProjectShareById(share.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /shares/:shareId error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

export default router;
