import { useEffect, useRef, useState } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import 'prosemirror-view/style/prosemirror.css';
import 'prosemirror-gapcursor/style/gapcursor.css';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { DOMParser as PMDOMParser } from 'prosemirror-model';
import { API, api } from '../api/client';
import useFocusTrap from '../hooks/useFocusTrap';
import { KATEX_OPTIONS } from '../lib/math';
import { blockKind, cmd, linkOf, markActive, plugins, putMath, selectedMath, setBlock, setLink } from '../lib/editor/commands';
import { openDocument, preparePastedHtml, serializeDoc } from '../lib/editor/html';
import { SAFE_LINK, schema, withAllowedImages } from '../lib/editor/schema';
import { ErrorNote } from './ui';

/** KaTeX into an element, built as DOM nodes by KaTeX (never HTML markup assigned by this app); trust is off. */
export function drawMath(el, tex, display) {
  el.textContent = '';
  katex.render(tex, el, { ...KATEX_OPTIONS, displayMode: display });
}

class MathView {
  constructor(node, view, getPos, onEdit) {
    this.node = node;
    this.dom = document.createElement(node.attrs.display ? 'div' : 'span');
    this.dom.className = `mc-math${node.attrs.display ? ' mc-math-display' : ''}`;
    this.dom.contentEditable = 'false';
    this.dom.title = 'Formula: click to edit its TeX';
    drawMath(this.dom, node.attrs.tex, node.attrs.display);
    this.dom.addEventListener('click', (e) => { e.preventDefault(); onEdit({ pos: getPos(), node: this.node }); });
  }
  update(node) {
    if (node.type !== this.node.type || node.attrs.display !== this.node.attrs.display) return false;
    if (node.attrs.tex !== this.node.attrs.tex) drawMath(this.dom, node.attrs.tex, node.attrs.display);
    this.node = node;
    return true;
  }
  selectNode() { this.dom.classList.add('mc-selected'); }
  deselectNode() { this.dom.classList.remove('mc-selected'); }
  stopEvent(e) { return e.type === 'mousedown' || e.type === 'click'; }
  ignoreMutation() { return true; }
}

/** A stored figure shown from the app (same origin, authorized); the document keeps only its file name. */
function imageView(figuresByName, textId) {
  return (node) => {
    const dom = document.createElement('img');
    const fig = figuresByName.get(node.attrs.src);
    dom.alt = node.attrs.alt ?? '';
    dom.className = 'mc-image';
    if (fig) dom.src = `${API}/texts/${textId}/figures/${fig.id}`;
    return { dom, ignoreMutation: () => true };
  };
}

/** A toolbar button: the symbol is what is seen; the name (and its keys) is what assistive technology reads and the tooltip shows. */
function Btn({ label, active, onRun, keys, children, disabled }) {
  return (
    <button type="button" className={`mc-tool ${active ? 'mc-tool-on' : ''}`} title={keys ? `${label} (${keys})` : label} aria-pressed={active === undefined ? undefined : !!active} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={onRun} tabIndex={-1}>
      <span aria-hidden="true">{children ?? label}</span><span className="sr-only">{label}</span>
    </button>
  );
}

/** A toolbar with one tab stop: arrows move between its controls (the ARIA toolbar pattern). */
function Toolbar({ children, label }) {
  const ref = useRef(null);
  useEffect(() => {
    const items = [...ref.current.querySelectorAll('button, select')];
    if (items.length && !items.some((i) => i.tabIndex === 0)) items.find((i) => !i.disabled).tabIndex = 0;
  });
  const onKeyDown = (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const items = [...ref.current.querySelectorAll('button:not([disabled]), select')];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
    items.forEach((el) => { el.tabIndex = -1; });
    items[next].tabIndex = 0;
    items[next].focus();
  };
  return <div ref={ref} role="toolbar" aria-label={label} aria-orientation="horizontal" className="mc-toolbar" onKeyDown={onKeyDown}>{children}</div>;
}

function useModal(onClose) {
  const ref = useRef(null);
  useFocusTrap(ref, true, onClose);
  return ref;
}

