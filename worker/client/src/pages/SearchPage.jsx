import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { ErrorNote, Spinner } from '../components/ui';

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
      <ul className="rowlist mt-4">
        {hits?.length === 0 ? <li className="py-3 text-sm text-slate-500 dark:text-slate-400">No text in your projects matches.</li> : null}
        {hits?.map((h) => (
          <li key={h.text_id} className="py-3">
            <Link to={`/texts/${h.text_id}`} className="doc-title text-lg">{h.text_name}</Link>
            <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">in {h.project_name}</span>
            {h.snippet ? <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{h.snippet}</p> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
