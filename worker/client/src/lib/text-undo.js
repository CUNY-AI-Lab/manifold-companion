// Undo history for the plain-text editors (page text, full text, HTML source).
//
// The browser's own undo cannot be used for them in Safari: WebKit clears a
// page's whole undo history whenever any iframe loads a new document, and the
// sandboxed live preview beside each editor (SandboxedPreview, srcdoc) reloads
// on every keystroke. So these editors keep their own history and handle
// Ctrl/Cmd+Z themselves, the same in every browser.

export const UNDO_LIMIT = 200;
export const COALESCE_MS = 1000;

/** A history holding only `value` (a load, a page switch or a change made outside the editor starts one). */
export function startHistory(value, sel = [value.length, value.length]) {
  return { entries: [{ value, sel }], index: 0, at: 0, kind: null };
}

/**
 * The history after the editor's text became `value` with the selection `sel`.
 * `kind` is 'type' (typing: a burst within COALESCE_MS is one step) or
 * 'format' (a toolbar or shortcut edit: always its own step). An edit after an
 * undo drops the steps that could have been redone.
 */
export function record(h, value, sel, now, kind) {
  const current = h.entries[h.index];
  if (value === current.value) return h;
  const entries = h.entries.slice(0, h.index + 1);
  if (kind === 'type' && h.kind === 'type' && now - h.at < COALESCE_MS && h.index > 0 && h.index === h.entries.length - 1) {
    entries[entries.length - 1] = { value, sel };
    return { entries, index: entries.length - 1, at: now, kind };
  }
  entries.push({ value, sel });
  const kept = entries.length > UNDO_LIMIT ? entries.slice(entries.length - UNDO_LIMIT) : entries;
  return { entries: kept, index: kept.length - 1, at: now, kind };
}

/** One step back (dir -1) or forward (dir 1): [history, entry to show], or [history, null] at either end. */
export function step(h, dir) {
  const index = h.index + dir;
  if (index < 0 || index >= h.entries.length) return [h, null];
  return [{ ...h, index, kind: null }, h.entries[index]];
}

const mod = (e) => (e.metaKey || e.ctrlKey) && !e.altKey;
/** Ctrl/Cmd+Z. */
export const isUndoKey = (e) => mod(e) && !e.shiftKey && e.key.toLowerCase() === 'z';
/** Ctrl/Cmd+Shift+Z, or Ctrl+Y. */
export const isRedoKey = (e) => mod(e) && ((e.shiftKey && e.key.toLowerCase() === 'z') || (e.ctrlKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'y'));
