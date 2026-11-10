import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useSession } from '../api/session.jsx';
import { formatBytes, ErrorNote } from './ui';
import SandboxedPreview from './SandboxedPreview';
import { formatWhen, replaceWarning, versionLabel } from '../lib/versions';
import { useConfirm } from './ConfirmDialog';

/**
 * Version history of one text's HTML (type "html") or of one page's text
 * (type "page" with pageId). Viewing is read-only in the sandboxed preview;
 * Restore writes the old content back, and the server saves the current
 * content as a version first. `refreshKey` reloads the list after other saves.
 */
export default function VersionHistory({ textId, type, pageId, canRestore, onRestored, refreshKey, images, dirty = false }) {
  const { session } = useSession();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState(null);
  const [viewing, setViewing] = useState(null); // { id, content, created_at }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const query = type === 'page' ? `type=page&page=${encodeURIComponent(pageId)}` : `type=${type}`;

  const load = useCallback(() => api.get(`/api/texts/${textId}/versions?${query}`).then((r) => setVersions(r.versions), setError), [textId, query]);
  useEffect(() => { setViewing(null); setVersions(null); if (open) load(); }, [open, load, refreshKey]);

  const view = async (v) => {
    if (viewing?.id === v.id) { setViewing(null); return; }
    try { setViewing((await api.get(`/api/texts/${textId}/versions/${v.id}`)).version); } catch (e) { setError(e); }
  };

  const restore = async (v) => {
    if (!(await confirm({ title: 'Restore this version?', message: replaceWarning(`Restore the version from ${formatWhen(v.created_at)}?${dirty ? ' Your unsaved changes in the editor will be lost.' : ''}`), confirmLabel: 'Restore' }))) return;
    setBusy(true);
    try {
      await api.post(`/api/texts/${textId}/versions/${v.id}/revert`, {});
      setViewing(null);
      await load();
      onRestored?.();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  const headingId = `versions-${type}-${pageId ?? textId}`;
  return (
    <section aria-labelledby={headingId} className="mt-3 rounded-md border border-slate-200 dark:border-slate-700">
      <h3 id={headingId} className="m-0 text-sm">
        <button type="button" className="flex w-full items-center justify-between px-3 py-2 text-left font-medium" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span>Version history{type === 'page' ? ' of this page' : ''}</span>
          <span aria-hidden="true">{open ? '−' : '+'}</span>
        </button>
      </h3>
      {open ? (
        <div className="border-t border-slate-200 px-3 py-2 dark:border-slate-700">
          <ErrorNote error={error} onDismiss={() => setError(null)} />
          {versions === null ? <p className="text-sm text-slate-600 dark:text-slate-300" role="status">Loading versions</p> : null}
          {versions?.length === 0 ? <p className="text-sm text-slate-600 dark:text-slate-300">No earlier versions yet. A version is saved each time the text is replaced: by a save, an OCR run, a conversion or a restore.</p> : null}
          {versions?.length ? (
            <ol className="space-y-2" aria-label="Earlier versions, newest first">
              {versions.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span>
                    <span className="block">{versionLabel(v, session?.subject)}</span>
                    <span className="block text-xs text-slate-600 dark:text-slate-300"><time dateTime={v.created_at}>{formatWhen(v.created_at)}</time>, {formatBytes(v.bytes)}</span>
                  </span>
                  <span className="flex gap-2">
                    <button type="button" className="btn-quiet" aria-pressed={viewing?.id === v.id} onClick={() => view(v)}>{viewing?.id === v.id ? 'Hide' : 'View'}<span className="sr-only"> the version from {formatWhen(v.created_at)}</span></button>
                    {canRestore ? <button type="button" className="btn-quiet" disabled={busy} onClick={() => restore(v)}>Restore<span className="sr-only"> the version from {formatWhen(v.created_at)}</span></button> : null}
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
          {viewing ? (
            <div className="mt-3">
              <p className="text-xs text-slate-600 dark:text-slate-300">Read-only view of the version from {formatWhen(viewing.created_at)}.</p>
              <SandboxedPreview {...(type === 'html' ? { html: viewing.content, images } : { markdown: viewing.content })} title={`Version from ${formatWhen(viewing.created_at)} (read-only)`} className="min-h-[16rem]" />
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
