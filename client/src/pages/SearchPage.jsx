import { useState, useEffect, useRef } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { api } from '../api/client';

export default function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialQuery = searchParams.get('q') || '';
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const debounceRef = useRef(null);

  useEffect(() => {
    if (initialQuery.length >= 2) {
      doSearch(initialQuery);
    }
  }, []);

  async function doSearch(q) {
    if (q.length < 2) {
      setResults([]);
      setSearched(false);
      return;
    }
    setLoading(true);
    setSearched(true);
    try {
      const data = await api.get(`/api/search?q=${encodeURIComponent(q)}`);
      setResults(Array.isArray(data.results) ? data.results : []);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  function handleChange(e) {
    const val = e.target.value.slice(0, 200);
    setQuery(val);
    setSearchParams(val ? { q: val } : {}, { replace: true });
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(val), 300);
  }

  // Group results by project
  const grouped = {};
  for (const r of results) {
    const key = r.project_id || 'unknown';
    if (!grouped[key]) grouped[key] = { name: r.project_name, type: r.project_type, items: [] };
    grouped[key].items.push(r);
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <Link
        to="/"
        className="inline-flex items-center gap-2 text-sm text-gray-500 dark:text-slate-400 hover:text-cail-dark dark:hover:text-slate-200 mb-6 group"
      >
        <svg className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Back to Dashboard
      </Link>

      <h1 className="font-display font-semibold text-2xl text-cail-dark dark:text-slate-200 mb-6">Search</h1>

      <div className="relative mb-8">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400 dark:text-slate-500 pointer-events-none"
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
        </svg>
        <input
          type="text"
          value={query}
          onChange={handleChange}
          placeholder="Search texts, projects, metadata..."
          autoFocus
          maxLength={200}
          className="w-full pl-12 pr-4 py-3 text-base bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-2xl text-cail-dark dark:text-slate-200 placeholder-gray-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cail-blue focus:border-transparent shadow-sm"
        />
        {loading && (
          <div className="absolute right-4 top-1/2 -translate-y-1/2">
            <div className="h-5 w-5 border-2 border-cail-blue border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>

      {/* Results */}
      {loading && results.length === 0 && (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cail-blue"></div>
        </div>
      )}

      {searched && !loading && results.length === 0 && (
        <div className="text-center py-12">
          <p className="text-gray-500 dark:text-slate-400">No results found for &ldquo;{query}&rdquo;</p>
        </div>
      )}

      {Object.keys(grouped).length > 0 && (
        <div className="space-y-8">
          {Object.entries(grouped).map(([projectId, group]) => (
            <div key={projectId}>
              <div className="flex items-center gap-2 mb-3">
                <h2 className="font-display font-semibold text-sm text-cail-dark dark:text-slate-200">{group.name || 'Unknown Project'}</h2>
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                  group.type === 'pdf_to_html'
                    ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                    : 'bg-cail-blue/10 text-cail-blue'
                }`}>
                  {group.type === 'pdf_to_html' ? 'PDF to HTML' : 'Image to Markdown'}
                </span>
              </div>
              <div className="space-y-2">
                {group.items.map((r) => (
                  <Link
                    key={r.id}
                    to={`/texts/${r.id}?tab=Review`}
                    className="block bg-white dark:bg-slate-800 rounded-xl border border-gray-100 dark:border-slate-700 p-4 hover:shadow-md hover:-translate-y-0.5 transition-all"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-cail-dark dark:text-slate-200 truncate">{r.name}</p>
                        {r.summary && (
                          <p className="text-xs text-gray-500 dark:text-slate-400 mt-1 line-clamp-2">{r.summary}</p>
                        )}
                      </div>
                      {r.access_role && r.access_role !== 'owner' && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300 flex-shrink-0">
                          {r.access_role}
                        </span>
                      )}
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {!searched && !loading && (
        <div className="text-center py-12">
          <p className="text-gray-400 dark:text-slate-500 text-sm">Type at least 2 characters to search</p>
        </div>
      )}
    </div>
  );
}
