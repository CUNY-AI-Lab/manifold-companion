import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import connectSqlite3 from 'connect-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

import { initDatabase } from './db.js';
import { DEFAULT_OCR_PROMPT } from './services/bedrock.js';
import { requireAuth } from './middleware/auth.js';
import { aiLimiter, uploadLimiter } from './middleware/rateLimits.js';
import { csrfCheck } from './middleware/csrf.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import projectRoutes from './routes/projects.js';
import textRoutes from './routes/texts.js';
import ocrRoutes from './routes/ocr.js';
import llmRoutes from './routes/llm.js';
import exportRoutes from './routes/export.js';
import { startCleanupCron } from './services/cleanup.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || join(__dirname, '..', 'data');
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// [MED-4] Startup check: refuse to run with weak session secret in production
if (IS_PRODUCTION && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  console.error('FATAL: SESSION_SECRET must be set to a random string of at least 32 characters in production.');
  process.exit(1);
}

// Trust reverse proxy (Nginx) for secure cookies and rate limiting
if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

// Initialize database
initDatabase(DATA_DIR);

// [LOW-1] Security middleware — removed 'unsafe-inline' from scriptSrc in production
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: IS_PRODUCTION ? ["'self'"] : ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
    }
  },
  crossOriginEmbedderPolicy: false,  // Allow loading images
}));

// [MED-2] Body parsing — reduced from 50mb to 200kb (uploads use multer, not JSON)
app.use(express.json({ limit: '200kb' }));

// Session configuration with SQLite store
const SQLiteStore = connectSqlite3(session);

app.use(session({
  store: new SQLiteStore({
    dir: DATA_DIR,
    db: 'sessions.db',
  }),
  name: 'mc.sid',
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    // [MED-3] Secure by default in production
    secure: IS_PRODUCTION || process.env.COOKIE_SECURE === 'true',
    maxAge: 24 * 60 * 60 * 1000,  // 24 hours
  }
}));

// Rate limiting on auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 10,  // 10 attempts
  message: { error: 'Too many attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/change-password', authLimiter);

// [MED-5] CSRF protection for all API state-changing requests
app.use('/api', csrfCheck);

// [CRIT-3] Moved /api/defaults behind auth — no longer leaks model info to unauthenticated users
app.get('/api/defaults', requireAuth, (req, res) => {
  res.json({
    prompt: DEFAULT_OCR_PROMPT,
    model: process.env.BEDROCK_OCR_MODEL || 'qwen.qwen3-vl-235b-a22b',
    temperature: 0.1,
    max_tokens: 4096
  });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api', textRoutes);
app.use('/api', ocrRoutes);
app.use('/api', llmRoutes);
app.use('/api', exportRoutes);

// Serve React app in production
const clientDist = join(__dirname, '..', 'client', 'dist');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  // SPA fallback -- serve index.html for any non-API route
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(join(clientDist, 'index.html'));
    }
  });
}

// Start cleanup cron
startCleanupCron();

// Start server
app.listen(PORT, () => {
  console.log(`\n  CAIL OCR Manifold Companion`);
  console.log(`  ──────────────────────────`);
  console.log(`  Running at http://localhost:${PORT}`);
  console.log(`  Data directory: ${DATA_DIR}\n`);
});
