import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api/client';

function formatTimestamp(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// Split text into diffable lines — for HTML, insert newlines before tags
function splitLines(text) {
  if (!text) return [];
  // If content looks like HTML with few newlines, split on tags
  if (text.includes('<') && text.split('\n').length < 5) {
    text = text.replace(/></g, '>\n<');
  }
  return text.split('\n');
}

// Myers diff algorithm (linear space, efficient)
function myersDiff(oldLines, newLines) {
  const N = oldLines.length;
  const M = newLines.length;
  const MAX = N + M;

  if (MAX === 0) return [];
  if (N === 0) return newLines.map(l => ({ type: 'add', line: l }));
  if (M === 0) return oldLines.map(l => ({ type: 'del', line: l }));

  // For very large inputs, use simple diff
  if (MAX > 10000) return simpleDiff(oldLines, newLines);

  const trace = [];
  const V = new Map();
  V.set(1, 0);

  let found = false;
  outer:
  for (let d = 0; d <= MAX; d++) {
    const vCopy = new Map(V);
    trace.push(vCopy);
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && (V.get(k - 1) || 0) < (V.get(k + 1) || 0))) {
        x = V.get(k + 1) || 0;
      } else {
        x = (V.get(k - 1) || 0) + 1;
      }
      let y = x - k;
      while (x < N && y < M && oldLines[x] === newLines[y]) {
        x++; y++;
      }
      V.set(k, x);
      if (x >= N && y >= M) { found = true; break outer; }
    }
  }

  if (!found) return simpleDiff(oldLines, newLines);

  // Backtrack
  const edits = [];
  let x = N, y = M;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && (v.get(k - 1) || 0) < (v.get(k + 1) || 0))) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = v.get(prevK) || 0;
    const prevY = prevX - prevK;
    // Diagonal (same lines)
    while (x > prevX && y > prevY) {
      x--; y--;
      edits.unshift({ type: 'same', line: oldLines[x] });
    }
    if (d > 0) {
      if (x === prevX) {
        y--;
        edits.unshift({ type: 'add', line: newLines[y] });
      } else {
        x--;
        edits.unshift({ type: 'del', line: oldLines[x] });
      }
    }
  }

  return edits;
}

function simpleDiff(oldLines, newLines) {
  const result = [];
  for (const l of oldLines) result.push({ type: 'del', line: l });
  for (const l of newLines) result.push({ type: 'add', line: l });
  return result;
}

function computeDiff(oldText, newText) {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const edits = myersDiff(oldLines, newLines);

  if (edits.length === 0) return [{ type: 'info', line: 'No changes' }];

  const hasChanges = edits.some(e => e.type !== 'same');
  if (!hasChanges) return [{ type: 'info', line: 'No changes' }];

  // Collapse to context hunks (3 lines of context around changes)
  const CTX = 3;
  const show = new Set();
  for (let i = 0; i < edits.length; i++) {
    if (edits[i].type !== 'same') {
      for (let c = Math.max(0, i - CTX); c <= Math.min(edits.length - 1, i + CTX); c++) {
        show.add(c);
      }
    }
  }

  const result = [];
  let prev = -1;
  for (let i = 0; i < edits.length; i++) {
    if (!show.has(i)) continue;
    if (prev >= 0 && i - prev > 1) {
      result.push({ type: 'sep', line: '...' });
    }
    result.push(edits[i]);
    prev = i;
  }
  return result;
}

