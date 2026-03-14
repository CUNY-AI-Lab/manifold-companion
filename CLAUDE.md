# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Multi-user document-processing platform with two first-class workflows:

- **Image to Markdown** -- upload images or rasterized PDF pages, run OCR via Bedrock, review/edit markdown, and export for Manifold
- **PDF to HTML** -- upload a source PDF, render pages browser-side, parse each page with Bedrock vision, clean the assembled HTML with Bedrock text models, and edit/download the generated HTML

The app is an Express backend serving a React SPA, with SQLite for persistence and AWS Bedrock for AI-powered OCR and text processing.

## Dev Commands

```bash
npm install          # Install all workspace dependencies (run from root)
npm run dev          # Start both server and client in dev mode (concurrently)
npm run dev:server   # Start only the Express server with --watch
npm run dev:client   # Start only the Vite dev server
npm run build        # Build the client for production (outputs to client/dist/)
npm start            # Start the production server (serves client/dist/ statically)
```

There are no test or lint scripts configured.

## Monorepo Layout

- **Root** -- npm workspace orchestrator
- **`server/`** -- Express API (port 3000)
- **`client/`** -- React + Vite SPA (Vite proxies `/api` → localhost:3000 in dev)
- **`data/`** -- Runtime: SQLite DBs (`manifold.db`, `sessions.db`) and uploaded files (gitignored)
- **`docs/`** -- Design documents and plans

## Tech Stack

- **Backend**: Express 4, better-sqlite3, express-session (SQLite-backed), bcrypt, multer, sharp, helmet
- **Frontend**: React 18, React Router 6, Tailwind CSS 3, marked + DOMPurify, pdfjs-dist, KaTeX (client-side TeX rendering)
- **AI/OCR**: AWS Bedrock for OCR (`qwen.qwen3-vl-235b-a22b`) and text processing (`openai.gpt-oss-120b-1:0`); OpenRouter (Gemini 3 Flash) for PDF page parsing and HTML cleanup
- **Math**: temml (server-side TeX→MathML conversion at Manifold export time)
- **Database**: SQLite with WAL mode, foreign keys enabled

## Environment

Configuration via `.env` in project root (symlinked to `server/.env` because `dotenv/config` reads from cwd):

