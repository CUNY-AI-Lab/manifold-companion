# CAIL OCR Manifold Companion — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a multi-user OCR platform with Express+React that processes document scans via AWS Bedrock and exports Manifold-compatible packages.

**Architecture:** Express.js API backend with React/Vite SPA frontend in a monorepo. SQLite database with better-sqlite3. AWS Bedrock for OCR (QWEN vision) and text tasks (Claude Sonnet). Tailwind CSS styled to match CUNY AI Lab website.

**Tech Stack:** Node.js 20+, Express 4, React 18, Vite 5, Tailwind CSS 3, better-sqlite3, Sharp, Multer, Archiver, bcrypt, express-session, pdf.js, marked, DOMPurify, @aws-sdk/client-bedrock-runtime

**Design doc:** `docs/plans/2026-02-24-cail-ocr-manifold-companion-design.md`

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json` (root workspace)
- Create: `server/package.json`
- Create: `client/package.json`
- Create: `.env`
- Create: `.gitignore`
- Create: `CLAUDE.md`

**Step 1: Create root package.json with workspaces**

```json
{
  "name": "manifold-companion",
  "private": true,
  "type": "module",
  "workspaces": ["server", "client"],
  "scripts": {
    "dev": "concurrently \"npm run dev:server\" \"npm run dev:client\"",
    "dev:server": "cd server && npm run dev",
    "dev:client": "cd client && npm run dev",
    "build": "cd client && npm run build",
    "start": "cd server && npm start"
  },
  "devDependencies": {
    "concurrently": "^9.1.0"
  }
}
```

**Step 2: Create server/package.json and install backend deps**

```json
{
  "name": "manifold-companion-server",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node index.js",
    "dev": "node --watch index.js"
  },
  "dependencies": {
    "@aws-sdk/client-bedrock-runtime": "^3.700.0",
    "archiver": "^7.0.0",
    "bcrypt": "^5.1.1",
    "better-sqlite3": "^11.0.0",
    "connect-sqlite3": "^0.9.15",
    "dotenv": "^16.4.0",
    "express": "^4.21.0",
    "express-rate-limit": "^7.5.0",
    "express-session": "^1.18.0",
    "helmet": "^8.0.0",
    "multer": "^1.4.5-lts.1",
    "sharp": "^0.33.0"
  }
}
```

Run: `cd server && npm install`

**Step 3: Create client/package.json and install frontend deps**

```json
{
  "name": "manifold-companion-client",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "dompurify": "^3.2.0",
    "marked": "^15.0.0",
    "pdfjs-dist": "^4.0.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "react-router-dom": "^6.28.0"
  },
  "devDependencies": {
    "@tailwindcss/typography": "^0.5.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.4.0",
    "tailwindcss": "^3.4.0",
    "vite": "^5.4.0"
  }
}
```

Run: `cd client && npm install`

**Step 4: Create .env with Bedrock credentials**

```
PORT=3000
SESSION_SECRET=change-me-to-random-string-in-production
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=<decoded from base64 key>
AWS_SECRET_ACCESS_KEY=<decoded from base64 key>
BEDROCK_OCR_MODEL=us.amazon.nova-pro-v1:0
BEDROCK_TEXT_MODEL=us.anthropic.claude-3-5-sonnet-20241022-v2:0
```

Note: The base64 key `ABSKQmVkcm9ja0FQSUtleS1uaXh0LWF0LTc1NzM5NTE2OTQ0MTo0aGMvUXFnSVFERVgwVHdMKytMOWMwRjhob1dFRVRYWndtTGo4YitaUkpYdkpyMWdBVmNOcWE5MlJDcz0=` must be decoded to extract the access key ID and secret access key.

**Step 5: Create .gitignore**

```
node_modules/
data/
*.db
*.db-wal
*.db-shm
.env
dist/
.DS_Store
```

**Step 6: Create CLAUDE.md**

Document the project structure, dev commands, architecture decisions.

**Step 7: Install root deps and verify workspace**

Run: `npm install`
Run: `npm run dev:server` — should fail gracefully (no index.js yet)

**Step 8: Commit**

```bash
git init
git add -A
git commit -m "chore: scaffold monorepo with server and client workspaces"
```

---

### Task 2: Database Layer

**Files:**
- Create: `server/db.js`

**Step 1: Create SQLite schema with all tables**

Create `server/db.js` with:
- `initDatabase(dataDir)` — creates/opens DB, runs schema, seeds admin
- Tables: users, projects, texts, pages, metadata, settings, sessions
- Admin seed: email `veritas44@gmail.com`, password hash of `gremlins2025`, role `admin`, status `approved`
- All query functions exported (CRUD for each entity)

Schema adapted from the Lalli `db.js` but restructured for multi-user with:
- `users` table with email, password_hash, role, status, storage_used_bytes
- `projects` table with user_id FK, expires_at
- `texts` instead of `works`, with project_id FK
- `pages` with text_id FK (not work name)
- `metadata` with text_id FK
- `settings` with text_id FK

Key functions to export:
- User: `createUser`, `getUserByEmail`, `getUserById`, `updateUserStatus`, `updateUserLogin`, `updateUserStorage`, `getAllUsers`, `deleteUser`
- Project: `createProject`, `getProjectsByUser`, `getProjectById`, `updateProject`, `deleteProject`, `getExpiredProjects`
- Text: `createText`, `getTextsByProject`, `getTextById`, `updateText`, `deleteText`, `setTextStatus`, `setTextSummary`, `setTextTranslation`
- Page: `savePageOCR`, `getPagesByText`, `savePageText`, `deletePage`
- Metadata: `getTextMetadata`, `saveTextMetadata`
- Settings: `getTextSettings`, `saveTextSettings`, `deleteTextSettings`
- Search: `searchTexts`

**Step 2: Verify DB creates and seeds admin**

Run a quick test: `node -e "import('./db.js').then(m => { const db = m.initDatabase('./test-data'); console.log(m.getUserByEmail('veritas44@gmail.com')); })"`

**Step 3: Commit**

```bash
git add server/db.js
git commit -m "feat: add SQLite database layer with multi-user schema"
```

---

### Task 3: Auth Middleware & Routes

**Files:**
- Create: `server/middleware/auth.js`
- Create: `server/routes/auth.js`

**Step 1: Create auth middleware**

`server/middleware/auth.js`:
- `requireAuth(req, res, next)` — checks session for userId, loads user, rejects if not approved
- `requireAdmin(req, res, next)` — checks user.role === 'admin'
- Attaches `req.user` for downstream handlers

**Step 2: Create auth routes**

`server/routes/auth.js` — Express Router:
- `POST /api/auth/register` — validate email+password, hash password, create user as pending, return 201
- `POST /api/auth/login` — find user by email, verify password, check status===approved, create session, update last_login
- `POST /api/auth/logout` — destroy session
- `GET /api/auth/me` — return current user info (or 401)

Input validation: email format check, password min 8 chars, sanitize inputs.

**Step 3: Commit**

```bash
git add server/middleware/auth.js server/routes/auth.js
git commit -m "feat: add auth middleware and login/register/logout routes"
```

---

### Task 4: Admin Routes

**Files:**
- Create: `server/routes/admin.js`

**Step 1: Create admin routes**

`server/routes/admin.js` — Express Router (all require requireAdmin):
- `GET /api/admin/users` — list all users with project counts and storage usage
- `PUT /api/admin/users/:id/status` — approve/disable a user
- `DELETE /api/admin/users/:id` — delete user, their projects, files, and reclaim storage

**Step 2: Commit**

```bash
git add server/routes/admin.js
git commit -m "feat: add admin user management routes"
```

---

### Task 5: Project & Text CRUD Routes

**Files:**
- Create: `server/routes/projects.js`
- Create: `server/routes/texts.js`
- Create: `server/middleware/upload.js`
- Create: `server/services/storage.js`

**Step 1: Create storage service**

`server/services/storage.js`:
- `checkQuota(userId, additionalBytes)` — returns true if under 50MB
- `updateStorageUsed(userId)` — recalculate from files on disk
- `getUserStorageDir(userId)` — returns `data/{userId}/`
- `getTextStorageDir(userId, projectId, textId)` — returns `data/{userId}/{projectId}/{textId}/`

**Step 2: Create upload middleware**

`server/middleware/upload.js`:
- Multer config with disk storage
- File filter: only .jpg, .jpeg, .png, .tiff, .bmp, .webp
- Size limit: 10MB per file (already preprocessed by client)
- Destination: `data/{userId}/{projectId}/{textId}/`

**Step 3: Create project routes**

`server/routes/projects.js` — Express Router (all require requireAuth):
- `GET /api/projects` — list user's projects
- `POST /api/projects` — create project (name, description, default_language), set expires_at = now+90 days
- `GET /api/projects/:id` — get project detail (with text list)
- `PUT /api/projects/:id` — update project name/description/language
- `DELETE /api/projects/:id` — delete project + all texts + files, reclaim storage

Ownership check: all routes verify project belongs to req.user.id.

**Step 4: Create text routes**

`server/routes/texts.js` — Express Router (all require requireAuth):
- `POST /api/projects/:projectId/texts` — create text
- `GET /api/texts/:id` — get text detail
- `PUT /api/texts/:id` — update text name/summary/translation (manual edit)
- `DELETE /api/texts/:id` — delete text + pages + files
- `POST /api/texts/:id/upload` — upload images (multer)
- `GET /api/texts/:id/pages` — list pages with OCR status
- `POST /api/texts/:id/pages/:pageId` — update single page OCR text
- `GET /api/texts/:id/result` — get compiled full text
- `POST /api/texts/:id/save` — save edited full markdown
- `GET /api/texts/:id/metadata` — get Dublin Core metadata
- `POST /api/texts/:id/metadata` — save metadata
- `GET /api/texts/:id/settings` — get OCR settings
- `POST /api/texts/:id/settings` — save OCR settings
- `DELETE /api/texts/:id/settings` — reset settings to defaults

Image serving:
- `GET /api/texts/:id/image/:filename` — serve image (with optional ?w= for thumbnails), smart rotation via Sharp

Ownership check: all routes verify text's project belongs to req.user.id.

**Step 5: Commit**

```bash
git add server/routes/projects.js server/routes/texts.js server/middleware/upload.js server/services/storage.js
git commit -m "feat: add project/text CRUD routes with storage management"
```

---

### Task 6: Bedrock Service & OCR Route

**Files:**
- Create: `server/services/bedrock.js`
- Create: `server/routes/ocr.js`

**Step 1: Create Bedrock service**

`server/services/bedrock.js`:
- Initialize `BedrockRuntimeClient` with region from env
- `ocrPage(base64Image, settings)` — call QWEN vision via `InvokeModel`, return OCR text
- `generateSummary(fullText)` — call Claude Sonnet, return ~200 word summary
- `translateText(text, sourceLang, targetLang)` — call Claude Sonnet with chunking, return translation

The OCR prompt is a generalized version of Lalli's (remove Italian-specific apostrophe rules):
```
You are an expert OCR system. This is a scan of a document page.

