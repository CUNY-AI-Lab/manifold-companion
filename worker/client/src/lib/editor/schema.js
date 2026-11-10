// The visual editor's document schema: an allowlist. A document is built ONLY
// by parsing SANITIZED HTML into these node and mark types (lib/editor/html.js),
// so nothing outside them can be represented, or rendered by the editor.
//
//   blocks  paragraph (a "bare" one stands for inline content written directly
//           in a container, e.g. <li>text</li>), heading 1-6, blockquote, the
//           containers the page prompt and the cleanup write (section with
//           data-page, article, aside, header, footer, nav, main, div), lists
//           (ol start/type/reversed, li value), pre (code), hr, figure with an
//           optional image and caption (the needs-image placeholder included),
//           table with caption, head/body/foot rows and th/td cells
//   inline  text, br, image (only this text's own stored figures, by name),
//           math (an atom holding TeX, inline or display, shown with KaTeX)
//   marks   link (http, https, mailto only), strong, b, em, i, u, s, del, ins,
//           sub, sup, code, mark, small, span, abbr, q, kbd, cite, dfn, samp, var
//
// Every node and mark keeps the sanitizer's global attributes (`g`: id, class,
// lang, dir, title, role, aria-*), so they survive a save. The editor shows
// only lang, dir and title of them: an id from a document could clobber the
// app's own ids and a class could pull in the app's layout classes, since the
// editor's DOM is part of the app page.
import { Schema } from 'prosemirror-model';

export const GLOBAL_ATTRS = ['id', 'class', 'lang', 'dir', 'title', 'role', 'aria-label', 'aria-hidden', 'aria-describedby', 'aria-labelledby'];
const SAFE_IN_VIEW = ['lang', 'dir', 'title'];

/** The allowed global attributes of a DOM element, as an object (or null when it has none). */
export function globalAttrs(dom) {
  const out = {};
  for (const name of GLOBAL_ATTRS) if (dom.hasAttribute?.(name)) out[name] = dom.getAttribute(name);
  return Object.keys(out).length ? out : null;
}
const viewAttrs = (g, extra = {}) => {
  const out = { ...extra };
  for (const name of SAFE_IN_VIEW) if (g?.[name] != null) out[name] = g[name];
  return out;
};
const g = { g: { default: null } };
const int = (v) => (v != null && /^\d+$/.test(v) ? Number(v) : null);

export const SAFE_LINK = /^(?:https?:\/\/|mailto:)/i;

function container(tag) {
  return {
    content: 'block+', group: 'block', defining: true, attrs: { ...g, ...(tag === 'section' ? { page: { default: null } } : {}) },
    parseDOM: [{ tag, getAttrs: (d) => ({ g: globalAttrs(d), ...(tag === 'section' ? { page: int(d.getAttribute('data-page')) } : {}) }) }],
    toDOM: (n) => [tag, viewAttrs(n.attrs.g, { class: `mc-${tag}`, ...(n.attrs.page != null ? { 'data-page': String(n.attrs.page) } : {}) }), 0],
  };
}

const CONTAINERS = ['section', 'article', 'aside', 'header', 'footer', 'nav', 'main', 'div'];
const cellAttrs = { ...g, colspan: { default: null }, rowspan: { default: null }, headers: { default: null }, scope: { default: null }, abbr: { default: null } };
const cellFrom = (d) => ({ g: globalAttrs(d), colspan: int(d.getAttribute('colspan')), rowspan: int(d.getAttribute('rowspan')), headers: d.getAttribute('headers'), scope: d.getAttribute('scope'), abbr: d.getAttribute('abbr') });
const cellView = (tag) => (n) => [tag, viewAttrs(n.attrs.g, { ...(n.attrs.colspan ? { colspan: String(n.attrs.colspan) } : {}), ...(n.attrs.rowspan ? { rowspan: String(n.attrs.rowspan) } : {}) }), 0];

