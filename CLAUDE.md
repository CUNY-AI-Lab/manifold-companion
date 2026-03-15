# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Multi-user document-processing platform with two first-class workflows:

- **Image to Markdown** -- upload images or rasterized PDF pages, run OCR via Bedrock, review/edit markdown, and export for Manifold
- **PDF to HTML** -- upload a source PDF, render pages browser-side, parse each page with OpenRouter (Gemini 3 Flash), clean the assembled HTML, and edit/download the generated HTML

The app is an Express backend serving a React SPA, with SQLite for persistence, AWS Bedrock for OCR/summaries/translations, and OpenRouter for PDF-to-HTML conversion.

## UI Development

When adding or modifying UI components, always invoke the `frontend-design` skill to ensure visual consistency and high design quality. This applies to all client-side changes that affect what the user sees.

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
- **AI/OCR**: AWS Bedrock for image OCR (`qwen.qwen3-vl-235b-a22b`), summaries, and translations (`openai.gpt-oss-120b-1:0`); OpenRouter (Gemini 3 Flash) for PDF page parsing and HTML cleanup
- **Math**: KaTeX (client-side TeX rendering in editor), temml (server-side TeX→MathML at Manifold export)
- **System deps**: `pdftohtml` from `poppler-utils` (used by figure extraction in `openrouter.js`)
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
- `SES_FROM_EMAIL` -- SES verified sender address (default `manifold-companion@cuny.qzz.io`)
- `APP_URL` -- Public app URL for email links (default `https://tools.cuny.qzz.io/manifold-companion`)

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
- **`middleware/rateLimits.js`**: `aiLimiter` (50 req/hour for OCR, summary, translation), `pdfVisionLimiter` (1200 req/hour for PDF page parsing), `uploadLimiter` (30 req/15 min) — all keyed by `req.session.userId` with IP fallback
- **`middleware/csrf.js`**: `csrfCheck` rejects state-changing requests without matching Origin/Referer header
- **`middleware/security.js`**: `sanitizeFilename()` (URL-decodes then strips traversal/null bytes/special chars), `validateEmail()`, `validatePassword()` (≥8 chars)
- **`middleware/tokenQuota.js`**: `checkTokenQuota` — rejects requests with 429 when user's token usage exceeds their `token_allowance`. Applied to all AI routes (OCR, summary, translation, PDF parsing).
- **`middleware/upload.js`**: Multer factories for image uploads and source PDF uploads, image allowlist (jpg/jpeg/png/tiff/bmp/webp), PDF allowlist, `validateImageMagicBytes()` and `validatePdfMagicBytes()` for binary signature verification post-upload

### Validation Constants

- **`ALLOWED_MODELS`** in `texts.js` -- whitelist of Bedrock model IDs accepted in settings
- **`ALLOWED_LANGUAGES`** in `texts.js` (exported) -- 40+ ISO 639 codes plus `auto-detect`, used in `texts.js`, `llm.js`, and `projects.js`
- **`BCRYPT_ROUNDS`** in `db.js` (exported) -- centralized bcrypt cost factor (12), used in `db.js`, `auth.js`, `admin.js`

### Auth Model

Session-based cookie auth with session regeneration on login (prevents fixation). Users register as `status: 'pending'` (with optional display name) and cannot log in until admin sets them to `'approved'`. Three statuses: `pending`, `approved`, `disabled`. Two roles: `user`, `admin`. The `/me` endpoint destroys sessions for non-approved accounts and returns `display_name`, `token_allowance`, and current `token_usage`. Users can update their own display name via `PUT /api/auth/profile`.

All route modules except auth apply `requireAuth` at the router level. Admin routes apply `requireAdmin`.

### Route Structure

```
/api/auth                          → server/routes/auth.js         (login, register, logout, me, profile, change-password)
/api/admin                         → server/routes/admin.js        (user mgmt, bulk approval, usage stats, backups)
/api/users                         → server/routes/users.js        (user search for share autocomplete)
/api/projects                      → server/routes/projects.js     (CRUD + project type on create)
/api/projects/:projectId/shares    → server/routes/shares.js       (project sharing CRUD — owner only)
/api                               → server/routes/texts.js        (texts, pages, upload, HTML, search, versions)
/api                               → server/routes/ocr.js          (SSE OCR pipeline — rate-limited by aiLimiter)
/api                               → server/routes/llm.js          (summary, translation, PDF page parsing, PDF cleanup)
/api                               → server/routes/export.js       (ZIP export)
/api                               → server/routes/annotations.js  (inline annotations/comments with replies)
/api/notifications                 → server/routes/notifications.js (bell notifications, preferences)
```

