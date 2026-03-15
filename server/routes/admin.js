// ---------------------------------------------------------------------------
// Admin routes  —  mounted at /api/admin
// ---------------------------------------------------------------------------

import { Router } from 'express';
import { rmSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, createReadStream } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import bcrypt from 'bcrypt';
import { requireAdmin } from '../middleware/auth.js';
import { validatePassword } from '../middleware/security.js';
import { sanitizeFilename } from '../middleware/security.js';
import { notifyAccountApproved } from '../services/notify.js';
import {
  getAllUsers,
  getUserById,
  getUserByEmail,
  updateUserStatus,
  updateUserRole,
  updateUserDisplayName,
  updateUserTokenAllowance,
  resetUserTokenUsage,
  bulkUpdateUserStatus,
  deleteUser,
  createUser,
  getProjectsByUser,
  getUsageStats,
  getUserTokenUsage,
  getDatabase,
  BCRYPT_ROUNDS,
} from '../db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

// ---- POST /users — create a new user (admin) -----------------------------
router.post('/users', async (req, res) => {
  try {
    const { email, password, role, status, name } = req.body || {};

    if (!email || !email.trim()) {
      return res.status(400).json({ error: 'Email is required.' });
    }
    if (!validatePassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    // Check for existing user
    const existing = getUserByEmail(email.trim().toLowerCase());
    if (existing) {
      return res.status(409).json({ error: 'A user with that email already exists.' });
    }

    const validRoles = ['user', 'admin'];
    const validStatuses = ['pending', 'approved', 'disabled'];
    const userRole = validRoles.includes(role) ? role : 'user';
    const userStatus = validStatuses.includes(status) ? status : 'approved';

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const displayName = name ? String(name).trim().slice(0, 100) : null;
    const userId = createUser(email.trim().toLowerCase(), hash, displayName);

    // Set role and status (createUser defaults to 'user' and 'pending')
    if (userRole !== 'user') {
      updateUserRole(userId, userRole);
    }
    updateUserStatus(userId, userStatus);

    const created = getUserById(userId);
    res.status(201).json({
      id: created.id,
      email: created.email,
      role: created.role,
      status: created.status,
      created_at: created.created_at,
    });
  } catch (err) {
    console.error('POST /admin/users error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- PUT /users/bulk-status — bulk approve/disable users ------------------
// NOTE: Must come before /users/:id routes to avoid matching "bulk-status" as :id
router.put('/users/bulk-status', (req, res) => {
  try {
    const { userIds, status } = req.body || {};

    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ error: 'userIds array is required.' });
    }
    if (!status || !['approved', 'disabled'].includes(status)) {
      return res.status(400).json({ error: "Status must be 'approved' or 'disabled'." });
    }

    // Filter out self
    const ids = userIds.map(Number).filter((id) => id !== req.user.id && Number.isFinite(id));
    if (ids.length === 0) {
      return res.status(400).json({ error: 'No valid user IDs to update.' });
    }

    bulkUpdateUserStatus(ids, status);

    // Notify each user if bulk-approved
    if (status === 'approved') {
      for (const uid of ids) {
        try { notifyAccountApproved(uid); } catch (e) { console.error('Bulk approval notification error:', e.message); }
      }
    }

    res.json({ updated: ids.length });
  } catch (err) {
    console.error('PUT /users/bulk-status error:', err);
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

    // Notify user if their account was just approved
    if (status === 'approved' && target.status !== 'approved') {
      try { notifyAccountApproved(targetId); } catch (e) { console.error('Approval notification error:', e.message); }
    }

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

    // Prevent deleting the last admin
    if (target.role === 'admin') {
      const admins = getAllUsers().filter((u) => u.role === 'admin');
      if (admins.length <= 1) {
        return res.status(400).json({ error: 'Cannot delete the only admin account.' });
      }
    }

    // Delete user from database
    deleteUser(targetId);

    // Remove user's project files from disk
    const dataDir = join(__dirname, '..', '..', 'data', String(targetId));
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

// ---- PUT /users/:id/name — update display name ---------------------------
router.put('/users/:id/name', (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const target = getUserById(targetId);
    if (!target) return res.status(404).json({ error: 'User not found.' });

    const { name } = req.body || {};
    const trimmed = String(name || '').trim().slice(0, 100);
    updateUserDisplayName(targetId, trimmed || null);
    res.json({ ok: true, display_name: trimmed || null });
  } catch (err) {
    console.error('PUT /users/:id/name error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- PUT /users/:id/token-allowance — set token cap -----------------------
router.put('/users/:id/token-allowance', (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const target = getUserById(targetId);
    if (!target) return res.status(404).json({ error: 'User not found.' });

    const { allowance } = req.body || {};
    if (!Number.isFinite(allowance) || allowance < 0) {
      return res.status(400).json({ error: 'allowance must be a non-negative number.' });
    }

    updateUserTokenAllowance(targetId, Math.round(allowance));
    res.json({ ok: true, token_allowance: Math.round(allowance) });
  } catch (err) {
    console.error('PUT /users/:id/token-allowance error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- POST /users/:id/reset-usage — reset token usage counter ---------------
router.post('/users/:id/reset-usage', (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const target = getUserById(targetId);
    if (!target) return res.status(404).json({ error: 'User not found.' });

    resetUserTokenUsage(targetId);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /users/:id/reset-usage error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- GET /usage — usage dashboard stats -----------------------------------
router.get('/usage', (req, res) => {
  try {
    const days = Math.min(Number(req.query.days) || 30, 365);
    const stats = getUsageStats(days);

    // Add current token usage for each user
    stats.byUser = stats.byUser.map((u) => ({
      ...u,
      current_usage: getUserTokenUsage(u.user_id),
    }));

    res.json(stats);
  } catch (err) {
    console.error('GET /usage error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- POST /backups — create a backup -------------------------------------
router.post('/backups', (req, res) => {
  try {
    const dataDir = join(__dirname, '..', '..', 'data');
    const backupDir = join(dataDir, 'backups');
    mkdirSync(backupDir, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dbBackupPath = join(backupDir, `manifold-${ts}.db`);

    // Use better-sqlite3's backup API for safe hot copy
    const database = getDatabase();
    database.backup(dbBackupPath);

    // Tar the data directory (excluding backups) using execFileSync for safety
    const tarName = `backup-${ts}.tar.gz`;
    const tarPath = join(backupDir, tarName);
    execFileSync('tar', ['czf', tarPath, '--exclude=backups', '-C', join(dataDir, '..'), 'data'], {
      timeout: 120000,
    });

    // Clean up the .db copy (it's inside the tar now)
    try { unlinkSync(dbBackupPath); } catch { /* ignore */ }

    const info = statSync(tarPath);
    res.json({
      filename: tarName,
      size: info.size,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('POST /backups error:', err);
    res.status(500).json({ error: 'Backup failed: ' + err.message });
  }
});

// ---- GET /backups — list available backups --------------------------------
router.get('/backups', (req, res) => {
  try {
    const backupDir = join(__dirname, '..', '..', 'data', 'backups');
    if (!existsSync(backupDir)) return res.json({ backups: [] });

    const files = readdirSync(backupDir)
      .filter((f) => f.endsWith('.tar.gz'))
      .map((f) => {
        const info = statSync(join(backupDir, f));
        return { filename: f, size: info.size, created_at: info.mtime.toISOString() };
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at));

    res.json({ backups: files });
  } catch (err) {
    console.error('GET /backups error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- GET /backups/:filename — download a backup ---------------------------
router.get('/backups/:filename', (req, res) => {
  try {
    const filename = sanitizeFilename(req.params.filename);
    if (!filename.endsWith('.tar.gz')) {
      return res.status(400).json({ error: 'Invalid backup filename.' });
    }

    const filePath = join(__dirname, '..', '..', 'data', 'backups', filename);
    if (!existsSync(filePath)) {
      return res.status(404).json({ error: 'Backup not found.' });
    }

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/gzip');
    createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error('GET /backups/:filename error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- DELETE /backups/:filename — delete a backup --------------------------
router.delete('/backups/:filename', (req, res) => {
  try {
    const filename = sanitizeFilename(req.params.filename);
    if (!filename.endsWith('.tar.gz')) {
      return res.status(400).json({ error: 'Invalid backup filename.' });
    }

    const filePath = join(__dirname, '..', '..', 'data', 'backups', filename);
    if (!existsSync(filePath)) {
      return res.status(404).json({ error: 'Backup not found.' });
    }

    unlinkSync(filePath);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /backups/:filename error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

export default router;
