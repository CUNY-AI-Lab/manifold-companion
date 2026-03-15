# Batch 1: Quick Wins Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four independent UI improvements: 404 page, loading skeletons, auto-save drafts with leave guard, and full-page drag-and-drop upload overlay.

**Architecture:** All changes are client-side only. No new API endpoints. Each feature is independent and can be implemented in any order. The auto-save feature introduces a `useUnsavedChanges` hook for reuse across both editors.

**Tech Stack:** React 18, React Router 6 (BrowserRouter), Tailwind CSS 3, localStorage API

**Spec:** `docs/superpowers/specs/2026-03-15-batch1-quick-wins-design.md`

**No tests configured** — this project has no test or lint scripts. Verification is manual via `npm run build` and `npm run dev`.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `client/src/pages/NotFoundPage.jsx` | Create | 404 page with path display and dashboard link |
| `client/src/components/Skeleton.jsx` | Create | Reusable skeleton primitives (Box, Circle) and composites (Card, TextRow, TableRow) |
| `client/src/hooks/useUnsavedChanges.js` | Create | Reusable hook: debounced localStorage drafts, beforeunload guard, popstate interception, draft recovery |
| `client/src/App.jsx` | Modify | Add catch-all `<Route path="*">` and import NotFoundPage |
| `client/src/pages/Dashboard.jsx` | Modify | Replace spinner with Skeleton.Card grid |
| `client/src/pages/ProjectView.jsx` | Modify | Replace spinner with Skeleton.TextRow list; add full-page drop overlay |
| `client/src/pages/PdfProjectView.jsx` | Modify | Replace spinner with Skeleton.TextRow list; add full-page drag-and-drop for PDFs |
| `client/src/pages/AdminPanel.jsx` | Modify | Replace spinner with Skeleton.TableRow |
| `client/src/pages/TextDetail.jsx` | Modify | Integrate useUnsavedChanges for Review tab page text |
| `client/src/pages/HtmlTextDetail.jsx` | Modify | Integrate useUnsavedChanges for HTML content |

---

## Chunk 1: 404 Page + Loading Skeletons

### Task 1: Create 404 Page

**Files:**
- Create: `client/src/pages/NotFoundPage.jsx`
- Modify: `client/src/App.jsx`

- [ ] **Step 1: Create NotFoundPage component**

Create `client/src/pages/NotFoundPage.jsx`:

```jsx
import { Link, useLocation } from 'react-router-dom';

export default function NotFoundPage() {
  const { pathname } = useLocation();
  return (
    <div className="max-w-xl mx-auto px-4 py-24 text-center">
      <h1 className="font-display text-6xl font-bold text-cail-dark mb-4">404</h1>
      <p className="text-lg text-gray-500 mb-2">Page not found</p>
      <p className="text-sm text-gray-400 mb-8 font-mono break-all">{pathname}</p>
      <Link
        to="/"
        className="inline-flex items-center px-5 py-2.5 bg-cail-blue text-white rounded-xl font-medium hover:bg-cail-blue/90 transition-colors"
      >
        Back to Dashboard
      </Link>
    </div>
  );
}
```

- [ ] **Step 2: Add catch-all route to App.jsx**

In `client/src/App.jsx`, add import at top:

```jsx
import NotFoundPage from './pages/NotFoundPage';
```

Add route as the last `<Route>` inside `<Routes>`, after the admin route:

```jsx
<Route path="*" element={<ProtectedRoute><NotFoundPage /></ProtectedRoute>} />
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Build succeeds with no errors.

- [ ] **Step 4: Manual test**

Run: `npm run dev`
Navigate to `http://localhost:5173/nonexistent-path`.
Expected: See "404 / Page not found / /nonexistent-path / Back to Dashboard" styled page.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/NotFoundPage.jsx client/src/App.jsx
git commit -m "feat: add 404 page for unknown routes"
```

---

### Task 2: Create Skeleton Component

**Files:**
- Create: `client/src/components/Skeleton.jsx`

- [ ] **Step 1: Create Skeleton component with primitives and composites**

Create `client/src/components/Skeleton.jsx`:

```jsx
function Box({ className = '' }) {
  return <div className={`animate-pulse bg-gray-200 rounded ${className}`} />;
}

