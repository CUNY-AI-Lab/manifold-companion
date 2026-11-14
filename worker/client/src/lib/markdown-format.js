// The page editor's Markdown toolbar (legacy: B, I, H1-H3, separator, quote).
// Pure: given the text and the selection, return the range to replace, the
// replacement and the selection after, so the textarea can apply it with the
// browser's own insertText (which keeps Ctrl/Cmd+Z working).

const lineStart = (v, i) => v.lastIndexOf('\n', i - 1) + 1;
const lineEnd = (v, i) => { const n = v.indexOf('\n', i); return n === -1 ? v.length : n; };

function wrap(value, start, end, marker) {
  // A double click selects the trailing space too; keep it outside the markers.
  let e = end;
  while (e > start && /\s/.test(value[e - 1])) e -= 1;
  const sel = value.slice(start, e);
  const m = marker.length;
  const single = marker === '*';
  if (sel.length >= 2 * m && sel.startsWith(marker) && sel.endsWith(marker) && !(single && sel.startsWith('**') && sel.endsWith('**'))) {
    const inner = sel.slice(m, -m);
    return { from: start, to: e, text: inner, selStart: start, selEnd: start + inner.length };
  }
  const before = value.slice(start - m, start);
  const after = value.slice(e, e + m);
  const doubled = single && (value[start - 2] === '*' || value[e + 1] === '*');
  if (before === marker && after === marker && !doubled) {
    return { from: start - m, to: e + m, text: sel, selStart: start - m, selEnd: start - m + sel.length };
  }
  return { from: start, to: e, text: `${marker}${sel}${marker}`, selStart: start + m, selEnd: start + m + sel.length };
}

function lines(value, start, end) {
  const from = lineStart(value, start);
  const last = end > start && value[end - 1] === '\n' ? end - 1 : end;
  const to = lineEnd(value, Math.max(from, last));
  return { from, to, rows: value.slice(from, to).split('\n') };
}

function heading(value, start, end, level) {
  const { from, to, rows } = lines(value, start, end);
  const want = `${'#'.repeat(level)} `;
  const all = rows.every((r) => r.startsWith(want) && !r.startsWith(`${want.trim()}#`));
  const text = rows.map((r) => { const bare = r.replace(/^#{1,6}\s+/, ''); return all ? bare : `${want}${bare}`; }).join('\n');
  return { from, to, text, selStart: from, selEnd: from + text.length };
}

function quote(value, start, end) {
  const { from, to, rows } = lines(value, start, end);
  const all = rows.every((r) => /^>\s?/.test(r));
  const text = rows.map((r) => (all ? r.replace(/^>\s?/, '') : `> ${r}`)).join('\n');
  return { from, to, text, selStart: from, selEnd: from + text.length };
}

function separator(value, end) {
  const at = lineEnd(value, end);
  const lineEmpty = value.slice(lineStart(value, at), at).trim() === '';
  const text = lineEmpty ? '---\n' : '\n\n---\n';
  return { from: at, to: at, text, selStart: at + text.length, selEnd: at + text.length };
}

/** action: bold | italic | h1 | h2 | h3 | separator | quote */
export function formatMarkdown(value, start, end, action) {
  switch (action) {
    case 'bold': return wrap(value, start, end, '**');
    case 'italic': return wrap(value, start, end, '*');
    case 'h1': case 'h2': case 'h3': return heading(value, start, end, Number(action[1]));
    case 'quote': return quote(value, start, end);
    case 'separator': return separator(value, end);
    default: throw new Error(`Unknown format: ${action}`);
  }
}

/** The text after an edit (for tests, and when insertText is unavailable). */
export const applyEdit = (value, edit) => value.slice(0, edit.from) + edit.text + value.slice(edit.to);
