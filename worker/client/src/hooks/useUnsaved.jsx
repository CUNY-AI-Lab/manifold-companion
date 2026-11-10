import { useEffect, useRef } from 'react';
import { useBlocker } from 'react-router-dom';
import { useSession } from '../api/session.jsx';
import { useConfirm } from '../components/ConfirmDialog';
import { clearDraft, loadDraft, saveDraft } from '../lib/drafts';
import { browserStorage } from '../lib/storage';
import { formatWhen } from '../lib/versions';

export const LEAVE_MESSAGE = 'You have changes that are not saved. This browser keeps a copy for 7 days and offers it when you open this text again, but only Save keeps them for everyone.';

/**
 * While `dirty`: closing or reloading the tab asks first (beforeunload), and
 * an in-app navigation to another page waits for an in-app confirmation.
 */
export function useLeaveGuard(dirty) {
  const confirm = useConfirm();
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirtyRef.current && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search));
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    let live = true;
    confirm({ title: 'Leave without saving?', message: LEAVE_MESSAGE, confirmLabel: 'Leave this page', cancelLabel: 'Stay', danger: true }).then((leave) => {
      if (!live) return;
      if (leave) blocker.proceed(); else blocker.reset();
    });
    return () => { live = false; };
  }, [blocker, confirm]);
  useEffect(() => {
    if (!dirty) return undefined;
    const ask = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [dirty]);
}

const sameTarget = (a, b) => a?.kind === b?.kind && (a?.pageId ?? null) === (b?.pageId ?? null);

/**
 * Keep the unsaved edit of one editor of a text as that text's local draft:
 * written a moment after each change and at once when the page is hidden;
 * removed when the edit stops being unsaved (a save, or the text put back),
 * but only if the stored draft is this editor's (one draft per text).
 */
export function useDraftKeeper({ textId, target, content, saved, dirty }) {
  const { draftOwner } = useSession();
  const latest = useRef({ target, content, saved, dirty });
  latest.current = { target, content, saved, dirty };
  const wasDirty = useRef(false);
  const write = () => {
    const l = latest.current;
    if (draftOwner && l.dirty) saveDraft(browserStorage(), draftOwner, textId, { target: l.target, content: l.content, saved: l.saved });
  };
  useEffect(() => {
    if (!draftOwner) return undefined;
    if (dirty) {
      wasDirty.current = true;
      const t = setTimeout(write, 600);
      return () => clearTimeout(t);
    }
    if (wasDirty.current) {
      wasDirty.current = false;
      const stored = loadDraft(browserStorage(), draftOwner, textId);
      if (stored && sameTarget(stored.target, target)) clearDraft(browserStorage(), draftOwner, textId);
    }
    return undefined;
  }, [draftOwner, textId, dirty, content, target?.kind, target?.pageId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Forget this editor's stored draft (its edit was discarded on purpose).
  const forget = () => {
    if (!draftOwner) return;
    const stored = loadDraft(browserStorage(), draftOwner, textId);
    if (stored && sameTarget(stored.target, latest.current.target)) clearDraft(browserStorage(), draftOwner, textId);
  };
  useEffect(() => {
    const flush = () => write();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', flush);
    return () => { window.removeEventListener('pagehide', flush); document.removeEventListener('visibilitychange', flush); flush(); };
  }, [draftOwner, textId]); // eslint-disable-line react-hooks/exhaustive-deps
  return { forget };
}

/** The stored draft of a text when the page opens (read once), with discard. */
export function useStoredDraft(textId) {
  const { draftOwner } = useSession();
  const found = useRef(undefined);
  if (found.current === undefined && draftOwner) found.current = loadDraft(browserStorage(), draftOwner, textId);
  return {
    draft: found.current ?? null,
    discard: () => { if (draftOwner) clearDraft(browserStorage(), draftOwner, textId); found.current = null; },
  };
}

/** "Unsaved changes to page 3 from 10 Nov 2026, 14:02 were kept in this browser." with Restore and Discard. */
export function DraftBanner({ what, at, savedChanged, onRestore, onDiscard }) {
  return (
    <section aria-labelledby="draft-title" className="my-3 rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-950 dark:border-sky-700 dark:bg-sky-950 dark:text-sky-100">
      <h2 id="draft-title" className="text-sm font-semibold">Unsaved changes found</h2>
      <p className="mt-1">Changes to {what} from {formatWhen(new Date(at).toISOString())} were not saved; this browser kept them.{savedChanged ? ' The saved text has changed since, so restoring them replaces the newer saved text in the editor (nothing is saved until you save).' : ' Restoring puts them in the editor; nothing is saved until you save.'}</p>
      <div className="mt-2 flex gap-2">
        <button type="button" className="btn-primary" onClick={onRestore}>Restore my changes</button>
        <button type="button" className="btn-quiet" onClick={onDiscard}>Discard them</button>
      </div>
    </section>
  );
}