### Access Control (server/middleware/access.js)

Centralized role-aware access verification replaces the old duplicated ownership helpers. Two functions:

- `verifyProjectAccess(projectId, userId, minRole)` — returns `{ project, role }` or `{ status, error }`
- `verifyTextAccess(textId, userId, minRole)` — returns `{ text, project, role }` or `{ status, error }`

Role hierarchy: `owner > editor > viewer`. The `getUserProjectRole()` DB function checks project ownership first, then falls back to `project_shares`. All route files use these instead of inline ownership checks.

**File storage for shared projects**: Files always live in the owner's directory (`data/{project.user_id}/...`). Collaborators access files via `result.project.user_id`, never `req.user.id`. Storage quotas only apply to the owner.

### Database (server/db.js)

Twelve tables: `users`, `projects`, `texts`, `pages`, `metadata`, `settings`, `project_shares`, `text_versions`, `annotations`, `api_usage_logs`, `notifications`, `notification_preferences`. Key conventions:

- **`__compiled__` sentinel**: A page with `filename = '__compiled__'` stores user-edited full text. Must be filtered out from display queries (`pages.filter(p => p.filename !== '__compiled__')`). Referenced across `db.js`, `texts.js`, `ocr.js`, `llm.js`, `export.js`, and `TextDetail.jsx`.
- **Project type**: `projects.project_type` is `image_to_markdown` or `pdf_to_html`; it is set at creation and used by the client routers to choose the correct UI.
- **PDF-to-HTML text fields**: `texts.html_content`, `texts.source_pdf_name`, `texts.pdf_meta`, and `texts.formula_repair_status` store the generated HTML workflow state.
- **Page upsert**: `savePageOCR()` uses `INSERT ... ON CONFLICT(text_id, filename) DO UPDATE` -- re-running OCR overwrites in place.
- **Text status flow**: `pending → processing → ocrd → reviewed`
- **Project expiry**: 90-day TTL set at creation, cleaned up by `server/services/cleanup.js` cron (runs every 24h).
- **Admin seeding**: `initDatabase()` calls `seedAdmin()` which creates admin from `ADMIN_EMAIL`/`ADMIN_PASSWORD` env vars if not already present.
- **Project shares**: `project_shares` table tracks `(project_id, user_id, role)` with UNIQUE constraint. Roles: `viewer`, `editor`. Cascade deletes on project or user removal.
- **Version history**: `text_versions` table stores content snapshots with `content_type` (`compiled`, `html`, `page`), user attribution, and timestamp. Auto-pruned to 50 versions per text+type. Versions are created automatically when saving text content (before overwrite).
- **Annotations**: `annotations` table supports threaded comments with `parent_id` for replies, `anchor_type` (`range`, `point`, `global`), and `anchor_data` (JSON with CSS selectors or paragraph offsets). Supports resolve/unresolve workflow with `resolved_by` and `resolved_at`. The `mentions` column (JSON array of user IDs) stores @mention data per annotation.
- **@Mentions**: `getProjectMembers(projectId)` returns owner + shared users for autocomplete. `GET /api/texts/:id/mentions/users` serves the member list. Annotations and replies accept `mentions` array, validated against project membership. Client renders `@Name` as highlighted blue spans.
- **Notifications**: `notifications` table stores in-app notifications with `user_id`, `type`, `title`, `body`, `link`, `read` (0/1), and `created_at`. Types: `ocr_complete`, `account_approved`, `project_shared`, `comment_reply`, `comment_mention`. `notification_preferences` table stores per-user email toggles (`email_ocr_complete`, `email_project_shared`, `email_comment_reply`, `email_comment_mention`) defaulting to 1 (enabled).
- **Display names**: `users.display_name` (nullable TEXT). Shown in annotations, shares, version history. Falls back to email when null.
- **Token allowances**: `users.token_allowance` (default 5,000,000) and `users.token_usage_reset_at` (timestamp). Quota is enforced by `checkTokenQuota` middleware on all AI routes.
- **API usage logs**: `api_usage_logs` table records every AI API call with `user_id`, `project_id`, `text_id`, `endpoint`, `model`, `tokens_in`, `tokens_out`, and `created_at`. Indexed on `(user_id, created_at)` and `(project_id)`. Token usage is calculated as `SUM(tokens_in + tokens_out)` since `token_usage_reset_at`.

### OCR Pipeline (server/routes/ocr.js + server/services/bedrock.js)

