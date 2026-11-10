// Allowlist HTML sanitizer for user-authored HTML (PDF-to-HTML output and edits).
//
// No DOM: a small tokenizer feeds a serializer that REBUILDS every tag it keeps
// from the allowlist, escaping all text and attribute values itself. Nothing
// from the input is copied through verbatim, so the output is whatever this
// module chose to emit, in one fixed normal form:
//   - lowercase allowlisted tag names only, attributes always double-quoted;
//   - text escaped (`<`, `>`, bare `&`), valid entities preserved;
//   - no comments, no processing instructions, no CDATA, no doctype;
//   - never `style`, `on*`, `srcdoc`, `formaction`, `xlink:*`, `data-*`;
//   - script/style/iframe/object/embed/svg/template/form-controls/etc. are
//     dropped WITH their content; unknown elements are unwrapped.
// Idempotent: sanitize(sanitize(x)) === sanitize(x).
//
// Defence in depth, not the only layer: previews render in a sandboxed
// `srcdoc` iframe without allow-same-origin, and the page CSP forbids scripts.

export const MAX_SANITIZE_INPUT_CHARS = 2_000_000;
const MAX_DEPTH = 100;
const MAX_ATTR_VALUE = 4096;

const HTML_TAGS = new Set([
  "a", "abbr", "article", "aside", "b", "bdi", "bdo", "blockquote", "br", "caption", "cite", "code", "col", "colgroup",
  "dd", "del", "details", "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hr", "i", "img", "ins", "kbd", "li", "main", "mark", "nav", "ol", "p", "pre", "q", "s", "samp", "section", "small",
  "span", "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "u", "ul", "var", "wbr",
]);

// MathML subset needed for formulas. No annotation/annotation-xml (they carry
// foreign content), no maction (can act as a link), no semantics wrapper content
// beyond the presentation child (semantics is unwrapped).
const MATHML_TAGS = new Set([
  "math", "maligngroup", "malignmark", "menclose", "merror", "mfenced", "mfrac", "mglyph", "mi", "mlabeledtr", "mmultiscripts",
  "mn", "mo", "mover", "mpadded", "mphantom", "mprescripts", "mroot", "mrow", "ms", "mspace", "msqrt", "mstyle", "msub", "msubsup",
  "msup", "mtable", "mtd", "mtext", "mtr", "munder", "munderover", "none",
]);

const VOID = new Set(["br", "hr", "img", "col", "wbr"]);
// MathML elements that never have children. HTML syntax only self-closes a foreign element
// with "/>", so a bare <mspace> would swallow its following siblings in a browser. They are
// always emitted with an explicit end tag and never take content.
const MATH_EMPTY = new Set(["mspace", "mprescripts", "none", "malignmark", "maligngroup", "mglyph"]);

// Content is discarded along with the element. RAW elements are tokenized as raw
// text up to their end tag (the browser would not parse markup inside them).
const DROP_RAW = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript", "plaintext"]);
const DROP_NESTED = new Set([
  "svg", "template", "object", "applet", "select", "datalist", "audio", "video", "canvas", "map", "frameset", "frame",
  "annotation", "annotation-xml", "head", "button", "dialog", "fieldset", "optgroup", "option", "portal", "slot",
]);
const DROP_VOID = new Set(["embed", "input", "link", "meta", "base", "param", "source", "track", "area", "keygen", "basefont", "bgsound"]);

