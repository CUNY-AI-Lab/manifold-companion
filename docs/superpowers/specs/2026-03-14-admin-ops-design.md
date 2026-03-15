# Admin/Ops Features Design Spec

**Date**: 2026-03-14
**Scope**: User display names, API usage tracking with token allowances, bulk user approval, backup/restore

---

## 1. User Display Names

### 1.1 Schema

Add `display_name TEXT` to the `users` table (nullable). When null or empty, the UI falls back to the email prefix (everything before `@`).

```sql
ALTER TABLE users ADD COLUMN display_name TEXT;
```

### 1.2 Server Changes

**`server/db.js`**:
- `createUser()` accepts optional `displayName` parameter
- `updateUserDisplayName(id, displayName)` — new function
- All JOIN queries that return `user_email` also return `user_display_name`:
  - `getProjectShares()` → adds `u.display_name`
  - `getAnnotationsByText()` → adds `u.display_name`
  - `getAnnotationReplies()` → adds `u.display_name`
  - `getTextVersions()` → adds `u.display_name`
- `getAllUsers()` → includes `display_name`
- `searchUsers(query)` — new function for share autocomplete: `WHERE (email LIKE ? OR display_name LIKE ?) AND status = 'approved'`, returns `{id, email, display_name}`, limited to 10 results

**`server/routes/auth.js`**:
- `POST /api/auth/register` — accepts optional `name` field, passes to `createUser()`
- `GET /api/auth/me` — returns `display_name` in user object
- `PUT /api/auth/profile` — new endpoint: updates `display_name` for the current user (max 100 chars, trimmed)

**`server/routes/admin.js`**:
- `POST /api/admin/users` — accepts optional `name` field
- `PUT /api/admin/users/:id/name` — new endpoint: admin can set any user's display name

**`server/routes/users.js`** (new file):
- `GET /api/users/search?q=...` — authenticated (not admin-only), returns matching users for share autocomplete. Min 2 chars, max 50 chars, returns `[{id, email, display_name}]` limited to 10. Requires `requireAuth`.

**`server/index.js`**: Mount `usersRoutes` at `/api/users`.

### 1.3 Client Changes

**`AuthContext`**: Store and expose `display_name` from `/me` response.

**`RegisterPage.jsx`**: Add optional "Full Name" field.

**`Header.jsx`**: Show display name (or email prefix) instead of raw email if available.

**`AnnotationSidebar.jsx`**: Use `annotation.user_display_name || annotation.user_email` for display. Initials derived from display name when available.

**`SharePanel.jsx`**:
- Replace email input with an autocomplete input that calls `GET /api/users/search?q=...`
- Show dropdown of matching users (name + email)
- On select, populate the share target
- Share list shows display name with email in smaller text

**`VersionHistory.jsx`**: Show `version.user_display_name || version.user_email`.

**`AdminPanel.jsx`**: Show display name column (editable inline or via modal).

---

## 2. API Usage Tracking & Token Allowances

### 2.1 Schema

New table for logging every AI API call:

```sql
CREATE TABLE IF NOT EXISTS api_usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL,
  model TEXT,
  project_id INTEGER,
  text_id INTEGER,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_api_usage_user ON api_usage_logs(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_api_usage_project ON api_usage_logs(project_id);
```

Add to `users` table:

```sql
ALTER TABLE users ADD COLUMN token_allowance INTEGER NOT NULL DEFAULT 5000000;
ALTER TABLE users ADD COLUMN token_usage_reset_at TEXT;
```

`token_usage_reset_at` — when set, only logs after this timestamp count toward the allowance. This lets admins "reset" a user's usage without deleting historical data.

### 2.2 Server — Logging

