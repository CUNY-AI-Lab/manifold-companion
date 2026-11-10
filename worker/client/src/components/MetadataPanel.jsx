import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { ErrorNote } from './ui';

// The legacy Dublin Core field set, in the legacy order. Title, creator and
// language also name the text in the Manifold export (front matter or <title>,
// <html lang>), falling back to the text's name and the export's metadata.
export const DC_FIELDS = [
  { key: 'dc_title', label: 'Title' },
  { key: 'dc_creator', label: 'Creator' },
  { key: 'dc_subject', label: 'Subject' },
  { key: 'dc_description', label: 'Description' },
  { key: 'dc_publisher', label: 'Publisher' },
  { key: 'dc_contributor', label: 'Contributor' },
  { key: 'dc_date', label: 'Date' },
  { key: 'dc_type', label: 'Type' },
  { key: 'dc_format', label: 'Format' },
  { key: 'dc_identifier', label: 'Identifier' },
  { key: 'dc_source', label: 'Source' },
  { key: 'dc_language', label: 'Language' },
  { key: 'dc_relation', label: 'Relation' },
  { key: 'dc_coverage', label: 'Coverage' },
  { key: 'dc_rights', label: 'Rights' },
];

/** Dublin Core metadata of one text: editors and owners edit, viewers read. */
export default function MetadataPanel({ textId, canEdit }) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(null);
  const [draft, setDraft] = useState({});
  const [status, setStatus] = useState('');
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!open || saved) return;
    api.get(`/api/texts/${textId}/metadata`).then((r) => { setSaved(r.metadata ?? {}); setDraft(r.metadata ?? {}); }, setError);
  }, [open, saved, textId]);
  const dirty = saved && DC_FIELDS.some((f) => (draft[f.key] ?? '') !== (saved[f.key] ?? ''));
  const save = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      const body = Object.fromEntries(DC_FIELDS.map((f) => [f.key, draft[f.key] ?? '']));
      const { metadata } = await api.post(`/api/texts/${textId}/metadata`, body);
      setSaved(metadata ?? {});
      setDraft(metadata ?? {});
      setStatus('Metadata saved.');
    } catch (err) { setError(err); }
  };
  return (
    <section aria-labelledby={`metadata-${textId}`} className="mt-6 rounded-md border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800">
      <h2 id={`metadata-${textId}`} className="m-0 text-base">
        <button type="button" className="flex w-full items-center justify-between px-4 py-3 text-left" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span>Dublin Core metadata</span><span aria-hidden="true">{open ? '−' : '+'}</span>
        </button>
      </h2>
      {open ? (
        <form className="border-t border-slate-200 px-4 py-3 dark:border-slate-700" onSubmit={save}>
          <ErrorNote error={error} onDismiss={() => setError(null)} />
          <p className="mb-3 text-xs text-slate-600 dark:text-slate-300">Title, creator and language are used for this text in the Manifold export; empty fields fall back to the text's name and the export's own metadata.{canEdit ? '' : ' You can read these; editors and owners can change them.'}</p>
          {saved === null ? <p role="status" className="text-sm">Loading metadata</p> : (
            <div className="grid gap-3 sm:grid-cols-2">
              {DC_FIELDS.map((f) => (
                <label key={f.key} className="block text-sm">
                  <span className="label">{f.label}</span>
                  <input className="field" name={f.key} maxLength={2000} readOnly={!canEdit} value={draft[f.key] ?? ''} onChange={(e) => { setDraft((d) => ({ ...d, [f.key]: e.target.value })); setStatus(''); }} />
                </label>
              ))}
            </div>
          )}
          {canEdit ? <div className="mt-3 flex items-center gap-3"><button className="btn-primary" type="submit" disabled={!dirty}>Save metadata</button><span role="status" className="text-sm text-slate-600 dark:text-slate-300">{status}</span></div> : null}
        </form>
      ) : null}
    </section>
  );
}
