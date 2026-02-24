# CAIL OCR Manifold Companion — Design Document

**Date:** 2026-02-24
**Status:** Approved

## Overview

A multi-user OCR processing platform that lets users create projects, upload document scans (images or PDFs), run OCR via AWS Bedrock, edit results, generate summaries and translations, and export Manifold-compatible packages. Built as a successor to the single-purpose Lalli Archive tool.

## Architecture

**Approach:** Express.js API backend + React/Vite SPA frontend (separate packages in a monorepo).

### Tech Stack

- **Backend:** Node.js, Express.js, better-sqlite3 (WAL mode), Sharp, Multer, Archiver, bcrypt, express-session
- **Frontend:** React 18, Vite, Tailwind CSS, React Router, marked.js, DOMPurify, pdf.js (browser-side PDF splitting)
- **AI:** AWS Bedrock — QWEN vision (us-east-1) for OCR, Claude Sonnet for summaries/translations
- **Deployment target:** Debian server

### Project Structure

```
manifold-companion/
├── server/
│   ├── index.js                # Express entry, middleware, static serving
│   ├── db.js                   # SQLite schema + queries
│   ├── routes/
│   │   ├── auth.js             # Login/logout/register
│   │   ├── projects.js         # CRUD projects
│   │   ├── texts.js            # CRUD texts within projects
│   │   ├── ocr.js              # OCR processing (SSE)
│   │   ├── llm.js              # Summaries/translations via Bedrock
│   │   ├── export.js           # Manifold ZIP export
│   │   └── admin.js            # User management
│   ├── services/
│   │   ├── bedrock.js          # AWS Bedrock client
│   │   ├── storage.js          # Per-user quota enforcement
│   │   └── cleanup.js          # 90-day project expiry cron
│   └── middleware/
│       ├── auth.js             # requireAuth, requireAdmin
│       └── upload.js           # Multer config + validation
├── client/
│   ├── index.html
│   ├── src/
│   │   ├── main.jsx
│   │   ├── App.jsx             # Router + layout shell
│   │   ├── api/                # API client helpers
│   │   ├── components/         # Reusable UI (Header, Footer, Card, etc.)
│   │   ├── pages/              # Route pages
│   │   └── styles/
│   ├── vite.config.js
│   ├── tailwind.config.js
│   └── package.json
├── package.json                # Root workspaces
├── .env                        # Bedrock credentials (server-only)
└── docs/
```

## Data Model

### Users

```
users
  id INTEGER PRIMARY KEY
  email TEXT UNIQUE NOT NULL        -- serves as username
  password_hash TEXT NOT NULL
  role TEXT DEFAULT 'user'          -- 'admin' | 'user'
  status TEXT DEFAULT 'pending'     -- 'pending' | 'approved' | 'disabled'
  storage_used_bytes INTEGER DEFAULT 0
  last_login_at TEXT
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
```

### Projects

```
projects
  id INTEGER PRIMARY KEY
  user_id INTEGER REFERENCES users(id)
  name TEXT NOT NULL
  description TEXT
  default_language TEXT DEFAULT 'en'
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  expires_at TEXT                    -- created_at + 90 days
```

### Texts

```
texts
  id INTEGER PRIMARY KEY
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE
  name TEXT NOT NULL
  status TEXT DEFAULT 'pending'     -- pending | processing | ocrd | reviewed
  summary TEXT
  translation TEXT
  source_language TEXT
  target_language TEXT
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
```

### Pages

```
pages
  id INTEGER PRIMARY KEY
  text_id INTEGER REFERENCES texts(id) ON DELETE CASCADE
  filename TEXT NOT NULL
  ocr_text TEXT
  page_number INTEGER
  processed_at TEXT
```

### Metadata (Dublin Core)

```
metadata
  text_id INTEGER UNIQUE REFERENCES texts(id) ON DELETE CASCADE
  dc_title, dc_creator, dc_subject, dc_description,
  dc_date, dc_type, dc_format, dc_language,
  dc_source, dc_rights, dc_coverage, dc_contributor,
  dc_publisher, dc_relation, dc_identifier
  updated_at TEXT
```

### Settings (per-text OCR config)

```
settings
  text_id INTEGER UNIQUE REFERENCES texts(id) ON DELETE CASCADE
  prompt TEXT
  model TEXT
  temperature REAL DEFAULT 0.1
  max_tokens INTEGER DEFAULT 4096
  updated_at TEXT
```

## User Management

- **Email = username.** Login is email + password.
- **Registration:** User submits email + password → account created as `pending`.
- **Admin approval required:** Only `status: approved` users can log in.
- **Admin panel** at `/admin`:
  - View all users (email, status, storage used, project count, last login)
  - Approve/reject/disable accounts
  - Delete users and their data