function Circle({ className = '' }) {
  return <div className={`animate-pulse bg-gray-200 rounded-full ${className}`} />;
}

// Matches project card in Dashboard.jsx
function Card() {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-6">
      <Box className="h-5 w-3/4 mb-3" />
      <Box className="h-3 w-full mb-2" />
      <Box className="h-3 w-2/3 mb-4" />
      <div className="flex gap-2">
        <Box className="h-5 w-20 rounded-full" />
        <Box className="h-5 w-16 rounded-full" />
        <Box className="h-5 w-16 rounded-full" />
      </div>
    </div>
  );
}

// Matches text list item in ProjectView/PdfProjectView
function TextRow() {
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4 flex items-center gap-4">
      <Box className="h-10 w-10 rounded-lg flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <Box className="h-4 w-1/3 mb-2" />
        <Box className="h-3 w-1/2" />
      </div>
      <Box className="h-5 w-16 rounded-full flex-shrink-0" />
    </div>
  );
}

// Matches admin table row in AdminPanel.jsx
function TableRow({ cols = 5 }) {
  return (
    <tr>
      {Array.from({ length: cols }, (_, i) => (
        <td key={i} className="px-4 py-3">
          <Box className={`h-4 ${i === 0 ? 'w-40' : i === cols - 1 ? 'w-20' : 'w-24'}`} />
        </td>
      ))}
    </tr>
  );
}

