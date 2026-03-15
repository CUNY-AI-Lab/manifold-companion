# Batch 3: Onboarding, Accessibility, Editor Color, Keyboard Shortcuts

## Overview

Four UX improvements building on Batches 1-2. Accessibility is the anchor feature (comprehensive WCAG AA); the other three are lighter additions.

## 1. Onboarding (Enhanced Empty State + Welcome Banner)

### Welcome Banner

Add `onboarded` column (INTEGER DEFAULT 0) to `users` table. On first login after approval, Dashboard shows a dismissable banner: "Welcome to Manifold Companion! Your account is ready." Dismiss calls `PUT /api/auth/profile` with `onboarded: true`. Never shows again.

**Server changes:**
- `server/db.js`: Add `onboarded` column to users table schema. Expose in `getUser()` response.
- `server/routes/auth.js`: Accept `onboarded` in `PUT /api/auth/profile`. Return `onboarded` in `/me` response.

**Client changes:**
- `AuthContext.jsx`: Refactor `updateProfile` from `(displayName)` to accept an object `({ display_name?, onboarded? })`. Update all existing callers (SettingsPage passes `{ display_name }`). Include `onboarded` in user state from `/me`.
- `Dashboard.jsx`: Show banner when `user.onboarded === 0`. On dismiss, call `updateProfile({ onboarded: true })`.

### Enhanced Empty State

When `projects.length === 0` (and `sharedProjects.length === 0`), replace the current minimal prompt with two workflow cards:

- **Image to Markdown** — icon, description ("Upload scanned pages or photos. OCR extracts text as Markdown for editing and Manifold export."), "Create Project" button pre-selecting `image_to_markdown`.
- **PDF to HTML** — icon, description ("Upload a PDF document. AI parses each page into structured, editable HTML."), "Create Project" button pre-selecting `pdf_to_html`.

Cards are styled with the Tailwind theme, dark mode compatible. No modals, no tooltips, no tracking beyond the `onboarded` flag.

---

## 2. Keyboard Shortcuts

### Architecture

