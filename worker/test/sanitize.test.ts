import { describe, expect, it } from "vitest";
import { htmlToPlainText, safeHref, safeImgSrc, sanitizeHtml } from "../src/sanitize/html";
import { XSS_CORPUS } from "./xss-corpus";
import { parse, serialize, type DefaultTreeAdapterMap } from "parse5";

// A second, stronger verdict. HTMLRewriter (lol-html) only TOKENIZES: it does no
// tree construction, so it cannot see foster parenting, foreign-content
// namespace switches or the serialize/re-parse mutations behind mXSS. parse5
// implements the WHATWG tree-construction algorithm. The output is parsed as a
// browser would, serialized back (what innerHTML returns) and re-parsed, three
// times, and every tree is checked.
type P5Node = DefaultTreeAdapterMap["node"];
const HTML_NS = "http://www.w3.org/1999/xhtml";
const MATH_NS = "http://www.w3.org/1998/Math/MathML";
function treeProblems(html: string): string[] {
  const problems: string[] = [];
  let current = html;
  for (let round = 0; round < 3; round += 1) {
    const doc = parse(`<!doctype html><body>${current}`);
    const visit = (node: P5Node) => {
      if ("tagName" in node) {
        const el = node as DefaultTreeAdapterMap["element"];
        if (el.namespaceURI !== HTML_NS && el.namespaceURI !== MATH_NS) problems.push(`round ${round}: <${el.tagName}> in ${el.namespaceURI}`);
        if (["script", "style", "iframe", "object", "embed", "svg", "textarea", "xmp", "noscript", "noembed", "template", "form", "input", "base", "meta", "link"].includes(el.tagName)) problems.push(`round ${round}: <${el.tagName}>`);
        for (const a of el.attrs) {
          if (/^on/i.test(a.name) || ["style", "srcdoc", "formaction", "action", "srcset"].includes(a.name) || a.name.includes(":")) problems.push(`round ${round}: <${el.tagName} ${a.name}>`);
          if (["href", "src", "cite"].includes(a.name)) {
            const probe = a.value.replace(/[\u0000-\u0020]/g, "").toLowerCase();
            if (/^[a-z][a-z0-9+.-]*:/.test(probe) && !(a.name === "src" ? /^data:image\/(png|jpeg|gif|webp);/.test(probe) : /^(https?|mailto):/.test(probe))) problems.push(`round ${round}: ${a.name}=${a.value.slice(0, 40)}`);
            if (/^(\/\/|\\|\/\\)/.test(a.value.trim())) problems.push(`round ${round}: off-origin ${a.name}`);
          }
        }
      }
      if ("childNodes" in node) for (const child of node.childNodes as P5Node[]) visit(child);
      if ("content" in node && node.content) visit(node.content as unknown as P5Node);
    };
    visit(doc as unknown as P5Node);
    const htmlEl = doc.childNodes.find((n) => n.nodeName === "html") as DefaultTreeAdapterMap["element"];
    const body = htmlEl.childNodes.find((n) => n.nodeName === "body") as DefaultTreeAdapterMap["element"];
    current = serialize(body);
  }
  return problems;
}

// Independent verdict: parse the sanitized output with workerd's HTMLRewriter
// (lol-html), not with our own tokenizer, and collect everything it sees.
async function inspect(html: string) {
  const elements: string[] = [];
  const attrs: [string, string, string][] = [];
  let comments = 0;
  await new HTMLRewriter()
    .on("*", {
      element(el) {
        elements.push(el.tagName);
        for (const [n, v] of el.attributes as Iterable<[string, string]>) attrs.push([el.tagName, n, v]);
      },
    })
    .onDocument({ comments() { comments += 1; }, doctype() { comments += 1; } })
    .transform(new Response(html))
    .text();
  return { elements, attrs, comments };
}

const ALLOWED_TAGS = new Set([
  "a", "abbr", "article", "aside", "b", "bdi", "bdo", "blockquote", "br", "caption", "cite", "code", "col", "colgroup", "dd", "del", "details", "dfn", "div", "dl", "dt", "em",
  "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i", "img", "ins", "kbd", "li", "main", "mark", "nav", "ol", "p", "pre", "q", "s", "samp",
  "section", "small", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "u", "ul", "var", "wbr",
  "math", "maligngroup", "malignmark", "menclose", "merror", "mfenced", "mfrac", "mglyph", "mi", "mlabeledtr", "mmultiscripts", "mn", "mo", "mover", "mpadded", "mphantom",
  "mprescripts", "mroot", "mrow", "ms", "mspace", "msqrt", "mstyle", "msub", "msubsup", "msup", "mtable", "mtd", "mtext", "mtr", "munder", "munderover", "none",
]);
const BANNED_ATTR = /^(on|style$|srcdoc|formaction|xlink|data-|srcset|autofocus|contenteditable|tabindex|name$|action|background|ping|poster)/;

