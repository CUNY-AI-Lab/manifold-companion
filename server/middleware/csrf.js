// ---------------------------------------------------------------------------
// CSRF protection via Origin/Referer header check for state-changing requests
// ---------------------------------------------------------------------------

/**
 * For state-changing HTTP methods (POST, PUT, DELETE, PATCH), verify that the
 * Origin or Referer header matches the expected host. This blocks cross-site
 * form submissions and fetch requests from other origins.
 */
export function csrfCheck(req, res, next) {
  const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
  if (safeMethods.has(req.method)) {
    return next();
  }

  const origin = req.get('origin') || req.get('referer');
  if (!origin) {
    // No origin header — reject (browsers always send it for cross-origin requests)
    return res.status(403).json({ error: 'Forbidden: missing origin header.' });
  }

  try {
    const url = new URL(origin);
    const host = req.get('host');
    if (url.host !== host) {
      // Allow localhost-to-localhost in development (Vite proxy changes Host header)
      const isLocalDev = url.hostname === 'localhost' && host?.startsWith('localhost');
      if (!isLocalDev) {
        return res.status(403).json({ error: 'Forbidden: cross-origin request.' });
      }
    }
  } catch {
    return res.status(403).json({ error: 'Forbidden: invalid origin header.' });
  }

  next();
}
