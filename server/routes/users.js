import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { searchUsers } from '../db.js';

const router = Router();
router.use(requireAuth);

// GET /api/users/search?q=... — autocomplete for share panel
router.get('/search', (req, res) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 50);
    if (q.length < 2) {
      return res.json({ users: [] });
    }
    const users = searchUsers(q);
    res.json({ users });
  } catch (err) {
    console.error('GET /users/search error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

export default router;
