// Figure placeholders in a PDF text's HTML, and attaching an image to one.
// The page prompt writes <figure class="needs-image"><figcaption>...</figcaption></figure>
// where the page shows a figure and no image file was given. This works on the
// HTML as a string (it never puts the document into the app's DOM): it finds
// each placeholder, the page it sits on (<section data-page="N">), and its
// caption as plain text; attaching replaces exactly that placeholder's opening
// tag and adds an <img> naming a stored figure, escaped, so the result passes
// the Worker's sanitizer unchanged.

const OPEN = /<figure\b[^>]*\bclass="([^"]*)"[^>]*>/gi;
const FIGURE_TAG = /<\/?figure\b[^>]*>/gi;

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
export const escapeAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const plain = (html) => decode(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/** The end of the figure element whose opening tag ends at `from` (nested figures counted). */
function closeOf(html, from) {
  FIGURE_TAG.lastIndex = from;
  let depth = 1;
  for (let m = FIGURE_TAG.exec(html); m; m = FIGURE_TAG.exec(html)) {
    depth += m[0][1] === '/' ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return -1;
}

/** Every placeholder, in document order: { n, start, end, page, caption }. */
export function findPlaceholders(html) {
  const out = [];
  OPEN.lastIndex = 0;
  for (let m = OPEN.exec(html); m; m = OPEN.exec(html)) {
    if (!m[1].split(/\s+/).includes('needs-image')) continue;
    const start = m.index;
    const end = closeOf(html, start + m[0].length);
    if (end < 0) continue;
    const inner = html.slice(start + m[0].length, end);
    const cap = /<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i.exec(inner);
    const before = html.slice(0, start);
    const sections = [...before.matchAll(/<section\b[^>]*\bdata-page="(\d+)"/gi)];
    out.push({ n: out.length, start, end, page: sections.length ? Number(sections[sections.length - 1][1]) : null, caption: cap ? plain(cap[1]) : '' });
    OPEN.lastIndex = start + m[0].length;
  }
  return out;
}

/** The alt text for a figure: its caption without the "Figure:" the prompt puts first. */
export const altFromCaption = (caption) => caption.replace(/^\s*figure\s*:\s*/i, '').slice(0, 300) || 'Figure';

/**
 * Attach a stored figure to placeholder `n`: <figure class="needs-image"> loses
 * that class and gains <img src="filename" alt="..."> before its caption.
 * Returns the new HTML, or null when the placeholder is no longer there.
 */
export function attachImage(html, n, { filename, alt, width, height }) {
  const ph = findPlaceholders(html)[n];
  if (!ph) return null;
  const open = OPEN;
  open.lastIndex = ph.start;
  const m = open.exec(html);
  const classes = m[1].split(/\s+/).filter((c) => c && c !== 'needs-image');
  const tag = m[0].replace(/\s*\bclass="[^"]*"/i, classes.length ? ` class="${escapeAttr(classes.join(' '))}"` : '');
  const size = width && height ? ` width="${Number(width) | 0}" height="${Number(height) | 0}"` : '';
  const img = `<img src="${escapeAttr(filename)}" alt="${escapeAttr(alt)}"${size}>`;
  return html.slice(0, ph.start) + tag + img + html.slice(ph.start + m[0].length);
}

/** A figure file name not yet used by this text: p7-fig1.png, p7-fig2.png, ... */
export function figureName(existing, page, ext = 'png') {
  const taken = new Set(existing.map((f) => (typeof f === 'string' ? f : f.filename).toLowerCase()));
  for (let i = 1; ; i += 1) {
    const name = `${page ? `p${page}-` : ''}fig${i}.${ext}`;
    if (!taken.has(name)) return name;
  }
}

/** A crop rectangle in page fractions (0..1), clamped and at least 1 px, as pixels of a w x h canvas. */
export function cropPixels(rect, w, h) {
  const clamp = (v) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
  const x0 = clamp(Math.min(rect.x, rect.x + rect.w));
  const y0 = clamp(Math.min(rect.y, rect.y + rect.h));
  const x1 = clamp(Math.max(rect.x, rect.x + rect.w));
  const y1 = clamp(Math.max(rect.y, rect.y + rect.h));
  const x = Math.floor(x0 * w);
  const y = Math.floor(y0 * h);
  return { x, y, width: Math.max(1, Math.round(x1 * w) - x), height: Math.max(1, Math.round(y1 * h) - y) };
}

/**
 * pdf.js image data as RGBA pixels. kind 1: 1 bit per pixel, rows padded to a
 * byte, 1 = white (pdf.js GRAYSCALE_1BPP); 2: RGB 24-bit; 3: RGBA 32-bit.
 */
export function toRgba({ width, height, kind, data }) {
  const out = new Uint8ClampedArray(width * height * 4);
  if (kind === 3) { out.set(data.subarray(0, out.length)); return out; }
  if (kind === 2) {
    for (let i = 0, j = 0; i < width * height; i += 1, j += 3) { out[i * 4] = data[j]; out[i * 4 + 1] = data[j + 1]; out[i * 4 + 2] = data[j + 2]; out[i * 4 + 3] = 255; }
    return out;
  }
  if (kind === 1) {
    const rowBytes = (width + 7) >> 3;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const v = bit ? 255 : 0;
        const o = (y * width + x) * 4;
        out[o] = v; out[o + 1] = v; out[o + 2] = v; out[o + 3] = 255;
      }
    }
    return out;
  }
  throw new Error('unknown_image_kind');
}
