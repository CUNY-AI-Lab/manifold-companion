// ---------------------------------------------------------------------------
// Rate limiting middleware — shared across route files
// ---------------------------------------------------------------------------

import rateLimit from 'express-rate-limit';

// Rate limiting on expensive AI endpoints (OCR, summary, translation)
export const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: 50,  // 50 AI requests per hour per user
  keyGenerator: (req) => String(req.session?.userId || req.ip),
  message: { error: 'Too many AI requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiting on upload endpoints
export const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,  // 30 upload requests per 15 min per user
  keyGenerator: (req) => String(req.session?.userId || req.ip),
  message: { error: 'Too many upload requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
