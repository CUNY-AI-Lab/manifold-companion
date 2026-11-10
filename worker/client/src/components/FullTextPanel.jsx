import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useConfirm } from './ConfirmDialog';
import SandboxedPreview from './SandboxedPreview';
import VersionHistory from './VersionHistory';
import { ErrorNote } from './ui';
import { useDraftKeeper } from '../hooks/useUnsaved';
import { useShortcut } from '../hooks/useShortcuts';

/**
 * The whole text of an image text in one editor (the legacy compiled text).
 * Until someone saves one, the export joins the page texts and this shows that
 * join, read-only. "Edit as one text" starts from it; once saved, the export
 * uses this full text and page edits no longer change the export, until
 * "Use the pages again" (the full text stays in its version history).
 */
export default function FullTextPanel({ textId, canEdit, pagesKey, onDraftChange, restoreDraft = null, onRestoreTaken }) {
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(undefined); // undefined: loading; null: none saved
  const [joined, setJoined] = useState('');
  const [draft, setDraft] = useState(null); // null: not editing
  const [versionKey, setVersionKey] = useState(0);
  const [status, setStatus] = useState('');
  const [error, setError] = useState(null);
  const savedRef = useRef(undefined);
  // A reload (pages changed, a restore) keeps an unsaved edit; otherwise the editor shows what is saved.
  const load = async ({ keepEdit = true } = {}) => {
    const [c, r] = await Promise.all([api.get(`/api/texts/${textId}/compiled`), api.get(`/api/texts/${textId}/result`)]);
    const before = savedRef.current;
    savedRef.current = c.text;
    setSaved(c.text);
    setJoined(r.text);
    setDraft((d) => (keepEdit && d !== null && d !== (before ?? null) ? d : c.text));
  };
  useEffect(() => { if (open) load().catch(setError); }, [open, textId, pagesKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // A draft recovered from this browser: open, load, then put it in the editor.
  useEffect(() => {
    if (restoreDraft === null) return;
    setOpen(true);
    load({ keepEdit: false }).then(() => { setDraft(restoreDraft); onRestoreTaken?.(); }, setError);
  }, [restoreDraft]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = draft !== null && saved !== undefined && draft !== (saved ?? null);
  useEffect(() => { onDraftChange?.(dirty ? draft : null); }, [dirty, draft]); // eslint-disable-line react-hooks/exhaustive-deps
  useDraftKeeper({ textId, target: { kind: 'fulltext' }, content: draft ?? '', saved: saved ?? '', dirty });

  const save = async () => {
    setError(null);
    try {
      await api.post(`/api/texts/${textId}/save`, { text: draft });
      setSaved(draft);
      savedRef.current = draft;
      setVersionKey((k) => k + 1);
      setStatus('Full text saved. The export uses it.');
    } catch (e) { setError(e); }
  };
  const region = useRef(null);
  useShortcut('save', () => { if (dirty && region.current?.contains(document.activeElement)) save(); }, canEdit && open);

  const usePages = async () => {
    if (!(await confirm({ title: 'Use the pages again?', message: 'Export this text from its page texts again? The full text is kept in its version history, where you can view or restore it.', confirmLabel: 'Use the pages again' }))) return;
    setError(null);
    try {
      await api.del(`/api/texts/${textId}/compiled`);
      setVersionKey((k) => k + 1);
      await load({ keepEdit: false });
      setStatus('The export uses the page texts again.');
    } catch (e) { setError(e); }
  };

  const editing = draft !== null;
  return (
    <section aria-labelledby={`fulltext-${textId}`} className="mt-6 rounded-md border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800">
      <h2 id={`fulltext-${textId}`} className="m-0 text-base">
        <button type="button" className="flex w-full items-center justify-between px-4 py-3 text-left" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span>Full text{saved ? ' (edited, used by the export)' : ''}</span><span aria-hidden="true">{open ? '−' : '+'}</span>
        </button>
      </h2>
      {open ? (
        <div ref={region} data-editor="fulltext" className="space-y-3 border-t border-slate-200 px-4 py-3 text-sm dark:border-slate-700">
          <ErrorNote error={error} onDismiss={() => setError(null)} />
          {saved === undefined ? <p role="status">Loading the full text</p> : (
            <>
              <p className="text-xs text-slate-600 dark:text-slate-300">
                {saved !== null
                  ? 'The export uses this full text instead of the page texts, so edits to single pages no longer reach the export. “Use the pages again” switches back and keeps this text as a version.'
                  : 'The export joins the page texts, as shown here. To work on the whole text at once (for example to join a paragraph split across two pages), edit it as one text: once saved, the export uses it instead of the pages.'}
              </p>
              {editing ? (
                <div className="grid gap-3 lg:grid-cols-2">
                  <label className="flex flex-col gap-1"><span className="label">Full text (Markdown)</span>
                    <textarea className="field min-h-[20rem] font-mono" value={draft} readOnly={!canEdit} onChange={(e) => { setDraft(e.target.value); setStatus(''); }} />
                  </label>
                  <SandboxedPreview markdown={draft} title="Preview of the full text" className="min-h-[20rem]" />
                </div>
              ) : (
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-slate-200 p-3 font-doc dark:border-slate-700" aria-label="The page texts as the export joins them">{joined || 'No page has text yet.'}</pre>
              )}
              {canEdit ? (
                <div className="flex flex-wrap items-center gap-2">
                  {!editing ? <button type="button" className="btn-quiet" disabled={!joined} onClick={() => setDraft(joined)}>Edit as one text</button> : null}
                  {editing ? <button type="button" className="btn-primary" disabled={!dirty} onClick={save}>Save full text</button> : null}
                  {editing && saved === null ? <button type="button" className="btn-quiet" onClick={() => setDraft(null)}>Cancel</button> : null}
                  {saved !== null ? <button type="button" className="btn-quiet" onClick={usePages}>Use the pages again</button> : null}
                  <span role="status" className="text-slate-600 dark:text-slate-300">{status}</span>
                </div>
              ) : null}
              <VersionHistory textId={textId} type="compiled" canRestore={canEdit} refreshKey={versionKey} dirty={dirty} heading="Version history of the full text" onRestored={() => { setVersionKey((k) => k + 1); load({ keepEdit: false }).catch(setError); }} />
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
