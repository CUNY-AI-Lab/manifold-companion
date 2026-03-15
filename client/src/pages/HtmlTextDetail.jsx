import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import DOMPurify from 'dompurify';
import JSZip from 'jszip';
import katex from 'katex';
import renderMathInElement from 'katex/contrib/auto-render';
import 'katex/dist/katex.min.css';
import { api, BASE } from '../api/client';
import { convertPdfToHtmlWithBedrock } from '../lib/pdfBedrockPipeline';
import VersionHistory from '../components/VersionHistory';
import AnnotationSidebar from '../components/AnnotationSidebar';
import KeyboardShortcuts from '../components/KeyboardShortcuts';
import useUnsavedChanges from '../hooks/useUnsavedChanges';

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

// Math rendering: TeX stored in HTML, rendered client-side with KaTeX, converted to MathML at Manifold export

const DC_FIELDS = [
  { key: 'dc_title', label: 'Title' },
  { key: 'dc_creator', label: 'Creator' },
  { key: 'dc_subject', label: 'Subject' },
  { key: 'dc_description', label: 'Description' },
  { key: 'dc_publisher', label: 'Publisher' },
  { key: 'dc_contributor', label: 'Contributor' },
  { key: 'dc_date', label: 'Date' },
  { key: 'dc_type', label: 'Type' },
  { key: 'dc_format', label: 'Format' },
  { key: 'dc_identifier', label: 'Identifier' },
  { key: 'dc_source', label: 'Source' },
  { key: 'dc_language', label: 'Language' },
  { key: 'dc_relation', label: 'Relation' },
  { key: 'dc_coverage', label: 'Coverage' },
  { key: 'dc_rights', label: 'Rights' },
];

const TABS = ['Review', 'Details'];

// ---------------------------------------------------------------------------
// Image resize overlay — click image to select, drag handles to resize
// ---------------------------------------------------------------------------

function ImageResizer({ editableRef, onDirty }) {
  const [target, setTarget] = useState(null);
  const [rect, setRect] = useState(null);
  const dragging = useRef(null);

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
      <div
        className="absolute pointer-events-none border-2 border-cail-blue rounded-sm z-40"
        style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
      />
      <div
        className="absolute z-50 px-1.5 py-0.5 rounded bg-cail-blue text-white text-[10px] font-medium whitespace-nowrap pointer-events-none"
        style={{ top: rect.top - 22, left: rect.left }}
      >
        {target.getAttribute('width') || Math.round(rect.width)}px
      </div>
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

function TBtn({ onClick, title, children, active, className: extra }) {
  return (
    <button
      type="button"
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      title={title}
      className={`px-2 py-1.5 rounded text-sm font-medium transition hover:bg-gray-100 dark:hover:bg-slate-700 hover:text-cail-dark dark:hover:text-slate-200 ${
        active ? 'bg-cail-blue/10 text-cail-blue' : 'text-gray-600 dark:text-slate-400'
      } ${extra || ''}`}
    >
      {children}
    </button>
  );
}

function Sep() {
  return <div className="w-px h-5 bg-gray-200 dark:bg-slate-600 mx-0.5" />;
}

function getBlockTag() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return 'p';
  let node = sel.anchorNode;
  while (node && node.nodeType !== 1) node = node.parentNode;
  while (node) {
    const tag = node.tagName?.toLowerCase();
    if (['h1', 'h2', 'h3', 'h4', 'blockquote', 'p'].includes(tag)) return tag;
    if (tag === 'section' || tag === 'article' || tag === 'div') return 'p';
    node = node.parentNode;
  }
  return 'p';
}

/**
 * Unwrap selected content from its closest callout container (section with header, aside, blockquote).
 * Moves the inner content out and removes the wrapper.
 */
function unwrapCallout() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  let node = sel.anchorNode;
  while (node && node.nodeType !== 1) node = node.parentNode;
  // Walk up to find the callout container
  while (node) {
    const tag = node.tagName?.toLowerCase();
    if (tag === 'aside' || tag === 'blockquote') break;
    if (tag === 'section' && node.querySelector(':scope > header')) break;
    if (tag === 'article' || tag === 'body') { node = null; break; }
    node = node.parentNode;
  }
  if (!node || !node.parentNode) return;
  // Move all children out before the container, then remove container
  const parent = node.parentNode;
  while (node.firstChild) {
    parent.insertBefore(node.firstChild, node);
  }
  parent.removeChild(node);
}

