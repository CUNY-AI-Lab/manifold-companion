# Batch 2: Dark Mode, User Settings, Pagination, Bulk Text Operations

**Date**: 2026-03-15
**Scope**: Four features adding theme support, a settings page, paginated lists, and multi-select text operations.

---

## 1. Dark Mode

### Problem
The app has no dark mode. Users working in low-light environments strain their eyes on the bright cream/white UI.

### Solution
Class-based Tailwind dark mode with user preference stored in the database. Three modes: system (default), light, dark.

### Database
Add column to `users` table (following existing migration pattern in `db.js` — wrapped in try/catch):
```sql
ALTER TABLE users ADD COLUMN theme_preference TEXT NOT NULL DEFAULT 'system'
  CHECK(theme_preference IN ('system', 'light', 'dark'));
```

### Server
- `GET /api/auth/me` — include `theme_preference` in response
- `PUT /api/auth/profile` — accept and validate `theme_preference` (must be one of `system`, `light`, `dark`). Currently only accepts `display_name` — extend the handler.

### Client

**Tailwind config** (`tailwind.config.js`):
- Add `darkMode: 'class'`

**Dark palette** (Slate scale, brand accents unchanged):
| Role | Light | Dark |
|------|-------|------|
| Background | `#FAFCF8` (cail-cream) | `#0F172A` (cail-dark / slate-900) |
| Surface (cards, header) | `#FFFFFF` | `#1e293b` (slate-800) |
| Borders | `#e5e7eb` (gray-200) | `#334155` (slate-700) |
| Primary text | `#0F172A` (cail-dark) | `#e2e8f0` (slate-200) |
| Muted text | `#6b7280` (gray-500) | `#94a3b8` (slate-400) |
| Brand blue | `#3B73E6` | `#3B73E6` (unchanged) |
| Brand teal | `#2FB8D6` | `#2FB8D6` (unchanged) |

**AuthContext**: Store `themePreference` from `/me` response. Expose `updateTheme(pref)` that calls `PUT /api/auth/profile` and applies the `dark` class to `<html>`. On mount, apply theme: if `'system'`, use `window.matchMedia('(prefers-color-scheme: dark)')`. Add a listener for system preference changes.

**Header.jsx**: Sun/moon toggle button. Clicking cycles system → light → dark. Tooltip shows current mode.

**All pages/components**: Add `dark:` Tailwind variants. The main classes to apply across the app:
- Backgrounds: `bg-white dark:bg-slate-800`, `bg-gray-50 dark:bg-slate-900`, `bg-cail-cream dark:bg-cail-dark`
- Text: `text-gray-900 dark:text-slate-200`, `text-gray-500 dark:text-slate-400`
- Borders: `border-gray-200 dark:border-slate-700`
- Inputs: `bg-white dark:bg-slate-700 border-gray-300 dark:border-slate-600`

**Special areas**:
- Markdown preview: rendered HTML uses Tailwind prose classes — add `dark:prose-invert`
- KaTeX math: renders with black text by default — set `color: inherit` on `.katex` in dark mode
- Contenteditable HTML editor: user-generated HTML may have hardcoded colors; wrap the editor in a container that forces text color inheritance where possible, accept that some user content will have light-on-light issues
- Status badges and progress bars: use brand colors (blue, teal) which have sufficient contrast on both backgrounds

**Pre-login fallback**: Before authentication, read `localStorage` for last-used theme preference to avoid flash-of-wrong-theme on page load.

---

## 2. User Settings Page

### Problem
Users have no central place to manage their profile, password, notification preferences, or view usage. Notification email toggles are buried in the notification bell dropdown.

### Solution
New `/settings` page with five sections: Profile, Password, Appearance, Notifications, Usage.

### Files
- **New**: `client/src/pages/SettingsPage.jsx`
- **Modified**: `client/src/App.jsx` — add `/settings` route
- **Modified**: `client/src/components/Header.jsx` — add Settings link
- **Modified**: `server/routes/auth.js` — extend `PUT /api/auth/profile` for theme (Section 1), add `PUT /api/auth/settings` for notification prefs
- **Modified**: `server/db.js` — export `getNotificationPreferences()`, `updateNotificationPreferences()` if not already exported

### Sections

**Profile**:
- Display name — editable text input, save button
- Email — read-only display
- Uses existing `PUT /api/auth/profile`

**Password**:
- Current password, new password, confirm new password fields
- Uses existing `POST /api/auth/change-password`
- Show success/error inline

**Appearance**:
- Dark mode — three radio buttons: System, Light, Dark
- Saves via `PUT /api/auth/profile` (same endpoint as header toggle and display name)

**Notifications**:
- Four toggles with labels:
  - "OCR complete" — email when OCR processing finishes
  - "Project shared" — email when someone shares a project with you
  - "Comment replies" — email when someone replies to your comment
  - "@Mentions" — email when someone mentions you
- Uses `PUT /api/auth/settings` to update `notification_preferences`
- Both the settings page and the bell dropdown gear icon write to the same DB table

**Usage**:
- Token usage — progress bar showing `token_usage / token_allowance`, percentage label
- Storage — progress bar showing `storage_used / 50MB`
- Both read-only, informational
- Storage comes from `/me` response. Use the cached value from `refreshUserStorage()` (already tracked in DB) instead of calling `calculateUserStorage()` on every `/me` request to avoid disk I/O on a frequently-called endpoint. Refresh the cached value when files are uploaded or deleted.

