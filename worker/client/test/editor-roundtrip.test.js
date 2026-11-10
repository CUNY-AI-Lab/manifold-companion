// @vitest-environment jsdom
// The visual editor holds real content losslessly: every stored page from the
// live evaluation, the assembled and cleaned-up documents made from them, and
// legacy-style documents open in the editor (the fidelity gate passes) and
// serialize back to the same HTML. Documents with constructs the schema cannot
// hold open in the source view instead.
import { describe, expect, it } from 'vitest';
import fixtures from './fixtures/roundtrip-pages.json';
import exportFixture from '../../test/fixtures/export-fixture.json';
import { cleanupDocumentHtml } from '../../src/model-output.ts';
import { sanitizeHtml } from '../../src/sanitize/html.ts';
import { canonicalHtml, firstDifference, openDocument, parseHtml, serializeDoc } from '../src/lib/editor/html.js';

const pages = Object.entries(fixtures.pages);
const roundTrip = (html, figures = []) => {
  const opened = openDocument(html, { figures });
  if (opened.mode !== 'rich') return { ok: false, why: opened };
  const back = serializeDoc(opened.doc);
  return { ok: canonicalHtml(back) === canonicalHtml(html), back, why: firstDifference(canonicalHtml(html), canonicalHtml(back)) };
};

describe('round trip on the live-evaluation pages', () => {
  it(`all ${pages.length} stored pages open in the visual editor and serialize back unchanged`, () => {
    const failed = [];
    for (const [name, html] of pages) {
      const r = roundTrip(html);
      if (!r.ok) failed.push({ name, why: r.why });
    }
    expect(failed, JSON.stringify(failed.slice(0, 3), null, 1)).toEqual([]);
  });

  it('serializing twice changes nothing more (the stored form is a fixed point)', () => {
    for (const [name, html] of pages.slice(0, 20)) {
      const once = serializeDoc(parseHtml(html));
      expect(serializeDoc(parseHtml(once)), name).toBe(once);
      expect(sanitizeHtml(once), name).toBe(once);
    }
  });

  it('every formula survives as TeX, character for character', () => {
    for (const [name, html] of pages) {
      const doc = parseHtml(html);
      const tex = [];
      doc.descendants((n) => { if (n.type.name === 'math') tex.push(n.attrs.display ? `\\[${n.attrs.tex}\\]` : `\\(${n.attrs.tex}\\)`); });
      const back = serializeDoc(doc);
      for (const t of tex) expect(back.includes(t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')), `${name}: ${t}`).toBe(true);
    }
  });

  it('assembled and cleaned-up documents (what a conversion stores) round-trip too', () => {
    const byPage = new Map();
    for (const [name, html] of pages) {
      const model = name.split('/').slice(1).join('/').replace(/\/[^/]+$/, '');
      if (!byPage.has(model)) byPage.set(model, []);
      byPage.get(model).push(html);
    }
    let docs = 0;
    for (const [model, list] of byPage) {
      const stored = sanitizeHtml(cleanupDocumentHtml(list.join('\n')));
      const r = roundTrip(stored);
      expect(r.ok, `${model}: ${JSON.stringify(r.why)}`).toBe(true);
      docs += 1;
    }
    expect(docs).toBeGreaterThan(3);
  });
});

describe('legacy documents', () => {
  const legacy = [
    ...exportFixture.projects.flatMap((p) => p.texts).filter((t) => t.html).map((t) => [t.name, t.html, t.figures ?? []]),
    // The legacy page prompt's callout boxes and the cleanup's <article> wrapper.
    ['callouts', '<article class="pdf-html-document"><section data-page="2"><h2>Identities</h2><section><header><h3>Example 3</h3></header><p>Solve \\(\\sin(t) = \\frac{1}{2}\\).</p></section><aside><h3>Try it now</h3><p>Find \\(\\cos(\\pi)\\).</p></aside><blockquote><h3>Definition</h3><p>A <em>function</em> is a rule.</p></blockquote></section></article>', []],
    ['lists', '<section data-page="8"><ol start="31"><li>\\(f(x)=2x\\)</li><li value="33"><strong>Bold</strong> and <em>italic</em> text</li></ol><ul><li><p>Paragraph item</p><ul><li>Nested</li></ul></li></ul></section>', []],
    ['tables', '<section data-page="19"><table class="equation-table"><caption>Table 1</caption><thead><tr><th colspan="2">x</th></tr></thead><tbody><tr><td>\\[x^2\\]</td><td></td></tr><tr><td rowspan="2">a</td><td><p>b</p></td></tr></tbody></table></section>', []],
    ['inline', '<p>Line one<br>line two with a <a href="https://example.org/page">link</a>, <sup>2</sup>, <sub>n</sub>, <code>x = 1</code> and <a href="mailto:ailab@gc.cuny.edu">mail</a>.</p><pre><code>let x = 1;\n  y = 2;</code></pre><hr><h4>End</h4>', []],
  ];
  for (const [name, html, figures] of legacy) {
    it(`${name} opens in the visual editor and serializes back unchanged`, () => {
      const r = roundTrip(html, figures);
      expect(r.ok, JSON.stringify(r.why)).toBe(true);
    });
  }
});

describe('what the schema cannot hold opens in the source view, with a reason', () => {
  const cases = [
    ['MathML', '<p><math><mi>x</mi></math></p>', 'MathML formulas'],
    ['a definition list', '<dl><dt>a</dt><dd>b</dd></dl>', 'a definition list'],
    ['a page-anchor link', '<p><a href="#sec">jump</a></p>', 'a link that is not a web or email address'],
    ['an image that is not a figure of this text', '<p><img src="data:image/png;base64,AAAA" alt="x"></p>', 'an image that is not one of this text’s figures'],
    ['an unknown figure name', '<figure><img src="elsewhere.png" alt="x"></figure>', 'an image that is not one of this text’s figures'],
    ['a collapsible section', '<details><summary>More</summary><p>x</p></details>', 'a collapsible section'],
  ];
  for (const [name, html, reason] of cases) {
    it(name, () => {
      const opened = openDocument(html);
      expect(opened.mode).toBe('source');
      expect(opened.reasons).toContain(reason);
    });
  }
  it('an empty text (not converted yet) opens in the visual editor and stays empty', () => {
    for (const html of ['', '   ', '\n']) {
      const opened = openDocument(html);
      expect(opened.mode, JSON.stringify(html)).toBe('rich');
      expect(serializeDoc(opened.doc)).toBe('');
    }
  });
  it('an image that is one of the text’s figures is held', () => {
    expect(openDocument('<figure><img src="p1-fig1.png" alt="x"><figcaption>c</figcaption></figure>', { figures: ['p1-fig1.png'] }).mode).toBe('rich');
  });
});
