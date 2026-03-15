// ---------------------------------------------------------------------------
// Authentication & authorisation middleware
// ---------------------------------------------------------------------------

import { getUserById } from '../db.js';

/**
 * Require an authenticated, approved user.
 *
 * Checks `req.session.userId`, loads the user row, attaches it to `req.user`,
 * and verifies the account status is 'approved'.  Returns 401 when the
 * session is missing or the account is not approved.
 */
export async function requireAuth(req, res, next) {
  try {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    const user = getUserById(userId);
    if (!user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    if (user.status !== 'approved') {
      return res.status(401).json({ error: 'Account is not approved.' });
    }

    // Attach the user object (without the password hash) for downstream handlers
    req.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
      storage_used_bytes: user.storage_used_bytes,
      token_allowance: user.token_allowance,
      last_login_at: user.last_login_at,
      created_at: user.created_at,
    };

    next();
  } catch (err) {
    console.error('requireAuth error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
}

/**
 * Require an admin user.
 *
 * Runs `requireAuth` first, then checks that the authenticated user has the
 * 'admin' role.  Returns 403 if the user is not an admin.
 */
export async function requireAdmin(req, res, next) {
  // Delegate to requireAuth; if it responds (401), we stop here.
  requireAuth(req, res, (err) => {
    if (err) return next(err);

    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required.' });
    }

    next();
  });
}