const GLOBAL_ATTRS = new Set(["id", "class", "lang", "dir", "title", "role", "aria-label", "aria-hidden", "aria-describedby", "aria-labelledby"]);
const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "hreflang"]),
  img: new Set(["src", "alt", "width", "height"]),
  td: new Set(["colspan", "rowspan", "headers", "scope", "abbr"]),
  th: new Set(["colspan", "rowspan", "headers", "scope", "abbr"]),
  col: new Set(["span"]),
  colgroup: new Set(["span"]),
  ol: new Set(["start", "type", "reversed"]),
  li: new Set(["value"]),
  q: new Set(["cite"]),
  blockquote: new Set(["cite"]),
  time: new Set(["datetime"]),
  bdo: new Set(["dir"]),
  details: new Set(["open"]),
};
const MATH_ATTRS = new Set([
  "display", "displaystyle", "mathvariant", "scriptlevel", "mathsize", "fence", "stretchy", "separator", "accent", "accentunder",
  "columnalign", "rowalign", "columnspan", "rowspan", "linethickness", "lspace", "rspace", "minsize", "maxsize", "open", "close",
  "separators", "form", "symmetric", "largeop", "movablelimits", "notation", "width", "height", "depth", "voffset", "numalign",
  "denomalign", "bevelled", "align", "frame", "equalrows", "equalcolumns", "rowlines", "columnlines", "rowspacing", "columnspacing",
  "mathbackground", "mathcolor", "scriptminsize", "scriptsizemultiplier", "subscriptshift", "superscriptshift", "side", "xmlns",
  "lquote", "rquote",
]);

