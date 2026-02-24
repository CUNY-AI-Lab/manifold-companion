// ---------------------------------------------------------------------------
// Auth routes  —  mounted at /api/auth
// ---------------------------------------------------------------------------

import { Router } from 'express';
import bcrypt from 'bcrypt';
import { createUser, getUserByEmail, getUserById, updateUserLogin } from '../db.js';
import { validateEmail, validatePassword } from '../middleware/security.js';

const router = Router();

// ---- POST /register -------------------------------------------------------
router.post('/register', async (req, res) => {
  try {
    const { email, password } = req.body || {};

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
    const passwordHash = await bcrypt.hash(password, 12);
    const userId = createUser(email.toLowerCase().trim(), passwordHash);

    res.status(201).json({
      message: 'Account created. Awaiting admin approval.',
      userId,
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

    // Status is 'approved' — set up the session
    req.session.userId = user.id;
    updateUserLogin(user.id);

    res.json({
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
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
router.get('/me', (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }

    const user = getUserById(userId);
    if (!user) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }

    res.json({
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
    });
  } catch (err) {
    console.error('GET /me error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

export default router;