- **Admin seed:** On first run, create admin account: email `<REDACTED_EMAIL>`, password `<REDACTED>`, role `admin`, status `approved`.
- **Sessions:** express-session with SQLite store, httpOnly + secure + sameSite cookies.
- **Rate limiting:** 5 login attempts per 15 minutes per IP.

## Storage & Lifecycle

- **50MB quota per user.** Enforced server-side on upload. `users.storage_used_bytes` updated on upload/delete.
- **90-day project expiry.** Daily cron checks `projects.expires_at`, deletes expired projects and reclaims storage.
- **File storage:** `data/{user_id}/{project_id}/{text_id}/` for uploaded images.

## OCR Pipeline

1. **Browser-side preprocessing:**
   - PDF uploads: pdf.js renders each page to canvas → JPEG export → individual page uploads
   - Large images (>3.5MB): Canvas resize to max 2048px, JPEG re-encode at 85% quality, progressive quality reduction if still over limit
   - Progress indicator shown during client-side processing

2. **Upload:** Processed images sent to server via multipart POST

3. **Server-side OCR (SSE stream):**
   - Smart rotation via Sharp (EXIF orientation → dimension fallback)
   - Base64 encode
   - Call Bedrock InvokeModel with QWEN vision (us-east-1)
   - Generic OCR prompt (no Italian-specific rules): handle bleed-through, join line breaks, flag unclear text, preserve markdown formatting
   - Store result in `pages.ocr_text`
   - Stream progress events to client

4. **Post-OCR:** Compile full text from all pages, optionally auto-generate summary

## LLM Integration (Bedrock)

- **OCR:** QWEN vision model, max 4096 tokens, temperature 0.1
- **Summary:** Claude Sonnet, ~200 words, temperature 0.3
- **Translation:** Claude Sonnet, chunked at ~10KB boundaries, temperature 0.3
- **All optional:** Summaries and translations are manually editable. LLM generation is a convenience, not a requirement.
- **Credentials:** Base64-encoded API key in `.env`, decoded server-side. Never exposed to client.

## Translation

- Default project language: English
- Translation dropdown: English, Spanish, French, German, Italian, Portuguese, Chinese, Japanese, Korean, Arabic
- Source language auto-detected or set per text
- Chunked translation for long texts (same approach as Lalli)
- Fully editable — users can write translations manually

## Export

- **Manifold-compatible ZIP** containing:
  - `manifest.yml` — Metadata + TOC structure
  - XHTML content files per text
  - Referenced images
- No full site generation. No deployment features.

## UI Design

### Styling

Tailwind CSS with CUNY AI Lab design tokens:

- **Accent palette:** #1D3A83 (navy), #3B73E6 (bright blue), #2FB8D6 (teal), #2A6FB8 (azure), #0F172A (text)
- **Background:** #FAFCF8 (cream)
- **Display font:** Outfit (headings)
- **Body font:** Inter
- **Components:** Glassmorphic header, rounded cards (rounded-2xl), pill buttons (rounded-full), hover elevation effects
- **Manifold logo** in header

### Footer

Replicates CUNY AI Lab footer: dark charcoal (#333) background with noise texture, copyright, partner logos (GC CUNY, GCDI, TLC, Mina Rees Library, ASHP) with opacity hover, plus Manifold logo.

### Pages

1. **Login / Register** — Centered card, email + password
2. **Dashboard** — Project cards grid (name, text count, storage, expiry)
3. **Project View** — Text list, upload area, project settings
4. **Text Detail** — Tabs: Pages (thumbnails), Full Text (editable markdown + language toggle), Review (side-by-side), Details (summary, translation, metadata)
5. **Admin Panel** — User table, approve/reject/disable, storage stats
6. **Export** — Select texts → generate Manifold ZIP

## Security

- `helmet` middleware (CSP, HSTS, X-Frame-Options)
- CSRF tokens via `csurf`
- Rate limiting on auth endpoints
- bcrypt password hashing (12 salt rounds)
- Secure session cookies (httpOnly, secure, sameSite: strict)
- Input validation on all endpoints
- File upload whitelist: jpg, jpeg, png, tiff, bmp, webp (PDFs processed client-side into images)
- Storage quota enforcement server-side
- Parameterized SQL queries (better-sqlite3 prepared statements)
- React auto-escaping + DOMPurify for markdown
- Bedrock credentials server-only

## Test Data

Port 2 Lalli texts as sample data for testing (e.g., "Gli spiriti in casa" and "La fuga") within a "Lalli Archive" demo project.