const nodes = {
  doc: { content: 'block+' },
  // bare: inline content that sat directly in a container (no <p> in the HTML); it is written back the same way.
  paragraph: {
    content: 'inline*', group: 'block', attrs: { ...g, bare: { default: false } },
    parseDOM: [{ tag: 'p', getAttrs: (d) => ({ g: globalAttrs(d), bare: d.hasAttribute('data-mc-bare') }) }],
    toDOM: (n) => (n.attrs.bare ? ['p', viewAttrs(n.attrs.g, { class: 'mc-bare' }), 0] : ['p', viewAttrs(n.attrs.g), 0]),
  },
  heading: {
    content: 'inline*', group: 'block', defining: true, attrs: { ...g, level: { default: 2 } },
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, getAttrs: (d) => ({ g: globalAttrs(d), level }) })),
    toDOM: (n) => [`h${n.attrs.level}`, viewAttrs(n.attrs.g), 0],
  },
  blockquote: {
    content: 'block+', group: 'block', defining: true, attrs: { ...g, cite: { default: null } },
    parseDOM: [{ tag: 'blockquote', getAttrs: (d) => ({ g: globalAttrs(d), cite: d.getAttribute('cite') }) }],
    toDOM: (n) => ['blockquote', viewAttrs(n.attrs.g), 0],
  },
  ...Object.fromEntries(CONTAINERS.map((t) => [t, container(t)])),
  bullet_list: {
    content: 'list_item*', group: 'block', attrs: { ...g },
    parseDOM: [{ tag: 'ul', getAttrs: (d) => ({ g: globalAttrs(d) }) }],
    toDOM: (n) => ['ul', viewAttrs(n.attrs.g), 0],
  },
  ordered_list: {
    content: 'list_item*', group: 'block', attrs: { ...g, start: { default: null }, type: { default: null }, reversed: { default: false } },
    parseDOM: [{ tag: 'ol', getAttrs: (d) => ({ g: globalAttrs(d), start: int(d.getAttribute('start')), type: d.getAttribute('type'), reversed: d.hasAttribute('reversed') }) }],
    toDOM: (n) => ['ol', viewAttrs(n.attrs.g, { ...(n.attrs.start != null ? { start: String(n.attrs.start) } : {}), ...(n.attrs.type ? { type: n.attrs.type } : {}), ...(n.attrs.reversed ? { reversed: '' } : {}) }), 0],
  },
  list_item: {
    content: 'block+', defining: true, attrs: { ...g, value: { default: null } },
    parseDOM: [{ tag: 'li', getAttrs: (d) => ({ g: globalAttrs(d), value: int(d.getAttribute('value')) }) }],
    toDOM: (n) => ['li', viewAttrs(n.attrs.g, n.attrs.value != null ? { value: String(n.attrs.value) } : {}), 0],
  },
  code_block: {
    content: 'text*', marks: '', group: 'block', code: true, defining: true, attrs: { ...g, inner: { default: null } },
    parseDOM: [{
      tag: 'pre', preserveWhitespace: 'full',
      getAttrs: (d) => { const only = d.childNodes.length === 1 && d.firstChild.nodeName === 'CODE' ? d.firstChild : null; return { g: globalAttrs(d), inner: only ? { g: globalAttrs(only) } : null }; },
    }],
    toDOM: (n) => ['pre', viewAttrs(n.attrs.g), ['code', 0]],
  },
  horizontal_rule: { group: 'block', attrs: { ...g }, parseDOM: [{ tag: 'hr', getAttrs: (d) => ({ g: globalAttrs(d) }) }], toDOM: (n) => ['hr', viewAttrs(n.attrs.g)] },
  figure: {
    content: 'figure_image? figcaption?', group: 'block', defining: true, attrs: { ...g },
    parseDOM: [{ tag: 'figure', getAttrs: (d) => ({ g: globalAttrs(d) }) }],
    toDOM: (n) => ['figure', viewAttrs(n.attrs.g, { class: (n.attrs.g?.class ?? '').split(/\s+/).includes('needs-image') ? 'mc-figure mc-needs-image' : 'mc-figure' }), 0],
  },
  figure_image: {
    attrs: { ...g, src: {}, alt: { default: null }, width: { default: null }, height: { default: null } },
    parseDOM: [{ tag: 'img', context: 'figure/', getAttrs: imageAttrs }],
    toDOM: (n) => ['img', { alt: n.attrs.alt ?? '' }],
  },
  figcaption: {
    content: 'inline*', attrs: { ...g },
    parseDOM: [{ tag: 'figcaption', getAttrs: (d) => ({ g: globalAttrs(d) }) }],
    toDOM: (n) => ['figcaption', viewAttrs(n.attrs.g), 0],
  },
  table: {
    content: 'table_caption? table_row+', group: 'block', isolating: true, attrs: { ...g, head: { default: null }, body: { default: null }, foot: { default: null } },
    parseDOM: [{ tag: 'table', getAttrs: (d) => ({ g: globalAttrs(d), ...sectionAttrs(d) }) }],
    toDOM: (n) => ['table', viewAttrs(n.attrs.g, { class: 'mc-table' }), ['tbody', 0]],
  },
  table_caption: {
    content: 'inline*', attrs: { ...g },
    parseDOM: [{ tag: 'caption', getAttrs: (d) => ({ g: globalAttrs(d) }) }],
    toDOM: (n) => ['caption', viewAttrs(n.attrs.g), 0],
  },
  // section: which group the row was in (thead, tbody, tfoot); the serializer groups rows back.
  table_row: {
    content: '(table_cell | table_header)+', attrs: { ...g, section: { default: 'body' } },
    parseDOM: [{ tag: 'tr', getAttrs: (d) => ({ g: globalAttrs(d), section: { THEAD: 'head', TFOOT: 'foot' }[d.parentNode?.nodeName] ?? 'body' }) }],
    toDOM: (n) => ['tr', viewAttrs(n.attrs.g, n.attrs.section === 'head' ? { class: 'mc-thead' } : {}), 0],
  },
  table_cell: { content: 'block+', isolating: true, attrs: cellAttrs, parseDOM: [{ tag: 'td', getAttrs: cellFrom }], toDOM: cellView('td') },
  table_header: { content: 'block+', isolating: true, attrs: cellAttrs, parseDOM: [{ tag: 'th', getAttrs: cellFrom }], toDOM: cellView('th') },
  text: { group: 'inline' },
  hard_break: { inline: true, group: 'inline', selectable: false, attrs: { ...g }, parseDOM: [{ tag: 'br', getAttrs: (d) => ({ g: globalAttrs(d) }) }], toDOM: () => ['br'] },
  image: {
    inline: true, group: 'inline', draggable: true, attrs: { ...g, src: {}, alt: { default: null }, width: { default: null }, height: { default: null } },
    parseDOM: [{ tag: 'img', getAttrs: imageAttrs }],
    toDOM: (n) => ['img', { alt: n.attrs.alt ?? '' }],
  },
  // TeX, exactly as stored between \( \) or \[ \]; a node view renders it with KaTeX (trust off).
  math: {
    inline: true, group: 'inline', atom: true, selectable: true, attrs: { tex: {}, display: { default: false } },
    parseDOM: [{ tag: 'mc-math', getAttrs: (d) => ({ tex: d.getAttribute('data-tex') ?? '', display: d.getAttribute('data-display') === 'true' }) }],
    toDOM: (n) => ['mc-math', { 'data-tex': n.attrs.tex, 'data-display': String(n.attrs.display) }],
  },
};