1. Client opens SSE connection to `GET /api/texts/:id/ocr`
2. Server processes pages sequentially: read image → sharp resize (2048x2048 max) → base64 → Bedrock `InvokeModelCommand` (non-streaming)
3. `extractText()` dispatches response parsing by model family (Qwen/OpenAI, Nova, Claude) and strips `<reasoning>`/`<thinking>`/`<think>` tags from output
4. `deduplicateOCR()` post-processes: collapses repeated paragraphs and repeating phrases (≥3 consecutive repeats of 20-200 char patterns). `collapseRepeatingPhrases()` has iteration (500K) and recursion depth (20) caps to prevent DoS on adversarial input.
5. SSE events sent to client: `start`, `progress` (per page), `page-error`, `complete`
6. Summary generated in background (non-blocking) after all pages complete
7. Error messages in SSE are scrubbed — Bedrock errors are not sent to client

Model format dispatch in `bedrock.js` is based on model ID prefix: `qwen.*` and `openai.*` use OpenAI-compatible format; `amazon.nova*` uses Nova format; `anthropic.claude*` uses Anthropic Bedrock format.

**AI service return values**: All AI functions return `{ text, usage }` objects (not raw strings). `usage` contains `{ tokensIn, tokensOut }`. Callers in `ocr.js` and `llm.js` destructure these and pass usage data to `logApiUsage()`. The `extractUsage()` function in `bedrock.js` normalizes token counts across model families.

### PDF to HTML Pipeline (OpenRouter)

The entire PDF-to-HTML pipeline uses OpenRouter (`server/services/openrouter.js`), not Bedrock. The client pipeline orchestrator is `client/src/lib/pdfBedrockPipeline.js` (name is a historical artifact).

1. User creates a `pdf_to_html` project and a text/document within it
2. Client renders PDF pages to JPEGs in-browser with `pdfjs-dist`
3. Client sends each page image to `POST /api/texts/:id/pdf-parse-page`
4. Server calls `parsePdfPageToHtml()` via OpenRouter (Gemini 3 Flash) to return semantic page HTML with TeX math delimiters
5. Client assembles page sections into one document and sends it to `POST /api/texts/:id/pdf-cleanup`
6. Server calls `cleanupPdfHtml()` via OpenRouter to normalize heading hierarchy and merge paragraph fragments
7. Client uploads the original PDF plus generated HTML via `POST /api/texts/:id/pdf-upload`
8. User edits the saved HTML in `HtmlTextDetail.jsx`; can reprocess the PDF without re-uploading

`openrouter.js` also exports:
- `extractFiguresFromPdf()` — extracts embedded figures using `pdftohtml -xml` (requires poppler-utils)
- `convertHtmlTexToMathML()` — export-time TeX→MathML conversion using temml
- `callWithRetry()` — exponential backoff on 429/5xx responses

### Notifications (server/services/notify.js + server/services/email.js)

Two-layer notification system: in-app (always) + email (AWS SES, per user preferences).

- **Dispatcher** (`notify.js`): `notifyOcrComplete()`, `notifyAccountApproved()`, `notifyProjectShared()`, `notifyCommentReply()`, `notifyMention()`. Each creates an in-app notification via `createNotification()` and conditionally sends email based on `shouldEmail()` checking `notification_preferences`.
- **Email** (`email.js`): Uses `@aws-sdk/client-sesv2` with SES v2 API. Domain `cuny.qzz.io` is DKIM-verified. Branded HTML email template with app links.
- **Triggers**: wired into `ocr.js` (after SSE complete), `admin.js` (status → approved), `shares.js` (after share created), `annotations.js` (replies and @mentions).
- **Known issue**: CUNY institutional email addresses (`@gc.cuny.edu`, `@gradcenter.cuny.edu`) silently drop emails sent from `cuny.qzz.io` — SES reports successful delivery but emails never arrive (not even in spam). Gmail and other providers work fine. This appears to be CUNY's mail gateway policy.

Note: `bedrock.js` still contains vestigial PDF functions (`parsePdfPageToHtml`, `cleanupPdfHtml`, `repairFormulasToMathMl`) from the original pipeline. These are **dead code** — all PDF routes in `llm.js` import from `openrouter.js`.

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

**Backups**: Admin can create backups via `POST /api/admin/backups`. Uses `database.backup()` (better-sqlite3 hot backup) for both `manifold.db` and `sessions.db`, then `execFileSync('tar', [...])` for data directory archiving. Backups are stored in `data/backups/` with timestamped filenames. `sanitizeFilename()` prevents path traversal on download/delete endpoints.

### Client Architecture

