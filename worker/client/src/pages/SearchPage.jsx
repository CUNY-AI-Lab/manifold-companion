import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { ErrorNote, Spinner } from '../components/ui';

/** Hits grouped by project, projects in the order of their best hit, texts in rank order within each. */
export function groupByProject(hits) {
  const groups = new Map();
  for (const h of hits) {
    if (!groups.has(h.project_id)) groups.set(h.project_id, { project_id: h.project_id, project_name: h.project_name, hits: [] });
    groups.get(h.project_id).hits.push(h);
  }
  return [...groups.values()];
}

export default function SearchPage() {
  const [params] = useSearchParams();
  const q = params.get('q') ?? '';
  const [hits, setHits] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { setHits(null); api.get(`/api/search?q=${encodeURIComponent(q)}`).then((r) => setHits(r.results), setError); }, [q]);
  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl">Results for “{q}”</h1>
      <ErrorNote error={error} />
      {hits === null && !error ? <Spinner /> : null}
      {hits?.length === 0 ? <p className="mt-4 py-3 text-sm text-slate-600 dark:text-slate-300">No text in your projects matches.</p> : null}
      {hits?.length ? <p className="mt-2 text-sm text-slate-600 dark:text-slate-300" role="status">{hits.length} text{hits.length === 1 ? '' : 's'} in {groupByProject(hits).length} project{groupByProject(hits).length === 1 ? '' : 's'}{hits.length >= 50 ? ' (the first 50; narrow the search to see others)' : ''}.</p> : null}
      {hits?.length ? groupByProject(hits).map((g) => (
        <section key={g.project_id} aria-labelledby={`hits-${g.project_id}`} className="mt-5">
          <h2 id={`hits-${g.project_id}`} className="text-base"><Link to={`/projects/${g.project_id}`}>{g.project_name}</Link> <span className="text-xs font-normal text-slate-600 dark:text-slate-300">{g.hits.length} text{g.hits.length === 1 ? '' : 's'}</span></h2>
          <ul className="rowlist mt-1">
            {g.hits.map((h) => (
              <li key={h.text_id} className="py-2">
                <Link to={`/texts/${h.text_id}`} className="doc-title text-lg">{h.text_name}</Link>
                {h.snippet ? <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{h.snippet}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      )) : null}
    </div>
  );
}