A `useHotkeys` custom hook (`client/src/hooks/useHotkeys.js`) that:
- Accepts a map of `{ combo: handler }` entries
- Detects Mac vs non-Mac via `navigator.userAgentData?.platform || navigator.platform` and normalizes `Cmd` to `Meta` / `Ctrl`
- Manages registration/cleanup via `useEffect`
- Supports `when` condition (e.g., only active on a specific tab)
- Prevents firing when focus is in an input/textarea/contenteditable (for single-key shortcuts like `N`, `/`)
- Editor-context shortcuts call `e.preventDefault()` to override browser defaults (e.g., `Cmd+K` overrides Chrome's address bar, `Cmd+E` overrides search)

Two-key combos (e.g., `G then D`): Track `pendingKey` ref with a 500ms timeout. If second key arrives in time, fire action and clear. Otherwise reset.

`KeyboardShortcuts.jsx` reads from a registry of registered shortcuts rather than a hardcoded list. The registry is a module-level `Map` in `useHotkeys.js` — each `useHotkeys` call registers its shortcuts with labels (e.g., `{ combo: 'Cmd+B', label: 'Bold', section: 'HTML Editor' }`), and `KeyboardShortcuts.jsx` imports a `getRegisteredShortcuts()` function to render the list.

**Shortcut conflicts:** `Cmd+Shift+D` may conflict with browser bookmark-all-tabs on Windows/Linux — this is best-effort. `?` and `Cmd+/` both open shortcuts help; `?` is the simple trigger, `Cmd+/` works when `?` would type into an input.

### Shortcut Map

**HTML Editor (HtmlTextDetail):**

| Shortcut | Action |
|----------|--------|
| `Cmd+B` | Bold |
| `Cmd+I` | Italic |
| `Cmd+U` | Underline |
| `Cmd+K` | Insert/edit link |
| `Cmd+E` | Inline code |
| `Cmd+Shift+X` | Strikethrough |
| `Cmd+Shift+7` | Ordered list |
| `Cmd+Shift+8` | Unordered list |
| `Cmd+Shift+9` | Blockquote |
| `Cmd+Option+1-4` | Heading levels 1-4 |
| `Cmd+Shift+K` | Insert TeX formula |
| `Cmd+S` | Save |

**MD Editor (TextDetail):**

| Shortcut | Action |
|----------|--------|
| `Cmd+S` | Save (exists) |
| `Cmd+Shift+S` | Save and next page |
| `←` / `→` | Prev/next page (exists) |
| `Cmd+Shift+F` | Find/replace |

**Navigation (both editors):**

| Shortcut | Action |
|----------|--------|
| `Alt+←` / `Alt+→` | Previous/next tab |
| `Cmd+Shift+C` | Toggle comments sidebar |
| `Cmd+Shift+H` | Toggle version history |

**Global (not in input/editor):**

| Shortcut | Action |
|----------|--------|
| `N` | New project (Dashboard) / new text (ProjectView) |
| `/` | Focus search bar |
| `G then D` | Go to dashboard |
| `G then S` | Go to settings |
| `Cmd+Shift+D` | Toggle dark/light mode (cycles light → dark → system) |
| `Cmd+/` | Toggle shortcuts help |
| `Cmd+Enter` | Submit current form/dialog |
| `Escape` | Close any open modal/sidebar |
| `?` | Show keyboard shortcuts (exists) |

---

## 3. HTML Editor Text Color

### Paste Sanitization

Intercept `paste` event on the contenteditable div in `HtmlTextDetail.jsx`. When pasting HTML:
1. Get `text/html` from clipboard
2. Parse to DOM fragment
3. Walk all elements: remove `color`, `background-color`, and `background` inline style properties; strip `<font>` elements (preserve children); remove embedded `<style>` blocks from pasted content
4. Insert sanitized fragment

Preserve other inline styles (font-size, margin, etc.). Plain text paste is unaffected.

### Toolbar Color Controls

Two new toolbar buttons in `HtmlTextDetail.jsx` `FormattingToolbar`:

- **Text color** (A with colored underline) — dropdown with 16-color palette grid. Click swatch to apply `<span style="color:...">` to selection via `document.execCommand('foreColor')`. Button shows a colored dot indicating current/last-used color. Includes a "Remove color" option.
- **Highlight color** (marker icon with colored underline) — same pattern, applies `background-color` via `document.execCommand('hiliteColor')`. Includes "Remove highlight" option.

Palette: black, white, gray, red, orange, amber, yellow, lime, green, teal, cyan, blue, indigo, purple, pink, rose. Arranged in a 4x4 grid dropdown.

Colors persist through save as inline styles in the HTML content. Dark mode: dropdown itself uses dark theme; color swatches are the same in both modes.

**Selection preservation:** Color swatches must use `onMouseDown={(e) => e.preventDefault()}` to prevent focus shift from contenteditable, matching the existing `TBtn` pattern (line 178 of HtmlTextDetail.jsx).

**Keyboard accessibility of color grid:** Arrow keys navigate the 4x4 grid (up/down/left/right). Each swatch has `aria-label` with color name. "Remove color/highlight" is reachable via keyboard at end of grid. Escape closes dropdown.

**Note:** `document.execCommand` is deprecated but the app's entire formatting toolbar already depends on it (`execCmd()` wrapper). Consistent with existing approach; no migration planned.

---

## 4. Comprehensive Accessibility (WCAG AA)

### 4.1 Semantic Structure

**`App.jsx`:**
- Add `id="main-content"` to the existing `<main>` element (line 36)
- Add skip-to-content link as first child of the outer div: `<a href="#main-content" class="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-50 focus:bg-white focus:px-4 focus:py-2 focus:rounded dark:focus:bg-slate-800">Skip to content</a>`

**`Header.jsx`:**
- Wrap in `<nav aria-label="Main navigation">`

### 4.2 Focus Management

**All modals** (SharePanel, VersionHistory, KeyboardShortcuts, SplitMergeModals, export modal, delete confirmations):
- Focus trap: Tab cycles within modal, Shift+Tab wraps backward
- Auto-focus first interactive element on open
- Restore focus to trigger element on close
- `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing to modal title

Implement via a `useFocusTrap(ref, isOpen)` hook in `client/src/hooks/useFocusTrap.js`.

### 4.3 ARIA Labels & Roles

**Icon-only buttons**: Every button without visible text gets `aria-label`. This includes:
- Toolbar formatting buttons (bold, italic, link, etc.)
- Close buttons (X icons)
- Navigation arrows
- Action buttons (delete, edit, share icons)
- Notification bell
- Theme toggle
- Search icon

**Tabs:**
- Tab containers: `role="tablist"`
- Tab buttons: `role="tab"`, `aria-selected`, `aria-controls`
- Tab panels: `role="tabpanel"`, `aria-labelledby`, `tabindex="0"`

**Toolbars:**
- Formatting toolbar: `role="toolbar"`, `aria-label="Formatting"`
- Buttons within: `role` implicit from `<button>`

**Sidebar:**
- Annotation sidebar: `role="complementary"`, `aria-label="Comments"`

**Expandable sections:**
- Annotation replies: `aria-expanded` on toggle button
- Notification dropdown: `aria-expanded` on bell button

### 4.4 Keyboard Navigation

**Toolbar buttons:**
- Arrow Left/Right moves focus between buttons
- `tabindex="0"` on active button, `tabindex="-1"` on others (roving tabindex)
- `Home`/`End` jump to first/last button

**Tab lists:**
- Arrow Left/Right moves between tabs
- Roving tabindex pattern
- `Home`/`End` jump to first/last tab

**Dropdown menus** (notification, search results, autocomplete):
- Arrow Up/Down navigates items
- `Enter` selects
- `Escape` closes
- `aria-activedescendant` tracks highlighted item

**General:**
- `Tab` moves between logical groups (toolbar → editor → sidebar), not every individual button
- Interactive elements reachable and operable via keyboard alone

### 4.5 Live Regions

**Polite announcements** (`aria-live="polite"`):
- Toast/success notifications
- Save confirmation ("Saved")
- Loading states ("Loading project...")
- OCR progress ("Processing page 3 of 12...")
- Search results count ("5 results found")

**Assertive announcements** (`aria-live="assertive"`):
- Error messages
- Validation failures

Implementation: A `useAnnounce()` hook backed by a lightweight `AnnounceContext` in `App.jsx`. The context holds a ref to a `<div aria-live="polite" class="sr-only">` and a `<div aria-live="assertive" class="sr-only">`. Components call `announce('Saved', 'polite')` or `announce('Error: failed to save', 'assertive')`. New file: `client/src/hooks/useAnnounce.js`.

### 4.6 Visual Accessibility

**Focus indicators:**
- Global `focus-visible` outline: `outline: 2px solid` using `cail-blue`, offset 2px
- Applied via Tailwind `focus-visible:ring-2 focus-visible:ring-cail-blue focus-visible:ring-offset-2`
- Remove default outline only when `focus-visible` is supported

**Reduced motion:**
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```
Added to `index.css`.

**Color contrast audit:**
- Check all color pairings from `tailwind.config.js` custom tokens against their typical backgrounds using a contrast ratio calculator
- Light mode: verify `cail-teal` on white, `text-gray-400` on white, `text-gray-500` on `cail-cream`, status badge text on badge bg
- Dark mode: verify `text-slate-400` on `slate-800`, `cail-teal` on `slate-900`, `cail-blue` on `slate-800`, status badge dark variants
- Fix any combo below 4.5:1 (normal text) or 3:1 (large text/UI components) by adjusting the shade one step darker/lighter

### 4.7 Contenteditable Editors

- `role="textbox"`, `aria-multiline="true"` on contenteditable divs
- `aria-label="Document editor"` (HTML) / `aria-label="Markdown editor"` (MD)
- `aria-describedby` linking to any active status (e.g., "Unsaved changes")

---

## Implementation Order

Dependencies require this sequence:
1. **Accessibility hooks** — `useFocusTrap`, `useAnnounce` (foundation for everything else)
2. **Keyboard shortcuts** — `useHotkeys` hook + `KeyboardShortcuts.jsx` registry (needs focus trap for help modal)
3. **Editor color controls** — paste sanitization + color picker (needs keyboard accessibility from step 1-2)
4. **Semantic structure & ARIA** — landmarks, labels, roles, tab patterns across all components
5. **Visual accessibility** — focus-visible, reduced-motion, contrast audit
6. **Onboarding** — independent, saved for last since it's simplest

---

## Files Summary

### New files (3)
| File | Purpose |
|------|---------|
| `client/src/hooks/useHotkeys.js` | Keyboard shortcut registration hook with global registry |
| `client/src/hooks/useFocusTrap.js` | Modal focus trap hook |
| `client/src/hooks/useAnnounce.js` | Live region announcements context + hook |

### Modified files (~15)
| File | Changes |
|------|---------|
| `server/db.js` | Add `onboarded` column to users |
| `server/routes/auth.js` | Accept/return `onboarded` in profile |
| `client/src/App.jsx` | `<main>` landmark, skip-to-content link, live region |
| `client/src/index.css` | `prefers-reduced-motion`, `focus-visible` styles, sr-only utilities |
| `client/src/context/AuthContext.jsx` | Include `onboarded` in user state |
| `client/src/pages/Dashboard.jsx` | Welcome banner, enhanced empty state |
| `client/src/pages/TextDetail.jsx` | Expanded shortcuts, ARIA, focus management, tab roles |
| `client/src/pages/HtmlTextDetail.jsx` | Formatting shortcuts, color picker, paste sanitization, ARIA, focus management, tab roles |
| `client/src/pages/ProjectView.jsx` | ARIA labels, keyboard nav |
| `client/src/pages/PdfProjectView.jsx` | ARIA labels, keyboard nav |
| `client/src/components/Header.jsx` | `<nav>` landmark, global shortcuts, ARIA |
| `client/src/components/KeyboardShortcuts.jsx` | Dynamic shortcut registry display |
| `client/src/components/SharePanel.jsx` | Focus trap, dialog role |
| `client/src/components/VersionHistory.jsx` | Focus trap, dialog role |
| `client/src/components/AnnotationSidebar.jsx` | Complementary role, ARIA expanded, keyboard nav |
| `client/src/components/NotificationBell.jsx` | Dropdown keyboard nav, ARIA expanded |
| `client/src/components/SearchBar.jsx` | Results keyboard nav, ARIA |
| `client/src/components/SplitMergeModals.jsx` | Focus trap, dialog role |

---

## Out of Scope

- Activity feed
- Offline support
- Pipeline prompt changes for color stripping
- Mobile-specific gestures
