import { getUserTokenUsage, getUserById } from '../db.js';

export function checkTokenQuota(req, res, next) {
  try {
    const user = getUserById(req.user.id);
    if (!user) return res.status(401).json({ error: 'Not authenticated.' });

    const usage = getUserTokenUsage(req.user.id);
    if (usage >= user.token_allowance) {
      return res.status(429).json({
        error: 'Token allowance exceeded. Contact an admin for more.',
        usage,
        allowance: user.token_allowance,
      });
    }
    next();
  } catch (err) {
    console.error('Token quota check error:', err);
    next(); // fail open — don't block requests on quota check errors
  }
}
