// Keyboard shortcuts: one list, shown in the shortcuts dialog and on the Help
// page, and the matching rules. Pure, so it is unit-tested.
//
// WCAG 2.1.4 (character key shortcuts): the shortcuts that are a single
// character key work only outside text fields and can be turned off
// (Settings, or the shortcuts dialog); the rest need Ctrl/Cmd.

export const SHORTCUTS = [
  { id: 'help', keys: '?', single: true, where: 'Everywhere, outside text fields', does: 'Show these keyboard shortcuts' },
  { id: 'search', keys: '/', single: true, where: 'Everywhere, outside text fields', does: 'Go to the search box' },
  { id: 'save', keys: 'Mod+S', where: 'A text editor', does: 'Save the text you are editing (the page, the full text or the HTML)' },
  { id: 'save-next', keys: 'Mod+Shift+S', where: 'An image text', does: 'Save the page and open the next one' },
  { id: 'next-page', keys: 'N', single: true, where: 'An image text, outside text fields', does: 'Open the next page' },
  { id: 'prev-page', keys: 'P', single: true, where: 'An image text, outside text fields', does: 'Open the previous page' },
  { id: 'close', keys: 'Escape', where: 'A dialog or the notification menu', does: 'Close it' },
];

export const SINGLE_KEY_PREF = 'manifold-companion:prefs:single-key-shortcuts';

export const isMac = (platform = globalThis.navigator?.platform ?? '') => /Mac|iPhone|iPad/i.test(platform);

/** "Mod+Shift+S" as this platform writes it: Ctrl+Shift+S, or ⌘ Shift S on a Mac. */
export function keyLabel(keys, mac = isMac()) {
  return keys.split('+').map((k) => (k === 'Mod' ? (mac ? '⌘' : 'Ctrl') : k)).join(mac ? ' ' : '+');
}

/** Does a keydown event match `keys` ("Mod+S", "Mod+Shift+S", "?", "N", "Escape")? Mod is Ctrl or Cmd. */
export function matches(e, keys) {
  const parts = keys.split('+');
  const key = parts[parts.length - 1];
  const mod = parts.includes('Mod');
  const shift = parts.includes('Shift');
  if (mod !== (e.ctrlKey || e.metaKey) || e.altKey) return false;
  if (key.length === 1 && /[A-Z]/.test(key)) return e.key.toUpperCase() === key && e.shiftKey === shift;
  if (key.length === 1) return e.key === key; // "?" and "/" (Shift is part of typing "?" on most layouts)
  return e.key === key && e.shiftKey === shift;
}

/** Text fields, editable regions and selects keep their keys (typing "n" in a field types n). */
export function isTypingTarget(el) {
  if (!el || typeof el !== 'object') return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes((el.type ?? 'text').toLowerCase());
}

/** Should this shortcut handle this event? */
export function applies(shortcut, e, { singleKeysOn }) {
  if (!matches(e, shortcut.keys)) return false;
  if (shortcut.single) return singleKeysOn && !isTypingTarget(e.target);
  return true;
}