function FormattingToolbar({ onDirty, editableRef }) {
  const wrap = (fn) => () => { fn(); onDirty(); };
  const [showFind, setShowFind] = useState(false);
  const findRef = useRef(null);
  const replaceRef = useRef(null);
  const [blockTag, setBlockTag] = useState('p');
  const [isBold, setIsBold] = useState(false);
  const [isItalic, setIsItalic] = useState(false);
  const [isUnderline, setIsUnderline] = useState(false);
  const [isStrike, setIsStrike] = useState(false);
  const selectRef = useRef(null);

  useEffect(() => {
    function onSelChange() {
      setBlockTag(getBlockTag());
      setIsBold(document.queryCommandState('bold'));
      setIsItalic(document.queryCommandState('italic'));
      setIsUnderline(document.queryCommandState('underline'));
      setIsStrike(document.queryCommandState('strikeThrough'));
    }
    document.addEventListener('selectionchange', onSelChange);
    return () => document.removeEventListener('selectionchange', onSelChange);
  }, []);

  function doFind() {
    const term = findRef.current?.value;
    if (!term) return;
    window.getSelection().removeAllRanges();
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
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    el.innerHTML = el.innerHTML.replace(new RegExp(`(?<=>)([^<]*?)${escaped}`, 'g'), (match) =>
      match.replace(new RegExp(escaped, 'g'), replacement)
    );
    onDirty();
  }

  return (
    <div className="border-b border-gray-200 dark:border-slate-700 bg-gray-50/80 dark:bg-slate-700/50 rounded-t-xl">
      <div className="flex flex-wrap items-center gap-0.5 px-3 py-1.5">
        {/* Block type */}
        <select
          ref={selectRef}
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(e) => { const v = e.target.value; if (v) { formatBlock(v); setBlockTag(v); onDirty(); } }}
          value={blockTag}
          className="px-2 py-1 rounded border border-gray-200 dark:border-slate-600 text-xs text-gray-700 dark:text-slate-300 bg-white dark:bg-slate-700 hover:border-gray-300 dark:hover:border-slate-500 focus:border-cail-blue outline-none cursor-pointer"
          title="Block type"
        >
          <option value="p">Paragraph</option>
          <option value="h1">Heading 1</option>
          <option value="h2">Heading 2</option>
          <option value="h3">Heading 3</option>
          <option value="h4">Heading 4</option>
          <option value="blockquote">Quote</option>
        </select>

        <Sep />

        <TBtn onClick={wrap(() => execCmd('bold'))} title="Bold (Ctrl+B)" active={isBold}><strong>B</strong></TBtn>
        <TBtn onClick={wrap(() => execCmd('italic'))} title="Italic (Ctrl+I)" active={isItalic}><em>I</em></TBtn>
        <TBtn onClick={wrap(() => execCmd('underline'))} title="Underline (Ctrl+U)" active={isUnderline}><span className="underline">U</span></TBtn>
        <TBtn onClick={wrap(() => execCmd('strikeThrough'))} title="Strikethrough" active={isStrike}><span className="line-through">S</span></TBtn>
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

        {/* Unwrap from callout box */}
        <TBtn onClick={wrap(unwrapCallout)} title="Remove callout box (unwrap from section/aside)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" strokeDasharray="3 2"/><path d="M8 12h8"/><path d="M12 8l4 4-4 4"/></svg>
        </TBtn>

        <TBtn onClick={() => setShowFind(!showFind)} title="Find & Replace (Ctrl+H)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        </TBtn>
      </div>

      {showFind && (
        <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 border-t border-gray-100 dark:border-slate-700 bg-gray-50/50 dark:bg-slate-700/30">
          <input
            ref={findRef}
            type="text"
            placeholder="Find..."
            className="px-2 py-1 text-xs border border-gray-200 dark:border-slate-600 rounded bg-white dark:bg-slate-700 dark:text-slate-200 w-36 focus:border-cail-blue focus:ring-1 focus:ring-cail-blue/20 outline-none"
            onKeyDown={(e) => { if (e.key === 'Enter') doFind(); }}
          />
          <button onClick={doFind} className="px-2 py-1 text-xs rounded bg-gray-200 dark:bg-slate-600 text-gray-700 dark:text-slate-300 hover:bg-gray-300 dark:hover:bg-slate-600">Find</button>
          <input
            ref={replaceRef}
            type="text"
            placeholder="Replace..."
            className="px-2 py-1 text-xs border border-gray-200 dark:border-slate-600 rounded bg-white dark:bg-slate-700 dark:text-slate-200 w-36 focus:border-cail-blue focus:ring-1 focus:ring-cail-blue/20 outline-none"
            onKeyDown={(e) => { if (e.key === 'Enter') doReplace(); }}
          />
          <button onClick={doReplace} className="px-2 py-1 text-xs rounded bg-gray-200 dark:bg-slate-600 text-gray-700 dark:text-slate-300 hover:bg-gray-300 dark:hover:bg-slate-600">Replace</button>
          <button onClick={doReplaceAll} className="px-2 py-1 text-xs rounded bg-gray-200 dark:bg-slate-600 text-gray-700 dark:text-slate-300 hover:bg-gray-300 dark:hover:bg-slate-600">All</button>
          <button onClick={() => setShowFind(false)} className="px-1.5 py-1 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 dark:text-slate-400">x</button>
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
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.css" crossorigin="anonymous">
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.js" crossorigin="anonymous"><\/script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/contrib/auto-render.min.js" crossorigin="anonymous"
  onload="renderMathInElement(document.body,{delimiters:[{left:'\\\\[',right:'\\\\]',display:true},{left:'\\\\(',right:'\\\\)',display:false}],throwOnError:false});"><\/script>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; max-width: 52rem; margin: 2rem auto; padding: 0 1.5rem; line-height: 1.75; color: #1a1a1a; }
  h1 { font-size: 1.7rem; font-weight: 700; margin: 1.5rem 0 0.75rem; border-bottom: 2px solid #c7d2de; padding-bottom: 0.5rem; color: #1e293b; }
  h2 { font-size: 1.35rem; font-weight: 600; margin: 1.75rem 0 0.5rem; color: #1e3a5f; }
  h3 { font-size: 1.1rem; font-weight: 600; margin: 1.25rem 0 0.4rem; color: #334155; }
  h4 { font-size: 1rem; font-weight: 600; margin: 1rem 0 0.35rem; color: #475569; }
  p { margin: 0.5rem 0; }
  section[data-page] { margin-bottom: 2rem; padding-bottom: 1.5rem; border-bottom: 1px solid #e2e8f0; }
  section[data-page] > section:has(> header) { margin: 1.25rem 0; padding: 1rem 1.25rem; background: linear-gradient(135deg, #fefce8 0%, #fef9c3 100%); border-radius: 0.625rem; border: 1px solid #fde68a; }
  section[data-page] > section:not(:has(> header)) { margin: 1rem 0; }
  section[data-page] > section > header,
  section[data-page] > section > h3:first-child,
  section[data-page] > section > h4:first-child { font-weight: 700; font-size: 0.95rem; text-transform: uppercase; letter-spacing: 0.03em; color: #92400e; margin: 0 0 0.5rem; padding-bottom: 0.35rem; border-bottom: 1px solid #fcd34d; }
  section[data-page] > section:has(> header) > section { margin: 0.75rem 0; padding: 0.75rem 1rem; background: rgba(255,255,255,0.6); border-radius: 0.5rem; border: 1px solid #fde68a; }
  aside { margin: 1.25rem 0; padding: 1rem 1.25rem; background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%); border-radius: 0.625rem; border: 1px solid #93c5fd; border-left: 4px solid #3b82f6; }
  aside > h2:first-child, aside > h3:first-child, aside > h4:first-child { font-size: 0.95rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; color: #1e40af; margin: 0 0 0.5rem; padding-bottom: 0.35rem; border-bottom: 1px solid #93c5fd; }
  blockquote { margin: 1.25rem 0; padding: 1rem 1.25rem; background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%); border-radius: 0.625rem; border: 1px solid #86efac; border-left: 4px solid #22c55e; color: #14532d; }
  blockquote > h2:first-child, blockquote > h3:first-child, blockquote > h4:first-child { font-size: 0.95rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; color: #166534; margin: 0 0 0.5rem; padding-bottom: 0.35rem; border-bottom: 1px solid #86efac; }
  body > header, section[data-page] > header { margin-bottom: 0.75rem; }
  footer { margin-top: 1.5rem; padding-top: 0.75rem; border-top: 1px solid #e2e8f0; font-size: 0.85rem; color: #64748b; font-style: italic; }
  nav { margin: 0.5rem 0 1rem; }
  nav ul { list-style: none; padding: 0; margin: 0; }
  nav li { padding: 0.2rem 0; color: #475569; }
  .toc-entry { display: flex; justify-content: space-between; gap: 1rem; padding: 0.25rem 0; }
  .toc-entry__title { flex: 1; }
  .toc-entry__page { color: #6b7280; white-space: nowrap; }
  ul, ol { margin: 0.5rem 0; padding-left: 1.75rem; }
  li { margin: 0.25rem 0; }
  ol[type="a"] { list-style-type: lower-alpha; }
  ol[type="A"] { list-style-type: upper-alpha; }
  ol[type="i"] { list-style-type: lower-roman; }
  table { border-collapse: collapse; margin: 1rem 0; width: 100%; font-size: 0.95rem; }
  th, td { border: 1px solid #cbd5e1; padding: 0.5rem 0.75rem; text-align: left; }
  th { background: #f1f5f9; font-weight: 600; color: #334155; }
  tbody tr:nth-child(even) { background: #f8fafc; }
  table.equation-table { border: none; margin: 0.5rem 0; }
  table.equation-table td { border: none; padding: 0.25rem 0.5rem; vertical-align: middle; background: transparent; }
  table.equation-table td:last-child { text-align: right; color: #6b7280; white-space: nowrap; }
  figure { margin: 1.5rem 0; text-align: center; padding: 1rem; background: #fafafa; border-radius: 0.5rem; border: 1px dashed #d1d5db; }
  figure img { max-width: 100%; height: auto; border-radius: 0.375rem; }
  figcaption { font-style: italic; color: #6b7280; margin-top: 0.5rem; font-size: 0.9rem; }
  .formula-block { margin: 1rem 0; padding: 0.75rem 1rem; background: #f8f9fa; border-radius: 0.5rem; border: 1px solid #e9ecef; }
  a { color: #2563eb; text-decoration: underline; text-underline-offset: 2px; }
  a:hover { color: #1d4ed8; }
  strong { font-weight: 700; }
  em { font-style: italic; }
  sup, sub { font-size: 0.75em; line-height: 0; }
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

// KaTeX auto-render options
const KATEX_OPTIONS = {
  delimiters: [
    { left: '\\[', right: '\\]', display: true },
    { left: '\\(', right: '\\)', display: false },
  ],
  throwOnError: false,
  trust: true,
  strict: false,
};

function renderTexInElement(el) {
  if (!el) return;
  renderMathInElement(el, KATEX_OPTIONS);
  el.querySelectorAll('.katex-display, .katex').forEach((span) => {
    const wrapper = span.closest('[data-katex-wrapper]');
    if (!wrapper) {
      const parent = span.parentNode;
      if (parent && !parent.hasAttribute('data-katex-wrapper')) {
        const w = document.createElement('span');
        w.setAttribute('data-katex-wrapper', 'true');
        w.setAttribute('contenteditable', 'false');
        w.style.cursor = 'default';
        parent.insertBefore(w, span);
        w.appendChild(span);
      }
    }
  });
}

function extractTexFromKatex(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  div.querySelectorAll('.katex-display').forEach((el) => {
    const annotation = el.querySelector('annotation[encoding="application/x-tex"]');
    if (annotation) {
      const tex = annotation.textContent;
      const wrapper = el.closest('[data-katex-wrapper]') || el;
      wrapper.replaceWith(document.createTextNode(`\\[${tex}\\]`));
    }
  });
  div.querySelectorAll('.katex').forEach((el) => {
    const annotation = el.querySelector('annotation[encoding="application/x-tex"]');
    if (annotation) {
      const tex = annotation.textContent;
      const wrapper = el.closest('[data-katex-wrapper]') || el;
      wrapper.replaceWith(document.createTextNode(`\\(${tex}\\)`));
    }
  });
  return div.innerHTML;
}

/**
 * Add anchor IDs to headings and link TOC entries to their corresponding sections.
 */
function linkTocEntries(html) {
  const div = document.createElement('div');
  div.innerHTML = html;

  // Build a map of heading text → ID
  const headingMap = new Map();
  div.querySelectorAll('h1, h2, h3, h4').forEach((heading) => {
    const text = heading.textContent.trim();
    if (!text) return;
    const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 80);
    if (!slug) return;
    // Avoid duplicates
    let id = slug;
    let counter = 2;
    while (headingMap.has(id)) { id = `${slug}-${counter++}`; }
    heading.id = id;
    headingMap.set(id, text);
  });

  // Find TOC entries and try to link them
  div.querySelectorAll('.toc-entry__title').forEach((titleEl) => {
    const titleText = titleEl.textContent.trim();
    if (!titleText || titleEl.querySelector('a')) return; // already linked

    // Try to find a matching heading by normalized text comparison
    let bestId = null;
    const normalizedTitle = titleText.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    div.querySelectorAll('h1[id], h2[id], h3[id], h4[id]').forEach((h) => {
      if (bestId) return;
      const normalizedHeading = h.textContent.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      // Match if one contains the other or they share significant overlap
      if (normalizedHeading === normalizedTitle ||
          normalizedHeading.includes(normalizedTitle) ||
          normalizedTitle.includes(normalizedHeading)) {
        bestId = h.id;
      }
    });

    if (bestId) {
      const link = document.createElement('a');
      link.href = `#${bestId}`;
      link.textContent = titleText;
      titleEl.textContent = '';
      titleEl.appendChild(link);
    }
  });

  return div.innerHTML;
}

export default function HtmlTextDetail() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const editableRef = useRef(null);
  const sourceRef = useRef(null);
  const [text, setText] = useState(null);
  const [htmlContent, setHtmlContent] = useState('');
  const [sourcePdfName, setSourcePdfName] = useState('');
  const [pdfPages, setPdfPages] = useState([]);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfZoom, setPdfZoom] = useState(1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reprocessing, setReprocessing] = useState(false);
  const [reprocessProgress, setReprocessProgress] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [sourceMode, setSourceMode] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [activeTab, setActiveTab] = useState(() => {
    const tab = searchParams.get('tab');
    return TABS.includes(tab) ? tab : 'Review';
  });
  const [role, setRole] = useState('viewer');
  const [showVersions, setShowVersions] = useState(false);
  const [showAnnotations, setShowAnnotations] = useState(() => searchParams.get('annotations') === '1');
  const [showShortcuts, setShowShortcuts] = useState(false);

  const getContentForDraft = useCallback(() => {
    if (!sourceMode && editableRef.current) {
      return extractTexFromKatex(normalizeImageSrcs(editableRef.current.innerHTML));
    } else if (sourceMode && sourceRef.current) {
      return sourceRef.current.value;
    }
    return htmlContent;
  }, [sourceMode, htmlContent]);

  const { isDirty: hasUnsaved, draftBanner, dismissDraft, restoreDraft, markSaved } = useUnsavedChanges(
    text ? `mc-draft-${id}-html` : null,
    htmlContent,
    text?.updated_at,
    { enabled: activeTab === 'Review', isDirtyOverride: dirty, getContent: getContentForDraft }
  );

  // Details tab state
  const [summary, setSummary] = useState('');
  const [metadata, setMetadata] = useState({});
  const [savingSummary, setSavingSummary] = useState(false);
  const [generatingSummary, setGeneratingSummary] = useState(false);
  const [savingMetadata, setSavingMetadata] = useState(false);

  // Render TeX with KaTeX after content loads
  const katexRenderedRef = useRef('');

  const loadText = useCallback(async () => {
    try {
      const [textData, htmlData, summaryData, metaData] = await Promise.all([
        api.get(`/api/texts/${id}`),
        api.get(`/api/texts/${id}/html`),
        api.get(`/api/texts/${id}/summary`).catch(() => ({ summary: '' })),
        api.get(`/api/texts/${id}/metadata`).catch(() => ({})),
      ]);
      setText(textData);
      setRole(textData.role || 'viewer');
      setHtmlContent(htmlData.html_content || '');
      setSourcePdfName(htmlData.source_pdf_name || '');
      setSummary(summaryData.summary || '');
      setMetadata(metaData || {});
      katexRenderedRef.current = '';
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadText();
  }, [loadText]);

  const sanitizedHtml = useMemo(() => {
    let html = DOMPurify.sanitize(htmlContent, SANITIZE_CONFIG);
    html = html.replace(
      /src="(page-[\w-]+\.\w+)"/g,
      (_, filename) => `src="${BASE}/api/texts/${id}/page-image/${filename}"`
    );
    // Add TOC links
    html = linkTocEntries(html);
    return html;
  }, [htmlContent, id]);

  // Mark broken images
  useEffect(() => {
    const el = editableRef.current;
    if (!el) return;
    const handler = (e) => {
      if (e.target.tagName === 'IMG') e.target.classList.add('img-error');
    };
    el.addEventListener('error', handler, true);
    return () => el.removeEventListener('error', handler, true);
  });

  useEffect(() => {
    const el = editableRef.current;
    if (!el || sourceMode || activeTab !== 'Review') return;
    if (katexRenderedRef.current === sanitizedHtml) return;
    katexRenderedRef.current = sanitizedHtml;
    const timer = setTimeout(() => renderTexInElement(el), 50);
    return () => clearTimeout(timer);
  }, [sanitizedHtml, sourceMode, activeTab]);

  function switchToVisual() {
    if (sourceRef.current) {
      const newHtml = sourceRef.current.value;
      setHtmlContent(newHtml);
      katexRenderedRef.current = '';
      setDirty(true);
    }
    setSourceMode(false);
  }

  function switchToSource() {
    if (editableRef.current) {
      setHtmlContent(extractTexFromKatex(normalizeImageSrcs(editableRef.current.innerHTML)));
    }
    setSourceMode(true);
  }

  function handleEditableInput() {
    setDirty(true);
  }

  function getEditableContent() {
    if (!sourceMode && editableRef.current) {
      return extractTexFromKatex(normalizeImageSrcs(editableRef.current.innerHTML));
    } else if (sourceMode && sourceRef.current) {
      return sourceRef.current.value;
    }
    return htmlContent;
  }

  // PDF preview loading
  useEffect(() => {
    let active = true;

    async function loadPdfPreview() {
      if (!sourcePdfName) { setPdfPages([]); return; }
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

  // Global ? shortcut for keyboard shortcuts overlay
  useEffect(() => {
    function handleShortcutKey(e) {
      if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT' || e.target.isContentEditable) return;
      if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setShowShortcuts((s) => !s);
      }
    }
    window.addEventListener('keydown', handleShortcutKey);
    return () => window.removeEventListener('keydown', handleShortcutKey);
  }, []);

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
      const contentToSave = getEditableContent();
      await api.put(`/api/texts/${id}/html`, { html_content: contentToSave });
      setHtmlContent(contentToSave);
      setDirty(false);
      markSaved(contentToSave);
      setToast('HTML saved.');
      setTimeout(() => setToast(''), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function reprocessPdf() {
    if (!sourcePdfName || reprocessing) return;
    if (!confirm('Re-run the full PDF extraction pipeline? This will replace the current HTML.')) return;
    setReprocessing(true);
    setReprocessProgress('Fetching source PDF...');
    try {
      const res = await fetch(`${BASE}/api/texts/${id}/source-pdf/${encodeURIComponent(sourcePdfName)}`, {
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error('Failed to fetch source PDF');
      const blob = await res.blob();
      const file = new File([blob], sourcePdfName, { type: 'application/pdf' });

      const result = await convertPdfToHtmlWithBedrock(id, file, ({ stage, pageNumber, totalPages }) => {
        if (stage === 'render') setReprocessProgress(`Extracting page ${pageNumber}/${totalPages}...`);
        else if (stage === 'parse') setReprocessProgress(`Parsing page ${pageNumber}/${totalPages}...`);
        else if (stage === 'cleanup') setReprocessProgress('Running cleanup...');
      });

      await api.put(`/api/texts/${id}/html`, {
        html_content: result.html,
        pdf_meta: JSON.stringify(result.meta),
      });

      setHtmlContent(result.html);
      katexRenderedRef.current = '';
      setDirty(false);
      markSaved(result.html);
      setToast('PDF reprocessed successfully.');
      setTimeout(() => setToast(''), 3000);
    } catch (err) {
      setError(`Reprocess failed: ${err.message}`);
    } finally {
      setReprocessing(false);
      setReprocessProgress('');
    }
  }

  // --- Details tab functions ---

  async function handleGenerateSummary() {
    setGeneratingSummary(true);
    setError('');
    try {
      const data = await api.post(`/api/texts/${id}/summary`);
      setSummary(data.summary || '');
      setToast('Summary generated.');
      setTimeout(() => setToast(''), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setGeneratingSummary(false);
    }
  }

  async function saveSummary() {
    setSavingSummary(true);
    setError('');
    try {
      await api.put(`/api/texts/${id}/summary`, { summary });
      setToast('Summary saved.');
      setTimeout(() => setToast(''), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingSummary(false);
    }
  }

  async function saveMetadata() {
    setSavingMetadata(true);
    setError('');
    try {
      await api.post(`/api/texts/${id}/metadata`, metadata);
      setToast('Metadata saved.');
      setTimeout(() => setToast(''), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingMetadata(false);
    }
  }

  const [downloading, setDownloading] = useState(false);

  async function downloadHtml() {
    const title = text?.name || 'Document';
    const content = getEditableContent();

    const imageRefs = [...content.matchAll(/src="(page-[\w-]+\.\w+)"/g)].map((m) => m[1]);
    const uniqueImages = [...new Set(imageRefs)];

    if (uniqueImages.length === 0) {
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

    setDownloading(true);
    try {
      const zip = new JSZip();
      const imgFolder = zip.folder('images');
      const downloadContent = content.replace(
        /src="(page-[\w-]+\.\w+)"/g,
        (_, filename) => `src="images/${filename}"`
      );
      const fullHtml = buildDownloadHtml(title, downloadContent);
      zip.file('index.html', fullHtml);
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
        } catch { /* skip */ }
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

      <Link to={`/projects/${text.project_id}`} className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-cail-dark dark:hover:text-slate-200 mb-4 group">
        <svg className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" /></svg>
        Back to Project
      </Link>

      <h1 className="font-display font-semibold text-2xl text-cail-dark mb-4">{text.name}</h1>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
          {error}
          <button onClick={() => setError('')} className="ml-3 text-red-400 hover:text-red-600">&times;</button>
        </div>
      )}

      {/* Tab bar */}
      <div className="border-b border-gray-200 dark:border-slate-700 mb-4">
        <nav className="flex gap-1 -mb-px overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => {
                if (dirty && activeTab === 'Review' && tab !== 'Review') {
                  if (!window.confirm('You have unsaved changes. Switch tabs anyway?')) return;
                  setDirty(false);
                }
                setActiveTab(tab);
              }}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === tab
                  ? 'border-cail-blue text-cail-blue'
                  : 'border-transparent text-gray-500 hover:text-cail-dark dark:hover:text-slate-200 hover:border-gray-300 dark:border-slate-600'
              }`}
            >
              {tab}
            </button>
          ))}
        </nav>
      </div>

      {/* ======================== REVIEW TAB ======================== */}
      {activeTab === 'Review' && (
        <div>
          {draftBanner && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-4 flex items-center justify-between">
              <span className="text-sm text-amber-800">
                Unsaved draft found from {new Date(draftBanner.savedAt).toLocaleString()}.
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => { const content = restoreDraft(); if (content) setHtmlContent(content); }}
                  className="text-sm font-medium text-amber-700 hover:text-amber-900"
                >
                  Restore
                </button>
                <button onClick={dismissDraft} className="text-sm text-gray-500 hover:text-gray-700 dark:text-slate-300">
                  Dismiss
                </button>
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3 mb-4">
            {role === 'viewer' && (
              <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400">
                Read-only
              </span>
            )}
            {sourcePdfName && (
              <a
                href={`${BASE}/api/texts/${id}/source-pdf/${encodeURIComponent(sourcePdfName)}`}
                target="_blank"
                rel="noreferrer"
                className="px-4 py-2 rounded-full bg-gray-100 text-gray-700 text-sm font-medium hover:bg-gray-200 dark:hover:bg-slate-600"
              >
                View Source PDF
              </a>
            )}
            {reprocessProgress && (
              <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-700">
                {reprocessProgress}
              </span>
            )}
            {sourcePdfName && role !== 'viewer' && (
              <button
                onClick={reprocessPdf}
                disabled={reprocessing}
                className="px-4 py-2 rounded-full bg-gray-100 text-gray-700 text-sm font-medium hover:bg-gray-200 dark:hover:bg-slate-600 disabled:opacity-50"
              >
                {reprocessing ? 'Reprocessing...' : 'Reprocess PDF'}
              </button>
            )}
            <button
              onClick={downloadHtml}
              disabled={downloading}
              className="px-4 py-2 rounded-full bg-gray-100 text-gray-700 text-sm font-medium hover:bg-gray-200 dark:hover:bg-slate-600 disabled:opacity-50"
            >
              {downloading ? 'Packaging...' : 'Download'}
            </button>
            {role !== 'viewer' && (
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
            )}
            <button onClick={() => setShowShortcuts(true)} className="w-7 h-7 rounded-full text-xs font-bold text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors" title="Keyboard shortcuts (?)">
              ?
            </button>
            <button
              onClick={() => setShowVersions(true)}
              className="px-3 py-1.5 rounded-full text-xs font-medium text-gray-600 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"
            >
              History
            </button>
            <button
              onClick={() => setShowAnnotations(true)}
              className="px-3 py-1.5 rounded-full text-xs font-medium text-gray-600 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"
            >
              Comments
            </button>
          </div>
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-6">
          {/* Source PDF pane */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-700 p-5">
            <div className="flex items-center justify-between gap-4 mb-4">
              <h2 className="font-display font-semibold text-lg text-cail-dark dark:text-slate-200">Source PDF</h2>
              <div className="flex items-center gap-2">
                {sourcePdfName && (
                  <>
                    <button
                      onClick={() => setPdfZoom((z) => Math.max(0.5, z - 0.25))}
                      className="w-7 h-7 flex items-center justify-center rounded-full text-sm font-bold text-gray-500 hover:bg-gray-100 dark:hover:bg-slate-700"
                      title="Zoom out"
                    >
                      -
                    </button>
                    <button
                      onClick={() => setPdfZoom(1)}
                      className="px-2 py-0.5 rounded text-xs font-medium text-gray-500 hover:bg-gray-100 dark:hover:bg-slate-700 tabular-nums"
                      title="Reset zoom"
                    >
                      {Math.round(pdfZoom * 100)}%
                    </button>
                    <button
                      onClick={() => setPdfZoom((z) => Math.min(3, z + 0.25))}
                      className="w-7 h-7 flex items-center justify-center rounded-full text-sm font-bold text-gray-500 hover:bg-gray-100 dark:hover:bg-slate-700"
                      title="Zoom in"
                    >
                      +
                    </button>
                    <a
                      href={`${BASE}/api/texts/${id}/source-pdf/${encodeURIComponent(sourcePdfName)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm font-medium text-cail-blue hover:text-cail-navy ml-2"
                    >
                      Open in New Tab
                    </a>
                  </>
                )}
              </div>
            </div>
            <div className="min-h-[40vh] max-h-[50vh] lg:min-h-[75vh] lg:max-h-[75vh] overflow-auto rounded-xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-900">
              {!sourcePdfName && (
                <div className="min-h-[40vh] lg:min-h-[75vh] flex items-center justify-center text-sm text-gray-500 dark:text-slate-400">
                  Source PDF unavailable.
                </div>
              )}
              {sourcePdfName && pdfLoading && (
                <div className="min-h-[40vh] lg:min-h-[75vh] flex items-center justify-center text-sm text-gray-500 dark:text-slate-400">
                  Rendering PDF preview...
                </div>
              )}
              {sourcePdfName && !pdfLoading && pdfPages.length > 0 && (
                <div className="p-4" style={{ minWidth: pdfZoom > 1 ? `${pdfZoom * 100}%` : undefined }}>
                  <div className="space-y-4">
                    {pdfPages.map((page) => (
                      <figure key={page.pageNumber} className="bg-white rounded-lg shadow-sm border border-gray-200 dark:border-slate-700">
                        <div className="px-3 py-2 text-xs font-medium tracking-wide text-gray-500 uppercase border-b border-gray-100 sticky top-0 bg-white z-10">
                          Page {page.pageNumber}
                        </div>
                        <img
                          src={page.dataUrl}
                          alt={`PDF page ${page.pageNumber}`}
                          className="block h-auto w-full"
                        />
                      </figure>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Editor pane */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-700 p-5">
            <div className="flex items-center justify-between gap-4 mb-4">
              <h2 className="font-display font-semibold text-lg text-cail-dark dark:text-slate-200">
                {sourceMode ? 'HTML Source' : 'Document'}
              </h2>
              <div className="inline-flex rounded-full bg-gray-100 dark:bg-slate-700 p-0.5">
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
                readOnly={role === 'viewer'}
                onChange={() => setDirty(true)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                    e.preventDefault();
                    saveHtml();
                  }
                }}
                className="w-full min-h-[40vh] max-h-[50vh] lg:min-h-[75vh] lg:max-h-[75vh] overflow-auto rounded-xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-900 p-4 font-mono text-sm leading-relaxed focus:border-cail-blue focus:ring-2 focus:ring-cail-blue/20 outline-none resize-none"
                spellCheck={false}
              />
            ) : (
              <div className="rounded-xl border border-gray-200 dark:border-slate-700 overflow-hidden">
                {role !== 'viewer' && <FormattingToolbar onDirty={() => setDirty(true)} editableRef={editableRef} />}
                <div className="relative">
                  <div
                    ref={editableRef}
                    contentEditable={role !== 'viewer'}
                    suppressContentEditableWarning
                    onInput={handleEditableInput}
                    onKeyDown={(e) => {
                      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                        e.preventDefault();
                        saveHtml();
                      }
                    }}
                    className="pdf-preview-pane min-h-[40vh] max-h-[50vh] lg:min-h-[75vh] lg:max-h-[75vh] overflow-auto bg-white dark:bg-slate-800 p-4 sm:p-6 focus:outline-none"
                    dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
                  />
                  <ImageResizer editableRef={editableRef} onDirty={() => setDirty(true)} />
                </div>
              </div>
            )}
          </div>
        </div>
        </div>
      )}

      {/* ======================== DETAILS TAB ======================== */}
      {activeTab === 'Details' && (
        <div className="space-y-8">
          {/* Summary */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-700 p-6">
            <h3 className="font-display font-semibold text-lg text-cail-dark mb-4">Summary</h3>
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              rows={4}
              className="w-full rounded-xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-900 p-4 text-sm leading-relaxed focus:border-cail-blue focus:ring-2 focus:ring-cail-blue/20 outline-none resize-y"
              placeholder="Add a summary for this document..."
            />
            <div className="flex items-center gap-3 mt-3">
              <button
                onClick={handleGenerateSummary}
                disabled={generatingSummary}
                className="px-4 py-2 rounded-full bg-cail-teal text-white text-sm font-medium hover:bg-cail-azure disabled:opacity-50"
              >
                {generatingSummary ? 'Generating...' : 'Generate with AI'}
              </button>
              <button
                onClick={saveSummary}
                disabled={savingSummary}
                className="px-4 py-2 rounded-full bg-cail-blue text-white text-sm font-medium hover:bg-cail-navy disabled:opacity-50"
              >
                {savingSummary ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>

          {/* Dublin Core Metadata */}
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-100 dark:border-slate-700 p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display font-semibold text-lg text-cail-dark dark:text-slate-200">Dublin Core Metadata</h3>
              <button
                onClick={saveMetadata}
                disabled={savingMetadata}
                className="px-4 py-2 rounded-full bg-cail-blue text-white text-sm font-medium hover:bg-cail-navy disabled:opacity-50"
              >
                {savingMetadata ? 'Saving...' : 'Save Metadata'}
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {DC_FIELDS.map((field) => (
                <div key={field.key}>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{field.label}</label>
                  <input
                    type="text"
                    value={metadata[field.key] || ''}
                    onChange={(e) => setMetadata((prev) => ({ ...prev, [field.key]: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-slate-700 text-sm focus:border-cail-blue focus:ring-2 focus:ring-cail-blue/20 outline-none"
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <VersionHistory textId={text?.id} contentType="html" open={showVersions} onClose={() => setShowVersions(false)} onRevert={() => loadText()} />
      <AnnotationSidebar textId={text?.id} open={showAnnotations} onClose={() => setShowAnnotations(false)} role={role} />
      {showShortcuts && (
        <KeyboardShortcuts
          onClose={() => setShowShortcuts(false)}
          shortcuts={{
            'HTML Editor': [
              { keys: ['\u2318S', 'Ctrl+S'], desc: 'Save HTML' },
              { keys: ['\u2318B'], desc: 'Bold' },
              { keys: ['\u2318I'], desc: 'Italic' },
              { keys: ['\u2318U'], desc: 'Underline' },
            ],
            'General': [
              { keys: ['Esc'], desc: 'Close modal / sidebar' },
              { keys: ['?'], desc: 'Show keyboard shortcuts' },
            ],
          }}
        />
      )}
    </div>
  );
}
