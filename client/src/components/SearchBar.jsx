import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';

export default function SearchBar({ compact = false, onSelect }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(!compact);
  const containerRef = useRef(null);
  const debounceRef = useRef(null);
  const navigate = useNavigate();

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
        if (compact) setExpanded(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [compact]);

  const search = useCallback(async (q) => {
    if (q.length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }
    setLoading(true);
    try {
      const data = await api.get(`/api/search?q=${encodeURIComponent(q)}`);
      setResults(Array.isArray(data.results) ? data.results : []);
      setOpen(true);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  function handleChange(e) {
    const val = e.target.value.slice(0, 200);
    setQuery(val);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(val), 300);
  }

  function handleSelect(result) {
    setOpen(false);
    setQuery('');
    setResults([]);
    if (compact) setExpanded(false);
    if (onSelect) onSelect(result);
    navigate(`/texts/${result.id}?tab=Review`);
  }

  if (compact && !expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="p-2 text-cail-navy hover:text-cail-blue transition-colors"
        aria-label="Search"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
        </svg>
      </button>
    );
  }

  return (
    <div ref={containerRef} className={`relative ${compact ? 'w-64' : 'w-full'}`}>
      <div className="relative">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500 dark:text-slate-500 pointer-events-none"
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
        </svg>
        <input
          type="text"
          value={query}
          onChange={handleChange}
          placeholder="Search texts..."
          autoFocus={compact}
          maxLength={200}
          data-search-input
          className="w-full pl-9 pr-3 py-2 text-sm bg-white dark:bg-slate-700 border border-gray-200 dark:border-slate-600 rounded-xl text-cail-dark dark:text-slate-200 placeholder-gray-400 dark:placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cail-blue focus:border-transparent"
        />
        {loading && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            <div className="h-4 w-4 border-2 border-cail-blue border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>

      {open && results.length > 0 && (
        <ul role="listbox" className="absolute z-50 mt-1 w-full bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl shadow-lg">
          {results.slice(0, 3).map((r) => (
            <li key={r.id} role="option">
              <button
                onClick={() => handleSelect(r)}
                className="w-full text-left px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors border-b border-gray-100 dark:border-slate-700"
              >
                <p className="text-sm font-medium text-cail-navy truncate">{r.name}</p>
                {r.project_name && (
                  <p className="text-xs text-gray-500 dark:text-slate-400 truncate">{r.project_name}</p>
                )}
                {r.summary && (
                  <p className="text-xs text-gray-500 dark:text-slate-500 mt-0.5 line-clamp-2">{r.summary}</p>
                )}
              </button>
            </li>
          ))}
          {results.length > 3 && (
            <li>
              <button
                onClick={() => { setOpen(false); setQuery(''); if (compact) setExpanded(false); navigate(`/search?q=${encodeURIComponent(query)}`); }}
                className="w-full text-center px-4 py-2.5 text-sm font-medium text-cail-blue hover:bg-cail-blue/5 transition-colors rounded-b-xl"
              >
                See all {results.length} results
              </button>
            </li>
          )}
        </ul>
      )}

      {open && query.length >= 2 && !loading && results.length === 0 && (
        <div className="absolute z-50 mt-1 w-full bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl shadow-lg px-4 py-3">
          <p className="text-sm text-gray-500 dark:text-slate-500">No results found</p>
        </div>
      )}
    </div>
  );
}