### API

`PUT /api/auth/settings`:
```json
{
  "notification_preferences": {
    "email_ocr_complete": false,
    "email_comment_reply": true
  }
}
```
Partial updates — only provided keys are changed.

Settings page composes its data from:
- `GET /api/auth/me` — theme, token usage, storage, display name, email
- Notification prefs fetched via `GET /api/auth/settings` (returns `notification_preferences` object)

---

## 3. Pagination

### Problem
All project and text lists load everything at once. This works now but won't scale, and provides no sense of collection size.

### Solution
Server-side pagination with traditional page buttons. 12 projects per page on dashboard, 20 texts per page in project views.

### Database
Modify existing query functions:

- `getProjectsByUser(userId, limit, offset)` — add `LIMIT ? OFFSET ?`, return total via `SELECT COUNT(*)`
- `getSharedProjectsByUser(userId, limit, offset)` — same pattern
- `getTextsByProject(projectId, limit, offset)` — same pattern

### API

**`GET /api/projects?page=1&limit=12&sharedPage=1&sharedLimit=12`**:
```json
{
  "projects": [...],
  "shared": [...],
  "total": 45,
  "totalShared": 8,
  "page": 1,
  "pageSize": 12,
  "sharedPage": 1,
  "sharedPageSize": 12
}
```

Owned and shared projects have independent pagination cursors. Both default to page 1, limit 12.

**`GET /api/projects/:id?page=1&limit=20`**:
```json
{
  "id": 1,
  "name": "...",
  "texts": [...],
  "totalTexts": 67,
  "page": 1,
  "pageSize": 20
}
```

The existing route already fetches texts separately via `getTextsByProject()` — pagination params only affect the texts array, not the project fields.

**Validation**:
- `page` must be ≥ 1 (default 1)
- `limit` must be 1–100 (default 12 for projects, 20 for texts)
- If `page` exceeds total pages, return empty results with correct `total` (not an error)

Query params are optional — if omitted, return all results (backward compatible).

**URL state**: Current page is reflected in the URL query string (`?page=2`) so it survives browser refresh and can be shared/bookmarked.

### Client

**New**: `client/src/components/Pagination.jsx`

Props: `currentPage`, `totalPages`, `onPageChange`, `totalItems`, `pageSize`

Renders: `< Prev  1  2  3  ...  10  Next >`
- Disable Prev on page 1, Next on last page
- Show first page, last page, and 2 pages around current
- Ellipsis for gaps
- Item count label: "Showing 1-12 of 45"
- On mobile: collapse to just Prev/Next + "Page N of M"

**Dashboard.jsx**: Add pagination state for both owned and shared sections, pass `page`/`sharedPage` params to API call, render `<Pagination>` below each grid.

**ProjectView.jsx**: Add pagination state for text list, pass to API, render `<Pagination>` below text cards.

**PdfProjectView.jsx**: Same as ProjectView.

---

## 4. Bulk Text Operations

### Problem
Users must delete or update text status one at a time. Tedious for projects with many texts.

### Solution
Multi-select checkboxes on text cards with a floating action bar for bulk delete and status change.

### API

**`POST /api/projects/:projectId/texts/bulk-delete`**:
- Body: `{ textIds: [1, 2, 3] }`
- Max 50 IDs per request
- Verifies all IDs belong to the project
- Requires editor+ role
- Uses database transaction
- Deletes files from disk using `result.project.user_id` for file paths (same pattern as single-text delete — files live in the owner's directory)
- Returns `{ deleted: 3 }`
- Show loading spinner on action bar during operation

**`POST /api/projects/:projectId/texts/bulk-status`**:
- Body: `{ textIds: [1, 2, 3], status: "reviewed" }`
- Status must be one of: `pending`, `ocrd`, `reviewed` (excludes `processing` — that is a transient status set only by the OCR pipeline)
- Max 50 IDs per request
- Verifies all IDs belong to the project
- Requires editor+ role
- Uses database transaction
- Returns `{ updated: 3 }`

### Files
- **Modified**: `server/routes/texts.js` — add two bulk endpoints
- **Modified**: `server/db.js` — add `bulkDeleteTexts()`, `bulkUpdateTextStatus()`
- **Modified**: `client/src/pages/ProjectView.jsx` — checkboxes, selection state, floating action bar
- **Modified**: `client/src/pages/PdfProjectView.jsx` — same

### Client UI

**Selection state**: `selectedTextIds` Set in component state. Checkbox on each text card (top-left corner). Only visible to editor+ roles.

**Floating action bar**: Fixed to bottom of viewport when `selectedTextIds.size > 0`. Contains:
- Left: "N selected" label, "Select All" / "Deselect All" button
- Right: "Set Status" dropdown (pending/ocrd/reviewed), "Delete" button (red)
- Shows loading spinner during bulk operations

**Delete confirmation**: Modal dialog — "Delete N texts? This cannot be undone." with Cancel/Delete buttons.

**Status change**: Immediate on dropdown selection, no confirmation needed.

**Pagination interaction**: Selecting texts applies to current page only. Navigating to a different page clears selection.

---

## Out of Scope

- Batch 3: Onboarding, accessibility audit, HTML editor text color, improved keyboard shortcuts
- Dark mode for the About page (it has custom styling — follow-up)
- Infinite scroll or virtual lists
- Bulk move texts between projects
