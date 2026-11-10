// Stored HTML <-> the visual editor's document.
//
//   parse:      sanitize (the Worker's own sanitizer) -> an INERT document
//               (DOMParser: nothing in it runs or loads, and it is never part of
//               the app page) -> TeX in text becomes <mc-math> markers, inline
//               runs directly inside containers become bare paragraphs ->
//               ProseMirror's parser with the allowlisted schema.
//   serialize:  the document -> HTML in the stored form (TeX back in \( \) and
//               \[ \], bare paragraphs unwrapped, rows regrouped) -> sanitize.
//   openDocument: the fidelity gate. A document opens in the visual editor
//               only if serializing what was parsed gives back the same HTML,
//               compared after the whitespace HTML itself ignores is
//               normalised (canonicalHtml). Anything the schema cannot hold
//               (MathML, a definition list, a link to a page anchor, an image
//               that is not one of this text's figures, ...) makes the two
//               differ, and the document opens in the source view instead, so
//               nothing is ever dropped by the editor.
import { DOMParser as PMDOMParser } from 'prosemirror-model';
import { sanitizeHtml } from '../../../../src/sanitize/html.ts';
import { LEGACY_DELIMITERS, splitAtDelimiters } from '../math.js';
import { BLOCK_CONTAINERS, INLINE_TAGS, schema, withAllowedImages } from './schema.js';

const NO_MATH = new Set(['PRE', 'CODE', 'SCRIPT', 'STYLE', 'TEXTAREA', 'OPTION', 'NOSCRIPT']);
const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'SECTION', 'ARTICLE', 'ASIDE', 'HEADER', 'FOOTER', 'NAV', 'MAIN', 'DIV', 'UL', 'OL', 'LI', 'PRE', 'HR', 'FIGURE', 'FIGCAPTION', 'TABLE', 'CAPTION', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'DL', 'DT', 'DD', 'DETAILS', 'SUMMARY', 'COLGROUP', 'COL', 'BODY', 'MATH']);

/** An inert HTML document for `html` (DOMParser: scripts never run, nothing loads). */
export function inertBody(html) {
  return new globalThis.DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html').body;
}