export default function VersionHistory({ textId, contentType, open, onClose, onRevert }) {
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [diffId, setDiffId] = useState(null);
  const [diffLines, setDiffLines] = useState([]);
  const [diffLoading, setDiffLoading] = useState(false);
  const [reverting, setReverting] = useState(false);

  const fetchVersions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get(`/api/texts/${textId}/versions?type=${contentType}`);
      setVersions(data.versions || data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [textId, contentType]);

  useEffect(() => {
    if (open) {
      fetchVersions();
      setDiffId(null);
      setDiffLines([]);
    }
  }, [open, fetchVersions]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  async function handleDiff(versionId, index) {
    if (diffId === versionId) {
      setDiffId(null);
      setDiffLines([]);
      return;
    }
    setDiffId(versionId);
    setDiffLoading(true);
    try {
      // Fetch this version's content
      const thisData = await api.get(`/api/texts/${textId}/versions/${versionId}`);
      const thisContent = thisData.content || '';

      // Get the previous version's content (next in array since newest-first)
      let prevContent = '';
      if (index < versions.length - 1) {
        const prevData = await api.get(`/api/texts/${textId}/versions/${versions[index + 1].id}`);
        prevContent = prevData.content || '';
      }

      setDiffLines(computeDiff(prevContent, thisContent));
    } catch (err) {
      setDiffLines([{ type: 'info', line: `Error: ${err.message}` }]);
    } finally {
      setDiffLoading(false);
    }
  }

  async function handleRevert(versionId) {
    if (!window.confirm('Revert to this version? Current content will be saved as a version first.')) {
      return;
    }
    setReverting(true);
    try {
      await api.post(`/api/texts/${textId}/versions/${versionId}/revert`);
      onRevert?.();
      onClose();
    } catch (err) {
      alert(`Revert failed: ${err.message}`);
    } finally {
      setReverting(false);
    }
  }

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex justify-end"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" />

      {/* Panel */}
      <div className="relative w-full max-w-2xl bg-white dark:bg-slate-800 shadow-2xl rounded-l-2xl flex flex-col animate-slide-in">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-slate-700">
          <h2 className="text-lg font-display font-semibold text-cail-navy">
            Version History
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 dark:text-slate-500 hover:text-cail-dark dark:hover:text-slate-200 transition-colors text-xl leading-none"
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <div className="w-6 h-6 border-2 border-cail-blue border-t-transparent rounded-full animate-spin" />
            </div>
          )}

          {error && (
            <p className="text-red-600 text-sm py-4">{error}</p>
          )}

          {!loading && !error && versions.length === 0 && (
            <p className="text-gray-500 dark:text-slate-400 text-sm py-12 text-center">
              No saved versions yet.
            </p>
          )}

          {!loading && versions.length > 0 && (
            <ul className="space-y-3">
              {versions.map((v, idx) => (
                <li key={v.id} className="border border-gray-200 dark:border-slate-700 rounded-2xl overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-cail-dark dark:text-slate-200 truncate">
                        {formatTimestamp(v.created_at)}
                      </p>
                      {(v.user_display_name || v.user_email) && (
                        <p className="text-xs text-gray-500 dark:text-slate-400 truncate">{v.user_display_name || v.user_email}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 ml-3 shrink-0">
                      <button
                        onClick={() => handleDiff(v.id, idx)}
                        className="px-3 py-1 text-xs font-medium rounded-lg border border-cail-blue text-cail-blue hover:bg-cail-blue/10 transition-colors"
                      >
                        {diffId === v.id ? 'Hide' : 'Changes'}
                      </button>
                      <button
                        onClick={() => handleRevert(v.id)}
                        disabled={reverting}
                        className="px-3 py-1 text-xs font-medium rounded-lg bg-cail-blue text-white hover:bg-cail-navy transition-colors disabled:opacity-50"
                      >
                        Revert
                      </button>
                    </div>
                  </div>

                  {diffId === v.id && (
                    <div className="border-t border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-900 px-4 py-3">
                      {diffLoading ? (
                        <div className="flex items-center justify-center py-4">
                          <div className="w-4 h-4 border-2 border-cail-blue border-t-transparent rounded-full animate-spin" />
                        </div>
                      ) : (
                        <div className="text-xs font-mono max-h-80 overflow-y-auto rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800">
                          {diffLines.map((d, i) => (
                            <div
                              key={i}
                              className={
                                d.type === 'add' ? 'bg-green-50 text-green-800 border-l-2 border-green-400 px-3 py-0.5' :
                                d.type === 'del' ? 'bg-red-50 text-red-800 border-l-2 border-red-400 px-3 py-0.5' :
                                d.type === 'sep' ? 'bg-blue-50 text-blue-400 px-3 py-1 text-center' :
                                d.type === 'info' ? 'text-gray-400 px-3 py-2 text-center italic' :
                                'text-gray-600 px-3 py-0.5'
                              }
                            >
                              <span className="select-none text-gray-300 mr-2">
                                {d.type === 'add' ? '+' : d.type === 'del' ? '−' : d.type === 'sep' ? '' : ' '}
                              </span>
                              <span className="whitespace-pre-wrap break-words">{d.line}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
