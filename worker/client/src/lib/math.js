// Mathematics on screen, rendered the way the legacy app rendered it: KaTeX
// (same version, 0.16.38) over TeX stored in \(...\) and \[...\], with
// throwOnError: false so bad TeX shows as KaTeX's red source text with the
// error in its tooltip. Legacy used katex/contrib/auto-render on the live DOM;
// this is a string port of the same algorithm (auto-render's
// splitAtDelimiters/findEndOfMath, its ignored tags, decoded text) so it can
// run on SANITIZED HTML in the parent page, in Node and in tests, and the
// result is injected into the sandboxed srcdoc preview, which runs no script.
//
// Deliberate differences from legacy: trust is OFF (legacy had trust: true,
// which enables \href, \url, \includegraphics and \htmlClass/\htmlStyle/
// \htmlData/\htmlId); maxSize and maxExpand are bounded; strict is "ignore",
// which is what legacy's strict: false meant.
import katex from 'katex';
import { isKatexClass } from '../../../src/sanitize/html.ts';

export const LEGACY_DELIMITERS = [
  { left: '\\[', right: '\\]', display: true },
  { left: '\\(', right: '\\)', display: false },
];
/** Markdown previews also take $$...$$ (legacy rendered no maths in Markdown at all). */
const MARKDOWN_EXTRA = [{ left: '$$', right: '$$', display: true }];

export const KATEX_OPTIONS = Object.freeze({
  throwOnError: false,
  errorColor: '#cc0000', // KaTeX's default, as legacy showed it
  trust: false,
  strict: 'ignore',
  maxSize: 20, // em; limits \rule and \kern sizes a document can ask for
  maxExpand: 1000, // macro expansions per formula
  output: 'htmlAndMathml', // KaTeX's default: visible HTML plus MathML for screen readers
});

// auto-render's default ignoredTags (script, style, textarea and option never survive the sanitizer)
const IGNORED = new Set(['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'option']);

function findEndOfMath(delimiter, text, startIndex) {
  let index = startIndex;
  let braceLevel = 0;
  while (index < text.length) {
    const character = text[index];
    if (braceLevel <= 0 && text.slice(index, index + delimiter.length) === delimiter) return index;
    if (character === '\\') index += 1;
    else if (character === '{') braceLevel += 1;
    else if (character === '}') braceLevel -= 1;
    index += 1;
  }
  return -1;
}

const escapeRegex = (s) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
const AMS = /^\\begin{/;

/** auto-render's splitAtDelimiters, unchanged in behaviour. */
export function splitAtDelimiters(input, delimiters) {
  let text = input;
  const data = [];
  const left = new RegExp(`(${delimiters.map((d) => escapeRegex(d.left)).join('|')})`);
  for (;;) {
    let index = text.search(left);
    if (index === -1) break;
    if (index > 0) {
      data.push({ type: 'text', data: text.slice(0, index) });
      text = text.slice(index);
    }
    const i = delimiters.findIndex((d) => text.startsWith(d.left));
    index = findEndOfMath(delimiters[i].right, text, delimiters[i].left.length);
    if (index === -1) break;
    const rawData = text.slice(0, index + delimiters[i].right.length);
    const math = AMS.test(rawData) ? rawData : text.slice(delimiters[i].left.length, index);
    data.push({ type: 'math', data: math, rawData, display: delimiters[i].display });
    text = text.slice(index + delimiters[i].right.length);
  }
  if (text !== '') data.push({ type: 'text', data: text });
  return data;
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** What a browser's textContent would give for the TeX (the stored HTML escapes <, > and &). */
export function decodeEntities(s) {
  return s.replace(/&(?:#x([0-9a-fA-F]{1,6})|#(\d{1,7})|([a-zA-Z][a-zA-Z0-9]{1,31}));/g, (m, hex, dec, name) => {
    if (hex || dec) {
      const cp = hex ? parseInt(hex, 16) : parseInt(dec, 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '�';
    }
    return NAMED[name] ?? m;
  });
}

const render = (tex, display) => katex.renderToString(tex, { ...KATEX_OPTIONS, displayMode: display });

// Class names KaTeX itself emits (the list lives in the sanitizer, which drops
// them at storage). They are dropped again here before rendering, for drafts
// and for content stored before the sanitizer did so: markup that imitates
// KaTeX output cannot borrow its stylesheet; real KaTeX markup exists only in
// the rendered preview, never in storage.

export function stripKatexClasses(html) {
  return html.replace(/ class="([^"]*)"/g, (m, value) => {
    const kept = value.split(/\s+/).filter((c) => c && !isKatexClass(c));
    return kept.length ? ` class="${kept.join(' ')}"` : '';
  });
}

/**
 * Render every \(...\) / \[...\] in SANITIZED HTML with KaTeX, exactly where
 * legacy auto-render would: inside one text run, outside pre/code. The input
 * must be the sanitizer's normal form (text escaped, tags rebuilt), so a tag
 * never hides inside text and a text run is everything between two tags.
 */
export function renderMath(sanitizedHtml, { markdown = false } = {}) {
  const delimiters = markdown ? [...MARKDOWN_EXTRA, ...LEGACY_DELIMITERS] : LEGACY_DELIMITERS;
  const out = [];
  let count = 0;
  let errors = 0;
  let ignoredDepth = 0;
  for (const part of stripKatexClasses(sanitizedHtml).split(/(<[^>]*>)/)) {
    if (part.startsWith('<')) {
      const m = /^<(\/?)([a-z][a-z0-9-]*)/i.exec(part);
      if (m && IGNORED.has(m[2].toLowerCase())) ignoredDepth = Math.max(0, ignoredDepth + (m[1] ? -1 : 1));
      out.push(part);
      continue;
    }
    if (ignoredDepth > 0 || part === '') {
      out.push(part);
      continue;
    }
    for (const piece of splitAtDelimiters(part, delimiters)) {
      if (piece.type === 'text') {
        out.push(piece.data);
        continue;
      }
      count += 1;
      const html = render(decodeEntities(piece.data), piece.display);
      if (html.includes('katex-error')) errors += 1;
      out.push(html);
    }
  }
  return { html: out.join(''), count, errors };
}

/** TeX fragments KaTeX cannot parse (what the formula-repair button sends). */
export function brokenFormulas(sanitizedHtml, { markdown = false } = {}) {
  const delimiters = markdown ? [...MARKDOWN_EXTRA, ...LEGACY_DELIMITERS] : LEGACY_DELIMITERS;
  const found = [];
  for (const part of sanitizedHtml.split(/(<[^>]*>)/)) {
    if (part.startsWith('<')) continue;
    for (const piece of splitAtDelimiters(part, delimiters)) {
      if (piece.type !== 'math') continue;
      try {
        katex.renderToString(decodeEntities(piece.data), { ...KATEX_OPTIONS, throwOnError: true, displayMode: piece.display });
      } catch {
        found.push(piece.data);
      }
    }
  }
  return [...new Set(found)].slice(0, 50);
}

// ---- fonts ----------------------------------------------------------------
// The KaTeX stylesheet is inlined into the preview and its @font-face rules are
// rewritten to data: URIs, because the sandboxed preview has an opaque origin
// and cannot fetch app URLs (and through Doorway an app URL needs the session
// cookie, which a cross-origin font request never carries). Only the faces the
// rendered formulas need are embedded, found from KaTeX's own class -> font
// rules, so a page with no maths carries no font at all.

/** @font-face rules of katex.min.css: family, weight, style and the woff2 file. */
export function parseFontFaces(css) {
  return [...css.matchAll(/@font-face\{([^}]*)\}/g)].map((m) => {
    const body = m[1];
    return {
      family: /font-family:([^;]+)/.exec(body)[1].trim(),
      weight: (/font-weight:(\d+)/.exec(body) ?? [null, '400'])[1],
      style: (/font-style:(\w+)/.exec(body) ?? [null, 'normal'])[1],
      file: /url\(fonts\/([^)]+\.woff2)\)/.exec(body)[1],
    };
  });
}