function mathMarkers(root) {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, 4 /* SHOW_TEXT */);
  const texts = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n);
  for (const t of texts) {
    let skip = false;
    for (let p = t.parentNode; p && p !== root; p = p.parentNode) if (NO_MATH.has(p.nodeName) || p.namespaceURI === 'http://www.w3.org/1998/Math/MathML') { skip = true; break; }
    if (skip || !/\\[([]/.test(t.nodeValue)) continue;
    const parts = splitAtDelimiters(t.nodeValue, LEGACY_DELIMITERS);
    if (!parts.some((p) => p.type === 'math')) continue;
    const frag = doc.createDocumentFragment();
    for (const p of parts) {
      if (p.type === 'text') frag.appendChild(doc.createTextNode(p.data));
      else {
        const m = doc.createElement('mc-math');
        m.setAttribute('data-tex', p.data);
        m.setAttribute('data-display', String(p.display));
        frag.appendChild(m);
      }
    }
    t.parentNode.replaceChild(frag, t);
  }
}

const isInline = (n) => n.nodeType === 3 || (n.nodeType === 1 && INLINE_TAGS.has(n.nodeName.toLowerCase()));
const blank = (n) => n.nodeType === 3 && !/[^ \t\r\n\f]/.test(n.nodeValue);

/** Inline content written straight into a container becomes a <p data-mc-bare>; an empty container gets an empty one. */
function bareParagraphs(root) {
  const containers = [root, ...root.querySelectorAll([...BLOCK_CONTAINERS].join(','))];
  for (const el of containers) {
    const kids = [...el.childNodes];
    if (!kids.some((k) => isInline(k) && !blank(k)) && kids.some((k) => !isInline(k))) continue; // blocks only (whitespace between them is ignored)
    let run = [];
    const flush = (before) => {
      if (run.length && run.some((k) => !blank(k))) {
        const p = el.ownerDocument.createElement('p');
        p.setAttribute('data-mc-bare', '');
        el.insertBefore(p, before);
        for (const k of run) p.appendChild(k);
      }
      run = [];
    };
    for (const k of kids) {
      if (isInline(k)) run.push(k);
      else flush(k);
    }
    flush(null);
    // An empty container (or an empty document) holds one empty bare paragraph: somewhere to type, written back as nothing.
    if (![...el.childNodes].some((k) => k.nodeType === 1)) {
      const p = el.ownerDocument.createElement('p');
      p.setAttribute('data-mc-bare', '');
      el.appendChild(p);
    }
  }
}

/** The editor document for stored HTML. `figures`: the file names of this text's stored figures (the only images it may show). */
export function parseHtml(html, { figures = [] } = {}) {
  const body = inertBody(sanitizeHtml(html ?? ''));
  mathMarkers(body);
  bareParagraphs(body);
  return withAllowedImages(new Set(figures), () => PMDOMParser.fromSchema(schema).parse(body));
}

/** The same preparation for pasted HTML: sanitized, TeX found, as HTML for ProseMirror's clipboard parser. */
export function preparePastedHtml(html) {
  const body = inertBody(sanitizeHtml(html ?? ''));
  mathMarkers(body);
  bareParagraphs(body);
  return body.innerHTML;
}

// ---- serialize --------------------------------------------------------------

const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function attrs(list) {
  let out = '';
  for (const [k, v] of list) {
    if (v === null || v === undefined || v === false) continue;
    out += v === true ? ` ${k}` : ` ${k}="${escAttr(v)}"`;
  }
  return out;
}
const gAttrs = (g) => (g ? Object.entries(g) : []);

const MARK_TAG = { link: 'a' };
function markOpen(m) {
  const tag = MARK_TAG[m.type.name] ?? m.type.name;
  const extra = m.type.name === 'link' ? [['href', m.attrs.href], ['hreflang', m.attrs.hreflang]] : m.type.name === 'q' ? [['cite', m.attrs.cite]] : [];
  return `<${tag}${attrs([...gAttrs(m.attrs.g), ...extra])}>`;
}
const markClose = (m) => `</${MARK_TAG[m.type.name] ?? m.type.name}>`;

function inlineContent(node) {
  let out = '';
  let open = [];
  const closeTo = (keep) => { while (open.length > keep) out += markClose(open.pop()); };
  node.forEach((child) => {
    const marks = child.marks;
    let keep = 0;
    while (keep < open.length && keep < marks.length && open[keep].eq(marks[keep])) keep += 1;
    closeTo(keep);
    for (let i = keep; i < marks.length; i += 1) { out += markOpen(marks[i]); open.push(marks[i]); }
    out += inlineNode(child);
  });
  closeTo(0);
  return out;
}

function inlineNode(n) {
  switch (n.type.name) {
    case 'text': return escText(n.text);
    case 'hard_break': return `<br${attrs(gAttrs(n.attrs.g))}>`;
    case 'image': return img(n);
    case 'math': return escText(n.attrs.display ? `\\[${n.attrs.tex}\\]` : `\\(${n.attrs.tex}\\)`);
    default: throw new Error(`unexpected inline node ${n.type.name}`);
  }
}
const img = (n) => `<img${attrs([...gAttrs(n.attrs.g), ['src', n.attrs.src], ['alt', n.attrs.alt], ['width', n.attrs.width], ['height', n.attrs.height]])}>`;
const children = (n) => { let s = ''; n.forEach((c) => { s += block(c); }); return s; };

function block(n) {
  const a = n.attrs;
  switch (n.type.name) {
    case 'paragraph': return a.bare ? inlineContent(n) : `<p${attrs(gAttrs(a.g))}>${inlineContent(n)}</p>`;
    case 'heading': return `<h${a.level}${attrs(gAttrs(a.g))}>${inlineContent(n)}</h${a.level}>`;
    case 'blockquote': return `<blockquote${attrs([...gAttrs(a.g), ['cite', a.cite]])}>${children(n)}</blockquote>`;
    case 'section': case 'article': case 'aside': case 'header': case 'footer': case 'nav': case 'main': case 'div':
      return `<${n.type.name}${attrs([...gAttrs(a.g), ['data-page', a.page]])}>${children(n)}</${n.type.name}>`;
    case 'bullet_list': return `<ul${attrs(gAttrs(a.g))}>${children(n)}</ul>`;
    case 'ordered_list': return `<ol${attrs([...gAttrs(a.g), ['start', a.start], ['type', a.type], ['reversed', a.reversed || null]])}>${children(n)}</ol>`;
    case 'list_item': return `<li${attrs([...gAttrs(a.g), ['value', a.value]])}>${children(n)}</li>`;
    case 'code_block': return `<pre${attrs(gAttrs(a.g))}>${a.inner ? `<code${attrs(gAttrs(a.inner.g))}>${escText(n.textContent)}</code>` : escText(n.textContent)}</pre>`;
    case 'horizontal_rule': return `<hr${attrs(gAttrs(a.g))}>`;
    case 'figure': return `<figure${attrs(gAttrs(a.g))}>${children(n)}</figure>`;
    case 'figure_image': return img(n);
    case 'figcaption': return `<figcaption${attrs(gAttrs(a.g))}>${inlineContent(n)}</figcaption>`;
    case 'table': return table(n);
    case 'table_cell': case 'table_header': {
      const tag = n.type.name === 'table_cell' ? 'td' : 'th';
      return `<${tag}${attrs([...gAttrs(a.g), ['colspan', a.colspan], ['rowspan', a.rowspan], ['headers', a.headers], ['scope', a.scope], ['abbr', a.abbr]])}>${children(n)}</${tag}>`;
    }
    default: throw new Error(`unexpected block node ${n.type.name}`);
  }
}

function table(n) {
  const a = n.attrs;
  let out = `<table${attrs(gAttrs(a.g))}>`;
  let group = null;
  const groups = { head: 'thead', body: 'tbody', foot: 'tfoot' };
  n.forEach((child) => {
    if (child.type.name === 'table_caption') { out += `<caption${attrs(gAttrs(child.attrs.g))}>${inlineContent(child)}</caption>`; return; }
    const section = child.attrs.section;
    if (section !== group) {
      if (group) out += `</${groups[group]}>`;
      group = section;
      out += `<${groups[section]}${attrs(gAttrs(a[section]?.g))}>`;
    }
    out += `<tr${attrs(gAttrs(child.attrs.g))}>${children(child)}</tr>`;
  });
  if (group) out += `</${groups[group]}>`;
  return `${out}</table>`;
}

/** The stored form of an editor document (sanitized, as the Worker stores it). */
export function serializeDoc(doc) {
  return sanitizeHtml(children(doc));
}

// ---- the fidelity gate --------------------------------------------------------

const isBlockEl = (n) => n?.nodeType === 1 && BLOCK_TAGS.has(n.nodeName);

/**
 * HTML in a form where two documents a browser renders the same compare equal:
 * sanitized, parsed by the browser (so <tbody> is implied the same way on both
 * sides), whitespace collapsed outside <pre>, whitespace between blocks and at
 * the edges of blocks removed, attributes sorted.
 */
export function canonicalHtml(html) {
  const body = inertBody(sanitizeHtml(html ?? ''));
  normalise(body);
  return body.innerHTML;
}

function normalise(el) {
  if (el.nodeName === 'PRE') return;
  if (el.attributes?.length > 1) {
    const list = [...el.attributes].map((x) => [x.name, x.value]).sort(([x], [y]) => (x < y ? -1 : 1));
    for (const [k] of list) el.removeAttribute(k);
    for (const [k, v] of list) el.setAttribute(k, v);
  }
  for (const child of [...el.childNodes]) {
    if (child.nodeType === 8) { child.remove(); continue; }
    if (child.nodeType === 3) child.nodeValue = child.nodeValue.replace(/[ \t\r\n\f]+/g, ' ');
    else if (child.nodeType === 1) normalise(child);
  }
  const blockish = isBlockEl(el) || el.nodeName === 'BODY';
  for (const child of [...el.childNodes]) {
    if (child.nodeType !== 3) continue;
    const prev = child.previousSibling;
    const next = child.nextSibling;
    if (blockish && (!prev || isBlockEl(prev)) && child.nodeValue.startsWith(' ')) child.nodeValue = child.nodeValue.slice(1);
    if (prev?.nodeName === 'BR' && child.nodeValue.startsWith(' ')) child.nodeValue = child.nodeValue.slice(1);
    if (blockish && (!next || isBlockEl(next)) && child.nodeValue.endsWith(' ')) child.nodeValue = child.nodeValue.slice(0, -1);
    if (child.nodeValue === '') child.remove();
  }
  // A space before an inline element's end, followed by more text or space, renders once.
  for (const child of [...el.childNodes]) {
    if (child.nodeType === 3 && child.nodeValue.startsWith(' ')) {
      const prev = child.previousSibling;
      const tail = prev?.nodeType === 1 && !isBlockEl(prev) ? lastText(prev) : prev?.nodeType === 3 ? prev : null;
      if (tail && tail.nodeValue.endsWith(' ')) child.nodeValue = child.nodeValue.slice(1);
      if (child.nodeValue === '') child.remove();
    }
  }
}
function lastText(el) {
  for (let n = el.lastChild; n; n = n.lastChild) if (n.nodeType === 3) return n;
  return null;
}

/** A short, readable account of the first difference (for the notice and for tests). */
export function firstDifference(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return { at: i, stored: a.slice(Math.max(0, i - 40), i + 60), editor: b.slice(Math.max(0, i - 40), i + 60) };
}

/** What the source has that the visual editor cannot show, named for the person. */
export function unrepresented(html) {
  const body = inertBody(sanitizeHtml(html ?? ''));
  const found = new Set();
  if (body.querySelector('math')) found.add('MathML formulas');
  if (body.querySelector('dl')) found.add('a definition list');
  if (body.querySelector('details')) found.add('a collapsible section');
  if (body.querySelector('col, colgroup')) found.add('table column settings');
  if ([...body.querySelectorAll('a[href]')].some((a) => !/^(?:https?:\/\/|mailto:)/i.test(a.getAttribute('href').trim()))) found.add('a link that is not a web or email address');
  if (body.querySelector('time, bdi, bdo, wbr')) found.add('rare inline markup');
  return [...found];
}

/**
 * Open stored HTML: `{ mode: 'rich', doc }` when the editor holds all of it,
 * else `{ mode: 'source', reasons }`.
 */
export function openDocument(html, { figures = [] } = {}) {
  try {
    const doc = parseHtml(html, { figures });
    const back = serializeDoc(doc);
    if (canonicalHtml(back) === canonicalHtml(html)) return { mode: 'rich', doc };
    const imgs = [...inertBody(sanitizeHtml(html ?? '')).querySelectorAll('img')].map((i) => i.getAttribute('src'));
    const extra = imgs.some((s) => !figures.includes(s)) ? ['an image that is not one of this text’s figures'] : [];
    return { mode: 'source', reasons: [...unrepresented(html), ...extra], difference: firstDifference(canonicalHtml(html), canonicalHtml(back)) };
  } catch {
    return { mode: 'source', reasons: [] };
  }
}
