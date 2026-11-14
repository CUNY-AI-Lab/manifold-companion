import { useCallback, useEffect, useRef, useState } from 'react';
import useFocusTrap from '../hooks/useFocusTrap';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useSession } from '../api/session.jsx';
import SharePanel from '../components/SharePanel';
import { ErrorNote, MoveButtons, Spinner, useMoveFocus } from '../components/ui';
import { RetentionBanner } from './Dashboard';
import * as toc from '../lib/toc';
import { useConfirm } from '../components/ConfirmDialog';
import { TEXTS_PER_PAGE, fetchAllTexts, pageCount, pageFromSearch, rangeLabel } from '../lib/paging';
import { SETTABLE_STATUSES, statusLabel } from '../lib/status';
import { pdfFileProblem } from '../lib/limits';

/**
 * Actions on the selected texts: set their status, delete them (after a
 * confirmation), or (image texts) merge them into a new text that copies
 * their pages in this order; the originals stay.
 */
function BulkBar({ project, texts, onDone, onError, onClear }) {
  const confirm = useConfirm();
  const [status, setStatus] = useState('reviewed');
  const [name, setName] = useState('');
  const ids = texts.map((t) => t.id);
  const n = texts.length;
  const run = async (fn) => { try { onDone(await fn()); } catch (e) { onError(e); } };
  return (
    <section aria-labelledby="bulk-title" className="sticky bottom-2 z-30 mt-3 flex flex-wrap items-end gap-3 rounded-md border border-slate-300 bg-white p-3 text-sm shadow-lg dark:border-slate-600 dark:bg-slate-800">
      <h2 id="bulk-title" className="w-full text-sm">{n} text{n === 1 ? '' : 's'} selected</h2>
      <label><span className="label">Status</span>
        <select className="field w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>{SETTABLE_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}</select>
      </label>
      <button type="button" className="btn-quiet" onClick={() => run(async () => { const r = await api.post(`/api/projects/${project.id}/texts/bulk-status`, { textIds: ids, status }); return `${r.updated} text${r.updated === 1 ? '' : 's'} set to “${statusLabel(status)}”.`; })}>Set status</button>
      {project.project_type === 'image_to_markdown' && n >= 2 ? (
        <>
          <label><span className="label">Name of the merged text</span><input className="field" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} /></label>
          <button type="button" className="btn-quiet" disabled={!name.trim()} onClick={() => run(async () => { const { text } = await api.post(`/api/projects/${project.id}/texts/merge`, { textIds: ids, name: name.trim() }); return `Merged into ${text.name}; the original texts are kept.`; })}>Merge into a new text</button>
        </>
      ) : null}
      <MoveTexts project={project} ids={ids} onDone={onDone} onError={onError} />
      <button type="button" className="btn-danger" onClick={async () => {
        if (!(await confirm({ title: `Delete ${n} text${n === 1 ? '' : 's'}?`, message: `Delete ${texts.map((t) => `“${t.name}”`).join(', ')}, with their pages, files and versions, for every member? This cannot be undone.`, confirmLabel: 'Delete selected', danger: true }))) return;
        run(async () => { const r = await api.post(`/api/projects/${project.id}/texts/bulk-delete`, { textIds: ids }); return `${r.deleted} text${r.deleted === 1 ? '' : 's'} deleted.`; });
      }}>Delete selected</button>
      <button type="button" className="btn-quiet" onClick={onClear}>Clear selection</button>
    </section>
  );
}