**`server/db.js`**:
- `logApiUsage(userId, endpoint, model, projectId, textId, tokensIn, tokensOut)` — insert into `api_usage_logs`
- `getUserTokenUsage(userId)` — `SUM(tokens_in + tokens_out)` from `api_usage_logs` where `user_id = ?` and `created_at > COALESCE(token_usage_reset_at, '1970-01-01')` (joins users table for reset date)
- `getUsageStats(days?)` — aggregated stats for dashboard
- `getUsageByUser(userId, days?)` — per-user breakdown
- `getUsageByProject(days?)` — most active projects
- `updateUserTokenAllowance(id, allowance)` — set per-user allowance
- `resetUserTokenUsage(id)` — sets `token_usage_reset_at = datetime('now')`

**Logging call sites** — after each successful API response, extract token counts and call `logApiUsage()`:

| File | Endpoint | Model source |
|------|----------|-------------|
| `server/services/bedrock.js` → `extractText()` | `ocr` | Response `usage.input_tokens` / `output_tokens` |
| `server/routes/llm.js` → summary | `summary` | Bedrock response usage |
| `server/routes/llm.js` → translation | `translation` | Bedrock response usage |
| `server/services/openrouter.js` → `parsePdfPageToHtml()` | `pdf-parse` | OpenRouter response `usage.prompt_tokens` / `completion_tokens` |
| `server/services/openrouter.js` → `cleanupPdfHtml()` | `pdf-cleanup` | OpenRouter response `usage.prompt_tokens` / `completion_tokens` |

Both Bedrock and OpenRouter return token counts in their responses. Bedrock uses `usage.inputTokens`/`outputTokens` (varies by model family); OpenRouter uses standard OpenAI format `usage.prompt_tokens`/`completion_tokens`.

### 2.3 Server — Enforcement

**`server/middleware/tokenQuota.js`** (new file):

```js
export function checkTokenQuota(req, res, next) {
  const usage = getUserTokenUsage(req.user.id);
  const user = getUserById(req.user.id);
  if (usage >= user.token_allowance) {
    return res.status(429).json({
      error: 'Token allowance exceeded',
      usage,
      allowance: user.token_allowance
    });
  }
  next();
}
```

Applied to: OCR route, summary/translation endpoints, PDF parse/cleanup endpoints. Placed after `requireAuth` and before the handler.

### 2.4 Server — Admin Endpoints

Add to `server/routes/admin.js`:

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/usage` | Dashboard stats: storage per user, API calls by endpoint/time, total tokens, most active projects. Query params: `days` (default 30) |
| GET | `/api/admin/usage/:userId` | Per-user usage detail |
| PUT | `/api/admin/users/:id/token-allowance` | Set `token_allowance` for a user |
| POST | `/api/admin/users/:id/reset-usage` | Set `token_usage_reset_at = now()` |

### 2.5 Client — User-Facing

**`Header.jsx`** or a new **profile dropdown**: Show remaining tokens as a small indicator (e.g., "4.2M / 5M tokens"). Color codes: green (>50%), yellow (25-50%), red (<25%).

**Error handling**: When a 429 with `error: 'Token allowance exceeded'` is received, show a clear message: "You've used your token allowance. Contact an admin for more."

### 2.6 Client — Admin Usage Dashboard

New tab in `AdminPanel.jsx`: **"Usage"** tab alongside the existing user management.

Shows:
- **Summary cards**: Total API calls (30d), total tokens consumed (30d), total storage used
- **Storage table**: Per-user storage breakdown (already partially shown, but now as a dedicated view)
- **API calls table**: Per-user call counts and token usage, with allowance and percentage used
- **Most active projects**: Top 10 by API call count
- **Endpoint breakdown**: Calls by type (OCR, summary, translation, PDF parse, PDF cleanup)

Admin can click a user row to see their detailed usage and adjust their token allowance.

---

## 3. Bulk User Approval

### 3.1 Server

**`server/routes/admin.js`**:
- `PUT /api/admin/users/bulk-status` — accepts `{ userIds: number[], status: 'approved' | 'disabled' }`. Validates all IDs exist, prevents self-modification, updates all in a transaction. Returns `{ updated: number }`.

**`server/db.js`**:
- `bulkUpdateUserStatus(userIds, status)` — runs in a transaction: `UPDATE users SET status = ? WHERE id IN (...)`.

### 3.2 Client

**`AdminPanel.jsx`**:
- Add checkbox column to user table
- "Select all pending" button (selects only users with `status === 'pending'`)
- "Approve Selected" and "Disable Selected" action buttons (shown when checkboxes are active)
- Count badge showing number selected
- Confirmation before bulk action
- Clear selection after successful bulk operation

---

## 4. Backup/Restore

### 4.1 Server

**`server/routes/admin.js`** (additional endpoints):

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/admin/backups` | Create a backup |
| GET | `/api/admin/backups` | List available backups |
| GET | `/api/admin/backups/:filename` | Download a backup file |
| DELETE | `/api/admin/backups/:filename` | Delete a backup |
| POST | `/api/admin/backups/restore` | Restore from uploaded backup |

