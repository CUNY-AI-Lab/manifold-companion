import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { brokenFormulas, facesNeeded, katexStylesheet, KATEX_OPTIONS, parseFontFaces, renderMath, stripKatexClasses } from '../src/lib/math.js';
import { previewBody, previewDocument } from '../src/lib/preview.js';
import { sanitizeHtml } from '../../src/sanitize/html.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/formulas.json', import.meta.url), 'utf8'));
const css = readFileSync(new URL('../node_modules/katex/dist/katex.min.css', import.meta.url), 'utf8');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// A formula as it is STORED: inside sanitized HTML, so <, > and & are entity-escaped.
const markupOnly = (html) => html.replace(/<annotation[^>]*>[\s\S]*?<\/annotation>/g, ''); // the TeX source KaTeX keeps for screen readers
const stored = (f) => sanitizeHtml(`<p>${esc(f.display ? `\\[${f.tex}\\]` : `\\(${f.tex}\\)`)}</p>`);

describe('KaTeX rendering of real formulas', () => {
  it(`all ${fixture.formulas.length} fixture formulas render with no KaTeX error, from sanitized storage`, () => {
    for (const f of fixture.formulas) {
      const { html, count, errors } = renderMath(stored(f));
      expect(count, f.tex).toBe(1);
      expect(errors, f.tex).toBe(0);
      expect(html, f.tex).toContain(f.display ? 'class="katex-display"' : 'class="katex"');
      expect(html, f.tex).toContain('<annotation encoding="application/x-tex">'); // MathML for screen readers, as KaTeX's default output
    }
  });
  it('the same formulas render from Markdown (OCR text) too', () => {
    for (const f of fixture.formulas.slice(0, 30)) {
      const { body, mathErrors, mathCount } = previewBody({ markdown: `Text before ${f.display ? `\\[${f.tex}\\]` : `\\(${f.tex}\\)`} after.` });
      expect(mathCount, f.tex).toBe(1);
      expect(mathErrors, f.tex).toBe(0);
      expect(body).toContain('class="katex');
    }
  });
});

describe('Markdown (OCR) maths', () => {
  it("renders $...$ by Pandoc's rule, and leaves prices alone", () => {
    const { body, mathCount } = previewBody({ markdown: 'Solve $2\\sin(t)=1$ for $t$. It costs $5 and $10, or $ 3 $.' });
    expect(mathCount).toBe(2);
    expect(body).toContain('It costs $5 and $10, or $ 3 $.');
  });
  it('every OCR fixture formula, written with dollars, renders', () => {
    for (const f of fixture.formulas.filter((x) => x.from?.startsWith('calls/ocr'))) {
      const { mathErrors, mathCount } = previewBody({ markdown: `See $${f.tex.replace(/\n/g, ' ')}$ here.` });
      expect(mathCount, f.tex).toBe(1);
      expect(mathErrors, f.tex).toBe(0);
    }
  });
});

describe('legacy semantics', () => {
  it('delimiters are legacy auto-render\'s: \\( \\) and \\[ \\] in HTML; dollars are left alone', () => {
    const { html, count } = renderMath('<p>\\(a\\) and \\[b\\] but $c$ and $$d$$ stay text</p>');
    expect(count).toBe(2);
    expect(html).toContain('$c$ and $$d$$ stay text');
  });
  it('braces protect a closing delimiter, as in auto-render', () => {
    expect(renderMath('<p>\\(\\text{a\\)b}\\)</p>').count).toBe(1);
  });
  it('code and pre are not rendered (auto-render ignoredTags)', () => {
    const { html, count } = renderMath('<pre><code>\\(x^2\\)</code></pre><p>\\(y\\)</p>');
    expect(count).toBe(1);
    expect(html).toContain('<pre><code>\\(x^2\\)</code></pre>');
  });
  it('bad TeX shows as KaTeX\'s red source with the error in the tooltip (legacy throwOnError: false)', () => {
    const { html, errors } = renderMath('<p>\\(x^\\)</p>');
    expect(errors).toBe(1);
    expect(html).toMatch(/<span class="katex-error" title="ParseError: KaTeX parse error:[^"]*" style="color:#cc0000">x\^<\/span>/);
    // An unclosed brace never finds its closing delimiter, so (as in legacy) it stays plain text.
    expect(renderMath('<p>\\(\\frac{1}{\\)</p>').count).toBe(0);
  });
  it('entity-escaped TeX renders as the browser would decode it', () => {
    expect(renderMath(stored({ tex: 'x<y', display: false })).html).toContain('<mo>&lt;</mo>');
  });
});