/** A text's status as a word with a colour (the word carries the meaning, the colour only helps scanning). */
export function StatusBadge({ status }) {
  const tone = { reviewed: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100', ocrd: 'bg-sky-100 text-sky-900 dark:bg-sky-900 dark:text-sky-100', processing: 'bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100' }[status] ?? 'bg-slate-100 text-slate-800 dark:bg-slate-700 dark:text-slate-100';
  return <span className={`rounded px-1.5 py-0.5 ${tone}`}>{statusLabel(status)}</span>;
}

const formatMb = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The confirmation text for a move, from the Worker's preview (what goes, what is deleted, whose storage). */
export function moveMessage(preview) {
  const { totals: t, destination: d } = preview;
  return [
    `Move ${plural(t.texts, 'text')} (${plural(t.pages, 'page')}, ${plural(t.versions, 'saved version')}, ${formatMb(t.bytes)}) to “${d.name}”?`,
    'Their pages, files, version history, metadata and model settings go with them. They get new addresses, so links to them stop working, and they leave this project\'s export.',
    t.comments ? `Their ${plural(t.comments, 'comment')} will be deleted: comments stay with the project whose members they were written for. Copy anything you need from them first.` : 'They have no comments.',
    d.same_owner ? '' : `From now on their storage counts against the owner of “${d.name}”, not this project's owner.`,
  ].filter(Boolean).join('\n\n');
}

/** Move the selected texts to another project the person can edit, of the same kind. */
function MoveTexts({ project, ids, onDone, onError }) {
  const confirm = useConfirm();
  const [targets, setTargets] = useState(null);
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get('/api/projects').then((r) => setTargets(r.projects.filter((p) => p.id !== project.id && p.project_type === project.project_type && p.role !== 'viewer')), () => setTargets([]));
  }, [project.id, project.project_type]);
  if (!targets?.length) return null;
  const go = async () => {
    setBusy(true);
    try {
      const { preview } = await api.post(`/api/projects/${project.id}/texts/move`, { textIds: ids, to, preview: true });
      if (!(await confirm({ title: `Move to “${preview.destination.name}”?`, message: moveMessage(preview), confirmLabel: 'Move', danger: preview.totals.comments > 0 }))) return;
      const r = await api.post(`/api/projects/${project.id}/texts/move`, { textIds: ids, to });
      if (r.failed.length) onError({ message: `${r.moved.length ? `Moved ${plural(r.moved.length, 'text')} to “${r.destination.name}”. ` : ''}Not moved: ${r.failed.map((f) => `“${f.name}” (${f.message})`).join('; ')}` });
      if (r.moved.length) onDone(`Moved ${plural(r.moved.length, 'text')} to “${r.destination.name}”.`, { keepError: r.failed.length > 0 });
    } catch (e) { onError(e); } finally { setBusy(false); }
  };
  return (
    <>
      <label><span className="label">Move to project</span>
        <select className="field w-auto" value={to} onChange={(e) => setTo(e.target.value)}><option value="">Choose a project</option>{targets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      </label>
      <button type="button" className="btn-quiet" disabled={!to || busy} onClick={go}>{busy ? 'Moving' : 'Move'}</button>
    </>
  );
}

/** A pending ownership offer made to me for this project: accept (after a confirmation) or decline. */
function TransferOffer({ projectId, onAccepted }) {
  const confirm = useConfirm();
  const [offer, setOffer] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => api.get('/api/transfers').then((r) => setOffer(r.offers.find((o) => o.project_id === projectId) ?? null), () => {}), [projectId]);
  useEffect(() => { load(); }, [load]);
  if (!offer) return error ? <ErrorNote error={error} onDismiss={() => setError(null)} /> : null;
  const from = offer.from_name || 'The owner';
  return (
    <section aria-labelledby="transfer-offer" className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
      <h2 id="transfer-offer" className="text-base">Ownership offered to you</h2>
      <p className="mt-1">{from} asks you to become the owner of this project (offer expires {offer.expires_at.slice(0, 10)}). If you accept, its storage counts against your allowance, only you can share it, transfer it or delete it, and {from} stays on as an editor.</p>
      <ErrorNote error={error} onDismiss={() => setError(null)} />
      <div className="mt-2 flex gap-2">
        <button type="button" className="btn-primary" onClick={async () => {
          if (!(await confirm({ title: 'Become the owner?', message: `Take over this project from ${from}? Its stored files count against your storage allowance from now on.`, confirmLabel: 'Accept ownership' }))) return;
          try { await api.post(`/api/transfers/${offer.id}/accept`, {}); setOffer(null); onAccepted(); } catch (e) { setError(e); load(); }
        }}>Accept ownership</button>
        <button type="button" className="btn-quiet" onClick={async () => { try { await api.post(`/api/transfers/${offer.id}/decline`, {}); setOffer(null); } catch (e) { setError(e); } }}>Decline</button>
      </div>
    </section>
  );
}