const SAFE_TOKEN = /^[A-Za-z][A-Za-z0-9_:.-]{0,63}$/;
const SAFE_CLASS = /^[A-Za-z0-9_\- :.]{0,200}$/;
const SAFE_SIMPLE = /^[A-Za-z0-9_\- :.,%#+]{0,200}$/;
const DIGITS = /^\d{1,9}$/;
// Class names KaTeX emits. Real KaTeX markup is produced only when a preview is
// rendered (worker/client/src/lib/math.js), never stored, so stored content may
// not carry these: markup imitating KaTeX output cannot borrow its stylesheet.
const KATEX_CLASS = /^(katex(-[\w-]+)?|base|strut|mord|mop|mbin|mrel|mopen|mclose|mpunct|minner|mspace|mtight|vlist(-[\w-]+)?|pstrut|sizing|reset-size\d+|size\d+|fontsize-ensurer|delimsizing|delimcenter|delim-size\d|mult|frac-line|mfrac|msupsub|sqrt|hide-tail|svg-align|nulldelimiter|enclosing|overline|underline|accent(-body)?|op-symbol|small-op|large-op|op-limits|mathnormal|mathrm|mathit|mathbf|mathbb|mathcal|mathfrak|mathscr|mathsf|mathtt|amsrm|textrm|textit|textbf|textsf|texttt|boldsymbol|mainrm|col-align-[lcr]|arraycolsep|tag|newline|stretchy|halfarrow-(left|right)|x-arrow(-pad)?|cancel-(pad|lap)|mathdefault|rule|root|stackedfrac)$/;
export const isKatexClass = (c: string): boolean => KATEX_CLASS.test(c);
// MathML fence and quote characters (mfenced open/close/separators, ms lquote/rquote): short plain
// text, which is all these attributes ever hold. Values are re-escaped on output, so any character
// outside the control range is safe here.
// eslint-disable-next-line no-control-regex
const MATH_FENCE = /^[^\u0000-\u001f\u007f]{0,16}$/;

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

/** Decode character references enough to judge a URL; unknown names stay literal. */
function decodeEntities(input: string): string {
  return input.replace(/&(?:#x([0-9a-fA-F]{1,6})|#(\d{1,7})|([a-zA-Z]{2,8}));?/g, (m, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
    if (hex !== undefined || dec !== undefined) {
      const cp = hex !== undefined ? parseInt(hex, 16) : parseInt(dec as string, 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "\ufffd";
    }
    const v = NAMED_ENTITIES[(name as string).toLowerCase()];
    return v ?? m;
  });
}

const escText = (s: string): string => s.replace(/&(?!(?:#\d{1,7}|#x[0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// eslint-disable-next-line no-control-regex
const CONTROL_AND_SPACE = /[\u0000-\u0020\u007f-\u009f\u00a0\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u2064\u3000\ufeff]/g;
const UNKNOWN_ENTITY = /&[a-zA-Z][a-zA-Z0-9]*;/;
const SCHEME = /^([a-z][a-z0-9+.-]*):/;

/**
 * Link target policy: http, https, mailto, or a scheme-less relative/fragment
 * reference. Anything with another scheme (javascript:, data:, vbscript:, file:,
 * blob:, ...) is rejected. Protocol-relative (`//host`) and backslash forms are
 * rejected so a "relative" URL cannot leave the origin unexpectedly.
 */
export function safeHref(raw: string): string | null {
  const decoded = decodeEntities(raw);
  // A named entity we do not decode (&colon; &Tab; &NewLine; ...) could still be a
  // scheme separator or whitespace to a browser: refuse rather than guess.
  if (UNKNOWN_ENTITY.test(decoded)) return null;
  const probe = decoded.replace(CONTROL_AND_SPACE, "").toLowerCase();
  if (probe === "") return null;
  if (probe.startsWith("//") || probe.includes("\\")) return null;
  const scheme = SCHEME.exec(probe);
  if (scheme) {
    if (scheme[1] !== "http" && scheme[1] !== "https" && scheme[1] !== "mailto") return null;
    // Re-check the untouched value too: whitespace inside a scheme is stripped
    // by browsers, but we only emit it if it is a clean URL as written.
    if (/[\u0000-\u0020\u007f-\u009f]/.test(decoded.trim())) return null;
  } else if (probe.includes(":") && !probe.startsWith("#") && !probe.startsWith("/") && !probe.startsWith(".") && !/^[^/?#]*[/?#]/.test(probe)) {
    // "foo:bar" with no path/query separator before the colon reads as a scheme.
    return null;
  }
  return decoded.trim().slice(0, MAX_ATTR_VALUE);
}

const IMG_DATA = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Images: same-origin relative paths or inline raster data URIs only. No remote images (tracking), no svg. */
export function safeImgSrc(raw: string): string | null {
  const decoded = decodeEntities(raw).trim();
  if (UNKNOWN_ENTITY.test(decoded)) return null;
  if (IMG_DATA.test(decoded) && decoded.length <= 2_000_000) return decoded;
  const probe = decoded.replace(CONTROL_AND_SPACE, "").toLowerCase();
  if (probe === "" || probe.startsWith("//") || probe.includes("\\") || SCHEME.test(probe)) return null;
  if (probe.includes(":") && !/^[^/?#]*[/?#]/.test(probe)) return null;
  return decoded.slice(0, MAX_ATTR_VALUE);
}

function cleanAttr(tag: string, isMath: boolean, name: string, value: string): string | null {
  // The one data-* attribute the page pipeline relies on: <section data-page="N">.
  if (name === "data-page") return tag === "section" && DIGITS.test(value) ? value : null;
  if (name.startsWith("on") || name === "style" || name.startsWith("data-") || name.startsWith("xlink") || name.includes(":") && name !== "xmlns") return null;
  const allowedHere = GLOBAL_ATTRS.has(name) || TAG_ATTRS[tag]?.has(name) || (isMath && MATH_ATTRS.has(name));
  if (!allowedHere) return null;
  const v = decodeEntities(value);
  switch (name) {
    case "href":
      return tag === "a" ? safeHref(value) : null;
    case "src":
      return tag === "img" ? safeImgSrc(value) : null;
    case "id":
      return SAFE_TOKEN.test(v) ? v : null;
    case "class": {
      if (!SAFE_CLASS.test(v)) return null;
      const kept = v.split(/\s+/).filter((c) => c !== "" && !isKatexClass(c));
      return kept.length > 0 ? kept.join(" ") : null;
    }
    case "xmlns":
      return tag === "math" && v === "http://www.w3.org/1998/Math/MathML" ? v : null;
    case "cite":
      return safeHref(value);
    case "colspan": case "rowspan": case "span": case "start": case "value": case "width": case "height": case "hreflang": case "columnspan":
      return name === "hreflang" ? (/^[A-Za-z-]{1,16}$/.test(v) ? v : null) : (DIGITS.test(v) || (isMath && SAFE_SIMPLE.test(v)) ? v : null);
    case "type":
      return /^[1aAiI]$/.test(v) ? v : null;
    case "dir":
      return v === "ltr" || v === "rtl" || v === "auto" ? v : null;
    case "open":
      // Boolean on <details>; a fence character on MathML (mfenced open="(").
      if (isMath) return MATH_FENCE.test(v) ? v : null;
      return "";
    case "close": case "separators": case "lquote": case "rquote":
      return isMath && MATH_FENCE.test(v) ? v : null;
    case "reversed": case "hidden":
      return "";
    case "lang":
      return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(v) ? v : null;
    case "datetime":
      return /^[0-9TZ:+.\- ]{1,40}$/.test(v) ? v : null;
    case "aria-hidden":
      return v === "true" || v === "false" ? v : null;
    case "role":
      return /^[a-z-]{1,30}$/.test(v) ? v : null;
    case "title": case "alt": case "aria-label": case "abbr":
      return v.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500);
    case "headers": case "aria-describedby": case "aria-labelledby":
      return /^[A-Za-z0-9_:.\- ]{0,300}$/.test(v) ? v : null;
    case "scope":
      return /^(row|col|rowgroup|colgroup)$/.test(v) ? v : null;
    default:
      // Remaining MathML presentation attributes: short, boring values only.
      return isMath && SAFE_SIMPLE.test(v) ? v : null;
  }
}

interface RawTag { name: string; closing: boolean; attrs: [string, string][]; selfClosing: boolean; end: number }

const TAG_NAME_START = /[A-Za-z]/;

/** Parse a tag starting at html[i] === "<" followed by a letter or "/" + letter. Returns null if unterminated. */
function parseTag(html: string, i: number): RawTag | null {
  let p = i + 1;
  let closing = false;
  if (html[p] === "/") { closing = true; p += 1; }
  let name = "";
  while (p < html.length && /[A-Za-z0-9:_.-]/.test(html[p] as string)) { name += html[p]; p += 1; }
  const attrs: [string, string][] = [];
  let selfClosing = false;
  for (;;) {
    while (p < html.length && /[\s/]/.test(html[p] as string)) { if (html[p] === "/" && /\s*>/.test(html.slice(p + 1, p + 8))) selfClosing = true; p += 1; }
    if (p >= html.length) return null;
    if (html[p] === ">") { p += 1; break; }
    let an = "";
    while (p < html.length && !/[\s/>=]/.test(html[p] as string)) { an += html[p]; p += 1; }
    if (an === "") { p += 1; continue; } // stray "=" etc.
    while (p < html.length && /\s/.test(html[p] as string)) p += 1;
    let av = "";
    if (html[p] === "=") {
      p += 1;
      while (p < html.length && /\s/.test(html[p] as string)) p += 1;
      const q = html[p];
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, p + 1);
        if (close === -1) return null;
        av = html.slice(p + 1, close);
        p = close + 1;
      } else {
        while (p < html.length && !/[\s>]/.test(html[p] as string)) { av += html[p]; p += 1; }
      }
    }
    if (attrs.length < 64) attrs.push([an.toLowerCase(), av]);
  }
  return { name: name.toLowerCase(), closing, attrs, selfClosing, end: p };
}

export function sanitizeHtml(input: string): string {
  let html = input.length > MAX_SANITIZE_INPUT_CHARS ? input.slice(0, MAX_SANITIZE_INPUT_CHARS) : input;
  html = html.replace(/\u0000/g, "");
  const out: string[] = [];
  const stack: string[] = []; // emitted (kept) elements
  let skipName: string | null = null; // inside a DROP_NESTED element
  let skipDepth = 0;
  let mathDepth = 0;
  let i = 0;

  const emitText = (t: string) => { if (t !== "" && skipName === null) out.push(escText(t)); };

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) { emitText(html.slice(i)); break; }
    if (lt > i) emitText(html.slice(i, lt));
    const next = html[lt + 1];
    if (next === "!" || next === "?") {
      // Comment, CDATA, doctype, PI: all dropped. `<!--` runs to `-->` (or EOF);
      // anything else is a bogus comment that ends at the first `>`.
      if (html.startsWith("<!--", lt)) {
        const end = html.indexOf("-->", lt + 4);
        i = end === -1 ? html.length : end + 3;
      } else {
        const end = html.indexOf(">", lt + 2);
        i = end === -1 ? html.length : end + 1;
      }
      continue;
    }
    const startsTag = next !== undefined && (TAG_NAME_START.test(next) || (next === "/" && TAG_NAME_START.test(html[lt + 2] ?? "")));
    if (!startsTag) { emitText("<"); i = lt + 1; continue; }
    const tag = parseTag(html, lt);
    if (tag === null) { i = html.length; break; } // unterminated tag swallows the rest
    i = tag.end;
    const { name } = tag;

    if (skipName !== null) {
      if (name === skipName) {
        if (tag.closing) { skipDepth -= 1; if (skipDepth === 0) skipName = null; }
        else if (!tag.selfClosing) skipDepth += 1;
      }
      continue;
    }

    if (DROP_RAW.has(name)) {
      if (!tag.closing) {
        if (name === "plaintext") { i = html.length; break; }
        const re = new RegExp(`</${name}(?=[\\s/>])`, "i");
        const m = re.exec(html.slice(i));
        if (m === null) { i = html.length; break; }
        const close = html.indexOf(">", i + m.index);
        i = close === -1 ? html.length : close + 1;
      }
      continue;
    }
    if (DROP_VOID.has(name)) continue;
    if (DROP_NESTED.has(name)) {
      if (!tag.closing && !tag.selfClosing) { skipName = name; skipDepth = 1; }
      continue;
    }

    const isMathTag = MATHML_TAGS.has(name);
    const known = HTML_TAGS.has(name) || isMathTag;
    if (!known) continue; // unwrap: drop the tag, keep its content

    if (tag.closing) {
      if (VOID.has(name) || MATH_EMPTY.has(name)) continue;
      const at = stack.lastIndexOf(name);
      if (at === -1) continue;
      while (stack.length > at) {
        const closed = stack.pop() as string;
        if (closed === "math") mathDepth -= 1;
        out.push(`</${closed}>`);
      }
      continue;
    }

    if (name === "math") {
      if (stack.length >= MAX_DEPTH) continue;
    } else if (isMathTag && mathDepth === 0) {
      continue; // MathML element outside <math>: unwrap
    } else if (!isMathTag && mathDepth > 0 && name !== "br") {
      // Plain HTML inside <math> changes parser namespace rules; unwrap it.
      continue;
    }
    if (stack.length >= MAX_DEPTH) continue;

    const parts: string[] = [];
    const seen = new Set<string>();
    let relNeeded = false;
    for (const [an, av] of tag.attrs) {
      if (seen.has(an)) continue;
      const cleaned = cleanAttr(name, isMathTag, an, av);
      if (cleaned === null) continue;
      seen.add(an);
      if (name === "a" && an === "href") relNeeded = true;
      parts.push(cleaned === "" ? ` ${an}` : ` ${an}="${escAttr(cleaned)}"`);
    }
    if (relNeeded) parts.push(' rel="noopener noreferrer nofollow"');
    out.push(`<${name}${parts.join("")}>`);
    if (MATH_EMPTY.has(name)) {
      out.push(`</${name}>`);
      continue;
    }
    if (!VOID.has(name)) {
      stack.push(name);
      if (name === "math") mathDepth += 1;
    }
  }
  while (stack.length > 0) out.push(`</${stack.pop() as string}>`);
  return out.join("");
}

/** Visible plain text of (already or not yet sanitized) HTML, for FTS indexing. */
export function htmlToPlainText(html: string): string {
  const clean = sanitizeHtml(html);
  return decodeEntities(
    clean
      .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|section|article|figcaption|caption|table|ul|ol)>/g, "\n")
      .replace(/<br>|<hr>/g, "\n")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}
