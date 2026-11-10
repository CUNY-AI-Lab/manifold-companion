// The whole preview path (Markdown/HTML -> sanitize -> KaTeX -> frame document)
// must leave nothing active, judged by a spec-compliant parser (parse5 tree
// construction), not by string matching. Regression for the post-sanitize
// re-insertion of Markdown formulas (a slot inside an attribute broke out of it).
import { describe, expect, it } from 'vitest';
import { parse } from 'parse5';
import { markdownToSanitizedHtml, previewBody, previewDocument } from '../src/lib/preview.js';
import { XSS_CORPUS } from '../../test/xss-corpus.ts';

const ACTIVE = new Set(['script', 'iframe', 'object', 'embed', 'form', 'input', 'textarea', 'button', 'select', 'link', 'base', 'template', 'noscript', 'frame', 'frameset', 'portal', 'applet', 'audio', 'video', 'source', 'track']);
const KATEX_ONLY = new Set(['svg', 'path', 'line', 'rect', 'g', 'annotation', 'semantics']);

/** Problems in the frame document as a browser would build it. */
function frameProblems(doc) {
  const problems = [];
  const tree = parse(doc);
  const html = tree.childNodes.find((n) => n.nodeName === 'html');
  const head = html.childNodes.find((n) => n.nodeName === 'head');
  const body = html.childNodes.find((n) => n.nodeName === 'body');
  const headTags = head.childNodes.filter((n) => n.tagName).map((n) => n.tagName);
  if (headTags.join() !== 'meta,meta,style') problems.push(`head holds ${headTags.join()}`);
  const visit = (node, inKatex) => {
    if (node.tagName) {
      const cls = node.attrs.find((a) => a.name === 'class')?.value ?? '';
      const katex = inKatex || /\bkatex\b/.test(cls);
      if (ACTIVE.has(node.tagName) || node.tagName === 'style' || node.tagName === 'meta' || node.tagName === 'title') problems.push(`<${node.tagName}> in body`);
      if (KATEX_ONLY.has(node.tagName) && !inKatex) problems.push(`<${node.tagName}> outside KaTeX output`);
      for (const a of node.attrs) {
        const name = a.name.toLowerCase();
        if (name.startsWith('on') || ['srcdoc', 'formaction', 'action', 'srcset', 'background', 'ping'].includes(name)) problems.push(`<${node.tagName} ${name}>`);
        if (name === 'style' && (!katex || /url\(|expression|@import|javascript/i.test(a.value))) problems.push(`style on <${node.tagName}>: ${a.value.slice(0, 40)}`);
        if (name === 'href' || name === 'src' || name === 'cite' || name === 'xlink:href') {
          const v = a.value.replace(/[\u0000- ]/g, '').toLowerCase();
          const scheme = /^([a-z][a-z0-9+.-]*):/.exec(v)?.[1];
          if (scheme && !(name === 'src' ? /^data:image\/(png|jpeg|gif|webp);/.test(v) : ['http', 'https', 'mailto'].includes(scheme))) problems.push(`${name}=${a.value.slice(0, 40)}`);
          if (/^(\/\/|\\|\/\\)/.test(a.value.trim())) problems.push(`off-origin ${name}`);
        }
      }
      for (const c of node.childNodes ?? []) visit(c, katex);
      if (node.content) visit(node.content, katex);
    } else {
      for (const c of node.childNodes ?? []) visit(c, inKatex);
    }
  };
  for (const c of body.childNodes) visit(c, false);
  return problems;
}

/** Attribute names of every <tag> in the parsed document. */
function attrsOf(doc, tag) {
  const out = [];
  const visit = (n) => { if (n.tagName === tag) out.push(n.attrs.map((a) => a.name)); for (const c of n.childNodes ?? []) visit(c); };
  visit(parse(doc));
  return out;
}

describe('Markdown formulas are restored before sanitizing (regression)', () => {
  it('a formula inside image alt text cannot break out of the attribute', () => {
    const md = '![x \\(a" onerror="alert(1)\\)](f.png) and ![y $b" onload="x()$](g.png)';
    const doc = previewDocument({ markdown: md });
    expect(frameProblems(doc)).toEqual([]);
    // As a browser parses it, each image carries exactly src and alt; the words survive only as text inside alt.
    expect(attrsOf(doc, 'img')).toEqual([['src', 'alt'], ['src', 'alt']]);
    expect(markdownToSanitizedHtml(md)).toContain('alt="x \\(a&quot; onerror=&quot;alert(1)\\)"');
  });
  it('a formula as a link target is judged by the sanitizer as the final URL', () => {
    for (const md of ['[l](\\(javascript:alert(1)\\))', '[l](<\\(javascript:alert(1)\\)>)', '[l]($javascript:alert(1)$)', '[t](https://ok.example "\\(x" onmouseover="y\\)")']) {
      const doc = previewDocument({ markdown: md });
      expect(frameProblems(doc), md).toEqual([]);
      for (const names of attrsOf(doc, 'a')) expect(names.every((n) => ['href', 'title', 'rel'].includes(n)), md).toBe(true);
      expect(doc, md).not.toMatch(/href="[^"]*javascript/i);
    }
  });
  it('a forged placeholder in stored text is removed, never resolved to another formula', () => {
    const forged = 'real \\(x^2\\) then forged 0 and 1 and ';
    const { body, mathCount } = previewBody({ markdown: forged });
    expect(mathCount).toBe(1);
    expect(body).not.toMatch(/[]/);
    expect(body).toContain('then forged 0 and 1 and');
  });
  it('TeX with quotes and angle brackets renders once and stays inert in text and attributes', () => {
    const md = 'Text \\(a<b>c "q" \'r\'\\) and ![alt \\(x<y "z"\\)](f.png)';
    const doc = previewDocument({ markdown: md });
    expect(frameProblems(doc)).toEqual([]);
    const { mathCount, mathErrors } = previewBody({ markdown: md });
    expect(mathCount).toBe(1); // the one in text; the alt text keeps its TeX as plain characters
    expect(mathErrors).toBe(0);
    expect(markdownToSanitizedHtml(md)).toContain('alt="alt \\(x&lt;y &quot;z&quot;\\)"');
  });
  it('nested, adjacent and duplicate formulas keep their own content', () => {
    const { body, mathCount } = previewBody({ markdown: '\\(\\(x\\)\\) \\(y\\)\\(y\\) $$z$$ $$z$$ \\(\\text{\\)}\\)' });
    expect(mathCount).toBeGreaterThanOrEqual(5);
    expect(body).not.toMatch(/[]/);
  });
  it('figure swaps accept only a strict raster data: URI', () => {
    const doc = previewDocument({ html: '<img src="f.png"><img src="g.png">', images: { 'f.png': 'data:image/png;base64,AA==', 'g.png': 'data:image/png;base64,AA" onerror="x' } });
    expect(doc).toContain('src="data:image/png;base64,AA=="');
    expect(doc).toContain('src="g.png"');
    expect(frameProblems(doc)).toEqual([]);
  });
});

