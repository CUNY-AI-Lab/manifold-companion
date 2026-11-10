import { useCallback, useEffect, useRef, useState } from 'react';
import useFocusTrap from '../hooks/useFocusTrap';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useSession } from '../api/session.jsx';
import SharePanel from '../components/SharePanel';
import { ErrorNote, MoveButtons, Spinner, useMoveFocus } from '../components/ui';
import { RetentionBanner } from './Dashboard';

function ExportPanel({ project, texts, onClose }) {
  const [selected, setSelected] = useState(() => texts.map((t) => t.id));
  const [meta, setMeta] = useState({ title: project.name, creators: '', date: new Date().toISOString().slice(0, 10), language: project.default_language, rights: '', description: project.description ?? '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const dialog = useRef(null);
  useFocusTrap(dialog, true, onClose);
  useEffect(() => {
    api.get(`/api/projects/${project.id}/export-settings`).then((r) => { if (r.settings?.meta) setMeta((m) => ({ ...m, ...r.settings.meta })); }, () => {});
  }, [project.id]);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const toc = texts.filter((t) => selected.includes(t.id)).map((t) => ({ type: 'text', textId: t.id, label: t.name, children: [] }));
      const res = await api.raw(`/api/projects/${project.id}/export`, { method: 'POST', body: { meta, toc, tocFlat: selected } });
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `${project.name.replace(/[^\w-]+/g, '_') || 'export'}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="export-title" tabIndex={-1} className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4">
      <div className="mt-12 w-full max-w-xl rounded-lg bg-white p-5 shadow-xl dark:bg-slate-800">
        <div className="flex items-center justify-between"><h2 id="export-title" className="text-lg">Export for Manifold</h2><button className="btn-quiet" type="button" onClick={onClose}>Close</button></div>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">A ZIP with one file per text and a manifest.yml, in the order listed. Mathematics is converted to MathML.</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {['title', 'creators', 'date', 'language', 'rights', 'description'].map((k) => (
            <label key={k} className={k === 'description' ? 'sm:col-span-2' : ''}><span className="label">{k === 'creators' ? 'Creators (separate with ;)' : k[0].toUpperCase() + k.slice(1)}</span><input className="field" value={meta[k] ?? ''} onChange={(e) => setMeta({ ...meta, [k]: e.target.value })} /></label>
          ))}
        </div>
        <fieldset className="mt-3"><legend className="label">Texts to include</legend>
          {texts.map((t) => <label key={t.id} className="block text-sm"><input type="checkbox" checked={selected.includes(t.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, t.id] : selected.filter((x) => x !== t.id))} /> {t.name}</label>)}
        </fieldset>
        <ErrorNote error={error} />
        <button className="btn-primary mt-4" type="button" disabled={busy || selected.length === 0} onClick={run}>{busy ? 'Building the ZIP' : 'Download ZIP'}</button>
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
      {panel === 'share' ? <SharePanel projectId={id} onClose={() => setPanel(null)} /> : null}
      {panel === 'export' ? <ExportPanel project={project} texts={texts} onClose={() => setPanel(null)} /> : null}
    </div>
  );
}