/** katex.min.css without its @font-face rules (they are added back as data: URIs). */
export const stripFontFaces = (css) => css.replace(/@font-face\{[^}]*\}/g, '');

/**
 * Which faces the rendered HTML needs: KaTeX_Main regular always, plus every
 * face whose family a matched class rule names (weights and styles as the
 * rules set them). Bounded and conservative: a family that is referenced gets
 * all of the faces those rules ask for.
 */
export function facesNeeded(css, renderedHtml) {
  if (!renderedHtml.includes('class="katex')) return [];
  const classes = new Set([...renderedHtml.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)));
  const faces = parseFontFaces(css);
  const want = new Set(['KaTeX_Main|400|normal']);
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*font-(?:family|weight|style)[^{}]*)\}/g)) {
    const [, selectors, body] = rule;
    if (selectors.includes('@font-face')) continue;
    const matched = selectors.split(',').some((sel) => {
      const names = [...sel.matchAll(/\.([\w-]+)/g)].map((x) => x[1]).filter((n) => n !== 'katex');
      return names.length > 0 && names.every((n) => classes.has(n));
    });
    if (!matched) continue;
    const family = (/font-family:([^;,}]+)/.exec(body)?.[1] ?? 'KaTeX_Main').trim();
    if (!family.startsWith('KaTeX_')) continue;
    const weight = /font-weight:(700|bold)/.test(body) ? '700' : '400';
    const style = /font-style:italic/.test(body) ? 'italic' : 'normal';
    want.add(`${family}|${weight}|${style}`);
    // A family with one face (Size1-4, AMS, Script...) needs it whatever the rule's weight says.
    if (faces.filter((f) => f.family === family).length === 1) want.add(`${family}|${faces.find((f) => f.family === family).weight}|${faces.find((f) => f.family === family).style}`);
  }
  // Large delimiters and big operators pick a Size font by size class; include the four tiny Size faces whenever sizing appears.
  if (/delimsizing|op-symbol|sqrt/.test(renderedHtml)) for (const n of [1, 2, 3, 4]) want.add(`KaTeX_Size${n}|400|normal`);
  return faces.filter((f) => want.has(`${f.family}|${f.weight}|${f.style}`));
}

/** The inlined stylesheet: KaTeX's rules plus the needed faces, each a woff2 data: URI. */
export function katexStylesheet(css, faces, dataUriFor) {
  const fontFaces = faces.map((f) => `@font-face{font-display:block;font-family:${f.family};font-style:${f.style};font-weight:${f.weight};src:url(${dataUriFor(f.file)}) format("woff2")}`).join('');
  return fontFaces + stripFontFaces(css);
}
