import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import DOMPurify from 'dompurify';
import JSZip from 'jszip';
import { api, BASE } from '../api/client';
import { applyFormulaRepairs, extractFormulaCandidatesFromHtml } from '../lib/pdfToHtml';
import { repairFormulasInBatches } from '../lib/formulaRepair';

const MATHML_TAGS = [
  'math', 'maction', 'maligngroup', 'malignmark', 'menclose', 'merror', 'mfenced', 'mfrac',
  'mglyph', 'mi', 'mlabeledtr', 'mmultiscripts', 'mn', 'mo', 'mover', 'mpadded', 'mphantom',
  'mprescripts', 'mroot', 'mrow', 'ms', 'mscarries', 'mscarry', 'msgroup', 'msline', 'mspace',
  'msqrt', 'msrow', 'mstack', 'mstyle', 'msub', 'msubsup', 'msup', 'mtable', 'mtd', 'mtext',
  'mtr', 'munder', 'munderover', 'none', 'semantics', 'annotation', 'annotation-xml',
];

const MATHML_ATTRS = [
  'accent', 'accentunder', 'align', 'bevelled', 'class', 'close', 'columnalign', 'columnlines',
  'columnspan', 'denomalign', 'depth', 'dir', 'display', 'displaystyle', 'encoding', 'fence',
  'form', 'frame', 'height', 'href', 'id', 'largeop', 'length', 'linethickness', 'location',
  'lspace', 'mathbackground', 'mathcolor', 'mathsize', 'mathvariant', 'maxsize', 'minsize',
  'movablelimits', 'notation', 'open', 'rowalign', 'rowlines', 'rowspan', 'rspace', 'scriptlevel',
  'scriptminsize', 'scriptsizemultiplier', 'selection', 'separator', 'separators', 'stretchy',
  'style', 'subscriptshift', 'superscriptshift', 'symmetric', 'voffset', 'width', 'xmlns',
  'xmlns:xlink', 'xlink:href',
];

// MathJax removed — math is now native MathML converted server-side via temml

// ---------------------------------------------------------------------------
// Image resize overlay — click image to select, drag handles to resize
// ---------------------------------------------------------------------------

