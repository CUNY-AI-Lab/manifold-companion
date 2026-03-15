import { useState, useEffect, useRef, useCallback } from 'react';

const DRAFT_DEBOUNCE_MS = 5000;
const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Patch history.pushState/replaceState once so React Router link clicks
// fire an event the hook can intercept.  The patch is idempotent.
let _historyPatched = false;
function patchHistory() {
  if (_historyPatched) return;
  _historyPatched = true;
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function (...args) {
      const event = new Event('locationchange');
      event.arguments = args;
      const result = original.apply(this, args);
      window.dispatchEvent(event);
      return result;
    };
  }
}

// Shared ref so multiple hook instances coordinate — only one confirm dialog
// should be active at a time.
let _blockingNavigation = false;

export default function useUnsavedChanges(draftKey, currentContent, serverUpdatedAt, { enabled = true, isDirtyOverride, getContent } = {}) {
  const savedContentRef = useRef(currentContent);
  const [draftBanner, setDraftBanner] = useState(null);
  const isDirty = enabled && (isDirtyOverride !== undefined ? isDirtyOverride : currentContent !== savedContentRef.current);

  // Draft recovery on mount
  useEffect(() => {
    if (!enabled || !draftKey) return;
    try {
      const raw = localStorage.getItem(draftKey);
      if (!raw) return;
      const draft = JSON.parse(raw);
      if (Date.now() - draft.savedAt > DRAFT_MAX_AGE_MS) {
        localStorage.removeItem(draftKey);
        return;
      }
      const serverTime = serverUpdatedAt ? new Date(serverUpdatedAt).getTime() : 0;
      if (draft.savedAt > serverTime && draft.content !== currentContent) {
        setDraftBanner({ savedAt: draft.savedAt, content: draft.content });
      } else {
        localStorage.removeItem(draftKey);
      }
    } catch {
      localStorage.removeItem(draftKey);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, enabled]);

  // Debounced draft saving
  useEffect(() => {
    if (!enabled || !draftKey || !isDirty) return;
    const timer = setTimeout(() => {
      try {
        const content = getContent ? getContent() : currentContent;
        localStorage.setItem(draftKey, JSON.stringify({
          content,
          savedAt: Date.now(),
        }));
      } catch {}
    }, DRAFT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [enabled, draftKey, currentContent, isDirty, getContent]);

  // beforeunload guard (tab close / external navigation)
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  // popstate guard (browser back/forward)
  const historyPushedRef = useRef(false);
  useEffect(() => {
    if (!isDirty) {
      if (historyPushedRef.current) {
        historyPushedRef.current = false;
      }
      return;
    }
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

  // In-app navigation guard (React Router <Link> / navigate())
  // React Router uses history.pushState which doesn't fire popstate.
  // We patch pushState/replaceState to emit 'locationchange' and intercept it.
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;

  useEffect(() => {
    patchHistory();

    const handler = (e) => {
      if (!isDirtyRef.current || _blockingNavigation) return;
      // The patched pushState already ran — the URL has changed.
      // We need to undo it, ask the user, and re-apply if they confirm.
      const targetArgs = e.arguments; // [state, title, url]
      _blockingNavigation = true;

      // Go back to the original URL
      history.replaceState({ unsavedGuard: true }, '', window.location.href);
      // Actually we can't reliably undo pushState here because the
      // component already re-rendered. Instead, use a click interceptor.
      _blockingNavigation = false;
    };

    // Click interceptor: catch <a> clicks before React Router processes them.
    const clickHandler = (e) => {
      if (!isDirtyRef.current) return;
      const link = e.target.closest('a[href]');
      if (!link) return;
      // Only intercept internal links (same origin, not target=_blank)
      if (link.target === '_blank' || link.target === '_new') return;
      if (link.origin !== window.location.origin) return;
      // Don't intercept hash-only links
      if (link.pathname === window.location.pathname && link.hash) return;
      // Don't intercept if navigating to the same page
      if (link.pathname === window.location.pathname && link.search === window.location.search) return;

      e.preventDefault();
      e.stopPropagation();
      if (window.confirm('You have unsaved changes. Leave anyway?')) {
        // Let it through by temporarily clearing the dirty flag
        isDirtyRef.current = false;
        link.click();
      }
    };

    // Use capture phase so we intercept before React Router's handler
    document.addEventListener('click', clickHandler, true);
    return () => {
      document.removeEventListener('click', clickHandler, true);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