- `PORT` -- Server port (default 3000)
- `SESSION_SECRET` -- Express session secret (must be ≥32 chars in production or server exits)
- `AWS_REGION` -- AWS region for Bedrock
- `BEDROCK_OCR_MODEL` -- Vision model ID for OCR (currently `qwen.qwen3-vl-235b-a22b`)
- `BEDROCK_TEXT_MODEL` -- Text model ID for summaries/translations (currently `openai.gpt-oss-120b-1:0`)
- `OPENROUTER_API_KEY` -- API key for OpenRouter (used for PDF page parsing and HTML cleanup)
- `OPENROUTER_PDF_MODEL` -- OpenRouter model for PDF parsing (default `google/gemini-3-flash-preview`)
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` -- Seeds initial admin user at startup (idempotent; only creates if not exists)
- `TRUST_PROXY` -- Set `true` when behind Nginx (enables correct rate limiting and secure cookies)
- `COOKIE_SECURE` -- Set `true` for HTTPS deployments (auto-enabled in production)

## Architecture

### Server Middleware Chain (server/index.js)

Applied in order:
1. **Helmet** -- CSP (no `unsafe-inline` scripts in production), COEP disabled for images
2. **JSON body parser** -- 2 MB limit (HTML editing needs more headroom than the original 200 KB cap)
3. **Session** -- SQLite store, cookie name `mc.sid`, 24-hour TTL, `httpOnly`, `sameSite: 'lax'`
4. **Auth rate limiter** -- 10 req/15 min on `/api/auth/login`, `/api/auth/register`, and `/api/auth/change-password`
5. **CSRF check** (`middleware/csrf.js`) -- validates Origin/Referer header on all non-GET `/api` requests
6. Route handlers

### Security Middleware

- **`middleware/auth.js`**: `requireAuth` (validates session, attaches `req.user`, checks `status === 'approved'`), `requireAdmin` (chains requireAuth + checks `role === 'admin'`)
- **`middleware/rateLimits.js`**: `aiLimiter` (50 req/hour for OCR, summary, translation), `pdfVisionLimiter` (1200 req/hour), `uploadLimiter` (30 req/15 min) — all keyed by `req.session.userId` with IP fallback
- **`middleware/csrf.js`**: `csrfCheck` rejects state-changing requests without matching Origin/Referer header
- **`middleware/security.js`**: `sanitizeFilename()` (URL-decodes then strips traversal/null bytes/special chars), `validateEmail()`, `validatePassword()` (≥8 chars)
- **`middleware/upload.js`**: Multer factories for image uploads and source PDF uploads, image allowlist (jpg/jpeg/png/tiff/bmp/webp), PDF allowlist, `validateImageMagicBytes()` and `validatePdfMagicBytes()` for binary signature verification post-upload

### Validation Constants

- **`ALLOWED_MODELS`** in `texts.js` -- whitelist of Bedrock model IDs accepted in settings
- **`ALLOWED_LANGUAGES`** in `texts.js` (exported) -- 40+ ISO 639 codes plus `auto-detect`, used in `texts.js`, `llm.js`, and `projects.js`
- **`BCRYPT_ROUNDS`** in `db.js` (exported) -- centralized bcrypt cost factor (12), used in `db.js`, `auth.js`, `admin.js`

### Auth Model

Session-based cookie auth with session regeneration on login (prevents fixation). Users register as `status: 'pending'` and cannot log in until admin sets them to `'approved'`. Three statuses: `pending`, `approved`, `disabled`. Two roles: `user`, `admin`. The `/me` endpoint destroys sessions for non-approved accounts.

All route modules except auth apply `requireAuth` at the router level. Admin routes apply `requireAdmin`.

### Route Structure

```
/api/auth        → server/routes/auth.js      (login, register, logout, me, change-password)
/api/admin       → server/routes/admin.js     (user management)
/api/projects    → server/routes/projects.js  (CRUD + project type on create)
/api             → server/routes/texts.js     (texts, pages, image upload, PDF upload, HTML storage, image/PDF serving, metadata, settings)
/api             → server/routes/ocr.js       (SSE OCR pipeline — rate-limited by aiLimiter)
/api             → server/routes/llm.js       (summary, translation, PDF page parsing, PDF cleanup)
/api             → server/routes/export.js    (ZIP export)
```

### Ownership Enforcement

Every resource route uses a `verifyTextOwnership(textId, userId)` or `verifyProjectOwnership(projectId, userId)` helper that walks text → project → user to verify ownership. This pattern is duplicated in `texts.js`, `ocr.js`, `llm.js`, and `export.js`.

### Database (server/db.js)

Six tables: `users`, `projects`, `texts`, `pages`, `metadata`, `settings`. Key conventions:

- **`__compiled__` sentinel**: A page with `filename = '__compiled__'` stores user-edited full text. Must be filtered out from display queries (`pages.filter(p => p.filename !== '__compiled__')`). Referenced across `db.js`, `texts.js`, `ocr.js`, `llm.js`, `export.js`, and `TextDetail.jsx`.
- **Project type**: `projects.project_type` is `image_to_markdown` or `pdf_to_html`; it is set at creation and used by the client routers to choose the correct UI.
- **PDF-to-HTML text fields**: `texts.html_content`, `texts.source_pdf_name`, `texts.pdf_meta`, and `texts.formula_repair_status` store the generated HTML workflow state.
- **Page upsert**: `savePageOCR()` uses `INSERT ... ON CONFLICT(text_id, filename) DO UPDATE` -- re-running OCR overwrites in place.
- **Text status flow**: `pending → processing → ocrd → reviewed`
- **Project expiry**: 90-day TTL set at creation, cleaned up by `server/services/cleanup.js` cron (runs every 24h).
- **Admin seeding**: `initDatabase()` calls `seedAdmin()` which creates admin from `ADMIN_EMAIL`/`ADMIN_PASSWORD` env vars if not already present.

### OCR Pipeline (server/routes/ocr.js + server/services/bedrock.js)

1. Client opens SSE connection to `GET /api/texts/:id/ocr`
2. Server processes pages sequentially: read image → sharp resize (2048x2048 max) → base64 → Bedrock `InvokeModelCommand` (non-streaming)
3. `extractText()` dispatches response parsing by model family (Qwen/OpenAI, Nova, Claude) and strips `<reasoning>`/`<thinking>`/`<think>` tags from output
4. `deduplicateOCR()` post-processes: collapses repeated paragraphs and repeating phrases (≥3 consecutive repeats of 20-200 char patterns). `collapseRepeatingPhrases()` has iteration (500K) and recursion depth (20) caps to prevent DoS on adversarial input.
5. SSE events sent to client: `start`, `progress` (per page), `page-error`, `complete`
6. Summary generated in background (non-blocking) after all pages complete
7. Error messages in SSE are scrubbed — Bedrock errors are not sent to client

Model format dispatch in `bedrock.js` is based on model ID prefix: `qwen.*` and `openai.*` use OpenAI-compatible format; `amazon.nova*` uses Nova format; `anthropic.claude*` uses Anthropic Bedrock format.

### PDF to HTML Pipeline

1. User creates a `pdf_to_html` project and a text/document within it
2. Client renders PDF pages to JPEGs in-browser with `pdfjs-dist`
3. Client sends each page image to `POST /api/texts/:id/pdf-parse-page`
4. Server uses OpenRouter (Gemini 3 Flash) to return semantic page HTML with TeX math delimiters
5. Client assembles page sections into one document and sends it to `POST /api/texts/:id/pdf-cleanup`
6. Server uses OpenRouter to normalize heading hierarchy and merge paragraph fragments
7. Client uploads the original PDF plus generated HTML via `POST /api/texts/:id/pdf-upload`
8. User edits the saved HTML in `HtmlTextDetail.jsx`; can reprocess the PDF without re-uploading

### Math Architecture

TeX is the storage format; MathML is generated only at Manifold export time.

- **Storage**: HTML contains TeX delimiters — `\(...\)` for inline math, `\[...\]` for display math
- **Editor rendering**: KaTeX auto-render processes TeX in the contenteditable div; rendered spans are `contenteditable="false"` to prevent corruption
- **Saving**: KaTeX rendered spans are converted back to TeX delimiters before persisting (via `extractTexFromKatex()`)
- **Download**: Downloaded HTML includes KaTeX CDN scripts for self-contained TeX rendering
- **Manifold export**: `convertHtmlTexToMathML()` in `server/services/openrouter.js` uses temml to convert TeX→MathML at export time, with `display="inline"` for inline math per Manifold requirements
- **Export ZIP**: HTML files are wrapped in proper `<!DOCTYPE html><html><head><body>` structure; referenced page images are included in `images-NN/` subfolders

Manifold MathML requirements: 30 core elements, `display="inline"` required for inline math, `alttext` recommended. See https://manifoldscholar.github.io/manifold-docusaurus/docs/backend/manifold_editor#mathml

### File Storage (server/services/storage.js)

```
data/{userId}/{projectId}/{textId}/{filename}
```

50 MB quota per user, enforced at upload via `calculateUserStorage()` (real disk measurement, not Content-Length header). `image_to_markdown` texts store page images; `pdf_to_html` texts store the original uploaded PDF under the same per-text directory. Project deletion and the 90-day cleanup remove both image assets and source PDFs. Export only serves files matching the text workflow; the app does not expose raw directory listings.

### Client Architecture

- **Global state**: Only `AuthContext` (user session). No Redux/Zustand. All page data is local `useState` with fetch-on-mount.
- **API client** (`client/src/api/client.js`): Thin fetch wrapper, `credentials: 'same-origin'`. The `upload()` method omits Content-Type so browser sets multipart boundary. Export uses raw `fetch` for blob response.
- **Route split by workflow**: `ProjectRoute.jsx` and `TextRoute.jsx` fetch the resource first, then branch to `ProjectView` / `TextDetail` for `image_to_markdown` or `PdfProjectView` / `HtmlTextDetail` for `pdf_to_html`.
- **OCR streaming**: `TextDetail.jsx` uses native `EventSource` API (not the api client) for SSE.
- **Image-to-Markdown PDF handling**: `pdfToImages()` dynamically imports pdfjs-dist, rasterizes at 2x scale to canvas, converts to JPEG blobs.
- **PDF-to-HTML conversion**: `client/src/lib/pdfBedrockPipeline.js` renders PDF pages to images, sends them through the Bedrock hybrid pipeline, and uploads the final HTML. `client/src/lib/pdfToHtml.js` is legacy heuristic code and should not be treated as the preferred primary converter.
- **Image resize**: `resizeImageBlob()` uses Canvas API to shrink images over 3.5 MB before upload.
- **Markdown rendering**: All user-facing markdown uses `marked.parse()` piped through `DOMPurify.sanitize()`.
- **HTML rendering**: `HtmlTextDetail.jsx` sanitizes rendered HTML while allowing MathML tags/attributes. KaTeX auto-render converts TeX delimiters to visual math in the contenteditable preview; `extractTexFromKatex()` reverses this before saving.
- **PDF project text actions**: `PdfProjectView.jsx` supports create, replace upload, open editor, and delete for PDF-to-HTML texts.

### Tailwind Theme (client/tailwind.config.js)

Custom color tokens: `cail-navy`, `cail-blue`, `cail-teal`, `cail-azure`, `cail-dark`, `cail-cream`, `cail-stone`. Fonts: Outfit (display), Inter (body).

## Production Deployment

**Server**: `100.111.252.53` (Debian), user `smorello.adm@gc.cuny.edu`
**URL**: `https://tools.cuny.qzz.io/manifold-companion/` (behind Cloudflare Access SSO)
**App dir**: `/data/manifold-companion/` (2TB storage drive)
**Data dir**: `/data/manifold-companion/data/` (SQLite DBs + uploaded files)
**Port**: `3003` (3000-3002 occupied by other services)
**Service**: `manifold-companion.service` (systemd)