CRITICAL INSTRUCTIONS:
- The paper may be thin, so you may see faint text bleeding through from the OTHER SIDE. IGNORE reversed/mirrored or faint bleed-through text. Only transcribe the main text on THIS side.
- Transcribe the text EXACTLY as written, preserving the original language.
- The text may wrap at fixed margins. Do NOT preserve physical line breaks. Join lines in the same paragraph into continuous text. Only break where there is an actual paragraph break.
- Do NOT include page numbers.
- Do NOT add any commentary, headers, or footers.

HANDLING UNCLEAR OR MODIFIED TEXT:
- Hard to read: [unclear: your best guess]
- Crossed out: [deleted: crossed out text]
- Handwritten annotations: [handwritten: the annotation text]
- Completely illegible: [illegible]

MARKDOWN FORMATTING:
- ## Heading for titles, centered headings, section headers
- **bold** for emphasized words or character names
- *italic* for stage directions, handwritten annotations, italic typeface
- --- for section separators
- Regular body text: no formatting

Output ONLY the transcribed text. No thinking or reasoning.
```

**Step 2: Create OCR route**

`server/routes/ocr.js` — Express Router:
- `GET /api/texts/:id/ocr` — SSE stream, process each page through Bedrock OCR
  - Load text settings or use defaults
  - For each page: smart rotate via Sharp, base64 encode, call bedrock.ocrPage(), save to DB, stream progress
  - After completion: compile full text, set status to 'ocrd'
  - Optionally generate summary in background
- `POST /api/texts/:id/ocr-single` — OCR a single page (re-process)

**Step 3: Commit**

```bash
git add server/services/bedrock.js server/routes/ocr.js
git commit -m "feat: add Bedrock OCR service and SSE processing route"
```

---

### Task 7: LLM Routes (Summary & Translation)

**Files:**
- Create: `server/routes/llm.js`

**Step 1: Create LLM routes**

`server/routes/llm.js` — Express Router:
- `GET /api/texts/:id/summary` — return cached summary
- `POST /api/texts/:id/summary` — generate via Bedrock Claude, save to DB
- `PUT /api/texts/:id/summary` — save manually-edited summary (no LLM)
- `GET /api/texts/:id/translation` — return cached translation
- `POST /api/texts/:id/translation` — generate via Bedrock Claude with target language, save to DB
- `PUT /api/texts/:id/translation` — save manually-edited translation (no LLM)

Translation target language comes from request body (default: 'en'). Supported: en, es, fr, de, it, pt, zh, ja, ko, ar.

**Step 2: Commit**

```bash
git add server/routes/llm.js
git commit -m "feat: add LLM summary and translation routes"
```

---

### Task 8: Manifold Export Route

**Files:**
- Create: `server/routes/export.js`

**Step 1: Create export route**

`server/routes/export.js` — Express Router:
- `POST /api/projects/:projectId/export` — generate Manifold-compatible ZIP
  - Request body: `{ toc, meta }` (table of contents tree + metadata)
  - Build manifest.yml with metadata and TOC
  - For each text in TOC: create markdown file with YAML frontmatter + content
  - Include referenced images
  - Stream ZIP as response

Adapted from the Lalli `export-manifold` route but using text IDs instead of work names.

**Step 2: Commit**

```bash
git add server/routes/export.js
git commit -m "feat: add Manifold-compatible ZIP export"
```

---

### Task 9: Cleanup Service

**Files:**
- Create: `server/services/cleanup.js`

**Step 1: Create cleanup cron**

`server/services/cleanup.js`:
- `startCleanupCron()` — runs daily (setInterval 24h)
- Finds projects where `expires_at < now()`
- Deletes expired projects, their texts, pages, files on disk
- Recalculates storage for affected users
- Logs deletions

**Step 2: Commit**

```bash
git add server/services/cleanup.js
git commit -m "feat: add 90-day project expiry cleanup service"
```

---

### Task 10: Express Server Entry Point

**Files:**
- Create: `server/index.js`

**Step 1: Wire everything together**

`server/index.js`:
- Load dotenv
- Create Express app
- Apply middleware: helmet, express.json, express-session (with SQLite store), rate limiter on /api/auth
- Mount routes: auth, admin, projects, texts, ocr, llm, export
- Serve client build (`../client/dist`) in production
- Init database, start cleanup cron
- Listen on PORT

Security middleware stack:
```js
app.use(helmet({ contentSecurityPolicy: { directives: { ... } } }));
app.use(express.json({ limit: '50mb' }));
app.use(session({ store: sqliteStore, secret, cookie: { httpOnly: true, sameSite: 'strict', maxAge: 24h } }));
app.use('/api/auth/login', rateLimit({ windowMs: 15*60*1000, max: 5 }));
app.use('/api/auth/register', rateLimit({ windowMs: 15*60*1000, max: 5 }));
```

**Step 2: Test server starts**

Run: `cd server && node index.js`
Expected: Server starts on port 3000, database created, admin seeded.

**Step 3: Commit**

```bash
git add server/index.js
git commit -m "feat: wire up Express server with all routes and security middleware"
```

---

### Task 11: Vite + Tailwind Configuration

**Files:**
- Create: `client/vite.config.js`
- Create: `client/tailwind.config.js`
- Create: `client/postcss.config.js`
- Create: `client/src/styles/index.css`
- Create: `client/index.html`
- Create: `client/src/main.jsx`

**Step 1: Configure Vite with proxy to Express**

```js
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000'
    }
  }
});
```

**Step 2: Configure Tailwind with CUNY AI Lab design tokens**

```js
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        'cail-navy': '#1D3A83',
        'cail-blue': '#3B73E6',
        'cail-teal': '#2FB8D6',
        'cail-azure': '#2A6FB8',
        'cail-dark': '#0F172A',
        'cail-cream': '#FAFCF8',
        'cail-stone': '#333333',
      },
      fontFamily: {
        display: ['Outfit', 'system-ui', 'sans-serif'],
        body: ['Inter', 'system-ui', 'sans-serif'],
      }
    }
  }
};
```

**Step 3: Create entry CSS with Tailwind directives and Google Fonts import**

**Step 4: Create index.html and main.jsx React entry**

**Step 5: Verify dev server starts**

Run: `cd client && npm run dev`
Expected: Vite dev server on 5173, proxying API to 3000.

**Step 6: Commit**

```bash
git add client/
git commit -m "feat: scaffold React/Vite client with Tailwind and CUNY AI Lab design tokens"
```

---

### Task 12: API Client & Auth Context

**Files:**
- Create: `client/src/api/client.js`
- Create: `client/src/api/auth.js`
- Create: `client/src/context/AuthContext.jsx`

**Step 1: Create API client wrapper**

`client/src/api/client.js` — thin fetch wrapper with JSON parsing, error handling, credentials: 'same-origin'.

**Step 2: Create auth API functions**

`client/src/api/auth.js` — `login(email, password)`, `register(email, password)`, `logout()`, `getMe()`.

**Step 3: Create AuthContext**

React context providing: user, login, logout, register, loading state. Wraps the app, checks `/api/auth/me` on mount.

**Step 4: Commit**

```bash
git add client/src/api/ client/src/context/
git commit -m "feat: add API client and auth context"
```

---

### Task 13: Layout Shell (Header, Footer, Router)

**Files:**
- Create: `client/src/App.jsx`
- Create: `client/src/components/Header.jsx`
- Create: `client/src/components/Footer.jsx`
- Create: `client/src/components/ProtectedRoute.jsx`

**Step 1: Create Header**

Glassmorphic sticky header (`bg-white/95 backdrop-blur-md`):
- Manifold logo + "CAIL OCR Manifold Companion" title
- Nav links: Dashboard, (Admin if admin role)
- User email + Logout button
- Mobile hamburger menu

**Step 2: Create Footer**

Replicate CUNY AI Lab footer:
- Dark charcoal (#333) background with noise texture
- Copyright: "© 2026 CUNY AI Lab"
- Partner logos: GC CUNY, GCDI, TLC, Mina Rees Library, ASHP (with links)
- Manifold logo
- All logos with opacity-60 hover:opacity-100

We'll use the partner logo image files from the CUNY AI Lab website (copy them to client/public/images/partners/).

**Step 3: Create App.jsx with React Router**

Routes:
- `/login` — LoginPage
- `/register` — RegisterPage
- `/` — Dashboard (protected)
- `/projects/:id` — ProjectView (protected)
- `/texts/:id` — TextDetail (protected)
- `/admin` — AdminPanel (protected, admin only)

**Step 4: Create ProtectedRoute wrapper**

Redirects to /login if not authenticated. Redirects non-admin from /admin.

**Step 5: Commit**

```bash
git add client/src/App.jsx client/src/components/
git commit -m "feat: add layout shell with header, footer, and routing"
```

---

### Task 14: Login & Register Pages

**Files:**
- Create: `client/src/pages/LoginPage.jsx`
- Create: `client/src/pages/RegisterPage.jsx`

**Step 1: Create LoginPage**

Centered card on cream background. Email + password fields. Submit button (pill, cail-blue). Error display. Link to register.

**Step 2: Create RegisterPage**

Same layout. Email + password + confirm password. Submit creates pending account. Success message: "Account created. Awaiting admin approval."

**Step 3: Commit**

```bash
git add client/src/pages/LoginPage.jsx client/src/pages/RegisterPage.jsx
git commit -m "feat: add login and register pages"
```

---

### Task 15: Dashboard Page

**Files:**
- Create: `client/src/pages/Dashboard.jsx`
- Create: `client/src/api/projects.js`

**Step 1: Create projects API**

`client/src/api/projects.js` — `getProjects()`, `createProject(name, description, language)`, `deleteProject(id)`.

**Step 2: Create Dashboard**

- "Your Projects" heading
- "New Project" button → modal with name, description, default language dropdown
- Grid of project cards:
  - Project name, description
  - Text count, storage used
  - Expiry date (days remaining)
  - Status badges
  - Click → navigate to `/projects/:id`
- Storage usage bar showing used/50MB

**Step 3: Commit**

```bash
git add client/src/pages/Dashboard.jsx client/src/api/projects.js
git commit -m "feat: add dashboard with project cards and creation"
```

---

### Task 16: Project View Page

**Files:**
- Create: `client/src/pages/ProjectView.jsx`
- Create: `client/src/api/texts.js`
- Create: `client/src/components/FileUpload.jsx`
- Create: `client/src/components/PdfProcessor.jsx`

**Step 1: Create texts API**

`client/src/api/texts.js` — `getTexts(projectId)`, `createText(projectId, name)`, `deleteText(id)`, `uploadImages(textId, files)`, etc.

**Step 2: Create FileUpload component**

Drag-and-drop zone + file picker. Accepts images and PDFs. For images > 3.5MB: browser-side canvas resize. Shows upload progress.

**Step 3: Create PdfProcessor component**

Uses pdf.js to:
1. Load PDF in browser
2. Render each page to canvas
3. Export as JPEG
4. Return array of Blob files for upload

Shows progress: "Processing page 3 of 12..."

**Step 4: Create ProjectView page**

- Project name + description (editable)
- "Add Text" button → name input
- Drag-and-drop upload area (creates text automatically from uploaded files)
- List of texts with status, page count, action buttons
- "Export to Manifold" button
- Project settings (default language dropdown)

**Step 5: Commit**

```bash
git add client/src/pages/ProjectView.jsx client/src/api/texts.js client/src/components/FileUpload.jsx client/src/components/PdfProcessor.jsx
git commit -m "feat: add project view with text management and browser-side file processing"
```

---

### Task 17: Text Detail Page

**Files:**
- Create: `client/src/pages/TextDetail.jsx`
- Create: `client/src/components/PageGrid.jsx`
- Create: `client/src/components/FullTextEditor.jsx`
- Create: `client/src/components/ReviewView.jsx`
- Create: `client/src/components/MetadataEditor.jsx`
- Create: `client/src/components/SummaryPanel.jsx`
- Create: `client/src/components/TranslationPanel.jsx`

**Step 1: Create TextDetail page shell with tabs**

Tabs: Pages, Full Text, Review, Details. Adapted from Lalli's tab structure but as React components.

**Step 2: Create PageGrid component**

Thumbnail grid of uploaded scans. Click to view in lightbox. Shows OCR status per page. "Run OCR" button to process all/individual pages.

**Step 3: Create FullTextEditor component**

- Markdown editor (textarea) with toolbar (bold, italic, heading, etc.)
- "Save" button
- Language toggle dropdown: shows original or translated text
- Renders preview using marked.js + DOMPurify

**Step 4: Create ReviewView component**

Side-by-side: image on left, editable OCR text on right. Navigate between pages with keyboard arrows. Pan/zoom on image.

**Step 5: Create MetadataEditor component**

Dublin Core 15-field form. Auto-save on blur.

**Step 6: Create SummaryPanel component**

- Displays summary text (editable textarea)
- "Generate with AI" button (calls Bedrock)
- "Save" button for manual edits
- Clear distinction: editing works without AI, generation is optional

**Step 7: Create TranslationPanel component**

- Target language dropdown (en, es, fr, de, it, pt, zh, ja, ko, ar)
- Displays translation text (editable textarea)
- "Generate with AI" button
- "Save" button for manual edits

**Step 8: Commit**

```bash
git add client/src/pages/TextDetail.jsx client/src/components/
git commit -m "feat: add text detail page with all tab components"
```

---

### Task 18: OCR Processing UI

**Files:**
- Modify: `client/src/pages/TextDetail.jsx`
- Create: `client/src/hooks/useSSE.js`

**Step 1: Create SSE hook**

`useSSE(url)` — connects to SSE endpoint, provides: progress, status, error, isProcessing. Handles reconnection and cleanup.

**Step 2: Wire OCR into TextDetail**

- "Run OCR" button triggers SSE connection to `/api/texts/:id/ocr`
- Progress bar shows page-by-page progress
- Live updates as each page completes
- Error handling for failed pages
- Auto-refresh page grid and full text on completion

**Step 3: Commit**

```bash
git add client/src/hooks/useSSE.js client/src/pages/TextDetail.jsx
git commit -m "feat: add OCR processing UI with SSE progress"
```

---

### Task 19: Admin Panel

**Files:**
- Create: `client/src/pages/AdminPanel.jsx`
- Create: `client/src/api/admin.js`

**Step 1: Create admin API**

`client/src/api/admin.js` — `getUsers()`, `approveUser(id)`, `disableUser(id)`, `deleteUser(id)`.

**Step 2: Create AdminPanel page**

- User management table: email, status (with colored badge), role, storage used, project count, last login, created
- Action buttons: Approve (for pending), Disable, Delete
- Confirmation dialogs for destructive actions
- System stats: total users, total storage used, pending approvals count

**Step 3: Commit**

```bash
git add client/src/pages/AdminPanel.jsx client/src/api/admin.js
git commit -m "feat: add admin panel with user management"
```

---

### Task 20: Manifold Export UI

**Files:**
- Modify: `client/src/pages/ProjectView.jsx`
- Create: `client/src/components/ExportModal.jsx`

**Step 1: Create ExportModal**

- Select texts to include (checkboxes)
- Metadata fields: title, creators, date, language, rights, description
- "Export ZIP" button → POST to export route → download ZIP
- Progress indicator during generation

**Step 2: Wire into ProjectView**

"Export to Manifold" button opens ExportModal.

**Step 3: Commit**

```bash
git add client/src/pages/ProjectView.jsx client/src/components/ExportModal.jsx
git commit -m "feat: add Manifold export UI"
```

---

### Task 21: Partner Assets & Manifold Logo

**Files:**
- Create: `client/public/images/partners/` (copy logos from CUNY AI Lab site)
- Create: `client/public/images/manifold-logo.svg`

**Step 1: Copy partner logos from CUNY AI Lab website**

Copy these files from `/Users/veritas44/Downloads/github/CUNY-AI-Lab-website/public/images/partners/`:
- `gc-logo-white.png`
- `logo-gcdi.png`
- `TLC-Logo-v4-No-GC-white.png`
- `MRS_logo_One_Search.png`
- `ashp-logo-blue.png`

**Step 2: Create Manifold logo SVG**

Create a simple SVG based on Manifold's branding (green "M" mark). This will be used in the header and footer.

**Step 3: Commit**

```bash
git add client/public/images/
git commit -m "feat: add partner logos and Manifold branding"
```

---

### Task 22: Security Hardening & Production Config

**Files:**
- Modify: `server/index.js`
- Create: `server/middleware/security.js`

**Step 1: Create security middleware**

`server/middleware/security.js`:
- Content Security Policy configuration (allow self, fonts.googleapis.com, fonts.gstatic.com)
- Input sanitization helper
- File path traversal prevention

**Step 2: Review and harden all routes**

- Verify all routes check ownership (user can only access their own projects/texts)
- Verify all file paths are sanitized (no path traversal)
- Verify upload filenames are sanitized
- Verify rate limiting on sensitive endpoints
- Verify no credentials leak in error messages

**Step 3: Add production static file serving**

In `server/index.js`, serve `../client/dist` for production, with SPA fallback to index.html.

**Step 4: Commit**

```bash
git add server/middleware/security.js server/index.js
git commit -m "feat: add security hardening and production static serving"
```

---

### Task 23: Test with Sample Data

**Step 1: Start both servers**

Run: `npm run dev`

**Step 2: Test admin login**

Login with `veritas44@gmail.com` / `gremlins2025`. Verify dashboard loads.

**Step 3: Create a test project**

Create "Lalli Archive" project with Italian as source language.

**Step 4: Upload test images**

Copy a few images from the Lalli project's "Gli spiriti in casa" folder. Upload via the UI.

**Step 5: Run OCR**

Trigger OCR on the uploaded text. Verify SSE progress works. Verify OCR results display.

**Step 6: Test summary and translation**

Generate a summary. Generate a translation to English. Edit both manually.

**Step 7: Test export**

Export the project as a Manifold ZIP. Verify the ZIP contains manifest.yml and content files.

**Step 8: Test user management**

Register a new user. Verify they're pending. Approve from admin panel. Verify they can log in.

**Step 9: Commit any fixes**

```bash
git add -A
git commit -m "fix: address issues found during integration testing"
```

---

### Task 24: Build & Deployment Preparation

**Step 1: Build client**

Run: `cd client && npm run build`
Verify: `dist/` directory created with index.html and assets.

**Step 2: Test production mode**

Run: `cd server && NODE_ENV=production node index.js`
Verify: serves client from dist, all routes work.

**Step 3: Create a simple systemd service file for Debian**

Create `deploy/manifold-companion.service`:
```ini
[Unit]
Description=CAIL OCR Manifold Companion
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/manifold-companion
ExecStart=/usr/bin/node server/index.js
Environment=NODE_ENV=production
Restart=always

[Install]
WantedBy=multi-user.target
```

**Step 4: Final commit**

```bash
git add -A
git commit -m "chore: add production build and deployment config"
```
