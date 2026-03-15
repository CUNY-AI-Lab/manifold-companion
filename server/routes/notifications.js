// ---------------------------------------------------------------------------
// Notification routes — mounted at /api/notifications
// ---------------------------------------------------------------------------

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  getNotifications,
  getUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
  getNotificationPreferences,
  updateNotificationPreferences,
} from '../db.js';

const router = Router();
router.use(requireAuth);

// ---- GET / — list notifications -------------------------------------------
router.get('/', (req, res) => {
  try {
    const includeRead = req.query.all === '1';
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const notifications = getNotifications(req.user.id, limit, includeRead);
    const unread = getUnreadCount(req.user.id);
    res.json({ notifications, unread });
  } catch (err) {
    console.error('GET /notifications error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- GET /unread-count — just the count -----------------------------------
router.get('/unread-count', (req, res) => {
  try {
    const unread = getUnreadCount(req.user.id);
    res.json({ unread });
  } catch (err) {
    console.error('GET /notifications/unread-count error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- POST /:id/read — mark one as read ------------------------------------
router.post('/:id/read', (req, res) => {
  try {
    markNotificationRead(Number(req.params.id), req.user.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /notifications/:id/read error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- POST /read-all — mark all as read ------------------------------------
router.post('/read-all', (req, res) => {
  try {
    markAllNotificationsRead(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /notifications/read-all error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- GET /preferences — get notification preferences ----------------------
router.get('/preferences', (req, res) => {
  try {
    const prefs = getNotificationPreferences(req.user.id);
    res.json({ preferences: prefs });
  } catch (err) {
    console.error('GET /notifications/preferences error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- PUT /preferences — update notification preferences -------------------
router.put('/preferences', (req, res) => {
  try {
    updateNotificationPreferences(req.user.id, req.body || {});
    const prefs = getNotificationPreferences(req.user.id);
    res.json({ preferences: prefs });
  } catch (err) {
    console.error('PUT /notifications/preferences error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

export default router;
