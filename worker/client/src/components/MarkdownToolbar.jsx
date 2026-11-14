import { Btn, Toolbar } from './RichEditor';
import { formatMarkdown } from '../lib/markdown-format';

/** Replace a range of a textarea through the browser's own editing, so Ctrl/Cmd+Z undoes it; fall back to setting the value. */
export function applyToTextarea(el, edit, setValue) {
  el.focus();
  el.setSelectionRange(edit.from, edit.to);
  let done = false;
  try { done = document.execCommand('insertText', false, edit.text); } catch { done = false; }
  if (!done || el.value.slice(edit.from, edit.from + edit.text.length) !== edit.text) {
    const next = el.value.slice(0, edit.from) + edit.text + el.value.slice(edit.to);
    setValue(next);
    requestAnimationFrame(() => el.setSelectionRange(edit.selStart, edit.selEnd));
    return;
  }
  el.setSelectionRange(edit.selStart, edit.selEnd);
}

/** The legacy page-editor toolbar: bold, italic, headings, separator, quotation, for Markdown in a textarea. */
export default function MarkdownToolbar({ textareaRef, controls, onChange, disabled = false }) {
  const run = (action) => () => {
    const el = textareaRef.current;
    if (!el || disabled) return;
    applyToTextarea(el, formatMarkdown(el.value, el.selectionStart, el.selectionEnd, action), onChange);
  };
  return (
    <Toolbar label="Format the page text (Markdown)" controls={controls}>
      <Btn label="Bold" keys="Ctrl/⌘ B" onRun={run('bold')} disabled={disabled}><b>B</b></Btn>
      <Btn label="Italic" keys="Ctrl/⌘ I" onRun={run('italic')} disabled={disabled}><i>I</i></Btn>
      <Btn label="Heading 1" onRun={run('h1')} disabled={disabled}>H1</Btn>
      <Btn label="Heading 2" onRun={run('h2')} disabled={disabled}>H2</Btn>
      <Btn label="Heading 3" onRun={run('h3')} disabled={disabled}>H3</Btn>
      <Btn label="Separator line" onRun={run('separator')} disabled={disabled}>―</Btn>
      <Btn label="Quotation" onRun={run('quote')} disabled={disabled}>“ ”</Btn>
    </Toolbar>
  );
}

/** Ctrl/Cmd+B and Ctrl/Cmd+I in the page text, as in the visual editor. */
export function markdownKeys(e, textareaRef, onChange) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
  const action = { b: 'bold', i: 'italic' }[e.key.toLowerCase()];
  if (!action) return;
  e.preventDefault();
  const el = textareaRef.current;
  applyToTextarea(el, formatMarkdown(el.value, el.selectionStart, el.selectionEnd, action), onChange);
}
