import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from 'react';
import useFocusTrap from './useFocusTrap';
import { SHORTCUTS, SINGLE_KEY_PREF, applies, keyLabel } from '../lib/shortcuts';
import { browserStorage } from '../lib/storage';

const ShortcutContext = createContext(null);

const readPref = () => { try { return browserStorage().getItem(SINGLE_KEY_PREF) !== 'off'; } catch { return true; } };

/** The shortcuts dialog, the single-key preference, and the global shortcuts (? and /). */
export function ShortcutProvider({ children }) {
  const [open, setOpen] = useState(false);
  const [singleKeysOn, setSingleKeysOnState] = useState(readPref);
  const setSingleKeysOn = useCallback((on) => {
    setSingleKeysOnState(on);
    try { if (on) browserStorage().removeItem(SINGLE_KEY_PREF); else browserStorage().setItem(SINGLE_KEY_PREF, 'off'); } catch { /* unavailable */ }
  }, []);
  const state = useRef({ singleKeysOn });
  state.current = { singleKeysOn };
  // Layout effects: the keys work from the first paint of the screen that offers them.
  useLayoutEffect(() => {
    const onKey = (e) => {
      if (e.defaultPrevented) return;
      const by = (id) => applies(SHORTCUTS.find((s) => s.id === id), e, state.current);
      if (by('help')) { e.preventDefault(); setOpen(true); }
      else if (by('search')) { const box = document.getElementById('site-search'); if (box) { e.preventDefault(); box.focus(); } }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return (
    <ShortcutContext.Provider value={{ singleKeysOn, setSingleKeysOn, openShortcuts: () => setOpen(true) }}>
      {children}
      {open ? <ShortcutsDialog onClose={() => setOpen(false)} /> : null}
    </ShortcutContext.Provider>
  );
}

export const useShortcutSettings = () => useContext(ShortcutContext);

/** Run `handler` for shortcut `id` while `enabled` (single-key ones only outside text fields, and only when on). */
export function useShortcut(id, handler, enabled = true) {
  const ctx = useContext(ShortcutContext);
  const h = useRef(handler);
  h.current = handler;
  const on = useRef(ctx?.singleKeysOn ?? true);
  on.current = ctx?.singleKeysOn ?? true;
  useLayoutEffect(() => {
    if (!enabled) return undefined;
    const shortcut = SHORTCUTS.find((s) => s.id === id);
    const onKey = (e) => {
      if (e.defaultPrevented || !applies(shortcut, e, { singleKeysOn: on.current })) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"]')) return; // a dialog has the keys
      e.preventDefault();
      h.current(e);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [id, enabled]);
}

export function ShortcutList() {
  return (
    <table className="w-full text-left text-sm">
      <caption className="sr-only">Keyboard shortcuts</caption>
      <thead><tr><th scope="col" className="py-1 pr-3">Keys</th><th scope="col" className="py-1 pr-3">Does</th><th scope="col" className="py-1">Where</th></tr></thead>
      <tbody>
        {SHORTCUTS.map((s) => (
          <tr key={s.id} className="border-t border-slate-200 dark:border-slate-700">
            <td className="py-1 pr-3 align-top"><kbd className="rounded border border-slate-300 bg-slate-50 px-1.5 py-0.5 font-mono text-xs dark:border-slate-600 dark:bg-slate-900">{keyLabel(s.keys)}</kbd></td>
            <td className="py-1 pr-3 align-top">{s.does}</td>
            <td className="py-1 align-top text-slate-600 dark:text-slate-300">{s.where}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function SingleKeyToggle() {
  const { singleKeysOn, setSingleKeysOn } = useShortcutSettings();
  return (
    <label className="block text-sm"><input type="checkbox" checked={singleKeysOn} onChange={(e) => setSingleKeysOn(e.target.checked)} /> Single-key shortcuts (?, /, N, P) are on. Turn them off if they get in the way of speech input or other tools.</label>
  );
}

function ShortcutsDialog({ onClose }) {
  const ref = useRef(null);
  useFocusTrap(ref, true, onClose);
  return (
    <div className="fixed inset-0 z-[65] flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4">
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" tabIndex={-1} className="mt-16 w-full max-w-2xl rounded-lg bg-white p-5 shadow-xl dark:bg-slate-800">
        <div className="flex items-center justify-between"><h2 id="shortcuts-title" className="text-lg">Keyboard shortcuts</h2><button type="button" className="btn-quiet" onClick={onClose}>Close</button></div>
        <div className="mt-3"><ShortcutList /></div>
        <div className="mt-4"><SingleKeyToggle /></div>
      </div>
    </div>
  );
}