- **Global state**: Only `AuthContext` (user session). No Redux/Zustand. All page data is local `useState` with fetch-on-mount.
- **API client** (`client/src/api/client.js`): Thin fetch wrapper, `credentials: 'same-origin'`. The `upload()` method omits Content-Type so browser sets multipart boundary. Export uses raw `fetch` for blob response.
- **Route split by workflow**: `ProjectRoute.jsx` and `TextRoute.jsx` fetch the resource first, then branch to `ProjectView` / `TextDetail` for `image_to_markdown` or `PdfProjectView` / `HtmlTextDetail` for `pdf_to_html`.
- **OCR streaming**: `TextDetail.jsx` uses native `EventSource` API (not the api client) for SSE.
- **Image-to-Markdown PDF handling**: `pdfToImages()` dynamically imports pdfjs-dist, rasterizes at 2x scale to canvas, converts to JPEG blobs.
- **PDF-to-HTML conversion**: `client/src/lib/pdfBedrockPipeline.js` renders PDF pages to images, sends them through the OpenRouter pipeline, and uploads the final HTML. `client/src/lib/pdfToHtml.js` is legacy heuristic code and should not be used.
- **Image resize**: `resizeImageBlob()` uses Canvas API to shrink images over 3.5 MB before upload.
- **Markdown rendering**: All user-facing markdown uses `marked.parse()` piped through `DOMPurify.sanitize()`.
- **HTML rendering**: `HtmlTextDetail.jsx` sanitizes rendered HTML while allowing MathML tags/attributes. KaTeX auto-render converts TeX delimiters to visual math in the contenteditable preview; `extractTexFromKatex()` reverses this before saving.
- **Image zoom**: Both editors have scroll-to-zoom + drag-to-pan on image/PDF panes (lightbox-style interaction). `TextDetail.jsx` Review tab uses `reviewZoom`/`reviewPan` state; `HtmlTextDetail.jsx` uses `pdfZoom` with `minWidth`-based horizontal scroll.
- **PDF project text actions**: `PdfProjectView.jsx` supports create, replace upload, open editor, and delete for PDF-to-HTML texts.
- **Search**: `SearchBar.jsx` provides debounced search with a 3-result dropdown and "See all" link to `/search` page. `SearchPage.jsx` shows full results grouped by project.
- **Collaboration UI**: `SharePanel.jsx` (portal modal) for owners to add/remove/update shares by email. `ProjectView.jsx` and `PdfProjectView.jsx` show role-based UI (hide edit/delete for viewers, share button for owners).
- **Version history**: `VersionHistory.jsx` (portal modal) shows version list with GitHub-style diff view (Myers algorithm, HTML-aware line splitting) and revert. Accessible via "History" button in the Review tab of both editors.
- **Annotations**: `AnnotationSidebar.jsx` (slide-out panel) for threaded comments with replies, resolve/unresolve, delete, and @mentions. Type `@` in comment/reply textarea to see project member autocomplete dropdown. Mentions stored as user ID arrays and rendered as highlighted spans. Accessible via "Comments" button in the Review tab.
- **Notifications UI**: `NotificationBell.jsx` in Header shows bell icon with unread count badge, dropdown notification list with per-type icons, mark-read on click (navigates to `link`), mark-all-read, and a gear icon to toggle email preferences. Polls `/api/notifications/unread-count` every 30 seconds. Comment/mention notification links include `?annotations=1` to auto-open the annotations sidebar.
- **Tab deep linking**: Both `TextDetail.jsx` and `HtmlTextDetail.jsx` read `?tab=` and `?annotations=1` query params on mount to set the initial active tab and auto-open the annotations sidebar (used by search results and notification links).
- **Admin panel** (`AdminPanel.jsx`): Three-tab layout — Users (inline name editing, bulk approval, token allowance controls, usage reset), Usage (period selector, summary cards, per-endpoint/user/project breakdowns), Backups (create/download/delete database+file backups). Backup download uses `BASE` prefix for subpath compatibility.
- **Registration**: `RegisterPage.jsx` includes optional display name field. `AuthContext` exposes `updateProfile()` for name changes.

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

- `compileFullText()` -- duplicated in `ocr.js`, `llm.js`
- `pdfToImages()` and `resizeImageBlob()` -- duplicated in `ProjectView.jsx`, `TextDetail.jsx`
- The legacy browser heuristic converter in `client/src/lib/pdfToHtml.js` and the current pipeline in `client/src/lib/pdfBedrockPipeline.js` may diverge. Prefer changing the pipeline path unless intentionally reviving the heuristic fallback.

Note: `verifyTextOwnership()` and `verifyProjectOwnership()` were previously duplicated across route files. These have been replaced by centralized `verifyTextAccess()` and `verifyProjectAccess()` in `server/middleware/access.js`.
