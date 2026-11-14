import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useSession } from '../api/session.jsx';
import { formatBytes, ErrorNote } from './ui';
import SandboxedPreview from './SandboxedPreview';
import { formatWhen, replaceWarning, versionLabel } from '../lib/versions';
import { useConfirm } from './ConfirmDialog';
import { changes } from '../lib/diff';

/** The content as saved now, for comparing the newest version with it. */
async function currentContent(textId, type, pageId) {
  if (type === 'html') return (await api.get(`/api/texts/${textId}/html`)).html_content ?? '';
  if (type === 'compiled') return (await api.get(`/api/texts/${textId}/compiled`)).text ?? '';
  const { pages } = await api.get(`/api/texts/${textId}`);
  return pages.find((p) => p.id === pageId)?.ocr_text ?? '';
}

/** One version's changes as a list of lines: removed and added are marked in text, not by colour alone. */
function ChangeList({ lines, label }) {
  if (lines.length === 0) return <p className="text-sm">No changes: the two are the same.</p>;
  return (
    <ol aria-label={label} className="max-h-[28rem] overflow-auto rounded-md border border-slate-200 font-mono text-xs dark:border-slate-700">
      {lines.map((l, i) => {
        if (l.type === 'skip') return <li key={i} className="bg-slate-50 px-2 py-1 text-slate-600 dark:bg-slate-900 dark:text-slate-300">… {l.count} unchanged line{l.count === 1 ? '' : 's'}</li>;
        const cls = l.type === 'add' ? 'bg-emerald-50 text-emerald-950 dark:bg-emerald-950 dark:text-emerald-100' : l.type === 'del' ? 'bg-rose-50 text-rose-950 line-through decoration-rose-400 dark:bg-rose-950 dark:text-rose-100' : '';
        const mark = l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' ';
        return (
          <li key={i} className={`whitespace-pre-wrap break-words px-2 py-0.5 ${cls}`}>
            <span aria-hidden="true" className="mr-2 select-none">{mark}</span>
            {l.type === 'add' ? <span className="sr-only">Added: </span> : l.type === 'del' ? <span className="sr-only">Removed: </span> : null}
            {l.line || ' '}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Version history of one text's HTML (type "html") or of one page's text
 * (type "page" with pageId). Viewing is read-only in the sandboxed preview;
 * Restore writes the old content back, and the server saves the current
 * content as a version first. `refreshKey` reloads the list after other saves.
 */
export default function VersionHistory({ textId, type, pageId, canRestore, onRestored, refreshKey, images, dirty = false, heading }) {
  const { session } = useSession();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState(null);
  const [viewing, setViewing] = useState(null); // { id, content, created_at }
  const [comparing, setComparing] = useState(null); // { id, lines, newer } newer: formatted label of what it is compared with
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const query = type === 'page' ? `type=page&page=${encodeURIComponent(pageId)}` : `type=${type}`;

  const load = useCallback(() => api.get(`/api/texts/${textId}/versions?${query}`).then((r) => setVersions(r.versions), setError), [textId, query]);
  useEffect(() => { setViewing(null); setComparing(null); setVersions(null); if (open) load(); }, [open, load, refreshKey]);

  // A version is the content before it was replaced, so its changes are what the next save, run or restore did to it.
  const compare = async (v, index) => {
    if (comparing?.id === v.id) { setComparing(null); return; }
    try {
      const newer = versions[index - 1];
      const [before, after] = await Promise.all([
        api.get(`/api/texts/${textId}/versions/${v.id}`).then((r) => r.version.content ?? ''),
        newer ? api.get(`/api/texts/${textId}/versions/${newer.id}`).then((r) => r.version.content ?? '') : currentContent(textId, type, pageId),
      ]);
      setComparing({ id: v.id, created_at: v.created_at, lines: changes(before, after), newer: newer ? `the version from ${formatWhen(newer.created_at)}` : 'the text as saved now' });
    } catch (e) { setError(e); }
  };

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
          <span>{heading ?? `Version history${type === 'page' ? ' of this page' : ''}`}</span>
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
              {versions.map((v, index) => (
                <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span>
                    <span className="block">{versionLabel(v, session?.subject)}</span>
                    <span className="block text-xs text-slate-600 dark:text-slate-300"><time dateTime={v.created_at}>{formatWhen(v.created_at)}</time>, {formatBytes(v.bytes)}</span>
                  </span>
                  <span className="flex gap-2">
                    <button type="button" className="btn-quiet" aria-pressed={comparing?.id === v.id} onClick={() => compare(v, index)}>{comparing?.id === v.id ? 'Hide changes' : 'Changes'}<span className="sr-only"> after the version from {formatWhen(v.created_at)}</span></button>
                    <button type="button" className="btn-quiet" aria-pressed={viewing?.id === v.id} onClick={() => view(v)}>{viewing?.id === v.id ? 'Hide' : 'View'}<span className="sr-only"> the version from {formatWhen(v.created_at)}</span></button>
                    {canRestore ? <button type="button" className="btn-quiet" disabled={busy} onClick={() => restore(v)}>Restore<span className="sr-only"> the version from {formatWhen(v.created_at)}</span></button> : null}
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
          {comparing ? (
            <div className="mt-3">
              <p className="text-xs text-slate-600 dark:text-slate-300">What changed from the version of {formatWhen(comparing.created_at)} to {comparing.newer}. Removed lines are struck through and marked −, added lines are marked +.</p>
              <ChangeList lines={comparing.lines} label={`Changes from the version of ${formatWhen(comparing.created_at)} to ${comparing.newer}`} />
            </div>
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