describe('XSS corpus and fuzz through the full preview path', () => {
  for (const payload of XSS_CORPUS) {
    it(payload.name, () => {
      for (const doc of [previewDocument({ html: payload.html }), previewDocument({ markdown: payload.html }), previewDocument({ markdown: `\\(${payload.html}\\) ![a \\(${payload.html}\\)](x.png)` })]) {
        expect(frameProblems(doc), payload.name).toEqual([]);
      }
    });
  }
  it('randomised Markdown + HTML + TeX fragments (deterministic seed)', () => {
    const pieces = XSS_CORPUS.map((p) => p.html).concat(['![', '](', ')', '[', ']', '\\(', '\\)', '\\[', '\\]', '$', '$$', '"', "'", '<', '>', '&', '', '', '0', '`', '```', '\n\n', '<a href="', ' title="', 'x^2', '\\frac{a}{b}', '<math><mi>', '</math>']);
    let seed = 0x5eed1234;
    const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    for (let i = 0; i < 400; i += 1) {
      const src = Array.from({ length: 2 + Math.floor(rand() * 10) }, () => pieces[Math.floor(rand() * pieces.length)]).join(rand() < 0.5 ? '' : ' ');
      expect(frameProblems(previewDocument({ markdown: src })), `md #${i}: ${JSON.stringify(src).slice(0, 120)}`).toEqual([]);
      expect(frameProblems(previewDocument({ html: src })), `html #${i}`).toEqual([]);
    }
  });
});
