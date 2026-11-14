import { useEffect, useRef } from 'react';
import { isRedoKey, isUndoKey, record, startHistory, step } from '../lib/text-undo';

/**
 * Undo and redo for a controlled textarea, kept by the app (lib/text-undo.js
 * says why the browser's own cannot be used). `value`/`setValue` are the
 * editor's state, `ref` its textarea, and `resetKey` names what is being
 * edited (a page, a text): when it changes, the history starts again.
 *
 * Call `typed()` from the textarea's onChange and `formatted()` before a
 * toolbar or shortcut edit; any other change of `value` (a load, a restore,
 * a model run) starts a fresh history, so undo never brings back text from
 * outside this editing session. Spread nothing: pass `onKeyDown` through.
 */
export function useTextUndo(value, setValue, ref, resetKey) {
  const text = value ?? '';
  const history = useRef(startHistory(text));
  const key = useRef(resetKey);
  const pending = useRef(null);
  const applying = useRef(null);
  const latest = useRef(text);
  latest.current = text;

  useEffect(() => {
    if (key.current !== resetKey) {
      key.current = resetKey;
      pending.current = null;
      applying.current = null;
      history.current = startHistory(text);
      return;
    }
    if (applying.current !== null && applying.current === text) {
      applying.current = null;
      return;
    }
    applying.current = null;
    const kind = pending.current;
    pending.current = null;
    const el = ref.current;
    const sel = el ? [el.selectionStart, el.selectionEnd] : [text.length, text.length];
    history.current = kind === null ? startHistory(text, sel) : record(history.current, text, sel, Date.now(), kind);
  }, [text, resetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (dir) => {
    const [next, entry] = step(history.current, dir);
    if (!entry || entry.value === latest.current) return;
    history.current = next;
    applying.current = entry.value;
    setValue(entry.value);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el && el.value === entry.value) el.setSelectionRange(entry.sel[0], entry.sel[1]);
    });
  };

  // The browser's Edit menu (and anything else that asks for its undo) reaches us as beforeinput.
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const onBeforeInput = (e) => {
      if (e.inputType === 'historyUndo') { e.preventDefault(); go(-1); }
      else if (e.inputType === 'historyRedo') { e.preventDefault(); go(1); }
    };
    el.addEventListener('beforeinput', onBeforeInput);
    return () => el.removeEventListener('beforeinput', onBeforeInput);
  });

  return {
    /** From onChange: the person typed (a toolbar edit marked first with formatted() stays a format step). */
    typed: () => { if (pending.current === null) pending.current = 'type'; },
    /** Before a toolbar or shortcut edit: it becomes its own undo step. */
    formatted: () => { pending.current = 'format'; },
    /** Handles Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and Ctrl+Y; returns true when it did. */
    onKeyDown: (e) => {
      if (e.target?.readOnly) return false;
      if (isUndoKey(e)) { e.preventDefault(); go(-1); return true; }
      if (isRedoKey(e)) { e.preventDefault(); go(1); return true; }
      return false;
    },
  };
}