function ImageResizer({ editableRef, onDirty }) {
  const [target, setTarget] = useState(null);
  const [rect, setRect] = useState(null);
  const dragging = useRef(null);

  // Listen for clicks on images inside the editable area
  useEffect(() => {
    const el = editableRef.current;
    if (!el) return;

    function onClick(e) {
      if (e.target.tagName === 'IMG' && el.contains(e.target)) {
        setTarget(e.target);
        updateRect(e.target);
      } else if (e.target.closest?.('.img-resize-handle')) {
        // Don't deselect when clicking handles
      } else {
        setTarget(null);
      }
    }

    function onScroll() {
      if (target) updateRect(target);
    }

    el.addEventListener('click', onClick);
    el.addEventListener('scroll', onScroll);
    return () => {
      el.removeEventListener('click', onClick);
      el.removeEventListener('scroll', onScroll);
    };
  });

  function updateRect(img) {
    const container = editableRef.current;
    if (!img || !container) return;
    const cr = container.getBoundingClientRect();
    const ir = img.getBoundingClientRect();
    setRect({
      top: ir.top - cr.top + container.scrollTop,
      left: ir.left - cr.left + container.scrollLeft,
      width: ir.width,
      height: ir.height,
    });
  }

  function onPointerDown(e, corner) {
    e.preventDefault();
    e.stopPropagation();
    if (!target) return;
    const startX = e.clientX;
    const startW = target.offsetWidth;
    const aspectRatio = target.naturalWidth / target.naturalHeight || startW / target.offsetHeight;

    function onPointerMove(ev) {
      const dx = corner.includes('right') ? ev.clientX - startX : startX - ev.clientX;
      const newW = Math.max(60, startW + dx);
      target.style.width = `${newW}px`;
      target.style.height = 'auto';
      target.setAttribute('width', Math.round(newW));
      target.removeAttribute('height');
      updateRect(target);
      onDirty();
    }

    function onPointerUp() {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
    }

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
  }

  if (!target || !rect) return null;

  const handleClass = 'img-resize-handle absolute w-3 h-3 bg-cail-blue border-2 border-white rounded-sm shadow-sm z-50 cursor-nwse-resize';

  return (
    <>
      {/* Selection border */}
      <div
        className="absolute pointer-events-none border-2 border-cail-blue rounded-sm z-40"
        style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
      />
      {/* Size label */}
      <div
        className="absolute z-50 px-1.5 py-0.5 rounded bg-cail-blue text-white text-[10px] font-medium whitespace-nowrap pointer-events-none"
        style={{ top: rect.top - 22, left: rect.left }}
      >
        {target.getAttribute('width') || Math.round(rect.width)}px
      </div>
      {/* Corner handles */}
      <div
        className={handleClass}
        style={{ top: rect.top - 5, left: rect.left + rect.width - 5, cursor: 'nesw-resize' }}
        onPointerDown={(e) => onPointerDown(e, 'top-right')}
      />
      <div
        className={handleClass}
        style={{ top: rect.top + rect.height - 5, left: rect.left + rect.width - 5 }}
        onPointerDown={(e) => onPointerDown(e, 'bottom-right')}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Formatting toolbar for contenteditable
// ---------------------------------------------------------------------------

function execCmd(command, value = null) {
  document.execCommand(command, false, value);
}

function formatBlock(tag) {
  document.execCommand('formatBlock', false, tag);
}

function TBtn({ onClick, title, children, className: extra }) {
  return (
    <button
      type="button"
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      title={title}
      className={`px-2 py-1.5 rounded text-sm font-medium transition text-gray-600 hover:bg-gray-100 hover:text-cail-dark ${extra || ''}`}
    >
      {children}
    </button>
  );
}

function Sep() {
  return <div className="w-px h-5 bg-gray-200 mx-0.5" />;
}

function FormattingToolbar({ onDirty, editableRef }) {
  const wrap = (fn) => () => { fn(); onDirty(); };
  const [showFind, setShowFind] = useState(false);
  const findRef = useRef(null);
  const replaceRef = useRef(null);

  function doFind() {
    const term = findRef.current?.value;
    if (!term) return;
    window.getSelection().removeAllRanges();
    // Use browser find — highlight matches
    window.find(term, false, false, true, false, false, false);
  }

  function doReplace() {
    const term = findRef.current?.value;
    const replacement = replaceRef.current?.value;
    if (!term || replacement == null) return;
    const sel = window.getSelection();
    if (sel.toString() === term) {
      document.execCommand('insertText', false, replacement);
      onDirty();
    }
    window.find(term, false, false, true, false, false, false);
  }

  function doReplaceAll() {
    const el = editableRef?.current;
    const term = findRef.current?.value;
    const replacement = replaceRef.current?.value;
    if (!el || !term || replacement == null) return;
    // Simple innerHTML replacement for plain text
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    el.innerHTML = el.innerHTML.replace(new RegExp(`(?<=>)([^<]*?)${escaped}`, 'g'), (match) =>
      match.replace(new RegExp(escaped, 'g'), replacement)
    );
    onDirty();
  }

  return (
    <div className="border-b border-gray-200 bg-gray-50/80 rounded-t-xl">
      <div className="flex flex-wrap items-center gap-0.5 px-3 py-1.5">
        {/* Block type */}
        <select
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(e) => { const v = e.target.value; if (v) formatBlock(v); e.target.value = ''; onDirty(); }}
          defaultValue=""
          className="px-2 py-1 rounded border border-gray-200 text-xs text-gray-700 bg-white hover:border-gray-300 focus:border-cail-blue outline-none cursor-pointer"
          title="Block type"
        >
          <option value="" disabled>Block</option>
          <option value="p">Paragraph</option>
          <option value="h1">H1</option>
          <option value="h2">H2</option>
          <option value="h3">H3</option>
          <option value="h4">H4</option>
          <option value="blockquote">Quote</option>
        </select>

        <Sep />

        <TBtn onClick={wrap(() => execCmd('bold'))} title="Bold (Ctrl+B)"><strong>B</strong></TBtn>
        <TBtn onClick={wrap(() => execCmd('italic'))} title="Italic (Ctrl+I)"><em>I</em></TBtn>
        <TBtn onClick={wrap(() => execCmd('underline'))} title="Underline (Ctrl+U)"><span className="underline">U</span></TBtn>
        <TBtn onClick={wrap(() => execCmd('strikeThrough'))} title="Strikethrough"><span className="line-through">S</span></TBtn>
        <TBtn onClick={wrap(() => execCmd('superscript'))} title="Superscript">x<sup>2</sup></TBtn>
        <TBtn onClick={wrap(() => execCmd('subscript'))} title="Subscript">x<sub>2</sub></TBtn>

        <Sep />

        <TBtn onClick={wrap(() => execCmd('justifyLeft'))} title="Align left">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="18" x2="18" y2="18"/></svg>
        </TBtn>
        <TBtn onClick={wrap(() => execCmd('justifyCenter'))} title="Align center">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>
        </TBtn>

        <Sep />

        <TBtn onClick={wrap(() => execCmd('insertUnorderedList'))} title="Bullet list">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4" cy="6" r="1.5" fill="currentColor"/><circle cx="4" cy="12" r="1.5" fill="currentColor"/><circle cx="4" cy="18" r="1.5" fill="currentColor"/></svg>
        </TBtn>
        <TBtn onClick={wrap(() => execCmd('insertOrderedList'))} title="Numbered list">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="10" y1="6" x2="20" y2="6"/><line x1="10" y1="12" x2="20" y2="12"/><line x1="10" y1="18" x2="20" y2="18"/><text x="2" y="8" fontSize="7" fill="currentColor" stroke="none" fontFamily="sans-serif">1</text><text x="2" y="14" fontSize="7" fill="currentColor" stroke="none" fontFamily="sans-serif">2</text><text x="2" y="20" fontSize="7" fill="currentColor" stroke="none" fontFamily="sans-serif">3</text></svg>
        </TBtn>
        <TBtn onClick={wrap(() => execCmd('indent'))} title="Indent">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="9" y1="18" x2="21" y2="18"/><polyline points="3,10 6,14 3,18"/></svg>
        </TBtn>
        <TBtn onClick={wrap(() => execCmd('outdent'))} title="Outdent">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="9" y1="18" x2="21" y2="18"/><polyline points="6,10 3,14 6,18"/></svg>
        </TBtn>

        <Sep />

        <TBtn onClick={wrap(() => {
          const url = prompt('Enter URL:');
          if (url) execCmd('createLink', url);
        })} title="Insert link">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
        </TBtn>
        <TBtn onClick={wrap(() => execCmd('unlink'))} title="Remove link">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/><line x1="4" y1="4" x2="20" y2="20" strokeWidth="1.5"/></svg>
        </TBtn>

        <TBtn onClick={wrap(() => {
          const cols = parseInt(prompt('Columns:', '3'), 10);
          const rows = parseInt(prompt('Rows:', '3'), 10);
          if (!cols || !rows) return;
          const ths = Array(cols).fill('<th>&nbsp;</th>').join('');
          const tds = Array(cols).fill('<td>&nbsp;</td>').join('');
          const trs = Array(rows).fill(`<tr>${tds}</tr>`).join('');
          execCmd('insertHTML', `<table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`);
        })} title="Insert table">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
        </TBtn>

        <TBtn onClick={wrap(() => execCmd('insertHorizontalRule'))} title="Horizontal rule">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="12" x2="21" y2="12"/></svg>
        </TBtn>

        <Sep />

        <TBtn onClick={wrap(() => execCmd('undo'))} title="Undo (Ctrl+Z)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="1,4 1,10 7,10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
        </TBtn>
        <TBtn onClick={wrap(() => execCmd('redo'))} title="Redo">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23,4 23,10 17,10"/><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10"/></svg>
        </TBtn>

        <Sep />

        <TBtn onClick={wrap(() => execCmd('removeFormat'))} title="Clear formatting">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="4" y1="4" x2="20" y2="20"/><path d="M7 21h10"/><path d="M9.5 4h5l-3 7"/></svg>
        </TBtn>

        <TBtn onClick={() => setShowFind(!showFind)} title="Find & Replace (Ctrl+H)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        </TBtn>
      </div>

      {/* Find & Replace bar */}
      {showFind && (
        <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 border-t border-gray-100 bg-gray-50/50">
          <input
            ref={findRef}
            type="text"
            placeholder="Find..."
            className="px-2 py-1 text-xs border border-gray-200 rounded bg-white w-36 focus:border-cail-blue focus:ring-1 focus:ring-cail-blue/20 outline-none"
            onKeyDown={(e) => { if (e.key === 'Enter') doFind(); }}
          />
          <button onClick={doFind} className="px-2 py-1 text-xs rounded bg-gray-200 text-gray-700 hover:bg-gray-300">Find</button>
          <input
            ref={replaceRef}
            type="text"
            placeholder="Replace..."
            className="px-2 py-1 text-xs border border-gray-200 rounded bg-white w-36 focus:border-cail-blue focus:ring-1 focus:ring-cail-blue/20 outline-none"
            onKeyDown={(e) => { if (e.key === 'Enter') doReplace(); }}
          />
          <button onClick={doReplace} className="px-2 py-1 text-xs rounded bg-gray-200 text-gray-700 hover:bg-gray-300">Replace</button>
          <button onClick={doReplaceAll} className="px-2 py-1 text-xs rounded bg-gray-200 text-gray-700 hover:bg-gray-300">All</button>
          <button onClick={() => setShowFind(false)} className="px-1.5 py-1 text-xs text-gray-400 hover:text-gray-600">x</button>
        </div>
      )}
    </div>
  );
}

function buildDownloadHtml(title, content) {
  const safeTitle = title.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; max-width: 52rem; margin: 2rem auto; padding: 0 1.5rem; line-height: 1.75; color: #1a1a1a; }

  /* Headings */
  h1 { font-size: 1.7rem; font-weight: 700; margin: 1.5rem 0 0.75rem; border-bottom: 2px solid #c7d2de; padding-bottom: 0.5rem; color: #1e293b; }
  h2 { font-size: 1.35rem; font-weight: 600; margin: 1.75rem 0 0.5rem; color: #1e3a5f; }
  h3 { font-size: 1.1rem; font-weight: 600; margin: 1.25rem 0 0.4rem; color: #334155; }
  h4 { font-size: 1rem; font-weight: 600; margin: 1rem 0 0.35rem; color: #475569; }
  p { margin: 0.5rem 0; }

  /* Page sections */
  section[data-page] { margin-bottom: 2rem; padding-bottom: 1.5rem; border-bottom: 1px solid #e2e8f0; }

  /* Example / exercise boxes */
  section[data-page] > section { margin: 1.25rem 0; padding: 1rem 1.25rem; background: linear-gradient(135deg, #fefce8 0%, #fef9c3 100%); border-radius: 0.625rem; border: 1px solid #fde68a; }
  section[data-page] > section > header,
  section[data-page] > section > h3:first-child,
  section[data-page] > section > h4:first-child { font-weight: 700; font-size: 0.95rem; text-transform: uppercase; letter-spacing: 0.03em; color: #92400e; margin: 0 0 0.5rem; padding-bottom: 0.35rem; border-bottom: 1px solid #fcd34d; }
  section[data-page] > section > section { margin: 0.75rem 0; padding: 0.75rem 1rem; background: rgba(255,255,255,0.6); border-radius: 0.5rem; border: 1px solid #fde68a; }

  /* Aside: definitions, theorems, callouts */
  aside { margin: 1.25rem 0; padding: 1rem 1.25rem; background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%); border-radius: 0.625rem; border: 1px solid #93c5fd; border-left: 4px solid #3b82f6; }
  aside > h2:first-child, aside > h3:first-child, aside > h4:first-child { font-size: 0.95rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; color: #1e40af; margin: 0 0 0.5rem; padding-bottom: 0.35rem; border-bottom: 1px solid #93c5fd; }

  /* Blockquote: theorem/definition callouts */
  blockquote { margin: 1.25rem 0; padding: 1rem 1.25rem; background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%); border-radius: 0.625rem; border: 1px solid #86efac; border-left: 4px solid #22c55e; color: #14532d; }
  blockquote > h2:first-child, blockquote > h3:first-child, blockquote > h4:first-child { font-size: 0.95rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; color: #166534; margin: 0 0 0.5rem; padding-bottom: 0.35rem; border-bottom: 1px solid #86efac; }

  /* Header elements */
  body > header, section[data-page] > header { margin-bottom: 0.75rem; }

  /* Footer */
  footer { margin-top: 1.5rem; padding-top: 0.75rem; border-top: 1px solid #e2e8f0; font-size: 0.85rem; color: #64748b; font-style: italic; }

  /* Navigation / TOC */
  nav { margin: 0.5rem 0 1rem; }
  nav ul { list-style: none; padding: 0; margin: 0; }
  nav li { padding: 0.2rem 0; color: #475569; }
  .toc-entry { display: flex; justify-content: space-between; gap: 1rem; padding: 0.25rem 0; }
  .toc-entry__title { flex: 1; }
  .toc-entry__page { color: #6b7280; white-space: nowrap; }

  /* Lists */
  ul, ol { margin: 0.5rem 0; padding-left: 1.75rem; }
  li { margin: 0.25rem 0; }
  ol[type="a"] { list-style-type: lower-alpha; }
  ol[type="A"] { list-style-type: upper-alpha; }
  ol[type="i"] { list-style-type: lower-roman; }

  /* Tables */
  table { border-collapse: collapse; margin: 1rem 0; width: 100%; font-size: 0.95rem; }
  th, td { border: 1px solid #cbd5e1; padding: 0.5rem 0.75rem; text-align: left; }
  th { background: #f1f5f9; font-weight: 600; color: #334155; }
  tbody tr:nth-child(even) { background: #f8fafc; }

  /* Figures / images */
  figure { margin: 1.5rem 0; text-align: center; padding: 1rem; background: #fafafa; border-radius: 0.5rem; border: 1px dashed #d1d5db; }
  figure img { max-width: 100%; height: auto; border-radius: 0.375rem; }
  figcaption { font-style: italic; color: #6b7280; margin-top: 0.5rem; font-size: 0.9rem; }

  /* Formula blocks */
  .formula-block { margin: 1rem 0; padding: 0.75rem 1rem; background: #f8f9fa; border-radius: 0.5rem; border: 1px solid #e9ecef; font-family: 'Cambria Math', 'STIX Two Math', serif; }

  /* Links */
  a { color: #2563eb; text-decoration: underline; text-underline-offset: 2px; }
  a:hover { color: #1d4ed8; }

  /* Inline elements */
  strong { font-weight: 700; }
  em { font-style: italic; }
  sup, sub { font-size: 0.75em; line-height: 0; }

  /* MathML */
  math { font-size: 1.1em; }
  math[display="block"] { display: block; margin: 0.75rem 0; overflow-x: auto; }
  .math-fallback { font-family: 'Cambria Math', 'STIX Two Math', serif; color: #b91c1c; }
</style>
</head>
<body>
${content}
</body>
</html>`;
}

const SANITIZE_CONFIG = {
  USE_PROFILES: { html: true, mathMl: true },
  ADD_TAGS: [...MATHML_TAGS, 'figure', 'figcaption', 'img'],
  ADD_ATTR: [...MATHML_ATTRS, 'data-page', 'data-formula-id', 'data-formula-source', 'contenteditable', 'src', 'alt', 'loading', 'width', 'style'],
};

export default function HtmlTextDetail() {
  const { id } = useParams();
  const editableRef = useRef(null);
  const sourceRef = useRef(null);
  const [text, setText] = useState(null);
  const [htmlContent, setHtmlContent] = useState('');
  const [formulaStatus, setFormulaStatus] = useState('');
  const [sourcePdfName, setSourcePdfName] = useState('');
  const [pdfPages, setPdfPages] = useState([]);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [repairProgress, setRepairProgress] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [sourceMode, setSourceMode] = useState(false);
  const [dirty, setDirty] = useState(false);
  const autoRepairStartedRef = useRef(false);

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const [textData, htmlData] = await Promise.all([
          api.get(`/api/texts/${id}`),
          api.get(`/api/texts/${id}/html`),
        ]);
        if (!active) return;
        setText(textData);
        setHtmlContent(htmlData.html_content || '');
        setFormulaStatus(htmlData.formula_repair_status || '');
        setSourcePdfName(htmlData.source_pdf_name || '');
      } catch (err) {
        if (active) setError(err.message);
      } finally {
        if (active) setLoading(false);
      }
    }

    load();
    return () => { active = false; };
  }, [id]);

  const sanitizedHtml = useMemo(() => {
    let html = DOMPurify.sanitize(htmlContent, SANITIZE_CONFIG);
    // Rewrite page image/figure src to API endpoint for preview
    html = html.replace(
      /src="(page-[\w-]+\.\w+)"/g,
      (_, filename) => `src="${BASE}/api/texts/${id}/page-image/${filename}"`
    );
    return html;
  }, [htmlContent, id]);

  // Mark broken images so CSS can hide them gracefully
  useEffect(() => {
    const el = editableRef.current;
    if (!el) return;
    const handler = (e) => {
      if (e.target.tagName === 'IMG') e.target.classList.add('img-error');
    };
    el.addEventListener('error', handler, true);
    return () => el.removeEventListener('error', handler, true);
  });

  // When switching from source to visual, sync the source textarea back
  function switchToVisual() {
    if (sourceRef.current) {
      const newHtml = sourceRef.current.value;
      setHtmlContent(newHtml);
      setDirty(true);
    }
    setSourceMode(false);
  }

  // When switching from visual to source, read from the editable div
  function switchToSource() {
    if (editableRef.current) {
      // Read innerHTML and normalize image srcs back to relative paths
      setHtmlContent(normalizeImageSrcs(editableRef.current.innerHTML));
    }
    setSourceMode(true);
  }

  // Track edits in the contenteditable div
  function handleEditableInput() {
    setDirty(true);
  }

  // PDF preview loading
  useEffect(() => {
    let active = true;

    async function loadPdfPreview() {
      if (!sourcePdfName) {
        setPdfPages([]);
        return;
      }

      setPdfLoading(true);
      try {
        const pdfjsLib = await import('pdfjs-dist');
        pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/build/pdf.worker.mjs',
          import.meta.url
        ).toString();

        const res = await fetch(`${BASE}/api/texts/${id}/source-pdf/${encodeURIComponent(sourcePdfName)}`, {
          credentials: 'same-origin',
        });
        if (!res.ok) throw new Error('Failed to load source PDF.');

        const buffer = await res.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
        const rendered = [];

        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
          const page = await pdf.getPage(pageNumber);
          const viewport = page.getViewport({ scale: 1.25 });
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          await page.render({ canvasContext: context, viewport }).promise;
          rendered.push({
            pageNumber,
            dataUrl: canvas.toDataURL('image/jpeg', 0.92),
            width: viewport.width,
            height: viewport.height,
          });
        }

        if (active) setPdfPages(rendered);
      } catch (err) {
        if (active) setError(err.message);
      } finally {
        if (active) setPdfLoading(false);
      }
    }

    loadPdfPreview();
    return () => { active = false; };
  }, [id, sourcePdfName]);

  // Strip API base URL from page image src so we store portable relative paths
  function normalizeImageSrcs(html) {
    return html.replace(
      new RegExp(`src="${BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/api/texts/\\d+/page-image/(page-[\\w-]+\\.\\w+)"`, 'g'),
      (_, filename) => `src="${filename}"`
    );
  }

  async function saveHtml() {
    setSaving(true);
    setError('');
    try {
      // Read latest content from whichever mode is active
      let contentToSave = htmlContent;
      if (!sourceMode && editableRef.current) {
        contentToSave = normalizeImageSrcs(editableRef.current.innerHTML);
      } else if (sourceMode && sourceRef.current) {
        contentToSave = sourceRef.current.value;
      }

      await api.put(`/api/texts/${id}/html`, {
        html_content: contentToSave,
        formula_repair_status: formulaStatus || 'manual_edit',
      });
      setHtmlContent(contentToSave);
      setDirty(false);
      setToast('HTML saved.');
      setTimeout(() => setToast(''), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  function extractFormulaCandidates() {
    return extractFormulaCandidatesFromHtml(htmlContent, text?.name || '');
  }

  async function runFormulaRepair(mode = 'manual') {
    const formulas = extractFormulaCandidates();
    if (!formulas.length) {
      setToast('No unresolved formula placeholders found.');
      setTimeout(() => setToast(''), 3000);
      return;
    }

    setRepairing(true);
    setRepairProgress('');
    setError('');
    try {
      const repairs = await repairFormulasInBatches(id, formulas, (progress) => {
        setRepairProgress(
          progress.totalBatches > 1
            ? `Repairing formulas (${progress.batchNumber}/${progress.totalBatches})...`
            : 'Repairing formulas...'
        );
      });
      const repairedHtml = applyFormulaRepairs(htmlContent, repairs);
      setHtmlContent(repairedHtml);
      setFormulaStatus(repairs.length ? 'completed' : 'attempted');
      await api.put(`/api/texts/${id}/html`, {
        html_content: repairedHtml,
        formula_repair_status: repairs.length ? 'completed' : 'attempted',
      });
      setToast(
        repairs.length
          ? (mode === 'auto' ? 'Background formula repair completed.' : 'Formula repair applied.')
          : 'Formula repair returned no replacements.'
      );
      setTimeout(() => setToast(''), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setRepairing(false);
      setRepairProgress('');
    }
  }

  async function rerunFormulaRepair() {
    await runFormulaRepair('manual');
  }

  useEffect(() => {
    if (!text || !htmlContent || repairing || autoRepairStartedRef.current) return;
    if (!['pending', 'detected', 'attempted'].includes(formulaStatus)) return;
    const formulas = extractFormulaCandidatesFromHtml(htmlContent, text.name || '');
    if (!formulas.length) return;

    autoRepairStartedRef.current = true;
    runFormulaRepair('auto');
  }, [text, htmlContent, formulaStatus, repairing]);

  const [downloading, setDownloading] = useState(false);

  async function downloadHtml() {
    const title = text?.name || 'Document';
    let content = htmlContent;
    if (!sourceMode && editableRef.current) {
      content = normalizeImageSrcs(editableRef.current.innerHTML);
    } else if (sourceMode && sourceRef.current) {
      content = sourceRef.current.value;
    }

    // Collect page image references from the HTML (pages and extracted figures)
    const imageRefs = [...content.matchAll(/src="(page-[\w-]+\.\w+)"/g)].map((m) => m[1]);
    const uniqueImages = [...new Set(imageRefs)];

    if (uniqueImages.length === 0) {
      // No images — download as plain HTML
      const fullHtml = buildDownloadHtml(title, content);
      const blob = new Blob([fullHtml], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${title.replace(/[^a-zA-Z0-9_-]/g, '_')}.html`;
      a.click();
      URL.revokeObjectURL(url);
      return;
    }

    // Download as ZIP with images in an images/ subfolder
    setDownloading(true);
    try {
      const zip = new JSZip();
      const imgFolder = zip.folder('images');

      // Rewrite image paths to images/ subfolder for the download
      const downloadContent = content.replace(
        /src="(page-[\w-]+\.\w+)"/g,
        (_, filename) => `src="images/${filename}"`
      );
      const fullHtml = buildDownloadHtml(title, downloadContent);
      zip.file('index.html', fullHtml);

      // Fetch each page image and add to ZIP
      const fetches = uniqueImages.map(async (filename) => {
        try {
          const res = await fetch(
            `${BASE}/api/texts/${id}/page-image/${filename}`,
            { credentials: 'same-origin' }
          );
          if (res.ok) {
            const blob = await res.blob();
            imgFolder.file(filename, blob);
          }
        } catch {
          // Skip images that can't be fetched
        }
      });
      await Promise.all(fetches);

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${title.replace(/[^a-zA-Z0-9_-]/g, '_')}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError('Download failed: ' + err.message);
    } finally {
      setDownloading(false);
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center items-center min-h-[60vh]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cail-blue"></div>
      </div>
    );
  }

  if (!text) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">Document not found.</div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {toast && (
        <div className="fixed top-20 right-4 z-50 px-4 py-3 rounded-xl bg-green-50 border border-green-200 text-green-700 text-sm shadow-lg">
          {toast}
        </div>
      )}

      <Link to={`/projects/${text.project_id}`} className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-cail-dark mb-6">
        <span>&larr;</span>
        Back to Project
      </Link>

      {error && (
        <div className="mb-6 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
          {error}
        </div>
      )}

      <div className="bg-white rounded-2xl border border-gray-100 p-6 mb-6">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-5">
          <div>
            <div className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-700 mb-3">
              PDF to HTML
            </div>
            <h1 className="font-display font-semibold text-2xl text-cail-dark">{text.name}</h1>
            <p className="text-sm text-gray-500 mt-2">
              Click directly on the text to edit. Use View Source for raw HTML editing. Math renders natively in any modern browser.
            </p>
            {sourcePdfName && (
              <a
                href={`${BASE}/api/texts/${id}/source-pdf/${encodeURIComponent(sourcePdfName)}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 text-sm text-cail-blue hover:text-cail-navy mt-3"
              >
                View source PDF
              </a>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
              Formula repair: {formulaStatus || 'unknown'}
            </span>
            {repairProgress && (
              <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-700">
                {repairProgress}
              </span>
            )}
            <button
              onClick={rerunFormulaRepair}
              disabled={repairing}
              className="px-4 py-2 rounded-full bg-gray-100 text-gray-700 text-sm font-medium hover:bg-gray-200 disabled:opacity-50"
            >
              {repairing ? 'Repairing...' : 'Re-run Formula Repair'}
            </button>
            <button
              onClick={downloadHtml}
              disabled={downloading}
              className="px-4 py-2 rounded-full bg-gray-100 text-gray-700 text-sm font-medium hover:bg-gray-200 disabled:opacity-50"
            >
              {downloading ? 'Packaging...' : 'Download'}
            </button>
            <button
              onClick={saveHtml}
              disabled={saving}
              className={`px-4 py-2 rounded-full text-sm font-medium disabled:opacity-50 ${
                dirty
                  ? 'bg-amber-500 text-white hover:bg-amber-600'
                  : 'bg-cail-blue text-white hover:bg-cail-navy'
              }`}
            >
              {saving ? 'Saving...' : dirty ? 'Save Changes' : 'Save HTML'}
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-6">
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <div className="flex items-center justify-between gap-4 mb-4">
            <h2 className="font-display font-semibold text-lg text-cail-dark">Source PDF</h2>
            {sourcePdfName && (
              <a
                href={`${BASE}/api/texts/${id}/source-pdf/${encodeURIComponent(sourcePdfName)}`}
                target="_blank"
                rel="noreferrer"
                className="text-sm font-medium text-cail-blue hover:text-cail-navy"
              >
                Open in New Tab
              </a>
            )}
          </div>
          <div className="min-h-[75vh] max-h-[75vh] overflow-auto rounded-xl border border-gray-200 bg-gray-50">
            {!sourcePdfName && (
              <div className="min-h-[75vh] flex items-center justify-center text-sm text-gray-500">
                Source PDF unavailable.
              </div>
            )}
            {sourcePdfName && pdfLoading && (
              <div className="min-h-[75vh] flex items-center justify-center text-sm text-gray-500">
                Rendering PDF preview...
              </div>
            )}
            {sourcePdfName && !pdfLoading && pdfPages.length > 0 && (
              <div className="space-y-4 p-4">
                {pdfPages.map((page) => (
                  <figure key={page.pageNumber} className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
                    <div className="px-3 py-2 text-xs font-medium tracking-wide text-gray-500 uppercase border-b border-gray-100">
                      Page {page.pageNumber}
                    </div>
                    <img
                      src={page.dataUrl}
                      alt={`PDF page ${page.pageNumber}`}
                      className="block w-full h-auto"
                    />
                  </figure>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <div className="flex items-center justify-between gap-4 mb-4">
            <h2 className="font-display font-semibold text-lg text-cail-dark">
              {sourceMode ? 'HTML Source' : 'Document'}
            </h2>
            <div className="inline-flex rounded-full bg-gray-100 p-0.5">
              <button
                onClick={() => { if (sourceMode) switchToVisual(); }}
                className={`px-3 py-1 rounded-full text-sm font-medium transition ${
                  !sourceMode ? 'bg-white text-cail-dark shadow-sm' : 'text-gray-500 hover:text-cail-dark'
                }`}
              >
                Visual
              </button>
              <button
                onClick={() => { if (!sourceMode) switchToSource(); }}
                className={`px-3 py-1 rounded-full text-sm font-medium transition ${
                  sourceMode ? 'bg-white text-cail-dark shadow-sm' : 'text-gray-500 hover:text-cail-dark'
                }`}
              >
                Source
              </button>
            </div>
          </div>

          {sourceMode ? (
            <textarea
              ref={sourceRef}
              defaultValue={htmlContent}
              onChange={() => setDirty(true)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                  e.preventDefault();
                  saveHtml();
                }
              }}
              className="w-full min-h-[75vh] max-h-[75vh] overflow-auto rounded-xl border border-gray-200 bg-gray-50 p-4 font-mono text-sm leading-relaxed focus:border-cail-blue focus:ring-2 focus:ring-cail-blue/20 outline-none resize-none"
              spellCheck={false}
            />
          ) : (
            <div className="rounded-xl border border-gray-200 overflow-hidden">
              <FormattingToolbar onDirty={() => setDirty(true)} editableRef={editableRef} />
              <div className="relative">
                <div
                  ref={editableRef}
                  contentEditable
                  suppressContentEditableWarning
                  onInput={handleEditableInput}
                  onKeyDown={(e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                      e.preventDefault();
                      saveHtml();
                    }
                  }}
                  className="pdf-preview-pane min-h-[75vh] max-h-[75vh] overflow-auto bg-white p-6 focus:outline-none"
                  dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
                />
                <ImageResizer editableRef={editableRef} onDirty={() => setDirty(true)} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
