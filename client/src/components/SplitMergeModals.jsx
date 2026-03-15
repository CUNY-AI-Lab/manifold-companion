import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api/client';

// ---------------------------------------------------------------------------
// Split Modal — split a text into multiple new texts by page ranges
// ---------------------------------------------------------------------------

export function SplitModal({ textId, pages, onClose, onSplit }) {
  // Each group: { name, pages: Set of page_numbers }
  const [groups, setGroups] = useState([
    { name: 'Part 1', pages: new Set() },
    { name: 'Part 2', pages: new Set() },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Filter out __compiled__ sentinel
  const realPages = pages.filter(p => p.filename !== '__compiled__');

  function addGroup() {
    setGroups(prev => [...prev, { name: `Part ${prev.length + 1}`, pages: new Set() }]);
  }

  function removeGroup(idx) {
    if (groups.length <= 2) return;
    setGroups(prev => prev.filter((_, i) => i !== idx));
  }

  function updateGroupName(idx, name) {
    setGroups(prev => prev.map((g, i) => i === idx ? { ...g, name } : g));
  }

  function togglePage(groupIdx, pageNum) {
    setGroups(prev => {
      const next = prev.map((g, i) => {
        const pages = new Set(g.pages);
        if (i === groupIdx) {
          if (pages.has(pageNum)) {
            pages.delete(pageNum);
          } else {
            pages.add(pageNum);
          }
        } else {
          // Remove from other groups
          pages.delete(pageNum);
        }
        return { ...g, pages };
      });
      return next;
    });
  }

  function getPageGroup(pageNum) {
    for (let i = 0; i < groups.length; i++) {
      if (groups[i].pages.has(pageNum)) return i;
    }
    return -1;
  }

  const GROUP_COLORS = [
    'bg-cail-blue/20 border-cail-blue text-cail-blue',
    'bg-cail-teal/20 border-cail-teal text-cail-teal',
    'bg-amber-100 border-amber-400 text-amber-700',
    'bg-violet-100 border-violet-400 text-violet-700',
    'bg-rose-100 border-rose-400 text-rose-700',
    'bg-emerald-100 border-emerald-400 text-emerald-700',
  ];

  const GROUP_DOT_COLORS = [
    'bg-cail-blue',
    'bg-cail-teal',
    'bg-amber-400',
    'bg-violet-400',
    'bg-rose-400',
    'bg-emerald-400',
  ];

  async function handleSplit() {
    // Validate
    const unassigned = realPages.filter(p => getPageGroup(p.page_number) === -1);
    if (unassigned.length > 0) {
      setError(`${unassigned.length} page(s) not assigned to any group.`);
      return;
    }
    for (const g of groups) {
      if (!g.name.trim()) { setError('All groups need a name.'); return; }
      if (g.pages.size === 0) { setError(`"${g.name}" has no pages.`); return; }
    }

    setSubmitting(true);
    setError('');
    try {
      const splits = groups.map(g => ({
        name: g.name.trim(),
        pages: [...g.pages].sort((a, b) => a - b),
      }));
      await api.post(`/api/texts/${textId}/split`, { splits });
      onSplit();
    } catch (err) {
      setError(err.message || 'Split failed.');
    }
    setSubmitting(false);
  }

  // Auto-assign: evenly distribute pages
  function autoAssign() {
    const perGroup = Math.ceil(realPages.length / groups.length);
    setGroups(prev => prev.map((g, i) => ({
      ...g,
      pages: new Set(
        realPages
          .slice(i * perGroup, (i + 1) * perGroup)
          .map(p => p.page_number)
      ),
    })));
  }

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div className="relative bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-gray-100 px-6 py-4 flex items-center justify-between rounded-t-2xl z-10">
          <div>
            <h2 className="font-display font-semibold text-lg text-cail-dark">Split Text</h2>
            <p className="text-xs text-gray-400 mt-0.5">{realPages.length} pages — assign each to a group</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-full hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-4 space-y-4">
          {/* Groups */}
          <div className="space-y-2">
            {groups.map((group, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <span className={`w-3 h-3 rounded-full shrink-0 ${GROUP_DOT_COLORS[idx % GROUP_DOT_COLORS.length]}`} />
                <input
                  value={group.name}
                  onChange={e => updateGroupName(idx, e.target.value)}
                  className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-cail-blue"
                  placeholder="Group name"
                />
                <span className="text-xs text-gray-400 w-16 text-right">{group.pages.size} pg</span>
                {groups.length > 2 && (
                  <button onClick={() => removeGroup(idx)} className="text-gray-300 hover:text-red-400 transition-colors">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            ))}
            <div className="flex gap-2">
              <button onClick={addGroup} className="text-xs text-cail-blue hover:text-cail-navy font-medium">+ Add group</button>
              <button onClick={autoAssign} className="text-xs text-gray-400 hover:text-cail-dark font-medium">Auto-assign evenly</button>
            </div>
          </div>

          {/* Page grid — click a page to cycle through groups */}
          <div className="border border-gray-100 rounded-xl p-3">
            <p className="text-xs text-gray-400 mb-2">Click a page to assign it to the selected group. Click again to cycle.</p>
            <div className="flex flex-wrap gap-1.5">
              {realPages.map(page => {
                const gIdx = getPageGroup(page.page_number);
                const colorClass = gIdx >= 0
                  ? GROUP_COLORS[gIdx % GROUP_COLORS.length]
                  : 'bg-gray-50 border-gray-200 text-gray-500';

                return (
                  <button
                    key={page.id}
                    onClick={() => {
                      const current = getPageGroup(page.page_number);
                      const next = (current + 1) % groups.length;
                      // If currently in a group, move to next; if unassigned, assign to first
                      togglePage(current >= 0 ? next : 0, page.page_number);
                    }}
                    className={`w-10 h-10 rounded-lg border-2 text-xs font-medium flex items-center justify-center transition-all hover:scale-105 ${colorClass}`}
                    title={`Page ${page.page_number}${gIdx >= 0 ? ` → ${groups[gIdx].name}` : ' (unassigned)'}`}
                  >
                    {page.page_number}
                  </button>
                );
              })}
            </div>
          </div>

          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-white border-t border-gray-100 px-6 py-4 flex items-center justify-end gap-3 rounded-b-2xl">
          <button onClick={onClose} className="px-4 py-2 rounded-full text-sm text-gray-500 hover:text-cail-dark">Cancel</button>
          <button
            onClick={handleSplit}
            disabled={submitting}
            className="px-5 py-2 rounded-full text-sm font-medium text-white bg-cail-blue hover:bg-cail-navy transition-colors disabled:opacity-50"
          >
            {submitting ? 'Splitting...' : `Split into ${groups.length} texts`}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ---------------------------------------------------------------------------
// Merge Modal — merge multiple texts into one
// ---------------------------------------------------------------------------

export function MergeModal({ texts, onClose, onMerge, projectId }) {
  const [selected, setSelected] = useState([]);
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  function toggleText(textId) {
    setSelected(prev =>
      prev.includes(textId) ? prev.filter(id => id !== textId) : [...prev, textId]
    );
  }

  function moveUp(idx) {
    if (idx === 0) return;
    setSelected(prev => {
      const next = [...prev];
      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      return next;
    });
  }

  function moveDown(idx) {
    if (idx >= selected.length - 1) return;
    setSelected(prev => {
      const next = [...prev];
      [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
      return next;
    });
  }

  const textMap = {};
  for (const t of texts) textMap[t.id] = t;

  async function handleMerge() {
    if (selected.length < 2) { setError('Select at least 2 texts to merge.'); return; }
    if (!name.trim()) { setError('Enter a name for the merged text.'); return; }

    setSubmitting(true);
    setError('');
    try {
      await api.post(`/api/projects/${projectId}/texts/merge`, {
        textIds: selected,
        name: name.trim(),
      });
      onMerge();
    } catch (err) {
      setError(err.message || 'Merge failed.');
    }
    setSubmitting(false);
  }

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div className="relative bg-white rounded-2xl shadow-2xl max-w-lg w-full max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-gray-100 px-6 py-4 flex items-center justify-between rounded-t-2xl z-10">
          <div>
            <h2 className="font-display font-semibold text-lg text-cail-dark">Merge Texts</h2>
            <p className="text-xs text-gray-400 mt-0.5">Combine multiple texts into one</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-full hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-4 space-y-4">
          {/* Name input */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Merged text name</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Combined Document"
              className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2 focus:outline-none focus:border-cail-blue"
            />
          </div>

          {/* Text selection */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-2">Select texts to merge (click to select)</label>
            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {texts.map(t => {
                const isSelected = selected.includes(t.id);
                return (
                  <button
                    key={t.id}
                    onClick={() => toggleText(t.id)}
                    className={`w-full text-left px-3 py-2 rounded-xl text-sm flex items-center gap-2 transition-all ${
                      isSelected
                        ? 'bg-cail-blue/10 border border-cail-blue/30 text-cail-dark'
                        : 'bg-gray-50 border border-transparent text-gray-600 hover:bg-gray-100'
                    }`}
                  >
                    <span className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                      isSelected ? 'border-cail-blue bg-cail-blue' : 'border-gray-300'
                    }`}>
                      {isSelected && (
                        <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </span>
                    <span className="truncate">{t.name}</span>
                    <span className="text-xs text-gray-400 ml-auto shrink-0">{t.page_count || 0} pg</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Merge order */}
          {selected.length >= 2 && (
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-2">Merge order (drag to reorder)</label>
              <div className="space-y-1">
                {selected.map((tid, idx) => (
                  <div key={tid} className="flex items-center gap-2 bg-cail-cream rounded-lg px-3 py-1.5">
                    <span className="text-xs font-medium text-cail-blue w-5">{idx + 1}.</span>
                    <span className="text-sm text-cail-dark flex-1 truncate">{textMap[tid]?.name}</span>
                    <div className="flex gap-0.5">
                      <button
                        onClick={() => moveUp(idx)}
                        disabled={idx === 0}
                        className="p-0.5 text-gray-400 hover:text-cail-dark disabled:opacity-30"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                        </svg>
                      </button>
                      <button
                        onClick={() => moveDown(idx)}
                        disabled={idx >= selected.length - 1}
                        className="p-0.5 text-gray-400 hover:text-cail-dark disabled:opacity-30"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-white border-t border-gray-100 px-6 py-4 flex items-center justify-end gap-3 rounded-b-2xl">
          <button onClick={onClose} className="px-4 py-2 rounded-full text-sm text-gray-500 hover:text-cail-dark">Cancel</button>
          <button
            onClick={handleMerge}
            disabled={submitting || selected.length < 2}
            className="px-5 py-2 rounded-full text-sm font-medium text-white bg-cail-blue hover:bg-cail-navy transition-colors disabled:opacity-50"
          >
            {submitting ? 'Merging...' : `Merge ${selected.length} texts`}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