/** Project-level metadata (the owner's): name, description and default language, the export's fallbacks. */
function ProjectDetails({ project, onSaved }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: project.name, description: project.description ?? '', default_language: project.default_language ?? 'en' });
  const [status, setStatus] = useState('');
  const [error, setError] = useState(null);
  const save = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      await api.put(`/api/projects/${project.id}`, { name: form.name.trim(), description: form.description.trim() === '' ? null : form.description, default_language: form.default_language.trim() });
      setStatus('Project details saved.');
      onSaved();
    } catch (err) { setError(err); }
  };
  return (
    <section aria-labelledby="project-details" className="mt-4 rounded-md border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800">
      <h2 id="project-details" className="m-0 text-base">
        <button type="button" className="flex w-full items-center justify-between px-4 py-3 text-left" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span>Project details</span><span aria-hidden="true">{open ? '−' : '+'}</span>
        </button>
      </h2>
      {open ? (
        <form className="grid gap-3 border-t border-slate-200 px-4 py-3 sm:grid-cols-2 dark:border-slate-700" onSubmit={save}>
          <ErrorNote error={error} onDismiss={() => setError(null)} />
          <label className="sm:col-span-2"><span className="label">Project name</span><input className="field" required maxLength={200} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="sm:col-span-2"><span className="label">Description</span><textarea className="field" maxLength={2000} rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
          <label><span className="label">Default language code</span><input className="field" maxLength={20} value={form.default_language} onChange={(e) => setForm({ ...form, default_language: e.target.value })} /></label>
          <p className="text-xs text-slate-600 dark:text-slate-300 sm:col-span-2">The export uses these when its own title, description or language are left empty.</p>
          <div className="flex items-center gap-3 sm:col-span-2"><button className="btn-primary" type="submit">Save details</button><span role="status" className="text-sm text-slate-600 dark:text-slate-300">{status}</span></div>
        </form>
      ) : null}
    </section>
  );
}