### Subpath Architecture

The app runs under `/manifold-companion/` subpath. Nginx `proxy_pass http://127.0.0.1:3003/;` (trailing slash) strips the prefix, so Express sees `/api/...` as usual. The **client** handles the prefix:

- `vite.config.js`: `base` is `/manifold-companion/` for builds, `/` for dev (`command === 'build'` check)
- `client/src/api/client.js`: `BASE` constant derived from `import.meta.env.BASE_URL` — prefixes all fetch/upload calls
- `main.jsx`: `<BrowserRouter basename={...}>` for client-side routing
- Components that bypass the API client (EventSource, direct fetch, image src) import `BASE` from `../api/client`

**Important**: Any new component that constructs URLs directly (not through `api.get/post/put/del/upload`) must import and use `BASE`.

### Deploying Changes

```bash
# 1. Dev locally as usual
npm run dev    # base='/', everything at localhost:5173

# 2. Build and push
npm run build
tar czf /tmp/manifold-companion.tar.gz --exclude='node_modules' --exclude='data' --exclude='.env' --exclude='.git' --exclude='.playwright-mcp' --exclude='*.png' .
sshpass -p '<password>' scp /tmp/manifold-companion.tar.gz smorello.adm@gc.cuny.edu@100.111.252.53:/data/manifold-companion/
sshpass -p '<password>' ssh smorello.adm@gc.cuny.edu@100.111.252.53 \
  "cd /data/manifold-companion && tar xzf manifold-companion.tar.gz && rm manifold-companion.tar.gz"

# 3. Restart (needs sudo)
sshpass -p '<password>' ssh -tt smorello.adm@gc.cuny.edu@100.111.252.53 \
  'echo "<password>" | sudo -S systemctl restart manifold-companion'
```