async function assertInert(output: string, label: string) {
  const { elements, attrs, comments } = await inspect(output);
  expect(comments, `${label}: comments/doctype survive`).toBe(0);
  for (const tag of elements) expect(ALLOWED_TAGS.has(tag), `${label}: <${tag}> is not allowlisted`).toBe(true);
  for (const [tag, name, value] of attrs) {
    expect(BANNED_ATTR.test(name), `${label}: <${tag} ${name}>`).toBe(false);
    if (name === "href" || name === "src" || name === "cite") {
      const probe = value.replace(/[\u0000- ]/g, "").toLowerCase();
      if (/^[a-z][a-z0-9+.-]*:/.test(probe)) {
        const ok = name === "src" ? probe.startsWith("data:image/") : /^(https?|mailto):/.test(probe);
        expect(ok, `${label}: <${tag} ${name}="${value.slice(0, 60)}">`).toBe(true);
      }
      expect(probe.startsWith("//"), `${label}: protocol-relative ${name}`).toBe(false);
    }
  }
  // The normal form never contains an unescaped script-ish construct in text.
  expect(output.toLowerCase()).not.toMatch(/<\s*(script|style|iframe|object|embed|svg|template|form|input|textarea)\b/);
}

describe("sanitizer under workerd", () => {
  it("runs in the Workers runtime without a DOM", () => {
    expect(typeof (globalThis as any).document).toBe("undefined");
    expect(typeof HTMLRewriter).toBe("function");
    expect(sanitizeHtml("<p>ok</p>")).toBe("<p>ok</p>");
  });

  describe("XSS corpus: stored output is inert", () => {
    for (const payload of XSS_CORPUS) {
      it(payload.name, async () => {
        const out = sanitizeHtml(payload.html);
        await assertInert(out, payload.name);
        expect(treeProblems(out), payload.name).toEqual([]);
        for (const bad of payload.forbid ?? []) expect(out.toLowerCase(), `${payload.name} kept "${bad}"`).not.toContain(bad.toLowerCase());
        // Idempotent: re-sanitizing stored output changes nothing, so edits can't ratchet it open.
        expect(sanitizeHtml(out)).toBe(out);
      });
    }
  });

  it("survives a randomized mix of fragments (deterministic seed)", async () => {
    const pieces = XSS_CORPUS.map((p) => p.html).concat(["<p>", "</p>", "<", ">", '"', "'", "&", "&#", "<a href='", "<!--", "-->", "<math>", "</math>", "<table><tr><td>", "text"]);
    let seed = 0x2f6e2b1;
    const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    for (let i = 0; i < 300; i += 1) {
      const html = Array.from({ length: 1 + Math.floor(rand() * 8) }, () => pieces[Math.floor(rand() * pieces.length)]).join(rand() < 0.5 ? "" : " ");
      const out = sanitizeHtml(html);
      await assertInert(out, `fuzz #${i}`);
      expect(treeProblems(out), `fuzz #${i}`).toEqual([]);
      expect(sanitizeHtml(out)).toBe(out);
    }
  });

  describe("keeps legitimate document content", () => {
    it("structure, tables, lists, figures", () => {
      const html = '<h1 id="t1">Title</h1><p class="lead" lang="en">Para with <em>em</em>, <strong>strong</strong>, <sup>2</sup> &amp; &copy;.</p><ul><li>a</li><li>b</li></ul><table><thead><tr><th scope="col">H</th></tr></thead><tbody><tr><td colspan="2" rowspan="1">c</td></tr></tbody></table><figure><img src="figures/f1.png" alt="A figure" width="100"><figcaption>Cap</figcaption></figure><blockquote>q</blockquote><pre><code>x &lt; y</code></pre>';
      expect(sanitizeHtml(html)).toBe(html);
    });
    it("MathML formulas survive", () => {
      const html = '<p>E = <math xmlns="http://www.w3.org/1998/Math/MathML" display="inline"><mrow><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></mrow></math></p>';
      expect(sanitizeHtml(html)).toBe(html);
      const frac = '<math display="block"><mfrac><mrow><mi>a</mi><mo stretchy="false">+</mo><mn>1</mn></mrow><msqrt><mi>b</mi></msqrt></mfrac></math>';
      expect(sanitizeHtml(frac)).toBe(frac);
    });
    // Regression: `open` was treated as a boolean on every element, so mfenced lost its
    // fences (`<mfenced open>`), and `close`/`separators` were dropped by the generic filter.
    it("MathML fence and quote characters survive; details stays boolean", () => {
      const fenced = '<math><mfenced open="(" close="]" separators=";"><mi>a</mi><mi>b</mi></mfenced><ms lquote="&lt;" rquote="&gt;">s</ms></math>';
      expect(sanitizeHtml(fenced)).toBe(fenced);
      expect(sanitizeHtml('<details open="evil"><summary>s</summary>x</details>')).toBe("<details open><summary>s</summary>x</details>");
      expect(sanitizeHtml('<math><mfenced open="&#1;x"><mi>a</mi></mfenced></math>')).toBe("<math><mfenced><mi>a</mi></mfenced></math>");
      expect(sanitizeHtml('<p close="x" lquote="y">p</p>')).toBe("<p>p</p>");
    });
    it("mXSS through MathML integration points stays inert after tree construction and round trips", () => {
      for (const p of [
        '<math><mi><mglyph><svg><mtext><textarea><path id="</textarea><img onerror=alert(1) src=1>">',
        '<form><math><mtext></form><form><mglyph><style></math><img onerror=alert(1) src>',
        '<math><mtext><h1><a><h6></a></h6><mglyph><svg><mtext><style><a title="</style><img src onerror=alert(1)>"></style></h1>',
        '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=alert(1)&gt;">',
        '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
        '<a href="&#00000106avascript:alert(1)">x</a><a href="jav&#x09;ascript:1">y</a><a href=" &#14;javascript:1">z</a>',
      ]) {
        const out = sanitizeHtml(p);
        expect(treeProblems(out), p).toEqual([]);
        expect(out).not.toMatch(/onerror|javascript/i);
      }
    });
    it("links get rel and lose target; http, https, mailto and fragments are kept", () => {
      expect(sanitizeHtml('<a href="https://example.org/a?b=1&c=2" target="_blank">x</a>')).toBe('<a href="https://example.org/a?b=1&amp;c=2" rel="noopener noreferrer nofollow">x</a>');
      expect(sanitizeHtml('<a href="#fn1">1</a><a href="mailto:a@b.example">m</a><a href="notes/x.html">r</a>')).toContain('href="#fn1"');
      expect(sanitizeHtml('<a href="mailto:a@b.example">m</a>')).toContain("mailto:a@b.example");
    });
    it("inline raster data images and relative images are kept; remote and svg are not", () => {
      expect(sanitizeHtml('<img src="data:image/png;base64,iVBORw0KGgo=" alt="x">')).toContain("data:image/png;base64,iVBORw0KGgo=");
      expect(sanitizeHtml('<img src="figures/p1.png">')).toContain('src="figures/p1.png"');
      expect(sanitizeHtml('<img src="https://x.example/p.png">')).toBe("<img>");
    });
    it("unwraps unknown elements and closes unclosed ones", () => {
      expect(sanitizeHtml("<custom-el>inner <b>bold")).toBe("inner <b>bold</b>");
    });
    it("escapes stray markup characters in text but keeps valid entities", () => {
      expect(sanitizeHtml("a < b > c & d &amp; e &#169; f")).toBe("a &lt; b &gt; c &amp; d &amp; e &#169; f");
    });
  });

  describe("URL policy helpers", () => {
    it("safeHref", () => {
      for (const ok of ["https://a.example/x", "http://a.example", "mailto:a@b.example", "#top", "/abs/path", "rel/path", "../up", "?q=1"]) expect(safeHref(ok), ok).not.toBeNull();
      for (const bad of ["javascript:alert(1)", " JavaScript:1", "data:text/html,x", "//evil.example", "\\\\evil", "vbscript:x", "file:///x", "tel:123", "", "   ", "foo:bar"]) expect(safeHref(bad), bad).toBeNull();
    });
    it("safeImgSrc", () => {
      for (const ok of ["figures/a.png", "/manifold-companion/api/x.png", "data:image/jpeg;base64,/9j/4AAQ"]) expect(safeImgSrc(ok), ok).not.toBeNull();
      for (const bad of ["https://x.example/a.png", "http://x.example/a.png", "javascript:1", "data:image/svg+xml;base64,AAAA", "data:text/html;base64,AAAA", "//x.example/a.png", ""]) expect(safeImgSrc(bad), bad).toBeNull();
    });
  });

  it("caps pathological input instead of hanging", () => {
    const start = Date.now();
    const out = sanitizeHtml("<p>".repeat(200_000));
    expect(Date.now() - start).toBeLessThan(3000);
    expect(out.length).toBeGreaterThan(0);
    expect(sanitizeHtml("x".repeat(3_000_000)).length).toBe(2_000_000);
  });

  it("extracts plain text for the search index without markup or script", () => {
    const text = htmlToPlainText('<h1>Title</h1><p>First &amp; <b>bold</b></p><script>alert(1)</script><table><tr><td>A</td><td>B</td></tr></table><math><mi>x</mi></math>');
    expect(text).toContain("Title");
    expect(text).toContain("First & bold");
    expect(text).not.toMatch(/alert|<|script/);
  });
});