function TocEditor({ items, setItems, texts }) {
  const [section, setSection] = useState('');
  const [adding, setAdding] = useState('');
  const missing = texts.filter((t) => !items.some((i) => i.type === 'text' && i.textId === t.id));
  const btn = 'btn-icon';
  return (
    <fieldset className="mt-3">
      <legend className="label">Table of contents</legend>
      <p className="mb-2 text-xs text-slate-600 dark:text-slate-300">The export follows this order. Indent an item to nest it under the item above; sections become their own pages in Manifold.</p>
      {items.length === 0 ? <p className="text-sm text-slate-600 dark:text-slate-300">Nothing to export yet. Add a text or a section.</p> : null}
      <ol className="space-y-1" aria-label="Table of contents items">
        {items.map((item, i) => (
          <li key={item.id} className="flex flex-wrap items-center gap-1 text-sm" style={{ paddingLeft: `${item.depth * 1.25}rem` }}>
            <span className="sr-only">Level {item.depth + 1}, </span>
            {item.type === 'section' ? (
              <label className="flex flex-1 items-center gap-1"><span className="text-xs font-semibold uppercase text-slate-600 dark:text-slate-300">Section</span>
                <input className="field min-w-0 flex-1" aria-label={`Section label, item ${i + 1}`} value={item.label} maxLength={toc.MAX_LABEL} onChange={(e) => setItems(toc.relabel(items, i, e.target.value))} />
              </label>
            ) : <span className="flex-1 truncate">{item.label}</span>}
            <button type="button" className={btn} aria-label={`Move ${item.label} up`} disabled={i === 0} onClick={() => setItems(toc.move(items, i, -1))}><span aria-hidden="true">↑</span></button>
            <button type="button" className={btn} aria-label={`Move ${item.label} down`} disabled={i === items.length - 1} onClick={() => setItems(toc.move(items, i, 1))}><span aria-hidden="true">↓</span></button>
            <button type="button" className={btn} aria-label={`Outdent ${item.label}`} disabled={item.depth === 0} onClick={() => setItems(toc.indent(items, i, -1))}><span aria-hidden="true">←</span></button>
            <button type="button" className={btn} aria-label={`Indent ${item.label}`} disabled={item.depth >= toc.MAX_DEPTH || i === 0} onClick={() => setItems(toc.indent(items, i, 1))}><span aria-hidden="true">→</span></button>
            <button type="button" className={btn} aria-label={`Remove ${item.label} from the export`} onClick={() => setItems(toc.remove(items, i))}><span aria-hidden="true">×</span></button>
          </li>
        ))}
      </ol>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="text-sm"><span className="label">New section</span><input className="field" value={section} maxLength={toc.MAX_LABEL} onChange={(e) => setSection(e.target.value)} /></label>
        <button type="button" className="btn-quiet" disabled={!section.trim()} onClick={() => { setItems(toc.addSection(items, section)); setSection(''); }}>Add section</button>
        {missing.length ? (
          <>
            <label className="text-sm"><span className="label">Text not in the export</span>
              <select className="field" value={adding} onChange={(e) => setAdding(e.target.value)}><option value="">Choose a text</option>{missing.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
            </label>
            <button type="button" className="btn-quiet" disabled={!adding} onClick={() => { const t = texts.find((x) => x.id === adding); if (t) setItems(toc.addText(items, t)); setAdding(''); }}>Add text</button>
          </>
        ) : null}
      </div>
    </fieldset>
  );
}

/** The export covers every text of the project, not just the page of the list on screen. */
function ExportPanel({ project, onClose }) {
  const [texts, setTexts] = useState(null);
  const [failed, setFailed] = useState(null);
  useEffect(() => { fetchAllTexts(api, project.id).then(setTexts, setFailed); }, [project.id]);
  const dialog = useRef(null);
  useFocusTrap(dialog, !texts, onClose);
  if (!texts) {
    return (
      <div ref={dialog} role="dialog" aria-modal="true" aria-label="Export for Manifold" tabIndex={-1} className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 p-4">
        <div className="mt-12 w-full max-w-2xl rounded-lg bg-white p-5 shadow-xl dark:bg-slate-800">{failed ? <><ErrorNote error={failed} /><button className="btn-quiet" type="button" onClick={onClose}>Close</button></> : <Spinner label="Loading the texts" />}</div>
      </div>
    );
  }
  return <ExportForm project={project} texts={texts} onClose={onClose} />;
}

function ExportForm({ project, texts, onClose }) {
  const canSave = project.role !== 'viewer';
  const [items, setItems] = useState(() => toc.reconcileToc([], texts));
  const [meta, setMeta] = useState({ title: project.name, creators: '', date: new Date().toISOString().slice(0, 10), language: project.default_language, rights: '', description: project.description ?? '' });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState(null);
  const dialog = useRef(null);
  useFocusTrap(dialog, true, onClose);
  useEffect(() => {
    api.get(`/api/projects/${project.id}/export-settings`).then((r) => {
      if (r.settings?.meta) setMeta((m) => ({ ...m, ...Object.fromEntries(Object.entries(r.settings.meta).filter(([, v]) => v)) }));
      if (Array.isArray(r.settings?.tocFlat) && r.settings.tocFlat.length) setItems(toc.reconcileToc(r.settings.tocFlat, texts, r.settings.excluded));
    }, () => {});
  }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const tocFlat = items.map(({ id, type, label, depth, textId }) => ({ id, type, label, depth, ...(textId ? { textId } : {}) }));
  const excluded = toc.excludedIds(items, texts);
  const saveOnly = async () => {
    setError(null);
    try { await api.put(`/api/projects/${project.id}/export-settings`, { meta, tocFlat, excluded }); setStatus('Export settings saved.'); } catch (e) { setError(e); }
  };
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.raw(`/api/projects/${project.id}/export`, { method: 'POST', body: { meta, toc: toc.flatToNested(items), ...(canSave ? { tocFlat, excluded } : {}) } });
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `${project.name.replace(/[^\w-]+/g, '_') || 'export'}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      if (canSave) setStatus('Exported; these settings are saved for next time.');
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const hasText = items.some((i) => i.type === 'text');
  return (
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="export-title" tabIndex={-1} className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4">
      <div className="mt-12 w-full max-w-2xl rounded-lg bg-white p-5 shadow-xl dark:bg-slate-800">
        <div className="flex items-center justify-between"><h2 id="export-title" className="text-lg">Export for Manifold</h2><button className="btn-quiet" type="button" onClick={onClose}>Close</button></div>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">A ZIP with one file per text and section and a manifest.yml. Mathematics is converted to MathML.{canSave ? '' : ' As a viewer you can export; your changes here are not saved for the project.'}</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {['title', 'creators', 'date', 'language', 'rights', 'description'].map((k) => (
            <label key={k} className={k === 'description' ? 'sm:col-span-2' : ''}><span className="label">{k === 'creators' ? 'Creators (separate with ;)' : k[0].toUpperCase() + k.slice(1)}</span><input className="field" value={meta[k] ?? ''} onChange={(e) => setMeta({ ...meta, [k]: e.target.value })} /></label>
          ))}
        </div>
        <TocEditor items={items} setItems={(next) => { setItems(next); setStatus(''); }} texts={texts} />
        <ErrorNote error={error} />
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button className="btn-primary" type="button" disabled={busy || !hasText} onClick={run}>{busy ? 'Building the ZIP' : 'Download ZIP'}</button>
          {canSave ? <button className="btn-quiet" type="button" onClick={saveOnly}>Save settings</button> : null}
          <span role="status" className="text-sm text-slate-600 dark:text-slate-300">{status}</span>
        </div>
      </div>
    </div>
  );
}

/** Select or clear every text listed on this page (indeterminate when some are). */
function SelectAll({ texts, chosen, setChosen, paged }) {
  const box = useRef(null);
  const ids = texts.map((t) => t.id);
  const n = ids.filter((x) => chosen.includes(x)).length;
  useEffect(() => { if (box.current) box.current.indeterminate = n > 0 && n < ids.length; }, [n, ids.length]);
  return (
    <label className="mt-6 inline-flex items-center gap-2 text-sm">
      <input ref={box} type="checkbox" checked={n === ids.length} onChange={(e) => setChosen(e.target.checked ? ids : [])} />
      Select all {paged ? `${ids.length} texts on this page` : `${ids.length} texts`}
    </label>
  );
}

const isPdfFile = (f) => f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name));

/** Store a PDF as a text's source PDF (checked against the limits first). Nothing is converted here. */
async function storeSourcePdf({ textId, file, replace, session }) {
  if (!isPdfFile(file)) throw new Error(`${file.name} is not a PDF.`);
  const problem = session?.limits ? pdfFileProblem({ name: file.name, bytes: file.size, maxPdfBytes: session.limits.max_pdf_bytes, usedBytes: session.storage.used_bytes, quotaBytes: session.storage.quota_bytes }) : null;
  if (problem) throw new Error(problem);
  await api.upload(`/api/texts/${textId}/source-pdf`, file, { method: 'PUT', filename: file.name, query: replace ? { replace: '1' } : {} });
}

/** A PDF text's row: its source PDF by name, and Upload or Replace without opening the text. */
function SourcePdfCell({ text, canEdit, onStored, onError }) {
  const { session } = useSession();
  const confirm = useConfirm();
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const pick = async (file) => {
    if (!file) return;
    if (text.has_source_pdf && !(await confirm({ title: 'Replace the source PDF?', message: `Replace ${text.source_pdf_name || 'the stored PDF'} of “${text.name}” with ${file.name}? The old PDF is deleted. The converted HTML stays until you convert again.`, confirmLabel: 'Replace the PDF' }))) return;
    setBusy(true);
    try { await storeSourcePdf({ textId: text.id, file, replace: text.has_source_pdf, session }); onStored(`${file.name} stored for “${text.name}”. Open the text to convert it.`); } catch (e) { onError(e); } finally { setBusy(false); }
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
      <span>{text.has_source_pdf ? `Source: ${text.source_pdf_name || 'a PDF'}` : 'No source PDF yet'}</span>
      {canEdit ? (
        <>
          <input ref={input} type="file" accept="application/pdf" className="hidden" tabIndex={-1} aria-hidden="true" onChange={(e) => { const f = e.target.files[0]; e.target.value = ''; pick(f); }} />
          <button type="button" className="btn-quiet" disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Uploading' : text.has_source_pdf ? 'Replace PDF' : 'Upload PDF'}<span className="sr-only"> for {text.name}</span></button>
        </>
      ) : null}
    </span>
  );
}

/** Import PDFs as new texts, one text per PDF named after the file; each is converted from its page. */
function ImportPdfs({ projectId, onDone, onError }) {
  const { session } = useSession();
  const input = useRef(null);
  const [busy, setBusy] = useState('');
  const run = async (files) => {
    const created = [];
    try {
      for (const file of files) {
        setBusy(`Importing ${file.name}`);
        if (!isPdfFile(file)) throw new Error(`${file.name} is not a PDF; nothing more was imported.`);
        const name = file.name.replace(/\.pdf$/i, '').slice(0, 200) || 'Untitled';
        const { text } = await api.post(`/api/projects/${projectId}/texts`, { name });
        try { await storeSourcePdf({ textId: text.id, file, replace: false, session }); } catch (e) { await api.del(`/api/texts/${text.id}`).catch(() => {}); throw e; }
        created.push(name);
      }
    } catch (e) { onError(e); } finally {
      setBusy('');
      if (created.length) onDone(`Imported ${created.map((n) => `“${n}”`).join(', ')}. Open each text to convert it.`);
    }
  };
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
      <input ref={input} type="file" accept="application/pdf" multiple className="hidden" tabIndex={-1} aria-hidden="true" onChange={(e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) run(fs); }} />
      <button type="button" className="btn-quiet" disabled={!!busy} aria-describedby="import-pdf-hint" onClick={() => input.current?.click()}>{busy || 'Import PDFs as new texts'}</button>
      <span id="import-pdf-hint" className="text-xs text-slate-600 dark:text-slate-300">One new text per PDF, named after the file. Nothing is converted until you press Convert on the text.</span>
    </div>
  );
}

function Pager({ page, total, onPage }) {
  const count = pageCount(total);
  if (count <= 1) return null;
  return (
    <nav aria-label="Pages of texts" className="mt-3 flex flex-wrap items-center gap-3 text-sm">
      <button type="button" className="btn-quiet" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous {TEXTS_PER_PAGE}</button>
      <span>Page {page} of {count}</span>
      <button type="button" className="btn-quiet" disabled={page >= count} onClick={() => onPage(page + 1)}>Next {TEXTS_PER_PAGE}</button>
    </nav>
  );
}

export default function ProjectPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const page = pageFromSearch(location.search);
  const { refresh } = useSession();
  const confirm = useConfirm();
  const [project, setProject] = useState(null);
  const [texts, setTexts] = useState([]);
  const [total, setTotal] = useState(0);
  const [moved, setMoved] = useState('');
  const focusMoved = useMoveFocus([texts]);
  const [chosen, setChosen] = useState([]);
  const [name, setName] = useState('');
  const [panel, setPanel] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    try {
      const [p, t] = await Promise.all([api.get(`/api/projects/${id}`), api.get(`/api/projects/${id}/texts?limit=${TEXTS_PER_PAGE}&page=${page}`)]);
      setProject(p.project);
      setTotal(t.total);
      // A page past the end (texts deleted meanwhile) goes to the last page that exists.
      if (t.texts.length === 0 && t.total > 0 && page > 1) { navigate(`?page=${pageCount(t.total)}`, { replace: true }); return; }
      setTexts(t.texts);
    } catch (e) { setError(e); }
  }, [id, page, navigate]);
  const offset = (page - 1) * TEXTS_PER_PAGE;
  const goToPage = (n) => { setChosen([]); navigate(n === 1 ? '?' : `?page=${n}`); };
  // `index` is the text's position in the whole project (the list shows one page of it).
  const moveText = async (index, dir, position) => {
    const t = texts[index - offset];
    setError(null);
    try {
      const r = await api.post(`/api/projects/${id}/texts/${t.id}/move`, { to: dir === 'to' ? position : index + 1 + (dir === 'up' ? -1 : 1) });
      setMoved(`${t.name} moved to position ${r.position} of ${r.total}.`);
      focusMoved({ idBase: `move-text-${t.id}`, dir });
      await load();
    } catch (e) { setError(e); }
  };
  useEffect(() => { load(); }, [load]);
  if (error && !project) return <ErrorNote error={error.status === 404 ? { message: 'This project does not exist or you no longer have access to it.' } : error} />;
  if (!project) return <Spinner />;
  const canEdit = project.role !== 'viewer';
  const isOwner = project.role === 'owner';
  return (
    <div>
      <p className="text-sm"><Link to="/">Projects</Link></p>
      <div className="mt-1 flex flex-wrap items-center gap-3">
        <h1 className="doc-title text-3xl">{project.name}</h1>
        <span className="text-xs text-slate-500 dark:text-slate-400">{project.project_type === 'pdf_to_html' ? 'PDF to HTML' : 'Image to Markdown'}, you are {project.role === 'owner' ? 'the owner' : `a ${project.role}`}</span>
        <div className="ml-auto flex gap-2">
          <button className="btn-quiet" type="button" onClick={() => setPanel('export')} disabled={total === 0}>Export</button>
          {isOwner ? <button className="btn-quiet" type="button" onClick={() => setPanel('share')}>Share</button> : null}
        </div>
      </div>
      {project.description ? <p className="mt-2 max-w-prose text-slate-600 dark:text-slate-300">{project.description}</p> : null}
      <div className="mt-3"><RetentionBanner project={project} /></div>
      <TransferOffer projectId={id} onAccepted={() => { load(); refresh(); }} />
      {isOwner ? <ProjectDetails project={project} onSaved={load} /> : null}
      <ErrorNote error={error} onDismiss={() => setError(null)} />
      {total > TEXTS_PER_PAGE ? <p className="mt-6 text-sm text-slate-600 dark:text-slate-300">{rangeLabel(page, total)}</p> : null}
      {canEdit && texts.length > 1 ? <SelectAll texts={texts} chosen={chosen} setChosen={setChosen} paged={total > TEXTS_PER_PAGE} /> : null}
      <ul className="rowlist mt-2 rounded-md border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800">
        {texts.length === 0 ? <li className="p-4 text-sm text-slate-500 dark:text-slate-400">{canEdit ? 'No texts yet. Add one below, then upload its pages.' : 'No texts yet.'}</li> : null}
        {texts.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center gap-3 p-4">
            {canEdit ? <input type="checkbox" aria-label={`Select ${t.name}`} checked={chosen.includes(t.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, t.id] : chosen.filter((x) => x !== t.id))} /> : null}
            {canEdit && total > 1 ? <MoveButtons label={t.name} index={offset + texts.indexOf(t)} total={total} idBase={`move-text-${t.id}`} onMove={moveText} positions /> : null}
            <Link to={`/texts/${t.id}`} className="doc-title text-lg">{t.name}</Link>
            {project.project_type === 'pdf_to_html'
              ? <span className="inline-flex flex-wrap items-center gap-3 text-xs text-slate-600 dark:text-slate-300"><span>{t.has_html ? 'Converted' : 'Not converted yet'}</span><SourcePdfCell text={t} canEdit={canEdit} onStored={(msg) => { setMoved(msg); load(); refresh(); }} onError={setError} /></span>
              : <span className="text-xs text-slate-600 dark:text-slate-300">{plural(t.page_count, 'page')}, <StatusBadge status={t.status} /></span>}
            {canEdit ? <button className="btn-quiet ml-auto" type="button" onClick={async () => { if (!(await confirm({ title: 'Delete this text?', message: `Delete “${t.name}”, its pages, files and versions, for every member? This cannot be undone.`, confirmLabel: 'Delete text', danger: true }))) return; try { await api.del(`/api/texts/${t.id}`); load(); refresh(); } catch (e) { setError(e); } }}>Delete</button> : null}
          </li>
        ))}
      </ul>
      <Pager page={page} total={total} onPage={goToPage} />
      {canEdit && chosen.length ? <BulkBar project={project} texts={texts.filter((t) => chosen.includes(t.id))} onDone={(msg, opts) => { setChosen([]); setMoved(msg); if (!opts?.keepError) setError(null); load(); refresh(); }} onError={setError} onClear={() => setChosen([])} /> : null}
      <p className="mt-2 text-sm text-slate-700 dark:text-slate-200" role="status">{moved}</p>
      {canEdit && total > 1 ? <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">Texts export in this order. Use the arrows to move a text up or down{total > TEXTS_PER_PAGE ? '; the first or last text of a page moves onto the next page' : ''}.</p> : null}
      {canEdit ? (
        <form className="mt-4 flex gap-2" onSubmit={async (e) => { e.preventDefault(); try { const { text } = await api.post(`/api/projects/${id}/texts`, { name }); navigate(`/texts/${text.id}`); } catch (err) { setError(err); } }}>
          <label className="sr-only" htmlFor="new-text">New text name</label>
          <input id="new-text" className="field max-w-sm" placeholder="Name of a new text" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn-primary" type="submit">Add text</button>
        </form>
      ) : null}
      {canEdit && project.project_type === 'pdf_to_html' ? <ImportPdfs projectId={id} onDone={(msg) => { setMoved(msg); load(); refresh(); }} onError={setError} /> : null}
      <div className="mt-10 flex gap-2">
        {isOwner ? <button className="btn-danger" type="button" onClick={async () => { if (!(await confirm({ title: 'Delete this project?', message: 'Delete this project, all its texts and files, for every member? This cannot be undone. Export first if you want to keep a copy.', confirmLabel: 'Delete project', danger: true }))) return; try { await api.del(`/api/projects/${id}`); refresh(); navigate('/'); } catch (e) { setError(e); } }}>Delete project</button> : (
          <button className="btn-quiet" type="button" onClick={async () => { if (!(await confirm({ title: 'Leave this project?', message: 'You lose access until the owner invites you again.', confirmLabel: 'Leave project', danger: true }))) return; try { const me = (await api.get(`/api/projects/${id}/members`)).members.find((m) => m.me); await api.del(`/api/projects/${id}/members/${me.subject}`); navigate('/'); } catch (e) { setError(e); } }}>Leave project</button>
        )}
      </div>
      {panel === 'share' ? <SharePanel projectId={id} onClose={() => setPanel(null)} /> : null}
      {panel === 'export' ? <ExportPanel project={project} onClose={() => setPanel(null)} /> : null}
    </div>
  );
}