If dependencies changed, add `npm install --production` before the restart.

### Nginx Note

`X-Forwarded-Proto` is hardcoded to `https` in the nginx location block because Cloudflare terminates SSL and forwards HTTP to nginx, so `$scheme` would incorrectly be `http`. This is critical for secure session cookies.

### Useful Server Commands

```bash
systemctl status manifold-companion          # Service status
journalctl -u manifold-companion -f          # Live logs
journalctl -u manifold-companion --no-pager -n 50   # Recent logs
ls /data/manifold-companion/data/            # Data directory
```

## Security Hardening

Fixes applied (2026-02-24):

- **Upload error scrubbing**: Multer errors are mapped to safe messages — no filesystem paths leak to clients (`texts.js`)
- **Prompt length cap**: User-supplied OCR prompts capped at 2000 chars (`texts.js`)
- **Last-admin guard**: Cannot delete the only remaining admin account (`admin.js`)
- **Export tree depth limit**: `validateTree()` rejects TOC nesting deeper than 10 levels (`export.js`)
- **Language validation**: `default_language` on project create/update validated against `ALLOWED_LANGUAGES` (`projects.js`)

### AWS GuardDuty

The AWS account (`757395169441`) has GuardDuty enabled with SNS alerts to `smorello@gradcenter.cuny.edu`. First-time Bedrock calls from a new IP/user-agent will trigger `Impact:IAMUser/AnomalousBehavior` alerts — these are false positives for legitimate first use from the CUNY network (ASN 31822). Archive these findings in the GuardDuty console; they stop recurring once the behavior is profiled.

## Known Code Duplication

These are intentional copy-paste patterns to be aware of when making changes:

- `verifyTextOwnership()` -- duplicated in `texts.js`, `ocr.js`, `llm.js`
- `compileFullText()` -- duplicated in `ocr.js`, `llm.js`
- `pdfToImages()` and `resizeImageBlob()` -- duplicated in `ProjectView.jsx`, `TextDetail.jsx`
- The legacy browser heuristic converter in `client/src/lib/pdfToHtml.js` and the current pipeline in `client/src/lib/pdfBedrockPipeline.js` may diverge. Prefer changing the pipeline path unless intentionally reviving the heuristic fallback.