/** Edit one formula's TeX with a live KaTeX preview; "Repair" asks the text model to fix TeX KaTeX cannot read. */
function MathDialog({ textId, initial, onApply, onRemove, onClose }) {
  const ref = useModal(onClose);
  const [tex, setTex] = useState(initial.tex);
  const [display, setDisplay] = useState(initial.display);
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const preview = useRef(null);
  useEffect(() => {
    try {
      katex.renderToString(tex, { ...KATEX_OPTIONS, throwOnError: true, displayMode: display });
      setProblem(null);
    } catch (e) {
      setProblem(e?.message?.replace(/^KaTeX parse error: /, '') ?? 'This TeX cannot be read.');
    }
    if (preview.current) drawMath(preview.current, tex, display);
  }, [tex, display]);
  const repair = async () => {
    setBusy(true);
    setError(null);
    try {
      const { formulas } = await api.post(`/api/texts/${textId}/formula-repair`, { formulas: [tex] });
      if (formulas?.[0]?.repaired) setTex(formulas[0].repaired);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4">
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="math-title" tabIndex={-1} className="mt-16 w-full max-w-2xl rounded-lg bg-white p-5 shadow-xl dark:bg-slate-800">
        <h2 id="math-title" className="text-lg">{initial.pos === null ? 'Insert a formula' : 'Edit formula'}</h2>
        <ErrorNote error={error} onDismiss={() => setError(null)} />
        <label className="mt-3 block"><span className="label">TeX</span>
          <textarea className="field min-h-[6rem] font-mono" value={tex} onChange={(e) => setTex(e.target.value)} aria-describedby="math-problem" spellCheck={false} />
        </label>
        <label className="mt-2 block text-sm"><input type="checkbox" checked={display} onChange={(e) => setDisplay(e.target.checked)} /> Display formula (on its own line)</label>
        <p className="label mt-3">Preview</p>
        <div ref={preview} className="mc-math-preview" aria-hidden="true" />
        <p id="math-problem" role="status" className={`mt-2 text-sm ${problem ? 'text-red-800 dark:text-red-300' : 'text-slate-600 dark:text-slate-300'}`}>{problem ? `KaTeX cannot read this: ${problem}` : tex.trim() ? 'KaTeX reads this formula.' : 'Type the formula as TeX.'}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className="btn-primary" disabled={!tex.trim()} onClick={() => onApply(tex, display)}>{initial.pos === null ? 'Insert' : 'Apply'}</button>
          <button type="button" className="btn-quiet" disabled={!problem || busy} onClick={repair}>{busy ? 'Repairing' : 'Repair this formula'}</button>
          {initial.pos !== null ? <button type="button" className="btn-danger" onClick={onRemove}>Remove formula</button> : null}
          <button type="button" className="btn-quiet" onClick={onClose}>Cancel</button>
        </div>
        <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">Repair sends only this TeX to the text model and is paid from your model allowance.</p>
      </div>
    </div>
  );
}

function LinkDialog({ initial, onApply, onClose }) {
  const ref = useModal(onClose);
  const [href, setHref] = useState(initial ?? '');
  const ok = href.trim() === '' || SAFE_LINK.test(href.trim());
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 p-4">
      <form ref={ref} role="dialog" aria-modal="true" aria-labelledby="link-title" tabIndex={-1} className="mt-24 w-full max-w-md rounded-lg bg-white p-5 shadow-xl dark:bg-slate-800" onSubmit={(e) => { e.preventDefault(); if (ok) onApply(href); }}>
        <h2 id="link-title" className="text-lg">Link</h2>
        <label className="mt-3 block"><span className="label">Address (https://, http:// or mailto:)</span><input className="field" value={href} onChange={(e) => setHref(e.target.value)} aria-invalid={!ok} aria-describedby="link-help" /></label>
        <p id="link-help" className={`mt-1 text-xs ${ok ? 'text-slate-600 dark:text-slate-300' : 'text-red-800 dark:text-red-300'}`}>{ok ? 'Leave empty to remove the link.' : 'Only web (http, https) and email (mailto) addresses can be linked.'}</p>
        <div className="mt-4 flex gap-2"><button type="submit" className="btn-primary" disabled={!ok}>Apply</button><button type="button" className="btn-quiet" onClick={onClose}>Cancel</button></div>
      </form>
    </div>
  );
}

/**
 * The visual editor. `value` is stored HTML; `onChange` gets stored HTML back:
 * exactly `value` while the document equals what was loaded (so opening and
 * saving without an edit changes nothing), else the serialized document.
 * `onFallback(reasons)` when `value` holds something the schema cannot (the
 * page then shows the source view).
 */
export default function RichEditor({ value, onChange, onFallback, figures, textId, readOnly, labelledBy }) {
  const host = useRef(null);
  const view = useRef(null);
  const loaded = useRef({ html: null, doc: null });
  const emitted = useRef(null);
  const [tick, setTick] = useState(0);
  const [mathEdit, setMathEdit] = useState(null);
  const [linkEdit, setLinkEdit] = useState(null);
  const figureNames = figures.map((f) => f.filename);
  const callbacks = useRef({});
  callbacks.current = { onChange, onFallback, editMath: (m) => setMathEdit({ pos: m.pos, tex: m.node?.attrs.tex ?? '', display: m.node?.attrs.display ?? false }), link: () => setLinkEdit(linkOf(view.current.state) ?? '') };

  useEffect(() => {
    if (value === emitted.current && view.current) return; // our own change coming back
    const opened = openDocument(value, { figures: figureNames });
    if (opened.mode !== 'rich') { callbacks.current.onFallback(opened.reasons ?? []); return; }
    loaded.current = { html: value, doc: opened.doc };
    emitted.current = value;
    const byName = new Map(figures.map((f) => [f.filename, f]));
    const state = EditorState.create({ doc: opened.doc, plugins: plugins({ onEditMath: (m) => callbacks.current.editMath(m), onLink: () => callbacks.current.link() }) });
    if (view.current) view.current.destroy();
    view.current = new EditorView(host.current, {
      state,
      editable: () => !readOnly,
      attributes: { class: 'mc-editor', role: 'textbox', 'aria-multiline': 'true', ...(labelledBy ? { 'aria-labelledby': labelledBy } : {}), spellcheck: 'true' },
      nodeViews: {
        math: (node, v, getPos) => new MathView(node, v, getPos, (m) => { if (!readOnly) callbacks.current.editMath(m); }),
        image: imageView(byName, textId),
        figure_image: imageView(byName, textId),
      },
      // Paste goes through the schema: sanitized like stored content, TeX found, and parsed with the allowlist only.
      transformPastedHTML: (html) => preparePastedHtml(html),
      clipboardParser: {
        parseSlice: (dom, options) => withAllowedImages(new Set(figureNames), () => PMDOMParser.fromSchema(schema).parseSlice(dom, options)),
      },
      dispatchTransaction(tr) {
        const next = view.current.state.apply(tr);
        view.current.updateState(next);
        if (tr.docChanged) {
          const html = next.doc.eq(loaded.current.doc) ? loaded.current.html : serializeDoc(next.doc);
          emitted.current = html;
          callbacks.current.onChange(html);
        }
        setTick((t) => t + 1);
      },
    });
    setTick((t) => t + 1);
  }, [value, figureNames.join('\n'), readOnly]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => view.current?.destroy(), []);

  const run = (command) => () => { const v = view.current; if (!v) return; command(v.state, v.dispatch); v.focus(); };
  const state = view.current?.state;
  void tick;
  const kind = state ? blockKind(state) : 'paragraph';
  return (
    <div className="mc-editor-frame">
      {!readOnly ? (
        <Toolbar label="Formatting">
          <label className="sr-only" htmlFor="mc-block">Block type</label>
          <select id="mc-block" className="mc-tool-select" value={kind} tabIndex={-1} onChange={(e) => run(setBlock(e.target.value))()}>
            <option value="paragraph">Paragraph</option><option value="h1">Heading 1</option><option value="h2">Heading 2</option><option value="h3">Heading 3</option><option value="h4">Heading 4</option><option value="code">Code block</option>
          </select>
          <Btn label="Bold" keys="Ctrl/⌘ B" active={state && markActive(state, schema.marks.strong)} onRun={run(cmd.bold)}><b>B</b></Btn>
          <Btn label="Italic" keys="Ctrl/⌘ I" active={state && markActive(state, schema.marks.em)} onRun={run(cmd.italic)}><i>I</i></Btn>
          <Btn label="Superscript" active={state && markActive(state, schema.marks.sup)} onRun={run(cmd.sup)}>x²</Btn>
          <Btn label="Subscript" active={state && markActive(state, schema.marks.sub)} onRun={run(cmd.sub)}>x₂</Btn>
          <Btn label="Code" keys="Ctrl/⌘ `" active={state && markActive(state, schema.marks.code)} onRun={run(cmd.code)}>{'</>'}</Btn>
          <Btn label="Link" keys="Ctrl/⌘ K" active={state && markActive(state, schema.marks.link)} onRun={() => callbacks.current.link()}>Link</Btn>
          <Btn label="Bulleted list" onRun={run(cmd.bulletList)}>• List</Btn>
          <Btn label="Numbered list" onRun={run(cmd.orderedList)}>1. List</Btn>
          <Btn label="Indent list item" keys="Ctrl/⌘ ]" onRun={run(cmd.indent)}>→</Btn>
          <Btn label="Outdent" keys="Ctrl/⌘ [" onRun={run(cmd.outdent)}>←</Btn>
          <Btn label="Quotation" onRun={run(cmd.quote)}>“ ”</Btn>
          <Btn label="Insert formula" keys="Ctrl/⌘ Shift M" onRun={() => callbacks.current.editMath(selectedMath(view.current.state) ?? { pos: null, node: null })}>∑ Formula</Btn>
          <Btn label="Undo" keys="Ctrl/⌘ Z" onRun={run(cmd.undo)}>↶</Btn>
          <Btn label="Redo" keys="Ctrl/⌘ Shift Z" onRun={run(cmd.redo)}>↷</Btn>
        </Toolbar>
      ) : null}
      <div ref={host} className="mc-editor-host" />
      {mathEdit ? (
        <MathDialog
          textId={textId}
          initial={mathEdit}
          onClose={() => { setMathEdit(null); view.current?.focus(); }}
          onApply={(tex, display) => { const v = view.current; putMath(tex, display, mathEdit.pos)(v.state, v.dispatch); setMathEdit(null); v.focus(); }}
          onRemove={() => { const v = view.current; v.dispatch(v.state.tr.delete(mathEdit.pos, mathEdit.pos + 1)); setMathEdit(null); v.focus(); }}
        />
      ) : null}
      {linkEdit !== null ? <LinkDialog initial={linkEdit} onClose={() => { setLinkEdit(null); view.current?.focus(); }} onApply={(href) => { const v = view.current; setLink(href)(v.state, v.dispatch); setLinkEdit(null); v.focus(); }} /> : null}
    </div>
  );
}