**Backup process** (`POST /api/admin/backups`):
1. Create `data/backups/` directory if not exists
2. Use better-sqlite3's `.backup()` API to safely copy `manifold.db` to `data/backups/manifold-{timestamp}.db`
3. Copy `sessions.db` similarly
4. Create a tar.gz of `data/` (excluding `data/backups/`) into `data/backups/backup-{timestamp}.tar.gz`
5. Clean up the temporary `.db` copies
6. Return `{ filename, size, created_at }`

**Restore process** (`POST /api/admin/backups/restore`):
1. Accept multipart upload of a `.tar.gz` file
2. Validate: must contain `manifold.db` and expected directory structure
3. Extract to a temp directory first, verify integrity
4. Warn admin this will overwrite current data and requires restart
5. Extract over `data/`
6. Return success with restart instruction

**List/Download/Delete**: Standard file operations on `data/backups/`.

**Filename validation**: `sanitizeFilename()` applied to all backup filename params — prevent path traversal.

### 4.2 Client

**`AdminPanel.jsx`** — new **"Backups"** tab:
- "Create Backup" button with loading state (backups may take time)
- Table of existing backups: filename, size (human-readable), date, download button, delete button
- Restore section: file upload dropzone with prominent warning ("This will overwrite all current data. The server must be restarted after restore.")
- Confirmation modal before restore

---

## Files Summary

### New files (3)
| File | Purpose |
|------|---------|
| `server/routes/users.js` | User search endpoint for autocomplete |
| `server/middleware/tokenQuota.js` | Token allowance enforcement middleware |
| `docs/superpowers/specs/2026-03-14-admin-ops-design.md` | This spec |

### Modified files (15)
| File | Changes |
|------|---------|
| `server/db.js` | `api_usage_logs` table, `display_name`/`token_allowance`/`token_usage_reset_at` columns, ~15 new functions |
| `server/index.js` | Mount users routes |
| `server/routes/admin.js` | Usage dashboard, bulk status, token allowance, backup/restore endpoints, display name edit |
| `server/routes/auth.js` | Profile endpoint, name in register, name in /me |
| `server/routes/ocr.js` | Token quota check, log usage after OCR |
| `server/routes/llm.js` | Token quota check, log usage after summary/translation/PDF calls |
| `server/services/bedrock.js` | Return token usage from API responses |
| `server/services/openrouter.js` | Return token usage from API responses |
| `client/src/context/AuthContext.jsx` | Expose display_name |
| `client/src/pages/AdminPanel.jsx` | Usage tab, backups tab, bulk approval, name column, token allowance controls |
| `client/src/pages/RegisterPage.jsx` | Name field |
| `client/src/pages/LoginPage.jsx` | No changes needed |
| `client/src/components/Header.jsx` | Show name, token usage indicator |
| `client/src/components/AnnotationSidebar.jsx` | Use display_name |
| `client/src/components/SharePanel.jsx` | Autocomplete with user search |
| `client/src/components/VersionHistory.jsx` | Use display_name |