/** thead/tbody/tfoot carry their own global attributes; kept per group on the table. */
function sectionAttrs(table) {
  const out = {};
  for (const child of table.children ?? []) {
    const key = { THEAD: 'head', TBODY: 'body', TFOOT: 'foot' }[child.nodeName];
    if (key) out[key] = { g: globalAttrs(child), explicit: true };
  }
  return out;
}

/** An image is kept only when it names one of this text's stored figures (set while parsing). */
let allowedImages = null;
export function withAllowedImages(names, fn) {
  const before = allowedImages;
  allowedImages = names;
  try { return fn(); } finally { allowedImages = before; }
}
function imageAttrs(d) {
  const src = d.getAttribute('src') ?? '';
  if (!allowedImages || !allowedImages.has(src)) return false;
  return { g: globalAttrs(d), src, alt: d.getAttribute('alt'), width: int(d.getAttribute('width')), height: int(d.getAttribute('height')) };
}

function simpleMark(tag, extra = {}) {
  return { attrs: { ...g }, parseDOM: [{ tag, getAttrs: (d) => ({ g: globalAttrs(d) }) }], toDOM: (m) => [tag, viewAttrs(m.attrs.g)], ...extra };
}

const marks = {
  link: {
    attrs: { ...g, href: {}, hreflang: { default: null } }, inclusive: false,
    parseDOM: [{ tag: 'a[href]', getAttrs: (d) => { const href = d.getAttribute('href') ?? ''; return SAFE_LINK.test(href.trim()) ? { g: globalAttrs(d), href, hreflang: d.getAttribute('hreflang') } : false; } }],
    toDOM: (m) => ['a', viewAttrs(m.attrs.g, { href: m.attrs.href, rel: 'noopener noreferrer nofollow', title: m.attrs.href })],
  },
  strong: simpleMark('strong'), b: simpleMark('b'), em: simpleMark('em'), i: simpleMark('i'), u: simpleMark('u'), s: simpleMark('s'),
  del: simpleMark('del'), ins: simpleMark('ins'), sub: simpleMark('sub', { excludes: 'sup' }), sup: simpleMark('sup', { excludes: 'sub' }),
  code: simpleMark('code'), mark: simpleMark('mark'), small: simpleMark('small'), span: simpleMark('span'),
  abbr: simpleMark('abbr'),
  q: { attrs: { ...g, cite: { default: null } }, parseDOM: [{ tag: 'q', getAttrs: (d) => ({ g: globalAttrs(d), cite: d.getAttribute('cite') }) }], toDOM: (m) => ['q', viewAttrs(m.attrs.g)] },
  kbd: simpleMark('kbd'), cite: simpleMark('cite'), dfn: simpleMark('dfn'), samp: simpleMark('samp'), var: simpleMark('var'),
};

export const schema = new Schema({ nodes, marks });

/** Tags the schema represents (everything else in a document sends it to the source view). */
export const BLOCK_CONTAINERS = new Set(['li', 'td', 'th', 'blockquote', ...CONTAINERS]);
export const INLINE_TAGS = new Set(['a', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'sub', 'sup', 'code', 'mark', 'small', 'span', 'abbr', 'q', 'kbd', 'cite', 'dfn', 'samp', 'var', 'br', 'img', 'mc-math', 'wbr', 'time', 'bdi', 'bdo']);
