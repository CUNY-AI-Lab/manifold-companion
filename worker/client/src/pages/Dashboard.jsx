import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useSession } from '../api/session.jsx';
import DisplayNamePrompt from '../components/DisplayNamePrompt';
import { DataNotice, ErrorNote, formatBytes, QuotaLine, Spinner } from '../components/ui';
import { LegacyDifferences, ToolRules, WhatItDoes } from '../components/ToolFacts';

export function RetentionBanner({ project }) {
  if (!project?.retention?.warning) return null;
  return (
    <p role="status" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
      This project has not been edited for a long time and will be deleted on {project.retention.delete_after.slice(0, 10)} ({project.retention.days_remaining} days). Edit something to keep it, or export your work.
    </p>
  );
}

export default function Dashboard() {
  const { session } = useSession();
  const navigate = useNavigate();
  const [projects, setProjects] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ name: '', project_type: 'image_to_markdown', default_language: 'en' });

  const [offers, setOffers] = useState([]);
  useEffect(() => { api.get('/api/projects').then((r) => setProjects(r.projects), setError); }, []);
  useEffect(() => { api.get('/api/transfers').then((r) => setOffers(r.offers), () => {}); }, []);

  const create = async (e) => {
    e.preventDefault();
    try {
      const { project } = await api.post('/api/projects', form);
      navigate(`/projects/${project.id}`);
    } catch (err) { setError(err); }
  };

  const { used_bytes: used, quota_bytes: quota } = session.storage;
  const pct = Math.min(100, Math.round((used / quota) * 100));
  return (
    <div>
      <DisplayNamePrompt />
      <h1 className="text-2xl">Your projects</h1>
      <div className="mt-2 mb-6"><DataNotice /></div>
      <ErrorNote error={error} onDismiss={() => setError(null)} />
      {offers.length ? (
        <section aria-labelledby="offers-title" className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          <h2 id="offers-title" className="text-base">Ownership offered to you</h2>
          <ul className="mt-1 list-disc pl-5">{offers.map((o) => <li key={o.id}><Link to={`/projects/${o.project_id}`}>{o.project_name}</Link> from {o.from_name || 'its owner'}, until {o.expires_at.slice(0, 10)}</li>)}</ul>
        </section>
      ) : null}
      {projects === null ? <Spinner /> : projects.length === 0 ? (
        <section aria-labelledby="welcome-title" className="space-y-4 rounded-md border border-slate-200 bg-white p-5 text-sm leading-relaxed dark:border-slate-700 dark:bg-slate-800">
          <h2 id="welcome-title" className="text-lg">Welcome to Manifold Companion</h2>
          <p>You have no projects yet. Create one below and choose a workflow:</p>
          <WhatItDoes />
          <h3 className="text-base">Before you start</h3>
          <ToolRules session={session} />
          <details>
            <summary className="cursor-pointer font-medium">Used the earlier version? What is different</summary>
            <div className="mt-2"><LegacyDifferences /></div>
          </details>
          <p><Link to="/help">More help</Link></p>
        </section>
      ) : (
        <ul className="rowlist rounded-md border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800">
          {projects.map((p) => (
            <li key={p.id} className="p-4">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <Link to={`/projects/${p.id}`} className="doc-title text-lg">{p.name}</Link>
                <span className="text-xs text-slate-500 dark:text-slate-400">{p.project_type === 'pdf_to_html' ? 'PDF to HTML' : 'Image to Markdown'}, {p.role}</span>
              </div>
              {p.retention.warning ? <div className="mt-2"><RetentionBanner project={p} /></div> : null}
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={create} className="mt-6 grid gap-3 rounded-md border border-slate-200 bg-white p-4 sm:grid-cols-4 dark:border-slate-700 dark:bg-slate-800">
        <h2 className="text-base sm:col-span-4">New project</h2>
        <label className="sm:col-span-2"><span className="label">Name</span><input className="field" required maxLength={200} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label><span className="label">Workflow</span>
          <select className="field" value={form.project_type} onChange={(e) => setForm({ ...form, project_type: e.target.value })}>
            <option value="image_to_markdown">Image to Markdown</option>
            <option value="pdf_to_html">PDF to HTML</option>
          </select>
        </label>
        <label><span className="label">Language code</span><input className="field" value={form.default_language} onChange={(e) => setForm({ ...form, default_language: e.target.value })} /></label>
        <div className="sm:col-span-4"><button className="btn-primary" type="submit">Create project</button></div>
      </form>
      <section className="mt-6 space-y-2 text-sm">
        <div>
          <div className="flex justify-between text-xs text-slate-600 dark:text-slate-300"><span>Storage in projects you own</span><span>{formatBytes(used)} of {formatBytes(quota)}</span></div>
          <div className="mt-1 h-2 rounded bg-slate-200 dark:bg-slate-700" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Storage used"><div className={`h-2 rounded ${pct >= 80 ? 'bg-red-500' : 'bg-cail-teal'}`} style={{ width: `${pct}%` }} /></div>
        </div>
        <QuotaLine />
        <p className="text-xs text-slate-500 dark:text-slate-400">Projects are deleted {session.retention.days} days after their last edit; you are warned {session.retention.warn_days} days before.</p>
      </section>
    </div>
  );
}
