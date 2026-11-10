import { useCallback, useEffect, useRef, useState } from 'react';
import useFocusTrap from '../hooks/useFocusTrap';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useSession } from '../api/session.jsx';
import SharePanel from '../components/SharePanel';
import { ErrorNote, MoveButtons, Spinner, useMoveFocus } from '../components/ui';
import { RetentionBanner } from './Dashboard';
import * as toc from '../lib/toc';

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

function ExportPanel({ project, texts, onClose }) {
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

export default function ProjectPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { refresh } = useSession();
  const [project, setProject] = useState(null);
  const [texts, setTexts] = useState([]);
  const [total, setTotal] = useState(0);
  const [moved, setMoved] = useState('');
  const focusMoved = useMoveFocus([texts]);
  const [name, setName] = useState('');
  const [panel, setPanel] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    try {
      const [p, t] = await Promise.all([api.get(`/api/projects/${id}`), api.get(`/api/projects/${id}/texts?limit=50`)]);
      setProject(p.project);
      setTexts(t.texts);
      setTotal(t.total);
    } catch (e) { setError(e); }
  }, [id]);
  const moveText = async (index, dir) => {
    const t = texts[index];
    setError(null);
    try {
      const r = await api.post(`/api/projects/${id}/texts/${t.id}/move`, { to: index + 1 + (dir === 'up' ? -1 : 1) });
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
          <button className="btn-quiet" type="button" onClick={() => setPanel('export')} disabled={texts.length === 0}>Export</button>
          {isOwner ? <button className="btn-quiet" type="button" onClick={() => setPanel('share')}>Share</button> : null}
        </div>
      </div>
      {project.description ? <p className="mt-2 max-w-prose text-slate-600 dark:text-slate-300">{project.description}</p> : null}
      <div className="mt-3"><RetentionBanner project={project} /></div>
      {isOwner ? <ProjectDetails project={project} onSaved={load} /> : null}
      <ErrorNote error={error} onDismiss={() => setError(null)} />
      <ul className="rowlist mt-6 rounded-md border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800">
        {texts.length === 0 ? <li className="p-4 text-sm text-slate-500 dark:text-slate-400">{canEdit ? 'No texts yet. Add one below, then upload its pages.' : 'No texts yet.'}</li> : null}
        {texts.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center gap-3 p-4">
            {canEdit && texts.length > 1 ? <MoveButtons label={t.name} index={texts.indexOf(t)} total={total} idBase={`move-text-${t.id}`} onMove={moveText} /> : null}
            <Link to={`/texts/${t.id}`} className="doc-title text-lg">{t.name}</Link>
            <span className="text-xs text-slate-500 dark:text-slate-400">{project.project_type === 'pdf_to_html' ? (t.has_html ? 'converted' : 'not converted yet') : `${t.page_count} pages, ${t.status}`}</span>
            {canEdit ? <button className="btn-quiet ml-auto" type="button" onClick={async () => { if (!window.confirm(`Delete “${t.name}” and its files?`)) return; try { await api.del(`/api/texts/${t.id}`); load(); refresh(); } catch (e) { setError(e); } }}>Delete</button> : null}
          </li>
        ))}
      </ul>
      <p className="sr-only" role="status">{moved}</p>
      {canEdit && texts.length > 1 ? <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">Texts export in this order. Use the arrows to move a text up or down.</p> : null}
      {canEdit ? (
        <form className="mt-4 flex gap-2" onSubmit={async (e) => { e.preventDefault(); try { const { text } = await api.post(`/api/projects/${id}/texts`, { name }); navigate(`/texts/${text.id}`); } catch (err) { setError(err); } }}>
          <label className="sr-only" htmlFor="new-text">New text name</label>
          <input id="new-text" className="field max-w-sm" placeholder="Name of a new text" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn-primary" type="submit">Add text</button>
        </form>
      ) : null}
      <div className="mt-10 flex gap-2">
        {isOwner ? <button className="btn-danger" type="button" onClick={async () => { if (!window.confirm('Delete this project, all its texts and files, for every member?')) return; try { await api.del(`/api/projects/${id}`); refresh(); navigate('/'); } catch (e) { setError(e); } }}>Delete project</button> : (
          <button className="btn-quiet" type="button" onClick={async () => { try { const me = (await api.get(`/api/projects/${id}/members`)).members.find((m) => m.me); await api.del(`/api/projects/${id}/members/${me.subject}`); navigate('/'); } catch (e) { setError(e); } }}>Leave project</button>
        )}
      </div>
      {panel === 'share' ? <SharePanel projectId={id} onClose={() => setPanel(null)} onTransferred={() => { setPanel(null); load(); refresh(); }} /> : null}
      {panel === 'export' ? <ExportPanel project={project} texts={texts} onClose={() => setPanel(null)} /> : null}
    </div>
  );
}
