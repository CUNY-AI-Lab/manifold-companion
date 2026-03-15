# Batch 1: Quick Wins — 404 Page, Loading Skeletons, Auto-Save Drafts, Drag-and-Drop

**Date**: 2026-03-15
**Scope**: Four independent UI improvements requiring no new API endpoints.

---

## 1. 404 Page

### Problem
Unknown routes render a blank screen. Users who mistype a URL or follow a stale link see nothing.

### Solution
Create `NotFoundPage.jsx` with a styled message, the current path, and a link back to the dashboard. Register it as `<Route path="*" />` at the end of the route list in `App.jsx`, inside `ProtectedRoute` so unauthenticated users redirect to login first.

### Files
- **New**: `client/src/pages/NotFoundPage.jsx`
- **Modified**: `client/src/App.jsx` — add catch-all route

### Behavior
- Displays a clear "Page not found" heading with the attempted path
- Shows a "Back to Dashboard" link
- Matches existing page styling (Tailwind, `cail-*` tokens)

---

## 2. Loading Skeletons

### Problem
Dashboard, project views, and admin panel show a bare spinner while data loads. This provides no spatial hint about what will appear.

### Solution
Create a reusable `Skeleton.jsx` component that renders `animate-pulse` placeholder shapes. Replace spinners with skeleton layouts matching the actual content structure.

### Files
- **New**: `client/src/components/Skeleton.jsx`
- **Modified**: `client/src/pages/Dashboard.jsx` — skeleton project cards
- **Modified**: `client/src/pages/ProjectView.jsx` — skeleton text rows
- **Modified**: `client/src/pages/PdfProjectView.jsx` — skeleton text rows
- **Modified**: `client/src/pages/AdminPanel.jsx` — skeleton table rows

### Component API
```jsx
// Primitives
<Skeleton.Box className="h-4 w-32" />   // rectangle
<Skeleton.Circle className="h-10 w-10" /> // circle

// Composites
<Skeleton.Card />       // matches project card layout
<Skeleton.TextRow />    // matches text list item
<Skeleton.TableRow cols={5} /> // matches admin table row
```

All primitives use `animate-pulse` with `bg-gray-200 rounded` styling.

### Behavior
- Show 3-6 skeleton cards/rows during loading (enough to fill typical viewport)
- Swap to real content once data arrives
- No layout shift — skeletons match the dimensions of real content

---

## 3. Auto-Save Drafts + Unsaved Changes Guard

### Problem
Users lose work if they accidentally close the tab, navigate away, or the browser crashes while editing. No warning is shown before leaving with unsaved changes.

### Solution
Three layers of protection:

1. **Debounced localStorage drafts**: Save editor content to `localStorage` every 5 seconds when content changes. Key format: `mc-draft-{textId}-{type}` where type is `compiled` or `html`.

2. **Draft recovery banner**: On mount, check for a draft. If one exists and is newer than the server content's `updated_at`, show a dismissible banner: "Unsaved draft found from [relative time]. **Restore** | **Dismiss**". Restore loads the draft; Dismiss clears it. A successful API save clears the draft.

3. **Leave guard**: When editor content differs from the last saved state:
   - `beforeunload` event prevents tab close with browser-native confirmation
   - In-app navigation guard via `window.onpopstate` interception — when `isDirty` is true and the user clicks a link or uses browser back, show a styled confirmation modal: "You have unsaved changes. Leave anyway? **Stay** | **Leave**". The app uses `BrowserRouter` (not data router), so `useBlocker` is unavailable. Instead, wrap navigation by intercepting link clicks on `[data-navigate]` or using a custom `useUnsavedChanges` hook that listens to `popstate`.

### Files
- **Modified**: `client/src/pages/TextDetail.jsx` — draft save/restore, leave guard in Review tab
- **Modified**: `client/src/pages/HtmlTextDetail.jsx` — draft save/restore, leave guard in Review tab

### Details
- Draft key includes text ID to avoid cross-text collisions
- `savedContentRef` tracks the last successfully saved content for dirty detection
- `beforeunload` listener is added/removed based on `isDirty` state
- In-app navigation guard uses `popstate` event interception (compatible with `BrowserRouter`); does not require migration to data router API
- Drafts older than 7 days are ignored and cleared on mount (stale draft cleanup)
- Multi-tab edge case: last-write-wins on localStorage is acceptable; unlikely scenario for the same text in two tabs

---

## 4. Drag-and-Drop Upload Enhancement

### Problem
`ProjectView.jsx` already supports drag-and-drop on the upload area, but `PdfProjectView.jsx` does not. Neither view supports dropping files anywhere on the page.

### Solution
Add a full-page drop zone overlay to both project views. When a user drags a file over the page, a translucent overlay appears with a "Drop files here" message. Dropping triggers the existing upload handler.

### Files
- **Modified**: `client/src/pages/PdfProjectView.jsx` — add drag-and-drop PDF upload
- **Modified**: `client/src/pages/ProjectView.jsx` — add full-page drop overlay

### Behavior
- `dragenter` on `document` shows the overlay; `dragleave` (when leaving the window) or `drop` hides it
- The overlay is a fixed-position div covering the viewport with a dashed border and icon
- Drop handler delegates to the existing upload logic (image processing in ProjectView, PDF upload in PdfProjectView)
- Overlay only appears when the drag payload contains files (check `e.dataTransfer.types.includes('Files')`)
- For PdfProjectView: dropping a PDF when no text is selected shows an inline error message (using existing `setError()` state pattern); otherwise triggers upload for the selected text

---

## Out of Scope

These features are tracked separately:
- **Batch 2**: Dark mode, user settings page, pagination, bulk text operations
- **Batch 3**: Onboarding, accessibility audit, HTML editor text color, improved keyboard shortcuts
