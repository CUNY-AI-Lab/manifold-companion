import { useState, useEffect, useRef, useCallback } from 'react';

const DRAFT_DEBOUNCE_MS = 5000;
const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export default function useUnsavedChanges(draftKey, currentContent, serverUpdatedAt, { enabled = true } = {}) {
  const savedContentRef = useRef(currentContent);
  const [draftBanner, setDraftBanner] = useState(null);
  const isDirty = enabled && currentContent !== savedContentRef.current;

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
        localStorage.setItem(draftKey, JSON.stringify({
          content: currentContent,
          savedAt: Date.now(),
        }));
      } catch {}
    }, DRAFT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [enabled, draftKey, currentContent, isDirty]);

  // beforeunload guard
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