const Skeleton = { Box, Circle, Card, TextRow, TableRow };
export default Skeleton;
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/Skeleton.jsx
git commit -m "feat: add reusable Skeleton loading component"
```

---

### Task 3: Replace Spinners with Skeletons

**Files:**
- Modify: `client/src/pages/Dashboard.jsx`
- Modify: `client/src/pages/ProjectView.jsx`
- Modify: `client/src/pages/PdfProjectView.jsx`
- Modify: `client/src/pages/AdminPanel.jsx`

- [ ] **Step 1: Dashboard — replace spinner with skeleton cards**

In `client/src/pages/Dashboard.jsx`, add import:

```jsx
import Skeleton from '../components/Skeleton';
```

Replace the loading spinner block:

```jsx
{loading && (
  <div className="flex justify-center py-16">
    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cail-blue"></div>
  </div>
)}
```

With skeleton cards:

```jsx
{loading && (
  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
    {Array.from({ length: 6 }, (_, i) => <Skeleton.Card key={i} />)}
  </div>
)}
```

- [ ] **Step 2: ProjectView — replace spinner with skeleton text rows**

In `client/src/pages/ProjectView.jsx`, add import:

```jsx
import Skeleton from '../components/Skeleton';
```

Replace the early-return loading spinner:

```jsx
if (loading) {
  return (
    <div className="flex justify-center items-center min-h-[60vh]">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cail-blue"></div>
    </div>
  );
}
```

With skeleton layout:

```jsx
if (loading) {
  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <Skeleton.Box className="h-8 w-64 mb-2" />
      <Skeleton.Box className="h-4 w-96 mb-8" />
      <div className="space-y-3">
        {Array.from({ length: 4 }, (_, i) => <Skeleton.TextRow key={i} />)}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: PdfProjectView — replace spinner with skeleton text rows**

In `client/src/pages/PdfProjectView.jsx`, add import:

```jsx
import Skeleton from '../components/Skeleton';
```

Replace the early-return loading spinner (same pattern as ProjectView):

```jsx
if (loading) {
  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <Skeleton.Box className="h-8 w-64 mb-2" />
      <Skeleton.Box className="h-4 w-96 mb-8" />
      <div className="space-y-3">
        {Array.from({ length: 4 }, (_, i) => <Skeleton.TextRow key={i} />)}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: AdminPanel — replace spinner with skeleton rows**

In `client/src/pages/AdminPanel.jsx`, add import:

```jsx
import Skeleton from '../components/Skeleton';
```

The AdminPanel Users tab loading spinner is a standalone div, not inside a table. Replace it with skeleton box rows (not TableRow, since there is no surrounding table element during loading):

```jsx
{loading && (
  <div className="space-y-3">
    {Array.from({ length: 5 }, (_, i) => (
      <div key={i} className="bg-white rounded-xl border border-gray-100 p-4 flex items-center gap-4">
        <Skeleton.Circle className="h-8 w-8" />
        <Skeleton.Box className="h-4 w-40" />
        <Skeleton.Box className="h-4 w-24" />
        <Skeleton.Box className="h-4 w-20" />
        <Skeleton.Box className="h-4 w-16 ml-auto" />
      </div>
    ))}
  </tbody>
)}
```

Adjust `cols` to match the number of columns in the admin users table.

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 6: Manual test**

Run: `npm run dev`
- Dashboard: refresh page, see skeleton cards briefly before projects load
- ProjectView: navigate to a project, see skeleton rows
- AdminPanel: navigate to admin, see skeleton table rows

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/Dashboard.jsx client/src/pages/ProjectView.jsx client/src/pages/PdfProjectView.jsx client/src/pages/AdminPanel.jsx
git commit -m "feat: replace loading spinners with skeleton placeholders"
```

---

## Chunk 2: Auto-Save Drafts + Unsaved Changes Guard

### Task 4: Create useUnsavedChanges Hook

**Files:**
- Create: `client/src/hooks/useUnsavedChanges.js`

This hook encapsulates three concerns:
1. Debounced localStorage draft saving
2. `beforeunload` browser tab close warning
3. `popstate` back-button interception (since BrowserRouter doesn't support `useBlocker`)

- [ ] **Step 1: Create the hook**

Create `client/src/hooks/useUnsavedChanges.js`:

```jsx
import { useState, useEffect, useRef, useCallback } from 'react';

const DRAFT_DEBOUNCE_MS = 5000;
const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Hook for auto-saving drafts to localStorage and warning on unsaved changes.
 *
 * @param {string} draftKey - Unique key for this draft, e.g. `mc-draft-${textId}-compiled`
 * @param {string} currentContent - The current editor content
 * @param {string} serverUpdatedAt - ISO timestamp of the server content's last update
 * @param {object} options
 * @param {boolean} options.enabled - Whether the hook is active (e.g. only when on Review tab)
 * @returns {{ isDirty, draftBanner, dismissDraft, restoreDraft, markSaved }}
 */
export default function useUnsavedChanges(draftKey, currentContent, serverUpdatedAt, { enabled = true } = {}) {
  const savedContentRef = useRef(currentContent);
  const [draftBanner, setDraftBanner] = useState(null); // { savedAt, content }
  const isDirty = enabled && currentContent !== savedContentRef.current;

  // --- Draft recovery on mount ---
  useEffect(() => {
    if (!enabled || !draftKey) return;
    try {
      const raw = localStorage.getItem(draftKey);
      if (!raw) return;
      const draft = JSON.parse(raw);
      // Ignore stale drafts
      if (Date.now() - draft.savedAt > DRAFT_MAX_AGE_MS) {
        localStorage.removeItem(draftKey);
        return;
      }
      // Only offer recovery if draft is newer than server content
      const serverTime = serverUpdatedAt ? new Date(serverUpdatedAt).getTime() : 0;
      if (draft.savedAt > serverTime && draft.content !== currentContent) {
        setDraftBanner({ savedAt: draft.savedAt, content: draft.content });
      } else {
        localStorage.removeItem(draftKey);
      }
    } catch {
      localStorage.removeItem(draftKey);
    }
  // Run only on mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, enabled]);

  // --- Debounced draft saving ---
  useEffect(() => {
    if (!enabled || !draftKey || !isDirty) return;
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(draftKey, JSON.stringify({
          content: currentContent,
          savedAt: Date.now(),
        }));
      } catch { /* localStorage full — ignore */ }
    }, DRAFT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [enabled, draftKey, currentContent, isDirty]);

  // --- beforeunload guard ---
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  // --- popstate guard (browser back/forward) ---
  const historyPushedRef = useRef(false);
  useEffect(() => {
    if (!isDirty) {
      // Clean up extra history entry when content is saved
      if (historyPushedRef.current) {
        historyPushedRef.current = false;
        // Don't pop — user may have already navigated
      }
      return;
    }
    // Push one duplicate state entry so back triggers popstate
    if (!historyPushedRef.current) {
      window.history.pushState({ unsavedGuard: true }, '', window.location.href);
      historyPushedRef.current = true;
    }
    const handler = () => {
      if (window.confirm('You have unsaved changes. Leave anyway?')) {
        historyPushedRef.current = false;
        window.history.back();
      } else {
        window.history.pushState({ unsavedGuard: true }, '', window.location.href);
      }
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, [isDirty]);

  const markSaved = useCallback((savedContent) => {
    savedContentRef.current = savedContent;
    if (draftKey) {
      try { localStorage.removeItem(draftKey); } catch {}
    }
  }, [draftKey]);

  const restoreDraft = useCallback(() => {
    setDraftBanner(null);
    return draftBanner?.content;
  }, [draftBanner]);

  const dismissDraft = useCallback(() => {
    setDraftBanner(null);
    if (draftKey) {
      try { localStorage.removeItem(draftKey); } catch {}
    }
  }, [draftKey]);

  // Update saved ref when content is first set (initial load)
  const initRef = useRef(false);
  useEffect(() => {
    if (!initRef.current && currentContent) {
      savedContentRef.current = currentContent;
      initRef.current = true;
    }
  }, [currentContent]);

  return { isDirty, draftBanner, dismissDraft, restoreDraft, markSaved };
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: Build succeeds (hook is created but not yet used).

- [ ] **Step 3: Commit**

```bash
git add client/src/hooks/useUnsavedChanges.js
git commit -m "feat: add useUnsavedChanges hook for draft save and leave guard"
```

---

### Task 5: Integrate useUnsavedChanges into HtmlTextDetail

**Files:**
- Modify: `client/src/pages/HtmlTextDetail.jsx`

HtmlTextDetail already tracks `dirty` state and has `htmlContent` + `saveHtml()`. Wire in the hook.

- [ ] **Step 1: Add hook import and integration**

In `client/src/pages/HtmlTextDetail.jsx`, add import near top:

```jsx
import useUnsavedChanges from '../hooks/useUnsavedChanges';
```

Inside the component, after the existing state declarations (after `htmlContent` is defined), add:

```jsx
const { isDirty: hasUnsaved, draftBanner, dismissDraft, restoreDraft, markSaved } = useUnsavedChanges(
  text ? `mc-draft-${id}-html` : null,
  htmlContent,
  text?.updated_at,
  { enabled: activeTab === 'review' }
);
```

- [ ] **Step 2: Call markSaved after successful save**

In the `saveHtml()` function, after `setDirty(false)` (around line 796), add:

```jsx
markSaved(contentToSave);
```

Also call `markSaved` in the reprocess success path after `setDirty(false)`.

- [ ] **Step 3: Handle draft restore**

In the initial data load (where `setHtmlContent(htmlData.html_content || '')` is called), after setting content, also update the saved ref:

After the fetch-on-mount sets `htmlContent`, the hook's `initRef` handles this automatically.

- [ ] **Step 4: Add draft recovery banner to the Review tab UI**

In the Review tab section of the JSX, at the top of the review content area, add:

```jsx
{draftBanner && (
  <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-4 flex items-center justify-between">
    <span className="text-sm text-amber-800">
      Unsaved draft found from {new Date(draftBanner.savedAt).toLocaleString()}.
    </span>
    <div className="flex gap-2">
      <button
        onClick={() => { const content = restoreDraft(); if (content) setHtmlContent(content); }}
        className="text-sm font-medium text-amber-700 hover:text-amber-900"
      >
        Restore
      </button>
      <button
        onClick={dismissDraft}
        className="text-sm text-gray-500 hover:text-gray-700"
      >
        Dismiss
      </button>
    </div>
  </div>
)}
```

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/HtmlTextDetail.jsx
git commit -m "feat: add auto-save drafts and leave guard to HTML editor"
```

---

### Task 6: Integrate useUnsavedChanges into TextDetail

**Files:**
- Modify: `client/src/pages/TextDetail.jsx`

TextDetail uses `pageText` state for the currently viewed page in the Review tab. The draft should save per-page: `mc-draft-${textId}-page-${pageId}`.

- [ ] **Step 1: Add hook import and integration**

In `client/src/pages/TextDetail.jsx`, add import:

```jsx
import useUnsavedChanges from '../hooks/useUnsavedChanges';
```

Inside the component, after `visiblePages` is derived (the `pages.filter(p => p.filename !== '__compiled__')` line), add:

```jsx
const currentPageId = visiblePages[reviewPage]?.id;
const { isDirty: hasUnsaved, draftBanner, dismissDraft, restoreDraft, markSaved } = useUnsavedChanges(
  currentPageId ? `mc-draft-${id}-page-${currentPageId}` : null,
  pageText,
  text?.updated_at,
  { enabled: activeTab === 'review' }
);
```

- [ ] **Step 2: Call markSaved after successful page save**

In `savePageReview()`, after `setToast('Page text saved.')`, add:

```jsx
markSaved(pageText);
```

- [ ] **Step 3: Add draft recovery banner**

In the Review tab JSX, above the page text textarea, add the same draft banner pattern as HtmlTextDetail:

```jsx
{draftBanner && (
  <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-3 flex items-center justify-between">
    <span className="text-sm text-amber-800">
      Unsaved draft found from {new Date(draftBanner.savedAt).toLocaleString()}.
    </span>
    <div className="flex gap-2">
      <button
        onClick={() => { const content = restoreDraft(); if (content) setPageText(content); }}
        className="text-sm font-medium text-amber-700 hover:text-amber-900"
      >
        Restore
      </button>
      <button onClick={dismissDraft} className="text-sm text-gray-500 hover:text-gray-700">
        Dismiss
      </button>
    </div>
  </div>
)}
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 5: Manual test**

Run: `npm run dev`
1. Open a text in the editor, edit content, wait 5+ seconds — check localStorage for `mc-draft-*` key
2. Refresh the page — see the amber draft recovery banner
3. Click Restore — editor content restores
4. Edit content, try closing the tab — see browser "Leave site?" confirmation
5. Edit content, click browser back — see "unsaved changes" confirmation

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/TextDetail.jsx
git commit -m "feat: add auto-save drafts and leave guard to markdown editor"
```

---

## Chunk 3: Drag-and-Drop Upload Enhancement

### Task 7: Add Full-Page Drop Overlay to ProjectView

**Files:**
- Modify: `client/src/pages/ProjectView.jsx`

ProjectView already has drag-and-drop on the upload zone. Add a full-page overlay that appears when dragging files anywhere over the page.

- [ ] **Step 1: Add full-page drop zone state and handlers**

In `client/src/pages/ProjectView.jsx`, add state:

```jsx
const [pageDropActive, setPageDropActive] = useState(false);
const dropCountRef = useRef(0);
```

First, extract the file-processing logic from the existing `handleDrop(e)` function into a standalone `processDroppedFiles(files)` function that both the upload zone's `onDrop` and the page-level handler can call. The existing `handleDrop` calls `processDroppedFiles(e.dataTransfer.files)`.

Then add document-level drag event listeners in a `useEffect`:

```jsx
useEffect(() => {
  const onDragEnter = (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    dropCountRef.current++;
    setPageDropActive(true);
  };
  const onDragLeave = (e) => {
    e.preventDefault();
    dropCountRef.current--;
    if (dropCountRef.current <= 0) {
      dropCountRef.current = 0;
      setPageDropActive(false);
    }
  };
  const onDragOver = (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
  };
  const onPageDrop = (e) => {
    e.preventDefault();
    dropCountRef.current = 0;
    setPageDropActive(false);
    if (e.dataTransfer?.files?.length) {
      processDroppedFiles(e.dataTransfer.files);
    }
  };

  document.addEventListener('dragenter', onDragEnter);
  document.addEventListener('dragleave', onDragLeave);
  document.addEventListener('dragover', onDragOver);
  document.addEventListener('drop', onPageDrop);
  return () => {
    document.removeEventListener('dragenter', onDragEnter);
    document.removeEventListener('dragleave', onDragLeave);
    document.removeEventListener('dragover', onDragOver);
    document.removeEventListener('drop', onPageDrop);
  };
}, [processDroppedFiles]);
```

Wrap `processDroppedFiles` in `useCallback` to keep the dependency stable.

- [ ] **Step 2: Add overlay JSX**

At the end of the component's return JSX (before the closing wrapper div), add:

```jsx
{pageDropActive && (
  <div className="fixed inset-0 z-50 bg-cail-blue/10 backdrop-blur-sm flex items-center justify-center pointer-events-none">
    <div className="bg-white rounded-2xl border-2 border-dashed border-cail-blue p-12 text-center shadow-2xl">
      <svg className="w-16 h-16 mx-auto text-cail-blue mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
      </svg>
      <p className="font-display font-semibold text-lg text-cail-dark">Drop images here</p>
      <p className="text-sm text-gray-500 mt-1">JPEG, PNG, TIFF, BMP, WebP, or PDF files</p>
    </div>
  </div>
)}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/ProjectView.jsx
git commit -m "feat: add full-page drag-and-drop overlay to image project view"
```

---

### Task 8: Add Drag-and-Drop to PdfProjectView

**Files:**
- Modify: `client/src/pages/PdfProjectView.jsx`

PdfProjectView has no drag-and-drop for file upload. Add full-page drop zone that triggers PDF upload for the selected text.

- [ ] **Step 1: Add drop zone state, handlers, and overlay**

Same pattern as Task 7, but:
- Accept only PDF files (check `file.type === 'application/pdf'` or `.pdf` extension)
- If no text is selected (`!selectedTextId`), call `setError('Select a text before dropping a PDF.')` and return
- Otherwise, create a `File` from the dropped data and trigger the existing PDF upload flow

Add state:

```jsx
const [pageDropActive, setPageDropActive] = useState(false);
const dropCountRef = useRef(0);
```

Add the same `useEffect` with `dragenter`/`dragleave`/`dragover`/`drop` listeners on `document`. The drop handler:

```jsx
const handlePageDrop = (e) => {
  e.preventDefault();
  dropCountRef.current = 0;
  setPageDropActive(false);
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
    setError('Only PDF files are accepted.');
    return;
  }
  if (!selectedTextId) {
    setError('Select a text before dropping a PDF.');
    return;
  }
  // Trigger existing upload flow — call the upload function with the file
  handlePdfUpload(file);
};
```

Extract the existing PDF upload logic from the file input handler into a `handlePdfUpload(file)` function that both the input's `onChange` and the drop handler can call.

- [ ] **Step 2: Add overlay JSX**

Same overlay as ProjectView but with PDF-specific text:

```jsx
{pageDropActive && (
  <div className="fixed inset-0 z-50 bg-cail-blue/10 backdrop-blur-sm flex items-center justify-center pointer-events-none">
    <div className="bg-white rounded-2xl border-2 border-dashed border-cail-blue p-12 text-center shadow-2xl">
      <svg className="w-16 h-16 mx-auto text-cail-blue mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
      </svg>
      <p className="font-display font-semibold text-lg text-cail-dark">Drop PDF here</p>
      <p className="text-sm text-gray-500 mt-1">{selectedTextId ? 'Upload to selected text' : 'Select a text first'}</p>
    </div>
  </div>
)}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Build succeeds.

- [ ] **Step 4: Manual test**

Run: `npm run dev`
1. Open an image-to-markdown project, drag an image file over the page — see blue overlay
2. Drop — file uploads to the selected text
3. Open a PDF-to-HTML project, select a text, drag a PDF — see overlay
4. Drop — PDF uploads
5. Try dropping without a text selected — see error message

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/PdfProjectView.jsx
git commit -m "feat: add drag-and-drop PDF upload to PDF project view"
```

---

## Final Steps

- [ ] **Full build verification**

Run: `npm run build`
Expected: Clean build, no errors.

- [ ] **Deploy**

```bash
tar czf /tmp/manifold-companion.tar.gz --exclude='node_modules' --exclude='data' --exclude='.env' --exclude='.git' --exclude='.playwright-mcp' --exclude='*.png' .
# scp + extract + restart on production server
```

- [ ] **Push to GitHub**

```bash
git push
```
