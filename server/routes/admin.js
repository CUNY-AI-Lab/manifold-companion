// ---------------------------------------------------------------------------
// Admin routes  —  mounted at /api/admin
// ---------------------------------------------------------------------------

import { Router } from 'express';
import { rmSync } from 'fs';
import { join } from 'path';
import { requireAdmin } from '../middleware/auth.js';
import {
  getAllUsers,
  getUserById,
  updateUserStatus,
  deleteUser,
  getProjectsByUser,
} from '../db.js';

const router = Router();

// All admin routes require admin role
router.use(requireAdmin);

// ---- GET /users -----------------------------------------------------------
router.get('/users', (req, res) => {
  try {
    const users = getAllUsers();

    // Enrich each user with project count
    const enriched = users.map((user) => {
      const projects = getProjectsByUser(user.id);
      return {
        ...user,
        project_count: projects.length,
      };
    });

    res.json(enriched);
  } catch (err) {
    console.error('GET /users error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- PUT /users/:id/status -----------------------------------------------
router.put('/users/:id/status', (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const { status } = req.body || {};

    // Validate status value
    if (!status || !['approved', 'disabled'].includes(status)) {
      return res.status(400).json({
        error: "Status must be 'approved' or 'disabled'.",
      });
    }

    // Cannot change own status
    if (targetId === req.user.id) {
      return res.status(400).json({ error: 'Cannot change your own status.' });
    }

    // Verify target user exists
    const target = getUserById(targetId);
    if (!target) {
      return res.status(404).json({ error: 'User not found.' });
    }

    updateUserStatus(targetId, status);

    // Return updated user
    const updated = getUserById(targetId);
    res.json({
      id: updated.id,
      email: updated.email,
      role: updated.role,
      status: updated.status,
      storage_used_bytes: updated.storage_used_bytes,
      last_login_at: updated.last_login_at,
      created_at: updated.created_at,
    });
  } catch (err) {
    console.error('PUT /users/:id/status error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- DELETE /users/:id ----------------------------------------------------
router.delete('/users/:id', (req, res) => {
  try {
    const targetId = Number(req.params.id);

    // Cannot delete self
    if (targetId === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own account.' });
    }

    // Verify target user exists
    const target = getUserById(targetId);
    if (!target) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // Delete user from database
    deleteUser(targetId);

    // Remove user's project files from disk
    const dataDir = join(process.cwd(), 'data', String(targetId));
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch (fsErr) {
      // Non-fatal: directory may not exist
      console.warn(`Could not remove data dir for user ${targetId}:`, fsErr.message);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /users/:id error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

export default router;