describe('safety', () => {
  it('trust is off: \\href, \\url, \\includegraphics and \\html* produce no link, image or attribute', () => {
    expect(KATEX_OPTIONS).toMatchObject({ trust: false, throwOnError: false, strict: 'ignore' });
    const { html } = renderMath('<p>\\(\\href{javascript:alert(1)}{x}\\) \\(\\url{https://evil.example}\\) \\(\\includegraphics{x.png}\\) \\(\\htmlClass{evil}{x}\\) \\(\\htmlStyle{color:red}{x}\\) \\(\\htmlData{a=1}{x}\\)</p>');
    expect(markupOnly(html)).not.toMatch(/<a\b|href=|<img\b|class="evil"|data-a=|color:red/);
    expect((html.match(/mathcolor="#cc0000"/g) ?? []).length).toBe(6); // each refused command shows as red error text
  });
  it('bounded: an expansion bomb stops instead of hanging', () => {
    const t = Date.now();
    renderMath(`<p>\\(${'\\def\\a{\\a\\a}'.repeat(1)}\\a\\)</p>`);
    expect(Date.now() - t).toBeLessThan(2000);
    expect(markupOnly(renderMath('<p>\\(\\rule{1000em}{1000em}\\)</p>').html)).not.toContain('1000em');
  });
  it('stored markup imitating KaTeX output loses its classes; styles never get through the sanitizer', () => {
    const sneaky = sanitizeHtml('<span class="katex"><span class="vlist-t mord keep-me" style="height:999em;color:red">x</span></span>');
    expect(sneaky).not.toContain('style=');
    expect(stripKatexClasses(sneaky)).toBe('<span><span class="keep-me">x</span></span>');
    expect(renderMath(sneaky).html).toBe('<span><span class="keep-me">x</span></span>');
  });
  it('the preview sanitizes drafts with the storage allowlist before rendering', () => {
    const { body } = previewBody({ html: '<p onclick="x()">\\(x\\)</p><script>alert(1)</script><img src=x onerror=alert(1)>' });
    expect(body).not.toMatch(/onclick|<script|onerror/);
    expect(body).toContain('class="katex"');
  });
});

describe('fonts: only the faces a page uses, as data: URIs', () => {
  const faces = parseFontFaces(css);
  it('knows all 20 KaTeX faces', () => {
    expect(faces).toHaveLength(20);
    expect(faces.find((f) => f.family === 'KaTeX_AMS')).toMatchObject({ weight: '400', style: 'normal', file: 'KaTeX_AMS-Regular.woff2' });
  });
  it('no maths, no fonts; plain maths gets Main and Math; AMS, Caligraphic and Size faces only when used', () => {
    expect(facesNeeded(css, '<p>no maths</p>')).toEqual([]);
    const plain = facesNeeded(css, renderMath('<p>\\(x+1\\)</p>').html).map((f) => f.file);
    expect(plain).toEqual(expect.arrayContaining(['KaTeX_Main-Regular.woff2', 'KaTeX_Math-Italic.woff2']));
    expect(plain).not.toContain('KaTeX_AMS-Regular.woff2');
    expect(plain).not.toContain('KaTeX_Caligraphic-Regular.woff2');
    const fancy = facesNeeded(css, renderMath('<p>\\(\\mathbb{R}\\) \\(\\mathcal{L}\\) \\[\\left(\\frac{a}{b}\\right)\\]</p>').html).map((f) => f.file);
    expect(fancy).toEqual(expect.arrayContaining(['KaTeX_AMS-Regular.woff2', 'KaTeX_Caligraphic-Regular.woff2', 'KaTeX_Size1-Regular.woff2']));
  });
  it('the inlined stylesheet has no url() but the data: URIs it was given', () => {
    const needed = facesNeeded(css, renderMath('<p>\\(\\sqrt{x}\\)</p>').html);
    const sheet = katexStylesheet(css, needed, (file) => `data:font/woff2;base64,${file}`);
    expect([...sheet.matchAll(/url\(([^)]*)\)/g)].every((m) => m[1].startsWith('data:font/woff2;base64,'))).toBe(true);
    expect((sheet.match(/@font-face/g) ?? []).length).toBe(needed.length);
  });
  it('the whole fixture needs few faces', () => {
    const body = previewBody({ html: fixture.formulas.map((f) => esc(f.display ? `\\[${f.tex}\\]` : `\\(${f.tex}\\)`)).join(' ') }).body;
    const needed = facesNeeded(css, body);
    expect(needed.length).toBeLessThanOrEqual(12);
  });
});

describe('formula repair finds what KaTeX cannot parse', () => {
  it('lists only the broken formulas', () => {
    expect(brokenFormulas('<p>\\(x^2\\) \\(x^\\) \\[\\frac{1}\\] \\(\\sqrt{2}\\)</p>')).toEqual(['x^', '\\frac{1}']);
  });
});

describe('document', () => {
  it('uses the legacy preview pane look', () => {
    const doc = previewDocument({ html: '<h1>T</h1>' });
    expect(doc).toContain("font-family: Georgia, 'Times New Roman', serif; line-height: 1.75");
    expect(doc).toContain('@media (prefers-color-scheme: dark)');
  });
});
