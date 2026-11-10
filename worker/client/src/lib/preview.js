// Previews of stored, user-authored HTML and Markdown. They are rendered ONLY
// inside a sandboxed srcdoc iframe without allow-scripts or allow-same-origin
// (components/SandboxedPreview.jsx). The pipeline, all in the parent page:
//   1. sanitize with the Worker's own sanitizer (src/sanitize/html.ts, the
//      allowlist stored content already passed), so a draft is held to the
//      same rules as storage;
//   2. render TeX with KaTeX as legacy did (lib/math.js);
//   3. wrap in a document carrying the legacy preview stylesheet, KaTeX's CSS
//      with only the needed faces as data: URIs, and its own CSP.
// Nothing in the frame runs; KaTeX markup is produced here and never stored.
import { marked } from 'marked';
import { sanitizeHtml } from '../../../src/sanitize/html.ts';
import { LEGACY_PREVIEW_CSS } from './legacy-preview-css.js';
import { decodeEntities, LEGACY_DELIMITERS, renderMath, splitAtDelimiters } from './math.js';

const FRAME_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";
// The legacy preview pane's box: white, padded, 16px Georgia (KaTeX scales from it).
const FRAME_CSS = `html{background:#fff}body{margin:0;padding:1.5rem;font-size:16px;background:#fff;overflow-wrap:break-word}
img{max-width:100%;height:auto}.katex-display{overflow-x:auto;overflow-y:hidden}
@media (prefers-color-scheme: dark){html,body{background:#1e293b;color:#e2e8f0}.katex{color:inherit}}`;

const SLOT = /(\d+)/g;
// Pandoc's inline-math rule for $...$: no space just inside either dollar, and the
// closing dollar not followed by a digit, so "$5 and $10" stays text. OCR models
// write Markdown maths this way; legacy rendered no maths in Markdown at all.
const PANDOC_DOLLAR = /(?<![\\$])\$(?![\s$])((?:\\\$|[^$\n])+?)(?<![\s\\])\$(?![\d$])/g;

/** Markdown: TeX is set aside before marked (its backslash escapes would eat \( ), then rendered after sanitizing. */
function markdownBody(md) {
  const slots = [];
  const slot = (p) => (slots.push(p), `${slots.length - 1}`);
  const protectedMd = splitAtDelimiters(md, [{ left: '$$', right: '$$', display: true }, ...LEGACY_DELIMITERS])
    .map((p) => (p.type === 'math' ? slot(p) : p.data.replace(PANDOC_DOLLAR, (_m, tex) => slot({ data: tex, rawData: `\\(${tex}\\)` }))))
    .join('');
  const clean = sanitizeHtml(marked.parse(protectedMd, { async: false }));
  // Put each formula back as escaped TeX in its original delimiters, then let renderMath do what it does for HTML.
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const restored = clean.replace(SLOT, (m, i) => {
    const p = slots[Number(i)];
    if (!p) return '';
    const raw = p.rawData.startsWith('$$') ? `\\[${p.data}\\]` : p.rawData;
    return esc(decodeEntities(raw));
  });
  return renderMath(restored);
}

/** The preview body (sanitized, maths rendered) and how many formulas it holds. */
export function previewBody({ html, markdown, images = {} }) {
  const { html: body, count, errors } = markdown !== undefined ? markdownBody(markdown ?? '') : renderMath(sanitizeHtml(html ?? ''));
  // Figures: the frame cannot fetch app URLs, so a referenced figure is swapped for its data: URI.
  const withImages = body.replace(/ src="([^"/]+)"/g, (m, name) => (images[name] ? ` src="${images[name]}"` : m));
  return { body: withImages, mathCount: count, mathErrors: errors };
}

/** A complete srcdoc document around a preview body. `mathCss` is KaTeX's inlined stylesheet ('' when there is no maths). */
export function wrapPreview(body, mathCss = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><style>${FRAME_CSS}${LEGACY_PREVIEW_CSS}${mathCss}</style></head><body>${body}</body></html>`;
}

/** One-call form (the live-eval harness uses it; it passes its own mathCss). */
export function previewDocument({ html, markdown, images = {}, mathCss = '' }) {
  return wrapPreview(previewBody({ html, markdown, images }).body, mathCss);
}
