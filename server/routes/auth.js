// ---------------------------------------------------------------------------
// Auth routes  —  mounted at /api/auth
// ---------------------------------------------------------------------------

import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { createUser, getUserByEmail, getUserById, updateUserLogin, updateUserPassword, updateUserDisplayName, updateUserThemePreference, updateUserOnboarded, getUserTokenUsage, setPasswordResetToken, getUserByResetToken, clearPasswordResetToken, BCRYPT_ROUNDS, getNotificationPreferences, updateNotificationPreferences } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { validateEmail, validatePassword } from '../middleware/security.js';
import { sendPasswordResetEmail } from '../services/email.js';
import { calculateUserStorage } from '../services/storage.js';

const router = Router();

// ---- POST /register -------------------------------------------------------
router.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body || {};

    // Validate inputs
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    if (!validateEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format.' });
    }

    if (!validatePassword(password)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    // Check for existing user
    const existing = getUserByEmail(email.toLowerCase().trim());
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    // Hash password and create user
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const displayName = name ? String(name).trim().slice(0, 100) : null;
    const userId = createUser(email.toLowerCase().trim(), passwordHash, displayName);

    res.status(201).json({
      message: 'Account created. Awaiting admin approval.',
    });
  } catch (err) {
    console.error('POST /register error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- POST /login ----------------------------------------------------------
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const user = getUserByEmail(email.toLowerCase().trim());
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Check account status
    if (user.status === 'pending') {
      return res.status(403).json({ error: 'Your account is pending admin approval.' });
    }

    if (user.status === 'disabled') {
      return res.status(403).json({ error: 'Your account has been disabled.' });
    }

    // Status is 'approved' — regenerate session to prevent fixation
    req.session.regenerate((err) => {
      if (err) {
        console.error('Session regenerate error:', err);
        return res.status(500).json({ error: 'Internal server error.' });
      }
      req.session.userId = user.id;
      updateUserLogin(user.id);

      res.json({
        id: user.id,
        email: user.email,
        display_name: user.display_name || null,
        role: user.role,
        status: user.status,
      });
    });
  } catch (err) {
    console.error('POST /login error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- POST /logout ---------------------------------------------------------
router.post('/logout', (req, res) => {
  try {
    req.session.destroy((err) => {
      if (err) {
        console.error('Session destroy error:', err);
        return res.status(500).json({ error: 'Failed to log out.' });
      }
      res.json({ ok: true });
    });
  } catch (err) {
    console.error('POST /logout error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- GET /me --------------------------------------------------------------
router.get('/me', async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }

    const user = getUserById(userId);
    if (!user) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }

    // [LOW-4] If account was disabled since login, destroy session
    if (user.status !== 'approved') {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Account is not approved.' });
    }

    const tokenUsage = getUserTokenUsage(user.id);
    const storageUsed = await calculateUserStorage(user.id);
    res.json({
      id: user.id,
      email: user.email,
      display_name: user.display_name || null,
      role: user.role,
      status: user.status,
      token_allowance: user.token_allowance,
      token_usage: tokenUsage,
      theme_preference: user.theme_preference || 'system',
      onboarded: user.onboarded || 0,
      storage_used: storageUsed,
    });
  } catch (err) {
    console.error('GET /me error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- POST /change-password — change password for authenticated user ------
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new passwords are required.' });
    }

    if (!validatePassword(newPassword)) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }

    const user = getUserById(req.user.id);
    if (!user) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }

    const match = await bcrypt.compare(currentPassword, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    updateUserPassword(user.id, newHash);

    res.json({ message: 'Password changed successfully.' });
  } catch (err) {
    console.error('POST /change-password error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- PUT /profile — update display name and/or theme for authenticated user
router.put('/profile', requireAuth, (req, res) => {
  try {
    const { display_name, theme_preference, onboarded } = req.body || {};
    if (display_name === undefined && theme_preference === undefined && onboarded === undefined) {
      return res.status(400).json({ error: 'display_name, theme_preference, or onboarded is required.' });
    }

    const result = {};

    if (display_name !== undefined) {
      const trimmed = String(display_name || '').trim().slice(0, 100);
      updateUserDisplayName(req.user.id, trimmed || null);
      result.display_name = trimmed || null;
    }

    if (theme_preference !== undefined) {
      const VALID_THEMES = ['system', 'light', 'dark'];
      if (!VALID_THEMES.includes(theme_preference)) {
        return res.status(400).json({ error: "theme_preference must be 'system', 'light', or 'dark'." });
      }
      updateUserThemePreference(req.user.id, theme_preference);
      result.theme_preference = theme_preference;
    }

    if (onboarded !== undefined) {
      updateUserOnboarded(req.user.id, onboarded);
      result.onboarded = onboarded ? 1 : 0;
    }

    res.json(result);
  } catch (err) {
    console.error('PUT /profile error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- POST /forgot-password ------------------------------------------------
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    // Always return success to prevent email enumeration
    const user = getUserByEmail(email.toLowerCase().trim());
    if (user && user.status === 'approved') {
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 3600000).toISOString(); // 1 hour
      setPasswordResetToken(email.toLowerCase().trim(), token, expiresAt);

      const APP_URL = process.env.APP_URL || 'http://localhost:5173';
      const resetUrl = `${APP_URL}/reset-password?token=${token}`;
      await sendPasswordResetEmail(user.email, resetUrl);
    }

    res.json({ message: 'If an account exists with that email, a reset link has been sent.' });
  } catch (err) {
    console.error('POST /forgot-password error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- POST /reset-password -------------------------------------------------
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) return res.status(400).json({ error: 'Token and password are required.' });
    if (!validatePassword(password)) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const user = getUserByResetToken(token);
    if (!user) return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });

    const newHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    updateUserPassword(user.id, newHash);
    clearPasswordResetToken(user.id);

    res.json({ message: 'Password has been reset. You can now log in.' });
  } catch (err) {
    console.error('POST /reset-password error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- GET /settings — return notification preferences ---------------------
router.get('/settings', requireAuth, (req, res) => {
  try {
    const prefs = getNotificationPreferences(req.user.id);
    res.json({
      notification_preferences: {
        email_ocr_complete: prefs.email_ocr_complete === 1,
        email_project_shared: prefs.email_project_shared === 1,
        email_comment_reply: prefs.email_comment_reply === 1,
        email_comment_mention: prefs.email_comment_mention === 1,
      },
    });
  } catch (err) {
    console.error('GET /settings error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ---- PUT /settings — update notification preferences (partial) -----------
router.put('/settings', requireAuth, (req, res) => {
  try {
    const { notification_preferences } = req.body || {};
    if (!notification_preferences || typeof notification_preferences !== 'object') {
      return res.status(400).json({ error: 'notification_preferences object is required.' });
    }
    updateNotificationPreferences(req.user.id, notification_preferences);
    const prefs = getNotificationPreferences(req.user.id);
    res.json({
      notification_preferences: {
        email_ocr_complete: prefs.email_ocr_complete === 1,
        email_project_shared: prefs.email_project_shared === 1,
        email_comment_reply: prefs.email_comment_reply === 1,
        email_comment_mention: prefs.email_comment_mention === 1,
      },
    });
  } catch (err) {
    console.error('PUT /settings error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

export default router;
