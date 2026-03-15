import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api/client';

export default function SharePanel({ projectId, open, onClose }) {
  const [shares, setShares] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('viewer');
  const [adding, setAdding] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const suggestDebounce = useRef(null);

  const fetchShares = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.get(`/api/projects/${projectId}/shares`);
      setShares(data.shares || data);
    } catch (err) {
      setError(err.message || 'Failed to load shares');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (open) fetchShares();
  }, [open, fetchShares]);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!email.trim()) return;
    setAdding(true);
    setError('');
    try {
      await api.post(`/api/projects/${projectId}/shares`, { email: email.trim(), role });
      setEmail('');
      setRole('viewer');
      await fetchShares();
    } catch (err) {
      setError(err.message || 'Failed to add share');
    } finally {
      setAdding(false);
    }
  };

  const handleUpdateRole = async (shareId, newRole) => {
    setError('');
    try {
      await api.put(`/api/projects/${projectId}/shares/${shareId}`, { role: newRole });
      setShares((prev) => prev.map((s) => s.id === shareId ? { ...s, role: newRole } : s));
    } catch (err) {
      setError(err.message || 'Failed to update role');
    }
  };

  const handleRemove = async (shareId) => {
    setError('');
    try {
      await api.del(`/api/projects/${projectId}/shares/${shareId}`);
      setShares((prev) => prev.filter((s) => s.id !== shareId));
    } catch (err) {
      setError(err.message || 'Failed to remove share');
    }
  };

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative bg-white dark:bg-slate-800 rounded-2xl shadow-2xl max-w-lg w-full max-h-[85vh] overflow-y-auto p-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-display font-bold text-cail-navy dark:text-slate-200">Share Project</h2>
          <button
            onClick={onClose}
            className="text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 text-2xl leading-none"
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 rounded-xl text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleAdd} className="mb-6">
          <div className="flex gap-2">
            <div className="flex-1 min-w-0 relative">
              <input
                type="text"
                placeholder="Search by name or email"
                value={email}
                onChange={(e) => {
                  const val = e.target.value;
                  setEmail(val);
                  clearTimeout(suggestDebounce.current);
                  if (val.trim().length >= 2) {
                    suggestDebounce.current = setTimeout(async () => {
                      try {
                        const data = await api.get(`/api/users/search?q=${encodeURIComponent(val.trim())}`);
                        setSuggestions(data.users || []);
                        setShowSuggestions(true);
                      } catch { setSuggestions([]); }
                    }, 250);
                  } else {
                    setSuggestions([]);
                    setShowSuggestions(false);
                  }
                }}
                onFocus={() => { if (suggestions.length > 0) setShowSuggestions(true); }}
                required
                className="w-full px-3 py-2 border border-gray-300 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-cail-blue focus:border-transparent"
              />
              {showSuggestions && suggestions.length > 0 && (
                <ul className="absolute z-50 mt-1 w-full bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl shadow-lg max-h-40 overflow-y-auto">
                  {suggestions.map((u) => (
                    <li key={u.id}>
                      <button
                        type="button"
                        onClick={() => { setEmail(u.email); setShowSuggestions(false); }}
                        className="w-full text-left px-3 py-2 hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors"
                      >
                        <p className="text-sm font-medium text-cail-dark dark:text-slate-200 truncate">{u.display_name || u.email}</p>
                        {u.display_name && <p className="text-xs text-gray-400 dark:text-slate-500 truncate">{u.email}</p>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-xl text-sm bg-white dark:bg-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-cail-blue focus:border-transparent"
            >
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
            </select>
            <button
              type="submit"
              disabled={adding}
              className="px-4 py-2 bg-cail-blue text-white rounded-full text-sm font-medium hover:bg-cail-teal disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              {adding ? 'Adding...' : 'Add'}
            </button>
          </div>
        </form>

        {loading ? (
          <div className="flex justify-center py-8">
            <div className="w-6 h-6 border-2 border-cail-blue border-t-transparent rounded-full animate-spin" />
          </div>
        ) : shares.length === 0 ? (
          <p className="text-center text-gray-400 dark:text-slate-500 text-sm py-6">No shares yet</p>
        ) : (
          <ul className="space-y-2">
            {shares.map((share) => (
              <li
                key={share.id}
                className="flex items-center justify-between gap-3 p-3 bg-gray-50 dark:bg-slate-900 rounded-2xl"
              >
                <div className="min-w-0 flex-1">
                  <span className="text-sm text-cail-dark dark:text-slate-200 truncate block">
                    {share.display_name || share.email}
                  </span>
                  {share.display_name && (
                    <span className="text-xs text-gray-400 dark:text-slate-500 truncate block">{share.email}</span>
                  )}
                </div>
                <select
                  value={share.role}
                  onChange={(e) => handleUpdateRole(share.id, e.target.value)}
                  className="px-2 py-1 text-xs border border-gray-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-cail-blue focus:border-transparent"
                >
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                </select>
                <button
                  onClick={() => handleRemove(share.id)}
                  className="px-3 py-1 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-full transition-colors"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>,
    document.body
  );
}
