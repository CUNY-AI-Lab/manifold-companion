import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import useFocusTrap from '../hooks/useFocusTrap';

const DEFAULT_SHORTCUTS = {
  'Review Tab': [
    { keys: ['\u2190', '\u2192'], desc: 'Previous / next page' },
    { keys: ['\u2318S', 'Ctrl+S'], desc: 'Save current page' },
  ],
  'General': [
    { keys: ['Esc'], desc: 'Close modal / sidebar' },
    { keys: ['?'], desc: 'Show keyboard shortcuts' },
  ],
};

export default function KeyboardShortcuts({ onClose, shortcuts }) {
  const sections = shortcuts || DEFAULT_SHORTCUTS;
  const modalRef = useRef(null);
  useFocusTrap(modalRef, true);

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="keyboard-shortcuts-title"
        className="bg-white dark:bg-slate-800 rounded-2xl shadow-2xl max-w-sm w-full overflow-hidden animate-in fade-in duration-200"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-slate-700">
          <h2 id="keyboard-shortcuts-title" className="font-display font-semibold text-lg text-cail-dark dark:text-slate-200">Keyboard Shortcuts</h2>
          <button
            onClick={onClose}
            aria-label="Close keyboard shortcuts"
            className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-slate-700 text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="p-6 space-y-5">
          {Object.entries(sections).map(([section, items]) => (
            <div key={section}>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-slate-500 mb-2.5">{section}</h3>
              <div className="space-y-2.5">
                {items.map((item, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <span className="text-sm text-gray-600 dark:text-slate-400">{item.desc}</span>
                    <div className="flex items-center gap-1">
                      {item.keys.map((k) => (
                        <kbd
                          key={k}
                          className="px-2 py-0.5 rounded-md bg-gray-100 dark:bg-slate-700 border border-gray-200 dark:border-slate-600 text-xs font-mono text-gray-600 dark:text-slate-400"
                        >
                          {k}
                        </kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}
